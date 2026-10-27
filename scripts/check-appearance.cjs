'use strict';
// Lead runs serially: <bundled node> scripts/check-appearance.cjs
// ACG_EXECUTABLE selects an actual packaged payload; otherwise current source is used.
// This script opens Electron. Writing/checking the script does not execute it.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const payload = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const report = {
  checks: [],
  errors: [],
  screenshots: [],
  externalRequests: [],
  samples: {},
  scope:
    'Serial real Electron; 40 generated folders and a nonuniform long image; offline isolated profile. No user library or full performance suite.',
  runtime: { mode: payload ? 'packaged' : 'source', executable: payload || require('electron') }
};
let app,
  page,
  run,
  profile,
  collection,
  folders,
  longImage,
  stage = 'setup',
  launches = 0;
const folderSelector = () => `.album-card[data-id="${idFor(folders[0])}"]`;
const mediaSelector = () => `.media-card[data-id="${idFor(longImage)}"]`;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual}, expected ${expected} ± ${tolerance}`
  );
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function seed() {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent_index.sqlite')
    }
  });
  let sequence = 0,
    readyTimer;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Fixture worker ready timeout')), 30000);
    worker.on('error', (error) => {
      reject(error);
      for (const request of pending.values()) request.reject(error);
    });
    worker.on('message', (message) => {
      if (message.event === 'ready') {
        clearTimeout(readyTimer);
        resolve();
      }
      const request = pending.get(message.request);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.request);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Fixture RPC timeout: ' + method));
      }, 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await ready;
    for (const [key, value] of [
      ['watchChanges', false],
      ['autoMatch', false],
      ['details', true],
      ['ratio', 'poster'],
      ['density', 222],
      ['theme', 'light']
    ])
      await call('settings', { key, value });
    // Do not seed either appearance setting: verify their real fresh-profile defaults.
    await call('scan', { path: collection, onlineMatch: false, subjectTypes: [4] });
    await call('mediaInfo', { id: idFor(longImage) });
    await call('patch', { id: idFor(folders[0]), changes: { favorite: 1 } });
    await call('shutdown');
  } finally {
    clearTimeout(readyTimer);
    for (const request of pending.values()) clearTimeout(request.timer);
    await worker.terminate();
  }
}
async function fixtures() {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const physicalArtifacts = await fs.realpath(path.join(root, 'artifacts'));
  const stamp = new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_');
  run = path.join(
    physicalArtifacts,
    'appearance',
    stamp + '_' + crypto.randomUUID().replace(/-/g, '_')
  );
  await fs.mkdir(run, { recursive: true });
  run = await fs.realpath(run);
  assert.ok(
    path.relative(physicalArtifacts, run) && !path.relative(physicalArtifacts, run).startsWith('..')
  );
  profile = path.join(run, 'generated_profile');
  collection = path.join(run, 'generated_collection');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(collection, { recursive: true });
  folders = Array.from({ length: 40 }, (_, i) =>
    path.join(collection, `Folder_${String(i).padStart(3, '0')}`)
  );
  for (const [index, folder] of folders.entries()) {
    await fs.mkdir(folder);
    const image = await sharp({
      create: {
        width: 200,
        height: 280,
        channels: 3,
        background: { r: 120 + index * 2, g: 135, b: 175 + index }
      }
    })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(folder, 'cover.png'), image, { flag: 'wx' });
  }
  longImage = path.join(collection, 'Long_nonuniform.png');
  const top = await sharp({
    create: { width: 200, height: 1100, channels: 3, background: '#e85b75' }
  })
    .png()
    .toBuffer();
  const middle = await sharp({
    create: { width: 200, height: 1100, channels: 3, background: '#e1bf63' }
  })
    .png()
    .toBuffer();
  await sharp({ create: { width: 200, height: 3400, channels: 3, background: '#526fc1' } })
    .composite([
      { input: top, top: 0, left: 0 },
      { input: middle, top: 1100, left: 0 }
    ])
    .png()
    .toFile(longImage);
  Object.assign(report, {
    run,
    profile,
    fixture: { collection, folders: folders.length, longImage, width: 200, height: 3400 }
  });
  await seed();
}
async function instrument() {
  await page.evaluate(() => {
    const nativeRAF = window.requestAnimationFrame.bind(window),
      nativeCancel = window.cancelAnimationFrame.bind(window);
    const pending = new Map();
    const stats = {
      requested: 0,
      executed: 0,
      cancelled: 0,
      effectsRequested: 0,
      effectsExecuted: 0,
      effectsMaxPending: 0,
      viewTransitions: 0
    };
    window.requestAnimationFrame = (callback) => {
      const effects = /effects\.js[:)]/.test(new Error().stack || '');
      let id;
      id = nativeRAF((time) => {
        pending.delete(id);
        stats.executed++;
        if (effects) stats.effectsExecuted++;
        callback(time);
      });
      pending.set(id, effects);
      stats.requested++;
      if (effects) stats.effectsRequested++;
      stats.effectsMaxPending = Math.max(
        stats.effectsMaxPending,
        [...pending.values()].filter(Boolean).length
      );
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      if (pending.delete(id)) stats.cancelled++;
      nativeCancel(id);
    };
    if (document.startViewTransition) {
      const nativeTransition = document.startViewTransition.bind(document);
      document.startViewTransition = (...args) => {
        stats.viewTransitions++;
        return nativeTransition(...args);
      };
    }
    window.__appearanceMetrics = () => ({
      ...stats,
      pending: pending.size,
      effectsPending: [...pending.values()].filter(Boolean).length,
      active: document.querySelectorAll('.effects-active').length,
      hidden: document.hidden
    });
  });
}
async function launch() {
  const started = performance.now();
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: report.runtime.executable,
    args: payload ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  launches++;
  await app.context().route(/^https?:\/\//, async (route) => {
    report.externalRequests.push({ stage, url: route.request().url() });
    await route.abort();
  });
  page = await app.firstWindow();
  const firstWindowMs = performance.now() - started;
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    report.errors.push({ stage, launch: launches, kind: 'pageerror', message: error.message })
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.errors.push({ stage, launch: launches, kind: 'console', message: message.text() });
  });
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.loadVersion > 0 &&
      typeof window.albumEffects?.apply === 'function'
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 1000);
    win.show();
    win.focus();
  });
  await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 1000);
  const actual = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    isPackaged: app.isPackaged,
    version: app.getVersion(),
    executable: process.execPath
  }));
  assert.equal(path.resolve(actual.userData), path.join(profile, 'chromium-profile'));
  assert.equal(actual.isPackaged, Boolean(payload));
  const requestedExecutable = await fs.realpath(report.runtime.executable),
    actualExecutable = await fs.realpath(actual.executable);
  assert.equal(
    process.platform === 'win32' ? actualExecutable.toLowerCase() : actualExecutable,
    process.platform === 'win32' ? requestedExecutable.toLowerCase() : requestedExecutable
  );
  report.runtime.actual = actual;
  await page.waitForFunction(() => document.querySelector('.collection-tile,.album-card'));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  (report.samples.startup ||= []).push({
    launch: launches,
    firstWindowMs: Math.round(firstWindowMs),
    automatedContentReadyMs: Math.round(performance.now() - started),
    rendererPaints: await page.evaluate(() =>
      performance
        .getEntriesByType('paint')
        .map((entry) => ({ name: entry.name, ms: Math.round(entry.startTime) }))
    ),
    scope:
      'Isolated 40-folder fixture; includes automation handshake and window resize, not a cold OS launch benchmark.'
  });
  await instrument();
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  try {
    await closing.close();
  } catch (error) {
    // Only the child created by this run is eligible for this fallback.
    closing.process()?.kill();
    throw error;
  } finally {
    if (app === closing) app = null;
  }
}
async function readyAppearance() {
  await page.waitForFunction(() => {
    const panel = document.querySelector('#settings-panel-appearance');
    return (
      document.querySelector('#modal').open &&
      panel &&
      !panel.hidden &&
      !panel.inert &&
      document.querySelector('#settings-content').getAttribute('aria-busy') === 'false'
    );
  });
  await page.evaluate(async () => {
    const shell = document.querySelector('#settings-shell');
    await Promise.all(
      shell
        .getAnimations({ subtree: true })
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {}))
    );
  });
}
async function appearance() {
  const open = await page.locator('#modal').evaluate((dialog) => dialog.open);
  if (!open) await page.locator('#profile-button').click();
  await expect(page.locator('#settings-tab-appearance')).toBeVisible();
  await page.locator('#settings-tab-appearance').click();
  await readyAppearance();
}
async function closeDialog() {
  if (await page.locator('#modal').evaluate((dialog) => dialog.open)) {
    await page.locator('#modal-close').click();
    await page.waitForFunction(() => !document.querySelector('#modal').open);
  }
  await page.mouse.move(1, 1);
}
async function effect(key, value) {
  await appearance();
  const selector = key === 'liquidGlass' ? '#liquid-glass' : '#motion-level';
  const control = page.locator(selector);
  if (key === 'liquidGlass') await control.setChecked(value, { force: true });
  else await control.selectOption(value, { force: true }); // Native API remains authoritative under enhanced comboboxes.
  await page.waitForFunction(
    ({ key, value }) =>
      S.settings[key] === value &&
      (key === 'liquidGlass'
        ? document.documentElement.dataset.liquidGlass === (value ? 'on' : 'off')
        : document.documentElement.dataset.motion === value),
    { key, value }
  );
  await expect(control).toBeEnabled();
  await expect.poll(async () => (await rpc('init')).settings[key]).toBe(value);
}
async function theme(value) {
  await appearance();
  await page.locator('#theme-select').selectOption(value, { force: true });
  await page.waitForFunction(
    (value) =>
      document.documentElement.dataset.theme === value &&
      S.settings.theme === value &&
      themeChangeTask === null,
    value
  );
  assert.equal((await rpc('init')).settings.theme, value);
}
async function go() {
  await closeDialog();
  await page.evaluate(
    (parent) =>
      navigate({
        parent,
        view: 'library',
        filter: 'all',
        search: '',
        sort: 'name',
        direction: 'asc'
      }),
    idFor(collection)
  );
  await page.waitForFunction(
    (parent) =>
      S.parent === parent &&
      grid.active &&
      grid.folders === 40 &&
      grid.total === 41 &&
      grid.loading.size === 0,
    idFor(collection)
  );
  await page.evaluate(() => {
    document.querySelector('#viewport').scrollTop = 0;
    grid.render();
  });
  await expect(page.locator(folderSelector())).toBeVisible();
  await page.mouse.move(1, 1);
}
async function surfaceSnapshot() {
  return page.evaluate(() => {
    const selectors = [
      '.sidebar-shell',
      '.topbar > .brand',
      '.topbar > .navigation',
      '.topbar > .search-wrap',
      '.topbar > .header-actions',
      '.toolbar-left',
      '.toolbar-right'
    ];
    return selectors.map((selector) => {
      const element = document.querySelector(selector),
        style = getComputedStyle(element),
        rect = element.getBoundingClientRect();
      return {
        selector,
        backdrop: style.backdropFilter,
        background: style.backgroundImage,
        color: style.backgroundColor,
        area: rect.width * rect.height,
        viewportArea: innerWidth * innerHeight
      };
    });
  });
}
async function noCardBackdrop() {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll('.album-card,.album-card *,.collection-tile,.collection-tile *')]
      .map((el) => ({ selector: el.className, backdrop: getComputedStyle(el).backdropFilter }))
      .filter((el) => el.backdrop !== 'none')
  );
  assert.deepEqual(bad, [], 'No card or card cover may sample the backdrop');
}
async function matrix(selector) {
  return page.locator(selector).evaluate((card) => {
    const style = getComputedStyle(card),
      m = new DOMMatrixReadOnly(style.transform);
    return {
      transform: style.transform,
      is2D: m.is2D,
      scale: Math.hypot(m.m21, m.m22, m.m23),
      x: m.m41,
      y: m.m42,
      rx: (Math.atan2(m.m23, m.m22) * 180) / Math.PI,
      ry: (Math.atan2(m.m31, m.m11) * 180) / Math.PI,
      willChange: style.willChange,
      inlineRX: card.style.getPropertyValue('--effect-rx'),
      inlineRY: card.style.getPropertyValue('--effect-ry')
    };
  });
}
async function hover(selector, tilt = false) {
  const card = page.locator(selector);
  await expect(card).toBeVisible();
  const rect = await card.boundingBox();
  assert.ok(rect && rect.width > 0 && rect.height > 0);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 150), {
    steps: 5
  });
  if (tilt)
    await page.mouse.move(rect.x + rect.width * 0.8, rect.y + Math.min(rect.height * 0.2, 65), {
      steps: 6
    });
}
async function inactive() {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.effects-active').length === 0 &&
      window.__appearanceMetrics().effectsPending === 0,
    null,
    { polling: 100 }
  );
  const stale = await page.evaluate(
    () =>
      [...document.querySelectorAll('.album-card,.collection-tile')].filter(
        (card) =>
          card.style.getPropertyValue('--effect-rx') ||
          card.style.getPropertyValue('--effect-ry') ||
          getComputedStyle(card).willChange.includes('transform')
      ).length
  );
  assert.equal(stale, 0, 'No stale tilt styles or permanent card promotion');
}
async function activeHigh(selector = folderSelector()) {
  await hover(selector, true);
  await expect
    .poll(async () => {
      const value = await matrix(selector);
      return (
        !value.is2D &&
        Math.abs(value.rx) > 2 &&
        Math.abs(value.ry) > 2 &&
        Math.abs(value.scale - 1.065) < 0.002
      );
    })
    .toBe(true);
  const value = await matrix(selector);
  assert.match(value.transform, /^matrix3d\(/);
  assert.ok(Math.abs(value.rx) <= 5.05 && Math.abs(value.ry) <= 5.05, JSON.stringify(value));
  near(value.scale, 1.065, 0.003, 'High mode uses 6.5 percent whole-card scale');
  assert.equal(await page.locator('.effects-active').count(), 1);
  assert.equal(
    await page.locator(selector).evaluate((el) => el.classList.contains('effects-active')),
    true
  );
  return value;
}
const metrics = () => page.evaluate(() => window.__appearanceMetrics());

(async () => {
  try {
    await fixtures();
    await launch();
    await check(
      'fresh profile defaults glass on and motion medium; real settings controls persist off and low',
      async () => {
        const initial = (await rpc('init')).settings;
        assert.equal(initial.liquidGlass, true);
        assert.equal(initial.motionLevel, 'medium');
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.liquidGlass === 'on' &&
            document.documentElement.dataset.motion === 'medium'
        );
        await expect(page.locator('.collection-path')).toHaveCount(1);
        await noCardBackdrop();
        await go();
        await expect(page.locator('.card-favorite')).toHaveCount(1);
        await appearance();
        await expect(page.locator('#liquid-glass')).toBeChecked();
        await expect(page.locator('#motion-level')).toHaveValue('medium');
        await shot('settings_default_glass_on');
        await effect('liquidGlass', false);
        await effect('motionLevel', 'low');
        await shot('settings_saved_glass_off_low');
        await closeDialog();
        return {
          defaults: { glass: initial.liquidGlass, motion: initial.motionLevel },
          saved: { glass: false, motion: 'low' }
        };
      }
    );
    await check(
      'closing and restarting the actual executable retains disabled glass and low motion',
      async () => {
        await closeApp();
        await launch();
        const saved = (await rpc('init')).settings;
        assert.equal(saved.liquidGlass, false);
        assert.equal(saved.motionLevel, 'low');
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.liquidGlass === 'off' &&
            document.documentElement.dataset.motion === 'low'
        );
        await appearance();
        await expect(page.locator('#liquid-glass')).not.toBeChecked();
        await expect(page.locator('#motion-level')).toHaveValue('low');
        await shot('settings_restart_remembers_off');
        await go();
      }
    );
    await check(
      'light and dark glass use 12px blur only on small floating surfaces; disabling restores material',
      async () => {
        const samples = [];
        for (const mode of ['light', 'dark']) {
          await theme(mode);
          await effect('liquidGlass', false);
          await closeDialog();
          const before = await surfaceSnapshot();
          for (const surface of before)
            assert.equal(surface.backdrop, 'none', JSON.stringify(surface));
          await effect('liquidGlass', true);
          await closeDialog();
          const glass = await surfaceSnapshot();
          for (const surface of glass) {
            assert.match(surface.backdrop, /blur\(12px\)/, JSON.stringify(surface));
            assert.ok(
              surface.area > 0 && surface.area < surface.viewportArea * 0.45,
              'Backdrop is limited to a floating component'
            );
          }
          await noCardBackdrop();
          await shot('glass_' + mode);
          await effect('liquidGlass', false);
          await closeDialog();
          const after = await surfaceSnapshot();
          assert.deepEqual(
            after.map(({ selector, backdrop, background, color }) => ({
              selector,
              backdrop,
              background,
              color
            })),
            before.map(({ selector, backdrop, background, color }) => ({
              selector,
              backdrop,
              background,
              color
            }))
          );
          samples.push({ theme: mode, static: before, glass, restored: after });
        }
        await theme('light');
        await effect('liquidGlass', true);
        await closeDialog();
        return samples;
      }
    );
    await check(
      'low is slight 2D scaling and medium focuses smoothly, without pointer RAF or 3D',
      async () => {
        const samples = [];
        for (const [level, scale, y] of [
          ['low', 1.008, 0],
          ['medium', 1.018, -2]
        ]) {
          await effect('motionLevel', level);
          if (level === 'low') {
            const decorative = await page.evaluate(() => {
              const selectors = [
                '.sidebar-shell',
                '.modal',
                '.settings-panel:not([hidden])',
                '.settings-tab-indicator'
              ];
              return {
                surfaces: selectors.map((selector) => {
                  const style = getComputedStyle(document.querySelector(selector));
                  return {
                    selector,
                    animation: style.animationName,
                    duration: style.transitionDuration
                  };
                }),
                spinner: getComputedStyle(document.querySelector('.progress-spinner'))
                  .animationName,
                panelAnimations: document
                  .querySelector('#settings-shell')
                  .getAnimations({ subtree: true })
                  .filter((animation) => animation.playState === 'running').length
              };
            });
            for (const surface of decorative.surfaces) {
              assert.equal(surface.animation, 'none', surface.selector);
              assert.ok(
                surface.duration.split(',').every((value) => parseFloat(value) === 0),
                JSON.stringify(surface)
              );
            }
            assert.equal(
              decorative.spinner,
              'spin',
              'Low motion preserves functional loading feedback'
            );
            assert.equal(decorative.panelAnimations, 0);
            report.samples.lowDecorativeMotion = decorative;
          }
          await go();
          const before = await metrics();
          await hover(folderSelector());
          await expect
            .poll(async () => Math.abs((await matrix(folderSelector())).scale - scale) < 0.003)
            .toBe(true);
          const value = await matrix(folderSelector());
          assert.equal(value.is2D, true);
          near(value.y, y, 0.3, level + ' translation');
          near(value.rx, 0, 0.01, level + ' rotation X');
          near(value.ry, 0, 0.01, level + ' rotation Y');
          assert.equal(value.inlineRX, '');
          await inactive();
          const after = await metrics();
          assert.equal(after.effectsRequested, before.effectsRequested);
          await shot('hover_' + level);
          samples.push({ level, ...value });
        }
        return samples;
      }
    );
    await check(
      'high uses 6.5 percent mouse matrix3d with noticeable tilt within five degrees and one active card',
      async () => {
        await effect('motionLevel', 'high');
        await go();
        const first = await activeHigh();
        await noCardBackdrop();
        await shot('glass_high_hover');
        const before = await metrics();
        await page.waitForTimeout(250); // Measure idle pointer scheduling; not a frame-driving loop.
        const after = await metrics();
        assert.equal(
          after.effectsRequested,
          before.effectsRequested,
          'Stationary hover must not run an animation loop'
        );
        assert.equal(after.effectsPending, 0);
        assert.ok(after.effectsMaxPending <= 1);
        assert.ok(after.effectsRequested > 0, 'Instrumentation identifies real effects.js frames');
        const secondSelector = `.album-card[data-id="${idFor(folders[1])}"]`;
        const second = await activeHigh(secondSelector);
        const old = await matrix(folderSelector());
        assert.equal(old.inlineRX, '');
        assert.equal(old.inlineRY, '');
        assert.equal(old.willChange, 'auto');
        report.samples.foregroundRAF = { before, after };
        return { first, second, old };
      }
    );
    await check(
      'scrolling, opening a real modal and reduced motion remove active tilt and promotion',
      async () => {
        await page.mouse.wheel(0, 520);
        await page.waitForFunction(() => document.querySelector('#viewport').scrollTop > 0);
        await inactive();
        await go();
        await activeHigh();
        await page.locator('#profile-button').click();
        await expect(page.locator('#modal')).toBeVisible();
        await inactive();
        await closeDialog();
        await go();
        await activeHigh();
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await inactive();
        await hover(folderSelector(), true);
        await expect.poll(async () => (await matrix(folderSelector())).transform).toBe('none');
        await inactive();
        await shot('reduced_motion_no_transform');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.mouse.move(1, 1);
      }
    );
    await check(
      'low theme switches persist without starting a whole-window view transition',
      async () => {
        await effect('motionLevel', 'low');
        await closeDialog();
        const before = (await metrics()).viewTransitions;
        await page.locator('#theme-button').click();
        await page.waitForFunction(
          () =>
            S.settings.theme === 'dark' &&
            document.documentElement.dataset.theme === 'dark' &&
            themeChangeTask === null
        );
        assert.equal((await rpc('init')).settings.theme, 'dark');
        assert.equal((await metrics()).viewTransitions, before);
        await page.locator('#theme-button').click();
        await page.waitForFunction(() => S.settings.theme === 'light' && themeChangeTask === null);
        assert.equal((await metrics()).viewTransitions, before);
      }
    );
    await check(
      'card and inner clipping curves align; rating is pill shaped and folder count is inset',
      async () => {
        await go();
        // Exercise the real folder renderer with a generated rating; no network fixture needed.
        await page.evaluate((id) => {
          const [index, node] = [...grid.items].find(([, node]) => node.id === id);
          updateFolderCard(grid.cards.get(index), {
            ...node,
            metadata: { ...node.metadata, rating: { score: 8.6 } }
          });
        }, idFor(folders[0]));
        const folder = await page.locator(folderSelector()).evaluate((card) => {
          const cover = getComputedStyle(card.querySelector('.cover-shell')),
            overlay = getComputedStyle(card.querySelector('.card-bottom-overlay')),
            gradient = getComputedStyle(card.querySelector('.cover-gradient')),
            rating = card.querySelector('.card-rating');
          return {
            radius: parseFloat(getComputedStyle(card).borderRadius),
            coverRadius: parseFloat(cover.borderRadius),
            gradientRadius: parseFloat(gradient.borderBottomLeftRadius),
            left: parseFloat(overlay.left),
            bottom: parseFloat(overlay.bottom),
            ratingRadius: parseFloat(getComputedStyle(rating).borderRadius),
            ratingHeight: rating.getBoundingClientRect().height,
            ratingText: rating.textContent
          };
        });
        assert.equal(folder.radius, 16);
        assert.equal(folder.coverRadius, folder.radius);
        assert.equal(folder.gradientRadius, folder.coverRadius - 1);
        assert.equal(folder.left, 8);
        assert.equal(folder.bottom, 4);
        assert.equal(folder.ratingText, '★ 8.6');
        assert.ok(folder.ratingRadius >= folder.ratingHeight / 2, 'Rating corners form a capsule');
        await shot('folder_aligned_corners_pill_rating');
        await page.evaluate(() => {
          document.querySelector('#viewport').scrollTop = grid.getPosition(grid.folders).top;
          grid.render();
        });
        await expect(page.locator(mediaSelector())).toBeVisible();
        await page.waitForFunction(
          (selector) =>
            document.querySelector(selector)?.querySelector('img')?.classList.contains('loaded'),
          mediaSelector()
        );
        const media = await page.locator(mediaSelector()).evaluate((card) => {
          const shell = card.querySelector('.cover-shell'),
            cover = getComputedStyle(shell),
            image = getComputedStyle(shell.querySelector('img')),
            overlay = getComputedStyle(card.querySelector('.card-bottom-overlay'));
          return {
            radius: parseFloat(getComputedStyle(card).borderRadius),
            coverRadius: parseFloat(cover.borderRadius),
            hoverRadius: parseFloat(
              getComputedStyle(card.querySelector('.media-hover')).borderBottomLeftRadius
            ),
            left: parseFloat(overlay.left),
            bottom: parseFloat(overlay.bottom),
            height: parseFloat(card.style.height),
            folderHeight: grid.getPosition(0).height,
            width: parseFloat(card.style.width),
            fit: image.objectFit,
            position: image.objectPosition,
            clamped: card.dataset.mediaClamped
          };
        });
        assert.equal(media.radius, 6);
        assert.equal(media.coverRadius, media.radius);
        assert.equal(media.hoverRadius, media.coverRadius - 1);
        assert.equal(media.left, 8);
        assert.equal(media.bottom, 8);
        assert.equal(media.clamped, 'true');
        assert.equal(media.fit, 'cover');
        assert.equal(media.position, '50% 0%');
        near(media.height, media.folderHeight * 2, 0.1, 'Complete media height cap');
        await shot('long_nonuniform_top_crop');
        return { folder, media };
      }
    );
    await check(
      'background visibility cleans effects and optional RAF sampling shows no effects work',
      async () => {
        await effect('motionLevel', 'high');
        await go();
        await activeHigh();
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        let supported = true;
        try {
          await page.waitForFunction(() => document.hidden, null, { timeout: 5000, polling: 100 });
        } catch {
          supported = false;
        }
        await inactive();
        const before = await metrics();
        await page.waitForTimeout(250);
        const after = await metrics();
        assert.equal(after.effectsRequested, before.effectsRequested);
        assert.equal(after.effectsExecuted, before.effectsExecuted);
        assert.equal(after.effectsPending, 0);
        await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.show();
          win.focus();
        });
        await page.waitForFunction(() => !document.hidden);
        return {
          visibilitySignalSupported: supported,
          before,
          after,
          note: 'Total RAF is diagnostic across all UI features; effects-only idle/background work is asserted.'
        };
      }
    );
    await check(
      'enabled glass and high motion also survive a second application restart',
      async () => {
        await effect('liquidGlass', true);
        await effect('motionLevel', 'high');
        await closeDialog();
        await closeApp();
        await launch();
        const saved = (await rpc('init')).settings;
        assert.equal(saved.liquidGlass, true);
        assert.equal(saved.motionLevel, 'high');
        await page.waitForFunction(
          () =>
            document.documentElement.dataset.liquidGlass === 'on' &&
            document.documentElement.dataset.motion === 'high'
        );
        await appearance();
        await expect(page.locator('#liquid-glass')).toBeChecked();
        await expect(page.locator('#motion-level')).toHaveValue('high');
        await shot('settings_restart_remembers_on_high');
        await closeDialog();
        assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
        assert.equal(report.externalRequests.length, 0, JSON.stringify(report.externalRequests));
      }
    );
    report.passed = true;
    stage = 'completed';
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    try {
      await closeApp();
    } catch (error) {
      report.errors.push({ stage: 'close', message: error.message });
      report.passed = false;
      process.exitCode = 1;
    }
    report.stage = stage;
    report.launches = launches;
    if (report.errors.length) {
      report.passed = false;
      process.exitCode = 1;
    }
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    }
    console.log(
      JSON.stringify({
        passed: report.passed,
        stage,
        checks: report.checks.length,
        errors: report.errors.length,
        report: run ? path.join(run, 'report.json') : null
      })
    );
  }
})();
