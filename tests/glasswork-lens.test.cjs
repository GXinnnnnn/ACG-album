'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../src/ui/vendor/glasswork-lens.js');
const { mount, surfaces, nativeSurfaces } = require('../src/ui/liquid-glass.js');
const flush = () => new Promise(setImmediate);

function fixture() {
  const decodes = [],
    nodes = [],
    values = new Map();
  const element = (tag) => ({
    tag,
    attributes: {},
    children: [],
    parent: null,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    append(child) {
      child.parent = this;
      this.children.push(child);
    },
    remove() {
      if (this.parent)
        this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    }
  });
  const win = {
    CSS: { supports: () => true },
    navigator: { userAgent: 'Chrome/140.0.0.0' },
    Image: class {
      decode() {
        return new Promise((resolve, reject) => decodes.push({ resolve, reject, src: this.src }));
      }
    }
  };
  let canvases = 0;
  const doc = {
    defaultView: win,
    body: element('body'),
    createElement(tag) {
      assert.equal(tag, 'canvas');
      canvases++;
      return {
        getContext(kind) {
          assert.equal(kind, '2d', 'Native hosts never request WebGL');
          return {
            createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
            putImageData() {}
          };
        },
        toDataURL: () => 'data:image/png;base64,small-map'
      };
    },
    createElementNS(ns, tag) {
      const node = element(tag);
      nodes.push(node);
      return node;
    }
  };
  win.document = doc;
  const host = {
    ownerDocument: doc,
    isConnected: true,
    style: {
      setProperty: (key, value) => values.set(key, value),
      removeProperty: (key) => values.delete(key)
    }
  };
  return {
    win,
    doc,
    host,
    values,
    nodes,
    decodes,
    canvases: () => canvases,
    resolve: () => decodes.splice(0).forEach((item) => item.resolve())
  };
}
const geometry = { width: 200, height: 100, radius: 20 };

test('Chromium detection and bounded geometry keep large viewers and malformed options out', () => {
  const f = fixture();
  assert.equal(kit.isLensSupported(f.win), true);
  assert.equal(kit.isLensSupported({ ...f.win, navigator: { userAgent: 'Firefox/140' } }), false);
  assert.equal(kit.isLensSupported({ ...f.win, CSS: { supports: () => false } }), false);
  assert.equal(kit.lensGeometry({ width: 1920, height: 1080 }).enabled, false);
  assert.equal(kit.lensGeometry({ width: 31, height: 100 }).enabled, false);
  const bounded = kit.lensGeometry({ ...geometry, radius: 1e6, rim: 1e6, corner: 1e6, edge: 1e6 });
  assert.equal(bounded.radius, 50);
  assert.equal(bounded.bezel, 24);
  assert.equal(bounded.corner, 8);
  assert.equal(bounded.edge, 1);
  assert.equal(kit.LENS_DEFAULTS.dispersion, 0, 'Trial has one displacement pass');
  assert.equal(nativeSurfaces, '.toolbar-right,.context-menu,.album-select-list');
});

test('rim map bends opposite edges inward while leaving the middle flat', () => {
  const g = { bezel: 12, radius: 20, corner: 2, power: 2.6 };
  assert.deepEqual(kit.rimDisplacement(100, 50, 200, 100, g), [0, 0]);
  const left = kit.rimDisplacement(1, 50, 200, 100, g);
  const right = kit.rimDisplacement(199, 50, 200, 100, g);
  assert.ok(left[0] > 0 && right[0] < 0);
  assert.ok(Math.abs(left[0] + right[0]) < 1e-9);
  const corner = kit.rimDisplacement(8, 8, 200, 100, g);
  assert.ok(corner[0] > 0 && corner[1] > 0);
});

test('data map cache shares pending work, bounds LRU entries and permits retry after failure', async () => {
  const cache = kit.createTileCache(2);
  let builds = 0;
  const build = () => ++builds;
  const a = cache.get('a', build);
  assert.equal(cache.get('a', build), a);
  await a;
  await cache.get('b', build);
  await cache.get('a', build);
  await cache.get('c', build);
  assert.equal(cache.size(), 2);
  await cache.get('b', build);
  assert.equal(builds, 4, 'Least recently used entry was evicted');
  await assert.rejects(
    cache.get('bad', () => {
      throw new Error('decode failed');
    })
  );
  assert.equal(await cache.get('bad', () => 'retried'), 'retried');
});

test('destroy or disable during decode cannot append an SVG or restore the property', async () => {
  for (const action of ['destroy', 'disable', 'cancel']) {
    const f = fixture();
    const lens = kit.createLens(f.host);
    const pending = lens.update(geometry);
    await flush();
    assert.equal(f.decodes.length, 8);
    assert.ok(f.decodes.every((item) => item.src.startsWith('data:image/png;')));
    assert.equal(f.doc.body.children.length, 0, 'Filter waits for all PNGs to decode');
    if (action === 'destroy') lens.destroy();
    else if (action === 'disable') await lens.update({ ...geometry, enabled: false });
    else lens.cancelPending();
    f.resolve();
    assert.equal(await pending, false);
    assert.equal(f.doc.body.children.length, 0);
    assert.equal(f.values.size, 0);
    if (action === 'destroy') assert.equal(await lens.update(geometry), false);
    lens.destroy();
  }
});

