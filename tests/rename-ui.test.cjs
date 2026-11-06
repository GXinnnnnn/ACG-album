'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../src/ui/app.js');
const source = fs.readFileSync(filename, 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const a = source.indexOf(start),
    b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `source section ${start} exists`);
  return source.slice(a, b);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function element() {
  const attributes = new Map();
  return {
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    hidden: false,
    isConnected: true,
    scrollTop: 0,
    dataset: {},
    style: {},
    focused: false,
    classList: { add() {}, toggle() {} },
    setAttribute(name, value) {
      attributes.set(name, String(value));
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    focus() {
      this.focused = true;
    },
    select() {
      this.selected = true;
    },
    replaceChildren() {},
    insertAdjacentHTML() {}
  };
}
function renameHarness(implementation) {
  const nodes = new Map([['#viewport', element()]]),
    calls = [],
    log = [];
  const oldRoot = {
    id: 'old-root',
    path: 'C:\\Fixture\\Album',
    name: 'Album',
    kind: 'folder',
    parent: null
  };
  const child = {
    id: 'old-child',
    path: oldRoot.path + '\\Nested',
    name: 'Nested',
    kind: 'folder',
    parent: oldRoot.id
  };
  const S = {
    roots: [oldRoot],
    current: child,
    parent: child.id,
    view: 'library',
    search: '',
    filter: 'images',
    sort: 'name',
    direction: 'asc',
    loadVersion: 5,
    history: [
      { parent: oldRoot.id, parentPath: oldRoot.path },
      { parent: child.id, parentPath: child.path }
    ],
    scrolls: new Map()
  };
  const viewKey = () => JSON.stringify([S.view, S.parent, S.search, S.filter, S.sort, S.direction]);
  nodes.get('#viewport').scrollTop = 932;
  S.scrolls.set(viewKey(), 932);
  const folderTree = {
    open: new Set([oldRoot.id, child.id]),
    openNodes: new Map([
      [oldRoot.id, oldRoot],
      [child.id, child]
    ]),
    pages: new Map()
  };
  let context, dialog;
  context = vm.createContext({
    S,
    V: { node: null },
    folderTree,
    grid: { items: new Map([[0, { id: 'media', path: child.path + '\\x.png', kind: 'image' }]]) },
    viewKey,
    modalGeneration: 0,
    $: (selector) => nodes.get(selector) || null,
    openModal(title, html) {
      for (const [selector, node] of nodes) if (selector !== '#viewport') node.isConnected = false;
      for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) nodes.set('#' + id, element());
      dialog = { open: true, title, html, classList: { add() {} } };
      context.modalGeneration++;
      return dialog;
    },
    closeModal() {
      dialog.open = false;
      log.push('close');
      context.modalGeneration++;
    },
    async loadSummary() {
      log.push('summary');
      S.roots = [{ ...oldRoot, id: 'new-root', path: 'C:\\Fixture\\Renamed' }];
    },
    async loadPage(keep) {
      log.push({ page: keep, parent: S.parent, filter: S.filter });
      S.loadVersion++;
      nodes.get('#viewport').scrollTop = 0;
    },
    async refreshGrowingView() {
      log.push('growing');
    },
    scheduleGrowingRefresh() {
      log.push('scheduled-growing');
    },
    window: {
      invalidateFolderTree() {
        log.push('tree');
      }
    },
    toast(message, error) {
      log.push({ message, error });
    },
    api(command, args) {
      calls.push({ command, args: plain(args) });
      return implementation(command, args);
    }
  });
  new vm.Script(section('function renameParts(n)', 'function showContext(e, n)'), {
    filename
  }).runInContext(context);
  return {
    context,
    S,
    oldRoot,
    child,
    calls,
    nodes,
    log,
    folderTree,
    get dialog() {
      return dialog;
    },
    submit() {
      return nodes.get('#rename-form').onsubmit({ preventDefault() {} });
    }
  };
}
function renamedResult(n, name) {
  const renamedPath = 'C:\\Fixture\\' + name;
  return {
    renamed: true,
    oldId: n.id,
    id: 'new-root',
    oldRoot: n.id,
    root: 'new-root',
    oldPath: n.path,
    path: renamedPath,
    node: { ...n, id: 'new-root', name, path: renamedPath },
    count: 2,
    caseOnly: false
  };
}

