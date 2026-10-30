'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  budget,
  materialProfile,
  materialSettings,
  scheduler,
  createRenderer,
  imageSampler,
  nativeInactive,
  intersectRect,
  paintedBounds,
  syncLegibility,
  mount,
  vertex,
  fragment,
  surfaces
} = require('../src/ui/liquid-glass.js');

function textHost(rect) {
  const attributes = new Map();
  return {
    writes: 0,
    rect,
    isConnected: true,
    hasAttribute: (name) => attributes.has(name),
    setAttribute(name, value) {
      attributes.set(name, value);
      this.writes++;
    },
    removeAttribute(name) {
      if (attributes.delete(name)) this.writes++;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    getClientRects: () => [rect],
    closest: () => null,
    matches: () => false
  };
}
const box = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
});
test('image overlap follows visible crop bounds and releases metadata without repeated writes', () => {
  const rect = box(0, 0, 200, 100),
    host = textHost(box(0, 0, 40, 100)),
    tracked = new Set();
  const contain = paintedBounds(rect, rect, 100, 200, 'contain', '50% 50%');
  assert.deepEqual(contain, box(75, 0, 50, 100));
  assert.equal(intersectRect(host.rect, contain), null, 'Letterbox gaps are not image-backed');
  assert.equal(
    syncLegibility([{ host, rect: host.rect }], [{ bounds: contain }], tracked).backed,
    0
  );
  host.rect = box(80, 10, 40, 40);
  assert.deepEqual(syncLegibility([{ host, rect: host.rect }], [{ bounds: contain }], tracked), {
    backed: 1,
    changes: 1
  });
  assert.equal(host.writes, 1);
  assert.equal(
    syncLegibility([{ host, rect: host.rect }], [{ bounds: contain }], tracked).changes,
    0
  );
  assert.equal(host.writes, 1, 'Stationary/repeated updates do not mutate the host');
  assert.equal(syncLegibility([{ host, rect: host.rect }], [], tracked).changes, 1);
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
  const cover = paintedBounds(rect, box(0, 50, 200, 50), 100, 200, 'cover', '50% 0%');
  assert.deepEqual(cover, box(0, 50, 200, 50));
  assert.equal(
    intersectRect(box(0, 0, 200, 40), cover),
    null,
    'Viewport-clipped content cannot trigger a header'
  );
  syncLegibility([{ host, rect: host.rect }], [{ bounds: contain }], tracked);
  syncLegibility([], [], tracked);
  assert.equal(tracked.size, 0);
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
});

test('off-mode text updates are event-driven, exclude own images, pause when inactive and never initialize GL', () => {
  const eventNode = (value = {}) => {
    const handlers = new Map();
    return Object.assign(value, {
      addEventListener(type, fn) {
        const list = handlers.get(type) || [];
        list.push(fn);
        handlers.set(type, list);
      },
      removeEventListener(type, fn) {
        handlers.set(
          type,
          (handlers.get(type) || []).filter((f) => f !== fn)
        );
      },
      emit(type, event = {}) {
        for (const fn of handlers.get(type) || []) fn(event);
      }
    });
  };
  const host = textHost(box(20, 20, 180, 60));
  const image = {
    complete: true,
    naturalWidth: 200,
    naturalHeight: 100,
    inside: false,
    rect: box(0, 0, 300, 200),
    closest(selector) {
      return selector === surfaces && this.inside ? host : null;
    },
    getBoundingClientRect() {
      return this.rect;
    },
    getClientRects: () => [{}],
    parentElement: { getBoundingClientRect: () => box(0, 0, 800, 600) }
  };
  let viewerOpen = false;
  const doc = eventNode({
    hidden: false,
    documentElement: { dataset: { liquidGlass: 'off', theme: 'light', motion: 'low' } },
    body: {},
    querySelector: (selector) => (selector === '.viewer[open]' && viewerOpen ? {} : null),
    querySelectorAll: (selector) => (selector === surfaces ? [host] : [image]),
    createElement() {
      throw new Error('Off mode must not create a GL canvas');
    }
  });
  const media = eventNode({ matches: false });
  const win = eventNode(
    Object.assign(clock(), {
      document: doc,
      innerWidth: 800,
      innerHeight: 600,
      matchMedia: () => media,
      getComputedStyle: (node) =>
        node === host
          ? { visibility: 'visible', opacity: '1', borderTopLeftRadius: '16px', position: 'fixed' }
          : { visibility: 'visible', opacity: '1', objectFit: 'fill', objectPosition: '50% 50%' },
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      MutationObserver: class {
        observe() {}
        disconnect() {}
      }
    })
  );
  const api = mount(win);
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), true);
  assert.equal(api.stats().frames, 0);
  assert.equal(api.stats().gpu.status, 'uninitialized');
  const initial = api.stats().legibilityPasses;
  win.tick(1000);
  assert.equal(api.stats().legibilityPasses, initial);
  assert.equal(api.stats().pending, 0);
  image.rect = box(400, 300, 100, 100);
  doc.emit('scroll');
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
  image.rect = box(0, 0, 300, 200);
  image.inside = true;
  doc.emit('load', { target: { tagName: 'IMG' } });
  win.tick();
  assert.equal(
    host.hasAttribute('data-glass-image-under'),
    false,
    'Own floating image is not a background'
  );
  image.inside = false;
  doc.emit('scroll');
  win.emit('blur');
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
  assert.equal(api.stats().pending, 0);
  win.emit('focus');
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), true);
  viewerOpen = true;
  doc.emit('toggle');
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
  assert.equal(api.stats().imageCandidates, 0, 'An open viewer must not sample the hidden library');
  assert.equal(api.stats().imageBackedSurfaces, 0);
  viewerOpen = false;
  doc.emit('toggle');
  win.tick();
  assert.equal(host.hasAttribute('data-glass-image-under'), true);
  api.destroy();
  assert.equal(host.hasAttribute('data-glass-image-under'), false);
  assert.equal(api.stats().pending, 0);
});

