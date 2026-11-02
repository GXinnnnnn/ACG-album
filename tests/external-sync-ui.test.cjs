'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.join(__dirname, '../src/ui/app.js');
const source = fs.readFileSync(filename, 'utf8');
const mediaSource = fs.readFileSync(path.join(__dirname, '../src/ui/media-ui.js'), 'utf8');
function section(text, start, end) {
  const a = text.indexOf(start),
    b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `actual source section ${start}`);
  return text.slice(a, b);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function element() {
  const listeners = new Map();
  return {
    open: false,
    scrollTop: 0,
    textContent: '',
    title: '',
    style: {},
    listeners,
    replaceChildren() {},
    insertAdjacentHTML() {},
    removeAttribute() {},
    focus() {
      this.focused = true;
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    }
  };
}
function harness(implementation) {
  const root = {
    id: 'root-a',
    root: 'root-a',
    parent: null,
    path: 'C:\\Fixture\\Album',
    name: 'Album',
    kind: 'folder',
    missing: 0
  };
  const child = {
    id: 'child-a',
    root: root.id,
    parent: root.id,
    path: root.path + '\\Nested',
    name: 'Nested',
    kind: 'folder',
    missing: 0,
    folders: 0,
    files: 1,
    total_bytes: 10
  };
  const nodes = new Map(),
    calls = [],
    log = [],
    timers = new Map(),
    pending = [];
  let timerId = 0,
    listener;
  const $ = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  $('#viewport').scrollTop = 932;
  const S = {
    roots: [root],
    current: child,
    parent: child.id,
    view: 'library',
    search: '',
    filter: 'images',
    sort: 'name',
    direction: 'asc',
    loadVersion: 5,
    history: [
      { parent: root.id, parentPath: root.path },
      { parent: child.id, parentPath: child.path }
    ],
    scrolls: new Map()
  };
  const folderTree = {
    open: new Set([root.id, child.id]),
    openNodes: new Map([
      [root.id, root],
      [child.id, child]
    ]),
    pages: new Map()
  };
  const grid = {
    active: true,
    items: new Map([[0, { id: 'image', path: child.path + '\\x.png', kind: 'image' }]]),
    async refreshGrowing() {
      log.push(['grid', S.parent]);
      return 1;
    }
  };
  const viewKey = () => JSON.stringify([S.view, S.parent, S.search, S.filter, S.sort, S.direction]);
  S.scrolls.set(viewKey(), 932);
  const context = vm.createContext({
    S,
    V: { node: null, serial: 0 },
    folderTree,
    grid,
    $,
    viewKey,
    Date,
    Map,
    Set,
    Promise,
    growingTimer: null,
    growingTask: null,
    growingDirty: false,
    growingLast: 0,
    overviewLast: 0,
    scanActive: false,
    pendingImport: null,
    changedTimer: null,
    latestOnlineProgress: null,
    startupResumeFinished: true,
    onlineToast: 0,
    setTimeout(fn) {
      const id = ++timerId;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    api(command, args) {
      calls.push([command, plain(args)]);
      return Promise.resolve(
        implementation
          ? implementation(command, args, { S, root, child, log })
          : command === 'get'
            ? args.id === root.id
              ? root
              : args.id === child.id
                ? child
                : null
            : []
      );
    },
    async loadSummary() {
      log.push(['summary']);
    },
    async loadPage(keep) {
      log.push(['page', keep, S.parent]);
      S.loadVersion++;
      $('#viewport').scrollTop = 0;
    },
    async attempt(fn) {
      const task = Promise.resolve().then(fn);
      pending.push(task);
      return task;
    },
    isOverview: () => !S.parent,
    updateImportBusy() {},
    updateScrollActions() {},
    scheduleSummaryDetails() {},
    fmt: String,
    bytes: String,
    setResultCount() {},
    renderEmpty() {},
    renderIntro() {},
    renderBreadcrumbs() {},
    async renderOverview() {
      log.push(['overview']);
    },
    hasStartupScanWork: () => false,
    applyTaskSnapshot() {},
    hasOnlineWork: () => false,
    showProgress() {},
    enterPendingImport() {},
    scanRefreshNeeded: () => false,
    showOnlineStatus() {},
    matchRefreshBatch: { flush() {}, changed() {} },
    toast() {},
    stopViewerVideo() {
      log.push(['stop-video']);
    },
    scheduleMediaRefresh() {
      log.push(['media']);
    },
    window: {
      invalidateFolderTree() {
        log.push(['tree']);
      },
      album: {
        onEvent(fn) {
          listener = fn;
        }
      }
    }
  });
  const code =
    section(source, 'function renamedPath(', 'function showContext(') +
    section(source, 'async function refreshGrowingView(', 'const importChoices =') +
    section(source, 'window.album.onEvent((event)', 'initializeDisplayControls();');
  new vm.Script(code, { filename }).runInContext(context);
  new vm.Script(
    section(
      mediaSource,
      "$('#viewer').addEventListener('close'",
      "$('#modal').addEventListener('close'"
    ),
    { filename: 'media-ui.js' }
  ).runInContext(context);
  return {
    context,
    S,
    root,
    child,
    folderTree,
    grid,
    nodes,
    calls,
    log,
    timers,
    $,
    changed(data = {}) {
      listener({ type: 'changed', data });
    },
    flush() {
      return context.flushStructuralChanges();
    },
    idle() {
      return Promise.all(pending);
    },
    state() {
      return vm.runInContext(
        '({dirty:structuralDirty, queued:externalRenameQueue.length, task:!!structuralTask})',
        context
      );
    },
    async close() {
      $('#viewer').open = false;
      $('#viewer').listeners.get('close')();
      await Promise.all(pending);
    }
  };
}
function rename(old, id, nextPath) {
  return {
    renamed: true,
    external: true,
    oldId: old.id,
    id,
    oldRoot: old.root,
    root: id,
    oldPath: old.path,
    path: nextPath,
    count: 2,
    caseOnly: false,
    node: { ...old, id, root: id, path: nextPath, name: nextPath.split('\\').at(-1) }
  };
}

test('external rename chains compose before resolving current descendants and preserve navigation and cached items', async () => {
  let h;
  h = harness((command, args) => {
    assert.equal(command, 'get');
    assert.equal(args.path, 'C:\\Fixture\\Final\\Nested');
    return { ...h.child, id: 'child-c', root: 'root-c', parent: 'root-c', path: args.path };
  });
  const first = rename(h.root, 'root-b', 'C:\\Fixture\\Middle');
  const second = rename(first.node, 'root-c', 'C:\\Fixture\\Final');
  const cache = h.grid.items;
  h.changed({ root: 'root-b', revision: 1, renames: [first] });
  h.changed({ root: 'root-c', revision: 2, renames: [second] });
  await h.flush();
  assert.equal(h.S.parent, 'child-c');
  assert.equal(h.S.current.path, 'C:\\Fixture\\Final\\Nested');
  assert.deepEqual(
    h.S.history.map((entry) => entry.parent),
    ['root-c', 'child-c']
  );
  assert.deepEqual([...h.folderTree.open], ['root-c', 'child-c']);
  assert.equal(h.$('#viewport').scrollTop, 932);
  assert.equal(h.S.filter, 'images');
  assert.equal(h.grid.items, cache);
  assert.deepEqual(h.calls, [['get', { path: 'C:\\Fixture\\Final\\Nested' }]]);
  assert.deepEqual(
    h.log.filter((row) => row[0] === 'page'),
    [['page', true, 'child-c']]
  );
  assert.deepEqual(plain(h.state()), { dirty: false, queued: 0, task: false });
});

test('a rename arriving during path lookup retries the complete ordered batch and uses one in-flight task', async () => {
  const gate = deferred();
  let h;
  h = harness(async (command, args) => {
    assert.equal(command, 'get');
    if (args.path === 'C:\\Fixture\\Middle\\Nested') return gate.promise;
    assert.equal(args.path, 'C:\\Fixture\\Final\\Nested');
    return { ...h.child, id: 'child-c', root: 'root-c', path: args.path };
  });
  const first = rename(h.root, 'root-b', 'C:\\Fixture\\Middle');
  h.changed({ renames: [first] });
  const running = h.flush();
  assert.equal(h.flush(), running);
  h.changed({ renames: [rename(first.node, 'root-c', 'C:\\Fixture\\Final')] });
  gate.resolve(null);
  await running;
  assert.equal(h.S.parent, 'child-c');
  assert.equal(h.S.history[0].parent, 'root-c');
  assert.equal(h.log.filter((row) => row[0] === 'page').length, 1);
  assert.equal(h.state().queued, 0);
});

test('a failed external path lookup keeps the batch available for the next real event or close flush', async () => {
  let fail = true,
    h;
  h = harness((command, args) => {
    assert.equal(command, 'get');
    if (fail) throw new Error('Temporary lookup failure');
    return { ...h.child, id: 'child-b', root: 'root-b', path: args.path };
  });
  h.changed({ renames: [rename(h.root, 'root-b', 'C:\\Fixture\\Middle')] });
  await assert.rejects(h.flush(), /Temporary lookup failure/);
  assert.equal(h.S.parent, h.child.id);
  assert.equal(h.state().queued, 1);
  assert.equal(h.state().dirty, true);
  fail = false;
  await h.flush();
  assert.equal(h.S.parent, 'child-b');
  assert.equal(h.state().queued, 0);
});

test('user navigation during an external lookup is not overwritten or given the old scroll position', async () => {
  const gate = deferred();
  let h;
  h = harness(async (command, args) => {
    if (args.path) return gate.promise;
    assert.equal(args.id, 'other');
    return h.S.current;
  });
  h.changed({ renames: [rename(h.root, 'root-b', 'C:\\Fixture\\Middle')] });
  const running = h.flush();
  h.S.loadVersion++;
  h.S.parent = 'other';
  h.S.current = {
    id: 'other',
    root: 'other-root',
    name: 'Other',
    path: 'D:\\Other',
    kind: 'folder',
    folders: 0,
    files: 1,
    total_bytes: 10
  };
  h.$('#viewport').scrollTop = 41;
  gate.resolve({ ...h.child, id: 'child-b', path: 'C:\\Fixture\\Middle\\Nested' });
  await running;
  assert.equal(h.S.parent, 'other');
  assert.equal(h.$('#viewport').scrollTop, 41);
  assert.equal(
    h.log.some((row) => row[0] === 'page'),
    false
  );
  assert.equal(h.state().queued, 0);
});

test('viewer-open structural changes and rename batches remain queued until the real close handler flushes once', async () => {
  let h;
  h = harness((command, args) =>
    args.path ? { ...h.child, id: 'child-b', root: 'root-b', path: args.path } : h.S.current
  );
  h.$('#viewer').open = true;
  h.changed({
    root: 'root-b',
    revision: 1,
    renames: [rename(h.root, 'root-b', 'C:\\Fixture\\Middle')]
  });
  h.changed({ root: 'root-b', revision: 2 });
  await h.flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.state().queued, 1);
  assert.equal(h.S.parent, 'child-a');
  await h.close();
  assert.equal(h.S.parent, 'child-b');
  assert.equal(h.log.filter((row) => row[0] === 'page').length, 1);
  assert.equal(h.state().dirty, false);
  await h.close();
  assert.equal(h.log.filter((row) => row[0] === 'page').length, 1);
});