test('rename dialog preselects basename, keeps media extension fixed, and saves once through real RPC name', async () => {
  const request = deferred();
  const h = renameHarness((command) => {
    assert.equal(command, 'rename');
    return request.promise;
  });
  const image = {
    id: 'photo',
    name: '原图.test.PNG',
    path: 'C:\\Fixture\\原图.test.PNG',
    kind: 'image'
  };
  h.context.renameModal(image);
  assert.equal(h.nodes.get('#rename-name').value, '原图.test');
  assert.equal(h.nodes.get('#rename-extension').textContent, '.PNG');
  assert.equal(h.nodes.get('#rename-original-path').textContent, image.path);
  assert.equal(h.nodes.get('#rename-name').selected, true);
  assert.match(h.dialog.html, /直接重命名磁盘/);
  assert.match(h.dialog.html, /role="alert"/);
  h.nodes.get('#rename-name').value = '新图';
  const pending = h.submit();
  await h.submit();
  assert.deepEqual(h.calls, [{ command: 'rename', args: { id: 'photo', name: '新图.PNG' } }]);
  assert.equal(h.nodes.get('#rename-save').disabled, true);
  request.resolve({ renamed: false });
  await pending;
  assert.equal(h.dialog.open, false);
});

test('rename validation rejects illegal/reserved/empty names without touching RPC', async () => {
  const h = renameHarness(() => {
    throw new Error('no RPC expected');
  });
  h.context.renameModal(h.oldRoot);
  for (const invalid of [
    '',
    '.',
    '..',
    'CON',
    'nul.txt',
    'LPT1',
    'COM².log',
    'a/b',
    'a\\b',
    'a:b',
    'a?',
    'a*',
    'a"',
    'a<',
    'a>',
    'a|',
    'trail.',
    'trail ',
    'line\nname'
  ]) {
    h.nodes.get('#rename-name').value = invalid;
    await h.submit();
    assert.equal(h.dialog.open, true, invalid);
    assert.ok(h.nodes.get('#rename-error').textContent, invalid);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.context.renameNameError('正常名字 (2)'), '');
});

test('collision stays inline and retryable; escaping pending dialog cannot close a replacement', async () => {
  const request = deferred();
  let attempts = 0;
  const h = renameHarness(() =>
    ++attempts === 1 ? Promise.reject(new Error('目标名称已存在')) : request.promise
  );
  h.context.renameModal(h.oldRoot);
  h.nodes.get('#rename-name').value = 'Existing';
  await h.submit();
  assert.equal(h.dialog.open, true);
  assert.equal(h.nodes.get('#rename-error').textContent, '目标名称已存在');
  assert.equal(h.nodes.get('#rename-save').disabled, false);
  h.nodes.get('#rename-name').value = 'Renamed';
  const pending = h.submit();
  h.nodes.get('#rename-cancel').onclick();
  // Replacement represents another unrelated modal, using the same native cancel/close path.
  h.context.openModal('其他对话框', '<div id="unrelated"></div>');
  request.resolve({ renamed: false });
  await pending;
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.title, '其他对话框');
  assert.equal(h.log.filter((row) => row === 'close').length, 1);
});

test('renaming an ancestor resolves current absolute path and preserves view, tree, history and scroll', async () => {
  let h;
  h = renameHarness(async (command, args) => {
    if (command === 'rename') return renamedResult(h.oldRoot, 'Renamed');
    assert.equal(command, 'get');
    assert.deepEqual(plain(args), { path: 'C:\\Fixture\\Renamed\\Nested' });
    return { ...h.child, id: 'new-child', parent: 'new-root', path: args.path };
  });
  h.context.renameModal(h.oldRoot);
  h.nodes.get('#rename-name').value = 'Renamed';
  await h.submit();
  assert.equal(h.S.parent, 'new-child');
  assert.equal(h.S.current.path, 'C:\\Fixture\\Renamed\\Nested');
  assert.equal(h.S.filter, 'images');
  assert.equal(h.nodes.get('#viewport').scrollTop, 932);
  assert.deepEqual(
    h.S.history.map((entry) => entry.parent),
    ['new-root', 'new-child']
  );
  assert.equal(h.S.history[1].parentPath, 'C:\\Fixture\\Renamed\\Nested');
  assert.deepEqual([...h.folderTree.open], ['new-root', 'new-child']);
  assert.equal([...h.S.scrolls.values()][0], 932);
  assert.match([...h.S.scrolls.keys()][0], /new-child/);
  assert.equal(
    h.calls.filter((call) => call.command === 'get').length,
    1,
    'media cache rows are not fetched one by one'
  );
  assert.ok(h.log.some((row) => row.page === true && row.parent === 'new-child'));
  assert.equal(
    h.context.renamedPath('C:\\Fixture\\Album-more\\x', h.oldRoot.path, 'C:\\Fixture\\Renamed'),
    'C:\\Fixture\\Album-more\\x'
  );
});

