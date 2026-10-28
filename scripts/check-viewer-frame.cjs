'use strict';
// Lead runs this GUI check serially; do not run it alongside another GUI/build.
// Source: node scripts/check-viewer-frame.cjs
// Packaged: set ACG_EXECUTABLE to the actual built EXE before the same command.
// Only generated fixtures and a fresh profile below realpath(artifacts) are used.
// No product CSS/markup is injected. Only the OS-player boundary is intercepted.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');

const root = path.resolve(__dirname, '..');
const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const forbiddenViewerGL =
  '#viewer.liquid-glass-canvas, #viewer[data-liquid-glass-host], #viewer .liquid-glass-canvas, #viewer [data-liquid-glass-host]';
const report = {
  started: new Date().toISOString(),
  passed: false,
  scope:
    'Real source/packaged Electron, generated PNGs and actual encoded WebM; 980/1600 content widths, light/dark and saved liquidGlass on/off. Computed production material, screenshots, decoded media pixels, controls, navigation, zoom, native video frame and OS fallback. No personal media/profile or product-style injection.',
  node: { executable: process.execPath, version: process.version },
  runtime: { executable: null, isPackaged: null, version: null },
  checks: [],
  errors: [],
  consoleErrors: [],
  blockedNetwork: [],
  screenshots: [],
  samples: [],
  fixtures: []
};
let run, profile, collection, app, page;
const fixtures = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const find = (key) => {
  const item = fixtures.find((item) => item.key === key);
  assert.ok(item, 'Missing generated fixture: ' + key);
  return item;
};
function within(parent, file) {
  const relative = path.relative(parent, file);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative),
    'Path escapes isolated directory: ' + file
  );
}
function errorRecord(source, error) {
  return { source, message: error.message || String(error), stack: error.stack };
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function settle() {
  await page.waitForFunction(() => window.albumLiquidGlass.stats().pending === 0);
  await frames();
}
async function screenshot(name) {
  if (!page || page.isClosed()) return null;
  const file = path.join(run, name.replace(/[^a-z0-9_-]/gi, '_') + '.png');
  within(run, file);
  await page.screenshot({ path: file, scale: 'css', timeout: 10000 });
  report.screenshots.push(file);
  return file;
}
async function check(name, action) {
  const began = Date.now();
  let timer;
  try {
    const details = await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Viewer check timed out: ' + name)), 60000);
      })
    ]);
    report.checks.push({ name, passed: true, ms: Date.now() - began, details });
    console.log('PASS ' + name);
    return details;
  } catch (error) {
    report.checks.push({ name, passed: false, ms: Date.now() - began, error: error.message });
    report.errors.push(errorRecord(name, error));
    await screenshot('failure_' + report.checks.length).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function fixture(key, filename, bytes, extra = {}) {
  const file = path.join(collection, filename);
  within(run, file);
  await fs.writeFile(file, bytes, { flag: 'wx' });
  const item = { key, file, id: idFor(file), bytes: bytes.length, sha256: digest(bytes), ...extra };
  fixtures.push(item);
  report.fixtures.push(item);
  return item;
}
async function setup() {
  const archive = await fs.realpath(path.join(root, 'artifacts'));
  assert.ok(samePath(archive, 'C:\\ACG\\资料归档'), 'Unexpected artifacts realpath: ' + archive);
  const base = path.join(archive, 'viewer-frame-20261028', 'viewer_gui');
  await fs.mkdir(base, { recursive: true });
  assert.ok(samePath(await fs.realpath(base), base), 'Evidence base must be a real directory');
  run = path.join(base, new Date().toISOString().replace(/[:.]/g, '-') + '_' + randomUUID());
  await fs.mkdir(run);
  assert.ok(samePath(await fs.realpath(run), run));
  within(archive, run);
  profile = path.join(run, 'isolated_profile');
  collection = path.join(
    run,
    '仅生成验收素材 中文 #100% 空格 很长的路径用于确认底栏文本可以省略且不挤出工具控件'
  );
  for (const directory of [profile, collection]) {
    await fs.mkdir(directory);
    assert.ok(samePath(await fs.realpath(directory), directory));
    within(run, directory);
  }
  Object.assign(report, { run, archive, profile, collection });
  sharp.cache({ memory: 24, files: 0, items: 16 });
  sharp.concurrency(1);
  const width = 1200,
    height = 720;
  for (let index = 0; index < 2; index++) {
    const colors = index
      ? [
          [33, 183, 120],
          [196, 79, 147],
          [234, 174, 54],
          [52, 117, 214]
        ]
      : [
          [218, 74, 57],
          [54, 135, 218],
          [53, 172, 112],
          [226, 183, 54]
        ];
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let color = colors[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)];
        if (x >= 480 && x < 720 && y >= 270 && y < 450)
          color = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 ? [242, 242, 242] : [18, 18, 18];
        const at = (y * width + x) * 3;
        for (let channel = 0; channel < 3; channel++) pixels[at + channel] = color[channel];
      }
    const png = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
    await fixture(
      'image' + (index + 1),
      '0' + (index + 1) + ' 清晰色块与棋盘 #100% 很长的图片名称用于标题截断验证.png',
      png,
      { width, height, colors }
    );
  }
  await fixture(
    'unsupported',
    '99 仅生成的损坏视频用于真实系统播放器回退.wmv',
    Buffer.concat([Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'), Buffer.alloc(48)]),
    { video: true }
  );
  return { run, profile, collection, generated: fixtures.length };
}
async function seed() {
  // Disable network and watches before loading the unmodified real worker.
  const worker = new Worker(
    `
      const { workerData, parentPort } = require('node:worker_threads');
      const forbidden = (operation) => {
        parentPort.postMessage({ event: 'fixture:forbidden', data: operation });
        throw new Error('Viewer fixture worker forbids ' + operation);
      };
      globalThis.fetch = async () => forbidden('fetch');
      for (const name of ['node:http', 'node:https']) {
        const transport = require(name);
        transport.request = transport.get = () => forbidden(name);
      }
      require('node:fs').watch = () => forbidden('fs.watch');
      require(workerData.entry);
    `,
    {
      eval: true,
      workerData: {
        entry: path.join(root, 'src/library-worker.cjs'),
        dataDir: profile,
        watch: false,
        token: '',
        localIndexPath: path.join(run, 'absent_index.sqlite')
      }
    }
  );
  let serial = 0,
    readyResolve,
    readyReject,
    readyTimer;
  const waiting = new Map(),
    forbidden = [];
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    readyTimer = setTimeout(() => reject(new Error('Fixture worker ready timeout')), 30000);
  });
  function fail(error) {
    readyReject(error);
    for (const entry of waiting.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    waiting.clear();
  }
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0 || waiting.size) fail(new Error('Fixture worker exited: ' + code));
  });
  worker.on('message', (message) => {
    if (message.event === 'ready') {
      clearTimeout(readyTimer);
      readyResolve();
    }
    if (message.event === 'fixture:forbidden') forbidden.push(message.data);
    const entry = waiting.get(message.request);
    if (!entry) return;
    waiting.delete(message.request);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++serial;
      const timer = setTimeout(() => {
        waiting.delete(request);
        reject(new Error('Fixture worker RPC timeout: ' + method));
      }, 30000);
      waiting.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await ready;
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['liquidGlass', true],
      ['motionLevel', 'high'],
      ['theme', 'light'],
      ['sidebarMode', 'compact']
    ])
      await call('settings', { key, value });
    const scanned = await call('scan', {
      path: collection,
      onlineMatch: false,
      directoryKind: 'photo',
      offline: true
    });
    assert.equal(scanned.cancelled, false);
    assert.equal(scanned.errors, 0);
    const initial = await call('init');
    assert.equal(initial.roots.length, 1);
    assert.ok(samePath(initial.roots[0].path, collection));
    assert.equal(initial.settings.watchChanges, false);
    assert.equal(initial.settings.autoMatch, false);
    await call('shutdown');
    assert.deepEqual(forbidden, []);
    return { scanned, forbidden };
  } finally {
    clearTimeout(readyTimer);
    for (const entry of waiting.values()) clearTimeout(entry.timer);
    await worker.terminate();
  }
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const selectedExecutable = executable || require('electron');
  app = await _electron.launch({
    executablePath: selectedExecutable,
    args: executable ? [] : [root],
    cwd: executable ? path.dirname(executable) : root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(errorRecord('renderer pageerror', error)));
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.consoleErrors.push({
        text: message.text(),
        location: message.location(),
        beforeVideoDecoded: !report.samples.some((entry) => entry.item === 'video')
      });
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push({ source: 'renderer', url: route.request().url() });
    await route.abort();
  });
  report.runtime = await app.evaluate(
    ({ app, BrowserWindow, shell, net, session }, allowed) => {
      globalThis.__viewerFrameCheck = {
        shellCalls: [],
        shellFailure: '',
        blockedNetwork: [],
        allowed
      };
      // Real get/openMedia IPC remains intact; never launch an external application.
      shell.openPath = async (file) => {
        const state = globalThis.__viewerFrameCheck;
        if (!state.allowed.includes(file.toLowerCase()))
          throw new Error('Non-fixture OS path: ' + file);
        state.shellCalls.push({ path: file, failure: state.shellFailure });
        return state.shellFailure;
      };
      const original = net.fetch.bind(net);
      net.fetch = (input, ...args) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (/^https?:\/\//i.test(url)) {
          globalThis.__viewerFrameCheck.blockedNetwork.push(url);
          return Promise.reject(new Error('Public HTTP blocked by viewer frame check'));
        }
        return original(input, ...args);
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          globalThis.__viewerFrameCheck.blockedNetwork.push(details.url);
          callback({ cancel: true });
        }
      );
      const win = BrowserWindow.getAllWindows()[0];
      globalThis.__viewerFrameMainWindow = win;
      if (win.isMaximized()) win.unmaximize();
      win.show();
      win.focus();
      win.webContents.focus();
      return {
        executable: process.execPath,
        isPackaged: app.isPackaged,
        version: app.getVersion(),
        userData: app.getPath('userData'),
        versions: process.versions
      };
    },
    fixtures.map((item) => item.file.toLowerCase())
  );
  assert.ok(samePath(report.runtime.executable, selectedExecutable));
  assert.equal(report.runtime.isPackaged, !!executable);
  assert.ok(samePath(report.runtime.userData, path.join(profile, 'chromium-profile')));
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.loadVersion > 0 &&
      typeof openViewer === 'function' &&
      !!window.albumLiquidGlass
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__viewerFrameRejections = [];
    window.__viewerFrameNativeErrors = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__viewerFrameRejections.push(String(event.reason?.stack || event.reason))
    );
    const video = document.querySelector('#viewer-video');
    video.addEventListener('error', (event) => {
      window.__viewerFrameLastError = video.onerror;
      window.__viewerFrameNativeErrors.push({
        id: V.node?.id,
        trusted: event.isTrusted,
        code: video.error?.code,
        src: video.currentSrc || video.src
      });
    });
  });
  const initial = await rpc('init');
  assert.ok(samePath(initial.dataDir, profile));
  assert.equal(initial.roots.length, 1);
  assert.ok(samePath(initial.roots[0].path, collection));
  assert.equal(initial.settings.watchChanges, false);
  assert.equal(initial.settings.autoMatch, false);
  assert.equal(
    await page.evaluate(() =>
      [...document.styleSheets].some((sheet) => sheet.href?.endsWith('/viewer-frame.css'))
    ),
    true,
    'The actual application must load viewer-frame.css'
  );
  return report.runtime;
}
async function resize(width) {
  const height = width === 980 ? 760 : 1000;
  const native = await app.evaluate(
    ({ app }, size) => {
      const win = globalThis.__viewerFrameMainWindow;
      app.focus({ steal: true });
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
      win.show();
      win.focus();
      win.webContents.focus();
      return {
        content: win.getContentBounds(),
        visible: win.isVisible(),
        focused: win.isFocused()
      };
    },
    { width, height }
  );
  await page.bringToFront();
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    { width, height }
  );
  await settle();
  assert.equal(native.content.width, width);
  assert.equal(native.content.height, height);
  return native;
}
async function configure(theme, glass) {
  await page.evaluate(
    async ({ theme, glass }) => {
      await saveSetting('theme', theme);
      await saveSetting('liquidGlass', glass);
      window.albumLiquidGlass.refresh({ immediate: true });
    },
    { theme, glass }
  );
  await settle();
  const actual = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    glass: document.documentElement.dataset.liquidGlass,
    saved: S.settings.liquidGlass
  }));
  assert.equal(actual.theme, theme);
  assert.equal(actual.saved, glass);
  assert.equal(actual.glass, glass ? 'on' : 'off');
  return actual;
}
async function open(item) {
  await page.evaluate(async (id) => {
    const node = await window.album.call('get', { id });
    if (!node || node.missing) throw new Error('Missing viewer fixture ' + id);
    await openViewer(node, 0, true);
  }, item.id);
}
async function imageReady(item) {
  await page.waitForFunction((id) => {
    const image = document.querySelector('#viewer-image');
    return (
      document.querySelector('#viewer').open &&
      V.node?.id === id &&
      !image.hidden &&
      image.complete &&
      image.naturalWidth === 1200 &&
      image.naturalHeight === 720 &&
      document.querySelector('#viewer-loading').hidden &&
      document.querySelector('#viewer-video').hidden
    );
  }, item.id);
  await expect(page.locator('#viewer-path')).toHaveText(item.file);
  await settle();
}
async function closeViewer(key = 'Escape') {
  if (key === 'button') await page.locator('#viewer-close').click();
  else await page.keyboard.press(key);
  await page.waitForFunction(
    () => !document.querySelector('#viewer').open && viewerVideoTimer === null
  );
  // Native dialog close events are queued; finish them before reopening another item.
  await frames();
}
async function material() {
  return page.evaluate(() => {
    const viewer = document.querySelector('#viewer'),
      stage = document.querySelector('#viewer-stage');
    const bounds = (node) => node.getBoundingClientRect().toJSON();
    const styles = (node, pseudo = null) => {
      const s = getComputedStyle(node, pseudo);
      return {
        content: s.content,
        display: s.display,
        visibility: s.visibility,
        position: s.position,
        zIndex: s.zIndex,
        pointerEvents: s.pointerEvents,
        opacity: s.opacity,
        filter: s.filter,
        backdrop: s.backdropFilter,
        background: s.backgroundColor,
        image: s.backgroundImage,
        maskImage: s.maskImage,
        maskComposite: s.maskComposite,
        webkitMaskComposite: s.webkitMaskComposite,
        maskClip: s.maskClip,
        clipPath: s.clipPath,
        boxSizing: s.boxSizing,
        top: s.top,
        right: s.right,
        bottom: s.bottom,
        left: s.left,
        width: s.width,
        height: s.height,
        paddingTop: s.paddingTop,
        paddingRight: s.paddingRight,
        paddingBottom: s.paddingBottom,
        paddingLeft: s.paddingLeft,
        overflowX: s.overflowX,
        overflowY: s.overflowY,
        textOverflow: s.textOverflow,
        whiteSpace: s.whiteSpace,
        blend: s.mixBlendMode,
        transform: s.transform
      };
    };
    const all = [viewer, ...viewer.querySelectorAll('*')];
    const filtered = all.flatMap((node) => {
      const style = styles(node);
      return style.filter !== 'none' || style.backdrop !== 'none'
        ? [
            {
              id: node.id,
              className: node.getAttribute('class'),
              filter: style.filter,
              backdrop: style.backdrop
            }
          ]
        : [];
    });
    const controls = [
      ...viewer.querySelectorAll('.viewer-top,.viewer-bottom,.viewer-arrow,.viewer-top button')
    ]
      .filter((node) => !node.hidden && getComputedStyle(node).display !== 'none')
      .map((node) => ({
        id: node.id,
        className: node.className,
        bounds: bounds(node),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
        style: styles(node),
        before: styles(node, '::before'),
        after: styles(node, '::after')
      }));
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      bounds: bounds(viewer),
      stage: {
        bounds: bounds(stage),
        style: styles(stage),
        before: styles(stage, '::before'),
        after: styles(stage, '::after')
      },
      viewer: styles(viewer),
      before: styles(viewer, '::before'),
      after: styles(viewer, '::after'),
      media: ['#viewer-image', '#viewer-video'].map((selector) => {
        const node = document.querySelector(selector);
        return { selector, hidden: node.hidden, bounds: bounds(node), style: styles(node) };
      }),
      path: {
        text: document.querySelector('#viewer-path').textContent,
        bounds: bounds(document.querySelector('#viewer-path')),
        style: styles(document.querySelector('#viewer-path')),
        scrollWidth: document.querySelector('#viewer-path').scrollWidth,
        clientWidth: document.querySelector('#viewer-path').clientWidth
      },
      title: {
        bounds: bounds(document.querySelector('#viewer-name')),
        style: styles(document.querySelector('#viewer-name'))
      },
      hint: {
        bounds: bounds(document.querySelector('#viewer-hint')),
        style: styles(document.querySelector('#viewer-hint'))
      },
      headerGroups: [...viewer.querySelectorAll('.viewer-top > div')].map((node) => ({
        id: node.id,
        bounds: bounds(node)
      })),
      controls,
      filtered,
      displacementFilters: viewer.querySelectorAll('feDisplacementMap').length,
      canvas: viewer.querySelectorAll('.liquid-glass-canvas').length,
      hosts: [viewer, ...viewer.querySelectorAll('[data-liquid-glass-host]')].filter((node) =>
        node.hasAttribute('data-liquid-glass-host')
      ).length
    };
  });
}
function inside(inner, outer, label) {
  for (const edge of ['x', 'y'])
    assert.ok(inner[edge] >= outer[edge] - 1, label + ' starts inside ' + edge);
  assert.ok(inner.x + inner.width <= outer.x + outer.width + 1, label + ' fits horizontally');
  assert.ok(inner.y + inner.height <= outer.y + outer.height + 1, label + ' fits vertically');
  assert.ok(inner.width > 0 && inner.height > 0, label + ' has visible dimensions');
}
function pseudoPaints(style) {
  return (
    !['none', 'normal'].includes(style.content) &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) > 0 &&
    (style.image !== 'none' ||
      (style.background !== 'rgba(0, 0, 0, 0)' && style.background !== 'transparent') ||
      style.backdrop !== 'none')
  );
}
function validateMaterial(actual, item) {
  assert.equal(actual.canvas, 0, 'Viewer must have no GL canvas');
  assert.equal(actual.hosts, 0, 'Viewer and its controls must have no GL host');
  assert.deepEqual(
    actual.filtered,
    [],
    'Viewer, media, stage and controls have no filter/backdrop'
  );
  assert.equal(actual.displacementFilters, 0, 'Viewer must have no SVG refraction');
  const frame = actual.before;
  assert.ok(pseudoPaints(frame), 'viewer::before must paint a visible frame');
  assert.equal(frame.position, 'absolute');
  assert.equal(frame.pointerEvents, 'none', 'Frame must not catch controls or wheel events');
  assert.equal(frame.filter, 'none', 'Frame has no optical/refraction filter');
  assert.match(frame.backdrop, /blur\([\d.]+px\)/, 'Frame uses ordinary backdrop frost');
  assert.ok(parseFloat(frame.backdrop.match(/blur\(([\d.]+)px\)/)[1]) > 0);
  assert.doesNotMatch(frame.backdrop, /url\(/i);
  assert.match(frame.maskImage, /gradient/, 'Frame mask must define the clear center');
  assert.match(frame.maskClip, /content-box/, 'Frame mask uses its padded inner clear box');
  assert.match(frame.maskClip, /border-box/, 'Frame mask also includes the outer edge');
  assert.ok(
    /exclude/.test(frame.maskComposite) || /xor/.test(frame.webkitMaskComposite),
    'Frame mask subtracts its center'
  );
  const thickness = Object.fromEntries(
    ['Top', 'Right', 'Bottom', 'Left'].map((side) => [
      side.toLowerCase(),
      parseFloat(frame['padding' + side])
    ])
  );
  for (const [side, value] of Object.entries(thickness))
    assert.ok(value >= 4 && value < 160, 'Visible, restrained ' + side + ' frame thickness');
  for (const edge of ['top', 'right', 'bottom', 'left'])
    assert.ok(Math.abs(parseFloat(frame[edge])) <= 1, 'Frame reaches viewer ' + edge);
  assert.equal(
    pseudoPaints(actual.after),
    false,
    'No second viewer pseudo covers the clear center'
  );
  for (const pseudo of [actual.stage.before, actual.stage.after])
    assert.equal(pseudoPaints(pseudo), false, 'No stage pseudo covers media');
  inside(
    actual.bounds,
    { x: 0, y: 0, width: actual.viewport.width, height: actual.viewport.height },
    'Viewer'
  );
  inside(actual.stage.bounds, actual.bounds, 'Media stage');
  const media = actual.media.find((entry) => !entry.hidden);
  assert.ok(media, 'One actual medium must be visible');
  assert.equal(media.style.opacity, '1');
  assert.equal(media.style.blend, 'normal');
  inside(media.bounds, actual.stage.bounds, 'Fitted media');
  const hole = {
    x: actual.bounds.x + thickness.left,
    y: actual.bounds.y + thickness.top,
    width: actual.bounds.width - thickness.left - thickness.right,
    height: actual.bounds.height - thickness.top - thickness.bottom
  };
  inside(media.bounds, hole, 'Media lies entirely in the clear mask hole');
  for (const control of actual.controls) {
    inside(control.bounds, actual.bounds, control.id || control.className);
    assert.equal(
      control.style.backdrop,
      'none',
      'Controls have no independent frosted/glass material'
    );
    assert.equal(control.style.filter, 'none');
    assert.equal(
      pseudoPaints(control.before),
      false,
      'No independent GL-like control before layer'
    );
    assert.equal(pseudoPaints(control.after), false, 'No independent GL-like control after layer');
    if (control.id && control.id !== 'viewer-prev' && control.id !== 'viewer-next')
      assert.ok(
        control.scrollWidth <= control.clientWidth + 1,
        control.id + ' label does not overflow'
      );
  }
  for (const [label, entry] of [
    ['Path', actual.path],
    ['Title', actual.title],
    ['Hint', actual.hint]
  ])
    inside(entry.bounds, actual.bounds, label);
  assert.equal(actual.path.text, item.file);
  assert.equal(actual.path.style.whiteSpace, 'nowrap');
  assert.equal(actual.path.style.textOverflow, 'ellipsis');
  assert.ok(
    ['hidden', 'clip'].includes(actual.path.style.overflowX),
    'Long path is clipped within its own box'
  );
  assert.equal(actual.headerGroups.length, 2, 'Header retains separate metadata and action groups');
  for (const group of actual.headerGroups) inside(group.bounds, actual.bounds, 'Header group');
  assert.ok(
    actual.headerGroups[0].bounds.right <= actual.headerGroups[1].bounds.left + 1,
    'Long filename cannot overlap header controls'
  );
  assert.ok(
    actual.path.bounds.right <= actual.hint.bounds.left + 1,
    'Long full path cannot overlap bottom keyboard hint'
  );
  const buttons = actual.controls.filter(
    (control) => control.id && !['viewer-prev', 'viewer-next'].includes(control.id)
  );
  for (let index = 0; index < buttons.length; index++)
    for (let next = index + 1; next < buttons.length; next++) {
      const a = buttons[index].bounds,
        b = buttons[next].bounds;
      const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(
        overlap <= 1 || vertical <= 1,
        buttons[index].id + ' does not overlap ' + buttons[next].id
      );
    }
  return { thickness, hole, media };
}
async function screenshotPixels(file, actual, geometry, item) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, actual.viewport.width);
  assert.equal(info.height, actual.viewport.height);
  function pixel(x, y) {
    x = Math.max(0, Math.min(info.width - 1, Math.round(x)));
    y = Math.max(0, Math.min(info.height - 1, Math.round(y)));
    const at = (y * info.width + x) * info.channels;
    return { x, y, rgb: [...data.subarray(at, at + 3)] };
  }
  const { bounds } = geometry.media;
  const clear = [],
    checkerboard = [];
  if (!item.video) {
    for (const [index, point] of [
      [0, [0.2, 0.25]],
      [1, [0.8, 0.25]],
      [2, [0.2, 0.75]],
      [3, [0.8, 0.75]]
    ]) {
      const sample = pixel(bounds.x + bounds.width * point[0], bounds.y + bounds.height * point[1]);
      const expected = item.colors[index];
      const delta = Math.max(
        ...sample.rgb.map((value, channel) => Math.abs(value - expected[channel]))
      );
      clear.push({ ...sample, expected, delta });
      assert.ok(
        delta <= 4,
        'Actual media pixels remain clear and untinted: ' + JSON.stringify(clear.at(-1))
      );
    }
    for (const sourceY of [282, 294])
      for (const sourceX of [486, 498, 510, 522]) {
        const sample = pixel(
          bounds.x + (bounds.width * sourceX) / item.width,
          bounds.y + (bounds.height * sourceY) / item.height
        );
        const expected = (Math.floor(sourceX / 12) + Math.floor(sourceY / 12)) % 2 ? 242 : 18;
        const delta = Math.max(...sample.rgb.map((value) => Math.abs(value - expected)));
        checkerboard.push({ ...sample, sourceX, sourceY, expected, delta });
        assert.ok(
          delta <= 8,
          'Fine central checkerboard retains source contrast: ' +
            JSON.stringify(checkerboard.at(-1))
        );
      }
  }
  const stage = actual.stage.bounds;
  const reference = pixel(stage.x + 3, stage.y + 3);
  assert.ok(
    reference.x < bounds.x ||
      reference.y < bounds.y ||
      reference.x >= bounds.x + bounds.width ||
      reference.y >= bounds.y + bounds.height,
    'Frame reference is an exposed central gutter, not a media pixel'
  );
  const r = actual.bounds,
    t = geometry.thickness;
  const edges = [
    ['top', pixel(r.x + r.width / 2, r.y + Math.min(6, t.top / 3))],
    ['right', pixel(r.x + r.width - Math.min(6, t.right / 3), r.y + r.height * 0.25)],
    ['bottom', pixel(r.x + r.width / 2, r.y + r.height - Math.min(6, t.bottom / 3))],
    ['left', pixel(r.x + Math.min(6, t.left / 3), r.y + r.height * 0.25)]
  ].map(([side, sample]) => ({
    side,
    ...sample,
    deltaFromClearGutter: Math.max(
      ...sample.rgb.map((value, channel) => Math.abs(value - reference.rgb[channel]))
    )
  }));
  for (const edge of edges)
    assert.ok(
      edge.deltaFromClearGutter >= 2,
      'Actual screenshot has visible frost on ' +
        edge.side +
        ': ' +
        JSON.stringify({ edge, reference })
    );
  return { clear, checkerboard, reference, edges };
}
async function sample(name, item) {
  assert.equal(await page.locator(forbiddenViewerGL).count(), 0);
  const actual = await material();
  const entry = { name, item: item.key, actual };
  report.samples.push(entry);
  // Always retain the real screenshot even when a later style assertion fails.
  entry.screenshot = await screenshot(name);
  const geometry = validateMaterial(actual, item);
  entry.pixels = await screenshotPixels(entry.screenshot, actual, geometry, item);
  return {
    screenshot: entry.screenshot,
    pixels: entry.pixels,
    frame: actual.before,
    viewport: actual.viewport
  };
}
async function albumGlass(name) {
  await page.waitForFunction(() => !document.querySelector('#viewer').open);
  await page.evaluate(() => window.albumLiquidGlass.refresh({ immediate: true }));
  await page.waitForFunction(() => {
    const host = document.querySelector('.topbar > .search-wrap');
    const canvas = host.querySelector(':scope > .liquid-glass-canvas');
    return (
      host.hasAttribute('data-liquid-glass-host') &&
      canvas?.width > 0 &&
      canvas.height > 0 &&
      window.albumLiquidGlass.stats().gpu.status === 'webgl2'
    );
  });
  await settle();
  const state = await page.locator('.topbar > .search-wrap').evaluate((host) => {
    const canvas = host.querySelector(':scope > .liquid-glass-canvas');
    const context = canvas.getContext('2d');
    return {
      stats: window.albumLiquidGlass.stats(),
      host: host.getAttribute('data-liquid-glass-host'),
      backdrop: getComputedStyle(host).backdropFilter,
      center: [
        ...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1)
          .data
      ]
    };
  });
  assert.match(state.backdrop, /blur/);
  assert.ok(state.center[3] > 0, 'Main album still has actual optical canvas pixels');
  assert.equal(
    await page.locator(forbiddenViewerGL).count(),
    0,
    'Closed viewer is also outside GL'
  );
  await screenshot(name);
  return state;
}
async function navigationAndZoom() {
  const first = find('image1'),
    second = find('image2');
  await open(first);
  await imageReady(first);
  await page.locator('#viewer-next').click();
  await imageReady(second);
  await page.locator('#viewer-prev').click();
  await imageReady(first);
  await page.keyboard.press('ArrowRight');
  await imageReady(second);
  await page.keyboard.press('ArrowLeft');
  await imageReady(first);
  const before = await page.evaluate(() => ({
    scale: V.scale,
    width: document.querySelector('#viewer-image').getBoundingClientRect().width
  }));
  const stage = await page.locator('#viewer-stage').boundingBox();
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, -180);
  await page.waitForFunction(
    () => V.scale > 1 && document.querySelector('#viewer-stage').classList.contains('zoomed')
  );
  const zoomed = await page.evaluate(() => ({
    scale: V.scale,
    native: V.native,
    label: document.querySelector('#viewer-zoom').textContent,
    width: document.querySelector('#viewer-image').getBoundingClientRect().width
  }));
  assert.ok(
    zoomed.scale > before.scale && zoomed.width > before.width + 1,
    'Trusted wheel input really enlarges the image'
  );
  assert.match(zoomed.label, /%/);
  await page.locator('#viewer-fit').click();
  await page.waitForFunction(
    () => !V.native && !document.querySelector('#viewer-stage').classList.contains('zoomed')
  );
  assert.equal(await page.locator(forbiddenViewerGL).count(), 0);
  await closeViewer();
  await open(second);
  await imageReady(second);
  await closeViewer('button');
  return { arrowButtons: true, arrowKeys: true, before, zoomed, escape: true, closeButton: true };
}
async function generateWebM() {
  // Use the same real Chromium encoder pattern as check-media.cjs. A temporary
  // blank window has no product styles; destroy it before testing the viewer.
  const recordingWindow = app.waitForEvent('window', { timeout: 20000 });
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__viewerFrameMainWindow.hide();
    const win = new BrowserWindow({
      width: 480,
      height: 360,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    globalThis.__viewerFrameRecorder = win;
    win.loadURL('about:blank');
    win.focus();
  });
  let encoded;
  try {
    const recorderPage = await recordingWindow;
    await recorderPage.waitForLoadState();
    encoded = await recorderPage.evaluate(async () => {
      const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'].find(
        (type) => MediaRecorder.isTypeSupported(type)
      );
      if (!mimeType) throw new Error('No supported WebM MediaRecorder codec');
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      document.body.append(canvas);
      const context = canvas.getContext('2d', { willReadFrequently: true }),
        stream = canvas.captureStream(0),
        track = stream.getVideoTracks()[0],
        chunks = [];
      context.fillStyle = '#5d91c7';
      context.fillRect(0, 0, 320, 180);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 300000 });
      const finished = new Promise((resolve, reject) => {
        recorder.onerror = (event) =>
          reject(new Error(event.error?.message || 'MediaRecorder error'));
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onstop = async () => {
          try {
            const bytes = new Uint8Array(await new Blob(chunks, { type: mimeType }).arrayBuffer());
            let text = '';
            for (const byte of bytes) text += String.fromCharCode(byte);
            resolve({ base64: btoa(text), mimeType, frames: 15, width: 320, height: 180 });
          } catch (error) {
            reject(error);
          }
        };
      });
      try {
        const started = new Promise((resolve) => {
          recorder.onstart = resolve;
        });
        recorder.start();
        await started;
        for (let frame = 0; frame < 15; frame++) {
          context.fillStyle = frame % 2 ? '#5d91c7' : '#b35b87';
          context.fillRect(0, 0, 320, 180);
          context.fillStyle = '#f2dc9a';
          context.fillRect(frame * 16, 60, 48, 48);
          context.getImageData(0, 0, 1, 1);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          track.requestFrame();
          await new Promise((resolve) => setTimeout(resolve, 85));
        }
        recorder.stop();
        return await finished;
      } finally {
        if (recorder.state !== 'inactive') recorder.stop();
        stream.getTracks().forEach((entry) => entry.stop());
        canvas.remove();
      }
    });
  } finally {
    await app.evaluate(() => {
      globalThis.__viewerFrameRecorder?.destroy();
      delete globalThis.__viewerFrameRecorder;
      const win = globalThis.__viewerFrameMainWindow;
      win.show();
      win.focus();
      win.webContents.focus();
    });
    await page.bringToFront();
  }
  const bytes = Buffer.from(encoded.base64, 'base64');
  assert.ok(
    bytes.length > 1024 && bytes.length < 2 * 1024 * 1024,
    'WebM has actual encoded frames within a small fixture budget'
  );
  assert.equal(bytes.readUInt32BE(0), 0x1a45dfa3, 'Actual EBML container');
  const item = await fixture('video', '03 可播放生成短视频.webm', bytes, {
    video: true,
    width: encoded.width,
    height: encoded.height
  });
  // Renderer IPC exposes refresh by an existing root ID; raw scan is a
  // worker-only operation. The seeded root already has offline matching set.
  const scanned = await rpc('refresh', { id: idFor(collection) });
  assert.equal(scanned.cancelled, false);
  assert.equal(scanned.errors, 0);
  const node = await rpc('get', { id: item.id });
  assert.equal(node.kind, 'video');
  assert.ok(samePath(node.path, item.file));
  await page.evaluate(async () => {
    await loadSummary();
    await navigate({ parent: S.roots[0].id });
  });
  return {
    bytes: bytes.length,
    mimeType: encoded.mimeType,
    frames: encoded.frames,
    width: encoded.width,
    height: encoded.height,
    scanned
  };
}
const shellState = () => app.evaluate(() => globalThis.__viewerFrameCheck);
async function videoFrame(theme, glass, width) {
  const video = find('video');
  await resize(width);
  await configure(theme, glass);
  await open(video);
  await page.waitForFunction((id) => {
    const player = document.querySelector('#viewer-video');
    return (
      document.querySelector('#viewer').open &&
      V.node?.id === id &&
      !player.hidden &&
      player.readyState >= 2 &&
      player.videoWidth === 320 &&
      player.videoHeight === 180 &&
      !player.error &&
      document.querySelector('#viewer-loading').hidden
    );
  }, video.id);
  const decoded = await page.locator('#viewer-video').evaluate(async (player) => {
    player.muted = true;
    await player.play();
    const frame = await new Promise((resolve, reject) => {
      let handle;
      const timeout = setTimeout(() => {
        player.cancelVideoFrameCallback(handle);
        reject(new Error('No actual decoded video frame'));
      }, 8000);
      const capture = (_, metadata) => {
        if (metadata.mediaTime <= 0) {
          handle = player.requestVideoFrameCallback(capture);
          return;
        }
        clearTimeout(timeout);
        resolve({
          mediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          width: metadata.width,
          height: metadata.height
        });
      };
      handle = player.requestVideoFrameCallback(capture);
    });
    player.pause();
    return {
      width: player.videoWidth,
      height: player.videoHeight,
      time: player.currentTime,
      frames: player.getVideoPlaybackQuality().totalVideoFrames,
      controls: player.controls,
      readyState: player.readyState,
      frame
    };
  });
  assert.ok(decoded.frames > 0 && decoded.time > 0, 'Native player presented actual video frames');
  assert.equal(decoded.controls, true, 'Native video controls remain available');
  await settle();
  const style = await sample(
    'video_' + theme + '_' + width + '_glass_' + (glass ? 'on' : 'off'),
    video
  );
  assert.equal(
    (await shellState()).shellCalls.length,
    0,
    'Compatible video never hands off to the OS'
  );
  await open(find('image1'));
  await imageReady(find('image1'));
  const stopped = await page.locator('#viewer-video').evaluate((player) => ({
    paused: player.paused,
    hidden: player.hidden,
    source: player.getAttribute('src')
  }));
  assert.deepEqual(stopped, { paused: true, hidden: true, source: null });
  await closeViewer();
  return { decoded, style, stopped };
}
async function fallback(failure = '') {
  const item = find('unsupported');
  await app.evaluate((_, failure) => {
    globalThis.__viewerFrameCheck.shellFailure = failure;
  }, failure);
  const before = (await shellState()).shellCalls.length;
  const offset = await page.evaluate(() => window.__viewerFrameNativeErrors.length);
  await open(item);
  await page.waitForFunction(
    ({ id, offset }) =>
      window.__viewerFrameNativeErrors
        .slice(offset)
        .some((entry) => entry.id === id && entry.trusted && [2, 3, 4].includes(entry.code)),
    { id: item.id, offset }
  );
  await expect(page.locator('#viewer-loading')).toContainText(
    failure ? '系统播放器打开失败：' : '已交给系统默认播放器。'
  );
  if (failure) await expect(page.locator('#viewer-loading')).toContainText(failure);
  const state = await shellState();
  assert.equal(state.shellCalls.length, before + 1, 'One real native error makes one OS handoff');
  assert.ok(samePath(state.shellCalls.at(-1).path, item.file));
  assert.equal(state.shellCalls.at(-1).failure, failure);
  await page.evaluate(() => {
    window.__viewerFrameLastError?.();
    window.__viewerFrameLastError?.();
  });
  await frames();
  assert.equal(
    (await shellState()).shellCalls.length,
    before + 1,
    'Repeated callbacks cannot repeat handoff'
  );
  assert.equal(await page.locator(forbiddenViewerGL).count(), 0);
  await screenshot(failure ? 'video_os_failure' : 'video_os_handoff');
  await open(find('image2'));
  await imageReady(find('image2'));
  assert.equal((await shellState()).shellCalls.length, before + 1);
  await closeViewer();
  await app.evaluate(() => {
    globalThis.__viewerFrameCheck.shellFailure = '';
  });
  return {
    calls: state.shellCalls.slice(before),
    nativeErrors: await page.evaluate(
      (offset) => window.__viewerFrameNativeErrors.slice(offset),
      offset
    )
  };
}
async function main() {
  try {
    await check('isolated realpath, disposable bounded media fixtures and fresh profile', setup);
    console.log('Evidence: ' + run);
    await check('real offline worker seeds only generated files without network or watches', seed);
    await check('actual Electron executable, packaged state, version and isolated profile', launch);
    await check(
      'generate actual VP8/VP9 WebM and index through real application IPC',
      generateWebM
    );
    await resize(1600);
    await configure('light', true);
    await check('main album initially retains actual liquid-glass optical material', () =>
      albumGlass('album_before')
    );
    for (const width of [980, 1600])
      for (const theme of ['light', 'dark'])
        for (const glass of [true, false]) {
          await check(
            'image frame ' + theme + ' ' + width + ' root-glass ' + (glass ? 'on' : 'off'),
            async () => {
              const native = await resize(width);
              const settings = await configure(theme, glass);
              const item = find('image1');
              await open(item);
              await imageReady(item);
              const style = await sample(
                'image_' + theme + '_' + width + '_glass_' + (glass ? 'on' : 'off'),
                item
              );
              await closeViewer();
              assert.equal(await page.locator(forbiddenViewerGL).count(), 0);
              return { native, settings, style };
            }
          );
        }
    await check(
      'real arrow clicks/keys, wheel zoom, fit, Esc and close button remain usable',
      navigationAndZoom
    );
    for (const width of [980, 1600])
      for (const theme of ['light', 'dark'])
        for (const glass of [true, false])
          await check(
            'native decoded video frame ' +
              theme +
              ' ' +
              width +
              ' root-glass ' +
              (glass ? 'on' : 'off'),
            () => videoFrame(theme, glass, width)
          );
    await check('real unsupported-video native error retains single system-player fallback', () =>
      fallback()
    );
    await check('real system-player failure remains visible and image viewing recovers', () =>
      fallback('Viewer frame check simulated OS-player failure')
    );
    await configure('light', true);
    await resize(1600);
    await check('returning to the main album retains liquid glass outside the viewer', () =>
      albumGlass('album_after')
    );
    await check('generated originals retain their bytes', async () => {
      for (const item of fixtures) {
        within(run, item.file);
        assert.ok(samePath(await fs.realpath(item.file), item.file));
        assert.equal(
          digest(await fs.readFile(item.file)),
          item.sha256,
          'Original fixture changed: ' + item.key
        );
      }
      return { verified: fixtures.length };
    });
    await check(
      'no renderer errors, unhandled rejections or unexpected public network',
      async () => {
        await frames();
        const rejections = await page.evaluate(() => window.__viewerFrameRejections);
        const state = await shellState();
        report.shellCalls = state.shellCalls;
        report.nativeErrors = await page.evaluate(() => window.__viewerFrameNativeErrors);
        report.blockedNetwork.push(
          ...state.blockedNetwork.map((url) => ({ source: 'main/session', url }))
        );
        assert.equal(
          state.shellCalls.length,
          2,
          'Only two deliberate unsupported-video OS-boundary attempts'
        );
        assert.deepEqual(rejections, []);
        assert.deepEqual(report.blockedNetwork, []);
        assert.deepEqual(report.errors, []);
        // The invalid WMV has no thumbnail; the generated WebM has none until
        // its first decoded frame. Allow only those exact fixture thumbnail URLs
        // (the WebM only before playback), retaining every raw console entry.
        const unsupported = fixtures.find((item) => item.key === 'unsupported'),
          video = fixtures.find((item) => item.key === 'video');
        report.expectedConsoleErrors = report.consoleErrors.filter((entry) => {
          try {
            const url = new URL(entry.location.url);
            return (
              entry.text ===
                'Failed to load resource: the server responded with a status of 404 (Not Found)' &&
              url.protocol === 'acg-image:' &&
              url.hostname === 'thumb' &&
              (url.pathname === '/' + unsupported.id ||
                (url.pathname === '/' + video.id && entry.beforeVideoDecoded))
            );
          } catch {
            return false;
          }
        });
        assert.deepEqual(
          report.consoleErrors.filter((entry) => !report.expectedConsoleErrors.includes(entry)),
          []
        );
        assert.ok(
          report.expectedConsoleErrors.length <= 2,
          'No repeated missing-thumbnail retries'
        );
        return {
          rejections,
          shellCalls: state.shellCalls.length,
          expectedInvalidVideoThumbnail404s: report.expectedConsoleErrors.length
        };
      }
    );
  } catch (error) {
    if (!report.errors.some((entry) => entry.stack === error.stack))
      report.errors.push(errorRecord('fatal', error));
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        report.finalMainState = await shellState();
        report.finalGlass = await page.evaluate(() => window.albumLiquidGlass?.stats());
      } catch (error) {
        report.errors.push(errorRecord('collect final state', error));
      }
      try {
        await app.close();
      } catch (error) {
        report.errors.push(errorRecord('Electron shutdown', error));
      }
      app = null;
    }
    report.finished = new Date().toISOString();
    report.summary = {
      checks: report.checks.length,
      passed: report.checks.filter((entry) => entry.passed).length,
      failed: report.checks.filter((entry) => !entry.passed).length,
      errors: report.errors.length,
      screenshots: report.screenshots.length
    };
    report.unexpectedConsoleErrors = report.consoleErrors.filter(
      (entry) => !report.expectedConsoleErrors?.includes(entry)
    );
    report.passed =
      report.summary.checks > 0 &&
      report.summary.failed === 0 &&
      report.errors.length === 0 &&
      report.unexpectedConsoleErrors.length === 0 &&
      report.blockedNetwork.length === 0;
    if (!report.passed) process.exitCode = 1;
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + file);
      console.log(JSON.stringify(report.summary));
    } else console.error(JSON.stringify(report, null, 2));
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
