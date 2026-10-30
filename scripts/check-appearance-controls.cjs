'use strict';
// Lead runs serially. This checker creates only its own profiles, PNGs and evidence.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.resolve(
  process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\appearance-controls-20261030'
);
const executable = process.env.ACG_EXECUTABLE
  ? path.resolve(process.env.ACG_EXECUTABLE)
  : require('electron');
const packaged = !!process.env.ACG_EXECUTABLE;
const ranges = {
  liquidTransparency: { id: 'appearance-liquid-transparency', min: 0, max: 90, default: 18 },
  frostTransparency: { id: 'appearance-frost-transparency', min: 0, max: 90, default: 8 },
  cardRadius: { id: 'appearance-card-radius', min: 0, max: 36, default: 16 },
  density: { id: 'appearance-density', min: 120, max: 360, default: 222 }
};
// prettier-ignore
const report = {
  passed: false, started: new Date().toISOString(), checks: [], samples: [], screenshots: [], runtimes: [], errors: [], consoleErrors: [], blockedNetwork: [],
  scope: 'Real Electron UI, isolated profiles, generated local PNGs and actual import/settings/init RPCs. Real mouse and keyboard range input plus explicitly labelled synthetic 100-input/flush-edge stress. Directory picker is intercepted; public HTTP is denied. Worker postMessage/replies are observed and forwarded unchanged to count actual persistence RPCs; no product handler, CSS, candidate response, layout or settings implementation is replaced. Renderer hooks only observe contexts, shader compilation, native input and material events. CSS fallback is recorded and receives CSS-effect assertions; GPU-only assertions run only with actual WebGL2.'
};
let run, profile, collection, gallery, app, page;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const closeTo = (a, b, message, tolerance = 0.02) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
async function check(name, callback) {
  try {
    await callback();
    report.checks.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.message });
    throw error;
  }
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
function instrument() {
  const p = (window.__appearanceProbe = {
    contexts: [],
    losses: [],
    materialEvents: [],
    inputs: [],
    shaderFailures: [],
    unhandled: [],
    baseline: null
  });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = getContext.apply(this, args);
    if (args[0] === 'webgl2' && context && !p.contexts.includes(context)) {
      p.contexts.push(context);
      this.addEventListener('webglcontextlost', () => p.losses.push(performance.now()));
    }
    return context;
  };
  const compile = WebGL2RenderingContext.prototype.compileShader;
  WebGL2RenderingContext.prototype.compileShader = function (shader) {
    const result = compile.call(this, shader);
    if (!this.getShaderParameter(shader, this.COMPILE_STATUS))
      p.shaderFailures.push(this.getShaderInfoLog(shader));
    return result;
  };
  window.addEventListener('album-appearance-change', (event) =>
    p.materialEvents.push({ time: performance.now(), detail: event.detail })
  );
  window.addEventListener('unhandledrejection', (event) => p.unhandled.push(String(event.reason)));
  document.addEventListener(
    'input',
    (event) => {
      if (event.target.matches('[data-appearance-key]'))
        p.inputs.push({
          id: event.target.id,
          value: event.target.value,
          trusted: event.isTrusted,
          time: performance.now()
        });
    },
    true
  );
}
async function ensureActive() {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win.isVisible()) win.show();
    if (!win.isFocused()) win.focus();
    if (!win.webContents.isFocused()) win.webContents.focus();
  });
  await page.waitForFunction(
    () => !document.hidden && document.hasFocus() && !window.albumLiquidGlass.stats().inactive
  );
}
async function settle() {
  await ensureActive();
  await page.waitForFunction(() => !growingTask && growingTimer === null && !growingDirty);
  await page.waitForFunction(() => [...document.images].every((image) => image.complete));
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.allSettled(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
        .map((a) => a.finished)
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await expect.poll(() => page.evaluate(() => window.albumLiquidGlass.stats().pending)).toBe(0);
}
async function writes() {
  return app.evaluate(() => ({
    ...globalThis.__appearanceTransport.stats,
    records: [...globalThis.__appearanceTransport.stats.records]
  }));
}
async function settings() {
  return (await rpc('init')).settings;
}
async function persisted(key, value) {
  await expect.poll(async () => (await settings())[key], { timeout: 15000 }).toEqual(value);
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
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [root],
    cwd: packaged ? path.dirname(executable) : root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.stack || error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push({ source: 'renderer', url: route.request().url() });
    await route.abort();
  });
  const runtime = await app.evaluate(({ app, BrowserWindow, dialog, net, session }, collection) => {
    const blocked = (globalThis.__appearanceNetwork = []);
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
    const realFetch = net.fetch.bind(net);
    net.fetch = (input, ...args) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (!/^https?:/i.test(url)) return realFetch(input, ...args);
      blocked.push({ source: 'net.fetch', url });
      return Promise.reject(new Error('HTTP disabled by isolated appearance checker'));
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        blocked.push({ source: 'session', url: details.url });
        callback({ cancel: true });
      }
    );
    // Observe the real main -> library-worker settings RPC. Product handlers and messages stay intact.
    const Worker = process.mainModule.require('node:worker_threads').Worker;
    const send = Worker.prototype.postMessage,
      watched = new WeakSet(),
      pending = new Map();
    const stats = { records: [], inFlight: 0, maxInFlight: 0 };
    globalThis.__appearanceTransport = { stats };
    Worker.prototype.postMessage = function (message, ...args) {
      if (message?.method === 'settings') {
        if (!watched.has(this)) {
          watched.add(this);
          this.on('message', (reply) => {
            const record = pending.get(reply?.request);
            if (!record) return;
            record.completed = performance.now();
            record.error = reply.error || null;
            pending.delete(reply.request);
            stats.inFlight--;
          });
        }
        const record = {
          request: message.request,
          key: message.args?.key,
          value: message.args?.value,
          started: performance.now(),
          completed: null
        };
        pending.set(message.request, record);
        stats.records.push(record);
        stats.inFlight++;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      }
      return send.call(this, message, ...args);
    };
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 900);
    if (!win.isVisible()) win.show();
    if (!win.isFocused()) win.focus();
    if (!win.webContents.isFocused()) win.webContents.focus();
    return {
      executable: process.execPath,
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      version: app.getVersion()
    };
  }, collection);
  assert.ok(samePath(runtime.executable, executable));
  assert.equal(runtime.packaged, packaged);
  assert.ok(samePath(runtime.userData, path.join(profile, 'chromium-profile')));
  report.runtimes.push(runtime);
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && S.settings.metadataOnboardingSeen
  );
  const modal = page.locator('#modal');
  if (await modal.isVisible()) {
    await page.waitForSelector('#settings-panel-metadata:not([hidden])');
    await page.waitForFunction(() => document.activeElement?.id === 'token-input');
    await page.locator('#modal-close').click();
  }
  for (const [key, value] of [
    ['watchChanges', false],
    ['autoMatch', false],
    ['sidebarMode', 'expanded']
  ])
    await rpc('settings', { key, value });
  await page.addInitScript(instrument);
  await page.reload();
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.loadVersion > 0 &&
      window.albumAppearanceControls &&
      window.albumLiquidGlass
  );
  assert.ok(samePath((await rpc('init')).dataDir, profile));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle();
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  app = null;
  let timer;
  try {
    report.blockedNetwork.push(
      ...(await closing.evaluate(() => globalThis.__appearanceNetwork || []))
    );
  } finally {
    try {
      await Promise.race([
        closing.close(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Owned Electron close timed out')), 15000);
        })
      ]);
    } catch (error) {
      const child = closing.process();
      if (child?.exitCode === null && child.signalCode === null) child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
async function openAppearance() {
  if (!(await page.locator('#modal').isVisible())) await page.locator('#settings-button').click();
  await page.locator('#settings-tab-appearance').click();
  await expect(page.locator('#settings-panel-appearance')).toBeVisible();
  await settle();
}
async function closeModal() {
  if (await page.locator('#modal').isVisible()) await page.locator('#modal-close').click();
  await page.waitForSelector('#modal', { state: 'hidden' });
  await settle();
}
async function navigateGallery() {
  await closeModal();
  await page.evaluate((id) => navigate({ parent: id }), idFor(gallery));
  await expect(page.locator('#virtual-grid .media-card').first()).toBeVisible();
  await settle();
}
async function snapshot(label) {
  const sample = await page.evaluate((label) => {
    const root = document.documentElement,
      css = getComputedStyle(root),
      probe = window.__appearanceProbe;
    const style = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        alphaColor: s.backgroundColor,
        opacity: s.opacity,
        shadow: s.textShadow,
        radius: s.borderTopLeftRadius
      };
    };
    return {
      label,
      theme: root.dataset.theme,
      textShadow: root.dataset.textShadow,
      settings: Object.fromEntries(
        ['liquidTransparency', 'frostTransparency', 'cardRadius', 'density', 'textShadow'].map(
          (key) => [key, S.settings[key]]
        )
      ),
      tokens: Object.fromEntries(
        ['--liquid-opacity', '--frost-opacity', '--user-card-radius', '--card-width'].map((key) => [
          key,
          css.getPropertyValue(key).trim()
        ])
      ),
      sidebar: style('.sidebar-shell'),
      modal: style('#modal'),
      stats: window.albumLiquidGlass.stats(),
      materialEvents: probe.materialEvents.length,
      inputEvents: probe.inputs.length,
      contexts: probe.contexts.length,
      gl: probe.contexts.map((gl) => ({ error: gl.getError(), lost: gl.isContextLost() })),
      losses: probe.losses.length,
      shaderFailures: [...probe.shaderFailures],
      unhandled: [...probe.unhandled]
    };
  }, label);
  report.samples.push(sample);
  return sample;
}
function alpha(color) {
  const values = String(color)
    .match(/[\d.]+/g)
    ?.map(Number);
  assert.ok(values?.length >= 3, 'A computed material color must be readable: ' + color);
  return values.length === 4 ? values[3] : 1;
}
async function inputValue(key, value, event = 'input') {
  await page.locator('#' + ranges[key].id).evaluate(
    (input, { value, event }) => {
      input.value = String(value);
      input.dispatchEvent(new Event(event, { bubbles: true }));
    },
    { value, event }
  );
}
async function rangeByKeyboard(key, value) {
  const spec = ranges[key],
    input = page.locator('#' + spec.id);
  await input.scrollIntoViewIfNeeded();
  await input.focus();
  const current = Number(await input.inputValue());
  if (value === spec.min) await input.press('Home');
  else if (value === spec.max) await input.press('End');
  else {
    await input.press(current <= value ? 'End' : 'Home');
    const start = current <= value ? spec.max : spec.min;
    for (let i = 0; i < Math.abs(start - value); i++)
      await input.press(start > value ? 'ArrowLeft' : 'ArrowRight');
  }
  await expect(input).toHaveValue(String(value));
  await persisted(key, value);
  await settle();
}
async function dragRange(key, fraction, steps = 16) {
  const input = page.locator('#' + ranges[key].id);
  await input.scrollIntoViewIfNeeded();
  const box = await input.boundingBox();
  assert.ok(box && box.width > 50);
  await page.mouse.move(box.x + box.width * 0.22, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 9 + (box.width - 18) * fraction, box.y + box.height / 2, { steps });
  await frames();
  const preview = await page.evaluate(
    (id) => ({
      value: Number(document.getElementById(id).value),
      state: S.settings[document.getElementById(id).dataset.appearanceKey],
      output: document.getElementById(id + '-value').textContent
    }),
    ranges[key].id
  );
  assert.equal(preview.state, preview.value);
  assert.ok(
    preview.output.includes(String(preview.value)),
    'Live output follows mouse before release'
  );
  await page.mouse.up();
  await persisted(key, preview.value);
  await settle();
  return preview;
}
async function beginIdentity() {
  await page.evaluate(() => {
    const p = window.__appearanceProbe;
    p.baseline = {
      canvases: [...document.querySelectorAll('.liquid-glass-canvas')],
      contexts: [...p.contexts],
      lossCount: p.losses.length
    };
    p.baseline.owners = p.baseline.canvases.map((canvas) => ({
      canvas,
      host: canvas.parentElement,
      label: canvas.parentElement?.id || canvas.parentElement?.className
    }));
  });
}
async function assertIdentity(label) {
  const result = await page.evaluate(() => {
    const p = window.__appearanceProbe,
      old = p.baseline;
    return {
      oldCount: old.canvases.length,
      removed: old.owners
        .filter((row) => !row.canvas.isConnected)
        .map((row) => ({
          host: row.label,
          hostConnected: row.host.isConnected,
          hidden: row.host.hidden,
          rects: row.host.getClientRects().length,
          replacement: !!row.host.querySelector('.liquid-glass-canvas'),
          style: {
            visibility: getComputedStyle(row.host).visibility,
            opacity: getComputedStyle(row.host).opacity
          }
        })),
      canvasSame: old.canvases.every(
        (canvas) =>
          canvas.isConnected &&
          [...document.querySelectorAll('.liquid-glass-canvas')].includes(canvas)
      ),
      contextSame:
        old.contexts.length === p.contexts.length &&
        old.contexts.every((context, index) => context === p.contexts[index]),
      losses: p.losses.length - old.lossCount,
      gl: p.contexts.map((gl) => ({ error: gl.getError(), lost: gl.isContextLost() }))
    };
  });
  report.samples.push({ label, identity: result });
  assert.equal(
    result.canvasSame,
    true,
    label + ': existing canvases survive ' + JSON.stringify(result.removed)
  );
  assert.equal(result.contextSame, true, label + ': contexts survive');
  assert.equal(result.losses, 0);
  for (const gl of result.gl) {
    assert.equal(gl.error, 0);
    assert.equal(gl.lost, false);
  }
  report.samples.push({ label, identity: result });
}
async function densityEvidence(value) {
  await navigateGallery();
  await page.mouse.move(4, 4);
  await settle();
  await page.evaluate(() => {
    const viewport = document.querySelector('#viewport');
    const clearance = Math.max(
      0,
      document.querySelector('#toolbar').getBoundingClientRect().bottom -
        viewport.getBoundingClientRect().top +
        12
    );
    grid.restoreAnchor(42, clearance);
    grid.render();
  });
  await settle();
  const anchor = await page.evaluate(() => {
    const anchor = captureDisplayAnchor(),
      card = document.querySelector(`#virtual-grid [data-index="${anchor.index}"]`),
      viewport = document.querySelector('#viewport');
    return {
      ...anchor,
      domOffset: card.getBoundingClientRect().top - viewport.getBoundingClientRect().top
    };
  });
  assert.equal(anchor.kind, 'grid');
  assert.ok(anchor.index > 0);
  await page.locator('#density-button').click();
  await expect(page.locator('#display-density')).toBeVisible();
  await page.locator('#display-density').evaluate((input, value) => {
    input.value = String(value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await persisted('density', value);
  await closeModal();
  await page.mouse.move(4, 4);
  await settle();
  const sample = await page.evaluate(
    ({ value, anchor }) => {
      const viewport = document.querySelector('#viewport'),
        el = document.querySelector('#virtual-grid'),
        rect = el.getBoundingClientRect();
      const cards = [...el.querySelectorAll('.album-card')].map((card) => ({
        index: Number(card.dataset.index),
        rect: card.getBoundingClientRect().toJSON(),
        cover: card.querySelector('.cover-shell').getBoundingClientRect().toJSON()
      }));
      const anchored = el.querySelector(`[data-index="${anchor.index}"]`);
      return {
        label: 'density-' + value,
        value,
        count: cards.length,
        rect: rect.toJSON(),
        cards,
        viewport: {
          left: viewport.getBoundingClientRect().left,
          right: viewport.getBoundingClientRect().right,
          scrollWidth: viewport.scrollWidth,
          clientWidth: viewport.clientWidth,
          scrollTop: viewport.scrollTop
        },
        anchor,
        anchoredTop: anchored?.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
        positions: cards.map((card) => ({ index: card.index, ...grid.getPosition(card.index) }))
      };
    },
    { value, anchor }
  );
  assert.ok(sample.count >= 3);
  assert.ok(
    sample.viewport.scrollWidth <= sample.viewport.clientWidth + 1,
    'No horizontal viewport overflow'
  );
  report.samples.push({
    ...sample,
    anchorDrift: sample.anchoredTop - anchor.domOffset,
    anchorToleranceCssPx: 3
  });
  // Native focus scrolling and fractional masonry rows quantize the scroll offset.
  closeTo(
    sample.anchoredTop,
    anchor.domOffset,
    'Density preserves the actual visible anchor offset',
    3
  );
  const byIndex = new Map(sample.cards.map((card) => [card.index, card]));
  for (const pos of sample.positions) {
    const card = byIndex.get(pos.index);
    closeTo(card.rect.left - sample.rect.left, pos.left, 'Actual left follows grid geometry', 1);
    closeTo(card.rect.top - sample.rect.top, pos.top, 'Actual top follows grid geometry', 1);
    assert.ok(
      card.rect.left >= sample.rect.left - 1 && card.rect.right <= sample.rect.right + 1,
      'Every card stays inside grid'
    );
    closeTo(card.cover.left, card.rect.left, 'Cover aligns to card left', 1);
  }
  const columns = [...new Set(sample.positions.map((pos) => Math.round(pos.left)))].sort(
    (a, b) => a - b
  );
  closeTo(columns[0], 0, 'First column starts at grid left', 1);
  const rowTops = new Map();
  for (const card of sample.cards) {
    const row = Math.round(card.rect.top);
    const values = rowTops.get(row) || [];
    values.push(card);
    rowTops.set(row, values);
  }
  assert.ok(
    [...rowTops.values()].some((row) => row.length >= 2),
    'Uniform fixtures share aligned row tops'
  );
  report.samples.push(sample);
  await shot('grid-density-' + value);
}
async function radiusEvidence() {
  const sample = [];
  for (const [label, args, selectors] of [
    [
      'media',
      { parent: idFor(gallery) },
      ['.media-card', '.media-card .cover-shell', '.media-card .cover-shell img']
    ],
    ['album', { parent: idFor(collection) }, ['.album-card', '.album-card .cover-shell']],
    ['collection', {}, ['.collection-tile', '.collection-image']]
  ]) {
    await page.evaluate((args) => navigate(args), args);
    await settle();
    for (const selector of selectors) {
      await expect(page.locator(selector).first()).toBeVisible();
      const values = await page.locator(selector).evaluateAll((elements) =>
        elements.map((el) => {
          const s = getComputedStyle(el);
          return [
            s.borderTopLeftRadius,
            s.borderTopRightRadius,
            s.borderBottomRightRadius,
            s.borderBottomLeftRadius
          ];
        })
      );
      assert.ok(values.length > 0);
      for (const row of values)
        for (const radius of row)
          closeTo(parseFloat(radius), 0, label + ' whole card/cover has square corners');
      sample.push({ label, selector, values });
    }
    await shot('radius-zero-' + label);
  }
  report.samples.push({ label: 'zero-radius-all-surface-types', rows: sample });
}
async function shadowSample(expected) {
  await navigateGallery();
  await openAppearance();
  const required = ['#virtual-grid .card-title', '#settings-panel-appearance .setting-row p'];
  const sample = await page.evaluate(
    (selectors) => ({
      root: document.documentElement.dataset.textShadow,
      rows: selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((el) => el.getClientRects().length)
          .slice(0, 5)
          .map((el) => ({ selector, shadow: getComputedStyle(el).textShadow }))
      )
    }),
    [...required, '#search', '.sidebar-label', '#settings-panel-appearance label']
  );
  assert.equal(sample.root, expected ? 'on' : 'off');
  for (const selector of required)
    assert.ok(
      sample.rows.some((row) => row.selector === selector),
      selector + ' is present for the shadow check'
    );
  const verify = (rows) => {
    assert.ok(rows.length);
    for (const row of rows) {
      if (expected)
        assert.notEqual(row.shadow, 'none', row.selector + ': on applies a real text shadow');
      else assert.equal(row.shadow, 'none', row.selector + ': off clears the old text shadow');
    }
  };
  verify(sample.rows);
  await closeModal();
  // Radius/density cases leave unrelated saved scroll positions in this generated gallery.
  await page.evaluate(() => {
    grid.restoreAnchor(0, 0);
    grid.render();
  });
  await settle();
  await shot('text-shadow-' + expected + '-grid');
  const point = await page.evaluate(() => {
    const viewport = document.querySelector('#viewport').getBoundingClientRect();
    const top = Math.max(
      viewport.top,
      document.querySelector('#toolbar').getBoundingClientRect().bottom
    );
    const card = [...document.querySelectorAll('#virtual-grid .media-card')].find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom > top + 24 && rect.top < viewport.bottom - 24;
    });
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { x: rect.left + Math.min(24, rect.width / 2), y: Math.max(rect.top, top) + 12 };
  });
  assert.ok(point, 'A real media card is available to open the viewer');
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('#viewer[open]')).toBeVisible();
  await expect(page.locator('#viewer-image')).toBeVisible();
  const viewerRows = await page.evaluate(() =>
    ['#viewer-name', '#viewer-position', '#viewer-path', '#viewer-hint'].map((selector) => {
      const el = document.querySelector(selector);
      return {
        selector,
        present: !!el?.getClientRects().length,
        text: el?.textContent,
        shadow: el ? getComputedStyle(el).textShadow : null
      };
    })
  );
  for (const row of viewerRows)
    assert.ok(row.present && row.text, row.selector + ' is visible with actual viewer content');
  verify(viewerRows);
  await shot('text-shadow-' + expected + '-viewer');
  await page.locator('#viewer-close').click();
  await page.waitForSelector('#viewer', { state: 'hidden' });
  report.samples.push({ label: 'text-shadow-' + expected, ...sample, viewerRows });
  await openAppearance();
}
async function iconsAndReadability(theme) {
  const sample = await page.evaluate((theme) => {
    const selectors = ['#settings-button svg', '#local-search-button svg', '#density-button svg'];
    const icons = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)].map((el) => {
        const clone = el.cloneNode(true);
        for (const node of [clone, ...clone.querySelectorAll('*')]) {
          node.removeAttribute('color');
          node.style?.removeProperty('color');
          if (!node.getAttribute('style')) node.removeAttribute('style');
        }
        const s = getComputedStyle(el);
        return {
          selector,
          shape: clone.outerHTML,
          color: s.color,
          width: s.width,
          height: s.height,
          strokeWidth: s.strokeWidth,
          opacity: s.opacity,
          filter: s.filter
        };
      })
    );
    const panel = document.querySelector('#settings-panel-appearance'),
      scrollbar = getComputedStyle(panel, '::-webkit-scrollbar'),
      thumb = getComputedStyle(panel, '::-webkit-scrollbar-thumb');
    return {
      label: 'readability-' + theme,
      theme,
      icons,
      placeholder: getComputedStyle(document.querySelector('#search'), '::placeholder').color,
      scrollbar: {
        width: scrollbar.width,
        height: scrollbar.height,
        color: thumb.backgroundColor,
        border: thumb.borderLeftWidth,
        clip: thumb.backgroundClip
      },
      panel: { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight }
    };
  }, theme);
  assert.ok(sample.icons.length >= 2);
  assert.equal(sample.placeholder, theme === 'dark' ? 'rgb(152, 147, 160)' : 'rgb(114, 111, 121)');
  assert.equal(sample.scrollbar.width, '6px');
  assert.equal(sample.scrollbar.height, '6px');
  assert.equal(
    sample.scrollbar.color,
    theme === 'dark' ? 'rgb(184, 121, 160)' : 'rgb(201, 130, 166)'
  );
  assert.equal(sample.scrollbar.border, '1px');
  assert.equal(sample.scrollbar.clip, 'padding-box');
  report.samples.push(sample);
  return sample;
}
async function themeScreenshots(theme) {
  await navigateGallery();
  await page.evaluate((theme) => changeTheme(theme), theme);
  await openAppearance();
  await page.locator('#settings-panel-appearance').evaluate((panel) => {
    panel.scrollTop = 0;
  });
  await settle();
  const top = await iconsAndReadability(theme);
  await shot(theme + '-appearance-top');
  await page.locator('#settings-panel-appearance').evaluate((panel) => {
    panel.scrollTop = panel.scrollHeight;
  });
  await settle();
  await shot(theme + '-appearance-bottom');
  await closeModal();
  await shot(theme + '-grid-modal-closed');
  return top;
}
async function fixture() {
  run = path.join(
    stage,
    'gui-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID()
  );
  profile = path.join(run, 'profile');
  collection = path.join(run, 'generated-library');
  gallery = path.join(collection, '统一比例画册');
  await fs.mkdir(gallery, { recursive: true });
  for (const [name, count] of [
    ['统一比例画册', 84],
    ['辅助相册甲', 6],
    ['辅助相册乙', 6]
  ]) {
    const directory = path.join(collection, name);
    await fs.mkdir(directory, { recursive: true });
    for (let i = 0; i < count; i++) {
      const image = await sharp({
        create: {
          width: 240,
          height: 320,
          channels: 3,
          background: { r: 94 + (i % 7) * 14, g: 105 + (i % 9) * 10, b: 155 + (i % 5) * 17 }
        }
      })
        .png()
        .toBuffer();
      await fs.writeFile(
        path.join(directory, '画面-' + String(i).padStart(3, '0') + '.png'),
        image
      );
    }
  }
  report.run = run;
  report.profile = profile;
  console.log('ISOLATED ' + run);
}
(async () => {
  await fixture();
  await launch();
  await check(
    'fresh defaults, range/reset contracts and actual 96-PNG offline import',
    async () => {
      await openAppearance();
      for (const [key, range] of Object.entries(ranges)) {
        const input = page.locator('#' + range.id);
        await expect(input).toHaveAttribute('min', String(range.min));
        await expect(input).toHaveAttribute('max', String(range.max));
        await expect(input).toHaveValue(String(range.default));
        const reset = page.locator(`#settings-panel-appearance [data-appearance-reset="${key}"]`);
        await expect(reset).toHaveAttribute('title', '恢复默认值');
        await expect(reset).toHaveAttribute('aria-label', '恢复默认值');
        assert.equal((await settings())[key], range.default);
      }
      await expect(page.locator('#appearance-text-shadow')).not.toBeChecked();
      assert.equal((await settings()).textShadow, false);
      await closeModal();
      const imported = await rpc('import', { onlineMatch: false });
      assert.equal(imported.cancelled, false);
      assert.equal(imported.errors, 0);
      assert.equal((await rpc('get', { id: imported.root })).files, 96);
      report.imported = { root: imported.root, files: 96 };
      await navigateGallery();
      // Import completion intentionally hides its panel after six seconds.
      // Wait for that lifecycle edge before measuring slider canvas identity.
      await expect(page.locator('#progress-panel')).toBeHidden({ timeout: 15000 });
      await settle();
    }
  );
  await check('real mouse drag and trusted keyboard preview for all four ranges', async () => {
    await openAppearance();
    await beginIdentity();
    for (const key of Object.keys(ranges)) {
      const value = await dragRange(key, 0.66);
      report.samples.push({ label: 'real-drag-' + key, ...value });
      const input = page.locator('#' + ranges[key].id);
      await input.focus();
      const prior = Number(await input.inputValue());
      await input.press(prior < ranges[key].max ? 'ArrowRight' : 'ArrowLeft');
      const next = Number(await input.inputValue());
      assert.notEqual(next, prior);
      await persisted(key, next);
    }
    const trusted = await page.evaluate(() =>
      window.__appearanceProbe.inputs.filter((row) => row.trusted)
    );
    for (const range of Object.values(ranges))
      assert.ok(
        trusted.some((row) => row.id === range.id),
        range.id + ' has actual native input'
      );
    await assertIdentity('native-range-drags');
  });
  await check(
    'independent liquid/frost effects, no scene upload and no replacement canvas',
    async () => {
      await openAppearance();
      await settle();
      await page.locator('#appearance-liquid-transparency').scrollIntoViewIfNeeded();
      await settle();
      await beginIdentity();
      const before = await snapshot('material-before');
      await rangeByKeyboard('liquidTransparency', 0);
      const opaque = await snapshot('liquid-opaque');
      await rangeByKeyboard('liquidTransparency', 90);
      const clear = await snapshot('liquid-clear');
      closeTo(Number(opaque.tokens['--liquid-opacity']), 1, 'Zero transparency opacity');
      closeTo(Number(clear.tokens['--liquid-opacity']), 0.1, 'Ninety transparency opacity');
      assert.ok(
        alpha(opaque.sidebar.alphaColor) > alpha(clear.sidebar.alphaColor) + 0.2,
        'Liquid slider visibly changes sidebar body alpha'
      );
      closeTo(
        alpha(opaque.modal.alphaColor),
        alpha(clear.modal.alphaColor),
        'Liquid does not alter frost body'
      );
      assert.ok(clear.stats.materialChanges > before.stats.materialChanges);
      assert.ok(clear.stats.materialReads > before.stats.materialReads);
      if (clear.stats.gpu.status === 'webgl2') {
        assert.ok(
          clear.stats.gpu.draws > before.stats.gpu.draws,
          'Liquid uniform change dirties real GPU hosts'
        );
        assert.equal(clear.stats.sceneBuilds, before.stats.sceneBuilds);
        assert.equal(clear.stats.gpu.uploads, before.stats.gpu.uploads);
      }
      await rangeByKeyboard('frostTransparency', 0);
      const solidFrost = await snapshot('frost-opaque');
      await rangeByKeyboard('frostTransparency', 90);
      const clearFrost = await snapshot('frost-clear');
      closeTo(Number(solidFrost.tokens['--frost-opacity']), 1, 'Zero frost transparency');
      closeTo(Number(clearFrost.tokens['--frost-opacity']), 0.1, 'Ninety frost transparency');
      assert.ok(
        alpha(solidFrost.modal.alphaColor) > alpha(clearFrost.modal.alphaColor) + 0.2,
        'Frost slider changes computed dialog body alpha'
      );
      closeTo(
        alpha(solidFrost.sidebar.alphaColor),
        alpha(clearFrost.sidebar.alphaColor),
        'Frost does not alter liquid body'
      );
      if (clearFrost.stats.gpu.status === 'webgl2')
        assert.equal(
          clearFrost.stats.gpu.draws,
          solidFrost.stats.gpu.draws,
          'Frost CSS adjustment does not redraw liquid GPU'
        );
      await assertIdentity('independent-transparency');
    }
  );
  await check(
    '100 synthetic input events coalesce preview and actual persistence RPCs; unchanged apply emits nothing',
    async () => {
      await openAppearance();
      await page.locator('#appearance-liquid-transparency').scrollIntoViewIfNeeded();
      await settle();
      const before = await snapshot('burst-before'),
        sentBefore = (await writes()).records.length;
      await beginIdentity();
      await page.evaluate(() => {
        const input = document.querySelector('#appearance-liquid-transparency');
        for (let i = 0; i < 100; i++) {
          input.value = String(i % 89);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await frames();
      const preview = await snapshot('burst-after-frame');
      assert.equal(preview.settings.liquidTransparency, 10);
      assert.equal(preview.inputEvents - before.inputEvents, 100);
      assert.ok(
        preview.materialEvents - before.materialEvents <= 1,
        'One frame applies only the latest 100-input value'
      );
      await persisted('liquidTransparency', 10);
      const burst = (await writes()).records
        .slice(sentBefore)
        .filter((row) => row.key === 'liquidTransparency');
      assert.ok(
        burst.length >= 1 && burst.length <= 2,
        '100 input events produce at most two persistence RPCs'
      );
      assert.equal(burst.at(-1).value, 10);
      report.samples.push({ label: '100-input-persistence', records: burst });
      const repeat = await page.evaluate(() => {
        const p = window.__appearanceProbe,
          before = p.materialEvents.length,
          stats = window.albumLiquidGlass.stats();
        for (let i = 0; i < 100; i++) window.albumAppearance.apply({ ...S.settings });
        return {
          events: p.materialEvents.length - before,
          before: stats,
          after: window.albumLiquidGlass.stats()
        };
      });
      assert.equal(repeat.events, 0);
      assert.equal(repeat.before.materialChanges, repeat.after.materialChanges);
      await assertIdentity('100-input-and-unchanged-apply');
    }
  );
  await check(
    'change, blur, preference-tab switch and close persist latest values through one serial queue',
    async () => {
      await openAppearance();
      await inputValue('liquidTransparency', 21);
      await inputValue('liquidTransparency', 21, 'change');
      await persisted('liquidTransparency', 21);
      await page.locator('#appearance-frost-transparency').focus();
      await inputValue('frostTransparency', 37);
      await page.locator('#settings-tab-appearance').focus();
      await persisted('frostTransparency', 37);
      await inputValue('cardRadius', 7);
      await page.locator('#settings-tab-metadata').click();
      await persisted('cardRadius', 7);
      await page.locator('#settings-tab-appearance').click();
      await inputValue('density', 186);
      await page.locator('#modal-close').click();
      await persisted('density', 186);
      await openAppearance();
      const start = (await writes()).records.length;
      for (const value of [29, 43, 63]) {
        await inputValue('liquidTransparency', value);
        await inputValue('liquidTransparency', value, 'change');
        await frames();
      }
      await persisted('liquidTransparency', 63);
      await page.evaluate(() => window.albumAppearanceControls.flush());
      const transport = await writes();
      assert.equal(transport.maxInFlight, 1, 'All actual settings saves stay serial');
      const records = transport.records
        .slice(start)
        .filter((row) => row.key === 'liquidTransparency');
      assert.ok(records.length);
      assert.equal(records.at(-1).value, 63);
      assert.ok(records.every((row) => row.completed && !row.error));
      report.samples.push({
        label: 'serial-latest-persistence',
        maxInFlight: transport.maxInFlight,
        records
      });
    }
  );
  await check(
    'density 120/158/186/222/360 preserves scroll anchor and actual grid/cover alignment without horizontal overflow',
    async () => {
      for (const value of [120, 158, 186, 222, 360]) await densityEvidence(value);
    }
  );
  await check(
    'zero-radius applies to whole media, cover, album and collection surfaces; shadow toggles on and off',
    async () => {
      await openAppearance();
      await rangeByKeyboard('cardRadius', 0);
      await closeModal();
      await radiusEvidence();
      await navigateGallery();
      await openAppearance();
      await page.locator('#appearance-text-shadow').check();
      await persisted('textShadow', true);
      await shadowSample(true);
      await page.locator('#appearance-text-shadow').uncheck();
      await persisted('textShadow', false);
      await shadowSample(false);
      await page.locator('#appearance-text-shadow').check();
      await persisted('textShadow', true);
    }
  );
  await check(
    'high-frequency actual drag preserves canvas/context and compiles no bad shader',
    async () => {
      await openAppearance();
      await beginIdentity();
      for (const fraction of [0.15, 0.85, 0.35, 0.7])
        await dragRange('liquidTransparency', fraction, 32);
      await assertIdentity('high-frequency-native-drag');
      const final = await snapshot('high-frequency-final');
      assert.deepEqual(final.shaderFailures, []);
      assert.deepEqual(final.unhandled, []);
      await inputValue('liquidTransparency', 63, 'change');
      await inputValue('frostTransparency', 37, 'change');
      await inputValue('cardRadius', 0, 'change');
      await inputValue('density', 186, 'change');
      await closeModal();
      await page.evaluate(() => window.albumAppearanceControls.flush());
    }
  );
  await check(
    'all five persisted values and original generated roots survive a real Electron restart',
    async () => {
      const expected = {
        liquidTransparency: 63,
        frostTransparency: 37,
        cardRadius: 0,
        density: 186,
        textShadow: true
      };
      for (const [key, value] of Object.entries(expected)) await persisted(key, value);
      const initial = await rpc('init');
      await closeApp();
      await launch();
      assert.equal(
        await page.locator('#modal').isVisible(),
        false,
        'Once marker prevents automatic reopening'
      );
      const after = await rpc('init');
      assert.deepEqual(
        after.roots.map((row) => row.id),
        initial.roots.map((row) => row.id)
      );
      for (const [key, value] of Object.entries(expected)) assert.equal(after.settings[key], value);
      await openAppearance();
      for (const [key, value] of Object.entries(expected))
        if (ranges[key])
          await expect(page.locator('#' + ranges[key].id)).toHaveValue(String(value));
      await expect(page.locator('#appearance-text-shadow')).toBeChecked();
      report.samples.push({
        label: 'restart-values',
        expected,
        roots: after.roots.map((row) => row.id)
      });
    }
  );
  await check(
    'four reset buttons restore persisted defaults; text shadow off clears existing shadows',
    async () => {
      await openAppearance();
      for (const [key, range] of Object.entries(ranges)) {
        await page.locator(`#settings-panel-appearance [data-appearance-reset="${key}"]`).click();
        await expect(page.locator('#' + range.id)).toHaveValue(String(range.default));
        await persisted(key, range.default);
      }
      await page.locator('#appearance-text-shadow').uncheck();
      await persisted('textShadow', false);
      await shadowSample(false);
    }
  );
  await check(
    'light/dark top and bottom preference screenshots, closed grid, grey placeholder, thin pink scrollbars and unchanged SVG shapes',
    async () => {
      const light = await themeScreenshots('light'),
        dark = await themeScreenshots('dark');
      assert.equal(light.icons.length, dark.icons.length);
      for (let i = 0; i < light.icons.length; i++) {
        const a = light.icons[i],
          b = dark.icons[i];
        assert.equal(a.selector, b.selector);
        assert.equal(a.shape, b.shape, a.selector + ' shape sequence is unchanged');
        for (const key of ['width', 'height', 'strokeWidth', 'opacity', 'filter'])
          assert.equal(a[key], b[key], a.selector + ' ' + key + ' stays unchanged');
      }
      assert.ok(
        light.icons.some((icon, i) => icon.color !== dark.icons[i].color),
        'Actual icon ink follows theme color'
      );
    }
  );
  await check(
    'no page/console/shader/context errors, public requests or failed actual persistence',
    async () => {
      const final = await snapshot('final-health');
      const transport = await writes();
      assert.deepEqual(final.shaderFailures, []);
      assert.deepEqual(final.unhandled, []);
      assert.equal(final.losses, 0);
      for (const gl of final.gl) {
        assert.equal(gl.error, 0);
        assert.equal(gl.lost, false);
      }
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.consoleErrors, []);
      assert.ok(transport.records.every((row) => !row.error));
      assert.equal(transport.inFlight, 0);
      report.persistence = transport;
      await closeApp();
      assert.deepEqual(report.blockedNetwork, []);
    }
  );
  report.passed = true;
})()
  .catch((error) => {
    report.errors.push(error.stack || String(error));
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeApp();
    } catch (error) {
      report.errors.push(error.stack || String(error));
      report.passed = false;
      process.exitCode = 1;
    }
    report.finished = new Date().toISOString();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('REPORT ' + path.join(run, 'report.json'));
    }
  });