test('ordinary additions and removals while viewer is open refresh the actual grid after close without resetting cache', async () => {
  const h = harness(),
    cache = h.grid.items;
  h.$('#viewer').open = true;
  h.changed({ root: h.root.id, revision: 8 });
  await h.context.refreshGrowingView();
  assert.equal(
    h.log.some((row) => row[0] === 'grid'),
    false
  );
  assert.equal(h.state().dirty, true);
  await h.close();
  assert.deepEqual(
    h.log.filter((row) => row[0] === 'grid'),
    [['grid', h.child.id]]
  );
  assert.equal(h.grid.items, cache);
  assert.equal(h.S.parent, h.child.id);
  assert.equal(h.state().dirty, false);
});

test('missing current directory skips missing parents and recovers the nearest live ancestor, pruning stale navigation', async () => {
  let h;
  h = harness((command, args) => {
    assert.equal(command, 'get');
    if (args.id === h.root.id) return h.root;
    if (args.id === 'leaf') return h.S.current;
    if (args.path === h.child.path) return { ...h.child, missing: 1 };
    throw new Error('Unexpected lookup ' + JSON.stringify(args));
  });
  const leaf = {
    ...h.child,
    id: 'leaf',
    parent: h.child.id,
    path: h.child.path + '\\Leaf',
    missing: 1
  };
  h.S.parent = leaf.id;
  h.S.current = leaf;
  h.S.history.push({ parent: leaf.id, parentPath: leaf.path });
  h.folderTree.open.add(leaf.id);
  h.folderTree.openNodes.set(leaf.id, leaf);
  await h.context.refreshGrowingView();
  assert.equal(h.S.parent, h.root.id);
  assert.equal(h.S.current, h.root);
  assert.deepEqual([...h.folderTree.open], [h.root.id]);
  assert.deepEqual(
    h.S.history.map((entry) => entry.parent),
    [h.root.id]
  );
  assert.equal(
    h.log.some((row) => row[0] === 'grid'),
    false,
    'do not empty the old grid before resolving its missing location'
  );
  assert.deepEqual(
    h.log.filter((row) => row[0] === 'page'),
    [['page', true, h.root.id]]
  );
});

