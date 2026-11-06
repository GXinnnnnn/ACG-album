'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../src/ui/app.js');
const source = fs.readFileSync(filename, 'utf8');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
function section(start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `source section ${start} must exist`);
  return source.slice(a, b);
}
function element() {
  return {
    textContent: '',
    title: '',
    scrollTop: 0,
    dataset: {},
    style: {},
    open: false,
    classList: { toggle() {} },
    replaceChildren() {},
    insertAdjacentHTML() {},
    setAttribute(name, value) {
      this[name] = value;
    },
    getAttribute(name) {
      return this[name] ?? null;
    },
    removeAttribute(name) {
      delete this[name];
    }
  };
}
function startupHarness({ statsReject = false, densityConfigured, density = 222 } = {}) {
  const nodes = new Map(),
    frames = [],
    timers = [],
    calls = [],
    painted = [],
    index = [];
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const S = {
    settings: { density: 222 },
    roots: [],
    history: [],
    view: 'library',
    filter: '',
    search: '',
    parent: null,
    loadVersion: 0
  };
  const init = {
    roots: [{ id: 'root-1', name: '缓存相册' }],
    settings: { density, densityConfigured },
    stats: null,
    localIndex: null,
    dataDir: 'C:\\test-profile'
  };
  let resolveIndex;
  const context = vm.createContext({
    S,
    $: node,
    $$: () => [],
    fmt: String,
    bytes: String,
    document: { documentElement: { clientWidth: 1920 } },
    cardPresets(width) {
      assert.equal(width, 1920);
      return [120, 155, 191];
    },
    window: {
      albumAppearanceControls: {
        snapshot() {
          return 0;
        },
        mergeSummary(s) {
          return s;
        }
      },
      albumLocalSearch: {
        setStatus(value) {
          index.push(value);
        }
      }
    },
    requestAnimationFrame(callback) {
      frames.push(callback);
    },
    setTimeout(callback) {
      timers.push(callback);
    },
    updateSidebar() {},
    applySettings() {},
    updateRefreshBusy() {},
    updateFilterIndicator() {},
    updateMediaView() {},
    renderBreadcrumbs() {},
    renderIntro() {},
    renderEmpty() {},
    setResultCount() {},
    updateScrollActions() {},
    isOverview: () => false,
    grid: {
      reset() {},
      async load() {
        painted.push('cached-card');
        return 1;
      }
    },
    queryArgs: () => ({}),
    api(command, args) {
      calls.push({ command, args });
      if (command === 'init') return Promise.resolve(init);
      if (command === 'statistics')
        return statsReject
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({ images: 1234, folders: 12 });
      if (command === 'localIndexStatus')
        return new Promise((resolve) => {
          resolveIndex = resolve;
        });
      throw new Error(`unexpected API ${command}`);
    }
  });
  new vm.Script(
    section('function viewKey()', 'function snapshot()') +
      section('let summarySettingsApplied = false', 'let filterResizeObserver'),
    { filename }
  ).runInContext(context);
  return {
    context,
    S,
    calls,
    painted,
    index,
    frames,
    timers,
    node,
    resolveIndex: (v) => resolveIndex(v)
  };
}

test('cached cards load with lightweight init before optional statistics/index work; explicit density survives', async () => {
  const h = startupHarness();
  await h.context.loadSummary();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [
    { command: 'init', args: { lightweight: true } }
  ]);
  assert.equal(h.S.dataDir, 'C:\\test-profile');
  assert.equal(h.S.settings.density, 222);
  await h.context.loadPage();
  assert.deepEqual(h.painted, ['cached-card']);
  assert.equal(h.calls.length, 1, 'no COUNT or local index work may precede the cached page');
  h.frames.shift()();
  assert.equal(h.calls.length, 1, 'optional work waits for the paint task boundary');
  h.timers.shift()();
  await nextTurn();
  assert.deepEqual(
    h.calls.map((c) => c.command),
    ['init', 'statistics', 'localIndexStatus']
  );
  assert.equal(h.node('#index-count').textContent, '1234 个媒体项目已索引');
  assert.equal(h.node('#index-status').textContent, '12 个文件夹 · 索引已保存');
  assert.deepEqual(h.index, [], 'a slow local index must not block statistics');
  h.resolveIndex({ available: true });
  await nextTurn();
  assert.equal(h.index[0].available, true);
});

test('optional statistics failure leaves real cached content visible and local index independent', async () => {
  const h = startupHarness({ statsReject: true });
  await h.context.loadSummary();
  await h.context.loadPage();
  h.frames.shift()();
  h.timers.shift()();
  await nextTurn();
  h.resolveIndex({ available: false });
  await nextTurn();
  assert.deepEqual(h.painted, ['cached-card']);
  assert.equal(h.index[0].available, false);
});

