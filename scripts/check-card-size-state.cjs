'use strict';
// Lead runs serially after other GUI/build work. Writing or syntax-checking this file launches nothing.
// ACG_APP_PATH/ACG_EXECUTABLE selects a source directory or .exe. ACG_CHECK_STAGE owns evidence.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const project = path.resolve(__dirname, '..');
const requested = path.resolve(process.env.ACG_APP_PATH || process.env.ACG_EXECUTABLE || project);
const packaged = /\.exe$/i.test(requested);
const executable = packaged ? requested : require('electron');
const stage = path.resolve(
  process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\release-1.2.1-20261103\\card-size-state'
);
const forcedDpr = process.env.ACG_TEST_DPR ? Number(process.env.ACG_TEST_DPR) : null;
if (forcedDpr !== null) assert.ok(Number.isFinite(forcedDpr) && forcedDpr >= 1 && forcedDpr <= 3);
const report = {
  passed: false,
  started: new Date().toISOString(),
  requested,
  packaged,
  forcedDpr,
  scope:
    'Real Electron native startup/maximize/resize, toolbar clicks, trusted range keyboard input and process restarts. Only new isolated profiles and six generated PNGs are used. Source worker seeds offline fixtures without a density row, except the explicitly labelled legacy-166 profile. Product settings/init handlers, CSS and layout remain intact. Main-to-worker density RPCs are observed and forwarded unchanged. No personal profile, original media, deployment, scan resumption or online matching.',
  checks: [],
  runtimes: [],
  samples: [],
  screenshots: [],
  errors: [],
  blockedNetwork: []
};
let run,
  profile,
  collection,
  app,
  page,
  currentCheck = 'prepare';
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function check(name, action) {
  currentCheck = name;
  try {
    await action();
    report.checks.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack || String(error) });
    throw error;
  }
}
async function seedProfile(name, density) {
  profile = path.join(run, name);
  assert.ok(inside(run, profile));
  const worker = new Worker(
    `globalThis.fetch = async () => { throw new Error('HTTP disabled by card-size fixture'); }; require(${JSON.stringify(path.join(project, 'src/library-worker.cjs'))});`,
    {
      eval: true,
      workerData: {
        dataDir: profile,
        watch: false,
        localIndexPath: path.join(run, 'absent-index.sqlite')
      }
    }
  );
  const pending = new Map();
  let sequence = 0;
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Fixture worker timed out: ' + method));
      }, 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Fixture worker did not become ready')),
        30000
      );
      worker.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.on('message', (message) => {
        if (message.event === 'ready') {
          clearTimeout(timer);
          resolve();
        }
        const task = pending.get(message.request);
        if (!task) return;
        clearTimeout(task.timer);
        pending.delete(message.request);
        message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
      });
    });
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['metadataOnboardingSeen', true],
      ['motionLevel', 'low']
    ])
      await call('settings', { key, value });
    if (density !== undefined) await call('settings', { key: 'density', value: density });
    const scanned = await call('scan', { path: collection, offline: true, onlineMatch: false });
    assert.equal(scanned.errors, 0);
    const settings = (await call('init', { lightweight: true })).settings;
    assert.equal(settings.densityConfigured, density !== undefined);
    assert.equal(settings.density, density === undefined ? 166 : density);
    await call('shutdown');
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    await worker.terminate();
  }
  await fs.writeFile(
    path.join(profile, 'window.json'),
    JSON.stringify({ width: 1600, height: 1000, maximized: true })
  );
}
async function prepare() {
  const personal = path.resolve('C:\\ACG\\.review-data');
  assert.ok(!samePath(personal, stage) && !inside(personal, stage));
  await fs.mkdir(stage, { recursive: true });
  const base = await fs.realpath(stage);
  assert.ok(!samePath(personal, base) && !inside(personal, base));
  run = path.join(base, (packaged ? 'packaged-' : 'source-') + randomUUID());
  assert.ok(inside(base, run));
  await fs.mkdir(run);
  collection = path.join(run, 'generated-six-images');
  await fs.mkdir(collection);
  for (let i = 0; i < 6; i++) {
    await sharp({
      create: {
        width: 90 + i * 30,
        height: 180,
        channels: 3,
        background: { r: 70 + i * 20, g: 110, b: 180 }
      }
    })
      .png()
      .toFile(path.join(collection, 'generated-' + i + '.png'));
  }
  Object.assign(report, { run, collection });
  await seedProfile('fresh-profile');
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const args = packaged ? [] : [requested];
  if (forcedDpr !== null) args.push('--force-device-scale-factor=' + forcedDpr);
  app = await _electron.launch({
    executablePath: executable,
    args,
    cwd: packaged ? path.dirname(executable) : requested,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push({ check: currentCheck, error: error.stack }));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push(route.request().url());
    await route.abort();
  });
  const runtime = await app.evaluate(({ app, BrowserWindow, net, session }) => {
    const blocked = (globalThis.__cardSizeBlocked = []);
    const realFetch = net.fetch.bind(net);
    net.fetch = (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (!/^https?:/i.test(url)) return realFetch(input, ...args);
      blocked.push(url);
      return Promise.reject(new Error('HTTP disabled by isolated card-size checker'));
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        blocked.push(details.url);
        callback({ cancel: true });
      }
    );
    const Worker = process.mainModule.require('node:worker_threads').Worker;
    const send = Worker.prototype.postMessage;
    const records = (globalThis.__cardSizeWrites = []);
    Worker.prototype.postMessage = function (message, ...rest) {
      if (message?.method === 'settings' && message.args?.key === 'density')
        records.push({ value: message.args.value, request: message.request });
      return send.call(this, message, ...rest);
    };
    const win = BrowserWindow.getAllWindows()[0];
    win.webContents.setBackgroundThrottling(false);
    if (!win.isVisible()) win.show();
    win.focus();
    return {
      profile: process.env.ACG_DATA_DIR,
      userData: app.getPath('userData'),
      appPath: app.getAppPath(),
      executable: process.execPath,
      packaged: app.isPackaged,
      version: app.getVersion()
    };
  });
  assert.ok(samePath(runtime.profile, profile));
  assert.ok(samePath(runtime.userData, path.join(profile, 'chromium-profile')));
  assert.ok(samePath(runtime.executable, executable));
  assert.equal(runtime.packaged, packaged);
  if (!packaged) assert.ok(samePath(runtime.appPath, requested));
  report.runtimes.push(runtime);
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumAppearanceControls
  );
  if (forcedDpr !== null)
    assert.ok(Math.abs((await page.evaluate(() => devicePixelRatio)) - forcedDpr) < 0.02);
  assert.equal((await rpc('init', { lightweight: true })).settings.autoMatch, false);
}
async function close() {
  if (!app) return;
  report.blockedNetwork.push(...(await app.evaluate(() => globalThis.__cardSizeBlocked || [])));
  await app.close();
  app = null;
  page = null;
}
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    const outer = win.getBounds(),
      content = win.getContentBounds();
    win.setBounds({ x: 0, y: 0, width: width + outer.width - content.width, height: 900 });
  }, width);
  await page.waitForFunction(
    (width) => innerWidth === width && document.documentElement.clientWidth === width,
    width
  );
}
async function sample(label, expected, configured) {
  const before = await page.evaluate(() => ({
    cssWidth: document.documentElement.clientWidth,
    density: S.settings.density,
    medium: cardPresets()[1],
    baseSize: parseFloat(document.documentElement.style.getPropertyValue('--card-base-size')),
    scale: Number(document.documentElement.style.getPropertyValue('--card-scale'))
  }));
  if (
    before.baseSize !== before.medium ||
    Math.abs(before.scale - before.density / before.medium) >= 0.0001
  )
    (report.resizeSettling ||= []).push({ label, before });
  await page.waitForFunction(
    ({ expected, configured }) => {
      const density = expected === null ? cardPresets()[1] : expected;
      return (
        S.settings.density === density &&
        S.settings.densityConfigured === configured &&
        parseFloat(document.documentElement.style.getPropertyValue('--card-width')) === density &&
        parseFloat(document.documentElement.style.getPropertyValue('--card-base-size')) ===
          cardPresets()[1] &&
        Math.abs(
          Number(document.documentElement.style.getPropertyValue('--card-scale')) -
            density / cardPresets()[1]
        ) < 0.0001 &&
        [...document.querySelectorAll('#toolbar [data-density]')].every(
          (button) =>
            button.getAttribute('aria-pressed') ===
            String(Number(button.dataset.density) === density)
        ) &&
        densityWheelTimer === null
      );
    },
    { expected: expected === undefined ? null : expected, configured }
  );
  const state = await page.evaluate(() => ({
    cssWidth: document.documentElement.clientWidth,
    innerWidth,
    dpr: devicePixelRatio,
    density: S.settings.density,
    densityConfigured: S.settings.densityConfigured,
    medium: cardPresets()[1],
    presets: cardPresets(),
    scale: Number(document.documentElement.style.getPropertyValue('--card-scale')),
    ratio: S.settings.ratio,
    details: S.settings.details,
    buttons: [...document.querySelectorAll('#toolbar [data-density]')].map((button) => ({
      value: Number(button.dataset.density),
      preset: button.dataset.cardPreset,
      pressed: button.getAttribute('aria-pressed')
    }))
  }));
  const saved = (await rpc('init', { lightweight: true })).settings;
  assert.equal(saved.densityConfigured, configured);
  assert.equal(saved.density, configured ? expected : 166);
  assert.equal(state.ratio, saved.ratio);
  assert.equal(state.details, saved.details);
  assert.ok(Math.abs(state.scale - state.density / state.medium) < 0.0001);
  assert.equal(state.cssWidth, state.innerWidth);
  for (const button of state.buttons)
    assert.equal(button.pressed, String(button.value === state.density));
  if (!configured) {
    assert.equal(state.buttons.find((button) => button.preset === 'standard')?.pressed, 'true');
    assert.deepEqual(await app.evaluate(() => globalThis.__cardSizeWrites), []);
  }
  report.samples.push({ label, profile, ...state, savedDensity: saved.density });
  return state;
}
async function maximize() {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()))
    .toBe(true);
}
async function shot(name) {
  const target = path.join(run, name + '.png');
  await page.screenshot({ path: target });
  report.screenshots.push(target);
}
(async () => {
  await prepare();
  await check(
    'fresh native maximized startup and CSS resize matrix follow medium without saving',
    async () => {
      await launch();
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())
        )
        .toBe(true);
      await sample('fresh-native-maximized', undefined, false);
      await shot('fresh-native-maximized');
      for (const width of [1920, 2240, 2560, 3200, 3840]) {
        await resize(width);
        await sample('fresh-css-' + width, undefined, false);
      }
      await close();
    }
  );
  await check(
    'fresh normal-window restart stays medium and same-medium toolbar click really saves',
    async () => {
      await launch();
      await sample('fresh-normal-restart', undefined, false);
      await resize(1920);
      const state = await sample('before-same-medium-click', undefined, false);
      await page.locator('#toolbar [data-card-preset="standard"]').click();
      await expect
        .poll(async () => (await rpc('init', { lightweight: true })).settings.densityConfigured)
        .toBe(true);
      await sample('explicit-same-medium', state.medium, true);
      assert.deepEqual(
        await app.evaluate(() => globalThis.__cardSizeWrites.map((row) => row.value)),
        [155]
      );
      await resize(3840);
      await sample('same-medium-after-resize', 155, true);
      await maximize();
      await close();
    }
  );
  await check(
    'saved medium survives native maximized restart and a trusted custom range choice persists',
    async () => {
      await launch();
      await sample('saved-medium-restart', 155, true);
      await page.locator('#density-button').click();
      const range = page.locator('#display-density');
      await range.focus();
      await range.press('Home');
      await range.press('ArrowRight');
      await range.press('Tab');
      await expect(range).toHaveValue('121');
      await expect
        .poll(async () => (await rpc('init', { lightweight: true })).settings.density)
        .toBe(121);
      await sample('custom-keyboard-121', 121, true);
      await page.keyboard.press('Escape');
      await resize(2560);
      await sample('custom-after-resize', 121, true);
      await shot('custom-after-resize');
      await maximize();
      await close();
    }
  );
  await check(
    'custom numeric width and another preset each survive a process restart',
    async () => {
      await launch();
      await sample('custom-restart', 121, true);
      await resize(1920);
      await page.locator('#toolbar [data-card-preset="large"]').click();
      await expect
        .poll(async () => (await rpc('init', { lightweight: true })).settings.density)
        .toBe(191);
      await sample('explicit-large', 191, true);
      await maximize();
      await close();
      await launch();
      await sample('large-restart', 191, true);
      await close();
    }
  );
  await check(
    'a pre-existing explicit legacy 166 remains numeric through native startup and resize',
    async () => {
      await seedProfile('legacy-explicit-166', 166);
      await launch();
      await sample('legacy-166-native-startup', 166, true);
      for (const width of [1920, 2560, 3840]) {
        await resize(width);
        await sample('legacy-166-css-' + width, 166, true);
      }
      await shot('legacy-166');
      await close();
    }
  );
  assert.deepEqual(report.errors, []);
  report.passed = true;
})()
  .catch((error) => {
    report.failure = error.stack || String(error);
    console.error(report.failure);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (page) await shot('failure').catch(() => {});
    await close().catch((error) => report.errors.push({ close: String(error) }));
    report.finished = new Date().toISOString();
    if (run) {
      const target = path.join(run, 'report.json');
      await fs.writeFile(target, JSON.stringify(report, null, 2));
      console.log('REPORT ' + target);
    }
  });
