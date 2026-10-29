'use strict';
// Lead runs this serially. Fixtures, profiles and evidence stay inside one unique archive run.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const stage =
  process.env.ACG_CHECK_STAGE ||
  path.join(path.dirname(root), '资料归档', 'release-1.1.1-20261029');
const executable = process.env.ACG_EXECUTABLE
  ? path.resolve(process.env.ACG_EXECUTABLE)
  : require('electron');
const packaged = !!process.env.ACG_EXECUTABLE;
const report = {
  passed: false,
  started: new Date().toISOString(),
  scope:
    'Actual Electron renderer and IPC, generated PNG imports and inert synthetic credential. Progress events are generated at the IPC event boundary; only update HTTP transport and directory-picker results are intercepted. No product styles or handlers are replaced.',
  checks: [],
  screenshots: [],
  samples: [],
  runtimes: [],
  errors: [],
  consoleErrors: [],
  blockedNetwork: []
};
let run, collection, app, page;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const waitFrames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
async function shot(name) {
  const file = path.join(run, `${name}.png`);
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}
async function check(name, callback) {
  await callback();
  report.checks.push(name);
  console.log(`PASS ${name}`);
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  app = null;
  let timer;
  try {
    const network = await closing.evaluate(() => globalThis.__release111?.blocked || []);
    report.blockedNetwork.push(...network);
    assert.deepEqual(network, [], 'No unexpected public network requests');
  } finally {
    try {
      await Promise.race([
        closing.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned Electron close timeout')), 15000);
        })
      ]);
    } catch (error) {
      const child = closing.process();
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
async function launch(profile, instrument = false) {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [root],
    cwd: packaged ? path.dirname(executable) : root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) =>
    report.errors.push({ message: error.message, stack: error.stack })
  );
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push({ source: 'renderer', url: route.request().url() });
    await route.abort();
  });
  const actual = await app.evaluate(({ app, BrowserWindow, dialog, net, session }, collection) => {
    const probe = (globalThis.__release111 = { blocked: [], updates: 0 });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
    const realFetch = net.fetch.bind(net);
    net.fetch = (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/latest$/.test(url)) {
        probe.updates++;
        // Real update parser/UI, deterministic transport response, no downloading/installing.
        return Promise.resolve(
          new Response(
            JSON.stringify({
              tag_name: `v${app.getVersion()}`,
              name: 'Generated release fixture',
              html_url: 'https://github.com/GXinnnnnn/ACG-album/releases/tag/v' + app.getVersion(),
              assets: []
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        );
      }
      if (/^https?:\/\//i.test(url)) {
        probe.blocked.push({ source: 'net.fetch', url });
        return Promise.reject(new Error('Unexpected public HTTP blocked by release acceptance'));
      }
      return realFetch(input, ...args);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        probe.blocked.push({ source: 'session', url: details.url });
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1600, 1000);
    win.show();
    win.focus();
    win.webContents.focus();
    return {
      executable: process.execPath,
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath('userData')
    };
  }, collection);
  assert.ok(samePath(actual.executable, executable));
  assert.equal(actual.isPackaged, packaged);
  assert.ok(samePath(actual.userData, path.join(profile, 'chromium-profile')));
  report.runtimes.push(actual);
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && S.settings.metadataOnboardingSeen
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  if (instrument) {
    await page.addInitScript(() => {
      const contexts = (window.__release111GL = []);
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (...args) {
        const context = original.apply(this, args);
        if (args[0] === 'webgl2' && context && !contexts.includes(context)) contexts.push(context);
        return context;
      };
      window.__release111Unhandled = [];
      window.addEventListener('unhandledrejection', (event) =>
        window.__release111Unhandled.push(String(event.reason))
      );
    });
    await page.reload();
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.loadVersion > 0 && window.albumLiquidGlass
    );
  }
  assert.ok(samePath((await rpc('init')).dataDir, profile));
  await waitFrames();
}
async function event(type, data) {
  await app.evaluate(
    ({ BrowserWindow }, event) =>
      BrowserWindow.getAllWindows()[0].webContents.send('library:event', event),
    { type, data }
  );
  await waitFrames();
}
async function progressSnapshot() {
  return page.evaluate(() => {
    const selectors = [
      '#progress-panel',
      '#progress-title',
      '.progress-track',
      '.progress-details',
      '#progress-directory',
      '#progress-path'
    ];
    const slots = Object.fromEntries(
      selectors.map((selector) => {
        const node = document.querySelector(selector),
          rect = node.getBoundingClientRect(),
          style = getComputedStyle(node);
        return [
          selector,
          {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            color: style.color
          }
        ];
      })
    );
    return {
      slots,
      title: document.querySelector('#progress-title').textContent,
      counts: document.querySelector('#progress-detail').textContent,
      name: document.querySelector('#progress-directory').textContent,
      hint: document.querySelector('#progress-path').textContent,
      percent: document.querySelector('.progress-track').getAttribute('aria-valuenow'),
      width: document.querySelector('#progress-bar').style.width,
      canvases: document.querySelectorAll('#progress-panel canvas').length
    };
  });
}
function equalSlots(actual, reference) {
  for (const [selector, expected] of Object.entries(reference.slots)) {
    const slot = actual.slots[selector];
    for (const key of ['x', 'y', 'width', 'height'])
      assert.ok(Math.abs(slot[key] - expected[key]) < 0.1, `${selector} ${key} remains stable`);
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color'])
      assert.equal(slot[key], expected[key], `${selector} ${key} remains stable`);
  }
}
async function progressChecks() {
  await event('progress', { active: true, current: '短名', images: 80, folders: 12, errors: 0 });
  assert.equal(
    (await progressSnapshot()).percent,
    null,
    'Scan items never become an invented match total'
  );
  await event('online', {
    active: true,
    discovering: true,
    completed: 2,
    remaining: 6,
    total: 999
  });
  await expect(page.locator('#progress-title')).toHaveText('正在检索作品简介');
  const reference = await progressSnapshot();
  assert.equal(reference.percent, '25');
  assert.equal(reference.width, '25%');
  assert.equal(reference.counts, '已处理 2 项 | 待处理 6 项');
  assert.ok(reference.slots['#progress-directory'].y > reference.slots['.progress-details'].y);
  assert.ok(reference.slots['#progress-directory'].y < reference.slots['#progress-path'].y);
  assert.equal(reference.hint, '作品简介在后台检索，可继续浏览相册');
  const names = ['中文作品长名称'.repeat(35), 'A_very_long_English_work_name_'.repeat(30), '短名'];
  for (let i = 0; i < 45; i++) {
    const name = names[i % names.length];
    await event('progress', {
      active: true,
      current: name,
      images: 80 + i,
      folders: 12 + i,
      errors: i % 2
    });
    await event('online', {
      active: true,
      discovering: i % 2 === 0,
      completed: 3,
      remaining: 17,
      total: 9999
    });
    const actual = await progressSnapshot();
    equalSlots(actual, reference);
    assert.equal(actual.title, '正在检索作品简介');
    assert.equal(actual.name, name);
    assert.equal(actual.counts, '已处理 3 项 | 待处理 17 项');
    assert.equal(actual.percent, '15');
    assert.ok(actual.canvases <= 1);
  }
  await shot('progress-long-name');
  await event('progress', { active: false, current: '', images: 125, folders: 57 });
  const onlineId = idFor(path.join(collection, 'generated_album'));
  await event('online', {
    active: true,
    id: onlineId,
    completed: 11,
    remaining: 9,
    discovering: false
  });
  await expect(page.locator('#progress-directory')).toHaveText('generated_album');
  equalSlots(await progressSnapshot(), reference);
  const stable = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const panel = document.querySelector('#progress-panel');
        const directory = document.querySelector('#progress-directory');
        const canvases = [...panel.querySelectorAll('canvas')];
        let writes = 0;
        const observer = new MutationObserver((rows) => (writes += rows.length));
        // Invoke the actual renderer repeatedly; genuine IPC delivery is covered above.
        observer.observe(panel, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true
        });
        for (let i = 0; i < 100; i++) showOnlineStatus({ ...latestOnlineProgress });
        queueMicrotask(() => {
          observer.disconnect();
          resolve({
            writes,
            sameDirectory: directory === document.querySelector('#progress-directory'),
            sameCanvases: canvases.every(
              (canvas, index) => canvas === panel.querySelectorAll('canvas')[index]
            )
          });
        });
      })
  );
  assert.deepEqual(stable, { writes: 0, sameDirectory: true, sameCanvases: true });
  await event('online', {
    active: false,
    paused: 'access',
    completed: 11,
    remaining: 9,
    id: onlineId
  });
  equalSlots(await progressSnapshot(), reference);
  await event('online', { active: false, completed: 20, remaining: 0 });
  await expect(page.locator('#progress-title')).toHaveText('作品检索完成');
  equalSlots(await progressSnapshot(), reference);
  report.samples.push({ progress: { reference, repeatedSnapshots: stable, changes: 45 } });
}
async function frostSample(label, scroller, modalSelector = '#modal') {
  await page.evaluate(async (selector) => {
    await document.fonts.ready;
    const modal = document.querySelector(selector);
    const animations = modal.getAnimations({ subtree: true }).filter((animation) => {
      const timing = animation.effect?.getComputedTiming();
      return timing && Number.isFinite(timing.endTime);
    });
    await Promise.allSettled(animations.map((animation) => animation.finished));
    window.albumLiquidGlass.refresh({ immediate: true });
  }, modalSelector);
  await waitFrames();
  await page.waitForFunction(
    (selector) =>
      document
        .querySelector(selector)
        ?.style.getPropertyValue('--dialog-frost-image')
        .includes('data:image/svg+xml'),
    modalSelector
  );
  await page.waitForFunction(() => window.albumLiquidGlass.stats().gpu.status === 'webgl2');
  const sample = await page.evaluate(
    ({ label, scroller, modalSelector }) => {
      const modal = document.querySelector(modalSelector),
        rect = modal.getBoundingClientRect();
      const mask = modal.style.getPropertyValue('--dialog-frost-image');
      const match = mask.match(/data:image\/svg\+xml,([^\"]+)/);
      if (!match) throw new Error('Missing actual frost SVG');
      const svg = new DOMParser().parseFromString(decodeURIComponent(match[1]), 'image/svg+xml');
      const rectangles = [...svg.querySelectorAll('rect')].map((node) =>
        Object.fromEntries(
          ['x', 'y', 'width', 'height', 'rx', 'fill', 'fill-opacity', 'filter'].map((name) => [
            name,
            node.getAttribute(name)
          ])
        )
      );
      const panel = document.querySelector(scroller),
        style = getComputedStyle(panel);
      const descriptions = [
        ...modal.querySelectorAll(
          '.field-help,.setting-row p,.updates-description,.updates-footnote,.about-description,.about-note'
        )
      ]
        .filter((node) => node.getClientRects().length)
        .map((node) => {
          const css = getComputedStyle(node);
          return {
            text: node.textContent.slice(0, 60),
            color: css.color,
            fontWeight: css.fontWeight,
            fontFamily: css.fontFamily,
            fontSize: css.fontSize,
            textShadow: css.textShadow
          };
        });
      return {
        label,
        theme: document.documentElement.dataset.theme,
        renderer: document.documentElement.dataset.liquidRenderer,
        modal: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        shell: {
          settings: modal.classList.contains('settings-dialog'),
          gutter: getComputedStyle(modal).scrollbarGutter,
          border:
            parseFloat(getComputedStyle(modal).borderLeftWidth) +
            parseFloat(getComputedStyle(modal).borderRightWidth),
          clientWidth: modal.clientWidth,
          canvas: (() => {
            const box = modal.querySelector('.liquid-glass-canvas')?.getBoundingClientRect();
            return box
              ? { left: box.left - rect.left, right: rect.right - box.right, width: box.width }
              : null;
          })()
        },
        rectangles,
        gaussian: svg.querySelector('feGaussianBlur')?.getAttribute('stdDeviation'),
        scrollbarColor: style.scrollbarColor,
        scrollbarWidth: style.scrollbarWidth,
        scrollTop: panel.scrollTop,
        scrollHeight: panel.scrollHeight,
        clientHeight: panel.clientHeight,
        descriptions,
        canvasCount: modal.querySelectorAll('canvas').length,
        stats: window.albumLiquidGlass.stats(),
        gl: (window.__release111GL || []).map((context) => ({
          error: context.getError(),
          lost: context.isContextLost()
        }))
      };
    },
    { label, scroller, modalSelector }
  );
  assert.equal(
    sample.rectangles.length,
    1,
    'The frost image contains exactly one material rectangle'
  );
  const rectangle = sample.rectangles[0];
  assert.equal(rectangle.rx, '18');
  assert.equal(sample.gaussian, '9');
  const gaps = [
    +rectangle.x,
    +rectangle.y,
    sample.modal.width - +rectangle.x - +rectangle.width,
    sample.modal.height - +rectangle.y - +rectangle.height
  ];
  assert.ok(gaps.every((gap) => gap >= 9.5));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 0.1, `Equal frost insets: ${gaps}`);
  if (sample.shell.settings) {
    assert.ok(
      gaps.every((gap) => Math.abs(gap - 18) < 0.1),
      `Refined settings rim: ${gaps}`
    );
    assert.equal(
      sample.shell.gutter,
      'auto',
      'Non-scrolling settings shell must not reserve a second scrollbar'
    );
    assert.ok(Math.abs(sample.modal.width - sample.shell.clientWidth - sample.shell.border) < 0.5);
    assert.ok(sample.shell.canvas);
    assert.ok(
      Math.abs(sample.shell.canvas.left - sample.shell.canvas.right) < 0.5,
      'Optical canvas reaches both shell edges equally'
    );
  }
  assert.equal(sample.renderer, 'webgl2');
  assert.equal(sample.stats.gpu.status, 'webgl2');
  assert.equal(sample.stats.gpu.error, '');
  assert.ok(sample.stats.gpu.draws > 0);
  assert.ok(sample.gl.length > 0, 'Instrumented actual WebGL2 context exists');
  for (const context of sample.gl) assert.deepEqual(context, { error: 0, lost: false });
  if (!sample.shell.settings || /appearance|metadata/.test(label))
    assert.ok(sample.descriptions.length > 0);
  const inks =
    sample.theme === 'dark'
      ? ['rgb(200, 194, 213)', 'rgb(222, 219, 233)']
      : ['rgb(69, 66, 81)', 'rgb(53, 51, 66)'];
  for (const text of sample.descriptions) {
    assert.ok(
      inks.includes(text.color),
      `Secondary ink follows strengthened theme tokens: ${JSON.stringify(text)}`
    );
    assert.equal(text.fontWeight, '550');
    assert.ok(text.fontFamily);
  }
  assert.equal(sample.scrollbarWidth, 'thin');
  assert.notEqual(sample.scrollbarColor, 'auto');
  assert.ok(
    sample.scrollbarColor.includes(
      sample.theme === 'dark' ? 'rgb(129, 115, 143)' : 'rgb(155, 129, 153)'
    ),
    'Scrollbar thumb follows the actual theme token'
  );
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const document = await cdp.send('DOM.getDocument', { depth: -1 });
    const evidenceSelector = await page.evaluate((modalSelector) => {
      document
        .querySelectorAll('[data-font-evidence]')
        .forEach((node) => node.removeAttribute('data-font-evidence'));
      const modal = document.querySelector(modalSelector),
        bounds = modal.getBoundingClientRect();
      const paragraph = [
        ...modal.querySelectorAll(
          '.setting-row p,.updates-description,.about-description,.about-note,.muted'
        )
      ].find((node) => {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom)
          return false;
        for (
          let parent = node.parentElement;
          parent && parent !== modal;
          parent = parent.parentElement
        ) {
          if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
            const clip = parent.getBoundingClientRect();
            if (rect.bottom <= clip.top || rect.top >= clip.bottom) return false;
          }
        }
        return true;
      });
      if (!paragraph) return '';
      paragraph.dataset.fontEvidence = 'true';
      return `${modalSelector} [data-font-evidence]`;
    }, modalSelector);
    assert.ok(evidenceSelector, 'A visible secondary paragraph is present');
    const secondary = await cdp.send('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: evidenceSelector
    });
    assert.ok(secondary.nodeId, 'A real secondary paragraph is present');
    const actualFonts = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: secondary.nodeId });
    sample.actualFonts = actualFonts.fonts.filter((font) => font.glyphCount > 0);
    assert.ok(sample.actualFonts.length > 0, 'CDP reports rendered glyphs');
    const lanting = sample.actualFonts.filter((font) =>
      /FZLan|兰亭/i.test(font.familyName + font.postScriptName)
    );
    if (lanting.length)
      assert.ok(
        lanting.some((font) =>
          /FZLanTingYuan-DB1-GBK|FZLANTY_ZHONGCUK|方正兰亭圆_GBK_中粗/i.test(
            font.familyName + ' ' + font.postScriptName
          )
        ),
        'Secondary paragraphs must render the actual heavier Lanting face: ' +
          JSON.stringify(sample.actualFonts)
      );
    sample.fontEvidence = lanting.length
      ? 'actual heavier Lanting glyphs'
      : 'system fallback glyphs (no local Lanting rendered)';
  } finally {
    await cdp.detach();
  }
  report.samples.push(sample);
  await shot(label);
  return sample;
}
async function scrollEvidence(label, selector, modalSelector = '#modal') {
  await page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    panel.scrollTop = 0;
    window.albumLiquidGlass.refresh({ immediate: true });
  }, selector);
  await waitFrames();
  const before = await frostSample(`${label}-top`, selector, modalSelector);
  await page.evaluate((selector) => {
    const panel = document.querySelector(selector);
    panel.scrollTop = panel.scrollHeight;
    window.albumLiquidGlass.refresh({ immediate: true });
  }, selector);
  await waitFrames();
  const after = await frostSample(`${label}-bottom`, selector, modalSelector);
  if (after.scrollHeight > after.clientHeight + 1) assert.ok(after.scrollTop > 0);
  // The rounded layer must remain clipped to one inset material area after scrolling.
  assert.equal(after.rectangles.length, before.rectangles.length);
  assert.deepEqual(after.modal, before.modal);
}
async function themeDialogs(theme) {
  await page.evaluate(async (theme) => {
    await changeTheme(theme);
    await settingsModal('appearance');
  }, theme);
  await expect(page.locator('#theme-select')).toHaveValue(theme);
  await expect(page.locator('#liquid-glass')).toBeChecked();
  await expect(page.locator('#motion-level')).toHaveValue('high');
  await scrollEvidence(`${theme}-preferences-appearance`, '#settings-panel-appearance');
  await page.locator('#settings-tab-metadata').click();
  await expect(page.locator('#settings-panel-metadata')).toBeVisible();
  await scrollEvidence(`${theme}-preferences-metadata`, '#settings-panel-metadata');
  for (const tab of ['profile', 'cache', 'application']) {
    await page.locator(`#settings-tab-${tab}`).click();
    await expect(page.locator(`#settings-panel-${tab}`)).toBeVisible();
    await scrollEvidence(`${theme}-preferences-${tab}`, `#settings-panel-${tab}`);
  }
  await page.locator('#settings-updates').click();
  await expect(page.locator('[data-update-result] [data-update-status]')).toBeVisible();
  await expect(page.locator('[data-update-result] [data-update-status]')).not.toHaveAttribute(
    'data-update-status',
    'error'
  );
  const child = 'dialog[data-info-child][open]';
  await scrollEvidence(`${theme}-updates`, child, child);
  await page.locator(`${child} .info-dialog-close`).click();
  await page.locator('#settings-about').click();
  await expect(page.locator('.album-about')).toBeVisible();
  await scrollEvidence(`${theme}-about`, child, child);
  await page.locator(`${child} .info-dialog-close`).click();
  await page.locator('#modal-close').click();
}
(async () => {
  try {
    await fs.mkdir(stage, { recursive: true });
    assert.ok(samePath(await fs.realpath(stage), stage), 'Archive stage must be physical');
    run = path.join(
      stage,
      `gui-${new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_')}-${randomUUID()}`
    );
    await fs.mkdir(run);
    collection = path.join(run, 'generated_collection');
    await fs.mkdir(path.join(collection, 'generated_album'), { recursive: true });
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#6595b7' }
    })
      .png()
      .toBuffer();
    for (let i = 0; i < 16; i++)
      await fs.writeFile(path.join(collection, 'generated_album', `${i}.png`), png, { flag: 'wx' });
    Object.assign(report, { run, collection, executable, packaged });
    const fresh = path.join(run, 'fresh_profile'),
      established = path.join(run, 'established_profile');
    await fs.mkdir(fresh);
    await fs.mkdir(established);
    await check(
      'fresh profile opens metadata once, focuses token at bottom and retains defaults',
      async () => {
        await launch(fresh);
        await expect(page.locator('#modal')).toBeVisible();
        await expect(page.locator('#settings-tab-metadata')).toHaveAttribute(
          'aria-selected',
          'true'
        );
        await expect(page.locator('#token-input')).toBeFocused();
        const first = await page.evaluate(() => {
          const panel = document.querySelector('#settings-panel-metadata'),
            input = document.querySelector('#token-input');
          return {
            scrollTop: panel.scrollTop,
            bottomGap: panel.scrollHeight - panel.clientHeight - panel.scrollTop,
            tokenVisible:
              input.getBoundingClientRect().bottom <= panel.getBoundingClientRect().bottom + 1,
            marker: S.settings.metadataOnboardingSeen,
            glass: S.settings.liquidGlass,
            motion: S.settings.motionLevel,
            roots: S.roots.length
          };
        });
        assert.equal(first.marker, true);
        assert.equal(first.roots, 0);
        assert.equal(first.glass, true);
        assert.equal(first.motion, 'high');
        assert.ok(first.bottomGap <= 1 && first.tokenVisible);
        report.samples.push({ firstLaunch: first });
        await shot('fresh-first-metadata');
        await page.locator('#modal-close').click();
        await closeApp();
        await launch(fresh, true);
        await expect(page.locator('#modal')).not.toBeVisible();
        assert.equal((await rpc('init')).settings.metadataOnboardingSeen, true);
        await closeApp();
      }
    );
    await check(
      'existing roots and encrypted synthetic token persist and suppress guidance with no marker',
      async () => {
        await launch(established);
        await page.locator('#modal-close').click();
        await rpc('settings', { key: 'watchChanges', value: false });
        await rpc('settings', { key: 'autoMatch', value: false });
        const imported = await rpc('import', {
          onlineMatch: false,
          subjectTypes: [4],
          directoryKind: 'work'
        });
        assert.equal(imported.root, idFor(collection));
        // Inert generated credential, encrypted through actual IPC; its value is never logged or reported.
        const synthetic = `release-acceptance-${randomUUID().replace(/-/g, '')}`;
        await rpc('saveToken', { value: synthetic });
        assert.equal((await rpc('tokenStatus')).saved, true);
        await rpc('settings', { key: 'metadataOnboardingSeen', value: false });
        const before = await rpc('init');
        const encryptedPath = path.join(established, 'bangumi-token.enc');
        const encryptedBefore = createHash('sha256')
          .update(await fs.readFile(encryptedPath))
          .digest('hex');
        await closeApp();
        await launch(established, true);
        await expect(page.locator('#modal')).not.toBeVisible();
        const after = await rpc('init');
        assert.deepEqual(after.roots, before.roots);
        assert.equal(after.settings.autoMatch, false);
        assert.equal(after.settings.watchChanges, false);
        assert.equal((await rpc('tokenStatus')).saved, true);
        assert.equal(
          createHash('sha256')
            .update(await fs.readFile(encryptedPath))
            .digest('hex'),
          encryptedBefore
        );
        assert.equal(after.settings.metadataOnboardingSeen, true);
        report.samples.push({
          established: {
            rootCount: after.roots.length,
            savedCredentialPreserved: true,
            marker: true
          }
        });
        await page.evaluate(async () => {
          await loadSummary();
          await navigate({ parent: S.roots[0].id });
        });
      }
    );
    await check(
      'progress geometry, typography, truthful discovery ratios and canvas identity remain stable',
      progressChecks
    );
    for (const theme of ['light', 'dark'])
      await check(
        `${theme} preferences, metadata, updates and about use readable ink, themed scrollbars and one rounded GL frost layer`,
        () => themeDialogs(theme)
      );
    assert.ok(await app.evaluate(() => globalThis.__release111.updates >= 2));
    assert.deepEqual(await page.evaluate(() => window.__release111Unhandled || []), []);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.blockedNetwork, []);
    assert.deepEqual(
      report.consoleErrors.filter((text) =>
        /shader|WebGL.*(?:error|invalid)|GL_INVALID/i.test(text)
      ),
      []
    );
    await closeApp();
    report.passed = true;
  } catch (error) {
    report.errors.push({ message: error.message, stack: error.stack });
    if (page && run) await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    await closeApp().catch((error) => {
      report.errors.push({ message: error.message });
      process.exitCode = 1;
    });
    report.finished = new Date().toISOString();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify(
          { passed: report.passed, run, checks: report.checks.length, errors: report.errors },
          null,
          2
        )
      );
    }
  }
})();