test('missing root preserves current cached cards, association and navigation without inventing work or deleting data', async () => {
  let h;
  h = harness((command, args) =>
    args.id === h.root.id ? { ...h.root, missing: 1 } : { ...h.child, missing: 1 }
  );
  h.S.current.metadata = { id: 940001, name: 'Existing manual association' };
  const cache = h.grid.items,
    history = plain(h.S.history);
  h.changed({ root: h.root.id, revision: 9 });
  await h.flush();
  assert.equal(h.S.parent, h.child.id);
  assert.equal(h.S.current.metadata.id, 940001);
  assert.equal(h.grid.items, cache);
  assert.deepEqual(plain(h.S.history), history);
  assert.equal(
    h.log.some((row) => row[0] === 'grid' || row[0] === 'page'),
    false
  );
  assert.match(h.$('#footer-status').textContent, /保留关联与缓存/);
  assert.ok(h.calls.every(([command]) => command === 'get'));
});

test('only a successful current user navigation sends one nonblocking browse sync request', async () => {
  const never = deferred();
  const h = harness((command) => {
    assert.equal(command, 'filesystemSync');
    return never.promise;
  });
  new vm.Script(section(source, 'function snapshot()', 'async function back()'), {
    filename
  }).runInContext(h.context);
  await h.context.navigate({ parent: h.child.id, filter: 'images' });
  assert.deepEqual(h.calls, [['filesystemSync', { reason: 'browse', id: h.child.id }]]);
  assert.equal(h.$('#viewport').focused, true);
  await h.context.navigate({ parent: null });
  assert.equal(h.calls.length, 1, 'overview has no current directory to probe');
});

