'use strict';
// Run serially after product changes: node scripts/check-import-matching.cjs [--packaged].
// Generated fixtures only. Never opens a real library, copies a profile, or decrypts credentials.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const metadata = require('../package.json');
const { idFor, searchTerms } = require('../src/model.cjs');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const run = path.join(
  root,
  'artifacts/import-matching',
  `${packaged ? 'packaged' : 'source'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
);
const profile = path.join(run, 'profile');
const fixtures = path.join(run, 'fixtures');
const localRoot = path.join(fixtures, 'local', 'CLANNAD');
const onlineRoot = path.join(fixtures, 'online', '截图');
const report = {
  packaged,
  version: metadata.version,
  run,
  checks: [],
  screenshots: [],
  errors: [],
  workerScans: [],
  unhandledRuns: [],
  limitations: [
    'Enabled GUI fixtures have generic titles and intentionally make no live Bangumi search; backend tests cover real candidate selection.'
  ],
  scope:
    'Generated fixtures; native picker stub only; real worker, scan, progress and network code.'
};
let app, page, before;
let stage = 'setup';
const sourceRows = [];
const expectedTypes = new Map([
  [2, '动画'],
  [1, '漫画'],
  [4, '游戏'],
  [6, '三次元']
]);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function withinRun(file) {
  const relative = path.relative(run, path.resolve(file));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  return file;
}
async function screenshot(name) {
  const file = withinRun(path.join(run, `${name}.png`));
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', ...(details ? { details } : {}) });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    if (page && !page.isClosed())
      await screenshot('failure-' + report.checks.length).catch(() => {});
    throw error;
  }
}
async function makeAlbum(directory) {
  withinRun(directory);
  await fs.mkdir(directory, { recursive: true });
  const files = [
    { name: 'a-old.png', color: '#d52b31', time: new Date('2020-01-02T03:04:05Z'), format: 'png' },
    {
      name: 'z-new.jpg',
      color: '#1cbe57',
      time: new Date(
        directory === localRoot || directory === onlineRoot
          ? '2024-05-06T07:08:09Z'
          : '2023-05-06T07:08:09Z'
      ),
      format: 'jpeg'
    }
  ];
  for (const item of files) {
    const file = withinRun(path.join(directory, item.name));
    const buffer = await sharp({
      create: { width: 96, height: 64, channels: 3, background: item.color }
    })
      .toFormat(item.format)
      .toBuffer();
    await fs.writeFile(file, buffer, { flag: 'wx' });
    await fs.utimes(file, item.time, item.time);
    sourceRows.push(file);
  }
}
async function manifest() {
  const rows = [];
  for (const file of [...sourceRows].sort()) {
    const stat = await fs.stat(file);
    rows.push({
      path: path.relative(fixtures, file),
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: hash(await fs.readFile(file))
    });
  }
  return rows;
}
async function launch() {
  withinRun(profile);
  const env = { ...process.env, ACG_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: packaged
      ? path.join(
          require('./distribution-paths.cjs').runtimeDirectory(),
          `${metadata.build.productName}.exe`
        )
      : require('electron'),
    args: packaged ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') report.errors.push({ stage, message: message.text() });
  });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname !== undefined);
  const runtime = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    version: app.getVersion(),
    packaged: app.isPackaged
  }));
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  assert.equal(
    runtime.version,
    metadata.version,
    'Rebuild packaged app before running this suite.'
  );
  assert.equal(runtime.packaged, packaged);
  assert.equal(await page.title(), metadata.build.productName);
  report.runtime = runtime;
  await app.evaluate(({ BrowserWindow, dialog }, run) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 960);
    win.webContents.setBackgroundThrottling(false);
    const { Worker } = process.mainModule.require('node:worker_threads');
    const originalPost = Worker.prototype.postMessage;
    global.__importProbe = { scans: [], pickers: [], queue: [], waiting: null };
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.method === 'scan')
        global.__importProbe.scans.push(JSON.parse(JSON.stringify(message)));
      return originalPost.call(this, message, ...rest);
    };
    // The native chooser alone is stubbed; every selection is bounded to this UUID run.
    dialog.showOpenDialog = async (_window, options) => {
      const probe = global.__importProbe;
      probe.pickers.push({ title: options?.title, properties: options?.properties });
      const choice = probe.queue.shift();
      if (!choice) throw new Error('Unexpected native picker request.');
      for (const file of choice.filePaths || []) {
        if (!file.startsWith(run + process.mainModule.require('node:path').sep))
          throw new Error('Non-fixture selection refused.');
      }
      const result = { canceled: !!choice.canceled, filePaths: choice.filePaths || [] };
      if (choice.hold)
        return new Promise((resolve) => {
          probe.waiting = () => resolve(result);
        });
      return result;
    };
  }, run);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    window.__importErrors = [];
    window.addEventListener('unhandledrejection', (event) =>
      __importErrors.push(String(event.reason?.message || event.reason))
    );
    await saveSetting('watchChanges', false);
    await saveSetting('sidebarMode', 'compact');
    await saveSetting('theme', 'light');
  });
}
async function closeApp() {
  if (!app) return;
  const scans = await app.evaluate(() => global.__importProbe?.scans || []).catch(() => []);
  report.workerScans.push(...scans);
  if (page && !page.isClosed())
    report.unhandledRuns.push(
      await page.evaluate(() => window.__importErrors || []).catch(() => [])
    );
  await app.close();
  app = page = null;
}
async function probe() {
  return app.evaluate(() => ({
    scans: global.__importProbe.scans,
    pickers: global.__importProbe.pickers,
    waiting: !!global.__importProbe.waiting
  }));
}
async function queuePicker(choice) {
  await app.evaluate((_, choice) => global.__importProbe.queue.push(choice), choice);
}
async function waitForPicker(count) {
  const deadline = Date.now() + 10000;
  while ((await probe()).pickers.length < count) {
    if (Date.now() >= deadline) throw new Error('Native picker request did not arrive.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function releasePicker() {
  await app.evaluate(() => {
    const release = global.__importProbe.waiting;
    if (!release) throw new Error('Expected a held native chooser.');
    global.__importProbe.waiting = null;
    release();
  });
}
async function idle() {
  await page.waitForFunction(() => !pendingImport && !scanActive, null, { timeout: 60000 });
}
async function viewState() {
  return page.evaluate(() => ({
    parent: S.parent,
    view: S.view,
    filter: S.filter,
    search: S.search,
    viewer: $('#viewer').open,
    viewed: V.node?.id || null
  }));
}
async function openImport() {
  await page.locator('#import-sidebar').click();
  await page.locator('#import-options').waitFor({ state: 'visible' });
}
async function selectedTypes() {
  return page
    .locator('[data-import-subject-type][aria-pressed="true"]')
    .evaluateAll((buttons) =>
      buttons.map((button) => Number(button.dataset.importSubjectType)).sort((a, b) => a - b)
    );
}
async function chooseTypes(types) {
  for (const type of expectedTypes.keys()) {
    const button = page.locator(`[data-import-subject-type="${type}"]`);
    if (((await button.getAttribute('aria-pressed')) === 'true') !== types.includes(type))
      await button.click();
  }
  assert.deepEqual(
    await selectedTypes(),
    [...types].sort((a, b) => a - b)
  );
}
function assertScan(message, directory, enabled, types) {
  assert.equal(path.resolve(message.args.path), path.resolve(directory));
  assert.equal(message.args.onlineMatch, enabled);
  assert.deepEqual(message.args.subjectTypes, types);
}
function rootPolicy(directory) {
  const db = new DatabaseSync(withinRun(path.join(profile, 'library.sqlite')), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT enabled,types,revision FROM root_match_policy WHERE root=?')
      .get(idFor(directory));
    assert.ok(row, 'Explicit import policy must persist for the root.');
    return { enabled: !!row.enabled, types: JSON.parse(row.types), revision: row.revision };
  } finally {
    db.close();
  }
}
async function getNode(directory) {
  return page.evaluate((id) => api('get', { id }), idFor(directory));
}
async function localCover(directory) {
  const node = await getNode(directory);
  assert.ok(node, 'Fixture directory must be indexed.');
  assert.equal(
    node.cover,
    idFor(path.join(directory, 'z-new.jpg')),
    'Latest mtime must beat alphabetical order.'
  );
  assert.notEqual(node.cover_source, 'bangumi');
  assert.equal(node.subject_id, null);
  assert.equal(node.crop_x, 50);
  assert.equal(node.crop_y, 50);
  assert.equal(node.crop_zoom, 1);
  await page.evaluate(async (parent) => {
    await navigate({ parent, filter: 'all', view: 'library' });
  }, node.parent || null);
  const card = page
    .locator(`.album-card[data-id="${node.id}"], .collection-tile[data-id="${node.id}"]`)
    .first();
  await card.waitFor({ state: 'visible' });
  // Progress events can replace an overview tile while its image is decoding.
  // Observe a connected, loaded image and its computed state in one DOM turn.
  const rendered = await page.waitForFunction(
    ({ id, cover }) => {
      const image = document.querySelector(
        `.album-card[data-id="${id}"] img, .collection-tile[data-id="${id}"] img`
      );
      if (!image?.isConnected || !image.complete || !image.naturalWidth) return null;
      const style = getComputedStyle(image);
      const state = {
        src: image.src,
        position: style.objectPosition,
        fit: style.objectFit,
        zoom: image.style.getPropertyValue('--crop-zoom')
      };
      return new URL(state.src).pathname === '/' + cover &&
        state.position === '50% 50%' &&
        state.fit === 'cover' &&
        Number(state.zoom) === 1
        ? state
        : null;
    },
    { id: node.id, cover: node.cover },
    { timeout: 10000 }
  );
  const displayed = await rendered.jsonValue();
  assert.equal(new URL(displayed.src).hostname, 'thumb');
  assert.equal(new URL(displayed.src).pathname, '/' + node.cover);
  assert.equal(displayed.position, '50% 50%');
  assert.equal(displayed.fit, 'cover');
  assert.equal(Number(displayed.zoom), 1);
  return { directory: path.relative(fixtures, directory), cover: node.cover, displayed };
}
(async () => {
  await fs.mkdir(run, { recursive: true });
  try {
    for (const directory of [
      localRoot,
      path.join(localRoot, 'CG'),
      onlineRoot,
      path.join(onlineRoot, 'CG'),
      path.join(onlineRoot, 'screenshots')
    ])
      await makeAlbum(directory);
    before = await manifest();
    report.originalsBefore = before;
    report.networkPreflight = ['截图', 'CG', 'screenshots'].map((name) => ({
      name,
      terms: searchTerms(name)
    }));
    for (const item of report.networkPreflight)
      assert.deepEqual(item.terms, [], 'Generic online fixture must never produce search terms.');
    await launch();
    await check('fresh isolated application and default local-only import', async () => {
      assert.equal((await page.evaluate(() => api('init'))).roots.length, 0);
      await openImport();
      const toggle = page.locator('#import-online-match');
      assert.equal(await toggle.isChecked(), false);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('#import-subject-types').isVisible(), false);
      for (const [type, label] of expectedTypes) {
        const button = page.locator(`[data-import-subject-type="${type}"]`);
        assert.equal((await button.textContent()).trim(), label);
        assert.equal(await button.isDisabled(), true);
      }
      await toggle.focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('[data-import-subject-type]:focus').count(), 0);
      await screenshot('modal-off-light');
    });
    await check(
      'keyboard toggle, multiselect, inline validation and retained choices',
      async () => {
        const toggle = page.locator('#import-online-match');
        await toggle.focus();
        await page.keyboard.press('Space');
        assert.equal(await toggle.isChecked(), true);
        assert.equal(await page.locator('#import-subject-types').isVisible(), true);
        assert.deepEqual(await selectedTypes(), [1, 2, 4, 6]);
        await screenshot('modal-on-light');
        await chooseTypes([]);
        const initial = await probe();
        await page.locator('#import-options-confirm').click();
        assert.equal(await page.locator('#import-options-error').isVisible(), true);
        assert.match(await page.locator('#import-options-error').textContent(), /至少选择/);
        assert.deepEqual(
          await probe(),
          initial,
          'Invalid choice must not request a native dialog or a scan.'
        );
        await screenshot('modal-invalid-light');
        const anime = page.locator('[data-import-subject-type="2"]');
        await anime.focus();
        await page.keyboard.press('Space');
        assert.deepEqual(await selectedTypes(), [2]);
        await toggle.uncheck();
        await toggle.check();
        assert.deepEqual(await selectedTypes(), [2]);
        await page.evaluate(() => changeTheme('dark'));
        await screenshot('modal-on-dark');
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(980, 680)
        );
        await page.waitForFunction(() => innerWidth === 980 && innerHeight === 680);
        const bounds = await page.locator('#modal').boundingBox();
        assert.ok(
          bounds.x >= 0 &&
            bounds.y >= 0 &&
            bounds.x + bounds.width <= 981 &&
            bounds.y + bounds.height <= 681
        );
        await screenshot('modal-narrow-dark');
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
        );
        await page.evaluate(() => changeTheme('light'));
      }
    );
    await check(
      'cancel, Escape and cancelled or empty native selection preserve the view',
      async () => {
        const state = await viewState();
        const baseline = await probe();
        await page.locator('#import-options-cancel').click();
        assert.equal(
          await page
            .locator('#import-sidebar')
            .evaluate((button) => button === document.activeElement),
          true
        );
        assert.deepEqual(await viewState(), state);
        await openImport();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !$('#modal').open);
        assert.equal(
          await page
            .locator('#import-sidebar')
            .evaluate((button) => button === document.activeElement),
          true
        );
        assert.deepEqual(await probe(), baseline);
        for (const choice of [{ canceled: true }, { canceled: false, filePaths: [] }]) {
          await openImport();
          assert.deepEqual(await selectedTypes(), [2]);
          await queuePicker(choice);
          await page.locator('#import-options-confirm').click();
          await idle();
          assert.deepEqual(await viewState(), state);
          assert.equal((await probe()).scans.length, 0);
          assert.equal((await page.evaluate(() => api('init'))).roots.length, 0);
        }
        await openImport();
        assert.deepEqual(await selectedTypes(), [2]);
        await page.locator('#import-options-cancel').click();
      }
    );
    await check(
      'explicit disabled import overrides global matching and chooses newest centered descendants',
      async () => {
        await page.evaluate(() => saveSetting('autoMatch', true));
        await openImport();
        await page.locator('#import-online-match').uncheck();
        const baseline = await probe();
        await queuePicker({ filePaths: [localRoot], hold: true });
        // Two activations in one event turn exercise the actual submit guard.
        await page.locator('#import-options-confirm').evaluate((button) => {
          button.click();
          button.click();
        });
        await waitForPicker(baseline.pickers.length + 1);
        assert.equal((await probe()).pickers.length, baseline.pickers.length + 1);
        assert.equal((await probe()).scans.length, baseline.scans.length);
        await releasePicker();
        await idle();
        const scans = (await probe()).scans;
        assert.equal(scans.length, baseline.scans.length + 1);
        assertScan(scans.at(-1), localRoot, false, [2]);
        const covers = [];
        for (const directory of [localRoot, path.join(localRoot, 'CG')])
          covers.push(await localCover(directory));
        await screenshot('local-newest-centered');
        return { captures: scans.length, covers };
      }
    );
    await check(
      'refresh preserves per-root disabled policy and manual local cover crop',
      async () => {
        const id = idFor(localRoot);
        await page.evaluate(
          async ({ id, imageId }) => {
            await api('setCover', { id, imageId });
            await api('patch', { id, changes: { crop_x: 23, crop_y: 71, crop_zoom: 1.4 } });
            await api('refresh', { id });
          },
          { id, imageId: idFor(path.join(localRoot, 'a-old.png')) }
        );
        const node = await getNode(localRoot);
        assert.equal(node.manual_cover, 1);
        assert.equal(node.cover, idFor(path.join(localRoot, 'a-old.png')));
        assert.equal(node.cover_source, 'manual');
        assert.equal(node.subject_id, null);
        assert.equal(node.crop_x, 23);
        assert.equal(node.crop_y, 71);
        assert.equal(node.crop_zoom, 1.4);
        report.manual = {
          cover: node.cover,
          crop_x: node.crop_x,
          crop_y: node.crop_y,
          crop_zoom: node.crop_zoom
        };
      }
    );
    await check(
      'explicit enabled narrow types reach worker despite legacy setting and preserve changed view and viewer',
      async () => {
        await page.evaluate(() => saveSetting('autoMatch', false));
        await openImport();
        await page.locator('#import-online-match').check();
        await chooseTypes([4]);
        const baseline = await probe();
        await queuePicker({ filePaths: [onlineRoot], hold: true });
        await page.locator('#import-options-confirm').click();
        await waitForPicker(baseline.pickers.length + 1);
        await page.waitForFunction(() => !!pendingImport);
        const viewedId = idFor(path.join(localRoot, 'z-new.jpg'));
        await page.evaluate(
          async ({ parent, viewedId }) => {
            await navigate({ parent, view: 'library', filter: 'images' });
            await openViewer(await api('get', { id: viewedId }));
          },
          { parent: idFor(localRoot), viewedId }
        );
        await page.waitForFunction(() => $('#viewer').open && $('#viewer-image').naturalWidth > 0);
        const chosen = await viewState();
        await releasePicker();
        await idle();
        assert.deepEqual(await viewState(), chosen);
        const scans = (await probe()).scans;
        assert.equal(scans.length, baseline.scans.length + 1);
        assertScan(scans.at(-1), onlineRoot, true, [4]);
        assert.equal((await getNode(onlineRoot)).subject_id, null);
        await screenshot('viewer-preserved-after-import');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !$('#viewer').open);
        for (const directory of [
          onlineRoot,
          path.join(onlineRoot, 'CG'),
          path.join(onlineRoot, 'screenshots')
        ])
          await localCover(directory);
        return { scan: scans.at(-1), preserved: chosen };
      }
    );
    report.policiesBeforeRestart = { local: rootPolicy(localRoot), online: rootPolicy(onlineRoot) };
    assert.deepEqual(report.policiesBeforeRestart.local, {
      enabled: false,
      types: [2],
      revision: 1
    });
    assert.deepEqual(report.policiesBeforeRestart.online, {
      enabled: true,
      types: [4],
      revision: 1
    });
    await closeApp();
    await launch();
    await check('restart retains local/manual results and independent root policies', async () => {
      assert.equal((await page.evaluate(() => api('init'))).roots.length, 2);
      const manual = await getNode(localRoot);
      assert.equal(manual.manual_cover, 1);
      for (const [key, value] of Object.entries(report.manual)) assert.equal(manual[key], value);
      assert.equal(manual.subject_id, null);
      await page.evaluate(
        async (ids) => {
          await saveSetting('autoMatch', true);
          await api('refresh', { id: ids.local });
          await saveSetting('autoMatch', false);
          await api('refresh', { id: ids.online });
        },
        { local: idFor(localRoot), online: idFor(onlineRoot) }
      );
      assert.equal((await getNode(localRoot)).subject_id, null);
      assert.equal((await getNode(onlineRoot)).subject_id, null);
      report.policiesAfterRestart = {
        local: rootPolicy(localRoot),
        online: rootPolicy(onlineRoot)
      };
      assert.deepEqual(report.policiesAfterRestart, report.policiesBeforeRestart);
      await localCover(path.join(localRoot, 'CG'));
      await localCover(onlineRoot);
      return { localRoot: await getNode(localRoot), genericRoot: await getNode(onlineRoot) };
    });
    await closeApp();
    // Seed only this generated profile while the worker is closed. Backend
    // tests separately exercise ranking, real assignment and persistence.
    const reviewDb = new DatabaseSync(withinRun(path.join(profile, 'library.sqlite')));
    try {
      const seed = reviewDb.prepare(
        'UPDATE nodes SET match_confidence=?,match_review=?,subject_id=?,confirmed=1 WHERE id=?'
      );
      assert.equal(seed.run(40 / 47, 1, 420, idFor(localRoot)).changes, 1);
      assert.equal(seed.run(1, 0, 421, idFor(path.join(localRoot, 'CG'))).changes, 1);
    } finally {
      reviewDb.close();
    }
    await launch();
    await check(
      'persistent partial match badge is visible and readable in light and dark themes',
      async () => {
        const node = await getNode(localRoot);
        assert.equal(node.match_review, 1);
        assert.equal(node.manual_cover, 1);
        await page.evaluate(async () => navigate({ parent: null, view: 'library', filter: 'all' }));
        const partial = page.locator(`.collection-tile[data-id="${node.id}"]`);
        await partial.waitFor({ state: 'visible' });
        assert.equal(await partial.locator('.match-review').innerText(), '匹配 85.1%');
        assert.match(
          await partial.locator('.collection-open').getAttribute('aria-label'),
          /匹配 85.1%.*更改作品关联/
        );
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, theme);
          const badge = partial.locator('.match-review');
          const dimensions = await badge.evaluate((el) => ({
            width: el.clientWidth,
            scroll: el.scrollWidth,
            height: el.clientHeight,
            size: getComputedStyle(el).fontSize
          }));
          assert.ok(dimensions.width >= dimensions.scroll);
          assert.ok(dimensions.height > 10);
          assert.equal(dimensions.size, '12px');
          const badgeBounds = await badge.boundingBox();
          const labelBounds = await partial.locator('.collection-path').boundingBox();
          assert.ok(
            badgeBounds.x + badgeBounds.width <= labelBounds.x,
            'Match score must not overlap the category label.'
          );
          await screenshot('match-review-' + theme);
        }
        await page.evaluate(
          async (parent) => navigate({ parent, view: 'library', filter: 'all' }),
          node.id
        );
        const exact = await getNode(path.join(localRoot, 'CG'));
        const exactCard = page.locator(`.album-card[data-id="${exact.id}"]`);
        await exactCard.waitFor({ state: 'visible' });
        assert.equal(await exactCard.locator('.card-review').count(), 0);
        assert.doesNotMatch(await exactCard.getAttribute('aria-label'), /待确认|待核对/);
        return {
          fixtureStatesSeededWhileClosed: true,
          partialScore: node.match_confidence,
          exactScore: exact.match_confidence
        };
      }
    );
    await check(
      'pending list exposes correction and explicit confirmation clears the match badge',
      async () => {
        const id = idFor(localRoot);
        await page.evaluate(async () => navigate({ view: 'pending', parent: null, filter: 'all' }));
        const partial = page.locator(`.album-card[data-id="${id}"]`);
        await partial.waitFor({ state: 'visible' });
        await partial.click({ button: 'right' });
        await page.getByText('更改作品关联…', { exact: true }).waitFor({ state: 'visible' });
        await page.getByText('确认当前作品匹配', { exact: true }).click();
        await partial.waitFor({ state: 'detached' });
        const node = await getNode(localRoot);
        assert.equal(node.match_review, 0);
        assert.equal(node.confirmed, 1);
        assert.equal(node.manual_cover, 1);
        await page.evaluate(async () => navigate({ view: 'library', parent: null, filter: 'all' }));
        const tile = page.locator(`.collection-tile[data-id="${id}"]`);
        await tile.waitFor({ state: 'visible' });
        assert.equal(await tile.locator('.card-review').count(), 0);
        return { reviewCleared: true, manualCoverPreserved: true };
      }
    );
    await check(
      'import progress persists across scan, discovery, matching and paused states',
      async () => {
        const emit = async (type, data) =>
          app.evaluate(
            ({ BrowserWindow }, event) => {
              BrowserWindow.getAllWindows()[0].webContents.send('library:event', event);
            },
            { type, data }
          );
        await emit('progress', { active: true, name: '生成测试相册', images: 2, folders: 1 });
        await page.waitForFunction(
          () => !$('#progress-panel').hidden && $('#progress-percent').textContent === '扫描中…'
        );
        assert.equal(await page.locator('.progress-track').getAttribute('aria-valuenow'), null);
        await emit('online', {
          active: true,
          discovering: true,
          remaining: 3,
          completed: 0,
          total: 3
        });
        await emit('progress', { active: false, name: '生成测试相册', images: 2, folders: 1 });
        await page.waitForFunction(() => $('#progress-title').textContent === '正在检索作品简介');
        assert.equal(await page.locator('.progress-track').getAttribute('aria-valuenow'), null);
        assert.equal(await page.locator('#cancel-import').isVisible(), false);
        await emit('online', {
          active: true,
          discovering: false,
          remaining: 2,
          completed: 1,
          total: 3
        });
        await page.waitForFunction(() => $('#progress-percent').textContent === '33%');
        await page.waitForTimeout(6200);
        assert.equal(
          await page.locator('#progress-panel').isVisible(),
          true,
          'Scan completion must not hide ongoing matching.'
        );
        for (const paused of ['access', 'network']) {
          await emit('online', {
            active: false,
            paused,
            retryAt: Date.now() + 60000,
            remaining: 2,
            completed: 1,
            total: 3
          });
          await page.waitForFunction(() => $('#progress-panel').dataset.state === 'paused');
          assert.equal(await page.locator('#progress-percent').innerText(), '已暂停');
          assert.equal(await page.locator('.progress-track').getAttribute('aria-valuenow'), '33');
          assert.equal(await page.locator('#progress-panel').getAttribute('aria-busy'), 'false');
        }
        await page.waitForTimeout(6200);
        assert.equal(
          await page.locator('#progress-panel').isVisible(),
          true,
          'Retry/access pause stays visible.'
        );
        await emit('online', { active: true, remaining: 1, completed: 2, total: 3 });
        await page.waitForFunction(() => $('#progress-percent').textContent === '66%');
        await emit('online', { active: false, remaining: 0, completed: 3, total: 3 });
        await page.waitForFunction(() => $('#progress-title').textContent === '作品检索完成');
        assert.equal(await page.locator('.progress-track').getAttribute('aria-valuenow'), '100');
        assert.equal(await page.locator('.progress-spinner').isVisible(), false);
        return {
          source:
            'Synthetic progress IPC into the real generated-profile renderer; no remote service',
          matchingOutlivesScanTimer: true,
          pauseOutlivesHideTimer: true
        };
      }
    );
    await check(
      'live folder updates retain covers, focus and balanced title spacing in both themes',
      async () => {
        await page.evaluate(
          async (parent) => navigate({ parent, view: 'library', filter: 'all' }),
          idFor(localRoot)
        );
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.album-card:not(.media-card) img')].every(
            (img) => img.complete && img.naturalWidth
          )
        );
        const stability = await page.evaluate(async () => {
          const before = [...document.querySelectorAll('.album-card:not(.media-card)')].map(
            (el) => ({
              el,
              img: el.querySelector('img'),
              src: el.querySelector('img').getAttribute('src')
            })
          );
          before[0].el.focus();
          for (const [index, n] of grid.items) {
            if (n.kind === 'folder') {
              grid.items.set(index, { ...n, files: -1 });
              updateFolderCard(grid.cards.get(index), { ...n, files: 0 });
            }
          }
          {
            await grid.refreshGrowing();
            for (const row of before) {
              if (
                !row.el.isConnected ||
                row.el.querySelector('img') !== row.img ||
                row.img.getAttribute('src') !== row.src ||
                !row.img.complete
              )
                throw new Error('Folder update replaced a loaded card/cover.');
            }
            if (document.activeElement !== before[0].el)
              throw new Error('Folder update lost keyboard focus.');
            for (const [index, n] of grid.items) {
              if (n.kind !== 'folder') continue;
              const el = grid.cards.get(index);
              if (
                !el.querySelector('.card-bottom-overlay').textContent.includes(fmt(n.files) + ' 张')
              )
                throw new Error('Live count was not applied.');
              updateFolderCard(el, {
                ...n,
                name: '16bit的感动',
                files: 12345,
                metadata: { ...n.metadata, rating: { score: 8.6 } }
              });
            }
            if (!before[0].el.querySelector('.card-bottom-overlay').textContent.includes('12,345'))
              throw new Error('Updated count was not applied.');
            if (before[0].el.querySelector('.card-rating').textContent !== '★ 8.6')
              throw new Error('Updated rating was not applied.');
            return {
              cardsRetained: before.length,
              coverElementsRetained: true,
              keyboardFocusRetained: true
            };
          }
        });
        const dimensions = [];
        for (const width of [1440, 980]) {
          await app.evaluate(
            ({ BrowserWindow }, width) =>
              BrowserWindow.getAllWindows()[0].setContentSize(width, width === 980 ? 680 : 960),
            width
          );
          for (const theme of ['light', 'dark']) {
            await page.evaluate((theme) => {
              document.documentElement.dataset.theme = theme;
              showOnlineStatus({ active: true, remaining: 2, completed: 1, total: 3 });
              grid.layout();
            }, theme);
            const sample = await page
              .locator('.album-card:not(.media-card)')
              .first()
              .evaluate((el) => {
                const cover = el.querySelector('.cover-shell').getBoundingClientRect(),
                  title = el.querySelector('.card-title').getBoundingClientRect(),
                  subtitle = el.querySelector('.card-subtitle').getBoundingClientRect();
                const count = el.querySelector('.card-bottom-overlay > span:not(.card-rating)'),
                  rating = el.querySelector('.card-rating');
                const panel = document.querySelector('#progress-panel').getBoundingClientRect();
                return {
                  titleSize: getComputedStyle(el.querySelector('.card-title')).fontSize,
                  beforeTitle: title.top - cover.bottom,
                  afterTitle: subtitle.top - title.bottom,
                  countSize: getComputedStyle(count).fontSize,
                  iconWidth: el.querySelector('.card-bottom-overlay > svg').getBoundingClientRect()
                    .width,
                  textRight: count.getBoundingClientRect().right,
                  ratingLeft: rating.getBoundingClientRect().left,
                  panelLeft: panel.left,
                  panelRight: panel.right,
                  viewport: innerWidth
                };
              });
            assert.equal(sample.viewport, width, 'Validate the actual supported window width.');
            assert.equal(sample.titleSize, '16px');
            assert.ok(
              Math.abs(sample.beforeTitle - sample.afterTitle) <= 1,
              JSON.stringify(sample)
            );
            assert.equal(sample.countSize, '17px');
            assert.equal(sample.iconWidth, 20);
            assert.ok(sample.textRight <= sample.ratingLeft);
            assert.ok(sample.panelLeft >= 0 && sample.panelRight <= sample.viewport);
            dimensions.push({ width, theme, ...sample });
            await screenshot(`import-progress-cards-${width}-${theme}`);
          }
        }
        await page.evaluate(() => {
          window.__importStableView = {
            version: S.loadVersion,
            cards: [...document.querySelectorAll('.album-card:not(.media-card)')].map((el) => ({
              el,
              img: el.querySelector('img')
            }))
          };
          window.__importChangedSeen = false;
          window.__removeImportProbe = window.album.onEvent((event) => {
            if (event.type === 'changed') window.__importChangedSeen = true;
          });
        });
        await app.evaluate(
          ({ BrowserWindow }, id) =>
            BrowserWindow.getAllWindows()[0].webContents.send('library:event', {
              type: 'changed',
              data: { id }
            }),
          idFor(path.join(localRoot, 'CG'))
        );
        await page.waitForFunction(
          () => window.__importChangedSeen && !growingDirty && !growingTask && !growingTimer
        );
        await page.evaluate(() => {
          __removeImportProbe();
          if (
            S.loadVersion !== __importStableView.version ||
            !__importStableView.cards.every(
              (row) => row.el.isConnected && row.el.querySelector('img') === row.img
            )
          )
            throw new Error('Matching changed event rebuilt the current page.');
        });
        await page.evaluate(async () => {
          showOnlineStatus({ active: false, remaining: 0, completed: 3, total: 3 });
          await navigate({ parent: null, view: 'library', filter: 'all' });
          const tiles = [...document.querySelectorAll('.collection-tile')].map((el) => ({
            el,
            img: el.querySelector('img')
          }));
          await refreshGrowingView();
          if (!tiles.every((row) => row.el.isConnected && row.el.querySelector('img') === row.img))
            throw new Error('Overview refresh replaced a loaded collection.');
          const root = S.roots.find((n) => n.name === 'CLANNAD');
          S.overviewExpanded.add(root.id);
          await renderOverview(S.loadVersion);
          const preview = document.querySelector(
              `.collection-tile[data-id="${root.id}"] .collection-preview`
            ),
            children = [...preview.querySelectorAll('.album-card')],
            more = preview.querySelector('.collection-more');
          if (!children.length) throw new Error('Expanded preview fixture has no folders.');
          await renderOverview(S.loadVersion);
          if (
            preview.querySelectorAll('.album-card').length !== children.length ||
            !children.every((el) => el.isConnected) ||
            preview.querySelectorAll('.collection-more').length !== 1 ||
            preview.querySelector('.collection-more') !== more
          )
            throw new Error('Expanded preview duplicated or replaced retained cards/actions.');
        });
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
        );
        return {
          ...stability,
          dimensions,
          overviewCoversRetained: true,
          fixtures:
            'Real generated-profile list refresh; display-only title, count and rating samples'
        };
      }
    );
    await check(
      'renderer completes without errors and all source files stay unchanged',
      async () => {
        report.unhandledRejections = await page.evaluate(() => __importErrors);
        assert.deepEqual(report.errors, []);
        assert.deepEqual(report.unhandledRejections, []);
        assert.deepEqual(report.unhandledRuns.flat(), []);
        report.originalsAfter = await manifest();
        assert.deepEqual(report.originalsAfter, before);
        return {
          files: before.length,
          compared: 'sha256 + size + mtime; fixtures were not modified after baseline'
        };
      }
    );
  } catch (error) {
    report.failure = { stage, message: error.message, stack: error.stack };
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (page && !page.isClosed())
      report.finalUnhandledRejections = await page
        .evaluate(() => window.__importErrors || [])
        .catch(() => []);
    await closeApp().catch((error) => {
      report.shutdownError = error.message;
      process.exitCode = 1;
    });
    if (before) {
      report.originalsAfter = await manifest();
      report.originalsUnchanged = JSON.stringify(report.originalsAfter) === JSON.stringify(before);
      if (!report.originalsUnchanged) process.exitCode = 1;
    }
    report.passed = report.checks.filter((row) => row.status === 'passed').length;
    report.failed =
      report.checks.filter((row) => row.status === 'failed').length +
      (report.shutdownError ? 1 : 0);
    if (report.failure && report.failed === 0) report.failed = 1;
    report.success =
      !report.failure &&
      !report.shutdownError &&
      report.originalsUnchanged === true &&
      report.errors.length === 0 &&
      report.unhandledRuns.flat().length === 0;
    if (!report.success) process.exitCode = 1;
    report.finished = new Date().toISOString();
    await fs.writeFile(withinRun(path.join(run, 'report.json')), JSON.stringify(report, null, 2));
    console.log(
      'RESULT ' +
        JSON.stringify({
          run,
          passed: report.passed,
          failed: report.failed,
          originalsUnchanged: report.originalsUnchanged,
          failure: report.failure
        })
    );
  }
})().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