test('only explicit native inactive booleans change visibility state; maximize notifications do not', () => {
  assert.equal(nativeInactive({ type: 'window', data: { inactive: true } }), true);
  assert.equal(nativeInactive({ type: 'window', data: { inactive: false } }), false);
  for (const event of [
    undefined,
    { type: 'window' },
    { type: 'window', data: { maximized: true } },
    { type: 'window', data: { maximized: false } },
    { type: 'window', data: { inactive: 'false' } },
    { type: 'window', data: { inactive: 0 } },
    { type: 'online', data: { inactive: false } }
  ])
    assert.equal(nativeInactive(event), null);
});

test('per-image security failures are isolated and cached; safe decoded pictures remain usable', () => {
  const metrics = { securityChecks: 0, skippedImages: 0 };
  let allocated = 0;
  const doc = {
    createElement() {
      allocated++;
      let tainted = false;
      return {
        getContext: () => ({
          drawImage(img) {
            if (img.throwDraw) throw new Error('draw failed');
            tainted = img.tainted;
          },
          getImageData() {
            if (tainted) throw new Error('SecurityError');
            return {};
          }
        })
      };
    }
  };
  const sample = imageSampler(doc, metrics);
  const bad = { src: 'cross-origin', naturalWidth: 800, naturalHeight: 400, tainted: true };
  const broken = { ...bad, src: 'broken', throwDraw: true };
  const good = { src: 'acg-image://thumb/local', naturalWidth: 800, naturalHeight: 400 };
  assert.equal(sample(bad), null);
  assert.equal(sample(bad), null);
  assert.equal(sample(broken), null);
  const picture = sample(good);
  assert.ok(picture);
  assert.equal(picture.width, 128);
  assert.equal(picture.height, 64);
  assert.equal(sample(good), picture);
  assert.equal(allocated, 3, 'No repeat security/readback work for cached sources');
  assert.equal(metrics.skippedImages, 2);
  assert.equal(metrics.securityChecks, 2);
});

