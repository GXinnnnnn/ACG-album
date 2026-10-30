'use strict';
// Lead runs serially; this file never builds or deploys. Every library/profile is generated.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const stage = path.resolve(
  process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\popup-pipeline-20261030'
);
const executable = process.env.ACG_EXECUTABLE
  ? path.resolve(process.env.ACG_EXECUTABLE)
  : require('electron');
const packaged = !!process.env.ACG_EXECUTABLE;
// prettier-ignore
const report = {
  passed: false, started: new Date().toISOString(), checks: [], samples: [], screenshots: [], errors: [], blockedNetwork: [],
  scope:
    'Real Electron renderer, real generated-PNG import/get/settings RPCs; isolated ACG_DATA_DIR and ACG_USER_DATA_DIR. Directory picker is intercepted. No candidate HTTP/RPC mock, no candidate/bind HTTP request, no product DOM/CSS/handler replacement. Synthetic progress/online/changed(matching) events enter the existing library:event boundary and are labelled separately. Main net.fetch and Chromium HTTP are denied; worker online matching/watchers are disabled. No public service or personal library is tested.'
};
let run, profile, collection, app, page;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
async function check(name, action) {
  try {
    await action();
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
async function ensureActive() {
  // Native blur pauses production drawing even while CDP can still interact.
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.show();
    win.focus();
    win.webContents.focus();
  });
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return { window: win.isFocused(), webContents: win.webContents.isFocused() };
      })
    )
    .toEqual({ window: true, webContents: true });
  await page.waitForFunction(
    () => !document.hidden && document.hasFocus() && !window.albumLiquidGlass.stats().inactive
  );
}
async function settle() {
  await ensureActive();
  await page.evaluate(async () => {
    await document.fonts.ready;
    const animations = document
      .getAnimations()
      .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime));
    await Promise.allSettled(animations.map((a) => a.finished));
    window.albumLiquidGlass.refresh({ immediate: true });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}
