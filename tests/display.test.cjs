'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/display.js'), 'utf8');
const spec = require('../src/appearance-settings.cjs');
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function control(dataset = {}) {
  return {
    dataset,
    attributes: {},
    classes: new Set(),
    classList: {
      toggle(name, selected) {
        selected ? this.owner.classes.add(name) : this.owner.classes.delete(name);
      }
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    }
  };
}
function fixture(width = 3840, dpr = 1) {
  const details = control(),
    buttons = [128, 166, 195].map((density) => control({ density: String(density) }));
  for (const button of [details, ...buttons]) button.classList.owner = button;
  const viewport = {
      scrollTop: 700,
      clientHeight: 600,
      addEventListener() {},
      getBoundingClientRect: () => ({ top: 100 })
    },
    toolbar = { getBoundingClientRect: () => ({ bottom: 160 }) },
    back = {},
    dataset = {},
    settings = { density: 186, ratio: 'poster', details: true },
    events = [],
    previews = [],
    grid = {
      active: true,
      total: 180,
      captureAnchor(clearance) {
        events.push({ type: 'capture', scroll: viewport.scrollTop, clearance });
        return { index: 17, offset: 96 };
      },
      layout(render) {
        events.push({ type: 'layout', render, details: settings.details });
      },
      restoreAnchor(index, offset) {
        events.push({ type: 'restore', index, offset });
      },
      render() {
        events.push({ type: 'render' });
      }
    };
  const elements = {
    '#viewport': viewport,
    '#toolbar': toolbar,
    '#details-toggle': details,
    '#back-to-top': back,
    '#card-size-controls': { addEventListener() {} }
  };
  const styles = new Map(),
    listeners = new Map(),
    root = {
      clientWidth: width,
      dataset,
      style: { setProperty: (key, value) => styles.set(key, value) }
    };
  const context = vm.createContext({
    S: { settings },
    window: {
      albumAppearanceSpec: spec,
      innerWidth: width,
      devicePixelRatio: dpr,
      addEventListener: (name, callback) => listeners.set(name, callback)
    },
    grid,
    document: { documentElement: root },
    $: (selector) => elements[selector] || null,
    $$: (selector) => (selector === '[data-density]' ? buttons : previews),
    api: async (method, args) => events.push({ type: 'persist', method, ...args }),
    applySettings: () => vm.runInContext('applyDisplaySettings()', context)
  });
  vm.runInContext(source, context);
  return {
    context,
    settings,
    dataset,
    details,
    buttons,
    viewport,
    grid,
    events,
    previews,
    root,
    styles,
    listeners
  };
}

test('card presets select 128/166/195 and retain arbitrary saved widths', async () => {
  const f = fixture();
  const presets = vm.runInContext('cardDisplayPresets.map((preset) => preset.width)', f.context);
  assert.deepEqual([...presets], [128, 166, 195]);
  for (const width of [128, 166, 195, 222, 267]) {
    await f.context.changeDisplaySetting('density', width);
    assert.equal(f.settings.density, width);
    assert.equal(
      f.dataset.cardSize,
      width === 128 ? 'compact' : width === 195 ? 'large' : 'standard'
    );
    assert.deepEqual(
      f.buttons
        .filter((button) => button.attributes['aria-pressed'] === 'true')
        .map((button) => Number(button.dataset.density)),
      [128, 166, 195].includes(width) ? [width] : []
    );
  }
});

test('responsive preset selection uses CSS viewport widths without multiplying DPR', async () => {
  for (const [width, expected] of [
    [1920, [120, 155, 191]],
    [2560, [123, 159, 192]],
    [3840, [128, 166, 195]]
  ]) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const f = fixture(width, dpr);
      f.context.applyDisplaySettings();
      assert.deepEqual([...f.context.cardPresets()], expected);
      assert.deepEqual(
        f.buttons.map((button) => Number(button.dataset.density)),
        expected
      );
      assert.equal(f.styles.get('--card-base-size'), expected[1] + 'px');
      assert.equal(f.styles.get('--card-scale'), String(186 / expected[1]));
      for (const [index, density] of expected.entries()) {
        await f.context.changeDisplaySetting('density', density);
        assert.equal(f.settings.density, density);
        assert.equal(f.buttons[index].attributes['aria-pressed'], 'true');
        assert.equal(f.dataset.cardSize, ['compact', 'standard', 'large'][index]);
      }
    }
  }
});

