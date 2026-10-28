'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { _electron } = require('@playwright/test');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const releaseRoot = path.resolve(
  process.env.ACG_RELEASE_OUTPUT || path.join(root, 'release', metadata.version)
);
const archive = fs.realpathSync(path.join(root, 'artifacts'));
const run = path.join(
  archive,
  'search-editions',
  new Date().toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID()
);
const sevenZip = path.join(
  root,
  'node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin/win/x64/7za.exe'
);
const variants = process.argv.slice(2);
if (
  variants.some((v) => !['lite', 'full'].includes(v)) ||
  new Set(variants).size !== variants.length
)
  throw new Error('Usage: node scripts/check-search-editions.cjs [lite] [full]');
if (!variants.length) variants.push('lite', 'full');
async function digest(file) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}
function seven(args) {
  const result = spawnSync(sevenZip, args, { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, '7-Zip failed: ' + args.join(' '));
}
async function visit(directory) {
  const files = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await visit(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function check(variant) {
  const label = variant === 'lite' ? 'Lite' : 'Full';
  const out = path.join(releaseRoot, variant);
  const build = JSON.parse(await fsp.readFile(path.join(out, 'build-report.json'), 'utf8'));
  const installer = path.join(out, `ACG-album-Setup-${metadata.version}-${label}.exe`);
  assert.equal(await digest(installer), build.sha256);
  const isolated = path.join(run, variant);
  const wrapper = path.join(isolated, 'installer-payload');
  await fsp.mkdir(wrapper, { recursive: true });
  // Inspect and extract the actual NSIS payload without executing the installer or changing registry/shortcuts.
  seven(['t', '-bsp0', '-bso0', installer]);
  seven(['x', '-y', '-bsp0', '-bso0', '-o' + wrapper, installer]);
  const archives = (await visit(wrapper)).filter((file) => /app-(?:64|x64)\.7z$/i.test(file));
  let runtime = wrapper;
  if (archives.length) {
    assert.equal(archives.length, 1, 'Exactly one x64 application payload is expected');
    seven(['t', '-bsp0', '-bso0', archives[0]]);
    runtime = path.join(isolated, 'application');
    seven(['x', '-y', '-bsp0', '-bso0', '-o' + runtime, archives[0]]);
  } else {
    // Standalone 7za can detect the embedded 7z stream directly inside NSIS.
    assert.ok(fs.existsSync(path.join(runtime, 'ACG-album.exe')));
    assert.ok(fs.existsSync(path.join(runtime, 'resources/app.asar')));
  }
  const index = path.join(runtime, 'resources/local-index/subjects.sqlite');
  const manifest = JSON.parse(
    await fsp.readFile(path.join(runtime, 'resources/local-index/manifest.json'), 'utf8')
  );
  assert.equal(manifest.variant, variant);
  assert.equal((await fsp.stat(index)).size, manifest.bytes);
  assert.equal(await digest(index), manifest.sha256);
  assert.equal(
    await digest(path.join(runtime, 'resources/app.asar')),
    await digest(path.join(out, 'win-unpacked/resources/app.asar'))
  );
  const originalIndex = await fsp.stat(index);
  const errors = [];
  const profile = path.join(isolated, 'profile');
  const env = { ...process.env, ACG_TEST: '1', ACG_DATA_DIR: profile };
  for (const key of Object.keys(env))
    if (['ELECTRON_RUN_AS_NODE', 'ACG_LOCAL_INDEX_PATH'].includes(key.toUpperCase()))
      delete env[key];
  let app;
  const report = {
    variant,
    installer,
    installerBytes: build.bytes,
    sha256: build.sha256,
    payloadExtracted: true,
    indexVerified: true,
    profile,
    checks: []
  };
  try {
    const started = performance.now();
    app = await _electron.launch({
      executablePath: path.join(runtime, 'ACG-album.exe'),
      env,
      timeout: 60000
    });
    const page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('#local-search-button', { timeout: 60000 });
    report.launchMs = Math.round(performance.now() - started);
    assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    assert.equal(await app.evaluate(({ app }) => app.getVersion()), metadata.version);
    const status = await page.evaluate(() => window.album.call('localIndexStatus'));
    assert.equal(status.available, true, JSON.stringify(status));
    assert.equal(status.variant, variant);
    assert.equal(status.dataVersion, manifest.dataVersion);
    assert.equal(path.resolve(status.path), path.resolve(index));
    report.status = status;
    report.checks.push('packaged app version and bundled variant discovered');
    const queries = [
      { query: '千恋＊万花', kind: 'subject', types: [4], id: 172612 },
      { query: 'AIR', kind: 'subject', types: [4], id: 232 },
      { query: '朝武芳乃', kind: 'character', subjectId: 172612, id: 39360 },
      { query: 'こぶいち', kind: 'person', subjectId: 172612, id: 5795 }
    ];
    report.queries = [];
    for (const query of queries) {
      const { id, ...args } = query;
      const queryStarted = performance.now();
      const result = await page.evaluate(
        (args) => window.album.call('searchLocalIndex', args),
        args
      );
      assert.equal(result.available, true);
      const found = result.candidates.find((item) => item.id === id);
      assert.ok(
        found,
        JSON.stringify({
          args,
          candidates: result.candidates.map((c) => ({ id: c.id, name: c.name }))
        })
      );
      if (args.kind === 'subject') assert.equal(found.type, 4);
      if (args.query === '千恋＊万花') {
        if (variant === 'full')
          assert.ok(found.summary?.length > 20, 'Full archive should contain real summary');
        else assert.ok(!found.summary, 'Lite archive deliberately strips long summary');
      }
      report.queries.push({
        ...args,
        found: id,
        complete: result.complete,
        truncated: result.truncated,
        elapsedMs: Math.round(performance.now() - queryStarted),
        candidates: result.candidates.map((c) => ({ id: c.id, name: c.name, type: c.type }))
      });
    }
    report.checks.push('real subject, restricted game, character and person searches');
    const mismatch = await page.evaluate(() =>
      window.album.call('searchLocalIndex', { query: '千恋＊万花', kind: 'subject', types: [2] })
    );
    assert.ok(!mismatch.candidates.some((c) => c.id === 172612));
    report.checks.push('subject type guard');
    await page.click('#local-search-button');
    await page.waitForSelector('#local-search-dialog[open]');
    await page
      .locator('#local-search-source')
      .filter({ hasText: variant === 'lite' ? '精简检索' : '完整检索' })
      .waitFor();
    await page.selectOption('#local-search-type', '4', { force: true });
    await page.fill('#local-search-query', '千恋＊万花');
    await page.click('#local-search-submit');
    await page.waitForFunction(() =>
      document.querySelector('#local-search-results')?.textContent.includes('千恋＊万花')
    );
    if (variant === 'full') {
      await page.click('[data-local-result-id="172612"] .local-search-summary summary');
      assert.ok(
        (await page.locator('[data-local-result-id="172612"] .local-search-summary p').innerText())
          .length > 20
      );
    } else assert.equal(await page.locator('.local-search-summary').count(), 0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
    );
    await page.screenshot({ path: path.join(isolated, 'local-search-light.png') });
    for (const input of [
      { kind: 'person', query: 'こぶいち', id: 5795 },
      { kind: 'character', query: '朝武芳乃', id: 39360 }
    ]) {
      await page.selectOption('#local-search-kind', input.kind, { force: true });
      await page.fill('#local-search-subject', '172612');
      await page.fill('#local-search-query', input.query);
      await page.click('#local-search-submit');
      await page.waitForSelector(`[data-local-result-id="${input.id}"]`);
    }
    report.checks.push('bundled subject/person/character forms and full-only summary');
    await page.selectOption('#local-search-kind', 'subject', { force: true });
    await page.selectOption('#local-search-type', '4', { force: true });
    await page.fill('#local-search-query', '千恋＊万花');
    await page.click('#local-search-submit');
    await page.waitForSelector('[data-local-result-id="172612"]');
    await page.locator('#theme-button').evaluate((button) => button.click());
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(980, 680)
    );
    const bounds = await page.locator('#local-search-dialog').evaluate((dialog) => {
      const r = dialog.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        scroll: getComputedStyle(dialog.querySelector('.local-search-scroll')).overflowY
      };
    });
    assert.ok(
      bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.right <= bounds.width + 1 &&
        bounds.bottom <= bounds.height + 1,
      JSON.stringify(bounds)
    );
    assert.ok(['auto', 'scroll'].includes(bounds.scroll));
    await page.screenshot({ path: path.join(isolated, 'local-search-dark-980.png') });
    report.checks.push('actual bundled UI search, light/dark and 980px bounds');
    await page.click('#local-search-close');
    await page.waitForSelector('#local-search-dialog', { state: 'detached' });
    const styles = await page.evaluate(() => ({
      stylesheets: [...document.styleSheets].map((s) => s.href),
      progress: !!document.querySelector('#progress-panel')
    }));
    report.ui = styles;
    const fixtureRoot = path.join(isolated, 'fixture-source');
    const fixtureAlbum = path.join(fixtureRoot, '离线验收相册');
    await fsp.mkdir(fixtureAlbum, { recursive: true });
    const image = await require('sharp')({
      create: { width: 32, height: 48, channels: 3, background: { r: 232, g: 185, b: 204 } }
    })
      .png()
      .toBuffer();
    const fixtureFiles = 512;
    for (let i = 0; i < fixtureFiles; i++)
      await fsp.writeFile(path.join(fixtureAlbum, `fixture-${i}.png`), image);
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, fixtureRoot);
    await page.evaluate(() => {
      window.__fixtureImport = window.album.call('import', { onlineMatch: false });
    });
    await page.locator('#progress-panel').waitFor({ state: 'visible' });
    report.progress = await page.locator('#progress-panel').evaluate((panel) => {
      const r = panel.getBoundingClientRect();
      return {
        state: panel.dataset.state,
        theme: document.documentElement.dataset.theme,
        x: r.x,
        y: r.y,
        right: r.right,
        bottom: r.bottom,
        width: innerWidth,
        height: innerHeight,
        role: panel.querySelector('[role="progressbar"]')?.getAttribute('role'),
        label: panel.querySelector('[role="progressbar"]')?.getAttribute('aria-label')
      };
    });
    assert.ok(report.progress.x >= 0 && report.progress.y >= 0);
    assert.ok(report.progress.right <= report.progress.width + 1);
    assert.ok(report.progress.bottom <= report.progress.height + 1);
    assert.equal(report.progress.theme, 'dark');
    assert.equal(report.progress.role, 'progressbar');
    assert.ok(report.progress.label);
    await page.screenshot({
      path: path.join(isolated, 'import-progress-dark-980.png'),
      animations: 'disabled'
    });
    const imported = await page.evaluate(() => window.__fixtureImport);
    assert.equal(imported.cancelled, false);
    assert.equal(imported.errors, 0);
    assert.equal(
      (await page.evaluate((id) => window.album.call('get', { id }), imported.root)).files,
      fixtureFiles
    );
    assert.equal(
      (
        await page.evaluate(() =>
          window.album.call('list', { search: 'fixture-', filter: 'images' })
        )
      ).total,
      fixtureFiles
    );
    report.checks.push('packaged import progress layout, accessible label and 980px bounds');
    const moved = path.join(isolated, 'fixture-moved');
    assert.equal(path.dirname(path.resolve(fixtureAlbum)), path.resolve(fixtureRoot));
    assert.equal(path.dirname(path.resolve(moved)), path.resolve(isolated));
    // Imported thumbnails may briefly hold Windows file handles after the scan
    // RPC resolves. Bound the wait, then retry only transient sharing failures.
    await page.waitForFunction(() => [...document.images].every((image) => image.complete));
    const moveDeadline = performance.now() + 5000;
    for (;;) {
      try {
        await fsp.rename(fixtureAlbum, moved);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || performance.now() >= moveDeadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const pruned = await page.evaluate((id) => window.album.call('refresh', { id }), imported.root);
    assert.equal(pruned.cancelled, false);
    assert.equal(pruned.errors, 0);
    assert.equal(
      (await page.evaluate((id) => window.album.call('get', { id }), imported.root)).files,
      0
    );
    assert.equal(
      (
        await page.evaluate(() =>
          window.album.call('list', { search: 'fixture-', filter: 'images' })
        )
      ).total,
      0
    );
    assert.equal((await fsp.stat(path.join(moved, 'fixture-0.png'))).size, image.length);
    report.checks.push(
      'isolated fixture import and subtree pruning with packaged checkpoint worker'
    );
    assert.deepEqual(errors, []);
    report.checks.push('no renderer errors');
  } finally {
    if (app) await app.close();
  }
  const after = await fsp.stat(index);
  assert.equal(after.size, originalIndex.size);
  assert.equal(after.mtimeMs, originalIndex.mtimeMs);
  report.checks.push('bundled database unchanged after queries');
  report.ok = true;
  await fsp.writeFile(path.join(isolated, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    'VERIFIED ' +
      JSON.stringify({
        variant,
        report: path.join(isolated, 'report.json'),
        checks: report.checks.length
      })
  );
  return report;
}
(async () => {
  await fsp.mkdir(run, { recursive: true });
  const reports = [];
  for (const variant of variants) reports.push(await check(variant));
  if (reports.length === 2) {
    for (let i = 0; i < reports[0].queries.length; i++)
      assert.deepEqual(
        reports[0].queries[i].candidates,
        reports[1].queries[i].candidates,
        'Same-version lite/full name search candidates should agree'
      );
  }
  const report = {
    ok: true,
    version: metadata.version,
    executedInstallers: false,
    changedRegistry: false,
    reports
  };
  await fsp.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('REPORT ' + path.join(run, 'report.json'));
})().catch(async (error) => {
  console.error(error.stack || error);
  await fsp.mkdir(run, { recursive: true });
  await fsp.writeFile(
    path.join(run, 'error.json'),
    JSON.stringify({ error: error.stack || String(error) }, null, 2) + '\n'
  );
  process.exitCode = 1;
});