async function idle() {
  await page.waitForFunction(() => !growingTask && growingTimer === null && !growingDirty);
  await settle();
}
function instrument() {
  // prettier-ignore
  const p = (window.__popupProbe = { contexts: [], shaders: [], resizes: [], losses: [], unhandled: [] });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const gl = getContext.apply(this, args);
    if (args[0] === 'webgl2' && gl && !p.contexts.includes(gl)) {
      p.contexts.push(gl);
      this.addEventListener('webglcontextlost', () => p.losses.push(performance.now()));
    }
    return gl;
  };
  const shaderSource = WebGL2RenderingContext.prototype.shaderSource;
  WebGL2RenderingContext.prototype.shaderSource = function (shader, source) {
    p.shaders.push(source);
    return shaderSource.call(this, shader, source);
  };
  for (const key of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, key);
    Object.defineProperty(HTMLCanvasElement.prototype, key, {
      ...descriptor,
      set(value) {
        p.resizes.push({ canvas: this, key, before: this[key], after: value });
        descriptor.set.call(this, value);
      }
    });
  }
  window.addEventListener('unhandledrejection', (event) => p.unhandled.push(String(event.reason)));
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
  // prettier-ignore
  app = await _electron.launch({ executablePath: executable, args: packaged ? [] : [root], cwd: packaged ? path.dirname(executable) : root, env, timeout: 30000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  page.on('console', (message) => {
    if (message.type() === 'error' && /shader|WebGL|GL_INVALID/i.test(message.text()))
      report.errors.push(message.text());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.blockedNetwork.push({ source: 'renderer', url: route.request().url() });
    await route.abort();
  });
  report.runtime = await app.evaluate(
    ({ app, BrowserWindow, dialog, net, session }, c) => {
      const probe = (globalThis.__popupNetwork = []);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [c.collection] });
      const original = net.fetch.bind(net);
      net.fetch = (input, ...args) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (!/^https?:/i.test(url)) return original(input, ...args);
        probe.push({ source: 'main-net.fetch', url });
        return Promise.reject(new Error('Public HTTP forbidden by popup acceptance'));
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          probe.push({ source: 'session', url: details.url });
          callback({ cancel: true });
        }
      );
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1440, 900);
      win.show();
      win.focus();
      win.webContents.focus();
      return {
        executable: process.execPath,
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        version: app.getVersion()
      };
    },
    { collection }
  );
  assert.ok(samePath(report.runtime.executable, executable));
  assert.equal(report.runtime.packaged, packaged);
  assert.ok(samePath(report.runtime.userData, path.join(profile, 'chromium-profile')));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && S.settings.metadataOnboardingSeen
  );
  if (await page.locator('#modal').isVisible()) await page.locator('#modal-close').click();
  for (const [key, value] of [
    ['watchChanges', false],
    ['autoMatch', false],
    ['sidebarMode', 'expanded']
  ])
    await rpc('settings', { key, value });
  await page.addInitScript(instrument);
  await page.reload();
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && window.albumLiquidGlass
  );
  assert.ok(samePath((await rpc('init')).dataDir, profile));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle();
}
async function surface(label, selector, modalMaterial = false) {
  await expect(page.locator(selector)).toBeVisible();
  await settle();
  const sample = await page.evaluate(
    ({ label, selector }) => {
      const el = document.querySelector(selector),
        r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      const canvas = el.querySelector(':scope > .liquid-glass-canvas'),
        c = canvas?.getBoundingClientRect();
      const material = (node) => {
        const css = getComputedStyle(node);
        return {
          backgroundImage: css.backgroundImage,
          backgroundColor: css.backgroundColor,
          backdropFilter: css.backdropFilter
        };
      };
      const sidebar = document.querySelector('.sidebar-shell'),
        sidebarRect = sidebar.getBoundingClientRect();
      const p = window.__popupProbe;
      // Keep the evidence schema compact and aligned for manual report review.
      // prettier-ignore
      return {
        label, selector, theme: document.documentElement.dataset.theme, rect: r.toJSON(),
        settings: el.classList.contains('settings-dialog'),
        client: { width: el.clientWidth, height: el.clientHeight, left: el.clientLeft, top: el.clientTop },
        border: { left: parseFloat(s.borderLeftWidth), right: parseFloat(s.borderRightWidth) },
        gutter: s.scrollbarGutter, overflow: [s.overflowX, s.overflowY], scrollHeight: el.scrollHeight,
        canvas: c ? {
          left: c.left - r.left, right: r.right - c.right, top: c.top - r.top, bottom: r.bottom - c.bottom,
          width: c.width, height: c.height, bitmapWidth: canvas.width, bitmapHeight: canvas.height
        } : null,
        material: material(el), sidebarMaterial: material(sidebar),
        sidebarVisible: !!sidebar.getClientRects().length && sidebarRect.right > 0 &&
          sidebarRect.bottom > 0 && sidebarRect.left < innerWidth && sidebarRect.top < innerHeight &&
          getComputedStyle(sidebar).visibility === 'visible',
        frostImage: s.getPropertyValue('--dialog-frost-image').trim(),
        hidden: document.hidden, focused: document.hasFocus(),
        stats: window.albumLiquidGlass.stats(),
        gl: p.contexts.map((gl) => ({ error: gl.getError(), lost: gl.isContextLost() })),
        contextLosses: p.losses.length,
        fragmentVariants: new Set(p.shaders.filter((source) => /out\s+vec4\s+color\b/.test(source))).size,
        centralShaderBranches: p.shaders.flatMap((source) => source.split('\n').filter((line) =>
          /\bfrost\b|dialogFrost|frostMask|centerMask|frostCenter/i.test(line)))
      };
    },
    { label, selector }
  );
  report.samples.push(sample);
  assert.ok(sample.canvas, label + ': real optical canvas exists');
  assert.ok(
    Math.abs(sample.canvas.left - sample.canvas.right) <= 0.75,
    label + ': equal left/right canvas coverage ' + JSON.stringify(sample.canvas)
  );
  assert.ok(
    sample.canvas.left <= sample.border.left + 0.75 &&
      sample.canvas.right <= sample.border.right + 0.75,
    label + ': canvas reaches client edges'
  );
  assert.equal(sample.stats.gpu.status, 'webgl2');
  assert.equal(sample.stats.gpu.error, '');
  assert.ok(sample.stats.gpu.draws > 0 && sample.gl.length > 0);
  assert.equal(sample.contextLosses, 0);
  for (const gl of sample.gl) assert.deepEqual(gl, { error: 0, lost: false });
  assert.equal(sample.hidden, false, label + ': saved sample is visible');
  assert.equal(sample.focused, true, label + ': saved sample retains renderer focus');
  assert.equal(sample.stats.inactive, false, label + ': saved sample is actively rendered');
  assert.equal(sample.fragmentVariants, 1, 'All surfaces compile the same shared fragment shader');
  assert.deepEqual(sample.centralShaderBranches, [], 'No central-mask branch or frost uniform');
  assert.equal(sample.frostImage, '', label + ': no special dialog frost image');
  assert.doesNotMatch(sample.material.backgroundImage, /data:image\/svg\+xml/i);
  if (modalMaterial) {
    assert.ok(sample.sidebarVisible, 'Compare against the visible sidebar in the same theme');
    const modalChannels = sample.material.backgroundColor.match(/[\d.]+/g).map(Number);
    const sidebarChannels = sample.sidebarMaterial.backgroundColor.match(/[\d.]+/g).map(Number);
    assert.deepEqual(
      modalChannels.slice(0, 3),
      sidebarChannels.slice(0, 3),
      label + ': shared theme hue'
    );
    assert.ok(
      Math.abs(modalChannels[3] - 0.92) < 0.001,
      label + ': denser default window material'
    );
    assert.ok(
      Math.abs(sidebarChannels[3] - 0.82) < 0.001,
      label + ': independently adjustable liquid layer'
    );
    assert.equal(
      sample.material.backdropFilter,
      sample.sidebarMaterial.backdropFilter,
      label + ': shared full-surface blur'
    );
    assert.equal((sample.material.backgroundImage.match(/linear-gradient\(/g) || []).length, 2);
    assert.match(sample.material.backgroundImage, /linear-gradient\(/);
    assert.match(sample.material.backdropFilter, /blur\(/);
    assert.equal(sample.gutter, 'auto', label + ': optical shell reserves no extra right gutter');
    assert.ok(
      Math.abs(
        sample.rect.width - sample.client.width - sample.border.left - sample.border.right
      ) <= 0.75,
      label + ': full-width shell has no second scrollbar gutter'
    );
  }
  return sample;
}
async function inputEvidence(selector, focus = false) {
  await ensureActive();
  if (focus) {
    await page.locator(selector).focus();
    await expect(page.locator(selector)).toBeFocused();
  }
  const sample = await page.locator(selector).evaluate((el) => {
    const s = getComputedStyle(el),
      placeholder = getComputedStyle(el, '::placeholder'),
      r = el.getBoundingClientRect();
    const extent = Math.max(0, parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth));
    // prettier-ignore
    const edges = { left: r.left - extent, right: r.right + extent, top: r.top - extent, bottom: r.bottom + extent };
    const clips = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const css = getComputedStyle(p),
        b = p.getBoundingClientRect();
      const x = /(auto|scroll|hidden|clip)/.test(css.overflowX),
        y = /(auto|scroll|hidden|clip)/.test(css.overflowY);
      if (x || y)
        clips.push({
          parent: p.id || p.className,
          x,
          y,
          left: edges.left - b.left - p.clientLeft,
          right: b.left + p.clientLeft + p.clientWidth - edges.right,
          top: edges.top - b.top - p.clientTop,
          bottom: b.top + p.clientTop + p.clientHeight - edges.bottom
        });
    }
    const rootStyle = getComputedStyle(document.documentElement);
    // prettier-ignore
    return {
      selector: '#' + el.id, theme: document.documentElement.dataset.theme,
      focused: el === document.activeElement, rect: r.toJSON(), edges, clips, color: s.color,
      outline: { width: s.outlineWidth, offset: s.outlineOffset, style: s.outlineStyle, color: s.outlineColor },
      placeholder: {
        color: placeholder.color, opacity: placeholder.opacity,
        token: rootStyle.getPropertyValue('--placeholder').trim(), muted: rootStyle.getPropertyValue('--muted').trim()
      }
    };
  });
  report.samples.push({ input: sample });
  assert.ok(sample.placeholder.token, 'Independent --placeholder token exists');
  assert.notEqual(sample.placeholder.token, sample.placeholder.muted);
  assert.notEqual(sample.placeholder.color, sample.color);
  assert.equal(sample.placeholder.opacity, '1');
  const expectedColor = await page.evaluate(() => {
    // Resolve the token through canvas, without changing product DOM or styles.
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = getComputedStyle(document.documentElement)
      .getPropertyValue('--placeholder')
      .trim();
    return c.fillStyle;
  });
  const rgb = sample.placeholder.color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  const hex = rgb && '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
  assert.ok(
    rgb && Math.max(...rgb) - Math.min(...rgb) <= 30,
    selector + ': placeholder is neutral gray'
  );
  assert.equal(hex, expectedColor, selector + ': computed placeholder follows independent token');
  if (focus) {
    assert.ok(parseFloat(sample.outline.width) > 0 && parseFloat(sample.outline.offset) <= -2);
    for (const clip of sample.clips) {
      if (clip.x)
        assert.ok(
          clip.left >= -0.75 && clip.right >= -0.75,
          selector + ': horizontal focus edges visible ' + JSON.stringify(clip)
        );
      if (clip.y)
        assert.ok(
          clip.top >= -0.75 && clip.bottom >= -0.75,
          selector + ': vertical focus edges visible ' + JSON.stringify(clip)
        );
    }
  }
}
async function selectPopover(selector, label) {
  const button = page.locator(selector).locator('..').getByRole('combobox');
  await button.click();
  const list = '#' + (await button.getAttribute('aria-controls'));
  await surface(label, list);
  await shot(label);
  await button.press('Escape');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
}
async function themeChecks(theme, album) {
  await page.evaluate((theme) => changeTheme(theme), theme);
  await inputEvidence('#search');
  for (const selector of [
    '.sidebar-shell',
    '.topbar > .brand',
    '.topbar > .navigation',
    '.topbar > .search-wrap',
    '.topbar > .header-actions',
    '.toolbar-right'
  ])
    await surface(theme + '-chrome-' + selector, selector);
  await page
    .locator(`.tree-node[data-node-id="${album.id}"] > .tree-row`)
    .click({ button: 'right' });
  await surface(theme + '-contextmenu', '#context-menu');
  await shot(theme + '-contextmenu');
  await page
    .locator('#context-menu')
    .getByRole('menuitem', { name: '关联作品简介…', exact: true })
    .click();
  await inputEvidence('#subject-keyword', true);
  await inputEvidence('#subject-url', true);
  await surface(theme + '-binding', '#modal', true);
  await shot(theme + '-binding');
  await selectPopover('#subject-type', theme + '-nested-binding-select');
  await page.locator('#modal-close').click();
  // A smaller native window makes this ordinary modal exercise its real scrollbar.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 560)
  );
  await page.evaluate(async (id) => properties(await api('get', { id })), album.id);
  const general = await surface(theme + '-general-properties', '#modal', true);
  assert.ok(
    general.scrollHeight <= general.client.height + 1,
    'Optical dialog shell never scrolls'
  );
  const content = page.locator('#modal-content');
  assert.ok(
    await content.evaluate((el) => el.scrollHeight > el.clientHeight),
    'Properties scrolls inside its full-width glass shell'
  );
  await shot(theme + '-general-properties');
  await content.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await surface(theme + '-general-properties-bottom', '#modal', true);
  await page.locator('#modal-close').click();
  await page.evaluate(async (id) => cropModal(await api('get', { id })), album.id);
  await surface(theme + '-cover-position', '#modal', true);
  await page.evaluate(() => {
    for (const [id, value] of [
      ['crop-zoom', '250'],
      ['crop-x', '20'],
      ['crop-y', '75']
    ]) {
      const input = document.getElementById(id);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await page.locator('[data-crop-reset="x"]').click();
  assert.deepEqual(
    await page.evaluate(() =>
      ['crop-zoom', 'crop-x', 'crop-y'].map((id) => document.getElementById(id).value)
    ),
    ['250', '50', '75'],
    'Position reset changes only its own slider'
  );
  for (const key of ['zoom', 'y']) {
    await page.locator(`[data-crop-reset="${key}"]`).click();
    assert.equal(
      await page.locator(`[data-crop-reset="${key}"]`).getAttribute('title'),
      '恢复默认值'
    );
  }
  assert.deepEqual(
    await page.evaluate(() =>
      ['crop-zoom', 'crop-x', 'crop-y'].map((id) => document.getElementById(id).value)
    ),
    ['100', '50', '50']
  );
  await page.locator('#modal-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await surface(theme + '-cover-position-bottom', '#modal', true);
  await shot(theme + '-cover-position');
  await page.locator('#modal-close').click();
  if (theme === 'dark') {
    await page.evaluate(async (id) => {
      await api('bind', {
        id,
        kind: 'character',
        custom: { name: '本地弹窗验收角色', summary: '仅用于独立验收资料库。\n'.repeat(90) }
      });
    }, album.id);
    for (const detailTheme of ['light', 'dark']) {
      await page.evaluate(
        async ({ id, theme }) => {
          await changeTheme(theme);
          detailModal(await api('get', { id }));
        },
        { id: album.id, theme: detailTheme }
      );
      await surface(detailTheme + '-detail-information', '#modal', true);
      await page.locator('#modal-content').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await surface(detailTheme + '-detail-information-bottom', '#modal', true);
      await shot(detailTheme + '-detail-information');
      await page.locator('#modal-close').click();
    }
  }
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 900)
  );
  await page.evaluate(async () => rootBindingModal(await api('get', { id: S.roots[0].id })));
  await surface(theme + '-root-binding', '#modal', true);
  await page.locator('#modal-close').click();
  await page.evaluate(() => settingsModal('appearance'));
  await surface(theme + '-settings-appearance', '#modal', true);
  await shot(theme + '-generalsettings');
  await selectPopover('#theme-select', theme + '-nested-settings-select');
  for (const tab of ['metadata', 'profile', 'cache', 'application']) {
    await page.locator('#settings-tab-' + tab).click();
    await expect(page.locator('#settings-panel-' + tab)).toBeVisible();
    await surface(theme + '-settings-' + tab, '#modal', true);
    if (tab === 'metadata') await inputEvidence('#token-input');
  }
  await page.locator('#settings-about').click();
  const child = 'dialog[data-info-child][open]';
  await surface(theme + '-nested-about', child, true);
  await shot(theme + '-nested-about');
  await page.locator(child + ' .info-dialog-close').click();
  await page.locator('#modal-close').click();
}
async function syntheticStability(theme, ids) {
  await idle();
  await page.evaluate(() => {
    const probe = window.__popupProbe;
    const hosts = [
      ...document.querySelectorAll(
        '.sidebar-shell,.topbar > .brand,.topbar > .navigation,.topbar > .search-wrap,.topbar > .header-actions,.toolbar-right'
      )
    ];
    const elements = hosts.flatMap((host) => [host, ...host.querySelectorAll('*')]);
    const canvases = hosts.flatMap((host) => [...host.querySelectorAll('canvas')]);
    const counts = Object.fromEntries(
      'records elementAdds elementRemoves attributes text themeWrites canvasAttributes'
        .split(' ')
        .map((k) => [k, 0])
    );
    const observer = new MutationObserver((rows) => {
      for (const row of rows) {
        counts.records++;
        if (row.target === document.documentElement) counts.themeWrites++;
        if (row.type === 'attributes') {
          counts.attributes++;
          if (row.target instanceof HTMLCanvasElement && /width|height/.test(row.attributeName))
            counts.canvasAttributes++;
        }
        if (row.type === 'characterData') counts.text++;
        counts.elementAdds += [...row.addedNodes].filter((n) => n.nodeType === 1).length;
        counts.elementRemoves += [...row.removedNodes].filter((n) => n.nodeType === 1).length;
      }
    });
    // prettier-ignore
    for (const host of hosts) observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-liquid-glass', 'data-motion', 'style']
    });
    // prettier-ignore
    probe.stability = { hosts, elements, canvases, counts, observer, resizeStart: probe.resizes.length, stats: window.albumLiquidGlass.stats() };
  });
  const send = (events) =>
    app.evaluate(({ BrowserWindow }, events) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      for (const [type, data] of events) wc.send('library:event', { type, data, synthetic: true });
    }, events);
  // Synthetic boundary events exercise unchanged summaries and matching batches, not a real online service.
  for (let i = 0; i < 24; i++) {
    // prettier-ignore
    await send([
      ['progress', { active: true, images: 24 + i, folders: 13, current: 'synthetic generated batch ' + i }],
      ['online', { active: true, completed: i, remaining: 24 - i }],
      ['changed', { matching: true, id: ids[i % ids.length] }]
    ]);
    await page.waitForTimeout(80);
  }
  // prettier-ignore
  await send([
    ['progress', { active: false, images: 48, folders: 13 }],
    ['online', { active: false, completed: 24, remaining: 0 }]
  ]);
  await idle();
  const sample = await page.evaluate(() => {
    const p = window.__popupProbe,
      b = p.stability;
    b.observer.disconnect();
    // prettier-ignore
    return {
      counts: b.counts, sameElements: b.elements.every((n) => n.isConnected),
      sameCanvases: b.canvases.every((n) => n.isConnected), canvasCount: b.canvases.length,
      protectedResizes: p.resizes.slice(b.resizeStart).filter((r) => b.canvases.includes(r.canvas))
        .map(({ key, before, after }) => ({ key, before, after })),
      before: b.stats, after: window.albumLiquidGlass.stats(), contextLosses: p.losses.length
    };
  });
  report.samples.push({ synthetic: true, theme, boundaryEvents: 74, stability: sample });
  assert.ok(
    sample.canvasCount > 0 && sample.sameElements && sample.sameCanvases,
    'Protected DOM and canvas identity persist'
  );
  assert.equal(
    sample.counts.elementAdds + sample.counts.elementRemoves,
    0,
    'No protected element rebuild'
  );
  assert.equal(sample.counts.themeWrites, 0, 'No theme/root style rewrites during unchanged batch');
  assert.equal(sample.counts.canvasAttributes, 0);
  assert.deepEqual(sample.protectedResizes, []);
  assert.equal(sample.contextLosses, 0);
  await shot(theme + '-synthetic-progress');
}
async function closeApp() {
  if (!app) return;
  const owned = app;
  app = null;
  let timer;
  try {
    report.blockedNetwork.push(...(await owned.evaluate(() => globalThis.__popupNetwork || [])));
    await Promise.race([
      owned.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron close timeout')), 15000);
      })
    ]);
  } catch (error) {
    const child = owned.process();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
(async () => {
  try {
    await fs.mkdir(stage, { recursive: true });
    assert.ok(
      samePath(await fs.realpath(stage), stage),
      'Stage must be a physical archive directory'
    );
    run = path.join(
      stage,
      'gui-' + new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') + '-' + randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    collection = path.join(run, 'generated-collection');
    await fs.mkdir(profile, { recursive: true });
    const png = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#6595b7' }
    })
      .png()
      .toBuffer();
    const albums = Array.from({ length: 12 }, (_, i) =>
      path.join(collection, 'generated-album-' + String(i).padStart(2, '0'))
    );
    for (const album of albums) {
      await fs.mkdir(album, { recursive: true });
      for (let i = 0; i < 2; i++)
        await fs.writeFile(path.join(album, i + '.png'), png, { flag: 'wx' });
    }
    Object.assign(report, { run, profile, collection, executable, packaged });
    await launch();
    await check('real generated PNG import uses production IPC and isolated profiles', async () => {
      const imported = await rpc('import', {
        onlineMatch: false,
        subjectTypes: [4],
        directoryKind: 'work'
      });
      assert.equal(imported.root, idFor(collection));
      await idle();
      await page.evaluate(async (id) => {
        await loadSummary();
        await navigate({ parent: id });
        await openFolderTree();
      }, idFor(collection));
      await expect(
        page.locator('.tree-node[data-node-id="' + idFor(albums[0]) + '"]')
      ).toBeVisible();
      assert.equal((await rpc('init')).stats.images, 24);
      report.samples.push({
        realImport: {
          root: imported.root,
          generatedImages: 24,
          generatedAlbums: 12,
          onlineMatch: false
        }
      });
    });
    const album = await rpc('get', { id: idFor(albums[0]) });
    await page.evaluate((id) => navigate({ parent: id }), album.id);
    for (const theme of ['light', 'dark']) {
      await check(
        theme + ': shared sidebar material, nested popovers, focus clips and placeholders',
        () => themeChecks(theme, album)
      );
      await check(
        theme + ': synthetic progress/matching preserves sidebar/top DOM, canvas and theme',
        () => syntheticStability(theme, albums.map(idFor))
      );
    }
    await check(
      'real structural import refreshes open tree and retains current selection',
      async () => {
        const added = path.join(collection, 'generated-new-structural-album');
        await fs.mkdir(added);
        await fs.writeFile(path.join(added, 'new.png'), png, { flag: 'wx' });
        await rpc('import', { onlineMatch: false, subjectTypes: [4], directoryKind: 'work' });
        await idle();
        // New name sorts after the 12-item first page; verify production tree paging as well.
        await expect(
          page.locator('#category-nav .tree-pager button').filter({ hasText: '下一页' }).last()
        ).toBeEnabled();
        await page
          .locator('#category-nav .tree-pager button')
          .filter({ hasText: '下一页' })
          .last()
          .click();
        await expect(page.locator('.tree-node[data-node-id="' + idFor(added) + '"]')).toBeVisible();
        await page
          .locator('#category-nav .tree-pager button')
          .filter({ hasText: '上一页' })
          .last()
          .click();
        await expect(
          page.locator('.tree-node[data-node-id="' + album.id + '"] > [aria-selected="true"]')
        ).toBeVisible();
        assert.equal(await page.evaluate(() => S.current.id), album.id);
        assert.equal((await rpc('init')).stats.images, 25);
        report.samples.push({
          realStructuralImport: { added: idFor(added), selected: album.id, generatedImages: 25 }
        });
        await shot('real-structural-tree-selection');
      }
    );
    assert.deepEqual(await page.evaluate(() => window.__popupProbe.unhandled), []);
    assert.deepEqual(report.errors, []);
    await closeApp();
    assert.deepEqual(report.blockedNetwork, [], 'No public HTTP was attempted');
    report.passed = true;
  } catch (error) {
    report.errors.push(error.stack);
    process.exitCode = 1;
    if (page && run) await shot('failure').catch(() => {});
  } finally {
    await closeApp().catch((error) => {
      report.errors.push(error.stack);
      process.exitCode = 1;
    });
    report.finished = new Date().toISOString();
    if (run) await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        { passed: report.passed, run, checks: report.checks, errors: report.errors },
        null,
        2
      )
    );
  }
})();
