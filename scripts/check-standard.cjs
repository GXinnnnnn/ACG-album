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
const out = path.join(
  path.resolve(process.env.ACG_RELEASE_OUTPUT || path.join(root, 'release', metadata.version)),
  'standard'
);
const archive = fs.realpathSync(path.join(root, 'artifacts'));
const isolated = path.join(
  archive,
  'standard',
  new Date().toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID()
);
const sevenZip = path.join(
  root,
  'node_modules/.pnpm/7zip-bin@5.2.0/node_modules/7zip-bin/win/x64/7za.exe'
);
const report = {
  variant: 'standard',
  version: metadata.version,
  isolated,
  executedInstallers: false,
  changedRegistry: false,
  checks: []
};
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
    assert.notEqual(
      entry.name.toLowerCase(),
      'local-index',
      'Standard must not contain a local-index folder: ' + file
    );
    if (entry.isDirectory()) files.push(...(await visit(file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}
async function bounds(page, selector) {
  const box = await page.locator(selector).evaluate((element) => {
    const r = element.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight
    };
  });
  assert.ok(
    box.x >= 0 && box.y >= 0 && box.right <= box.width + 1 && box.bottom <= box.height + 1,
    JSON.stringify(box)
  );
  return box;
}
(async () => {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/check-standard.cjs');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/, 'A stable release version is required');
  await fsp.mkdir(isolated, { recursive: true });
  console.log('ISOLATED ' + isolated);
  const build = JSON.parse(await fsp.readFile(path.join(out, 'build-report.json'), 'utf8'));
  const installer = path.join(out, `ACG-album-Setup-${metadata.version}-Standard.exe`);
  assert.equal(await digest(installer), build.sha256);
  assert.equal((await fsp.stat(installer)).size, build.bytes);
  Object.assign(report, { installer, installerBytes: build.bytes, sha256: build.sha256 });
  const wrapper = path.join(isolated, 'installer-payload');
  await fsp.mkdir(wrapper);
  seven(['t', '-bsp0', '-bso0', installer]);
  seven(['x', '-y', '-bsp0', '-bso0', '-o' + wrapper, installer]);
  const archives = (await visit(wrapper)).filter((file) => /app-(?:64|x64)\.7z$/i.test(file));
  let runtime = wrapper;
  if (archives.length) {
    assert.equal(archives.length, 1);
    seven(['t', '-bsp0', '-bso0', archives[0]]);
    runtime = path.join(isolated, 'application');
    seven(['x', '-y', '-bsp0', '-bso0', '-o' + runtime, archives[0]]);
  }
  assert.ok(fs.existsSync(path.join(runtime, 'ACG-album.exe')));
  assert.ok(fs.existsSync(path.join(runtime, 'resources/app.asar')));
  await visit(path.join(runtime, 'resources'));
  assert.equal(
    await digest(path.join(runtime, 'resources/app.asar')),
    await digest(path.join(out, 'win-unpacked/resources/app.asar'))
  );
  report.runtime = runtime;
  report.checks.push(
    'actual final NSIS tested and extracted with 7za; payload matches build and contains no local-index folder'
  );
  const profile = path.join(isolated, 'profile');
  const env = { ...process.env, ACG_TEST: '1', ACG_DATA_DIR: profile };
  for (const key of Object.keys(env))
    if (['ELECTRON_RUN_AS_NODE', 'ACG_LOCAL_INDEX_PATH'].includes(key.toUpperCase()))
      delete env[key];
  report.profile = profile;
  const errors = [];
  const consoleErrors = [];
  let app;
  try {
    app = await _electron.launch({
      executablePath: path.join(runtime, 'ACG-album.exe'),
      env,
      timeout: 60000
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.waitForSelector('#local-search-button', { timeout: 60000 });
    report.environment = await app.evaluate(({ app }) => {
      const pkg = process.mainModule.require(app.getAppPath() + '/package.json');
      return {
        packaged: app.isPackaged,
        version: app.getVersion(),
        searchEdition: pkg.searchEdition,
        userData: app.getPath('userData'),
        dataDir: process.env.ACG_DATA_DIR,
        test: process.env.ACG_TEST,
        runAsNode: process.env.ELECTRON_RUN_AS_NODE || null,
        indexOverride: process.env.ACG_LOCAL_INDEX_PATH || null
      };
    });
    assert.equal(report.environment.packaged, true);
    assert.equal(report.environment.version, metadata.version);
    assert.equal(report.environment.searchEdition, 'standard');
    assert.equal(path.resolve(report.environment.userData), path.join(profile, 'chromium-profile'));
    assert.equal(path.resolve(report.environment.dataDir), profile);
    assert.equal(report.environment.test, '1');
    assert.equal(report.environment.runAsNode, null);
    assert.equal(report.environment.indexOverride, null);
    report.status = await page.evaluate(() => window.album.call('localIndexStatus'));
    assert.equal(report.status.available, false);
    assert.equal(report.status.variant, null);
    assert.equal(report.status.error, undefined);
    assert.ok(!fs.existsSync(path.dirname(report.status.path)));
    report.searches = [];
    for (const query of ['', '千恋＊万花']) {
      const result = await page.evaluate(
        (query) => window.album.call('searchLocalIndex', { query, kind: 'subject' }),
        query
      );
      assert.equal(result.available, false);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.candidates, []);
      report.searches.push(result);
    }
    report.checks.push(
      `packaged Standard ${metadata.version} metadata, isolated profile, missing optional index and empty/nonempty search return without throwing`
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(980, 680)
    );
    await page.click('#local-search-button');
    await page.waitForSelector('#local-search-dialog[open]');
    await page.waitForFunction(
      () => !document.querySelector('#local-search-source').textContent.includes('正在读取')
    );
    report.missingPrompt = await page.locator('#local-search-source').innerText();
    assert.match(report.missingPrompt, /索引/);
    assert.match(report.missingPrompt, /未安装/);
    assert.match(report.missingPrompt, /资料库补全.*Lite.*Full/);
    assert.doesNotMatch(report.missingPrompt, /ENOENT/);
    await page.fill('#local-search-query', '千恋＊万花');
    await page.click('#local-search-submit');
    await page.waitForFunction(
      () => document.querySelector('#local-search-results').getAttribute('aria-busy') === 'false'
    );
    report.searchPrompt = {
      status: await page.locator('#local-search-status').innerText(),
      error: await page.locator('#local-search-error').textContent(),
      errorVisible: await page.locator('#local-search-error').isVisible()
    };
    assert.match(report.searchPrompt.status, /索引未安装/);
    assert.equal(report.searchPrompt.errorVisible, false);
    assert.doesNotMatch(report.searchPrompt.error, /ENOENT/);
    assert.equal(await page.locator('[data-local-result-id]').count(), 0);
    report.dialogBounds = {};
    for (const theme of ['light', 'dark']) {
      if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== theme)
        await page.locator('#theme-button').evaluate((button) => button.click());
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme
      );
      report.dialogBounds[theme] = await bounds(page, '#local-search-dialog');
      await page.screenshot({
        path: path.join(isolated, `missing-index-${theme}-980.png`),
        animations: 'disabled'
      });
    }
    report.checks.push(
      'missing-index prompt and empty results in actual bundled UI at 980px in light/dark'
    );
    await page.click('#local-search-close');
    await page.waitForSelector('#local-search-dialog', { state: 'detached' });
    const fixtureRoot = path.join(isolated, 'fixture-source');
    const fixtureAlbum = path.join(fixtureRoot, '离线验收相册');
    await fsp.mkdir(fixtureAlbum, { recursive: true });
    const image = await require('sharp')({
      create: { width: 32, height: 48, channels: 3, background: { r: 232, g: 185, b: 204 } }
    })
      .png()
      .toBuffer();
    for (let i = 0; i < 512; i++)
      await fsp.writeFile(path.join(fixtureAlbum, `fixture-${i}.png`), image);
    await app.evaluate(({ dialog, session }, selected) => {
      global.__standardNetwork = [];
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          global.__standardNetwork.push(details.url);
          callback({ cancel: true });
        }
      );
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, fixtureRoot);
    await page.evaluate(() => {
      window.__standardProgress = [];
      window.album.onEvent((event) => {
        if (event.type === 'progress') window.__standardProgress.push(event.data);
      });
      window.__fixtureImport = window.album.call('import', { onlineMatch: false });
    });
    await page.locator('#progress-panel').waitFor({ state: 'visible' });
    report.progress = await page.locator('#progress-panel').evaluate((panel) => ({
      state: panel.dataset.state,
      theme: document.documentElement.dataset.theme,
      role: panel.querySelector('[role="progressbar"]')?.getAttribute('role'),
      label: panel.querySelector('[role="progressbar"]')?.getAttribute('aria-label'),
      text: panel.textContent
    }));
    report.progress.bounds = await bounds(page, '#progress-panel');
    assert.equal(report.progress.role, 'progressbar');
    assert.ok(report.progress.label);
    await page.screenshot({
      path: path.join(isolated, 'import-progress-dark-980.png'),
      animations: 'disabled'
    });
    const imported = await page.evaluate(() => window.__fixtureImport);
    assert.equal(imported.cancelled, false);
    assert.equal(imported.errors, 0);
    report.imported = imported;
    report.importedFiles = (
      await page.evaluate((id) => window.album.call('get', { id }), imported.root)
    ).files;
    assert.equal(report.importedFiles, 512);
    report.importedImages = (
      await page.evaluate(() => window.album.call('list', { search: 'fixture-', filter: 'images' }))
    ).total;
    assert.equal(report.importedImages, 512);
    report.mediaStats = await page.evaluate(() => window.album.call('mediaStats'));
    assert.equal(
      report.mediaStats.rows.reduce((total, row) => total + row.count, 0),
      512
    );
    report.progressEvents = await page.evaluate(() => window.__standardProgress);
    assert.ok(report.progressEvents.length > 0);
    report.checks.push(
      '512 real Sharp PNG fixtures imported with onlineMatch:false; visible accessible progress within 980px bounds and 512 media'
    );
    const moved = path.join(isolated, 'fixture-moved');
    assert.equal(path.dirname(path.resolve(fixtureAlbum)), path.resolve(fixtureRoot));
    assert.equal(path.dirname(path.resolve(moved)), path.resolve(isolated));
    await fsp.rename(fixtureAlbum, moved);
    report.refreshed = await page.evaluate(
      (id) => window.album.call('refresh', { id }),
      imported.root
    );
    assert.equal(report.refreshed.cancelled, false);
    assert.equal(report.refreshed.errors, 0);
    report.remainingFiles = (
      await page.evaluate((id) => window.album.call('get', { id }), imported.root)
    ).files;
    report.remainingImages = (
      await page.evaluate(() => window.album.call('list', { search: 'fixture-', filter: 'images' }))
    ).total;
    assert.equal(report.remainingFiles, 0);
    assert.equal(report.remainingImages, 0);
    assert.equal((await fsp.stat(path.join(moved, 'fixture-0.png'))).size, image.length);
    report.networkRequests = await app.evaluate(() => global.__standardNetwork);
    assert.deepEqual(report.networkRequests, []);
    report.checks.push(
      'moving only isolated fixture subtree then refresh prunes files and image results to zero; no online requests'
    );
    // Run the exact packaged checkpoint module from a worker and observe its nested worker's real result.
    report.checkpoint = await app.evaluate(
      async ({ app }, probeFile) => {
        const { Worker } = process.mainModule.require('node:worker_threads');
        const checkpointModule = app.getAppPath() + '/src/sqlite-checkpoint.cjs';
        const source = `const {parentPort,workerData,Worker,threadId}=require('node:worker_threads');
        const {DatabaseSync}=require('node:sqlite');
        (async()=>{const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(value); INSERT INTO probe VALUES(1)');
        let nested;const maintenance=require(workerData.module).createSqliteCheckpoint(workerData.filename,{createWorker:(file,options)=>{const w=new Worker(file,options);nested={file,threadId:w.threadId,sqliteCheckpoint:options.workerData.sqliteCheckpoint};return w;}});
        try{const result=await maintenance.checkpoint();await maintenance.close();db.close();parentPort.postMessage({parentThreadId:threadId,nested,result});}catch(error){parentPort.postMessage({error:error.stack});process.exitCode=1;}})();`;
        return await new Promise((resolve, reject) => {
          const worker = new Worker(source, {
            eval: true,
            workerData: { filename: probeFile, module: checkpointModule }
          });
          const timer = setTimeout(() => {
            void worker.terminate();
            reject(new Error('Packaged nested checkpoint probe timed out'));
          }, 40000);
          worker.once('message', (result) => {
            clearTimeout(timer);
            void worker.terminate();
            resolve(result);
          });
          worker.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
      },
      path.join(profile, 'checkpoint-probe.sqlite')
    );
    assert.ok(!report.checkpoint.error, JSON.stringify(report.checkpoint));
    assert.ok(report.checkpoint.parentThreadId > 0);
    assert.ok(report.checkpoint.nested.threadId > 0);
    assert.notEqual(report.checkpoint.parentThreadId, report.checkpoint.nested.threadId);
    assert.ok(report.checkpoint.nested.file.includes('app.asar'));
    assert.equal(report.checkpoint.nested.sqliteCheckpoint, true);
    assert.equal(report.checkpoint.result.busy, 0);
    assert.ok(report.checkpoint.result.log > 0);
    assert.equal(report.checkpoint.result.checkpointed, report.checkpoint.result.log);
    report.checks.push(
      'exact packaged sqlite-checkpoint.cjs executes in nested worker and drains real WAL frames'
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    report.rendererErrors = errors;
    report.rendererConsoleErrors = consoleErrors;
    report.checks.push('no renderer page errors or error console messages');
  } finally {
    if (app) await app.close();
  }
  assert.equal(await digest(installer), build.sha256);
  await visit(path.join(runtime, 'resources'));
  report.ok = true;
  await fsp.writeFile(path.join(isolated, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    'VERIFIED ' +
      JSON.stringify({
        variant: 'standard',
        report: path.join(isolated, 'report.json'),
        checks: report.checks.length
      })
  );
})().catch(async (error) => {
  console.error(error.stack || error);
  await fsp.mkdir(isolated, { recursive: true });
  await fsp.writeFile(
    path.join(isolated, 'error.json'),
    JSON.stringify({ ...report, ok: false, error: error.stack || String(error) }, null, 2) + '\n'
  );
  process.exitCode = 1;
});
