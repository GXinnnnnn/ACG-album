'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/display.js'), 'utf8');
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
function fixture() {
  const details = control(),
    buttons = [158, 186, 222].map((density) => control({ density: String(density) }));
  for (const button of [details, ...buttons]) button.classList.owner = button;
  const viewport = {
      scrollTop: 700,
      clientHeight: 600,
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
    '#back-to-top': back
  };
  const context = vm.createContext({
    S: { settings },
    grid,
    document: { documentElement: { dataset } },
    $: (selector) => elements[selector] || null,
    $$: (selector) => (selector === '[data-density]' ? buttons : previews),
    api: async (method, args) => events.push({ type: 'persist', method, ...args }),
    applySettings: () => vm.runInContext('applyDisplaySettings()', context)
  });
  vm.runInContext(source, context);
  return { context, settings, dataset, details, buttons, viewport, grid, events, previews };
}

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
