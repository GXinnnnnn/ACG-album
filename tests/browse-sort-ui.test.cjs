'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const moduleSource = fs.readFileSync(path.join(__dirname, '../src/ui/browse-sort.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
const menusSource = fs.readFileSync(path.join(__dirname, '../src/ui/menus.js'), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
function section(source, start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
function fixture(save = async () => {}) {
  const context = vm.createContext({ window: {}, Promise, console });
  vm.runInContext(moduleSource, context);
  return {
    context,
    api: context.window.albumBrowseSort,
    memory: context.window.albumBrowseSort.create({ save })
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('canonical scope separates views and folders; Windows drive, UNC and long escaped Unicode paths agree', () => {
  const { api } = fixture();
  assert.equal(
    api.scope('library', 'C:/Album/Child/../照片/'),
    JSON.stringify(['library', 'c:\\album\\照片'])
  );
  assert.equal(api.scope('library', 'C:\\'), JSON.stringify(['library', 'c:\\']));
  assert.equal(
    api.scope('library', '\\\\Server\\Share\\'),
    JSON.stringify(['library', '\\\\server\\share'])
  );
  assert.equal(api.scope('library', '\\\\?\\C:\\'), JSON.stringify(['library', '\\\\?\\c:\\']));
  assert.equal(
    api.scope('library', '\\\\?\\UNC\\Server\\Share\\'),
    JSON.stringify(['library', '\\\\?\\unc\\server\\share'])
  );
  const long = 'C:\\' + '目录\\'.repeat(900);
  assert.ok(api.scope('library', long));
  assert.equal(api.scope('library', 'relative'), null);
  assert.equal(api.scope('other', null), null);
  assert.notEqual(api.scope('library', null), api.scope('favorites', null));
});
test('parent, child, siblings and top-level views retain independent pairs across a new controller', async () => {
  let stored;
  const { api, memory } = fixture(async (v) => {
    stored = plain(v);
  });
  memory.set('library', 'C:\\Album', { sort: 'contentDate', direction: 'desc' });
  memory.set('library', 'C:\\Album\\Child', { sort: 'modified', direction: 'asc' });
  memory.set('favorites', 'C:\\Album', { sort: 'size', direction: 'desc' });
  await memory.flush();
  const restarted = api.create({
    save: async () => {
      throw Error('read must not write');
    }
  });
  assert.equal(restarted.hydrate(stored, restarted.beginRead()), true);
  assert.deepEqual(plain(restarted.get('library', 'c:/album/')), {
    sort: 'contentDate',
    direction: 'desc'
  });
  assert.deepEqual(plain(restarted.get('library', 'C:\\Album\\Child')), {
    sort: 'modified',
    direction: 'asc'
  });
  assert.deepEqual(plain(restarted.get('library', 'C:\\Album\\Sibling')), {
    sort: 'name',
    direction: 'asc'
  });
  assert.deepEqual(plain(restarted.get('favorites', 'C:\\Album')), {
    sort: 'size',
    direction: 'desc'
  });
});
test('whole-object saves serialize and include edits made while the first RPC is pending', async () => {
  const gate = deferred(),
    writes = [];
  let active = 0,
    maxActive = 0;
  const { memory } = fixture(async (v) => {
    active++;
    maxActive = Math.max(active, maxActive);
    writes.push(plain(v));
    if (writes.length === 1) await gate.promise;
    active--;
  });
  memory.set('library', null, { sort: 'size', direction: 'asc' });
  await Promise.resolve();
  memory.set('library', 'C:\\A', { sort: 'contentDate', direction: 'desc' });
  memory.set('pending', null, { sort: 'modified', direction: 'desc' });
  gate.resolve();
  await memory.flush();
  assert.equal(maxActive, 1);
  assert.equal(writes.length, 2);
  assert.equal(Object.keys(writes[1]).length, 3);
});
test('slow initial read merges local edits and queued renames with unrelated stored scopes before the first save', async () => {
  const { api } = fixture(),
    writes = [];
  const memory = api.create({ requireHydration: true, save: async (v) => writes.push(plain(v)) });
  const old = memory.beginRead();
  memory.set('library', null, { sort: 'contentDate', direction: 'desc' });
  memory.rename([{ oldPath: 'C:\\A', path: 'C:\\B' }]);
  await memory.flush();
  assert.equal(writes.length, 0);
  memory.hydrate(
    {
      [api.scope('library', null)]: { sort: 'date', direction: 'asc' },
      [api.scope('library', 'C:\\A\\Unopened')]: { sort: 'size', direction: 'desc' },
      [api.scope('favorites', null)]: { sort: 'modified', direction: 'asc' }
    },
    old
  );
  await memory.flush();
  assert.equal(memory.get('library').sort, 'contentDate');
  assert.equal(memory.get('library', 'C:\\B\\Unopened').sort, 'size');
  assert.equal(memory.get('favorites').sort, 'modified');
  assert.equal(Object.keys(writes.at(-1)).length, 3);
  assert.ok(!Object.hasOwn(writes.at(-1), api.scope('library', 'C:\\A\\Unopened')));
});
test('pending save and later slow reads preserve newest edits and merge untouched scopes', async () => {
  const gate = deferred();
  const { api, memory } = fixture(() => gate.promise);
  memory.set('library', null, { sort: 'size', direction: 'asc' });
  const read = memory.beginRead();
  memory.set('library', null, { sort: 'contentDate', direction: 'desc' });
  memory.hydrate(
    {
      [api.scope('library', null)]: { sort: 'name', direction: 'asc' },
      [api.scope('pending', null)]: { sort: 'date', direction: 'desc' }
    },
    read
  );
  gate.resolve();
  await memory.flush();
  assert.equal(memory.get('library').sort, 'contentDate');
  assert.equal(memory.get('pending').sort, 'date');
});
test('failed saves reject explicit flush and both flush and same-value set can retry without losing records', async () => {
  let fail = true;
  const writes = [],
    errors = [];
  const { api } = fixture();
  const memory = api.create({
    save: async (v) => {
      if (fail) throw Error('offline');
      writes.push(plain(v));
    },
    onError: (error) => errors.push(error.message)
  });
  memory.set('library', null, { sort: 'size', direction: 'desc' });
  await assert.rejects(memory.flush(), /offline/);
  fail = false;
  await memory.flush();
  assert.equal(writes.length, 1);
  fail = true;
  memory.set('pending', null, { sort: 'date', direction: 'asc' });
  await assert.rejects(memory.flush(), /offline/);
  fail = false;
  assert.equal(memory.set('pending', null, { sort: 'date', direction: 'asc' }), false);
  await memory.flush();
  assert.equal(Object.keys(writes.at(-1)).length, 2);
  assert.equal(errors.length, 2);
});
test('save-drain microtasks cannot leave a later choice dirty without another operation', async () => {
  const writes = [];
  const { memory } = fixture(async (v) => {
    writes.push(plain(v));
  });
  memory.set('library', null, { sort: 'size', direction: 'asc' });
  await Promise.resolve();
  await Promise.resolve();
  memory.set('library', null, { sort: 'contentDate', direction: 'desc' });
  await memory.flush();
  assert.equal(Object.values(writes.at(-1))[0].sort, 'contentDate');
});
test('manual or external ordered prefix renames migrate unopened descendants and preserve sibling boundaries', async () => {
  const { memory } = fixture();
  memory.set('library', 'C:\\A\\Deep\\Unopened', { sort: 'contentDate', direction: 'desc' });
  memory.set('favorites', 'C:\\A', { sort: 'date', direction: 'desc' });
  memory.set('library', 'C:\\AB', { sort: 'size', direction: 'asc' });
  memory.rename([
    { oldPath: 'C:\\A', path: 'C:\\B' },
    { oldPath: 'C:\\B', path: 'C:\\C', external: true }
  ]);
  await memory.flush();
  assert.equal(memory.get('library', 'C:\\C\\Deep\\Unopened').sort, 'contentDate');
  assert.equal(memory.get('favorites', 'C:\\C').sort, 'date');
  assert.equal(memory.get('library', 'C:\\AB').sort, 'size');
  assert.equal(memory.get('library', 'C:\\A\\Deep\\Unopened').sort, 'name');
});
test('1024-entry limit evicts the least recently used scope without changing valid saved choices', async () => {
  const { memory } = fixture();
  for (let i = 0; i < 1024; i++)
    memory.set('library', 'C:\\Folder' + i, { sort: 'size', direction: 'asc' });
  memory.get('library', 'C:\\Folder0');
  memory.set('library', 'C:\\Newest', { sort: 'contentDate', direction: 'desc' });
  await memory.flush();
  assert.equal(Object.keys(memory.snapshot()).length, 1024);
  assert.equal(memory.get('library', 'C:\\Folder0').sort, 'size');
  assert.equal(memory.get('library', 'C:\\Folder1').sort, 'name');
});
test('invalid, noncanonical and extra-field records are ignored without discarding valid records', () => {
  const { memory, api } = fixture();
  const value = {
    [api.scope('library', null)]: { sort: 'contentDate', direction: 'desc' },
    '["library","C:\\\\Bad"]': { sort: 'size', direction: 'asc' },
    [api.scope('library', 'C:\\Extra')]: { sort: 'date', direction: 'asc', extra: true },
    [api.scope('library', 'C:\\Unknown')]: { sort: 'unknown', direction: 'asc' }
  };
  memory.hydrate(value, memory.beginRead());
  assert.equal(Object.keys(memory.snapshot()).length, 1);
});
function appFixture() {
  const writes = [],
    nodes = new Map(),
    root = { id: 'root', path: 'C:\\Album', name: 'Album' },
    child = { id: 'child', path: 'C:\\Album\\Child', name: 'Child' };
  const { context, api } = fixture();
  const element = () => ({
    value: '',
    scrollTop: 0,
    style: {},
    classList: { toggle() {} },
    replaceChildren() {},
    insertAdjacentHTML() {},
    focus() {}
  });
  const $ = (key) => {
    if (!nodes.has(key)) nodes.set(key, element());
    return nodes.get(key);
  };
  const state = {
    view: 'library',
    parent: null,
    current: null,
    roots: [root],
    settings: {},
    sort: 'name',
    direction: 'asc',
    search: '',
    filter: 'all',
    history: [],
    scrolls: new Map(),
    loadVersion: 0
  };
  const calls = [],
    queries = [];
  Object.assign(context, {
    S: state,
    $,
    $$: () => [],
    grid: {
      items: new Map([[child.id, child]]),
      reset() {},
      hide() {},
      load: async (q) => {
        queries.push(plain(q));
        return 1;
      }
    },
    api: async (method, args) => {
      calls.push({ method, args });
      if (method === 'settings') {
        writes.push(plain(args.value));
        return;
      }
      if (method === 'get') return args.id === 'root' ? root : child;
      if (method === 'ancestors') return [];
    },
    toast() {},
    updateSidebar() {},
    updateRefreshBusy() {},
    updateFilterIndicator() {},
    updateMediaView() {},
    renderBreadcrumbs() {},
    renderIntro() {},
    setResultCount() {},
    renderEmpty() {},
    updateScrollActions() {},
    scheduleSummaryDetails() {},
    renderOverview: async () => {},
    fmt: String,
    bytes: String,
    isOverview: () => !state.parent
  });
  vm.runInContext(
    section(appSource, 'if (!window.albumBrowseSort?.create)', 'function queryArgs()') +
      section(appSource, 'function queryArgs()', 'function viewKey()') +
      section(appSource, 'function viewKey()', 'function updateSidebar()') +
      section(appSource, 'async function loadPage(', 'let filterResizeObserver;'),
    context
  );
  vm.runInContext('browseSortMemory.hydrate({}, browseSortMemory.beginRead())', context);
  return { context, state, $, writes, calls, queries, root, child, api };
}
test('actual navigation restores saved parent/child before list; search and filters retain the same scope', async () => {
  const h = appFixture();
  await vm.runInContext("changeBrowseSort('contentDate','desc')", h.context);
  await vm.runInContext("navigate({parent:'root'})", h.context);
  assert.equal(h.state.sort, 'name');
  await vm.runInContext("changeBrowseSort('modified','desc');", h.context);
  await vm.runInContext("navigate({parent:'child'})", h.context);
  assert.equal(h.state.sort, 'contentDate');
  assert.equal(h.state.direction, 'desc');
  await vm.runInContext("changeBrowseSort('size','asc')", h.context);
  h.state.search = 'image';
  h.state.filter = 'images';
  await vm.runInContext('loadPage()', h.context);
  assert.equal(h.queries.at(-1).sort, 'size');
  await vm.runInContext('back()', h.context);
  assert.equal(h.state.parent, 'root');
  assert.equal(h.state.sort, 'modified');
  assert.equal(h.state.direction, 'desc');
  await vm.runInContext('back()', h.context);
  assert.equal(h.state.parent, null);
  assert.equal(h.state.sort, 'contentDate');
  assert.ok(h.calls.some((c) => c.method === 'filesystemSync'));
  assert.ok(h.writes.length);
});
test('unknown deep path waits for its real node without writing overview; stale navigation cancels it', async () => {
  const h = appFixture(),
    gate = deferred(),
    baseApi = h.context.api;
  h.state.parent = 'deep';
  h.state.current = null;
  h.context.api = (method, args) =>
    method === 'get' && args.id === 'deep' ? gate.promise : baseApi(method, args);
  const pending = vm.runInContext("changeBrowseSort('contentDate','desc')", h.context);
  await Promise.resolve();
  assert.equal(h.writes.length, 0);
  const deepPath = 'C:/Album/Deep';
  gate.resolve({ id: 'deep', path: deepPath, name: 'Deep' });
  await pending;
  assert.ok(!Object.hasOwn(h.writes.at(-1), h.api.scope('library', null)));
  assert.equal(h.writes.at(-1)[h.api.scope('library', deepPath)].sort, 'contentDate');
  const late = deferred();
  h.state.parent = 'other';
  h.state.current = null;
  h.context.api = (method, args) =>
    method === 'get' && args.id === 'other' ? late.promise : baseApi(method, args);
  const stale = vm.runInContext("changeBrowseSort('size','asc')", h.context);
  h.state.parent = null;
  h.state.loadVersion++;
  const count = h.writes.length;
  late.resolve({ id: 'other', path: 'C:/Other' });
  await stale;
  assert.equal(h.writes.length, count);
});
test('viewer-open external rename saves preferences before any deferred navigation or viewer close', async () => {
  const h = appFixture();
  vm.runInContext(
    "browseSortMemory.set('library','C:/A/Unopened',{sort:'contentDate',direction:'desc'})",
    h.context
  );
  vm.runInContext(
    section(appSource, 'let structuralDirty =', 'function flushStructuralChanges()'),
    h.context
  );
  h.$('#viewer').open = true;
  h.context.renameEvent = {
    renames: [{ renamed: true, external: true, oldId: 'a', oldPath: 'C:/A', path: 'C:/B' }]
  };
  vm.runInContext('rememberStructuralChange(renameEvent)', h.context);
  await vm.runInContext('browseSortMemory.flush()', h.context);
  assert.equal(h.writes.at(-1)[h.api.scope('library', 'C:/B/Unopened')].sort, 'contentDate');
  assert.ok(!Object.hasOwn(h.writes.at(-1), h.api.scope('library', 'C:/A/Unopened')));
  assert.equal(h.$('#viewer').open, true);
});
test('timeline defaults to date descending but independently saves every explicit sort and direction', async () => {
  const h = appFixture();
  h.state.view = 'timeline';
  await vm.runInContext('loadPage()', h.context);
  assert.equal(h.state.sort, 'contentDate');
  assert.equal(h.state.direction, 'desc');
  await vm.runInContext("changeBrowseSort('name','asc')", h.context);
  assert.equal(h.state.sort, 'name');
  assert.equal(vm.runInContext('queryArgs().direction', h.context), 'asc');
  assert.equal(h.queries.at(-1).sort, 'name');
  assert.equal(h.queries.at(-1).timeline, true);
  assert.ok(h.writes.length);
});
test('summary changes to sort preferences never reapply appearance settings', async () => {
  const h = appFixture();
  let applied = 0;
  h.state.settings = { density: 166, theme: 'dark', browseSortPreferences: {} };
  Object.assign(h.context, {
    summaryDetailsDirty: false,
    summaryDetailsVersion: 0,
    summarySettingsApplied: true,
    renderSummaryStats() {},
    applySettings() {
      applied++;
    },
    api: async () => ({
      roots: [h.root],
      settings: {
        density: 166,
        theme: 'dark',
        browseSortPreferences: {
          [h.api.scope('library', null)]: { sort: 'contentDate', direction: 'desc' }
        }
      },
      stats: null
    })
  });
  h.context.window.albumAppearanceControls = {
    snapshot: () => 0,
    mergeSummary: (settings) => settings
  };
  vm.runInContext(
    section(appSource, 'async function loadSummary()', 'async function loadPage('),
    h.context
  );
  await vm.runInContext('loadSummary()', h.context);
  assert.equal(applied, 0);
  assert.equal(
    h.state.settings.browseSortPreferences[h.api.scope('library', null)].sort,
    'contentDate'
  );
});
test('overview date preserves content_date including zero; folders prefer birth then mtime while media keeps the filesystem minimum', () => {
  const compareSection = section(appSource, '  const k = {', '  const existing = new Map(');
  const roots = [
    { id: 'a', name: 'A', kind: 'folder', content_date: 50, birth: 900, mtime: 100 },
    { id: 'b', name: 'B', kind: 'folder', birth: 70, mtime: 20 },
    { id: 'c', name: 'C', kind: 'folder', content_date: 0, birth: 1, mtime: 1 },
    { id: 'd', name: 'D', kind: 'folder', birth: 0, mtime: 30 },
    { id: 'e', name: 'E', kind: 'folder', birth: NaN, mtime: -1 },
    { id: 'f', name: 'F', kind: 'image', birth: 80, mtime: 40 }
  ];
  const context = vm.createContext({ roots, S: { sort: 'contentDate', direction: 'asc' } });
  vm.runInContext(compareSection, context);
  assert.deepEqual(
    roots.map((n) => n.id),
    ['c', 'e', 'd', 'f', 'a', 'b']
  );
});
test('layer defaults follow imported roots, not physical path depth; explicit defaults survive restart and changed roots', async () => {
  let stored;
  const { api, memory } = fixture(async (value) => {
    stored = plain(value);
  });
  const rootContext = { insideAlbum: true, importedRoot: true },
    childContext = { insideAlbum: true, importedRoot: false };
  assert.deepEqual(plain(memory.get('library', 'D:/深/层/导入根', rootContext)), {
    sort: 'name',
    direction: 'asc'
  });
  assert.deepEqual(plain(memory.get('library', 'D:/导入根/一级', childContext)), {
    sort: 'contentDate',
    direction: 'desc'
  });
  assert.deepEqual(plain(memory.get('library', 'D:/导入根/一级/二级', childContext)), {
    sort: 'contentDate',
    direction: 'desc'
  });
  assert.equal(Object.keys(memory.snapshot()).length, 0, 'defaults do not write preferences');
  assert.equal(memory.set('library', 'D:/导入根/一级', { sort: 'name', direction: 'asc' }), true);
  await memory.flush();
  const next = api.create({
    save: async () => {
      throw Error('read must not save');
    }
  });
  next.hydrate(stored, next.beginRead());
  assert.deepEqual(plain(next.get('library', 'd:/导入根/一级', childContext)), {
    sort: 'name',
    direction: 'asc'
  });
  assert.deepEqual(plain(next.get('library', 'd:/导入根/一级', rootContext)), {
    sort: 'name',
    direction: 'asc'
  });
});
test('return navigation restores before delayed ancestors without a cold list or a second reset', async () => {
  const h = appFixture(),
    grid = h.context.grid,
    ancestors = deferred(),
    baseApi = h.context.api,
    cached = new Map();
  let active = null,
    resets = 0,
    restores = 0;
  grid.reset = () => {
    resets++;
  };
  grid.retain = (key, scroll) => {
    if (active !== key) return false;
    cached.set(key, { scroll, total: grid.total });
    active = null;
    return true;
  };
  grid.restore = (key) => {
    const saved = cached.get(key);
    if (!saved) return null;
    cached.delete(key);
    active = key;
    grid.total = saved.total;
    h.$('#viewport').scrollTop = saved.scroll;
    restores++;
    return saved.scroll;
  };
  grid.load = async (q, version, key) => {
    active = key;
    grid.total = 42;
    h.queries.push(plain(q));
    return grid.total;
  };
  await vm.runInContext("navigate({parent:'root'})", h.context);
  h.$('#viewport').scrollTop = 1200;
  await vm.runInContext("navigate({parent:'child'})", h.context);
  const coldCalls = h.queries.length;
  h.context.api = (method, args) =>
    method === 'ancestors' ? ancestors.promise : baseApi(method, args);
  const pending = vm.runInContext('back()', h.context);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(restores, 1, 'cached parent is restored before ancestor RPC resolves');
  assert.equal(h.$('#viewport').scrollTop, 1200);
  assert.equal(h.queries.length, coldCalls);
  assert.equal(resets, 0, 'ordinary navigation leaves reset ownership to the grid');
  ancestors.resolve([]);
  await pending;
  assert.equal(h.$('#viewport').scrollTop, 1200);
});
test('restored scroll zero is a hit, timeline month and place have distinct view keys', async () => {
  const h = appFixture();
  h.state.parent = 'root';
  h.context.grid.restore = () => 0;
  h.context.grid.total = 7;
  await vm.runInContext('loadPage(true)', h.context);
  assert.equal(h.queries.length, 0);
  h.state.view = 'timeline';
  h.state.timelineMonth = '2026-10';
  const first = vm.runInContext('viewKey()', h.context);
  h.state.timelineMonth = '2026-11';
  assert.notEqual(vm.runInContext('viewKey()', h.context), first);
  const month = vm.runInContext('viewKey()', h.context);
  h.state.timelinePlace = 'Tokyo';
  assert.notEqual(vm.runInContext('viewKey()', h.context), month);
});
test('toolbar and real browse context menu call the shared persistent action with a distinct 日期 option', () => {
  assert.match(appSource, /#sort'\)\.onchange[^\n]*changeBrowseSort/);
  assert.match(menusSource, /\['contentDate', '按日期排序'\]/);
  assert.match(menusSource, /\(\) => changeBrowseSort\(value\)/);
  assert.match(appSource, /browseSortMemory\.rename\(renames\)/);
  assert.match(
    appSource,
    /browseSortMemory\.hydrate\(init\.settings\.browseSortPreferences, sortRead\)/
  );
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  assert.ok(
    html.indexOf('src="browse-sort.js"') < html.indexOf('src="app.js"') &&
      html.includes('src="browse-sort.js"')
  );
});
