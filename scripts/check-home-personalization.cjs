'use strict';
// Prepare only; the Lead runs GUI checks serially. No user media or profiles are opened.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
// Opt in for TTF-free public payloads; local runs still require the default medium face.
const publicBuild = process.env.ACG_PUBLIC_BUILD === '1';
const stage = 'C:\\ACG\\资料归档\\home-personalization-20261028';
const requested = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const defaults = {
  eyebrow: 'YOUR PERSONAL COLLECTION',
  title: '我的相册',
  description: '把散落的画面，整理成喜欢的世界。'
};
const report = {
  started: new Date().toISOString(),
  passed: false,
  publicBuild,
  scope:
    'Real source/packaged Electron; generated PNGs and real import/settings IPC in an isolated physical profile. Only directory-picker results and deliberate save-fault/barrier boundaries are intercepted. No product styles or page handlers are replaced.',
  executable: null,
  runtime: { requested, actual: null },
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedNetwork: [],
  screenshots: [],
  samples: [],
  fixtures: [],
  expectedFaults: []
};
let run, profile, collection, app, page;
const expectedCopy = { ...defaults };
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const field = (key) => page.locator(`[data-home-copy="${key}"]`);
const editor = (key) => field(key).locator('input.home-copy-editor');
async function installSaveGate(kind) {
  await app.evaluate(({ ipcMain }, kind) => {
    const channel = 'library:settings',
      original = ipcMain._invokeHandlers.get(channel);
    if (!original) throw new Error('Missing actual settings IPC handler');
    const gate = (globalThis.__homeCopySaveGate = {
      original,
      calls: [],
      entered: false,
      release: null
    });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (...args) => {
      const settings = args[1];
      if (settings?.key === 'homeCopy') {
        gate.calls.push(JSON.parse(JSON.stringify(settings.value)));
        if (gate.calls.length === 1) {
          gate.entered = true;
          if (kind === 'barrier')
            await new Promise((resolve) => {
              gate.release = resolve;
            });
          if (kind === 'failure') throw new Error('Generated one-shot homeCopy save failure');
        }
      }
      return original(...args);
    });
  }, kind);
}
async function saveGateState() {
  return app.evaluate(() => ({
    calls: globalThis.__homeCopySaveGate.calls,
    entered: globalThis.__homeCopySaveGate.entered
  }));
}
async function releaseSaveGate() {
  await app.evaluate(() => globalThis.__homeCopySaveGate.release?.());
}
async function restoreSaveGate() {
  await app.evaluate(({ ipcMain }) => {
    const gate = globalThis.__homeCopySaveGate;
    if (!gate) return;
    gate.release?.();
    ipcMain.removeHandler('library:settings');
    ipcMain.handle('library:settings', gate.original);
    delete globalThis.__homeCopySaveGate;
  });
}
function within(parent, file) {
  const relative = path.relative(parent, file);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative),
    'Escaped evidence directory: ' + file
  );
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function settled() {
  await page.evaluate(() => window.albumHomeCopy.settled());
  await page.waitForFunction(
    () =>
      document.documentElement.dataset.fontState !== 'loading' &&
      (!window.albumLiquidGlass || window.albumLiquidGlass.stats().pending === 0)
  );
  await frames();
}
async function shot(name) {
  if (!page || page.isClosed()) return null;
  const file = path.join(run, name.replace(/[^a-z0-9_-]/gi, '_') + '.png');
  within(run, file);
  await page.screenshot({ path: file, scale: 'css', timeout: 15000 });
  report.screenshots.push(file);
  return file;
}
async function check(name, action) {
  const began = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, passed: true, ms: Date.now() - began, details });
    console.log('PASS ' + name);
    return details;
  } catch (error) {
    report.checks.push({ name, passed: false, ms: Date.now() - began, error: error.stack });
    report.errors.push({ source: name, message: error.message, stack: error.stack });
    await shot('failure_' + report.checks.length).catch(() => {});
    throw error;
  }
}
async function setup() {
  await fs.mkdir(stage, { recursive: true });
  assert.ok(samePath(await fs.realpath(stage), stage), 'Evidence stage must be physical');
  const base = path.join(stage, 'home_gui');
  await fs.mkdir(base, { recursive: true });
  assert.ok(samePath(await fs.realpath(base), base));
  run = path.join(
    base,
    new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') + '_' + randomUUID().replace(/-/g, '_')
  );
  within(stage, run);
  await fs.mkdir(run);
  profile = path.join(run, 'isolated_profile');
  collection = path.join(run, 'generated_collection');
  for (const directory of [profile, collection]) {
    await fs.mkdir(directory);
    assert.ok(samePath(await fs.realpath(directory), directory));
  }
  const png = await sharp({ create: { width: 96, height: 72, channels: 3, background: '#386f9a' } })
    .png()
    .toBuffer();
  const album = path.join(collection, 'generated_album');
  await fs.mkdir(album);
  for (const file of [
    path.join(collection, 'generated_root.png'),
    path.join(album, 'generated_child.png')
  ]) {
    within(run, file);
    await fs.writeFile(file, png, { flag: 'wx' });
    report.fixtures.push({
      file,
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex')
    });
  }
  Object.assign(report, { run, profile, collection, stage });
}
async function launch() {
  const executable = requested || require('electron');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable,
    args: requested ? [] : [root],
    cwd: requested ? path.dirname(executable) : root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) =>
    report.errors.push({ source: 'renderer', message: error.message, stack: error.stack })
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.consoleErrors.push({ text: message.text(), location: message.location() });
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push({ source: 'renderer', url: route.request().url() });
    await route.abort();
  });
  const actual = await app.evaluate(({ app, BrowserWindow, dialog, net, session }, collection) => {
    globalThis.__homePersonalization = { blocked: [], picks: [], collection };
    dialog.showOpenDialog = async () => {
      globalThis.__homePersonalization.picks.push(collection);
      return { canceled: false, filePaths: [collection] };
    };
    const fetch = net.fetch.bind(net);
    net.fetch = (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https?:\/\//i.test(url)) {
        globalThis.__homePersonalization.blocked.push({ source: 'net.fetch', url });
        return Promise.reject(new Error('Public HTTP blocked by home personalization check'));
      }
      return fetch(input, ...args);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        globalThis.__homePersonalization.blocked.push({ source: 'session', url: details.url });
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    globalThis.__homePersonalizationWindow = win;
    if (win.isMaximized()) win.unmaximize();
    win.show();
    win.focus();
    win.webContents.focus();
    return {
      isPackaged: app.isPackaged,
      executable: process.execPath,
      version: app.getVersion(),
      userData: app.getPath('userData'),
      versions: process.versions
    };
  }, collection);
  assert.ok(samePath(actual.executable, executable));
  assert.equal(actual.isPackaged, !!requested);
  assert.ok(samePath(actual.userData, path.join(profile, 'chromium-profile')));
  report.runtime = { requested: executable, actual, ...actual };
  report.executable = actual.executable;
  if (actual.isPackaged) {
    const asar = path.join(path.dirname(actual.executable), 'resources', 'app.asar');
    actual.asarSha256 = createHash('sha256')
      .update(await fs.readFile(asar))
      .digest('hex');
    actual.asar = asar;
    report.asarSha256 = actual.asarSha256;
  }
  if (publicBuild) {
    const files = await app.evaluate(({ app }) => {
      const fs = process.mainModule.require('node:fs');
      const p = process.mainModule.require('node:path');
      return fs.readdirSync(p.join(app.getAppPath(), 'src/assets/fonts/founder-lanting-yuan'), {
        recursive: true
      });
    });
    assert.deepEqual(
      files.filter((file) => /\.ttf$/i.test(file)),
      []
    );
    report.publicFonts = { files, localFontsEnabled: false };
    // Keep this session attached until app shutdown so installed local() faces cannot mask fallback.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    await cdp.send('CSS.setLocalFontsEnabled', { enabled: false });
    await page.reload();
  }
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.loadVersion > 0 &&
      window.albumHomeCopy &&
      window.albumTypography
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__homePersonalizationRejections = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__homePersonalizationRejections.push(String(event.reason?.stack || event.reason))
    );
  });
  const initial = await rpc('init');
  assert.ok(samePath(initial.dataDir, profile));
  await resize(1600, 1000);
  await settled();
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  app = null;
  try {
    const probe = await closing.evaluate(() => globalThis.__homePersonalization);
    report.blockedNetwork.push(...probe.blocked);
    const rejections = await page.evaluate(() => window.__homePersonalizationRejections || []);
    assert.deepEqual(rejections, [], 'No unhandled renderer rejections');
    assert.deepEqual(probe.blocked, [], 'No public main/session requests attempted');
  } finally {
    let timer;
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
async function resize(width, height = width === 3840 ? 2160 : 1000) {
  const native = await app.evaluate(
    ({ app }, size) => {
      const win = globalThis.__homePersonalizationWindow;
      app.focus({ steal: true });
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
      win.show();
      win.focus();
      win.webContents.focus();
      return {
        content: win.getContentBounds(),
        bounds: win.getBounds(),
        visible: win.isVisible(),
        focused: win.isFocused()
      };
    },
    { width, height }
  );
  await page.bringToFront();
  await page.waitForFunction((size) => innerWidth === size.width && innerHeight === size.height, {
    width,
    height
  });
  assert.equal(native.content.width, width);
  assert.equal(native.content.height, height);
  await settled();
  return native;
}
async function home() {
  await page.evaluate(() => navigate({}));
  await expect(page.locator('[data-home-copy]')).toHaveCount(3);
  await settled();
}
async function stored() {
  return (await rpc('init')).settings.homeCopy || {};
}
async function expectCopy() {
  for (const [key, value] of Object.entries(expectedCopy))
    await expect(field(key).locator('.home-copy-text')).toHaveText(value);
}
async function begin(key, value) {
  await field(key).click();
  await expect(editor(key)).toBeFocused();
  await editor(key).fill(value);
}
async function commit(key, value, method = 'Enter') {
  await begin(key, value);
  if (method === 'blur') await page.locator('#search').click();
  else await editor(key).press(method);
  await settled();
  expectedCopy[key] = value;
  await expect(field(key).locator('.home-copy-text')).toHaveText(value);
  assert.equal((await stored())[key], value);
}
// Read the physical SQLite file independently of renderer settings and the init IPC cache.
async function sqliteCopy() {
  const filename = path.join(profile, 'library.sqlite');
  within(profile, filename);
  return app.evaluate((_, filename) => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const db = new DatabaseSync(filename, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('homeCopy');
      if (!row) throw new Error('Missing actual SQLite homeCopy row');
      return { filename, raw: row.value, value: JSON.parse(row.value) };
    } finally {
      db.close();
    }
  }, filename);
}
async function copyMetrics(key) {
  await frames();
  return field(key).evaluate((element) => {
    const px = (value) => parseFloat(value) || 0;
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height
      };
    };
    const viewport = document.querySelector('#viewport'),
      vpStyle = getComputedStyle(viewport),
      host = element.parentElement,
      parent = host.parentElement,
      parentStyle = getComputedStyle(parent),
      dot = host.querySelector('.heading-dot'),
      input = element.querySelector('input'),
      text = input || element.querySelector('.home-copy-text'),
      style = getComputedStyle(element),
      textStyle = getComputedStyle(text),
      value = input ? input.value : text.textContent,
      graphemes = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value),
        (part) => part.segment
      ),
      context = document.createElement('canvas').getContext('2d');
    context.font = `${textStyle.fontStyle} ${textStyle.fontVariant} ${textStyle.fontWeight} ${textStyle.fontSize} ${textStyle.fontFamily}`;
    context.fontKerning = textStyle.fontKerning;
    const spacing = px(textStyle.letterSpacing),
      nativeSpacing = 'letterSpacing' in context;
    if (nativeSpacing) context.letterSpacing = textStyle.letterSpacing;
    const measuredWidth =
      context.measureText(value).width + (nativeSpacing ? 0 : spacing * Array.from(value).length);
    const range = document.createRange();
    if (!input) range.selectNodeContents(text);
    const lines = input
      ? []
      : Array.from(range.getClientRects(), (r) => ({
          top: r.top,
          bottom: r.bottom,
          width: r.width
        }));
    const fieldBox = rect(element),
      textBox = rect(text),
      inputAvailable = input
        ? input.clientWidth - px(textStyle.paddingLeft) - px(textStyle.paddingRight)
        : null,
      halfContent = (viewport.clientWidth - px(vpStyle.paddingLeft) - px(vpStyle.paddingRight)) / 2,
      parentAvailable =
        parent.clientWidth - px(parentStyle.paddingLeft) - px(parentStyle.paddingRight),
      dotWidth = dot
        ? dot.getBoundingClientRect().width +
          px(getComputedStyle(dot).marginLeft) +
          px(getComputedStyle(dot).marginRight)
        : 0;
    return {
      key: element.dataset.homeCopy,
      value,
      graphemes,
      editing: !!input,
      viewport: {
        clientWidth: viewport.clientWidth,
        paddingLeft: vpStyle.paddingLeft,
        paddingRight: vpStyle.paddingRight
      },
      halfContent,
      parentAvailable,
      dotWidth,
      available: Math.min(halfContent, parentAvailable - dotWidth),
      computedMaxWidth: style.maxWidth,
      computedMaxWidthPx: /^\d+(?:\.\d+)?px$/.test(style.maxWidth)
        ? parseFloat(style.maxWidth)
        : null,
      field: fieldBox,
      text: textBox,
      inputAvailable,
      measuredWidth,
      host: rect(host),
      hostLineHeight: px(getComputedStyle(host).lineHeight),
      hostVerticalPadding:
        px(getComputedStyle(host).paddingTop) + px(getComputedStyle(host).paddingBottom),
      dot: dot ? rect(dot) : null,
      rangeWidth: lines.length ? Math.max(...lines.map((line) => line.width)) : null,
      lineTops: Array.from(new Set(lines.map((line) => Math.round(line.top * 100) / 100))),
      lineHeight: px(textStyle.lineHeight),
      whiteSpace: style.whiteSpace,
      overflowX: style.overflowX,
      textOverflow: style.textOverflow,
      textWhiteSpace: textStyle.whiteSpace,
      textOverflowX: textStyle.overflowX,
      textTextOverflow: textStyle.textOverflow,
      font: context.font,
      letterSpacing: textStyle.letterSpacing,
      nativeCanvasLetterSpacing: nativeSpacing,
      maxLength: input?.maxLength,
      inputEvents: input?.__homeCopyAcceptanceInputs || []
    };
  });
}
function assertCopyGeometry(sample, { truncated = false } = {}) {
  const detail = JSON.stringify(sample);
  assert.ok(sample.field.width > 0 && sample.field.width <= sample.available + 1, detail);
  assert.ok(sample.field.width <= sample.halfContent + 1, detail);
  assert.notEqual(sample.computedMaxWidth, 'none', detail);
  if (sample.computedMaxWidthPx !== null)
    assert.ok(sample.computedMaxWidthPx <= sample.available + 1, detail);
  assert.ok(['nowrap', 'pre'].includes(sample.whiteSpace), detail);
  if (sample.hostLineHeight)
    assert.ok(
      sample.host.height <= sample.hostLineHeight + sample.hostVerticalPadding + 2,
      'Each heading row must occupy one line: ' + detail
    );
  if (sample.dot)
    assert.ok(
      sample.dot.right <= sample.host.right + 1 &&
        sample.dot.top < sample.field.bottom &&
        sample.dot.bottom > sample.field.top,
      'Title dot must remain on the same line: ' + detail
    );
  if (sample.editing) {
    assert.ok(sample.text.width <= sample.field.width + 1, detail);
    assert.ok(
      sample.measuredWidth + 12 <= sample.inputAvailable + 1,
      'Text and 12px caret must fit: ' + detail
    );
    if (sample.lineHeight) assert.ok(sample.text.height <= sample.lineHeight + 2, detail);
  } else {
    assert.equal(sample.lineTops.length, 1, detail);
    const ellipsis = sample.textOverflow === 'ellipsis' || sample.textTextOverflow === 'ellipsis';
    const clipped =
      ['hidden', 'clip'].includes(sample.overflowX) ||
      ['hidden', 'clip'].includes(sample.textOverflowX);
    assert.ok(ellipsis && clipped, 'Actual field/text must clip with ellipsis: ' + detail);
    if (truncated)
      assert.ok(
        sample.rangeWidth > sample.field.width + 1,
        'Long persisted text must actually overflow at the narrow size: ' + detail
      );
    else assert.ok(sample.rangeWidth <= sample.field.width + 1, detail);
  }
}
async function observeEditor(key) {
  await field(key).click();
  await expect(editor(key)).toBeFocused();
  await editor(key).evaluate((input) => {
    input.__homeCopyAcceptanceInputs = [];
    input.addEventListener('input', (event) =>
      input.__homeCopyAcceptanceInputs.push({
        type: event.type,
        inputType: event.inputType,
        isComposing: event.isComposing,
        trusted: event.isTrusted
      })
    );
  });
}
async function saveMeasuredCopy(key, method = 'Enter') {
  const before = await copyMetrics(key);
  assertCopyGeometry(before);
  if (method === 'blur') await page.locator('#search').click();
  else await editor(key).press('Enter');
  await settled();
  const value = await field(key).locator('.home-copy-text').textContent();
  assert.equal(value, before.value.replace(/[\u0000-\u0020\u007f]+/gu, ' ').trim());
  expectedCopy[key] = value;
  const database = await sqliteCopy();
  assert.deepEqual(database.value, expectedCopy);
  assert.deepEqual(await stored(), database.value);
  const display = await copyMetrics(key);
  assertCopyGeometry(display);
  return { method, before, display, database };
}
async function controlledPaste(key, value) {
  const prevented = await editor(key).evaluate((input, value) => {
    const data = new DataTransfer();
    data.setData('text/plain', value);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    });
    input.select();
    input.dispatchEvent(event);
    return event.defaultPrevented;
  }, value);
  // Untrusted paste has no browser default action. Native keyboard insertion delivers the real input event.
  if (!prevented) await page.keyboard.insertText(value);
  await frames();
  const sample = await copyMetrics(key);
  assert.ok(
    sample.inputEvents.length > 0,
    'Controlled paste must reach actual product input handlers'
  );
  return { prevented, sample };
}
(async () => {
  try {
    await check(
      'isolated real runtime imports generated PNGs through actual directory import IPC',
      async () => {
        await setup();
        await launch();
        await expectCopy();
        assert.equal((await rpc('init')).roots.length, 0);
        await rpc('settings', { key: 'watchChanges', value: false });
        await rpc('settings', { key: 'autoMatch', value: false });
        const imported = await rpc('import', {
          onlineMatch: false,
          subjectTypes: [4],
          directoryKind: 'work'
        });
        assert.equal(imported.root, idFor(collection));
        await page.evaluate(async () => {
          await loadSummary();
          await navigate({});
        });
        await settled();
        const initial = await rpc('init');
        assert.equal(initial.roots.length, 1);
        assert.ok(samePath(initial.roots[0].path, collection));
        assert.equal(initial.settings.watchChanges, false);
        assert.equal(initial.settings.autoMatch, false);
        const policy = await rpc('getRootMatchPolicy', { id: imported.root });
        assert.equal(policy.enabled, false);
        const probe = await app.evaluate(() => globalThis.__homePersonalization);
        assert.deepEqual(probe.picks, [collection]);
        await expect(page.locator('#category-overview .collection-tile')).toHaveCount(1);
        return { imported, policy, actual: report.runtime.actual };
      }
    );
    await check(
      publicBuild
        ? 'public default Chinese preset falls back and actual header/content spacing remains usable at 980/1600/4K'
        : 'default Chinese face is loaded and actual header/content spacing remains usable at 980/1600/4K',
      async () => {
        const font = await page.evaluate(async (allowFallback) => {
          await document.fonts.ready;
          let loaded = [],
            loadError = null;
          try {
            loaded = await document.fonts.load('400 16px "方正兰亭圆_GBK_中"', '我的相册');
          } catch (error) {
            if (!allowFallback) throw error;
            loadError = String(error);
          }
          return {
            family: getComputedStyle(document.querySelector('#page-title')).fontFamily,
            state: document.documentElement.dataset.fontState,
            loaded: loaded.map((face) => ({ family: face.family, status: face.status })),
            loadError,
            setting: S.settings.fontFamily || ''
          };
        }, publicBuild);
        assert.equal(font.setting, '');
        assert.ok(font.family.replace(/^["']/, '').startsWith('方正兰亭圆_GBK_中'));
        assert.equal(font.state, publicBuild ? 'fallback' : 'ready');
        if (publicBuild) assert.deepEqual(font.loaded, []);
        else
          assert.ok(
            font.loaded.length > 0 && font.loaded.every((face) => face.status === 'loaded')
          );
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('DOM.enable');
        await cdp.send('CSS.enable');
        const dom = await cdp.send('DOM.getDocument');
        const node = await cdp.send('DOM.querySelector', {
          nodeId: dom.root.nodeId,
          selector: '#page-title .home-copy-text'
        });
        const glyphs = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: node.nodeId });
        await cdp.detach();
        if (publicBuild) {
          assert.ok(
            glyphs.fonts.reduce((sum, item) => sum + item.glyphCount, 0) >= 4,
            JSON.stringify(glyphs)
          );
          assert.ok(
            glyphs.fonts.every((item) => !item.isCustomFont),
            JSON.stringify(glyphs)
          );
        } else
          assert.ok(
            glyphs.fonts.some(
              (item) =>
                /FZLanTingYuan-DB-GBK|方正兰亭圆_GBK_中/i.test(item.familyName) &&
                item.glyphCount >= 4
            ),
            JSON.stringify(glyphs)
          );
        report.font = { ...font, glyphs };
        for (const width of [980, 1600, 3840])
          for (const mode of ['compact', 'expanded'])
            for (const theme of ['light', 'dark']) {
              const native = await resize(width);
              await page.mouse.move(width - 100, 200);
              await page.evaluate(
                async ({ mode, theme }) => {
                  await saveSetting('sidebarMode', mode);
                  setSidebarOpen(mode === 'expanded');
                  await saveSetting('theme', theme);
                  $('#viewport').scrollTop = 0;
                },
                { mode, theme }
              );
              await settled();
              await page.waitForFunction((mode) => {
                const viewport = document.querySelector('#viewport'),
                  shell = document.querySelector('#sidebar-shell');
                const inset = (
                  getComputedStyle(shell)
                    .clipPath.split(/\s+round\s+/)[0]
                    .match(/-?[\d.]+/g) || []
                ).map(Number);
                return (
                  Math.abs(
                    viewport.getBoundingClientRect().left - (mode === 'expanded' ? 256 : 88)
                  ) < 0.75 &&
                  Math.abs((inset[1] ?? inset[0] ?? 0) - (mode === 'expanded' ? 0 : 168)) < 0.75
                );
              }, mode);
              const layout = await page.evaluate(() => {
                const rect = (element) => {
                  const r = element.getBoundingClientRect();
                  return {
                    left: r.left,
                    right: r.right,
                    top: r.top,
                    bottom: r.bottom,
                    width: r.width,
                    height: r.height
                  };
                };
                const shell = $('#sidebar-shell'),
                  vp = $('#viewport'),
                  style = getComputedStyle(vp),
                  clip = getComputedStyle(shell).clipPath,
                  numbers = clip.split(/\s+round\s+/)[0].match(/-?[\d.]+/g) || [];
                const shellRect = rect(shell),
                  visibleRight = shell.classList.contains('is-open')
                    ? shellRect.right
                    : shellRect.right - Number(numbers[1] ?? numbers[0] ?? 0);
                const contentLeft = vp.getBoundingClientRect().left + parseFloat(style.paddingLeft),
                  contentRight =
                    vp.getBoundingClientRect().left +
                    vp.clientWidth -
                    parseFloat(style.paddingRight);
                const labels = [
                  '.brand',
                  '.navigation',
                  '.search-wrap',
                  '.header-actions',
                  '#toolbar .toolbar-right'
                ].map((selector) => {
                  const element = $(selector),
                    r = rect(element);
                  return {
                    selector,
                    ...r,
                    scroll: element.scrollWidth,
                    client: element.clientWidth
                  };
                });
                const filters = $('.navigation .filter-tabs'),
                  filterStyle = getComputedStyle(filters),
                  texts = [
                    '.brand-text b',
                    '#search',
                    '.user-name',
                    '.filter-tabs button',
                    '.result-count',
                    '.sort-label'
                  ].map((selector) => {
                    const element = $(selector);
                    return element
                      ? {
                          selector,
                          font: getComputedStyle(element).fontSize,
                          display: getComputedStyle(element).display,
                          shadow: getComputedStyle(element).textShadow
                        }
                      : { selector, absent: true };
                  });
                const title = rect($('#page-title')),
                  controls = rect($('#toolbar .toolbar-right'));
                return {
                  width: innerWidth,
                  mode: shell.classList.contains('is-open') ? 'expanded' : 'compact',
                  theme: document.documentElement.dataset.theme,
                  contentLeft,
                  contentRight,
                  visibleRight,
                  gap: contentLeft - visibleRight,
                  rightGap: innerWidth - contentRight,
                  documentOverflow: document.documentElement.scrollWidth - innerWidth,
                  labels,
                  filters: {
                    ...rect(filters),
                    padding: filterStyle.padding,
                    shadow: filterStyle.boxShadow,
                    border: filterStyle.borderWidth,
                    font: getComputedStyle(filters.querySelector('button')).fontSize
                  },
                  texts,
                  title,
                  controls
                };
              });
              assert.ok(Math.abs(layout.gap - 16) <= 1, JSON.stringify(layout));
              assert.ok(Math.abs(layout.rightGap - 16) <= 1, JSON.stringify(layout));
              assert.ok(layout.documentOverflow <= 1);
              assert.ok(
                layout.labels.every(
                  (label) =>
                    label.left >= -1 && label.right <= width + 1 && label.scroll <= label.client + 2
                ),
                JSON.stringify(layout.labels)
              );
              assert.ok(
                layout.title.right <= layout.controls.left + 1,
                JSON.stringify({ title: layout.title, controls: layout.controls })
              );
              assert.ok((layout.filters.shadow.match(/inset/g) || []).length >= 2);
              assert.equal(layout.filters.font, '13px');
              assert.ok(Math.abs(layout.filters.height - 36) <= 1);
              for (const text of layout.texts) {
                assert.equal(text.absent, undefined, text.selector);
                const expectedSize =
                  text.selector === '.brand-text b'
                    ? width <= 1250
                      ? '14px'
                      : '15px'
                    : text.selector === '.result-count'
                      ? width <= 1050
                        ? '11px'
                        : '12px'
                      : '13px';
                assert.equal(text.font, expectedSize, JSON.stringify(text));
                if (text.shadow !== 'none') {
                  assert.equal(
                    (text.shadow.match(/rgba?\(/g) || []).length,
                    1,
                    JSON.stringify(text)
                  );
                  assert.ok(text.shadow.includes('0px 1px 2px'), JSON.stringify(text));
                }
              }
              const image = await shot(`layout_${width}_${mode}_${theme}`);
              report.samples.push({ type: 'layout', native, ...layout, image });
            }
        await resize(1600);
        await page.evaluate(async () => {
          await saveSetting('sidebarMode', 'compact');
          setSidebarOpen(false);
          await saveSetting('theme', 'light');
        });
        await settled();
        return { font: report.font, matrix: report.samples.length };
      }
    );
    await check(
      'all three editable fields keep inherited typography with a pink caret and internal underline; Enter and blur save Chinese',
      async () => {
        const edits = {
          eyebrow: '我的收藏 · 中文眉题',
          title: '林间相册',
          description: '把喜欢的照片留在本地，慢慢整理。'
        };
        const samples = [];
        for (const [key, value] of Object.entries(edits)) {
          const before = await field(key).evaluate((element) => ({
            font: getComputedStyle(element).fontFamily,
            size: getComputedStyle(element).fontSize
          }));
          await begin(key, value);
          const active = await editor(key).evaluate((input) => {
            const s = getComputedStyle(input),
              wrapper = getComputedStyle(input.parentElement),
              context = document.createElement('canvas').getContext('2d');
            context.fillStyle = s.getPropertyValue('--accent');
            context.fillRect(0, 0, 1, 1);
            const rgba = context.getImageData(0, 0, 1, 1).data,
              accent = `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
            return {
              caret: s.caretColor,
              accent,
              font: s.fontFamily,
              size: s.fontSize,
              inputShadow: s.boxShadow,
              outlineStyle: s.outlineStyle,
              outlineWidth: s.outlineWidth,
              borderWidth: s.borderWidth,
              underline: wrapper.boxShadow,
              background: wrapper.backgroundColor
            };
          });
          assert.equal(active.caret, active.accent);
          assert.equal(active.font, before.font);
          assert.equal(active.size, before.size);
          assert.equal(
            active.outlineStyle,
            'none',
            'Inline editing must use only the host underline'
          );
          assert.equal(active.outlineWidth, '0px');
          assert.equal(active.borderWidth, '0px');
          assert.ok(active.underline.includes('inset'));
          assert.notEqual(active.underline, 'none');
          await shot('editing_' + key);
          if (key === 'description') await page.locator('#search').click();
          else await editor(key).press('Enter');
          await settled();
          expectedCopy[key] = value;
          assert.equal((await stored())[key], value);
          await expect(field(key).locator('.home-copy-text')).toHaveText(value);
          samples.push({ key, before, active });
        }
        await expectCopy();
        return samples;
      }
    );
    await check(
      'Escape cancels, composition Enter does not submit, and markup is stored only as literal text',
      async () => {
        await begin('title', '取消后不能出现');
        await editor('title').press('Escape');
        await settled();
        await expectCopy();
        assert.equal((await stored()).title, expectedCopy.title);
        await begin('title', '输入法候选中');
        const composing = await editor('title').evaluate((input) => {
          input.dispatchEvent(
            new CompositionEvent('compositionstart', { bubbles: true, data: '输入法' })
          );
          const event = new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true
          });
          input.dispatchEvent(event);
          return { connected: input.isConnected, prevented: event.defaultPrevented };
        });
        assert.equal(composing.connected, true);
        assert.equal(composing.prevented, false);
        await expect(editor('title')).toBeVisible();
        assert.equal((await stored()).title, expectedCopy.title);
        await editor('title').evaluate((input) =>
          input.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true, data: '输入法候选中' })
          )
        );
        await editor('title').press('Enter');
        await settled();
        expectedCopy.title = '输入法候选中';
        assert.equal((await stored()).title, expectedCopy.title);
        const literal = '<img src=x onerror="window.__homeCopyInjected=1"> 中文 & <b>纯文本</b>';
        await commit('description', literal);
        assert.equal(await field('description').locator('img,b,script').count(), 0);
        assert.equal(await page.evaluate(() => window.__homeCopyInjected), undefined);
        assert.equal(await field('description').locator('.home-copy-text').textContent(), literal);
        await shot('literal_text_and_composition');
      }
    );
    await check(
      'queued concurrent edits merge against the latest successful SQLite state without losing either field',
      async () => {
        await installSaveGate('barrier');
        try {
          const eyebrow = '连续编辑 · 先保存眉题',
            title = '连续编辑的新标题';
          await begin('eyebrow', eyebrow);
          await editor('eyebrow').press('Enter');
          await expect.poll(async () => (await saveGateState()).entered).toBe(true);
          await begin('title', title);
          await editor('title').press('Enter');
          assert.equal(
            (await saveGateState()).calls.length,
            1,
            'Second write is queued behind the actual first IPC'
          );
          await releaseSaveGate();
          await settled();
          expectedCopy.eyebrow = eyebrow;
          expectedCopy.title = title;
          const copy = await stored();
          assert.equal(copy.eyebrow, eyebrow);
          assert.equal(copy.title, title);
          await expectCopy();
          const saves = (await saveGateState()).calls;
          assert.equal(saves.length, 2);
          assert.equal(saves[1].eyebrow, eyebrow);
          assert.equal(saves[1].title, title);
          report.samples.push({ type: 'serialized-save-barrier', saves });
        } finally {
          await restoreSaveGate();
        }
      }
    );
    await check(
      'a deliberate single settings rejection remains visible and retries through the real IPC without losing the draft',
      async () => {
        const previous = expectedCopy.description,
          retry = '保存失败后重试，文案保持完整。';
        await installSaveGate('failure');
        try {
          await begin('description', retry);
          await editor('description').press('Enter');
          await settled();
          await expect(field('description')).toHaveAttribute('aria-invalid', 'true');
          await expect(field('description').locator('.home-copy-text')).toHaveText(retry);
          assert.equal((await stored()).description, previous);
          await shot('expected_save_failure');
          await field('description').click();
          await expect(editor('description')).toHaveValue(retry);
          await editor('description').press('Enter');
          await settled();
          expectedCopy.description = retry;
          await expect(field('description')).not.toHaveAttribute('aria-invalid', 'true');
          assert.equal((await stored()).description, retry);
          await expectCopy();
          report.expectedFaults.push({
            boundary: 'main library:settings homeCopy IPC before actual worker',
            message: 'Generated one-shot homeCopy save failure',
            retryPersisted: true
          });
        } finally {
          await restoreSaveGate();
        }
      }
    );
    await check(
      'favorites, imported folders and search retain their own headings and home editing returns only at home',
      async () => {
        const homeCopy = await stored();
        const cases = [
          { view: 'favorites' },
          { parent: idFor(collection) },
          { search: 'generated' }
        ];
        const results = [];
        for (const target of cases) {
          await page.evaluate((target) => navigate(target), target);
          await settled();
          await expect(page.locator('[data-home-copy]')).toHaveCount(0);
          const before = await page.locator('#page-title').textContent();
          await page.locator('#page-title').click();
          await expect(page.locator('.home-copy-editor')).toHaveCount(0);
          assert.equal(await page.locator('#page-title').textContent(), before);
          assert.deepEqual(await stored(), homeCopy);
          results.push({ target, heading: before });
          await home();
          await expectCopy();
        }
        await shot('home_restored_after_other_pages');
        return results;
      }
    );
    await check(
      'root all/folders/images edits and real input/paste/composition obey single-line half-content limits at 980/1600 in light/dark without resize writes',
      async () => {
        const original = { ...expectedCopy },
          limits = { eyebrow: 120, title: 80, description: 240 },
          samples = [];
        await home();
        await resize(1600);
        // Values come from the actual navigation buttons: media is images, not media.
        for (const filter of ['all', 'folders', 'images']) {
          await page.locator(`.filter-tabs [data-filter="${filter}"]`).click();
          await page.waitForFunction((filter) => S.filter === filter, filter);
          await settled();
          const navigation = await page.evaluate(() => ({
            view: S.view,
            parent: S.parent,
            search: S.search,
            filter: S.filter
          }));
          assert.equal(navigation.view, 'library');
          assert.ok(!navigation.parent && !navigation.search, JSON.stringify(navigation));
          await expect(page.locator('[data-home-copy]')).toHaveCount(3);
          for (const [index, key] of Object.keys(limits).entries()) {
            await observeEditor(key);
            await editor(key).fill(
              `筛选${filter} · ${key === 'title' ? '标题' : key === 'eyebrow' ? '眉题' : '说明'}`
            );
            samples.push({
              type: 'root-filter-edit',
              navigation,
              key,
              ...(await saveMeasuredCopy(key, index % 2 ? 'blur' : 'Enter'))
            });
          }
        }
        for (const width of [980, 1600]) {
          await resize(width);
          for (const theme of ['light', 'dark']) {
            await page.evaluate(async (theme) => {
              await saveSetting('theme', theme);
              $('#viewport').scrollTop = 0;
            }, theme);
            await settled();
            assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
            assert.equal(await page.evaluate(() => S.filter), 'images');
            for (const [key, limit] of Object.entries(limits)) {
              const cases = [
                { kind: 'long-cjk', payload: '藏'.repeat(limit) },
                { kind: 'unbroken-english', payload: 'W'.repeat(limit) },
                {
                  kind: 'multiline-paste',
                  payload: '粘贴第一行 \n第二行文字 \r\n第三行结束 '.repeat(limit)
                },
                { kind: 'grapheme-boundaries', payload: '👩🏽‍💻e\u0301' + '藏'.repeat(limit - 9) }
              ];
              for (const [index, testCase] of cases.entries()) {
                let { kind, payload } = testCase;
                await observeEditor(key);
                if (kind === 'grapheme-boundaries') {
                  const budget = (await copyMetrics(key)).available - 12;
                  payload = await editor(key).evaluate(
                    (input, { budget, limit }) => {
                      const style = getComputedStyle(input),
                        context = document.createElement('canvas').getContext('2d');
                      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
                      context.letterSpacing = style.letterSpacing;
                      const cluster = '👩🏽‍💻e\u0301',
                        clusterWidth = context.measureText(cluster).width;
                      let prefix = '';
                      while (
                        context.measureText(prefix + '藏').width + clusterWidth / 2 <= budget &&
                        prefix.length < limit - cluster.length - 1
                      )
                        prefix += '藏';
                      return prefix + cluster + '藏'.repeat(limit);
                    },
                    { budget, limit }
                  );
                }
                const paste =
                  kind === 'multiline-paste' ? await controlledPaste(key, payload) : null;
                if (!paste) await editor(key).fill(payload);
                const input = await copyMetrics(key);
                assert.equal(
                  input.maxLength,
                  limit,
                  'Backend character ceiling remains represented by the actual editor'
                );
                assert.ok(input.inputEvents.length > 0, JSON.stringify(input));
                assert.ok(
                  input.value.length > 0 && input.value.length < payload.length,
                  'Long input must actually be truncated: ' + JSON.stringify(input)
                );
                assert.ok(!/[\r\n]/u.test(input.value), JSON.stringify(input));
                if (kind !== 'multiline-paste') {
                  const boundaries = await page.evaluate((payload) => {
                    let prefix = '';
                    return Array.from(
                      new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(payload),
                      (part) => (prefix += part.segment)
                    );
                  }, payload);
                  assert.ok(
                    boundaries.includes(input.value),
                    'Truncation must preserve complete graphemes: ' + JSON.stringify(input)
                  );
                }
                assertCopyGeometry(input);
                if (key === 'title' && kind === 'multiline-paste')
                  await shot(`paste_editor_${width}_${theme}_images`);
                const evidence = {
                  type: 'half-content-input',
                  width,
                  theme,
                  filter: 'images',
                  key,
                  kind,
                  payload,
                  pastePrevented: paste?.prevented,
                  ...(await saveMeasuredCopy(key, index % 2 ? 'blur' : 'Enter'))
                };
                samples.push(evidence);
                report.samples.push(evidence);
              }
            }
            await shot(`single_line_${width}_${theme}_images`);
          }
        }
        // Exercise IME candidates through the actual registered composition/input/key handlers.
        for (const key of Object.keys(limits)) {
          const payload = '候'.repeat(limits[key]);
          for (const finish of ['compositionend-enter', 'composing-blur']) {
            const beforeDatabase = await sqliteCopy();
            await observeEditor(key);
            const candidate = await editor(key).evaluate((input, payload) => {
              input.dispatchEvent(
                new CompositionEvent('compositionstart', { bubbles: true, data: '' })
              );
              input.value = payload;
              input.dispatchEvent(
                new InputEvent('input', {
                  bubbles: true,
                  inputType: 'insertCompositionText',
                  data: payload,
                  isComposing: true
                })
              );
              const enter = new KeyboardEvent('keydown', {
                key: 'Enter',
                keyCode: 229,
                isComposing: true,
                bubbles: true,
                cancelable: true
              });
              input.dispatchEvent(enter);
              return {
                value: input.value,
                connected: input.isConnected,
                focused: document.activeElement === input,
                prevented: enter.defaultPrevented
              };
            }, payload);
            assert.deepEqual(candidate, {
              value: payload,
              connected: true,
              focused: true,
              prevented: false
            });
            assert.deepEqual(await sqliteCopy(), beforeDatabase);
            const composing = await copyMetrics(key);
            assert.ok(
              composing.measuredWidth > composing.inputAvailable,
              'IME fixture must exceed the visual width'
            );
            let evidence;
            if (finish === 'compositionend-enter') {
              await editor(key).evaluate(
                (input, payload) =>
                  input.dispatchEvent(
                    new CompositionEvent('compositionend', { bubbles: true, data: payload })
                  ),
                payload
              );
              const ended = await copyMetrics(key);
              assert.ok(ended.value.length > 0 && ended.value.length < payload.length);
              assertCopyGeometry(ended);
              evidence = await saveMeasuredCopy(key);
            } else {
              // No synthetic compositionend: finish itself must constrain a pending candidate.
              await page.locator('#search').click();
              await settled();
              const display = await copyMetrics(key);
              assert.ok(display.value.length > 0 && display.value.length < payload.length);
              assertCopyGeometry(display);
              expectedCopy[key] = display.value;
              const database = await sqliteCopy();
              assert.deepEqual(database.value, expectedCopy);
              assert.deepEqual(await stored(), database.value);
              evidence = { method: 'blur-during-composition', display, database };
            }
            const sample = {
              type: 'composition-width',
              key,
              finish,
              payload,
              candidate,
              composing,
              ...evidence
            };
            samples.push(sample);
            report.samples.push(sample);
          }
        }
        // Persist at the wide size; only display clipping may change on a narrower resize.
        for (const theme of ['light', 'dark']) {
          await resize(1600);
          await page.evaluate((theme) => saveSetting('theme', theme), theme);
          await settled();
          const wide = [];
          for (const key of Object.keys(limits)) {
            await observeEditor(key);
            await editor(key).fill('宽'.repeat(limits[key]));
            wide.push({ key, ...(await saveMeasuredCopy(key)) });
          }
          const before = await sqliteCopy();
          await resize(980);
          const narrow = [];
          for (const key of Object.keys(limits)) {
            const sample = await copyMetrics(key);
            assert.equal(sample.value, before.value[key]);
            assertCopyGeometry(sample, { truncated: true });
            narrow.push(sample);
          }
          // Compare both the raw SQLite value and its parsed copy after the actual resize settles.
          assert.deepEqual(await sqliteCopy(), before);
          assert.deepEqual(await stored(), before.value);
          const image = await shot(`resize_ellipsis_980_${theme}_images`);
          const evidence = {
            type: 'resize-preserves-sqlite',
            theme,
            wide,
            narrow,
            database: before,
            image
          };
          samples.push(evidence);
          report.samples.push(evidence);
        }
        const restartBefore = await sqliteCopy();
        await closeApp();
        await launch();
        await home();
        await expectCopy();
        assert.deepEqual(await sqliteCopy(), restartBefore);
        assert.deepEqual(await stored(), restartBefore.value);
        const restartImage = await shot('restart_width_constrained_copy');
        samples.push({
          type: 'truncated-copy-restart',
          database: restartBefore,
          expected: { ...expectedCopy },
          image: restartImage
        });
        // Restore through real product saves, so the existing restart/fault/concurrency expectations remain authoritative.
        await resize(1600);
        await page.evaluate(async () => {
          await saveSetting('theme', 'light');
          await saveSetting('sidebarMode', 'compact');
          setSidebarOpen(false);
        });
        await page.locator('.filter-tabs [data-filter="all"]').click();
        await settled();
        for (const [key, value] of Object.entries(original))
          await commit(key, value, key === 'description' ? 'blur' : 'Enter');
        await expectCopy();
        assert.deepEqual((await sqliteCopy()).value, original);
        return {
          filters: ['all', 'folders', 'images'],
          dimensions: [980, 1600],
          themes: ['light', 'dark'],
          samples,
          restored: { ...expectedCopy }
        };
      }
    );
    await check(
      'actual app restart preserves all three edited fields in the same isolated SQLite profile',
      async () => {
        const before = await stored();
        await closeApp();
        await launch();
        await home();
        await expectCopy();
        assert.deepEqual(await stored(), before);
        assert.equal((await rpc('init')).roots.length, 1);
        await shot('restart_home_copy');
        return { expected: expectedCopy, persisted: before, actual: report.runtime.actual };
      }
    );
    assert.deepEqual(report.blockedNetwork, []);
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    process.exitCode = 1;
    report.failure = error.stack;
    if (!report.errors.some((item) => item.stack === error.stack))
      report.errors.push({ source: 'runner', message: error.message, stack: error.stack });
    console.error(error.stack);
    await shot('failure_final').catch(() => {});
  } finally {
    try {
      await closeApp();
    } catch (error) {
      report.passed = false;
      process.exitCode = 1;
      report.errors.push({ source: 'close', message: error.message, stack: error.stack });
    }
    if (report.blockedNetwork.length) {
      report.passed = false;
      process.exitCode = 1;
    }
    report.finished = new Date().toISOString();
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    }
  }
})();
