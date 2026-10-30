'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const spec = require('../src/appearance-settings.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/appearance.js'), 'utf8');
function harness(save = async () => {}) {
  let sequence = 0;
  const frames = new Map(),
    timers = new Map(),
    writes = [],
    events = [],
    errors = [],
    density = [],
    finishes = [];
  const root = { dataset: {}, style: { setProperty: (...args) => writes.push(args) } };
  const document = { documentElement: root, querySelectorAll: () => [] };
  const window = { albumAppearanceSpec: spec, dispatchEvent: (event) => events.push(event) };
  const context = vm.createContext({
    window,
    document,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    requestAnimationFrame: (callback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (callback) => {
      const id = ++sequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  vm.runInContext(source, context);
  const settings = { ...spec.defaults };
  const controller = window.albumAppearance.createController({
    settings: () => settings,
    save,
    notify: (...args) => errors.push(args),
    previewDensity: (value) => density.push(value),
    finishDensity: () => finishes.push(settings.density)
  });
  function tick(collection) {
    const tasks = [...collection.values()];
    collection.clear();
    tasks.forEach((f) => f());
  }
  return {
    controller,
    settings,
    window,
    writes,
    events,
    errors,
    frames,
    timers,
    root,
    density,
    finishes,
    frame: () => tick(frames),
    debounce: () => tick(timers)
  };
}
const turn = () => Promise.resolve().then(() => Promise.resolve());

test('appearance defaults/ranges reject invalid data and include all legacy presets', () => {
  assert.deepEqual(spec.defaults, {
    textShadow: false,
    liquidTransparency: 18,
    frostTransparency: 8,
    cardRadius: 16,
    density: 222
  });
  for (const width of [120, 158, 186, 222, 360]) assert.equal(spec.valid('density', width), true);
  for (const [key, range] of Object.entries(spec.ranges)) {
    for (const value of [NaN, Infinity, null, '18', range.min - 1, range.max + 1])
      assert.equal(spec.valid(key, value), false);
    assert.equal(spec.normalize({ [key]: -Infinity })[key], range.default);
  }
  assert.equal(spec.valid('textShadow', 'false'), false);
});

test('public apply writes only changed tokens and emits material events only for opacity changes', () => {
  const h = harness();
  h.window.albumAppearance.apply(spec.defaults);
  assert.equal(h.events.length, 1);
  assert.equal(h.writes.length, 3);
  for (let i = 0; i < 100; i++) h.window.albumAppearance.apply(spec.defaults);
  assert.equal(h.events.length, 1);
  assert.equal(h.writes.length, 3);
  h.window.albumAppearance.apply({ ...spec.defaults, cardRadius: 0, textShadow: true });
  assert.equal(h.events.length, 1);
  assert.equal(h.writes.length, 4);
  assert.equal(h.root.dataset.textShadow, 'on');
  h.window.albumAppearance.apply({
    ...spec.defaults,
    liquidTransparency: 90,
    frostTransparency: 0
  });
  assert.equal(h.events.length, 2);
  assert.ok(
    Math.abs(Number(h.writes.findLast(([key]) => key === '--liquid-opacity')[1]) - 0.1) < 1e-10
  );
  assert.equal(h.writes.findLast(([key]) => key === '--frost-opacity')[1], '1');
});

test('one frame previews the latest input; debounce coalesces IPC, finish commits density only once', async () => {
  const saves = [],
    h = harness(async (...args) => saves.push(args));
  for (let value = 223; value <= 300; value++) h.controller.set('density', value);
  assert.equal(h.frames.size, 1);
  assert.deepEqual(h.density, []);
  assert.deepEqual(saves, []);
  h.frame();
  assert.deepEqual(h.density, [300]);
  h.debounce();
  await turn();
  assert.deepEqual(saves, [['density', 300]]);
  assert.deepEqual(h.finishes, []);
  await h.controller.flush();
  await h.controller.flush();
  h.controller.set('density', 300);
  await h.controller.flush();
  assert.deepEqual(h.finishes, [300]);
  assert.deepEqual(saves, [['density', 300]]);
});

test('writes are serial, same-value change/blur adds no IPC, stale summary cannot overwrite pending or newer saved values', async () => {
  const saves = [],
    releases = [];
  let running = 0;
  const h = harness(
    (key, value) =>
      new Promise((resolve) => {
        assert.equal(++running, 1);
        saves.push([key, value]);
        releases.push(() => {
          running--;
          resolve();
        });
      })
  );
  const started = h.controller.snapshot();
  h.controller.set('cardRadius', 20);
  const task = h.controller.flush();
  await turn();
  h.controller.set('cardRadius', 20);
  void h.controller.flush();
  h.controller.set('cardRadius', 21);
  void h.controller.flush();
  h.controller.set('cardRadius', 36);
  void h.controller.flush();
  h.controller.set('liquidTransparency', 60);
  void h.controller.flush();
  assert.equal(
    h.controller.mergeSummary({ cardRadius: 16, liquidTransparency: 18 }, started).cardRadius,
    undefined
  );
  releases.shift()();
  await turn();
  assert.deepEqual(saves, [
    ['cardRadius', 20],
    ['cardRadius', 36]
  ]);
  releases.shift()();
  await turn();
  releases.shift()();
  await task;
  assert.deepEqual(saves, [
    ['cardRadius', 20],
    ['cardRadius', 36],
    ['liquidTransparency', 60]
  ]);
  assert.equal(h.settings.cardRadius, 36);
  assert.equal(h.controller.mergeSummary({ cardRadius: 16 }, started).cardRadius, undefined);
  assert.equal(
    h.controller.mergeSummary({ cardRadius: 36 }, h.controller.snapshot()).cardRadius,
    36
  );
});

test('failed IPC resolves with a visible error and retains local value for retry', async () => {
  let fails = true;
  const saves = [],
    h = harness(async (...args) => {
      saves.push(args);
      if (fails) throw new Error('disk full');
    });
  h.controller.set('frostTransparency', 45);
  await h.controller.flush();
  assert.match(h.errors[0][0], /disk full/);
  assert.equal(h.settings.frostTransparency, 45);
  assert.equal(
    h.controller.mergeSummary({ frostTransparency: 8 }, h.controller.snapshot()).frostTransparency,
    undefined
  );
  fails = false;
  await h.controller.flush();
  assert.deepEqual(saves, [
    ['frostTransparency', 45],
    ['frostTransparency', 45]
  ]);
});

test('range labels, readouts and reset contracts are present for both panels', () => {
  const h = harness(),
    html = h.window.albumAppearance.markup();
  for (const key of Object.keys(spec.ranges)) {
    assert.match(html, new RegExp(`data-appearance-key="${key}"`));
    assert.match(
      html,
      new RegExp(`data-appearance-reset="${key}" title="恢复默认值" aria-label="恢复默认值"`)
    );
  }
  assert.match(html, /label for="appearance-card-radius"/);
  assert.match(html, /aria-describedby="appearance-density-help appearance-density-value"/);
  assert.match(html, /0% 不透明，90% 更通透/);
  assert.match(h.window.albumAppearance.rangeMarkup('density', 'display'), /id="display-density"/);
});

// Reuse the existing VM fixture without registering/running the legacy test suite.
const masonryTestSource = fs.readFileSync(path.join(__dirname, 'masonry-layout.test.cjs'), 'utf8');
const fixture = vm.runInNewContext(
  masonryTestSource.slice(0, masonryTestSource.indexOf('function disjoint(')) + '\nfixture;',
  { require, __dirname, console, AbortController }
);
test('continuous virtual and overview widths stay top-left and clamp at narrow containers', async () => {
  for (const available of [90, 120, 700, 3448])
    for (const density of [120, 158, 186, 222, 267, 360]) {
      const f = await fixture(24, 0, available, density);
      assert.equal(f.grid.width, Math.min(available, density));
      assert.equal(f.grid.getPosition(0).left, 0);
      assert.equal(f.grid.getPosition(0).top, 0);
      const overview = f.context.overviewPreviewGeometry(available, density);
      assert.equal(overview.width, Math.min(available, density));
      assert.equal(overview.columns, f.grid.cols);
      f.grid.reset();
    }
});

test('density preview keeps card identity and thumbnail tier until release, preserving anchor', async () => {
  const f = await fixture(0, 180, 1180, 158, 2),
    { grid, settings } = f;
  const card = grid.cards.get(0),
    image = card.querySelector('img'),
    before = image.writes.length;
  const anchor = grid.captureAnchor();
  grid.previewThumbWidth = grid.width;
  for (const value of [180, 220, 280, 360]) {
    settings.density = value;
    grid.layout(false);
    grid.restoreAnchor(anchor.index, anchor.offset);
    grid.render();
    await f.settle();
    assert.equal(grid.cards.get(0), card);
    assert.equal(image.writes.length, before);
    assert.equal(grid.getPosition(anchor.index).top - f.viewport.scrollTop, anchor.offset);
  }
  grid.previewThumbWidth = 0;
  grid.render();
  assert.equal(grid.cards.get(0), card);
  assert.equal(image.writes.length, before + 1);
  grid.reset();
});

const overviewTestSource = fs.readFileSync(
  path.join(__dirname, 'overview-preview.test.cjs'),
  'utf8'
);
const overviewFixture = vm.runInNewContext(
  overviewTestSource.slice(0, overviewTestSource.indexOf("test('overview geometry")) + '\nfixture;',
  { require, __dirname }
);
test('overview preview changes geometry without requesting data or updating retained thumbnail widths until release', async () => {
  const f = overviewFixture(960, 158);
  f.document.documentElement.dataset = {};
  const initial = f.controller.render(f.preview, { id: 'collection' }, 1);
  f.reply(0);
  await initial;
  const retained = f.preview.children[0],
    width = retained.width,
    count = f.created.length;
  f.document.documentElement.dataset.densityPreview = 'on';
  for (const value of [180, 220, 280, 360]) {
    f.S.settings.density = value;
    f.controller.preview();
    f.mutations[0].callback([{ type: 'attributes' }]);
    await f.frame();
    assert.equal(f.requests.length, 1);
    assert.equal(f.created.length, count);
    assert.equal(retained.width, width);
    assert.equal(f.preview.children[0], retained);
  }
  f.document.documentElement.dataset.densityPreview = 'off';
  const finished = f.controller.refresh();
  assert.equal(f.requests.length, 2);
  f.reply(1);
  await finished;
  assert.equal(f.preview.children[0], retained);
  assert.equal(retained.width, 360);
  assert.equal(f.errors.length, 0);
});

function delayedDisplayHarness() {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/display.js'), 'utf8');
  const listeners = new Set(),
    restored = [],
    refreshes = [],
    errors = [];
  const viewport = {
    scrollTop: 100,
    addEventListener(type, callback) {
      assert.equal(type, 'scroll');
      listeners.add(callback);
    },
    removeEventListener(type, callback) {
      assert.equal(type, 'scroll');
      listeners.delete(callback);
    }
  };
  const context = vm.createContext({
    viewport,
    restored,
    document: { documentElement: { dataset: {}, style: { setProperty() {} } } },
    grid: { width: 222, render() {}, layout() {} },
    viewKey: () => 'same-view',
    $: () => viewport,
    toast: (error) => errors.push(error),
    overviewPreviewController: {
      preview() {},
      refresh: () => new Promise((resolve, reject) => refreshes.push({ resolve, reject }))
    }
  });
  vm.runInContext(
    source +
      `
    captureDisplayAnchor = () => ({ kind: 'scroll', scroll: viewport.scrollTop });
    restoreDisplayAnchor = (anchor) => { restored.push(anchor.scroll); viewport.scrollTop = anchor.scroll; };
    applyDisplaySettings = () => {};
  `,
    context
  );
  return {
    context,
    viewport,
    restored,
    refreshes,
    listeners,
    errors,
    preview: (value = 280) => context.previewDisplayDensity(value),
    finish: () => context.finishDisplayDensity(),
    scroll: (value) => {
      viewport.scrollTop = value;
      for (const listener of listeners) listener();
    }
  };
}

test('delayed overview refresh preserves user scrolling after density release', async () => {
  const h = delayedDisplayHarness();
  h.preview();
  h.finish();
  assert.equal(h.listeners.size, 1);
  h.scroll(700);
  h.refreshes[0].resolve();
  await turn();
  assert.equal(h.viewport.scrollTop, 700);
  assert.deepEqual(h.restored, [100]);
  assert.equal(h.listeners.size, 0);
});

test('a new density preview invalidates the earlier delayed restoration and its listener', async () => {
  const h = delayedDisplayHarness();
  h.preview();
  h.finish();
  h.scroll(700);
  h.preview(320);
  assert.equal(h.listeners.size, 0);
  h.finish();
  h.refreshes[0].resolve();
  await turn();
  assert.equal(h.viewport.scrollTop, 700);
  assert.deepEqual(h.restored, [100, 700]);
  assert.equal(h.listeners.size, 1);
  h.refreshes[1].resolve();
  await turn();
  assert.deepEqual(h.restored, [100, 700, 700]);
  assert.equal(h.listeners.size, 0);
});

test('unchanged viewport still restores the anchor and failed refresh releases its listener', async () => {
  const h = delayedDisplayHarness();
  h.preview();
  h.finish();
  h.refreshes[0].resolve();
  await turn();
  assert.deepEqual(h.restored, [100, 100]);
  assert.equal(h.listeners.size, 0);
  h.preview(360);
  h.finish();
  h.refreshes[1].reject(new Error('overview failed'));
  await turn();
  assert.equal(h.errors[0], 'overview failed');
  assert.equal(h.listeners.size, 0);
});

test('worker persists five appearance keys across restart and rejects malformed settings', async (t) => {
  const { Worker } = require('node:worker_threads');
  const os = require('node:os');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-appearance-focused-'));
  let worker;
  t.after(async () => {
    if (worker) await worker.terminate();
    assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(data).startsWith('acg-appearance-focused-'));
    fs.rmSync(data, { recursive: true, force: true });
  });
  async function open() {
    worker = new Worker(path.join(__dirname, '../src/library-worker.cjs'), {
      workerData: { dataDir: data, watch: false }
    });
    const pending = new Map();
    let sequence = 0;
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const request = pending.get(message.request);
        if (request) {
          pending.delete(message.request);
          message.error
            ? request.reject(new Error(message.error))
            : request.resolve(message.result);
        }
      });
    });
    return (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++sequence;
        pending.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
  }
  let call = await open();
  const initial = (await call('init')).settings;
  for (const [key, value] of Object.entries(spec.defaults)) assert.equal(initial[key], value);
  const changed = {
    textShadow: true,
    liquidTransparency: 90,
    frostTransparency: 0,
    cardRadius: 0,
    density: 360
  };
  for (const [key, value] of Object.entries(changed)) await call('settings', { key, value });
  for (const [key, value] of [
    ['textShadow', 1],
    ['density', 119],
    ['cardRadius', -1],
    ['liquidTransparency', 91],
    ['frostTransparency', '8']
  ])
    await assert.rejects(call('settings', { key, value }), /外观设置值无效/);
  await call('shutdown');
  await worker.terminate();
  call = await open();
  const saved = (await call('init')).settings;
  for (const [key, value] of Object.entries(changed)) assert.equal(saved[key], value);
  await call('shutdown');
});