test('latest resize wins; decoded maps are reused and destroy removes a ready filter', async () => {
  const f = fixture();
  const lens = kit.createLens(f.host);
  const old = lens.update(geometry);
  await flush();
  const latest = lens.update({ ...geometry, width: 300 });
  f.resolve();
  assert.equal(await old, false);
  assert.equal(await latest, true);
  assert.equal(f.doc.body.children.length, 1);
  const filter = f.nodes.find((node) => node.tag === 'filter');
  assert.equal(filter.attributes.width, '300');
  assert.equal(f.nodes.filter((node) => node.tag === 'feDisplacementMap').length, 1);
  assert.equal(f.canvases(), 8);
  await lens.update({ ...geometry, width: 400 });
  assert.equal(filter.attributes.width, '400');
  assert.equal(f.canvases(), 8, 'Resize repositions nine-slice tiles without re-encoding');
  assert.match(f.values.get('--glass-lens'), /^url\(#liquid-glass-lens-/);
  lens.destroy();
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(f.values.size, 0);
});

test('decode rejection is caught and leaves the CSS backdrop available', async () => {
  const f = fixture();
  const lens = kit.createLens(f.host);
  const pending = lens.update(geometry);
  await flush();
  f.decodes.splice(0).forEach((item) => item.reject(new Error('blocked map')));
  assert.equal(await pending, false);
  assert.equal(lens.stats().state, 'css-fallback');
  assert.equal(lens.stats().error, 'blocked map');
  assert.equal(f.values.size, 0);
  assert.equal(f.doc.body.children.length, 0);
  lens.destroy();
});

function events(value = {}) {
  const listeners = new Map();
  return Object.assign(value, {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, value = {}) {
      for (const fn of listeners.get(type) || []) fn(value);
    }
  });
}

test('mount uses its existing scheduler, creates no GL for native-only hosts and restores after off/low/suspend', async () => {
  const f = fixture();
  const frames = new Map(),
    media = new Map();
  let nextFrame = 0,
    clock = 0;
  Object.assign(f.host, {
    dataset: {},
    matches: (selector) => selector === nativeSurfaces,
    closest: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 200,
      bottom: 100,
      width: 200,
      height: 100
    }),
    getClientRects: () => [{}]
  });
  const tokens = new Map();
  const root = {
    dataset: { liquidGlass: 'on', motion: 'high', theme: 'light' },
    style: { getPropertyValue: (name) => tokens.get(name) || '' }
  };
  Object.assign(events(f.doc), {
    documentElement: root,
    hidden: false,
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === surfaces ? [f.host] : [])
  });
  Object.assign(events(f.win), {
    albumGlassworkLens: kit,
    innerWidth: 1000,
    innerHeight: 800,
    performance: { now: () => (clock += 100) },
    getComputedStyle: (node) =>
      node === root
        ? root.style
        : {
            visibility: 'visible',
            opacity: '1',
            borderTopLeftRadius: '20px',
            position: 'relative',
            getPropertyValue: () => ''
          },
    matchMedia(query) {
      if (!media.has(query)) media.set(query, events({ matches: false }));
      return media.get(query);
    },
    requestAnimationFrame(fn) {
      frames.set(++nextFrame, fn);
      return nextFrame;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    setTimeout() {
      throw new Error('No repeated timer expected');
    },
    clearTimeout() {},
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    }
  });
  const run = async () => {
    for (const [id, callback] of [...frames]) {
      frames.delete(id);
      callback();
    }
    await flush();
    f.resolve();
    await flush();
  };
  const api = mount(f.win);
  await run();
  assert.equal(api.stats().native.ready, 1);
  assert.equal(api.stats().gpu.status, 'uninitialized');
  assert.equal(api.stats().sceneBuilds, 0);
  assert.equal(api.stats().proxyHosts, 0);
  assert.equal(api.stats().sampleMode, 'real-background-backdrop');
  assert.equal(frames.size, 0, 'Idle native lens schedules no RAF');
  const displacement = f.nodes.find((node) => node.tag === 'feDisplacementMap');
  const fullScale = Number(displacement.attributes.scale),
    nodeCount = f.nodes.length,
    canvasCount = f.canvases();
  for (const alpha of [0.41, 0, 0.82]) {
    tokens.set('--liquid-opacity', String(alpha));
    f.win.emit('album-appearance-change');
    await run();
    assert.ok(Math.abs(Number(displacement.attributes.scale) - (fullScale * alpha) / 0.82) < 0.11);
    assert.equal(f.nodes.length, nodeCount, 'Transparency reuses the ready SVG filter');
    assert.equal(f.canvases(), canvasCount, 'Transparency does not regenerate maps');
    assert.equal(frames.size, 0);
  }
  for (const state of ['off', 'low', 'suspend', 'hidden', 'opaque']) {
    if (state === 'off') root.dataset.liquidGlass = 'off';
    else if (state === 'low') root.dataset.motion = 'low';
    else if (state === 'suspend') api.suspend(true);
    else if (state === 'hidden') f.doc.hidden = true;
    else media.get('(prefers-reduced-transparency: reduce)').emit('change', { matches: true });
    f.win.emit('album-effects-change');
    assert.equal(api.stats().native.hosts, 0, state);
    assert.equal(f.doc.body.children.length, 0, state);
    root.dataset.liquidGlass = 'on';
    root.dataset.motion = 'high';
    f.doc.hidden = false;
    media.get('(prefers-reduced-transparency: reduce)').emit('change', { matches: false });
    api.suspend(false);
    await run();
    assert.equal(api.stats().native.ready, 1, 'Restored after ' + state);
  }
  api.destroy();
  assert.equal(f.doc.body.children.length, 0);
  assert.equal(frames.size, 0);
});
