'use strict';
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const report = {
  scope:
    'Source Electron, generated images/profile only. Real import, right-click binding settings and production RPCs. No personal library or public HTTP.',
  checks: [],
  screenshots: [],
  errors: [],
  sessions: []
};
let app, page, run, profile, collection, album, deep, config, session;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
async function check(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}
async function poll(label, action, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error('Timed out: ' + label);
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}

// The generated bootstrap changes no production source and blocks worker HTTP
// before the first scan. Local file delivery still uses Electron's real net.fetch.
function bootstrap(c) {
  const path = require('node:path'),
    electron = require('electron'),
    threads = require('node:worker_threads');
  const NativeWorker = threads.Worker;
  const probe = (global.__rootBinding = { calls: [], blocked: [] });
  threads.Worker = class extends NativeWorker {
    constructor(entry, options = {}) {
      const wrapped =
        typeof entry === 'string' && !options.eval && path.resolve(entry) === c.worker;
      super(
        wrapped ? c.wrapper : entry,
        wrapped
          ? { ...options, workerData: { ...options.workerData, rootBindingSource: c.worker } }
          : options
      );
      if (wrapped)
        this.on('message', (m) => {
          if (m.event === 'rootBindingHTTP') probe.blocked.push({ kind: 'worker', url: m.data });
        });
    }
    postMessage(message, ...args) {
      if (['setRootMatchPolicy', 'scan'].includes(message?.method))
        probe.calls.push({ method: message.method, args: message.args });
      return super.postMessage(message, ...args);
    }
  };
  const original = electron.net.fetch.bind(electron.net);
  electron.net.fetch = (value, options) => {
    const url = new URL(String(value));
    if (url.protocol === 'file:') {
      const file = require('node:url').fileURLToPath(url),
        relative = path.relative(c.run, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        return original(value, options);
    }
    probe.blocked.push({ kind: 'main-fetch', url: url.href });
    return Promise.reject(new Error('Non-fixture HTTP forbidden'));
  };
  electron.app.whenReady().then(() =>
    electron.session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        probe.blocked.push({ kind: 'session', url: details.url });
        callback({ cancel: true });
      }
    )
  );
  require(c.main);
}
async function launch() {
  assert.equal(app, undefined, 'Only one owned Electron may run');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    executablePath: require('electron'),
    args: [run],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  session = { rendererErrors: [], blockedRenderer: [] };
  report.sessions.push(session);
  page.on('pageerror', (error) => session.rendererErrors.push(error.stack));
  await app.context().route(/^https?:\/\//, async (route) => {
    session.blockedRenderer.push(route.request().url());
    await route.abort();
  });
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumDialogInteraction
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(
    ({ app, BrowserWindow, dialog }, c) => {
      const path = process.mainModule.require('node:path');
      if (path.resolve(app.getPath('userData')) !== path.resolve(c.profile, 'chromium-profile'))
        throw new Error('Profile isolation failed');
      if (app.isPackaged) throw new Error('Expected source Electron');
      const win = BrowserWindow.getAllWindows()[0];
      win.setFullScreen(false);
      win.unmaximize();
      win.setContentSize(1440, 1000);
      win.webContents.setBackgroundThrottling(false);
      win.show();
      win.focus();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [c.collection] });
    },
    { profile, collection }
  );
  assert.equal((await rpc('tokenStatus')).saved, false);
  assert.equal((await rpc('init')).localIndex.available, false);
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  app = undefined;
  let timer;
  try {
    session.probe = await closing.evaluate(() => global.__rootBinding);
    await Promise.race([
      closing.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron close timeout')), 15000);
      })
    ]);
    session.closed = true;
    assert.deepEqual(session.probe.blocked, []);
    assert.deepEqual(session.rendererErrors, []);
    assert.deepEqual(session.blockedRenderer, []);
  } catch (error) {
    const child = closing.process();
    if (child && child.exitCode === null && child.signalCode === null) {
      let exitTimer;
      try {
        await new Promise((resolve, reject) => {
          child.once('exit', resolve);
          exitTimer = setTimeout(() => reject(new Error('Owned Electron did not exit')), 5000);
          child.kill();
        });
      } finally {
        clearTimeout(exitTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function choose(selector, value) {
  const source = page.locator(selector);
  if ((await source.inputValue()) !== value) {
    const label = await source.locator(`option[value="${value}"]`).textContent();
    const button = source.locator('..').getByRole('combobox');
    await button.click();
    const list = await button.getAttribute('aria-controls');
    assert.ok(list);
    await page
      .locator('#' + list)
      .getByRole('option', { name: label, exact: true })
      .click();
  }
  await expect(source).toHaveValue(value);
}
async function openRootSettings() {
  await page.evaluate(() => navigate({ view: 'library', parent: null }));
  const card = page.locator(`.collection-tile[data-id="${idFor(collection)}"]`);
  await expect(card).toBeVisible();
  await card.locator('.collection-image').click({ button: 'right' });
  await page
    .locator('#context-menu')
    .getByRole('menuitem', { name: '分类绑定设置…', exact: true })
    .click();
  await expect(page.locator('#import-options')).toBeVisible();
  await expect(page.locator('#modal-title')).toContainText('绑定设置');
}
async function backdrop() {
  const rect = await page.locator('#modal').boundingBox();
  assert.ok(rect.x > 5);
  await page.mouse.click(2, rect.y + Math.min(100, rect.height / 2));
  await expect(page.locator('#modal')).toBeVisible();
}
function seedLegacyReview() {
  assert.equal(app, undefined, 'Database injection requires complete owned-app shutdown');
  const file = path.join(profile, 'library.sqlite');
  assert.ok(inside(run, file));
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    // Deliberate old review scope, with network kept OFF. This fixture is separate
    // from the unmodified restart/persistence check and is never a personal DB.
    db.prepare(
      'UPDATE root_match_policy SET auto_enabled=1,enabled=0,match_depth=2 WHERE root=?'
    ).run(idFor(collection));
    db.prepare(
      "UPDATE nodes SET confirmed=0,manual_cover=0,subject_id=NULL,manual_subject=0,cover_source='fallback',match_review=1 WHERE id=?"
    ).run(idFor(deep));
    db.prepare('INSERT OR REPLACE INTO match_pending(id,root,stamp) VALUES(?,?,?)').run(
      idFor(deep),
      idFor(collection),
      'generated-legacy-depth-two'
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  report.legacyInjection = {
    scope: 'Only closed generated profile; synthetic legacy review fixture',
    automaticReview: true,
    onlineMatch: false,
    matchDepth: 2,
    directory: path.basename(deep)
  };
}
(async () => {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const base = await fs.realpath(path.join(root, 'artifacts'));
  run = path.join(
    base,
    'root_binding',
    new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
      '_' +
      crypto.randomUUID().replace(/-/g, '_')
  );
  await fs.mkdir(run, { recursive: true });
  run = await fs.realpath(run);
  assert.ok(inside(base, run));
  profile = path.join(run, 'generated_profile');
  collection = path.join(run, 'generated_collection');
  album = path.join(collection, '一级作品');
  deep = path.join(album, '二级图片目录');
  await fs.mkdir(deep, { recursive: true });
  await sharp({ create: { width: 160, height: 220, channels: 3, background: '#759cbd' } })
    .png()
    .toFile(path.join(album, 'image_1.png'));
  await sharp({ create: { width: 180, height: 260, channels: 3, background: '#bd758e' } })
    .png()
    .toFile(path.join(deep, 'image_2.png'));
  config = {
    run,
    main: path.join(root, 'src', 'main.cjs'),
    worker: path.join(root, 'src', 'library-worker.cjs'),
    wrapper: path.join(run, 'worker_fixture.cjs')
  };
  await fs.writeFile(
    config.wrapper,
    "const {parentPort,workerData}=require('node:worker_threads'); global.fetch=async(url)=>{parentPort.postMessage({event:'rootBindingHTTP',data:String(url)});throw new Error('Fixture blocked unexpected worker HTTP');}; require(workerData.rootBindingSource);\n"
  );
  await fs.writeFile(
    path.join(run, 'bootstrap.cjs'),
    '(' + bootstrap.toString() + ')(' + JSON.stringify(config) + ');\n'
  );
  await fs.writeFile(
    path.join(run, 'package.json'),
    JSON.stringify({
      name: metadata.name,
      productName: metadata.productName,
      version: metadata.version,
      main: 'bootstrap.cjs'
    })
  );
  report.run = run;
  report.profile = profile;
  report.collection = collection;
  await launch();
  await check('real offline work import defaults to one matching level', async () => {
    assert.equal((await rpc('init')).roots.length, 0);
    await page.evaluate(async () => {
      await saveSetting('watchChanges', false);
      await saveSetting('autoMatch', false);
    });
    await page.locator('#import-sidebar').click();
    await expect(page.locator('#import-options')).toBeVisible();
    await choose('#import-directory-kind', 'work');
    await expect(page.locator('#import-match-depth')).toHaveValue('1');
    await expect(page.locator('#import-online-match')).not.toBeChecked();
    await page.locator('#import-options-confirm').click();
    await page.waitForFunction(
      () => !scanActive && pendingImport === null && S.roots.length === 1,
      null,
      { timeout: 60000 }
    );
    const policy = await rpc('getRootMatchPolicy', { id: idFor(collection) });
    assert.equal(policy.matchDepth, 1);
    assert.equal(policy.onlineMatch, false);
    assert.equal(policy.directoryKind, 'work');
    const node = await rpc('get', { id: idFor(deep) });
    assert.equal(node.depth, 2);
    assert.ok(node.cover);
    return { policy, deep: { depth: node.depth, files: node.files } };
  });
  await check(
    'root context settings save depth two and game type without implicitly enabling online',
    async () => {
      await openRootSettings();
      await expect(page.locator('#import-online-match')).not.toBeChecked();
      await choose('#import-match-depth', '2');
      await expect(page.locator('#import-online-match')).not.toBeChecked();
      // The current UI hides types offline. This changes only unsubmitted form
      // visibility; uncheck again before saving, so no online policy is ever sent.
      await page.locator('#import-online-match').check();
      for (const type of [1, 2, 6]) {
        const chip = page.locator(`[data-import-subject-type="${type}"]`);
        if ((await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
      }
      await expect(page.locator('[data-import-subject-type="4"]')).toHaveAttribute(
        'aria-pressed',
        'true'
      );
      await page.locator('#import-online-match').uncheck();
      await backdrop();
      await screenshot('depth_two_offline_before_save');
      await page.locator('#import-options-confirm').click();
      await expect(page.locator('#modal')).not.toBeVisible();
      const policy = await rpc('getRootMatchPolicy', { id: idFor(collection) });
      assert.equal(policy.matchDepth, 2);
      assert.equal(policy.onlineMatch, false);
      assert.equal(policy.enabled, false);
      assert.deepEqual(policy.subjectTypes, [4]);
      const calls = await app.evaluate(() =>
        global.__rootBinding.calls.filter((c) => c.method === 'setRootMatchPolicy')
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, { id: idFor(collection), subjectTypes: [4], matchDepth: 2 });
      return { policy, submittedPatch: calls[0].args, transientFormOnlyTypeSelection: true };
    }
  );
  await closeApp();
  await launch();
  await check(
    'depth and offline game policy survive an unmodified application restart',
    async () => {
      const policy = await rpc('getRootMatchPolicy', { id: idFor(collection) });
      assert.equal(policy.matchDepth, 2);
      assert.equal(policy.onlineMatch, false);
      assert.equal(policy.enabled, false);
      assert.deepEqual(policy.subjectTypes, [4]);
      await openRootSettings();
      await expect(page.locator('#import-match-depth')).toHaveValue('2');
      await expect(page.locator('#import-online-match')).not.toBeChecked();
      await page.keyboard.press('Escape');
      await expect(page.locator('#modal')).not.toBeVisible();
      return policy;
    }
  );
  await closeApp();
  seedLegacyReview();
  await launch();
  await check(
    'shrinking legacy depth-two scope removes pending review and the nested folder card dot',
    async () => {
      const before = await rpc('get', { id: idFor(deep) });
      assert.equal(before.review_eligible, true);
      assert.ok(
        (await rpc('list', { filter: 'pending', limit: 100 })).items.some(
          (n) => n.id === idFor(deep)
        ),
        'Generated legacy deep review is visible before reducing scope'
      );
      await openRootSettings();
      await choose('#import-match-depth', '1');
      await expect(page.locator('#import-online-match')).not.toBeChecked();
      await page.locator('#import-options-confirm').click();
      await expect(page.locator('#modal')).not.toBeVisible();
      const policy = await rpc('getRootMatchPolicy', { id: idFor(collection) });
      assert.equal(policy.matchDepth, 1);
      assert.equal(policy.onlineMatch, false);
      const after = await rpc('get', { id: idFor(deep) });
      assert.equal(after.review_eligible, false);
      assert.equal(after.match_review, 0);
      assert.ok(
        !(await rpc('list', { filter: 'pending', limit: 100 })).items.some(
          (n) => n.id === idFor(deep)
        )
      );
      await page.evaluate((parent) => navigate({ parent }), idFor(album));
      const card = page.locator(`.album-card[data-id="${idFor(deep)}"]`);
      await expect(card).toBeVisible();
      await expect(card.locator('.card-review')).toHaveCount(0);
      await screenshot('depth_one_nested_card_without_dot');
      return {
        policy,
        before: { reviewEligible: before.review_eligible },
        after: { reviewEligible: after.review_eligible, matchReview: after.match_review }
      };
    }
  );
  await check(
    'incremental update belongs to display modal heading and backdrop or Escape follow dialog policy',
    async () => {
      await expect(page.locator('#refresh-button:visible')).toHaveCount(0);
      await page.locator('#density-button').click();
      await expect(page.locator('#modal-title')).toHaveText('查看设置');
      const button = page.locator('#modal-heading-actions #refresh-button');
      await expect(button).toBeVisible();
      await expect(button).toHaveText('批量增量更新');
      const titleRect = await page.locator('#modal-title').boundingBox(),
        buttonRect = await button.boundingBox();
      assert.ok(
        buttonRect.x >= titleRect.x + titleRect.width,
        'Update action sits to the right of the modal title'
      );
      await backdrop();
      await page.keyboard.press('Escape');
      await expect(page.locator('#modal')).not.toBeVisible();
      await expect(page.locator('#refresh-button:visible')).toHaveCount(0);
      assert.equal(
        await page
          .locator('#refresh-button')
          .evaluateAll((buttons) => buttons.every((b) => !!b.closest('#modal'))),
        true
      );
      return { titleRect, buttonRect };
    }
  );
  await closeApp();
  await launch();
  await check('reduced scope and no deep review remain after final restart', async () => {
    const policy = await rpc('getRootMatchPolicy', { id: idFor(collection) });
    assert.equal(policy.matchDepth, 1);
    assert.equal(policy.onlineMatch, false);
    const node = await rpc('get', { id: idFor(deep) });
    assert.equal(node.match_review, 0);
    assert.equal(node.review_eligible, false);
    assert.ok(
      !(await rpc('list', { filter: 'pending', limit: 100 })).items.some(
        (n) => n.id === idFor(deep)
      )
    );
    await page.evaluate((parent) => navigate({ parent }), idFor(album));
    const card = page.locator(`.album-card[data-id="${idFor(deep)}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('.card-review')).toHaveCount(0);
    return policy;
  });
  await closeApp();
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'), { readOnly: true });
  try {
    assert.equal(
      db.prepare('SELECT count(*) count FROM match_pending WHERE id=?').get(idFor(deep)).count,
      0
    );
    report.finalDeepPendingCount = 0;
  } finally {
    db.close();
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
})()
  .catch(async (error) => {
    report.passed = false;
    report.failure = error.stack;
    process.exitCode = 1;
    if (page && run) await screenshot('failure').catch(() => {});
  })
  .finally(async () => {
    try {
      await closeApp();
    } catch (error) {
      report.errors.push(error.stack);
      report.passed = false;
      process.exitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    if (run) {
      const output = path.join(run, 'report.json');
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(output);
    }
  });