test('an obsolete navigation cannot send browse sync or restore scroll over a newer selection', async () => {
  const h = harness(),
    gate = deferred();
  new vm.Script(section(source, 'function snapshot()', 'async function back()'), {
    filename
  }).runInContext(h.context);
  h.context.loadPage = async () => {
    h.S.loadVersion++;
    await gate.promise;
  };
  const running = h.context.navigate({ parent: h.child.id });
  h.S.loadVersion++;
  h.S.parent = 'other';
  h.$('#viewport').scrollTop = 51;
  gate.resolve();
  await running;
  assert.equal(h.calls.length, 0);
  assert.equal(h.$('#viewport').scrollTop, 51);
  assert.equal(h.$('#viewport').focused, undefined);
});

test('first-document startup probes the loaded directory without tying the first paint to its reply', async () => {
  const gate = deferred();
  const h = harness((command) => {
    assert.equal(command, 'filesystemSync');
    return gate.promise;
  });
  new vm.Script(section(source, 'function requestBrowseFilesystemSync(', 'async function back()'), {
    filename
  }).runInContext(h.context);
  let ready;
  h.context.document = {
    addEventListener(type, fn) {
      assert.equal(type, 'DOMContentLoaded');
      ready = fn;
    }
  };
  h.context.loadSummary = async () => ({ progress: { active: false, busy: false }, online: null });
  h.context.showMetadataOnboarding = async () => {};
  const start = source.lastIndexOf("document.addEventListener(\n  'DOMContentLoaded'");
  assert.ok(start > 0);
  new vm.Script(source.slice(start), { filename }).runInContext(h.context);
  ready();
  await h.idle();
  assert.deepEqual(h.calls, [['filesystemSync', { reason: 'browse', id: h.child.id }]]);
  assert.equal(h.S.loadVersion, 6);
});

test('the real preload admits the fixed filesystemSync method and preserves the IPC boundary', async () => {
  let bridge;
  const calls = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'album');
            bridge = value;
          }
        },
        ipcRenderer: {
          async invoke(...args) {
            calls.push(args);
            return { accepted: true };
          },
          on() {},
          removeListener() {}
        }
      };
    }
  });
  assert.deepEqual(await bridge.call('filesystemSync', { reason: 'browse', id: 'folder' }), {
    accepted: true
  });
  assert.deepEqual(calls, [['library:filesystemSync', { reason: 'browse', id: 'folder' }]]);
  await assert.rejects(bridge.call('arbitraryFilesystemAction'), /不支持/);
  assert.equal(calls.length, 1);
});

test('a rejected background browse probe stays silent and cannot reject a completed navigation', async () => {
  const h = harness(() => Promise.reject(new Error('Background unavailable')));
  new vm.Script(section(source, 'function snapshot()', 'async function back()'), {
    filename
  }).runInContext(h.context);
  await h.context.navigate({ parent: h.child.id });
  assert.equal(h.calls.length, 1);
  assert.equal(h.$('#viewport').focused, true);
});

test('late missing-directory lookup cannot redirect a newly selected location', async () => {
  const gate = deferred();
  let h;
  h = harness((command, args) =>
    args.id === h.child.id ? { ...h.child, missing: 1 } : gate.promise
  );
  const running = h.context.refreshGrowingView();
  await Promise.resolve();
  await Promise.resolve();
  h.S.parent = 'other';
  h.S.loadVersion++;
  h.S.current = { id: 'other', path: 'D:\\Other' };
  gate.resolve(h.root);
  await running;
  assert.equal(h.S.parent, 'other');
  assert.equal(
    h.log.some((row) => row[0] === 'page'),
    false
  );
});