test('pending rename defers structural refresh but continues tasks/progress/online, then retries refresh on failure', async () => {
  const request = deferred();
  const h = renameHarness(() => request.promise);
  let listener;
  const observed = [];
  h.context.window.album = {
    onEvent(handler) {
      listener = handler;
    }
  };
  Object.assign(h.context, {
    applyTaskSnapshot(data) {
      observed.push(['tasks', data.busy]);
    },
    hasStartupScanWork: () => false,
    hasOnlineWork: () => false,
    latestOnlineProgress: null,
    showProgress() {
      observed.push(['progress']);
    },
    showOnlineStatus() {
      observed.push(['online']);
    },
    attempt(fn) {
      return fn();
    },
    enterPendingImport() {},
    scanRefreshNeeded: () => false,
    matchRefreshBatch: { flush() {}, changed() {} }
  });
  new vm.Script(section('window.album.onEvent((event)', 'initializeDisplayControls();'), {
    filename
  }).runInContext(h.context);
  h.context.renameModal(h.oldRoot);
  h.nodes.get('#rename-name').value = 'Renamed';
  const pending = h.submit();
  listener({ type: 'changed', data: { renamed: true } });
  assert.equal(h.log.includes('tree'), false);
  listener({ type: 'tasks', data: { known: true, busy: true } });
  listener({ type: 'progress', data: { active: true } });
  listener({ type: 'online', data: { active: false } });
  assert.deepEqual(observed, [['tasks', true], ['progress'], ['online']]);
  request.reject(new Error('文件正在使用'));
  await pending;
  assert.equal(h.dialog.open, true);
  assert.equal(h.log.filter((row) => row === 'scheduled-growing').length, 1);
});

test('refreshing the home page invokes every real root refresh despite one failure', async () => {
  const calls = [],
    messages = [];
  const nodes = new Map();
  const context = vm.createContext({
    S: {
      parent: null,
      roots: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B' }
      ]
    },
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    $$: () => [],
    libraryRefreshBusy: false,
    isImportBusy: () => false,
    updateRefreshBusy() {},
    async api(command, args) {
      calls.push({ command, args });
      if (args.id === 'a') throw new Error('目录不可用');
    },
    async refreshGrowingView() {
      calls.push({ command: 'render' });
    },
    toast(text, error) {
      messages.push({ text, error });
    }
  });
  new vm.Script(section('async function refreshLibrary()', 'function densityModal('), {
    filename
  }).runInContext(context);
  await context.refreshLibrary();
  assert.deepEqual(plain(calls), [
    { command: 'refresh', args: { id: 'a' } },
    { command: 'refresh', args: { id: 'b' } },
    { command: 'render' }
  ]);
  assert.equal(messages[0].error, true);
  assert.match(messages[0].text, /A：目录不可用/);
});