function clock() {
  let time = 0,
    serial = 0;
  const frames = new Map(),
    timers = new Map();
  return {
    performance: { now: () => time },
    frames,
    timers,
    requestAnimationFrame(fn) {
      const id = ++serial;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout(fn, delay) {
      const id = ++serial;
      timers.set(id, { fn, at: time + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(delta = 40) {
      time += delta;
      for (const [id, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      const work = [...frames.values()];
      frames.clear();
      for (const fn of work) fn();
    }
  };
}
function fixture(options = {}) {
  const calls = [],
    listeners = new Map();
  const gl = {};
  for (const key of [
    'VERTEX_SHADER',
    'FRAGMENT_SHADER',
    'COMPILE_STATUS',
    'LINK_STATUS',
    'TEXTURE_2D',
    'TEXTURE_MIN_FILTER',
    'TEXTURE_MAG_FILTER',
    'LINEAR',
    'TEXTURE_WRAP_S',
    'TEXTURE_WRAP_T',
    'CLAMP_TO_EDGE',
    'UNPACK_FLIP_Y_WEBGL',
    'RGBA',
    'UNSIGNED_BYTE',
    'COLOR_BUFFER_BIT',
    'SCISSOR_TEST',
    'TRIANGLES',
    'RENDERER'
  ])
    gl[key] = key;
  for (const name of [
    'shaderSource',
    'compileShader',
    'attachShader',
    'linkProgram',
    'deleteShader',
    'useProgram',
    'bindVertexArray',
    'bindTexture',
    'texParameteri',
    'uniform1i',
    'pixelStorei',
    'viewport',
    'enable',
    'scissor',
    'clearColor',
    'clear',
    'uniform2f',
    'uniform1f',
    'uniform4f',
    'drawArrays',
    'deleteTexture',
    'deleteVertexArray',
    'deleteProgram'
  ])
    gl[name] = (...args) => calls.push([name, ...args]);
  gl.createShader = (type) => ({ type });
  gl.createProgram = () => ({});
  gl.createTexture = () => ({});
  gl.createVertexArray = () => ({});
  gl.getShaderParameter = () => options.compile !== false;
  gl.getShaderInfoLog = () => 'compile fixture error';
  gl.getProgramParameter = () => options.link !== false;
  gl.getProgramInfoLog = () => 'link fixture error';
  gl.getUniformLocation = (_, name) => name;
  gl.getParameter = () => 'unit GL double, not a measured GPU';
  gl.getExtension = () => null;
  gl.texImage2D = (...args) => {
    if (options.uploadError) throw new Error('tainted source');
    calls.push(['texImage2D', ...args]);
  };
  const canvas = {
    width: 1,
    height: 1,
    getContext(kind) {
      calls.push(['getContext', kind]);
      return options.unavailable ? null : gl;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    emit(type) {
      let prevented = false;
      listeners.get(type)?.({
        preventDefault() {
          prevented = true;
        }
      });
      return prevented;
    }
  };
  const target = () => ({
    width: 1,
    height: 1,
    getContext: () => ({
      clearRect() {},
      drawImage: (...args) => calls.push(['copyPresentation', ...args])
    })
  });
  return { canvas, calls, target, gl };
}

test('event-driven scheduler coalesces bursts, caps frequency and never self-schedules while idle', () => {
  const win = clock();
  let enabled = true,
    paints = 0;
  const queue = scheduler(
    win,
    () => paints++,
    () => enabled
  );
  for (let i = 0; i < 100; i++) queue.request();
  assert.equal(win.frames.size, 1);
  win.tick();
  assert.equal(paints, 1);
  assert.equal(queue.pending(), 0);
  win.tick(1000);
  assert.equal(paints, 1, 'No perpetual RAF loop');
  queue.request();
  win.tick(0);
  queue.request();
  assert.equal(win.timers.size, 1);
  queue.cancel();
  assert.equal(queue.pending(), 0);
  enabled = false;
  queue.request();
  win.tick();
  assert.equal(paints, 2);
  enabled = true;
  queue.request();
  enabled = false;
  win.tick();
  assert.equal(paints, 2, 'Hidden/off state prevents pending draw');
});

test('full-face material covers header, narrow rail and modal interiors with wider bounded shoulders', () => {
  for (const [width, height] of [
    [220, 42],
    [58, 850],
    [760, 600]
  ]) {
    const material = materialProfile(width, height);
    assert.ok(
      material.bodyAlpha > 0 && material.bodyAlpha < 0.3,
      'Frosted center has nonzero translucent optical coverage'
    );
    assert.ok(
      material.shoulderWidth > material.edgeWidth,
      'Lens transition extends beyond the old edge-only strip'
    );
    assert.ok(material.shoulderWidth >= 24 && material.shoulderWidth <= 180);
    assert.ok(material.sheenAlpha > 0 && material.sheenAlpha < 0.1);
  }
});

test('per-surface budgets bound DPR, texture dimensions and total pixels', () => {
  for (const [width, height, dpr] of [
    [30, 40, 4],
    [365, 180, 3],
    [1000, 900, 2],
    [4000, 2200, 2]
  ]) {
    const result = budget(width, height, dpr);
    assert.ok(result.width * result.height <= 181000);
    assert.ok(result.width <= 1024 && result.height <= 1024);
    assert.ok(result.width <= width * 1.5 + 1 && result.height <= height * 1.5 + 1);
  }
});

test('real WebGL2 API path compiles GLSL, uploads one texture and draws/copies bounded surfaces using one context', () => {
  const f = fixture();
  const statuses = [];
  const renderer = createRenderer(
    f.canvas,
    (status) => statuses.push(status),
    () => 1
  );
  assert.equal(renderer.ready(), true);
  assert.deepEqual(statuses, ['webgl2']);
  assert.match(vertex, /#version 300 es/);
  assert.match(fragment, /texture\(scene/);
  assert.match(fragment, /normal/);
  assert.match(fragment, /fresnel/);
  assert.equal(renderer.upload({ width: 320, height: 180 }), true);
  for (let i = 0; i < 2; i++)
    renderer.render(
      f.target(),
      { left: 10, bottom: 200, width: 300, height: 180 },
      { width: 1600, height: 900 },
      {
        radius: 24,
        dark: false,
        light: [-0.5, 0.8],
        dpr: 2,
        strength: 1
      }
    );
  assert.equal(f.calls.filter((call) => call[0] === 'getContext').length, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'drawArrays').length, 2);
  assert.equal(f.calls.filter((call) => call[0] === 'copyPresentation').length, 2);
  assert.equal(renderer.stats().uploads, 1, 'Pointer-only draws reuse the scene texture');
  assert.equal(renderer.stats().draws, 2);
  const material = materialProfile(300, 180);
  assert.deepEqual(
    f.calls.filter((call) => call[0] === 'uniform4f' && call[1] === 'material'),
    Array.from({ length: 2 }, () => [
      'uniform4f',
      'material',
      material.edgeWidth,
      material.shoulderWidth,
      material.bodyAlpha,
      material.sheenAlpha
    ]),
    'Every surface receives the full-face material profile without extra draw calls'
  );
  assert.deepEqual(
    f.calls.filter((call) => call[0] === 'uniform4f' && call[1] === 'frost'),
    [],
    'Sidebar and dialogs use the same full-face profile without a central frost uniform'
  );
  renderer.destroy();
  assert.equal(renderer.stats().status, 'destroyed');
});

for (const options of [{ unavailable: true }, { compile: false }, { link: false }])
  test('unsupported or failed shaders preserve CSS fallback: ' + JSON.stringify(options), () => {
    const f = fixture(options),
      renderer = createRenderer(f.canvas);
    assert.equal(renderer.ready(), false);
    assert.equal(renderer.stats().status, 'css-fallback');
    assert.ok(renderer.stats().error);
    assert.equal(renderer.upload({}), false);
    renderer.destroy();
  });

test('native context loss falls back once and restores only on a native restore event', () => {
  const f = fixture(),
    statuses = [];
  const renderer = createRenderer(f.canvas, (status) => statuses.push(status));
  assert.equal(f.canvas.emit('webglcontextlost'), true);
  assert.equal(renderer.ready(), false);
  assert.equal(renderer.upload({}), false);
  for (let i = 0; i < 10; i++) renderer.stats();
  assert.equal(
    f.calls.filter((call) => call[0] === 'getContext').length,
    1,
    'No restore/recreate loop'
  );
  f.canvas.emit('webglcontextrestored');
  assert.equal(renderer.ready(), true);
  assert.equal(f.calls.filter((call) => call[0] === 'getContext').length, 2);
  assert.deepEqual(statuses, ['webgl2', 'context-lost', 'webgl2']);
  assert.equal(renderer.stats().contextLosses, 1);
  assert.equal(renderer.stats().restores, 1);
  renderer.destroy();
});

test('unexpected texture security failure remains recoverable without rebuilding GL contexts', () => {
  const options = { uploadError: true },
    f = fixture(options),
    renderer = createRenderer(f.canvas);
  assert.equal(renderer.upload({}), false);
  assert.equal(renderer.ready(), true);
  options.uploadError = false;
  assert.equal(renderer.upload({}), true);
  assert.equal(f.calls.filter((call) => call[0] === 'getContext').length, 1);
  renderer.destroy();
});

function materialMount(options = {}) {
  const f = fixture(options);
  const eventNode = (node = {}) => {
    const handlers = new Map();
    return Object.assign(node, {
      addEventListener(type, fn) {
        const list = handlers.get(type) || [];
        list.push(fn);
        handlers.set(type, list);
      },
      removeEventListener(type, fn) {
        handlers.set(
          type,
          (handlers.get(type) || []).filter((item) => item !== fn)
        );
      },
      emit(type, event = {}) {
        for (const fn of handlers.get(type) || []) fn(event);
      }
    });
  };
  const values = new Map([
    ['--liquid-opacity', '0.82'],
    ['--frost-opacity', '0.92']
  ]);
  const root = {
    dataset: { liquidGlass: options.off ? 'off' : 'on', theme: 'light', motion: 'low' },
    style: { getPropertyValue: (name) => values.get(name) || '' }
  };
  const hosts = [textHost(box(20, 20, 180, 60)), textHost(box(300, 20, 220, 60))];
  for (const host of hosts) {
    host.dataset = {};
    host.children = [];
    host.append = (canvas) => {
      host.children.push(canvas);
      canvas.parentElement = host;
    };
  }
  const mutations = [];
  const counts = { rootReads: 0, hostReads: 0, contexts: 0, canvases: 0 };
  const ctx = {
    fillRect() {},
    clearRect() {},
    drawImage() {}
  };
  const doc = eventNode({
    documentElement: root,
    body: {},
    hidden: false,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === surfaces ? hosts : []),
    createElement() {
      counts.canvases++;
      return eventNode({
        width: 1,
        height: 1,
        setAttribute() {},
        remove() {
          this.parentElement = null;
        },
        getContext(kind) {
          if (kind !== 'webgl2') return ctx;
          counts.contexts++;
          return options.unavailable ? null : f.gl;
        }
      });
    }
  });
  const media = eventNode({ matches: !!options.reduced });
  const win = eventNode(
    Object.assign(clock(), {
      document: doc,
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 1,
      matchMedia: () => media,
      getComputedStyle(node) {
        if (node === root) {
          counts.rootReads++;
          return root.style;
        }
        counts.hostReads++;
        return {
          visibility: 'visible',
          opacity: '1',
          borderTopLeftRadius: '16px',
          position: 'fixed'
        };
      },
      ResizeObserver: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
      MutationObserver: class {
        constructor(callback) {
          mutations.push(callback);
        }
        observe() {}
        disconnect() {}
      }
    })
  );
  const api = mount(win);
  const change = (
    liquid = values.get('--liquid-opacity'),
    frost = values.get('--frost-opacity')
  ) => {
    values.set('--liquid-opacity', String(liquid));
    values.set('--frost-opacity', String(frost));
    win.emit('album-appearance-change');
  };
  return {
    ...f,
    win,
    api,
    counts,
    hosts,
    change,
    mutate: (records) => mutations.forEach((callback) => callback(records))
  };
}

test('numeric range readouts do not rebuild the background scene, while real modal changes still do', () => {
  const f = materialMount();
  f.win.tick();
  const before = f.api.stats();
  const output = {
    nodeType: 1,
    closest: (selector) => (selector === '.appearance-range-control output' ? output : null)
  };
  for (let i = 0; i < 100; i++)
    f.mutate([
      { type: 'childList', target: output, addedNodes: [{ nodeType: 3 }], removedNodes: [] }
    ]);
  f.mutate([{ type: 'characterData', target: { nodeType: 3, parentElement: output } }]);
  f.win.tick();
  assert.equal(f.api.stats().sceneBuilds, before.sceneBuilds);
  assert.equal(f.api.stats().gpu.draws, before.gpu.draws);
  assert.equal(f.api.stats().pending, 0);
  f.mutate([
    {
      type: 'childList',
      target: {
        nodeType: 1,
        closest: (selector) => (selector === '.modal:not(.viewer)' ? {} : null)
      },
      addedNodes: [{ nodeType: 1 }],
      removedNodes: []
    }
  ]);
  f.win.tick();
  assert.equal(
    f.api.stats().sceneBuilds,
    before.sceneBuilds + 1,
    'Real modal content remains observable'
  );
  f.api.destroy();
});

test('material tokens clamp numeric alpha independently and preserve defaults', () => {
  assert.deepEqual(materialSettings(null), { liquidOpacity: 0.82, frostOpacity: 0.92 });
  assert.deepEqual(
    materialSettings({ getPropertyValue: (name) => (name.includes('liquid') ? '0' : '5') }),
    {
      liquidOpacity: 0.1,
      frostOpacity: 1
    }
  );
  assert.deepEqual(materialSettings({ getPropertyValue: () => 'invalid' }), {
    liquidOpacity: 0.82,
    frostOpacity: 0.92
  });
});

test('appearance bursts reuse canvases, context, geometry and scene; same-value events draw nothing', () => {
  const f = materialMount();
  f.win.tick();
  assert.equal(f.api.stats().gpu.draws, 2);
  assert.equal(f.counts.rootReads, 1);
  const baseline = f.api.stats();
  const counts = { ...f.counts };
  const canvases = f.hosts.map((host) => host.children[0]);
  for (let i = 0; i < 100; i++) f.change();
  f.win.tick();
  assert.equal(f.api.stats().gpu.draws, baseline.gpu.draws);
  assert.equal(f.api.stats().pending, 0);
  assert.deepEqual(f.counts, counts);
  for (let i = 0; i < 100; i++) f.change(0.2 + i / 200);
  assert.equal(f.api.stats().pending, 1, 'At most one scheduled batch per drag burst');
  assert.ok(f.win.frames.size <= 1);
  f.win.tick();
  const changed = f.api.stats();
  assert.equal(changed.gpu.draws, baseline.gpu.draws + 2);
  assert.equal(changed.sceneBuilds, baseline.sceneBuilds);
  assert.equal(changed.gpu.uploads, baseline.gpu.uploads);
  assert.equal(f.counts.contexts, 1);
  assert.equal(f.counts.canvases, counts.canvases);
  assert.equal(f.counts.hostReads, counts.hostReads, 'No new host style/layout pass');
  assert.equal(f.counts.rootReads, 2, 'One root style read for the entire changed batch');
  assert.deepEqual(
    f.hosts.map((host) => host.children[0]),
    canvases
  );
  const opacityCalls = f.calls.filter((call) => call[0] === 'uniform1f' && call[1] === 'opacity');
  assert.equal(opacityCalls.slice(-2).length, 2);
  for (const call of opacityCalls.slice(-2)) assert.ok(Math.abs(call[2] - 0.695) < 1e-12);
  for (let i = 0; i < 100; i++) f.change();
  f.win.tick();
  assert.equal(f.api.stats().gpu.draws, changed.gpu.draws);
  for (let i = 0; i < 100; i++) f.change(undefined, 0.1 + i / 110);
  f.win.tick();
  assert.equal(f.api.stats().gpu.draws, changed.gpu.draws, 'Frost is CSS-only');
  assert.equal(f.counts.rootReads, 2);
  assert.equal(f.api.stats().pending, 0);
  f.win.tick(1000);
  assert.equal(f.api.stats().gpu.draws, changed.gpu.draws, 'Idle material never self-schedules');
  f.api.destroy();
});

for (const options of [{ off: true }, { unavailable: true }, { reduced: true }])
  test(
    'material changes stay effective without context recreation: ' + JSON.stringify(options),
    () => {
      const f = materialMount(options);
      f.win.tick();
      const initialContexts = f.counts.contexts;
      f.change(0.3, 0.4);
      f.win.tick();
      const stats = f.api.stats();
      assert.deepEqual(stats.material, { liquidOpacity: 0.3, frostOpacity: 0.4, key: '0.3|0.4' });
      assert.equal(f.counts.contexts, initialContexts);
      if (options.off || options.unavailable) assert.equal(stats.gpu.draws || 0, 0);
      else {
        assert.equal(stats.gpu.draws, 4);
        assert.ok(
          f.calls.some(
            (call) => call[0] === 'uniform1f' && call[1] === 'opacity' && call[2] === 0.3
          )
        );
        assert.ok(
          f.calls.some(
            (call) => call[0] === 'uniform1f' && call[1] === 'strength' && call[2] === 0.45
          )
        );
      }
      for (let i = 0; i < 100; i++) f.change();
      f.win.tick();
      assert.equal(f.api.stats().gpu.draws, stats.gpu.draws);
      assert.equal(f.api.stats().pending, 0);
      f.api.destroy();
    }
  );

test('surface allowlist excludes cards and nested navigation filters', () => {
  assert.ok(surfaces.includes('.topbar > .navigation'));
  for (const forbidden of ['.album-card', '.cover-shell', '.toolbar-left', '.navigation-filters'])
    assert.ok(!surfaces.includes(forbidden));
});
