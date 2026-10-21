'use strict';
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { idFor } = require('../src/model.cjs');
const packaged = process.argv.includes('--packaged'),
  label = packaged ? 'packaged' : 'source',
  report = { packaged, errors: [] };
async function manifest(root) {
  const rows = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        const data = await fs.readFile(file),
          stat = await fs.stat(file);
        rows.push({
          path: path.relative(root, file),
          bytes: data.length,
          mtimeMs: stat.mtimeMs,
          sha256: crypto.createHash('sha256').update(data).digest('hex')
        });
      }
    }
  }
  await walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
(async () => {
  const roots = [
      path.join(require('./distribution-paths.cjs').workspaceRoot, 'ACG图片'),
      path.join(require('./distribution-paths.cjs').workspaceRoot, '游戏图片')
    ],
    before = await Promise.all(roots.map(manifest));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-display-'));
  let app, page;
  async function launch() {
    const env = { ...process.env, ACG_DATA_DIR: data, ACG_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: packaged
        ? path.resolve(
            require('./distribution-paths.cjs').runtimeDirectory(),
            `${require('../package.json').build.productName}.exe`
          )
        : require('electron'),
      args: packaged ? [] : ['.'],
      env
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.waitForFunction(
      () =>
        typeof S !== 'undefined' &&
        S.settings.nickname !== undefined &&
        window.applyNavigationSettings
    );
    await page.evaluate(() => {
      window.__displayErrors = [];
      window.addEventListener('unhandledrejection', (e) =>
        window.__displayErrors.push(e.reason?.message || String(e.reason))
      );
      window.addEventListener('error', (e) => window.__displayErrors.push(e.message));
    });
  }
  async function resize(width, height) {
    await app.evaluate(
      async ({ BrowserWindow }, { width, height }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMaximized())
          await new Promise((resolve) => {
            window.once('unmaximize', resolve);
            window.unmaximize();
          });
        window.setContentSize(width, height);
      },
      { width, height }
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height }
    );
  }
  async function settle(width) {
    await page.waitForFunction(
      (width) => displayChangeTask === null && Number(S.settings.density) === width,
      width
    );
  }
  async function choose(width) {
    await page.locator(`#card-size-controls [data-density="${width}"]`).click();
    await settle(width);
  }
  async function gallery() {
    await page.waitForFunction(() => grid.active && grid.total > 0 && grid.cards.size > 0);
  }
  async function settledScreenshot(file) {
    await page.mouse.move(900, 18);
    await page.waitForFunction(() => S.settings.sidebarMode === 'expanded' || !sidebarOpen);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.album-card img')]
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.bottom > 220 && r.top < innerHeight;
        })
        .every((i) => i.complete && i.naturalWidth > 0)
    );
    await page.screenshot({ path: file });
  }
  async function deepScroll() {
    await page.evaluate(() => {
      const viewport = $('#viewport'),
        top =
          $('#virtual-grid').getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop;
      viewport.scrollTop = top + grid.getPosition(Math.min(500, grid.total - 1)).top;
      grid.render();
    });
    await page.waitForFunction(() => {
      const a = captureDisplayAnchor();
      return a.kind === 'grid' && grid.items.has(a.index) && !$('#back-to-top').hidden;
    });
  }
  try {
    await launch();
    await resize(1920, 1032);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('watchChanges', false);
    });
    for (const root of roots) {
      await app.evaluate(({ dialog }, source) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      }, root);
      await page.evaluate(() => window.album.call('import'));
    }
    await page.waitForFunction(() => $('#progress-panel').hidden);
    await page.waitForFunction(
      () => S.roots.length === 2 && document.querySelectorAll('.collection-tile').length === 2
    );
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.collection-tile img')].every(
        (i) => i.complete && i.naturalWidth > 0
      )
    );
    report.categorySizes = [];
    for (const width of [158, 186, 222]) {
      await choose(width);
      report.categorySizes.push(
        await page.evaluate(() => ({
          density: S.settings.density,
          width: $('.collection-tile').getBoundingClientRect().width,
          height: $('.collection-image').getBoundingClientRect().height,
          selected: $('#card-size-controls [aria-pressed=true]').textContent.trim()
        }))
      );
    }
    assert.ok(
      report.categorySizes[0].width < report.categorySizes[1].width &&
        report.categorySizes[1].width < report.categorySizes[2].width
    );
    await page.screenshot({ path: `artifacts/display-${label}-categories.png` });
    const root = idFor(roots[0]);
    await page.locator(`.collection-tile[data-id="${root}"] .category-expand`).click();
    await page.waitForSelector('.collection-preview .album-card');
    report.previewSizes = [];
    for (const width of [158, 222]) {
      await choose(width);
      report.previewSizes.push(
        await page.evaluate(() => ({
          density: S.settings.density,
          width: $('.collection-preview .album-card').getBoundingClientRect().width,
          columns: getComputedStyle($('.collection-preview')).gridTemplateColumns.split(' ').length
        }))
      );
    }
    assert.ok(report.previewSizes[1].width > report.previewSizes[0].width);
    const folders = await page.evaluate(
      (parent) => api('list', { parent, filter: 'folders', limit: 180 }),
      root
    );
    let largest = folders.items.sort((a, b) => b.files - a.files)[0];
    for (let depth = 0; depth < 8; depth++) {
      const images = await page.evaluate(
        (parent) => api('list', { parent, filter: 'images', limit: 1 }),
        largest.id
      );
      if (images.total > 1000) {
        report.directImageCount = images.total;
        break;
      }
      const children = await page.evaluate(
        (parent) => api('list', { parent, filter: 'folders', limit: 180 }),
        largest.id
      );
      assert.ok(children.items.length, 'Expected nested large gallery');
      largest = children.items.sort((a, b) => b.files - a.files)[0];
    }
    assert.ok(report.directImageCount > 1000);
    report.gallery = { name: largest.name, total: largest.files };
    await page.evaluate((parent) => navigate({ parent }), largest.id);
    await gallery();
    await deepScroll();
    await page.evaluate(() => {
      window.__displayBefore = {
        anchor: captureDisplayAnchor(),
        version: S.loadVersion,
        items: grid.items
      };
    });
    await choose(158);
    report.anchor = await page.evaluate(() => {
      const before = window.__displayBefore,
        a = before.anchor,
        vp = $('#viewport').getBoundingClientRect(),
        top =
          $('#virtual-grid').getBoundingClientRect().top - vp.top + grid.getPosition(a.index).top;
      return {
        index: a.index,
        beforeOffset: a.offset,
        afterOffset: top,
        visible: top + grid.getPosition(a.index).height > 0 && top < vp.height,
        versionStable: S.loadVersion === before.version,
        cacheStable: grid.items === before.items,
        scroll: $('#viewport').scrollTop,
        cols: grid.cols,
        dom: grid.cards.size
      };
    });
    assert.ok(report.anchor.visible);
    assert.ok(Math.abs(report.anchor.beforeOffset - report.anchor.afterOffset) < 1);
    assert.equal(report.anchor.versionStable, true);
    assert.equal(report.anchor.cacheStable, true);
    assert.ok(report.anchor.dom < 200);
    report.stickyToolbar = await page.evaluate(() => {
      const toolbar = $('#toolbar').getBoundingClientRect(),
        vp = $('#viewport').getBoundingClientRect();
      return {
        top: toolbar.top - vp.top,
        bottom: toolbar.bottom,
        inside: toolbar.bottom < vp.bottom
      };
    });
    assert.ok(report.stickyToolbar.top >= 3 && report.stickyToolbar.top <= 10);
    assert.equal(report.stickyToolbar.inside, true);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.image-card img')]
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.bottom > 220 && r.top < innerHeight;
        })
        .every((i) => i.complete && i.naturalWidth > 0)
    );
    await settledScreenshot(`artifacts/display-${label}-small.png`);
    await choose(222);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.image-card img')]
        .filter((i) => {
          const r = i.getBoundingClientRect();
          return r.bottom > 220 && r.top < innerHeight;
        })
        .every((i) => i.complete && i.naturalWidth > 0)
    );
    await settledScreenshot(`artifacts/display-${label}-large.png`);
    report.rapidChoice = await page.evaluate(async () => {
      const first = changeDisplaySetting('density', 158);
      await Promise.resolve();
      changeDisplaySetting('density', 222);
      changeDisplaySetting('density', 186);
      await first;
      return {
        density: S.settings.density,
        persisted: (await api('init')).settings.density,
        selected: $$('#card-size-controls [aria-pressed=true]').length
      };
    });
    assert.deepEqual(report.rapidChoice, { density: 186, persisted: 186, selected: 1 });
    await page.locator('#card-size-controls [data-density="222"]').focus();
    await page.keyboard.press('Enter');
    await settle(222);
    report.keyboard = await page
      .locator('#card-size-controls [data-density="222"]')
      .getAttribute('aria-pressed');
    assert.equal(report.keyboard, 'true');
    await page.locator('#density-button').click();
    await page.locator('#modal [data-density="158"]').focus();
    await page.keyboard.press('Space');
    await settle(158);
    report.modalSync = await page.evaluate(() => ({
      toolbar: $('#card-size-controls [data-density="158"]').getAttribute('aria-pressed'),
      modal: $('#modal [data-density="158"]').getAttribute('aria-pressed'),
      focus: document.activeElement === $('#modal [data-density="158"]')
    }));
    assert.deepEqual(report.modalSync, { toolbar: 'true', modal: 'true', focus: true });
    report.ratios = [];
    for (const ratio of ['tall', 'square', 'poster']) {
      const source = page.locator('#ratio-select');
      const wrapper = source.locator('..');
      const index = await source.evaluate(
        (select, value) => [...select.options].findIndex((option) => option.value === value),
        ratio
      );
      assert.ok(index >= 0);
      await wrapper.locator('.album-select-button').click();
      await wrapper.locator(`.album-select-option[data-index='${index}']`).click();
      await page.waitForFunction(
        (ratio) => displayChangeTask === null && S.settings.ratio === ratio,
        ratio
      );
      report.ratios.push(
        await page.evaluate(() => {
          const r = $('.image-card .cover-shell').getBoundingClientRect();
          return {
            ratio: S.settings.ratio,
            actual: r.width / r.height,
            height: r.height,
            cap:
              grid.width /
              Number(getComputedStyle(document.documentElement).getPropertyValue('--poster-ratio')),
            anchor: captureDisplayAnchor().kind
          };
        })
      );
    }
    assert.ok(report.ratios.every((r) => r.height <= r.cap + 1));
    await page.locator('#modal-close').click();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#back-to-top').click();
    await page.waitForFunction(() => $('#viewport').scrollTop === 0 && $('#back-to-top').hidden);
    report.returnToTop = await page.evaluate(() => ({
      scroll: $('#viewport').scrollTop,
      hidden: $('#back-to-top').hidden,
      focus: document.activeElement === $('#viewport')
    }));
    assert.deepEqual(report.returnToTop, { scroll: 0, hidden: true, focus: true });
    report.responsive = [];
    for (const [width, height, sidebar] of [
      [980, 680, 'expanded'],
      [1280, 800, 'auto'],
      [1920, 1032, 'auto'],
      [3840, 2160, 'expanded']
    ]) {
      await resize(width, height);
      await page.evaluate((sidebar) => saveSetting('sidebarMode', sidebar), sidebar);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => changeTheme(theme), theme);
        for (const density of [158, 186, 222]) {
          await choose(density);
          const layout = await page.evaluate(() => {
            const vp = $('#viewport'),
              bar = $('#toolbar').getBoundingClientRect(),
              left = $('.toolbar-left').getBoundingClientRect(),
              right = $('.toolbar-right').getBoundingClientRect(),
              controls = $('#card-size-controls').getBoundingClientRect();
            return {
              width: innerWidth,
              height: innerHeight,
              sidebar: S.settings.sidebarMode,
              theme: S.settings.theme,
              density: S.settings.density,
              columns: grid.cols,
              visible: [...grid.cards.values()].filter((b) => {
                const r = b.getBoundingClientRect(),
                  v = vp.getBoundingClientRect();
                return r.bottom > v.top && r.top < v.bottom;
              }).length,
              dom: grid.cards.size,
              cached: grid.items.size,
              overflow: vp.scrollWidth - vp.clientWidth,
              toolbarInside:
                bar.left >= vp.getBoundingClientRect().left &&
                bar.right <= vp.getBoundingClientRect().right + 1,
              groupsSeparated: left.right <= right.left + 1 || left.bottom <= right.top + 1,
              controlsInside: controls.left >= bar.left && controls.right <= bar.right,
              cssRatio: getComputedStyle(document.documentElement).getPropertyValue(
                '--poster-ratio'
              )
            };
          });
          assert.ok(layout.overflow <= 1, JSON.stringify(layout));
          assert.equal(layout.toolbarInside, true);
          assert.equal(layout.groupsSeparated, true);
          assert.equal(layout.controlsInside, true);
          assert.ok(
            layout.dom <= Math.max(300, layout.visible + layout.columns * 10),
            JSON.stringify(layout)
          );
          assert.ok(layout.cached <= 1440);
          report.responsive.push(layout);
        }
      }
      if (width === 980) await settledScreenshot(`artifacts/display-${label}-minimum-dark.png`);
      if (width === 3840) await settledScreenshot(`artifacts/display-${label}-4k-dark.png`);
    }
    await resize(1920, 1032);
    await page.evaluate(async () => {
      await saveSetting('sidebarMode', 'auto');
      await changeTheme('light');
      await changeDisplaySetting('density', 186);
      await changeDisplaySetting('ratio', 'square');
    });
    await app.close();
    app = null;
    await launch();
    report.restart = await page.evaluate(() => ({
      density: S.settings.density,
      ratio: S.settings.ratio,
      selected: $('#card-size-controls [aria-pressed=true]').textContent.trim(),
      categoryWidth: $('.collection-tile').getBoundingClientRect().width
    }));
    assert.equal(report.restart.density, 186);
    assert.equal(report.restart.ratio, 'square');
    assert.equal(report.restart.selected, '中');
    report.errors = [
      ...new Set([...report.errors, ...(await page.evaluate(() => window.__displayErrors))])
    ];
    assert.deepEqual(report.errors, []);
    const after = await Promise.all(roots.map(manifest));
    assert.deepEqual(after, before);
    report.sourceSafety = {
      files: before.flat().length,
      hashesSizesAndModificationTimesUnchanged: true
    };
    await fs.writeFile(`artifacts/display-${label}-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    await fs.writeFile(`artifacts/display-${label}-failure.json`, JSON.stringify(report, null, 2));
    if (page)
      await page.screenshot({ path: `artifacts/display-${label}-error.png` }).catch(() => {});
    console.error('DISPLAY VALIDATION ERROR', report.errors);
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    const resolved = path.resolve(data);
    assert.ok(resolved.startsWith(path.join(path.resolve(os.tmpdir()), 'acg-display-')));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