function startupHarness({ resumeReject = false } = {}) {
  const nodes = new Map(),
    frames = [],
    timers = [],
    idle = [],
    calls = [],
    rendered = [];
  const node = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const snapshot = {
    known: true,
    busy: false,
    scan: { status: 'idle' },
    matching: { hasWork: false },
    maintenance: { state: 'pending' }
  };
  const init = {
    roots: [{ id: 'cache', name: '真实缓存相册' }],
    settings: { density: 166, densityConfigured: true },
    stats: null,
    localIndex: null,
    taskSnapshot: snapshot
  };
  let context;
  context = vm.createContext({
    S: {
      settings: {},
      roots: [],
      history: [],
      view: 'library',
      filter: 'all',
      search: '',
      parent: null,
      loadVersion: 0
    },
    $: node,
    $$: () => [],
    fmt: String,
    bytes: String,
    window: {
      albumAppearanceControls: { snapshot: () => 0, mergeSummary: (s) => s },
      albumLocalSearch: { setStatus() {} }
    },
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback, delay) => timers.push({ callback, delay }),
    requestIdleCallback: (callback, options) => idle.push({ callback, options }),
    updateImportBusy() {},
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
        rendered.push('real-cache-card');
        return 1;
      }
    },
    queryArgs: () => ({}),
    async api(command, args) {
      calls.push({ command, args });
      if (command === 'init') return init;
      if (command === 'startupResume') {
        if (resumeReject) throw new Error('恢复失败');
        return { accepted: true, taskSnapshot: { ...snapshot, maintenance: { state: 'ready' } } };
      }
      if (command === 'statistics') return { images: 9, folders: 1 };
      if (command === 'localIndexStatus') return { available: false };
      throw new Error('unexpected ' + command);
    }
  });
  new vm.Script(
    section('function viewKey()', 'function snapshot()') +
      section('let startupTaskSnapshot =', 'let filterResizeObserver'),
    { filename }
  ).runInContext(context);
  return { context, nodes, calls, frames, timers, idle, rendered, snapshot };
}

test('real cached page precedes one startupResume paint boundary; statistics wait for its reply and idle', async () => {
  const h = startupHarness();
  assert.equal(h.context.hasStartupTaskWork(), true, 'unknown state is not idle');
  await h.context.loadSummary();
  assert.equal(h.context.hasStartupTaskWork(), false);
  await h.context.loadPage();
  assert.deepEqual(h.rendered, ['real-cache-card']);
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['init']
  );
  h.frames.shift()();
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['init']
  );
  await h.timers.shift().callback();
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['init', 'startupResume']
  );
  assert.equal(h.nodes.get('#startup-status').hidden, true);
  h.frames.shift()();
  assert.equal(h.idle.length, 1);
  h.idle.shift().callback();
  await Promise.resolve();
  assert.deepEqual(
    h.calls.map((call) => call.command),
    ['init', 'startupResume', 'statistics', 'localIndexStatus']
  );
  await h.context.loadPage();
  assert.equal(h.frames.length, 0);
  assert.equal(h.calls.filter((call) => call.command === 'startupResume').length, 1);
});

test('task snapshots retain queued/unknown-count work and expose recoverable startup errors', async () => {
  const h = startupHarness({ resumeReject: true });
  h.context.applyTaskSnapshot({ ...h.snapshot, busy: true, scan: { status: 'queued' } });
  assert.equal(h.context.hasStartupTaskWork(), true);
  assert.equal(h.context.hasStartupCancelableWork(), true);
  assert.match(h.nodes.get('#startup-status').textContent, /未完成的索引/);
  await h.context.loadSummary();
  await h.context.loadPage();
  h.frames.shift()();
  await h.timers.shift().callback();
  assert.match(h.nodes.get('#startup-status').textContent, /未能恢复/);
  assert.equal(h.nodes.get('#startup-retry').hidden, false);
  // The existing online controls also honor bounded lightweight queue snapshots.
  new vm.Script(section('function hasBatchOnlineWork(data)', 'function hasImportWork()'), {
    filename
  }).runInContext(h.context);
  assert.equal(
    h.context.hasBatchOnlineWork({
      hasWork: true,
      countsKnown: false,
      pending: null,
      remaining: null
    }),
    true
  );
  assert.equal(
    h.context.hasBatchOnlineWork({ hasWork: false, paused: 'access', pending: 0 }),
    false
  );
});

test('asynchronous maintenance error exposes retry and its actual reason without a cancellable task', async () => {
  const h = startupHarness();
  h.context.applyTaskSnapshot({
    ...h.snapshot,
    maintenance: { state: 'error', error: '排序维护失败：磁盘只读' }
  });
  assert.equal(h.nodes.get('#startup-retry').hidden, false);
  assert.equal(h.nodes.get('#startup-cancel').hidden, true);
  assert.match(h.nodes.get('#startup-status').title, /磁盘只读/);
  h.nodes.get('#startup-retry').onclick();
  assert.equal(h.nodes.get('#startup-retry').disabled, true);
  h.frames.shift()();
  await h.timers.shift().callback();
  assert.equal(h.calls.filter((call) => call.command === 'startupResume').length, 1);
  assert.equal(h.nodes.get('#startup-retry').hidden, true);
  assert.equal(h.nodes.get('#startup-cancel').hidden, true);
});

