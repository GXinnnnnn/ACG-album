'use strict';
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto'),
  { createRequire } = require('node:module');
const { idFor, MEDIA_EXT } = require('../src/model.cjs');
async function originalSnapshot(root) {
  const rows = [];
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const data = await fs.readFile(file),
          stat = await fs.stat(file);
        rows.push({
          path: path.relative(root, file),
          bytes: stat.size,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash('sha256').update(data).digest('hex')
        });
      }
    }
  }
  await visit(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
async function footprint(dir) {
  let total = 0,
    count = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await footprint(p);
      total += sub.bytes;
      count += sub.files;
    } else if (e.isFile()) {
      total += (await fs.stat(p)).size;
      count++;
    }
  }
  return { bytes: total, files: count };
}
(async () => {
  const executable = path.resolve(
      require('./distribution-paths.cjs').runtimeDirectory(),
      `${require('../package.json').build.productName}.exe`
    ),
    data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-packaged-')),
    env = { ...process.env, ACG_TEST: '1', ACG_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  let app, page;
  const errors = [],
    report = {};
  try {
    const started = performance.now();
    app = await _electron.launch({ executablePath: executable, env, timeout: 30000 });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#import-sidebar');
    report.freshLaunchMs = +(performance.now() - started).toFixed(2);
    await page.evaluate(() => {
      window.__packageErrors = [];
      window.addEventListener('error', (e) => window.__packageErrors.push(e.message));
      window.addEventListener('unhandledrejection', (e) =>
        window.__packageErrors.push(e.reason?.message || String(e.reason))
      );
    });
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1920, 1080)
    );
    report.brand = await page.title();
    assert.equal(report.brand.includes('ACG-album'), true);
    await page.evaluate(async () => {
      await window.album.call('settings', { key: 'autoMatch', value: false });
      await window.album.call('settings', { key: 'categoryType', value: 2 });
    });
    const source = path.join(require('./distribution-paths.cjs').workspaceRoot, 'ACG图片');
    const sourceBefore = await originalSnapshot(source);
    const expectedMedia = sourceBefore.filter((item) =>
      MEDIA_EXT.has(path.extname(item.path).toLowerCase())
    ).length;
    assert.ok(expectedMedia > 0);
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
    }, source);
    const scanStart = performance.now();
    await page.evaluate(() => window.album.call('import'));
    report.importAdmissionMs = +(performance.now() - scanStart).toFixed(2);
    await page.waitForFunction(async (id) => {
      const init = await window.album.call('init');
      return init.roots.some((node) => node.id === id) && !init.progress.active;
    }, idFor(source));
    report.realImportMs = +(performance.now() - scanStart).toFixed(2);
    report.nativeDialogMocked = true;
    await page.waitForSelector('.collection-tile');
    await page.locator('.collection-open').first().click();
    await page.waitForSelector('.album-card');
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.album-card img').length === 6 &&
        [...document.querySelectorAll('.album-card img')].every(
          (i) => i.complete && i.naturalWidth > 0
        )
    );
    const init = await page.evaluate(() => window.album.call('init'));
    report.images = init.stats.images;
    report.expectedMediaFromReadOnlySnapshot = expectedMedia;
    assert.equal(report.images, expectedMedia);
    report.offlineCovers = await page.locator('.album-card img').count();
    await page.screenshot({ path: 'artifacts/packaged-1080p.png', scale: 'css' });
    await page.waitForTimeout(1000);
    report.memoryFresh1080 = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((m) => ({ type: m.type, workingSetMB: m.memory.workingSetSize / 1024 }))
    );
    const bit = idFor(path.join(source, '16bit的感动'));
    await page.evaluate(async (id) => cropModal(await window.album.call('get', { id })), bit);
    await page.waitForFunction(() => document.querySelector('#crop-image')?.naturalWidth > 0);
    await page.locator('#crop-preview').hover();
    await page.mouse.wheel(0, -360);
    await page.waitForFunction(() => Number(document.querySelector('#crop-zoom').value) > 150);
    await page.locator('#crop-save').click();
    await page.waitForFunction(() => !document.querySelector('#modal').open);
    report.cropZoom = (
      await page.evaluate((id) => window.album.call('get', { id }), bit)
    ).crop_zoom;
    assert.ok(report.cropZoom > 1.5);
    await page.locator('[data-window="maximize"]').click();
    await page.waitForFunction(() => innerHeight < 1080);
    report.maximize = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return {
        maximized: w.isMaximized(),
        fullscreen: w.isFullScreen(),
        content: w.getContentBounds(),
        workArea: screen.getDisplayMatching(w.getBounds()).workArea
      };
    });
    assert.equal(report.maximize.maximized, true);
    assert.equal(report.maximize.fullscreen, false);
    assert.ok(
      report.maximize.content.y + report.maximize.content.height <=
        report.maximize.workArea.y + report.maximize.workArea.height
    );
    await page.locator('[data-window="maximize"]').click();
    await page.waitForFunction(() => innerHeight === 1080);
    await page.locator(`[data-id="${bit}"]`).click();
    await page.waitForSelector('.image-card');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.image-card img')]
        .filter((i) => i.getBoundingClientRect().top < innerHeight)
        .every((i) => i.complete && i.naturalWidth > 0)
    );
    const image = (
      await page.evaluate(
        (id) => window.album.call('list', { parent: id, filter: 'images', limit: 1 }),
        bit
      )
    ).items[0];
    await page.evaluate((id) => window.album.call('copyImage', { id }), image.id);
    report.clipboard = await app.evaluate(({ clipboard }) => ({
      size: clipboard.readImage().getSize(),
      empty: clipboard.readImage().isEmpty()
    }));
    assert.equal(report.clipboard.empty, false);
    await page.locator('.image-card').first().dblclick();
    await page.waitForFunction(() => {
      const i = document.querySelector('#viewer-image');
      return i?.complete && i.naturalWidth > 0;
    });
    await page.keyboard.press('Escape');
    const demo = await page.evaluate(() => window.album.call('demo'));
    report.demoImported = (await page.evaluate(() => window.album.call('init'))).roots.length === 4;
    assert.equal(report.demoImported, true);
    const sample = (
      await page.evaluate((id) => window.album.call('list', { parent: id }), demo.root)
    ).items.find((n) => n.kind === 'folder');
    report.demoThumbDecoded = await page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const i = new Image();
          i.onload = () => resolve(i.naturalWidth > 0);
          i.onerror = () => reject(new Error('Packaged demo thumbnail failed'));
          i.src = `acg-image://thumb/${id}?size=512&v=packaged-demo`;
        }),
      sample.id
    );
    assert.equal(report.demoThumbDecoded, true);
    report.errors = [
      ...new Set([...errors, ...(await page.evaluate(() => window.__packageErrors))])
    ];
    assert.deepEqual(report.errors, []);
    const builderRequire = createRequire(require.resolve('electron-builder')),
      asar = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/asar'),
      archive = path.join(
        require('./distribution-paths.cjs').runtimeDirectory(),
        'resources/app.asar'
      ),
      entries = asar.listPackage(archive);
    assert.equal(
      entries.some((p) => /[\\/]ACG图片[\\/]|[\\/]artifacts[\\/]|[\\/]\.review-data[\\/]/.test(p)),
      false
    );
    report.realImagesExcludedFromPackage = true;
    report.asarBytes = (await fs.stat(archive)).size;
    report.asarSha256 = crypto
      .createHash('sha256')
      .update(await fs.readFile(archive))
      .digest('hex');
    report.runnableDirectory = await footprint(path.dirname(executable));
    const original = JSON.parse(await fs.readFile('artifacts/source-manifest.json', 'utf8'));
    let checked = 0;
    for (const item of original) {
      const p = path.join(source, item.path),
        buf = await fs.readFile(p);
      assert.equal(buf.length, item.bytes, item.path + ' size changed');
      assert.equal(
        crypto.createHash('sha256').update(buf).digest('hex'),
        item.sha256,
        item.path + ' content changed'
      );
      checked++;
    }
    assert.deepEqual(
      await originalSnapshot(source),
      sourceBefore,
      'Source hashes sizes modification times and file tree must remain unchanged'
    );
    report.sourceSafety = {
      checkedImages: checked,
      historicalManifestHashesUnchanged: true,
      files: sourceBefore.length,
      allHashesSizesAndModificationTimesUnchanged: true
    };
    await fs.writeFile('artifacts/packaged-report.json', JSON.stringify(report, null, 2));
    console.log('PACKAGED VALIDATION', JSON.stringify(report, null, 2));
  } catch (e) {
    if (page) await page.screenshot({ path: 'artifacts/packaged-error.png' }).catch(() => {});
    console.error('PACKAGED ERROR', errors, e);
    throw e;
  } finally {
    if (app) await app.close().catch(() => {});
    const resolved = path.resolve(data);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'acg-packaged-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
