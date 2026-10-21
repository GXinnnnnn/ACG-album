'use strict';
// Serial, isolated Electron verification only. Never opens or copies an existing profile.
// Run: <bundled node> scripts/check-settings-motion.cjs [--packaged]
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const artifactRoot = require('node:fs').realpathSync(path.join(root, 'artifacts'));
const run = path.join(
  artifactRoot,
  'settings-motion',
  `${packaged ? 'packaged' : 'source'}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`
);
const profile = path.join(run, 'generated-profile');
const tabs = ['profile', 'appearance', 'metadata', 'cache', 'application'];
const report = {
  packaged,
  version: metadata.version,
  run,
  profile,
  checks: [],
  screenshots: [],
  errors: [],
  transitionFrames: []
};
let app,
  page,
  stage = 'setup';
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
  return file;
}
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    if (page && !page.isClosed()) await shot('failure-' + report.checks.length).catch(() => {});
    throw error;
  }
}
async function size(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setMinimumSize(320, 280);
      win.setContentSize(width, height);
      win.webContents.setBackgroundThrottling(false);
    },
    { width, height }
  );
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    { width, height }
  );
}
async function ready(tab) {
  await page.waitForFunction((tab) => {
    const panel = document.querySelector('#settings-panel-' + tab);
    return (
      document.querySelector('#modal').open &&
      panel &&
      !panel.hidden &&
      !panel.inert &&
      panel.getAttribute('aria-hidden') === 'false' &&
      document.querySelector('#settings-content').getAttribute('aria-busy') === 'false' &&
      document.querySelector('#settings-tab-' + tab).getAttribute('aria-selected') === 'true'
    );
  }, tab);
}
async function finishMotion() {
  await page.evaluate(async () => {
    const shell = document.querySelector('#settings-shell');
    if (shell)
      await Promise.all(
        shell
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {}))
      );
  });
}
async function select(tab, finish = true) {
  await page.locator('#settings-tab-' + tab).click();
  await ready(tab);
  if (finish) await finishMotion();
}
async function close() {
  if (await page.locator('#modal').evaluate((dialog) => dialog.open)) {
    await page.locator('#modal-close').click();
    await page.waitForFunction(
      () => !document.querySelector('#modal').open && !document.querySelector('#settings-shell')
    );
  }
}
async function open(tab = 'appearance') {
  await close();
  await page.locator(tab === 'profile' ? '#profile-button' : '#settings-button').click();
  if (!['appearance', 'profile'].includes(tab)) await page.locator('#settings-tab-' + tab).click();
  await ready(tab);
  await finishMotion();
}
async function rememberShell() {
  await page.evaluate(() => {
    window.__motionNodes = {
      dialog: document.querySelector('#modal'),
      content: document.querySelector('#modal-content'),
      shell: document.querySelector('#settings-shell'),
      tabs: document.querySelector('.settings-tabs'),
      buttons: [...document.querySelectorAll('.settings-tabs [role=tab]')],
      generation: modalGeneration,
      replacements: 0
    };
    window.__motionNodes.observer = new MutationObserver((records) => {
      window.__motionNodes.replacements += records.length;
    });
    window.__motionNodes.observer.observe(window.__motionNodes.content, { childList: true });
  });
}
async function persistent() {
  assert.equal(
    await page.evaluate(() => {
      const n = window.__motionNodes;
      return (
        n.dialog === document.querySelector('#modal') &&
        n.content === document.querySelector('#modal-content') &&
        n.shell === document.querySelector('#settings-shell') &&
        n.tabs === document.querySelector('.settings-tabs') &&
        n.buttons.every(
          (button, index) =>
            button === document.querySelectorAll('.settings-tabs [role=tab]')[index]
        ) &&
        n.generation === modalGeneration &&
        n.replacements === 0
      );
    }),
    true,
    'Dialog, content, shell, tablist, buttons and modal generation must stay unchanged.'
  );
}
async function configure(method, state) {
  await app.evaluate(
    (_, { method, state }) => {
      global.__settingsMotion.states[method] = state;
    },
    { method, state }
  );
}
async function held(method, count = 1) {
  // Electron's main-process gate is the source of truth; poll it between rendered frames.
  for (let attempt = 0; attempt < 100; attempt++) {
    const pending = await app.evaluate(
      (_, method) =>
        global.__settingsMotion.pending.filter((item) => item.method === method).length,
      method
    );
    if (pending >= count) return;
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  throw new Error('IPC request did not enter gate: ' + method);
}
async function release(method, fail = false) {
  return app.evaluate(
    (_, { method, fail }) => {
      const gate = global.__settingsMotion;
      gate.states[method] = {};
      const pending = gate.pending.filter((item) => item.method === method);
      gate.pending = gate.pending.filter((item) => item.method !== method);
      pending.forEach((item) => item.resolve({ fail }));
      return pending.length;
    },
    { method, fail }
  );
}
async function active() {
  return page.evaluate(() =>
    [...document.querySelectorAll('.settings-panel')]
      .filter((panel) => !panel.hidden && !panel.inert)
      .map((panel) => panel.id)
  );
}
async function geometry() {
  return page.locator('#modal').evaluate((dialog) => {
    const r = dialog.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}
(async () => {
  await fs.mkdir(profile, { recursive: true });
  assert.equal(path.dirname(profile), run);
  assert.ok(
    path.resolve(profile).startsWith(path.join(artifactRoot, 'settings-motion') + path.sep)
  );
  const env = { ...process.env, ACG_DATA_DIR: profile, ACG_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({
      executablePath: packaged
        ? path.join(
            process.env.ACG_PACKAGED_RUNTIME
              ? path.resolve(process.env.ACG_PACKAGED_RUNTIME)
              : require('./distribution-paths.cjs').runtimeDirectory(),
            `${metadata.build.productName}.exe`
          )
        : require('electron'),
      args: packaged ? [] : ['.'],
      cwd: root,
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.settings.nickname !== undefined && window.albumControls
    );
    await size(1440, 960);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await check(
      'only the generated profile and requested source or packaged runtime are used',
      async () => {
        const runtime = await app.evaluate(({ app, safeStorage }) => ({
          userData: app.getPath('userData'),
          version: app.getVersion(),
          packaged: app.isPackaged,
          encryption: safeStorage.isEncryptionAvailable()
        }));
        assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
        assert.equal(runtime.version, metadata.version);
        assert.equal(runtime.packaged, packaged);
        assert.deepEqual(await page.evaluate(() => S.roots), []);
        report.runtime = runtime;
        return runtime;
      }
    );
    await app.evaluate(({ ipcMain }) => {
      const gate = (global.__settingsMotion = { states: {}, pending: [], calls: {} });
      for (const method of [
        'tokenStatus',
        'cacheInfo',
        'appInfo',
        'saveToken',
        'cleanCache',
        'chooseAvatar',
        'settings'
      ]) {
        const channel = 'library:' + method;
        const original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Missing IPC handler ' + channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          gate.calls[method] = (gate.calls[method] || 0) + 1;
          const state = gate.states[method] || {};
          const result = await original(...args);
          if (state.hold) {
            const outcome = await new Promise((resolve) => gate.pending.push({ method, resolve }));
            if (outcome.fail) throw new Error('Injected isolated ' + method + ' error');
          }
          return result;
        });
      }
    });
    await check(
      'top-right profile and all five tabs preserve shell nodes, drafts and dialog bounds',
      async () => {
        await open('profile');
        await rememberShell();
        const before = await geometry();
        await page.locator('#profile-name').fill('Motion draft');
        const bounds = [];
        for (const tab of tabs) {
          await select(tab);
          await persistent();
          const rect = await geometry();
          assert.ok(
            Math.abs(rect.y - before.y) < 1 && Math.abs(rect.height - before.height) < 1,
            'Dialog top/height changed on ' + tab
          );
          assert.deepEqual(await active(), ['settings-panel-' + tab]);
          assert.equal(await page.locator('.settings-tabs [tabindex="0"]').count(), 1);
          bounds.push({ tab, ...rect });
        }
        await select('profile');
        assert.equal(await page.locator('#profile-name').inputValue(), 'Motion draft');
        await select('metadata');
        await page.locator('#token-input').fill('unsaved-generated-draft');
        await select('appearance');
        await select('metadata');
        assert.equal(await page.locator('#token-input').inputValue(), 'unsaved-generated-draft');
        await page.locator('#token-input').fill('');
        assert.equal(await page.locator('#settings-content .settings-panel').count(), 5);
        await shot('persistent-metadata');
        return {
          bounds,
          shellReplacements: 0,
          profileDraftRetained: true,
          tokenDraftRetained: true
        };
      }
    );
    await check('delayed token and cache preparation retains the complete old panel', async () => {
      await open('profile');
      await rememberShell();
      await configure('tokenStatus', { hold: true });
      await page.locator('#settings-tab-metadata').click();
      await held('tokenStatus');
      assert.deepEqual(await active(), ['settings-panel-profile']);
      assert.equal(await page.locator('#profile-name').isVisible(), true);
      assert.equal(await page.locator('#settings-content').getAttribute('aria-busy'), 'true');
      assert.equal(
        await page
          .locator('#settings-panel-profile')
          .evaluate((panel) => getComputedStyle(panel).opacity),
        '1'
      );
      await persistent();
      await shot('delayed-token-old-profile');
      await release('tokenStatus');
      await ready('metadata');
      await finishMotion();
      await configure('cacheInfo', { hold: true });
      await page.locator('#settings-tab-cache').click();
      await held('cacheInfo');
      assert.deepEqual(await active(), ['settings-panel-metadata']);
      assert.equal(await page.locator('#token-input').isVisible(), true);
      await shot('delayed-cache-old-metadata');
      await release('cacheInfo');
      await ready('cache');
      await finishMotion();
      await persistent();
      return { tokenOldPanel: 'profile', cacheOldPanel: 'metadata', retainedUntilReady: true };
    });
    await check(
      'rapid switches ignore stale async results and interrupt existing motion safely',
      async () => {
        await open();
        await configure('tokenStatus', { hold: true });
        await configure('cacheInfo', { hold: true });
        await page.locator('#settings-tab-metadata').click();
        await held('tokenStatus');
        await page.locator('#settings-tab-cache').click();
        await held('cacheInfo');
        await select('profile');
        await release('cacheInfo');
        await release('tokenStatus');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
        assert.deepEqual(await active(), ['settings-panel-profile']);
        await page.evaluate(() => {
          for (const name of ['appearance', 'cache', 'metadata', 'application', 'profile'])
            document.querySelector('#settings-tab-' + name).click();
        });
        await ready('profile');
        await finishMotion();
        assert.deepEqual(await active(), ['settings-panel-profile']);
        assert.equal(await page.locator('.settings-panel:not([hidden])').count(), 1);
        return { staleResponsesIgnored: 2, rapidLastTab: 'profile', visiblePanelsAfterSettle: 1 };
      }
    );
    await check(
      'representative crossfade frames keep old and new content within a stable viewport',
      async () => {
        await select('appearance');
        await select('profile');
        await page.evaluate(() => {
          document.querySelector('#settings-tab-appearance').click();
          queueMicrotask(() =>
            queueMicrotask(() => {
              document
                .querySelector('#settings-shell')
                .getAnimations({ subtree: true })
                .forEach((animation) => animation.pause());
            })
          );
        });
        await ready('appearance');
        const frames = [];
        for (const time of [0, 15, 30, 45, 60, 80, 100, 115, 130]) {
          const state = await page.evaluate((time) => {
            const shell = document.querySelector('#settings-shell');
            shell.getAnimations({ subtree: true }).forEach((animation) => {
              animation.pause();
              animation.currentTime = time;
            });
            return [...document.querySelectorAll('.settings-panel:not([hidden])')].map((panel) => ({
              id: panel.id,
              opacity: Number(getComputedStyle(panel).opacity),
              transform: getComputedStyle(panel).transform,
              inert: panel.inert
            }));
          }, time);
          assert.equal(state.length, 2);
          assert.ok(state.every((panel) => panel.opacity >= 0 && panel.opacity <= 1));
          if (time > 0) assert.ok(state.every((panel) => panel.opacity > 0 && panel.opacity < 1));
          assert.equal(state.filter((panel) => !panel.inert).length, 1);
          const file = await shot('transition-' + String(time).padStart(3, '0') + 'ms');
          frames.push({ time, state, file });
        }
        report.transitionFrames = frames;
        await page.evaluate(() =>
          document
            .querySelector('#settings-shell')
            .getAnimations({ subtree: true })
            .forEach((animation) => animation.finish())
        );
        await finishMotion();
        assert.equal(await page.locator('.settings-panel:not([hidden])').count(), 1);
        const settled = await shot('transition-settled');
        return { frames, settled };
      }
    );
    await check(
      'Escape retains settings; explicit close, replacement and same-task reopen discard pending sessions',
      async () => {
        await open();
        await configure('tokenStatus', { hold: true });
        await page.locator('#settings-tab-metadata').click();
        await held('tokenStatus');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#modal').evaluate((dialog) => dialog.open), true);
        await close();
        await open('profile');
        await release('tokenStatus');
        await finishMotion();
        assert.deepEqual(await active(), ['settings-panel-profile']);
        assert.equal(await page.locator('#settings-panel-metadata').count(), 0);
        await configure('cacheInfo', { hold: true });
        await page.locator('#settings-tab-cache').click();
        await held('cacheInfo');
        await close();
        await open();
        await release('cacheInfo');
        assert.deepEqual(await active(), ['settings-panel-appearance']);
        await page.evaluate(() => {
          closeModal();
          void settingsModal('profile');
        });
        await ready('profile');
        await finishMotion();
        assert.equal(
          await page
            .locator('#modal')
            .evaluate((dialog) => dialog.classList.contains('settings-dialog')),
          true
        );
        await select('appearance');
        await configure('tokenStatus', { hold: true });
        await page.locator('#settings-tab-metadata').click();
        await held('tokenStatus');
        await page.locator('#settings-density').click();
        await release('tokenStatus');
        await page.waitForFunction(
          () =>
            document.querySelector('#ratio-select') && !document.querySelector('#settings-shell')
        );
        assert.equal(
          await page
            .locator('#modal')
            .evaluate((dialog) => dialog.classList.contains('settings-dialog')),
          false
        );
        return { escape: true, closeButton: true, sameTaskReopen: true, replacementDensity: true };
      }
    );
    await check(
      'keyboard tab roving, focus, control hydration and popover Escape remain functional',
      async () => {
        await open();
        await page.locator('#settings-tab-appearance').focus();
        for (const [key, tab] of [
          ['Home', 'profile'],
          ['End', 'application'],
          ['ArrowRight', 'profile'],
          ['ArrowLeft', 'application'],
          ['Home', 'profile'],
          ['ArrowRight', 'appearance']
        ]) {
          await page.keyboard.press(key);
          await ready(tab);
          assert.equal(
            await page
              .locator('#settings-tab-' + tab)
              .evaluate((button) => document.activeElement === button),
            true
          );
          assert.equal(await page.locator('.settings-tabs [tabindex="0"]').count(), 1);
        }
        const control = page.locator('#sidebar-mode').locator('..').locator('.album-select-button');
        await control.focus();
        await page.keyboard.press('Enter');
        assert.equal(await control.getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('Escape');
        assert.equal(await control.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#modal').evaluate((dialog) => dialog.open), true);
        assert.equal(await page.locator('#settings-shell').count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#modal').evaluate((dialog) => dialog.open), true);
        await close();
        return {
          rovingKeys: 6,
          hydratedCombobox: true,
          firstEscapeOnlyClosesPopover: true,
          secondEscapeRetainsPreferences: true
        };
      }
    );
    await check(
      'token and cache load failures are local, readable and retry without rebuilding shell',
      async () => {
        const outcomes = [];
        for (const [method, tab] of [
          ['tokenStatus', 'metadata'],
          ['cacheInfo', 'cache']
        ]) {
          await open('profile');
          await rememberShell();
          await configure(method, { hold: true });
          await page.locator('#settings-tab-' + tab).click();
          await held(method);
          assert.deepEqual(await active(), ['settings-panel-profile']);
          await release(method, true);
          await ready(tab);
          await finishMotion();
          assert.match(
            await page.locator('#settings-panel-' + tab + ' .settings-error').textContent(),
            /Injected isolated/
          );
          await persistent();
          await shot('error-' + tab);
          await configure(method, { hold: true });
          await page.locator('#settings-panel-' + tab + ' [data-settings-retry]').click();
          await held(method);
          assert.equal(
            await page.locator('#settings-panel-' + tab + ' .settings-error').isVisible(),
            true
          );
          await persistent();
          await release(method);
          await page.waitForFunction(
            (tab) => !document.querySelector('#settings-panel-' + tab + ' .settings-error'),
            tab
          );
          await ready(tab);
          await finishMotion();
          assert.equal(
            await page.locator('#settings-panel-' + tab + ' .settings-error').count(),
            0
          );
          await persistent();
          outcomes.push({ method, retried: true });
        }
        return outcomes;
      }
    );
    await check(
      'real generated-profile token save/remove, profile save and cache cleanup preserve their shell',
      async () => {
        await open('metadata');
        await rememberShell();
        const tokenInput = await page.locator('#token-input').elementHandle();
        if (report.runtime.encryption) {
          await page
            .locator('#token-input')
            .fill('generated-settings-motion-' + crypto.randomBytes(12).toString('hex'));
          await configure('saveToken', { hold: true });
          await page.locator('#token-save').click();
          await held('saveToken');
          assert.equal(await page.locator('#token-save').isDisabled(), true);
          await page.locator('#token-input').fill('newer-unsaved-draft');
          await select('profile');
          await release('saveToken');
          await page.waitForFunction(() => !document.querySelector('#token-save').disabled);
          assert.deepEqual(await active(), ['settings-panel-profile']);
          await select('metadata');
          assert.equal(await page.locator('#token-input').inputValue(), 'newer-unsaved-draft');
          assert.equal(
            await page.evaluate(() => api('tokenStatus').then((status) => status.saved)),
            true
          );
          assert.equal(
            await page.locator('#settings-panel-metadata h3 .chip').textContent(),
            '已加密保存'
          );
        }
        await page.locator('#token-input').fill('');
        await page.locator('#token-save').click();
        await page.waitForFunction(
          () =>
            !document.querySelector('#token-save').disabled &&
            document.querySelector('#settings-panel-metadata h3 .chip').textContent === '未设置'
        );
        assert.equal(
          await page.evaluate(() => api('tokenStatus').then((status) => status.saved)),
          false
        );
        assert.equal(
          await tokenInput.evaluate((input) => input === document.querySelector('#token-input')),
          true
        );
        await persistent();
        await select('profile');
        await page.locator('#profile-name').fill('Motion verified');
        await page.locator('#profile-save').click();
        await page.waitForFunction(() => S.settings.nickname === 'Motion verified');
        await select('cache');
        const calls = await app.evaluate(() => global.__settingsMotion.calls.cacheInfo);
        await page.locator('#cache-unused').click();
        for (let attempt = 0; attempt < 100; attempt++) {
          if (
            await app.evaluate((_, calls) => global.__settingsMotion.calls.cacheInfo > calls, calls)
          )
            break;
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        assert.ok(
          await app.evaluate((_, calls) => global.__settingsMotion.calls.cacheInfo > calls, calls)
        );
        await persistent();
        await open('profile');
        assert.equal(await page.locator('#profile-name').inputValue(), 'Motion verified');
        return {
          tokenSaveEncrypted: report.runtime.encryption,
          tokenRemoved: true,
          newerDraftRetained: report.runtime.encryption,
          nicknameSaved: true,
          cacheCleaned: true
        };
      }
    );
    await check(
      'late avatar choose/reset completions never write into a reopened profile panel',
      async () => {
        // Cancel the native picker deterministically; no original image is ever read.
        await app.evaluate(({ dialog }) => {
          dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
        });
        await configure('chooseAvatar', { hold: true });
        await page.locator('#avatar-choose').click();
        await held('chooseAvatar');
        await select('appearance');
        await release('chooseAvatar');
        await select('profile');
        assert.equal(await page.locator('#avatar-choose').isDisabled(), false);
        await configure('settings', { hold: true });
        await page.locator('#avatar-reset').click();
        await held('settings');
        await close();
        await open('profile');
        const avatar = await page.locator('#identity-avatar').elementHandle();
        await release('settings');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        );
        assert.equal(
          await avatar.evaluate((image) => image === document.querySelector('#identity-avatar')),
          true
        );
        assert.match(
          await page.locator('#identity-avatar').getAttribute('src'),
          /default-avatar\.jpg$/
        );
        return { canceledPicker: true, resetAfterReopen: true };
      }
    );
    await check(
      'reduced motion disables opening, tab, indicator and control animations',
      async () => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await open('profile');
        for (const tab of tabs) {
          await select(tab, false);
          assert.equal(
            await page
              .locator('#modal')
              .evaluate((dialog) => dialog.getAnimations({ subtree: true }).length),
            0
          );
          assert.equal(await page.locator('.settings-panel:not([hidden])').count(), 1);
        }
        await shot('reduced-motion-application');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await select('profile');
        await page.evaluate(() => document.querySelector('#settings-tab-application').click());
        await ready('application');
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForFunction(
          () => document.querySelector('#modal').getAnimations({ subtree: true }).length === 0
        );
        assert.equal(await page.locator('.settings-panel:not([hidden])').count(), 1);
        return { allFiveTabsWithoutAnimations: true, preferenceChangedMidTransition: true };
      }
    );
    await check(
      'narrow and short windows retain bounded scrolling, tabs and dialog controls',
      async () => {
        await page.waitForFunction(() => !document.querySelector('#toast-region').children.length);
        const dimensions = [];
        for (const [width, height] of [
          [375, 667],
          [390, 360],
          [740, 360]
        ]) {
          // The application's existing toolbar assumes its 980px minimum width.
          // Open through the real trigger first, then stress only the owned settings dialog.
          await size(1440, 960);
          await open('profile');
          await size(width, height);
          for (const tab of tabs) {
            await select(tab);
            const measured = await page.evaluate((tab) => {
              const dialog = document.querySelector('#modal'),
                panel = document.querySelector('#settings-panel-' + tab),
                r = dialog.getBoundingClientRect();
              const close = document.querySelector('#modal-close').getBoundingClientRect();
              const buttons = [...document.querySelectorAll('.settings-tabs button')].map(
                (button) => {
                  const b = button.getBoundingClientRect();
                  return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
                }
              );
              panel.scrollTop = panel.scrollHeight;
              return {
                tab,
                dialog: { x: r.x, y: r.y, right: r.right, bottom: r.bottom },
                panel: {
                  width: panel.clientWidth,
                  scrollWidth: panel.scrollWidth,
                  height: panel.clientHeight,
                  scrollHeight: panel.scrollHeight,
                  scrollTop: panel.scrollTop
                },
                close: { x: close.x, y: close.y, right: close.right, bottom: close.bottom },
                buttons
              };
            }, tab);
            assert.ok(
              measured.dialog.x >= -1 &&
                measured.dialog.y >= -1 &&
                measured.dialog.right <= width + 1 &&
                measured.dialog.bottom <= height + 1,
              JSON.stringify(measured)
            );
            assert.ok(
              measured.panel.scrollWidth <= measured.panel.width + 1,
              'Horizontal panel overflow: ' + JSON.stringify(measured)
            );
            assert.ok(measured.panel.height >= 80);
            assert.ok(
              measured.buttons.every(
                (button) =>
                  button.x >= measured.dialog.x &&
                  button.right <= measured.dialog.right &&
                  button.y >= measured.dialog.y &&
                  button.bottom <= measured.dialog.bottom
              )
            );
            assert.ok(measured.close.y >= 0 && measured.close.bottom <= height);
            if (measured.panel.scrollHeight > measured.panel.height)
              assert.ok(measured.panel.scrollTop > 0);
            dimensions.push({ width, height, ...measured });
            if (tab === 'metadata' || tab === 'cache')
              await shot(`viewport-${width}x${height}-${tab}`);
          }
        }
        await size(1440, 960);
        await open('appearance');
        await page.locator('#theme-select').selectOption('dark', { force: true });
        await page.waitForFunction(() => S.settings.theme === 'dark');
        await shot('dark-appearance');
        return dimensions;
      }
    );
    await check('renderer reports no uncaught errors', async () => {
      assert.deepEqual(report.errors, []);
      return { errors: 0 };
    });
  } catch (error) {
    report.fatal = error.stack;
    process.exitCode = 1;
  } finally {
    if (app) {
      await app
        .evaluate(() => {
          global.__settingsMotion?.pending
            .splice(0)
            .forEach((item) => item.resolve({ fail: false }));
        })
        .catch(() => {});
      await app.close().catch((error) => {
        report.closeError = error.stack;
        process.exitCode = 1;
      });
    }
    report.summary = {
      passed: report.checks.filter((item) => item.status === 'passed').length,
      failed: report.checks.filter((item) => item.status === 'failed').length
    };
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ run, summary: report.summary, fatal: report.fatal || null }));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