test('paused and blocked saved scans expose one resume request and preserve scan/maintenance reasons', async () => {
  for (const state of ['paused', 'blocked']) {
    const h = startupHarness();
    h.context.applyTaskSnapshot({
      ...h.snapshot,
      busy: true,
      scan: { status: state, reason: '原目录 E: 暂不可访问' },
      maintenance: { state: 'error', error: '后台恢复需要处理' }
    });
    assert.equal(h.context.hasStartupScanWork(), true);
    assert.equal(h.context.hasStartupCancelableWork(), true);
    assert.equal(h.nodes.get('#startup-retry').hidden, false);
    assert.equal(h.nodes.get('#startup-cancel').hidden, false);
    assert.match(h.nodes.get('#startup-status').title, /原目录 E: 暂不可访问/);
    assert.match(h.nodes.get('#startup-status').title, /后台恢复需要处理/);
    h.nodes.get('#startup-retry').onclick();
    h.nodes.get('#startup-retry').onclick();
    assert.equal(h.frames.length, 1);
    h.frames.shift()();
    await h.timers.shift().callback();
    assert.deepEqual(plain(h.calls.filter((call) => call.command === 'startupResume')), [
      { command: 'startupResume', args: {} }
    ]);
    assert.equal(h.nodes.get('#startup-retry').hidden, true);
  }
});

test('independent saved-task cancel uses real single-flight cancelImport while the progress panel is hidden', async () => {
  const h = startupHarness(),
    pending = deferred();
  const baseApi = h.context.api;
  Object.assign(h.context, {
    pendingImport: null,
    scanActive: false,
    latestScanProgress: null,
    latestOnlineProgress: null,
    clearTimeout() {},
    attempt(fn) {
      return fn();
    },
    api(command, args) {
      if (command !== 'cancel') return baseApi(command, args);
      h.calls.push({ command, args });
      return pending.promise;
    }
  });
  new vm.Script(
    section('function setProgressText(element, value)', 'function hasOnlineWork(data)'),
    { filename }
  ).runInContext(h.context);
  new vm.Script(section('let importBusyHeld =', 'async function enterPendingImport(p)'), {
    filename
  }).runInContext(h.context);
  h.context.$('#progress-panel').hidden = true;
  h.context.applyTaskSnapshot({
    ...h.snapshot,
    busy: true,
    scan: { status: 'blocked', reason: '路径离线' }
  });
  const cancel = h.nodes.get('#startup-cancel');
  assert.equal(cancel.hidden, false);
  const first = cancel.onclick();
  await cancel.onclick();
  assert.equal(h.calls.filter((call) => call.command === 'cancel').length, 1);
  assert.equal(cancel.textContent, '正在取消…');
  assert.equal(cancel.getAttribute('aria-busy'), 'true');
  assert.equal(h.nodes.get('#startup-retry').disabled, true);
  h.context.applyTaskSnapshot({ ...h.snapshot, maintenance: { state: 'running' } });
  assert.equal(cancel.hidden, true, 'maintenance alone is not cancellable');
  pending.resolve(true);
  await first;
  h.timers.find((timer) => timer.delay === 300).callback();
  assert.equal(h.context.isImportBusy(), false);
  h.context.applyTaskSnapshot({
    ...h.snapshot,
    busy: true,
    matching: { hasWork: true, pausedReason: 'access' }
  });
  assert.equal(cancel.hidden, false, 'saved matching task remains cancellable without a scan');
  const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
  assert.ok(html.indexOf('id="startup-cancel"') < html.indexOf('id="progress-panel"'));
});