test('only an explicitly unconfigured density adopts responsive medium in memory', async () => {
  const fresh = startupHarness({ densityConfigured: false, density: 166 });
  await fresh.context.loadSummary();
  assert.equal(fresh.S.settings.density, 155);
  assert.equal(fresh.S.settings.densityConfigured, false);
  const writes = [];
  fresh.context.window.albumAppearanceSpec = require('../src/appearance-settings.cjs');
  fresh.context.window.dispatchEvent = () => {};
  fresh.context.CustomEvent = class {};
  fresh.context.document.documentElement.style = { setProperty() {} };
  fresh.context.document.documentElement.dataset = {};
  fresh.context.document.querySelectorAll = () => [];
  fresh.context.clearTimeout = () => {};
  fresh.context.cancelAnimationFrame = () => {};
  new vm.Script(fs.readFileSync(path.join(__dirname, '../src/ui/appearance.js'), 'utf8'), {
    filename: 'src/ui/appearance.js'
  }).runInContext(fresh.context);
  const controls = fresh.context.window.albumAppearance.createController({
    settings: () => fresh.S.settings,
    save: async (key, value) => writes.push([key, value])
  });
  fresh.context.window.albumAppearanceControls = controls;
  assert.deepEqual(writes, [], 'adopting the responsive default must not persist it');
  controls.set('density', 191);
  assert.equal(
    fresh.S.settings.densityConfigured,
    true,
    'a real user choice records intent immediately'
  );
  await controls.flush();
  await fresh.context.loadSummary();
  assert.equal(fresh.S.settings.density, 191, 'later summaries preserve the numeric user choice');
  assert.equal(fresh.S.settings.densityConfigured, true);
  assert.deepEqual(writes, [['density', 191]], 'the choice uses the real serial save controller');
  assert.ok(
    fresh.calls.every((call) => call.command === 'init'),
    'default selection never persists a setting'
  );
  for (const density of [166, 222]) {
    const saved = startupHarness({ densityConfigured: true, density });
    await saved.context.loadSummary();
    assert.equal(saved.S.settings.density, density, 'explicit legacy widths survive');
  }
});

function shortcutHarness() {
  const nodes = new Map([
    ['#viewer', element()],
    ['#modal', element()]
  ]);
  let handler,
    dialogOpen = false,
    refreshes = 0;
  const context = vm.createContext({
    document: {
      activeElement: null,
      addEventListener(type, callback) {
        handler = callback;
      },
      querySelector() {
        return dialogOpen ? {} : null;
      }
    },
    $: (selector) => nodes.get(selector),
    densityWheelEditing: (target) => !!target?.editing,
    attempt: (callback) => callback(),
    refreshLibrary() {
      refreshes++;
    },
    V: {},
    window: {},
    setMediaView() {},
    navigate() {},
    context: { hidden: true },
    S: { mediaView: 'grid' }
  });
  const shortcutStart = source.lastIndexOf("document.addEventListener('keydown', (e) => {");
  assert.ok(shortcutStart >= 0);
  const code = source.slice(
    shortcutStart,
    source.indexOf("window.addEventListener('error'", shortcutStart)
  );
  new vm.Script(code, { filename }).runInContext(context);
  function press(key, options = {}) {
    const event = {
      key,
      target: null,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...options
    };
    handler(event);
    return event;
  }
  return {
    context,
    press,
    nodes,
    setDialog(value) {
      dialogOpen = value;
    },
    refreshes: () => refreshes
  };
}

test('refresh shortcuts handle F5/Ctrl+R and leave editing, dialogs and the viewer untouched', () => {
  const h = shortcutHarness();
  assert.equal(h.press('F5').defaultPrevented, true);
  assert.equal(h.press('r', { ctrlKey: true }).defaultPrevented, true);
  assert.equal(h.refreshes(), 2);
  h.context.document.activeElement = { editing: true };
  assert.equal(h.press('F5').defaultPrevented, undefined);
  h.context.document.activeElement = null;
  assert.equal(
    h.press('r', { ctrlKey: true, target: { editing: true } }).defaultPrevented,
    undefined
  );
  h.setDialog(true);
  assert.equal(h.press('F5').defaultPrevented, undefined);
  h.setDialog(false);
  h.nodes.get('#viewer').open = true;
  assert.equal(h.press('F5').defaultPrevented, undefined);
  assert.equal(h.refreshes(), 2);
});

test('both refresh buttons share busy state, suppress duplicate scans, and preserve cards', async () => {
  const toolbar = element(),
    modal = element(),
    calls = [];
  let refreshView = 0,
    resolveRefresh;
  const context = vm.createContext({
    S: { roots: [{ id: 'root-1' }], parent: null },
    scanActive: false,
    pendingImport: null,
    isImportBusy: () => context.scanActive || !!context.pendingImport,
    setProgressAttribute(node, name, value) {
      if (node.getAttribute(name) !== String(value)) node.setAttribute(name, String(value));
    },
    $$: () => [toolbar, modal],
    api(command, args) {
      calls.push({ command, args });
      return new Promise((resolve) => {
        resolveRefresh = resolve;
      });
    },
    refreshGrowingView() {
      refreshView++;
    },
    toast() {},
    loadPage() {
      assert.fail('incremental refresh must preserve the page');
    }
  });
  new vm.Script(section('let libraryRefreshBusy = false;', 'function densityModal()'), {
    filename
  }).runInContext(context);
  const pending = context.refreshLibrary();
  assert.equal(toolbar.disabled, true);
  assert.equal(modal['aria-busy'], 'true');
  await context.refreshLibrary();
  assert.equal(calls.length, 1);
  resolveRefresh();
  await pending;
  assert.equal(refreshView, 1);
  assert.equal(toolbar.disabled, false);
  assert.equal(modal['aria-busy'], 'false');
  context.scanActive = true;
  context.updateRefreshBusy();
  assert.equal(toolbar.disabled, true);
  await context.refreshLibrary();
  assert.equal(calls.length, 1);
});

test('toolbar offers one refresh after density with compact defaults and no global thumbnail invalidation', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/ui/styles.css'), 'utf8');
  assert.equal([...html.matchAll(/id="refresh-button"/g)].length, 1);
  assert.match(html, /id="density-button"[\s\S]*?<\/button\s*><button\s+id="refresh-button"/);
  assert.deepEqual(
    [...html.matchAll(/data-density="(\d+)"/g)].map((m) => Number(m[1])),
    [128, 166, 195]
  );
  assert.match(css, /--card-width:\s*166px/);
  assert.doesNotMatch(source, /S\.rev\s*=\s*Date\.now\(\)/);
});