test('resize updates existing preset objects and controls while preserving a saved continuous width', async () => {
  const f = fixture(3840),
    presets = vm.runInContext('cardDisplayPresets', f.context);
  f.settings.density = 222;
  f.context.applyDisplaySettings();
  f.context.initializeDisplayControls();
  const writes = f.events.length;
  f.root.clientWidth = 1920;
  f.listeners.get('resize')();
  assert.equal(vm.runInContext('cardDisplayPresets', f.context), presets);
  assert.deepEqual(
    [...presets].map((preset) => preset.width),
    [120, 155, 191]
  );
  assert.deepEqual(
    f.buttons.map((button) => Number(button.dataset.density)),
    [120, 155, 191]
  );
  assert.equal(f.settings.density, 222);
  assert.equal(f.events.length, writes, 'A resize neither persists nor relayouts a numeric width');
  assert.equal(f.styles.get('--card-scale'), String(222 / 155));
  assert.ok(f.buttons.every((button) => button.attributes['aria-pressed'] === 'false'));
  await f.context.changeDisplaySetting('density', Number(f.buttons[1].dataset.density));
  assert.equal(f.settings.density, 155);
  assert.equal(f.styles.get('--card-scale'), '1');
  assert.ok(f.events.some((event) => event.type === 'persist' && event.value === 155));
  f.root.clientWidth = 2560;
  f.context.applyDisplaySettings();
  assert.deepEqual(
    f.buttons.map((button) => Number(button.dataset.density)),
    [123, 159, 192]
  );
  assert.equal(f.settings.density, 155, 'An earlier preset choice remains the saved numeric value');
  assert.ok(f.buttons.every((button) => button.attributes['aria-pressed'] === 'false'));
});

test('details persist before capture so scrolling during a write stays authoritative', async () => {
  const f = fixture(),
    write = deferred();
  f.context.api = () => write.promise;
  const changing = f.context.changeDisplaySetting('details', false);
  await Promise.resolve();
  assert.equal(f.settings.details, true);
  assert.deepEqual(f.events, []);
  f.viewport.scrollTop = 1400;
  write.resolve();
  await changing;
  assert.equal(f.settings.details, false);
  assert.equal(f.dataset.mediaDetails, 'off');
  assert.equal(f.details.attributes['aria-pressed'], 'false');
  assert.equal(f.details.attributes['aria-label'], '显示卡片详情');
  assert.match(f.details.title, /相册附加信息/);
  assert.deepEqual(f.events, [
    { type: 'capture', scroll: 1400, clearance: 72 },
    { type: 'layout', render: false, details: false },
    { type: 'restore', index: 17, offset: 96 },
    { type: 'render' }
  ]);
  await f.context.changeDisplaySetting('details', true);
  assert.equal(f.dataset.mediaDetails, 'on');
  assert.equal(f.details.attributes['aria-pressed'], 'true');
});

test('a failed details write preserves the current view and later toggles still work', async () => {
  const f = fixture();
  f.context.applyDisplaySettings();
  f.context.api = async () => {
    throw new Error('settings write failed');
  };
  await assert.rejects(f.context.changeDisplaySetting('details', false), /settings write failed/);
  assert.equal(f.settings.details, true);
  assert.equal(f.dataset.mediaDetails, 'on');
  assert.deepEqual(f.events, []);
  f.context.api = async () => {};
  await f.context.changeDisplaySetting('details', false);
  assert.equal(f.dataset.mediaDetails, 'off');
});

test('expanded category previews preserve the visible card when hidden subtitles shrink earlier rows', async () => {
  const f = fixture();
  f.grid.active = false;
  let top = 220;
  const preview = {
    isConnected: true,
    getBoundingClientRect: () => ({ top, bottom: top + 300 })
  };
  f.previews.push({ getBoundingClientRect: () => ({ top: -300, bottom: 0 }) }, preview);
  f.context.applySettings = () => {
    f.context.applyDisplaySettings();
    top -= 30;
  };
  await f.context.changeDisplaySetting('details', false);
  assert.equal(f.viewport.scrollTop, 670);
  assert.equal(f.dataset.mediaDetails, 'off');
  assert.equal(
    f.events.some((event) => event.type === 'restore'),
    false
  );
});

test('invalid details values cannot persist or disturb layout', async () => {
  const f = fixture();
  for (const value of ['false', 0, null])
    await assert.rejects(f.context.changeDisplaySetting('details', value), /不支持的显示设置/);
  assert.equal(f.settings.details, true);
  assert.deepEqual(f.events, []);
});