test('tasks idle after the final scan progress completes the real panel once and keeps repeated idle quiet', () => {
  const h = startupHarness(),
    timers = new Map();
  let timerId = 0,
    listener,
    paints = 0;
  Object.assign(h.context, {
    pendingImport: null,
    scanActive: false,
    progressHideTimer: null,
    matchMedia: () => ({ matches: true }),
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    attempt(callback) {
      return callback();
    },
    enterPendingImport() {},
    scanRefreshNeeded: () => false
  });
  h.context.window.album = {
    onEvent(callback) {
      listener = callback;
    }
  };
  new vm.Script(
    section('let importBusyHeld =', 'async function enterPendingImport(p)') +
      section('let latestOnlineProgress = null', 'window.album.onEvent((event)'),
    { filename }
  ).runInContext(h.context);
  const paint = h.context.paintProgress;
  h.context.paintProgress = (state) => {
    paints++;
    return paint(state);
  };
  new vm.Script(section('window.album.onEvent((event)', 'initializeDisplayControls();'), {
    filename
  }).runInContext(h.context);
  const runTimers = (delay) => {
    for (const [id, timer] of [...timers]) {
      if (timer.delay !== delay || !timers.has(id)) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  const panel = h.context.$('#progress-panel');
  panel.hidden = true;
  h.context.$('#progress-bar').parentElement = element();
  const idle = { ...h.snapshot, maintenance: { state: 'ready' } };
  listener({
    type: 'tasks',
    data: { ...idle, busy: true, scan: { status: 'running', jobId: 'offline-96' } }
  });
  listener({ type: 'progress', data: { active: true, busy: true, files: 96 } });
  assert.equal(panel.dataset.state, 'active');
  assert.equal(panel.getAttribute('aria-busy'), 'true');
  listener({
    type: 'progress',
    data: { active: false, busy: false, cancelling: false, files: 96 }
  });
  assert.equal(h.context.scanActive, false);
  assert.equal(h.context.hasStartupScanWork(), true, 'the terminal progress precedes tasks idle');
  assert.equal(
    panel.dataset.state,
    'active',
    'the older running task still keeps the panel active'
  );
  assert.equal(panel.getAttribute('aria-busy'), 'true');
  const activePaints = paints;
  listener({ type: 'tasks', data: idle });
  assert.equal(h.context.hasStartupScanWork(), false);
  runTimers(300);
  assert.equal(paints, activePaints + 1, 'tasks running-to-idle must schedule the terminal paint');
  assert.equal(panel.dataset.state, 'complete');
  assert.equal(panel.getAttribute('aria-busy'), 'false');
  assert.equal(h.context.$('.progress-spinner').hidden, true);
  assert.equal(h.context.isImportBusy(), false);
  assert.equal(panel.hidden, false, 'retain the normal completed summary before hiding');
  const hideTimers = [...timers.keys()];
  assert.equal(hideTimers.length, 1);
  assert.equal(timers.get(hideTimers[0]).delay, 6000);
  for (let i = 0; i < 3; i++) listener({ type: 'tasks', data: idle });
  runTimers(300);
  assert.equal(
    paints,
    activePaints + 1,
    'repeated idle snapshots do not repaint the completed panel'
  );
  assert.deepEqual([...timers.keys()], hideTimers, 'repeated idle does not restart the hide timer');
  runTimers(6000);
  assert.equal(panel.hidden, true);
  listener({ type: 'tasks', data: idle });
  assert.equal(panel.hidden, true, 'another idle snapshot does not reopen the hidden panel');
  assert.equal(paints, activePaints + 1);
  assert.equal(timers.size, 0);
});

test('a newer tasks event is not overwritten by an older in-flight lightweight init response', async () => {
  const h = startupHarness();
  await h.context.loadSummary();
  const pending = deferred();
  h.context.api = (command) => {
    assert.equal(command, 'init');
    return pending.promise;
  };
  const load = h.context.loadSummary();
  h.context.applyTaskSnapshot({ ...h.snapshot, busy: false, maintenance: { state: 'ready' } });
  pending.resolve({
    roots: h.context.S.roots,
    settings: h.context.S.settings,
    stats: null,
    taskSnapshot: { ...h.snapshot, busy: true, scan: { status: 'queued' } }
  });
  await load;
  assert.equal(h.context.hasStartupTaskWork(), false);
  assert.equal(h.nodes.get('#startup-status').hidden, true);
});

test('preload permits rename/startupResume and page menu shares refreshLibrary without a local-only reload', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  assert.match(preload, /'rename'/);
  assert.match(preload, /'startupResume'/);
  const menus = fs.readFileSync(path.join(__dirname, '../src/ui/menus.js'), 'utf8');
  assert.match(menus, /action\('刷新当前页面', 'refresh', refreshLibrary/);
  assert.match(source, /event\.type === 'tasks'/);
  assert.match(
    source,
    /event\.type === 'changed' && !event\.data\.cover && !event\.data\.matching && renamingNodes\.size/
  );
  assert.match(source, /action\('重命名…', 'edit', \(\) => renameModal\(n\)/);
});
