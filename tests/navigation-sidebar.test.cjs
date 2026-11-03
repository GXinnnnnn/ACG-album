'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/navigation.js'), 'utf8');
const treeSource = source.slice(0, source.indexOf('function updateCoverNode('));
const treeModel = require('../src/ui/sidebar-tree-model.js');
const eventsSource = source.slice(
  source.indexOf('const sidebarShell ='),
  source.indexOf('window.applyNavigationSettings =')
);
const root = {
  id: 'root',
  name: 'Generated root',
  path: 'D:\\Generated',
  folders: 2,
  parent: null
};
const children = [
  { id: 'child-a', name: 'A', path: 'D:\\Generated\\A', folders: 1, parent: 'root' },
  { id: 'child-b', name: 'B', path: 'D:\\Generated\\B', folders: 0, parent: 'root' }
];
function fixture({ roots = [root], mode = 'auto', current = null, pages, defer = false } = {}) {
  const elements = new Map(),
    timers = new Map(),
    requests = [],
    pending = [],
    errors = [],
    settings = [],
    windowEvents = new Map(),
    mutations = [];
  const document = {};
  let sequence = 0,
    nav;
  function element(id = '') {
    const el = {
      id,
      className: '',
      dataset: {},
      attributes: {},
      children: [],
      parentElement: null,
      inert: false,
      hidden: false,
      scrollTop: 0,
      clientHeight: 390,
      click() {
        return el.onclick?.();
      },
      remove() {
        if (el.contains(document.activeElement)) document.activeElement = outside;
        if (el.parentElement) {
          mutations.push({ element: el.parentElement, kind: 'childList', removed: el });
          el.parentElement.children = el.parentElement.children.filter((child) => child !== el);
          el.parentElement = null;
        }
      },
      removeAttribute(name) {
        delete el.attributes[name];
      },
      hover: false,
      focusVisible: false,
      listeners: new Map(),
      style: new Proxy(
        {
          setProperty(name, value) {
            mutations.push({ element: el, kind: 'style', name, value });
          }
        },
        {
          set(target, name, value) {
            mutations.push({ element: el, kind: 'style', name, value });
            target[name] = value;
            return true;
          }
        }
      ),
      get innerHTML() {
        return el.markup || '';
      },
      set innerHTML(value) {
        el.replaceChildren();
        el.markup = value;
      },
      setAttribute(name, value) {
        mutations.push({ element: el, kind: 'attribute', name, value });
        el.attributes[name] = String(value);
      },
      getAttribute(name) {
        return el.attributes[name] ?? null;
      },
      append(...nodes) {
        for (const child of nodes) {
          mutations.push({ element: el, kind: 'childList', added: child });
          child.parentElement = el;
          el.children.push(child);
        }
      },
      replaceChildren() {
        for (const child of el.children) child.parentElement = null;
        el.children = [];
        el.markup = '';
      },
      contains(other) {
        return el === other || el.children.some((child) => child.contains(other));
      },
      focus() {
        if (document.activeElement === el) return;
        document.activeElement = el;
        for (const action of windowEvents.get('focusin') || []) action({ target: el });
      },
      matches(selector) {
        if (selector === ':hover') return el.hover;
        if (selector === ':focus-visible') return el.focusVisible;
        if (selector.startsWith('#')) return el.id === selector.slice(1);
        if (selector.startsWith('.')) return el.className.split(/\s+/).includes(selector.slice(1));
        const data = /^\[data-([\w-]+)="([^"]*)"\]$/.exec(selector);
        return (
          !!data && el.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === data[2]
        );
      },
      closest(selector) {
        for (let node = el; node; node = node.parentElement)
          if (selector.split(',').some((part) => node.matches(part))) return node;
        return null;
      },
      querySelectorAll(selector) {
        const found = [];
        function visit(parent) {
          for (const child of parent.children) {
            if (child.matches(selector)) found.push(child);
            visit(child);
          }
        }
        visit(el);
        return found;
      },
      querySelector(selector) {
        return el.querySelectorAll(selector)[0] || null;
      },
      addEventListener(type, action) {
        if (!el.listeners.has(type)) el.listeners.set(type, []);
        el.listeners.get(type).push(action);
      },
      dispatch(type, event = {}) {
        for (const action of windowEvents.get(type) || []) action({ target: el, ...event });
        if (type === 'pointerenter') el.hover = true;
        if (type === 'pointerleave') el.hover = false;
        for (const action of el.listeners.get(type) || []) action({ target: el, ...event });
      },
      classList: {
        toggle(name, value) {
          const classes = new Set(el.className.split(/\s+/).filter(Boolean));
          if (value) classes.add(name);
          else classes.delete(name);
          el.className = [...classes].join(' ');
        }
      }
    };
    return el;
  }
  for (const id of [
    'sidebar-shell',
    'sidebar-details',
    'sidebar-pin',
    'sidebar-copyright',
    'rail-tree',
    'category-nav',
    'context-menu',
    'profile-button',
    'collapse-all'
  ])
    elements.set('#' + id, element(id));
  const shell = elements.get('#sidebar-shell'),
    details = elements.get('#sidebar-details'),
    host = elements.get('#category-nav'),
    pin = elements.get('#sidebar-pin'),
    tree = elements.get('#rail-tree'),
    outside = element('outside');
  shell.append(tree, details, pin, elements.get('#sidebar-copyright'));
  details.append(host);
  elements.get('#context-menu').hidden = true;
  elements.set('.app-shell', element());
  document.activeElement = outside;
  document.createElement = () => element();
  const S = {
    settings: { sidebarMode: mode, nickname: 'Generated' },
    roots,
    current,
    overviewExpanded: new Set()
  };
  const folders =
    pages ||
    new Map([
      ['root', children],
      [
        'child-a',
        [
          {
            id: 'grandchild',
            name: 'Grandchild',
            path: 'D:\\Generated\\A\\Grandchild',
            folders: 0,
            parent: 'child-a'
          }
        ]
      ]
    ]);
  const context = {
    S,
    albumSidebarTree: treeModel,
    window: {
      addEventListener(type, action) {
        if (!windowEvents.has(type)) windowEvents.set(type, []);
        windowEvents.get(type).push(action);
      }
    },
    requestAnimationFrame(action) {
      timers.set(++sequence, action);
      return sequence;
    },
    isOverview: () => false,
    document,
    CSS: { escape: String },
    $: (selector) => elements.get(selector),
    $$: () => [],
    matchMedia: () => ({ matches: false }),
    setTimeout(action) {
      timers.set(++sequence, action);
      return sequence;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    queueMicrotask,
    svg: () => '<svg></svg>',
    esc: String,
    fmt: String,
    api: async (method, args) => {
      assert.equal(method, 'list');
      requests.push(args);
      if (defer) await new Promise((resolve) => pending.push(resolve));
      const nodes = (folders.get(args.parent) || []).filter(treeModel.folder);
      return {
        items: nodes.slice(args.offset || 0, (args.offset || 0) + args.limit),
        total: nodes.length
      };
    },
    attempt: (action) =>
      Promise.resolve()
        .then(action)
        .catch((error) => {
          errors.push(error);
        }),
    saveSetting: async (key, value) => {
      settings.push({ key, value });
      S.settings[key] = value;
      nav.applyNavigationSettings();
    },
    navigate: () => {},
    showContext: () => {}
  };
  nav = vm.runInNewContext(
    treeSource +
      '\n' +
      eventsSource +
      '\n({ folderTree, setSidebarOpen, applyNavigationSettings, openFolderTree, renderFolderTree, toggleTree, fetchTreePage, invalidateFolderTree, focusTreeIndex, get layout() { return treeLayout; }, get isOpen() { return sidebarOpen; } });',
    context
  );
  nav.applyNavigationSettings();
  nav.renderFolderTree();
  const row = (id) => host.querySelector(`[data-node-id="${id}"]`)?.querySelector('.tree-row');
  return {
    nav,
    S,
    shell,
    details,
    host,
    pin,
    tree,
    outside,
    document,
    requests,
    context,
    errors,
    settings,
    mutations,
    row,
    contextMenu: elements.get('#context-menu'),
    runTimers() {
      const work = [...timers.values()];
      timers.clear();
      for (const action of work) action();
    },
    release() {
      for (const resolve of pending.splice(0)) resolve();
    }
  };
}

test('pointerenter then folder click expands actual children instead of only opening the shell', async () => {
  const f = fixture();
  f.shell.dispatch('pointerenter');
  f.runTimers();
  assert.equal(f.nav.isOpen, true);
  assert.equal(f.row('root').getAttribute('aria-expanded'), 'false');
  assert.equal(f.host.querySelectorAll('.tree-children').length, 0);
  assert.equal(f.requests.length, 0);
  await f.tree.onclick();
  assert.equal(f.row('root').getAttribute('aria-expanded'), 'true');
  assert.equal(f.host.querySelectorAll('.tree-virtual-content').length, 1);
  assert.equal(f.host.querySelectorAll('.tree-pager').length, 0);
  assert.ok(f.row('child-a'));
  assert.ok(f.row('child-b'));
  assert.equal(f.requests[0].parent, 'root');
  assert.equal(f.requests[0].filter, 'folders');
  await f.nav.toggleTree(children[0]);
  assert.ok(f.row('grandchild'));
  await f.tree.onclick();
  assert.equal(f.nav.folderTree.open.has('child-a'), true);
  assert.ok(f.row('grandchild'));
  assert.equal(f.requests.length, 2, 'repeated clicks reuse loaded branch pages');
  assert.deepEqual(f.errors, []);
});

test('repeated clicks while a branch loads keep it open and issue only one list request', async () => {
  const f = fixture({ defer: true });
  f.shell.dispatch('pointerenter');
  f.runTimers();
  const first = f.tree.onclick();
  await Promise.resolve();
  assert.equal(f.requests.length, 1);
  assert.ok(f.host.querySelector('.tree-pending'));
  const repeated = f.tree.onclick();
  await repeated;
  assert.equal(f.requests.length, 1);
  assert.equal(f.nav.folderTree.open.has('root'), true);
  f.release();
  await first;
  assert.ok(f.row('child-a'));
  assert.equal(f.row('root').getAttribute('aria-expanded'), 'true');
});

function delayedRootOpening() {
  const nodes = Array.from({ length: 640 }, (_, i) => ({
    id: 'folder-' + i,
    name: 'Folder ' + i,
    path: root.path + '\\Folder ' + i,
    folders: 0,
    parent: root.id
  }));
  return fixture({
    roots: [{ ...root, folders: nodes.length }],
    pages: new Map([[root.id, nodes]]),
    defer: true
  });
}

test('a real wheel intent during the first folder page prevents a late opening from resetting scroll', async () => {
  const f = delayedRootOpening(),
    opening = f.tree.onclick();
  await Promise.resolve();
  assert.equal(f.row(root.id).getAttribute('aria-expanded'), 'true');
  assert.equal(f.nav.folderTree.loading.has(root.id), true);
  f.host.dispatch('wheel', { deltaY: 100000 });
  f.host.scrollTop = 600 * treeModel.ROW_HEIGHT;
  f.release();
  await opening;
  assert.equal(f.host.scrollTop, 600 * treeModel.ROW_HEIGHT);
  assert.equal(f.nav.folderTree.open.has(root.id), true);
  assert.deepEqual(f.errors, []);
});

test('an uninterrupted delayed opening still reveals its root after the first page completes', async () => {
  const f = delayedRootOpening(),
    opening = f.tree.onclick();
  await Promise.resolve();
  f.host.scrollTop = 600 * treeModel.ROW_HEIGHT;
  f.release();
  await opening;
  assert.equal(f.host.scrollTop, 0);
  assert.equal(f.nav.folderTree.open.has(root.id), true);
  assert.deepEqual(f.errors, []);
});

test('a retired opening generation cannot reveal its root after an old page returns', async () => {
  const f = delayedRootOpening(),
    opening = f.tree.onclick();
  await Promise.resolve();
  f.nav.folderTree.generation++;
  f.nav.folderTree.requests.clear();
  f.nav.folderTree.loading.clear();
  f.host.scrollTop = 600 * treeModel.ROW_HEIGHT;
  f.release();
  await opening;
  assert.equal(f.host.scrollTop, 600 * treeModel.ROW_HEIGHT);
  assert.deepEqual(f.errors, []);
});

test('a shell closed during the first page is not scrolled by the completed opening', async () => {
  const f = delayedRootOpening(),
    opening = f.tree.onclick();
  await Promise.resolve();
  f.nav.setSidebarOpen(false);
  f.host.scrollTop = 600 * treeModel.ROW_HEIGHT;
  f.release();
  await opening;
  assert.equal(f.nav.isOpen, false);
  assert.equal(f.host.scrollTop, 600 * treeModel.ROW_HEIGHT);
  assert.deepEqual(f.errors, []);
});

test('folder click scrolls to the current root and respects Windows path boundaries', async () => {
  const roots = Array.from({ length: 15 }, (_, i) => ({
    id: 'root-' + i,
    name: 'Root ' + i,
    path: 'D:\\Generated\\Root' + i,
    folders: 1
  }));
  const f = fixture({
    roots,
    current: { id: 'inside-13', path: 'd:/generated/root13/inside' },
    pages: new Map([
      [
        'root-13',
        [
          {
            id: 'inside-13',
            name: 'Inside',
            path: 'D:\\Generated\\Root13\\inside',
            folders: 0,
            parent: 'root-13'
          }
        ]
      ]
    ])
  });
  await f.tree.onclick();
  assert.equal(f.nav.folderTree.rootOffset, 13);
  assert.ok(f.host.scrollTop > 0);
  assert.equal(f.requests[0].parent, 'root-13');
  assert.equal(f.row('root-13').getAttribute('aria-expanded'), 'true');
  assert.ok(f.row('inside-13'));
  assert.ok(f.row('root-14'), 'later roots remain in the continuous logical list');
  assert.equal(f.host.querySelector('.tree-pager'), null);
});

test('an empty library and leaf-only roots remain visible without inventing child requests', async () => {
  const empty = fixture({ roots: [] });
  await empty.tree.onclick();
  assert.equal(empty.nav.isOpen, true);
  assert.equal(empty.details.inert, false);
  assert.match(empty.host.innerHTML, /导入文件夹后/);
  assert.equal(empty.requests.length, 0);
  const leaves = fixture({ roots: [{ ...root, folders: 0 }] });
  await leaves.tree.onclick();
  assert.ok(leaves.row('root'));
  assert.equal(leaves.requests.length, 0);
  assert.equal(leaves.nav.isOpen, true);
});

test('Escape from tree content restores the folder control while leaving the collapsed pin usable', async () => {
  const f = fixture();
  await f.tree.onclick();
  const link = f.host.querySelector('[data-tree-key="child-a:link"]');
  link.focusVisible = true;
  link.focus();
  let prevented = false;
  f.shell.dispatch('keydown', {
    target: link,
    key: 'Escape',
    preventDefault() {
      prevented = true;
    }
  });
  assert.equal(prevented, true);
  assert.equal(f.nav.isOpen, false);
  assert.equal(f.document.activeElement, f.tree);
  assert.equal(f.details.inert, true);
  assert.equal(f.pin.inert, false);
  assert.equal(f.tree.getAttribute('aria-expanded'), 'false');
});

test('collapsed pin accepts keyboard focus, toggles persistence and restores compact mode', async () => {
  const f = fixture({ mode: 'compact' });
  assert.equal(f.pin.inert, false);
  f.pin.focusVisible = true;
  f.pin.focus();
  f.shell.dispatch('focusin', { target: f.pin });
  assert.equal(f.nav.isOpen, false, 'focusing a visible pin does not reveal the hidden tree');
  await f.pin.onclick();
  assert.equal(f.S.settings.sidebarMode, 'expanded');
  assert.equal(f.nav.isOpen, true);
  assert.equal(f.pin.getAttribute('aria-pressed'), 'true');
  assert.equal(f.pin.title, '取消固定侧栏');
  await f.pin.onclick();
  assert.equal(f.S.settings.sidebarMode, 'compact');
  assert.equal(f.pin.getAttribute('aria-pressed'), 'false');
  f.shell.dispatch('keydown', { key: 'Escape', target: f.pin, preventDefault() {} });
  assert.equal(f.nav.isOpen, false);
  assert.equal(f.document.activeElement, f.pin);
  assert.equal(f.pin.inert, false);
});

test('keyboard focus and context menus protect tree browsing from pointerleave collapse', async () => {
  const f = fixture();
  await f.tree.onclick();
  const link = f.host.querySelector('[data-tree-key="child-a:link"]');
  link.focusVisible = true;
  link.focus();
  f.shell.dispatch('pointerleave');
  f.runTimers();
  assert.equal(f.nav.isOpen, true);
  f.document.activeElement = f.outside;
  f.shell.dispatch('focusout');
  f.runTimers();
  assert.equal(f.nav.isOpen, false);
  const pointer = fixture();
  pointer.shell.dispatch('pointerenter');
  pointer.runTimers();
  pointer.contextMenu.hidden = false;
  pointer.shell.dispatch('pointerleave');
  pointer.runTimers();
  assert.equal(pointer.nav.isOpen, true);
  pointer.contextMenu.hidden = true;
  pointer.shell.dispatch('focusout');
  pointer.runTimers();
  assert.equal(pointer.nav.isOpen, false);
});

test('unchanged tree snapshots retain row identity, open pages, focus and scroll', async () => {
  const f = fixture();
  await f.tree.onclick();
  const row = f.row('child-a'),
    rootRow = f.row('root'),
    link = row.querySelector('.category-link'),
    requests = f.requests.length;
  link.focus();
  f.host.clientHeight = 30;
  f.host.scrollTop = 87;
  for (let i = 0; i < 100; i++) {
    f.S.roots = f.S.roots.map((n) => ({ ...n, subject_id: i, metadata: { updated: i } }));
    f.nav.renderFolderTree();
  }
  assert.equal(f.row('root'), rootRow);
  assert.equal(f.row('child-a'), row);
  assert.equal(f.document.activeElement, link);
  assert.equal(f.host.scrollTop, 87);
  assert.equal(f.requests.length, requests);
  assert.equal(f.nav.folderTree.pages.size, 1);
  let contextual;
  f.context.showContext = (_, node) => {
    contextual = node;
  };
  f.context.api = async (method, args) => {
    assert.equal(method, 'get');
    assert.equal(args.id, root.id);
    return { ...f.S.roots[0], subject_id: 102 };
  };
  await rootRow.oncontextmenu({ preventDefault() {}, stopPropagation() {} });
  assert.equal(contextual.subject_id, 102, 'retained handlers read authoritative metadata');
  const childRow = f.row('child-a');
  f.context.api = async () => ({
    ...children[0],
    match_review: 1,
    subject_id: 42,
    cover: 'online'
  });
  await childRow.oncontextmenu({ preventDefault() {}, stopPropagation() {} });
  assert.equal(contextual.match_review, 1, 'paged child confirmation uses current match state');
  assert.equal(contextual.cover, 'online', 'crop actions receive the current cover');
  assert.equal(f.row('child-a'), childRow, 'metadata lookup preserves the visible tree');
});

test('unchanged cached scroll frames and summary metadata perform no tree DOM attribute or style writes', async () => {
  const f = fixture();
  await f.tree.onclick();
  await settle();
  f.mutations.length = 0;
  for (let index = 0; index < 40; index++) {
    f.S.roots = f.S.roots.map((node) => ({ ...node, metadata: { revision: index } }));
    f.nav.renderFolderTree();
  }
  assert.equal(
    f.mutations.filter((entry) => f.host.contains(entry.element)).length,
    0,
    'unchanged cached frames must not mutate tree attributes or style'
  );
});

test('visible tree changes update selection, labels and directory counts in retained rows', async () => {
  const f = fixture();
  await f.tree.onclick();
  const old = f.row('root');
  f.S.roots = [{ ...root, name: 'Renamed', folders: 3 }];
  f.S.current = { ...children[0] };
  f.nav.renderFolderTree();
  assert.equal(f.row('root'), old, 'metadata changes update the existing row');
  assert.match(f.row('root').querySelector('.category-link').innerHTML, />3</);
  assert.match(f.row('root').querySelector('.category-link').innerHTML, /Renamed/);
  assert.equal(f.row('child-a').getAttribute('aria-selected'), 'true');
  assert.equal(f.row('root').getAttribute('aria-expanded'), 'true');
  assert.equal(f.requests.length, 1, 'content update keeps cached directory pages');
});

const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise(setImmediate);
};
function wideFolders(size = 640) {
  return Array.from({ length: size }, (_, i) => ({
    id: 'folder-' + i,
    kind: 'folder',
    name: 'Folder ' + String(i).padStart(4, '0'),
    sortkey: 'folder ' + String(i).padStart(4, '0'),
    path: 'D:\\Generated\\Folder' + i,
    folders: 0,
    parent: 'root'
  }));
}
async function heightChangingTree({ size = 640, top = 510 * treeModel.ROW_HEIGHT } = {}) {
  const nodes = wideFolders(size),
    pages = new Map([['root', nodes]]),
    f = fixture({ roots: [{ ...root, folders: size }], pages });
  f.host.clientHeight = 137.5;
  await f.tree.onclick();
  f.host.scrollTop = top;
  f.nav.renderFolderTree();
  await settle();
  return { ...f, nodes, pages };
}

test('viewport height task-status cycles retain all committed rows with zero DOM writes', async () => {
  const f = await heightChangingTree();
  const link = f.row('folder-510').querySelector('.category-link');
  link.focus();
  f.nav.renderFolderTree();
  const groups = f.host.querySelectorAll('.tree-node'),
    top = f.host.scrollTop;
  f.mutations.length = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const height of [98.5, 137.5]) {
      f.host.clientHeight = height;
      f.nav.renderFolderTree();
      f.nav.invalidateFolderTree();
      await settle();
      for (const group of groups) assert.ok(f.host.contains(group), 'overscan stays connected');
      assert.equal(f.host.scrollTop, top);
      assert.equal(f.document.activeElement, link);
      assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
      assert.equal(f.mutations.filter((entry) => f.host.contains(entry.element)).length, 0);
    }
  }
  assert.deepEqual(f.errors, []);
});

test('viewport height retention ends on a one-pixel native scroll even within the same first row', async () => {
  const f = await heightChangingTree(),
    tail = f.host.querySelectorAll('.tree-node').at(-1),
    count = f.host.querySelectorAll('.tree-node').length;
  f.host.clientHeight = 98.5;
  f.nav.renderFolderTree();
  assert.ok(f.host.contains(tail));
  f.host.scrollTop += 1;
  f.host.dispatch('scroll');
  f.runTimers();
  await settle();
  assert.equal(f.host.contains(tail), false);
  assert.equal(f.host.querySelectorAll('.tree-node').length, count - 1);
  assert.equal(f.host.scrollTop % treeModel.ROW_HEIGHT, 1);
});

test('viewport height recovery prepares the retained tail page before committing across a page boundary', async () => {
  const f = await heightChangingTree({ top: 118 * treeModel.ROW_HEIGHT }),
    groups = f.host.querySelectorAll('.tree-node'),
    api = f.context.api,
    offsets = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.context.api = async (method, args) => {
    offsets.push(args.offset);
    await gate;
    return api(method, args);
  };
  f.host.clientHeight = 98.5;
  f.mutations.length = 0;
  f.nav.invalidateFolderTree();
  await settle();
  for (const group of groups) assert.ok(f.host.contains(group));
  release();
  await settle();
  assert.ok(offsets.includes(128), 'retained folder 128 requires its actual destination page');
  assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
  for (const group of groups) assert.ok(f.host.contains(group));
  assert.equal(f.mutations.filter((entry) => f.host.contains(entry.element)).length, 0);
});

test('viewport height staging does not publish a larger uncommitted range to the live tree', async () => {
  const f = await heightChangingTree({ top: 118 * treeModel.ROW_HEIGHT }),
    groups = f.host.querySelectorAll('.tree-node'),
    api = f.context.api,
    pending = [];
  f.context.api = async (...args) => {
    await new Promise((resolve) => pending.push(resolve));
    return api(...args);
  };
  f.host.clientHeight = 390;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(pending.length, 1);
  pending.shift()();
  await settle();
  assert.equal(pending.length, 1, 'larger staged range awaits its next page');
  f.host.clientHeight = 98.5;
  f.mutations.length = 0;
  f.nav.renderFolderTree();
  assert.equal(f.host.querySelectorAll('.tree-node').length, groups.length);
  for (const group of groups) assert.ok(f.host.contains(group));
  pending.shift()();
  await settle();
  assert.equal(pending.length, 0);
  assert.equal(f.host.querySelectorAll('.tree-node').length, groups.length);
  assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
  assert.equal(f.mutations.filter((entry) => f.host.contains(entry.element)).length, 0);
});

test('viewport height retention still applies real last-folder deletion, collapse and root removal', async () => {
  const f = await heightChangingTree({ top: 640 * treeModel.ROW_HEIGHT - 137.5 });
  assert.ok(f.row('folder-639'));
  f.host.clientHeight = 98.5;
  f.nav.renderFolderTree();
  f.nodes.pop();
  f.S.roots[0].folders--;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(f.nav.layout.total, 640);
  assert.equal(f.row('folder-639'), undefined);
  assert.equal(f.host.children[0].style.height, 640 * treeModel.ROW_HEIGHT + 'px');
  await f.nav.toggleTree(f.S.roots[0]);
  assert.equal(f.nav.layout.total, 1);
  assert.equal(f.host.querySelectorAll('.tree-node').length, 1);
  f.S.roots = [];
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(f.nav.layout.total, 0);
  assert.equal(f.host.querySelectorAll('.tree-node').length, 0);
  assert.deepEqual(f.errors, []);
});

test('viewport height retention resets when the shell closes or an equal-size root is replaced', async () => {
  const f = await heightChangingTree();
  f.host.clientHeight = 98.5;
  f.nav.setSidebarOpen(false);
  f.nav.setSidebarOpen(true);
  f.nav.renderFolderTree();
  assert.equal(f.host.querySelectorAll('.tree-node').length, 19);
  f.host.clientHeight = 137.5;
  f.nav.renderFolderTree();
  assert.equal(f.host.querySelectorAll('.tree-node').length, 20);
  const replacement = { ...f.S.roots[0], id: 'replacement-root' },
    nodes = f.nodes.map((node) => ({ ...node, id: 'new-' + node.id, parent: replacement.id }));
  f.S.roots = [replacement];
  f.nav.folderTree.open = new Set([replacement.id]);
  f.nav.folderTree.openNodes = new Map([[replacement.id, replacement]]);
  f.nav.folderTree.pages.clear();
  treeModel.storePage(
    f.nav.folderTree.pages,
    replacement.id,
    { items: nodes.slice(384, 512), total: 640 },
    384
  );
  treeModel.storePage(
    f.nav.folderTree.pages,
    replacement.id,
    { items: nodes.slice(512), total: 640 },
    512
  );
  f.host.clientHeight = 98.5;
  f.nav.renderFolderTree();
  await settle();
  assert.equal(f.host.querySelectorAll('.tree-node').length, 19);
  assert.ok(
    f.host.querySelectorAll('.tree-node').every((group) => group.treeNode.parent === replacement.id)
  );
  assert.equal(f.nav.layout.total, 641);
});

test('viewport height large resize stays within row and cache budgets with one offscreen native focus', async () => {
  const f = await heightChangingTree({ size: 4096, top: 0 }),
    focus = f.row('folder-0').querySelector('.category-link');
  focus.focus();
  f.host.scrollTop = 510 * treeModel.ROW_HEIGHT;
  f.host.clientHeight = 12000;
  f.nav.renderFolderTree();
  await settle();
  assert.equal(f.host.querySelectorAll('.tree-node').length, treeModel.MAX_ROWS);
  assert.ok(f.host.contains(focus));
  for (const height of [98.5, 12000, 98.5]) {
    f.host.clientHeight = height;
    f.nav.renderFolderTree();
    f.nav.invalidateFolderTree();
    await settle();
    assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
    assert.equal(f.host.querySelectorAll('.tree-node').length, treeModel.MAX_ROWS);
    assert.equal(f.document.activeElement, focus);
    assert.ok(f.nav.folderTree.pages.get('root').items.length <= 1536);
  }
  f.host.scrollTop += 1;
  f.host.dispatch('scroll');
  f.runTimers();
  await settle();
  assert.ok(f.host.querySelectorAll('.tree-node').length <= 20);
  assert.equal(f.document.activeElement, focus);
  assert.deepEqual(f.errors, []);
});

test('continuous scrolling reaches folder 600 among media without loading the full sibling list', async () => {
  const nodes = wideFolders(),
    media = Array.from({ length: 70 }, (_, i) => ({
      id: 'image-' + i,
      kind: 'image',
      parent: 'root'
    })),
    f = fixture({
      roots: [{ ...root, folders: nodes.length }],
      pages: new Map([['root', [...nodes, ...media]]])
    });
  await f.tree.onclick();
  assert.equal(f.nav.folderTree.pages.get('root').items.length, 128);
  await f.nav.focusTreeIndex(601);
  await settle();
  assert.ok(f.row('folder-600'));
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-600:link');
  assert.ok(f.host.scrollTop > 500 * treeModel.ROW_HEIGHT);
  assert.equal(f.host.querySelector('.tree-pager'), null);
  assert.equal(
    f.host.querySelectorAll('.tree-node').some((n) => n.treeNode.kind === 'image'),
    false
  );
  assert.ok(f.host.querySelectorAll('.tree-node').length <= treeModel.MAX_ROWS);
  assert.ok(f.requests.every((q) => q.filter === 'folders' && q.limit === 128));
  assert.ok(f.requests.some((q) => q.offset === 512));
  assert.ok(f.requests.length < 5, 'jump loads viewport pages rather than every skipped directory');
  assert.deepEqual(f.errors, []);
});
test('wheel scroll retains one offscreen focused row and bounds repeated cache growth', async () => {
  const nodes = wideFolders(4096),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages: new Map([['root', nodes]]) });
  await f.tree.onclick();
  const link = f.row('folder-0').querySelector('.category-link');
  link.focus();
  for (let ordinal = 256; ordinal < nodes.length; ordinal += 256) {
    f.host.scrollTop = (ordinal + 1) * treeModel.ROW_HEIGHT;
    f.host.dispatch('scroll');
    f.runTimers();
    await f.nav.fetchTreePage(f.S.roots[0], ordinal);
    await settle();
    assert.equal(f.document.activeElement, link);
    assert.ok(f.host.contains(link));
    assert.ok(f.host.querySelectorAll('.tree-node').length <= treeModel.MAX_ROWS);
    assert.ok(f.nav.folderTree.pages.get('root').chunks.size <= treeModel.CACHE_PAGES);
  }
  assert.ok(f.nav.folderTree.pages.get('root').items.length <= 1536);
  assert.deepEqual(f.errors, []);
});
test('End, Home and arrows move through logical rows beyond the rendered window', async () => {
  const nodes = wideFolders(),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages: new Map([['root', nodes]]) });
  await f.tree.onclick();
  const key = async (name) => {
    let prevented = false;
    f.host.dispatch('keydown', {
      target: f.document.activeElement,
      key: name,
      preventDefault() {
        prevented = true;
      }
    });
    await settle();
    assert.equal(prevented, true);
  };
  f.row('root').querySelector('.category-link').focus();
  await key('End');
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-639:link');
  await key('ArrowUp');
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-638:link');
  await key('Home');
  assert.equal(f.document.activeElement.dataset.treeKey, 'root:link');
  await key('ArrowRight');
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-0:link');
  await key('ArrowLeft');
  assert.equal(f.document.activeElement.dataset.treeKey, 'root:link');
  assert.deepEqual(f.errors, []);
});
test('a path deeper than five levels keeps expanding and parent navigation uses logical ancestry', async () => {
  const chain = Array.from({ length: 10 }, (_, i) => ({
      id: 'depth-' + i,
      kind: 'folder',
      name: 'Level ' + i,
      folders: i < 9 ? 1 : 0,
      path: 'D:\\Generated' + '\\level'.repeat(i),
      parent: i ? 'depth-' + (i - 1) : null
    })),
    pages = new Map(chain.slice(0, -1).map((n, i) => [n.id, [chain[i + 1]]])),
    f = fixture({ roots: [chain[0]], pages });
  await f.tree.onclick();
  for (const n of chain.slice(1, -1)) await f.nav.toggleTree(n);
  assert.ok(f.row('depth-9'));
  assert.equal(f.row('depth-9').getAttribute('aria-level'), '10');
  assert.equal(f.host.querySelector('.tree-more'), null);
  f.row('depth-9').querySelector('.category-link').focus();
  f.host.dispatch('keydown', {
    target: f.document.activeElement,
    key: 'ArrowLeft',
    preventDefault() {}
  });
  await settle();
  assert.equal(f.document.activeElement.dataset.treeKey, 'depth-8:link');
  await f.nav.toggleTree(chain[0]);
  assert.equal(f.nav.folderTree.open.size, 0);
  assert.equal(f.nav.folderTree.pages.size, 0);
  assert.equal(f.nav.folderTree.openNodes.size, 0);
  assert.equal(f.document.activeElement.dataset.treeKey, 'depth-0:link');
});
test('old single-flight waiters cannot repopulate a reopened branch after invalidation', async () => {
  const nodes = wideFolders(),
    f = fixture({
      defer: true,
      roots: [{ ...root, folders: nodes.length }],
      pages: new Map([['root', nodes]])
    });
  const first = f.tree.onclick();
  await settle();
  const waiting = f.nav.fetchTreePage(f.S.roots[0], 128);
  await f.nav.toggleTree(f.S.roots[0]);
  f.nav.invalidateFolderTree();
  const reopened = f.tree.onclick();
  await settle();
  assert.equal(f.requests.length, 2);
  f.release();
  await Promise.all([first, waiting, reopened]);
  await settle();
  assert.equal(f.requests.length, 2, 'the old queued page does not start in the new generation');
  assert.deepEqual([...f.nav.folderTree.pages.get('root').chunks.keys()], [0]);
});
test('refresh locates a renamed open node beyond page 500 without losing its expanded child', async () => {
  const nodes = wideFolders(),
    old = { ...nodes[520], folders: 1 },
    leaf = {
      id: 'leaf',
      kind: 'folder',
      name: 'Leaf',
      path: old.path + '\\Leaf',
      parent: old.id,
      folders: 0
    };
  nodes[520] = old;
  const pages = new Map([
      ['root', nodes],
      [old.id, [leaf]]
    ]),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages });
  await f.tree.onclick();
  await f.nav.focusTreeIndex(521);
  await f.nav.toggleTree(old);
  const renamed = {
      ...old,
      id: 'renamed',
      name: 'ZZZ Renamed',
      sortkey: 'zzz renamed',
      path: 'D:\\Generated\\ZZZ Renamed'
    },
    renamedLeaf = { ...leaf, parent: renamed.id, path: renamed.path + '\\Leaf' };
  pages.set('root', [...nodes.filter((n) => n.id !== old.id), renamed]);
  pages.set(renamed.id, [renamedLeaf]);
  f.nav.folderTree.open = new Set(['root', renamed.id]);
  f.nav.folderTree.openNodes = new Map([
    ['root', f.S.roots[0]],
    [renamed.id, renamed]
  ]);
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(f.nav.folderTree.open.has(renamed.id), true);
  assert.equal(f.nav.folderTree.positions.get(renamed.id), 639);
  const index = f.nav.layout.indexOf(renamed.id);
  await f.nav.focusTreeIndex(index);
  await settle();
  assert.ok(f.row(renamed.id));
  assert.ok(f.row('leaf'));
  assert.equal(f.row(renamed.id).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(f.errors, []);
});

for (const location of ['middle', 'bottom'])
  test(`background revalidation keeps the entire ${location} viewport connected without placeholders or recursive-count geometry`, async () => {
    const nodes = wideFolders(),
      pages = new Map([['root', nodes]]),
      f = fixture({ roots: [{ ...root, folders: nodes.length + 9 }], pages });
    await f.tree.onclick();
    await f.nav.focusTreeIndex(location === 'middle' ? 521 : nodes.length);
    f.host.scrollTop =
      location === 'middle'
        ? 515 * treeModel.ROW_HEIGHT + 7
        : (nodes.length + 1) * treeModel.ROW_HEIGHT - f.host.clientHeight;
    f.nav.renderFolderTree();
    await settle();
    const groups = f.host.querySelectorAll('.tree-node'),
      active = f.document.activeElement,
      content = f.host.querySelector('.tree-virtual-content'),
      height = content.style.height,
      before = f.host.scrollTop,
      original = f.context.api;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.context.api = async (...args) => {
      await gate;
      return original(...args);
    };
    // Progress can change recursive totals without changing this direct folder list.
    f.S.roots[0].folders += 7;
    for (let revision = 0; revision < 3; revision++) {
      f.nav.invalidateFolderTree();
      await settle();
      for (const group of groups)
        assert.ok(f.host.contains(group), 'a loaded viewport row stays attached while validating');
      assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
      assert.equal(content.style.height, height);
      assert.equal(f.host.scrollTop, before);
      assert.equal(f.document.activeElement, active);
    }
    release();
    await settle();
    for (const group of groups) assert.ok(f.host.contains(group));
    assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
    assert.equal(content.style.height, height);
    assert.equal(f.host.scrollTop, before);
    assert.equal(f.document.activeElement, active);
    assert.equal(f.nav.layout.total, nodes.length + 1);
    assert.deepEqual(f.errors, []);
  });

test('a failed background folder read keeps its committed viewport and a later validation can recover', async () => {
  const nodes = wideFolders(),
    f = fixture({ roots: [{ ...root, folders: 649 }], pages: new Map([['root', nodes]]) });
  await f.tree.onclick();
  f.host.scrollTop = 620 * treeModel.ROW_HEIGHT;
  f.nav.renderFolderTree();
  await settle();
  const groups = [...f.host.querySelectorAll('.tree-node')],
    height = f.host.children[0].style.height,
    top = f.host.scrollTop,
    api = f.context.api;
  f.context.api = async () => {
    throw new Error('generated background read unavailable');
  };
  f.nav.invalidateFolderTree();
  await settle();
  for (const group of groups) assert.ok(f.host.contains(group));
  assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
  assert.equal(f.host.children[0].style.height, height);
  assert.equal(f.host.scrollTop, top);
  assert.equal(f.nav.folderTree.loading.size, 0);
  f.context.api = api;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(f.nav.layout.total, 641);
  for (const group of groups) assert.ok(f.host.contains(group));
});

test('collapsing a branch during background validation cannot reopen it or leave a fetching loop', async () => {
  const f = fixture();
  await f.tree.onclick();
  const api = f.context.api;
  let release;
  f.context.api = async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return api(...args);
  };
  f.nav.invalidateFolderTree();
  await settle();
  await f.nav.toggleTree(f.S.roots[0]);
  release();
  await settle();
  assert.equal(f.nav.folderTree.open.size, 0);
  assert.equal(f.nav.folderTree.openNodes.size, 0);
  assert.equal(f.nav.folderTree.loading.size, 0);
  assert.equal(f.nav.layout.total, 1);
});

test('a newer wheel viewport and its offscreen native focus survive the in-flight background snapshot', async () => {
  const nodes = wideFolders(4096),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages: new Map([['root', nodes]]) });
  await f.tree.onclick();
  f.host.scrollTop = 515 * treeModel.ROW_HEIGHT;
  f.nav.renderFolderTree();
  await settle();
  f.row('folder-520').querySelector('.category-link').focus();
  const api = f.context.api;
  let release;
  f.context.api = async (...args) => {
    if (!release)
      await new Promise((resolve) => {
        release = resolve;
      });
    return api(...args);
  };
  f.nav.invalidateFolderTree();
  await settle();
  f.host.dispatch('wheel', { deltaY: -100000 });
  f.host.scrollTop = 0;
  f.nav.renderFolderTree();
  const focus = f.row('folder-5').querySelector('.category-link');
  focus.focus();
  f.host.dispatch('wheel', { deltaY: 100000 });
  f.host.scrollTop = 4080 * treeModel.ROW_HEIGHT;
  f.nav.renderFolderTree();
  const top = f.host.scrollTop;
  release();
  await settle();
  assert.equal(f.host.scrollTop, top);
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-5:link');
  assert.ok(f.document.activeElement === focus, 'the new native focus keeps the same DOM element');
  assert.ok(f.host.contains(focus));
  assert.equal(f.nav.layout.total, 4097);
  assert.equal(f.host.querySelectorAll('.tree-slot').length, 0);
});

test('a removed root commits its empty tree while an older folder validation is still pending', async () => {
  const f = fixture();
  await f.tree.onclick();
  const api = f.context.api;
  let release;
  f.context.api = async (...args) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return api(...args);
  };
  f.nav.invalidateFolderTree();
  await settle();
  f.S.roots = [];
  f.nav.invalidateFolderTree();
  await settle();
  release();
  await settle();
  assert.equal(f.nav.folderTree.open.size, 0);
  assert.equal(f.nav.folderTree.openNodes.size, 0);
  assert.equal(f.host.querySelectorAll('.tree-node').length, 0);
  assert.equal(f.nav.folderTree.loading.size, 0);
});

test('refresh preserves native focus and the pixel anchor of a closed middle-page child after insertion', async () => {
  const nodes = wideFolders(),
    pages = new Map([['root', nodes]]),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages });
  await f.tree.onclick();
  await f.nav.focusTreeIndex(521);
  f.host.scrollTop = 515 * treeModel.ROW_HEIGHT + 7;
  f.nav.renderFolderTree();
  await settle();
  const link = f.row('folder-520').querySelector('.category-link'),
    anchor = f.nav.layout.at(515).node.id,
    before = f.host.scrollTop,
    original = f.context.api;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  f.context.api = async (...args) => {
    await gate;
    return original(...args);
  };
  pages.set('root', [
    { ...nodes[0], id: 'inserted', name: '000 Before', sortkey: '000 before' },
    ...nodes
  ]);
  f.S.roots[0].folders++;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(
    f.document.activeElement,
    link,
    'pages.clear does not remove the native focused element'
  );
  assert.ok(f.host.contains(link));
  assert.equal(f.host.scrollTop, before);
  release();
  await settle();
  assert.equal(f.document.activeElement, link);
  assert.equal(f.row('folder-520').querySelector('.category-link'), link);
  assert.equal(f.nav.layout.indexOf('folder-520'), 522);
  assert.equal(
    f.nav.layout.at(Math.floor(f.host.scrollTop / treeModel.ROW_HEIGHT)).node.id,
    anchor
  );
  assert.equal(
    f.host.scrollTop,
    before + treeModel.ROW_HEIGHT,
    'same folder stays at the same pixel offset'
  );
  assert.deepEqual(f.errors, []);
});

test('late old-generation refresh pages cannot restore an obsolete focus or scroll ordinal', async () => {
  const nodes = wideFolders(),
    pages = new Map([['root', nodes]]),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages });
  await f.tree.onclick();
  await f.nav.focusTreeIndex(521);
  f.host.scrollTop = 515 * treeModel.ROW_HEIGHT + 9;
  f.nav.renderFolderTree();
  await settle();
  const link = f.row('folder-520').querySelector('.category-link'),
    before = f.host.scrollTop,
    original = f.context.api,
    delayed = [];
  f.context.api = async (...args) => {
    const result = await original(...args);
    return new Promise((resolve) => delayed.push(() => resolve(result)));
  };
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(delayed.length, 1);
  pages.set('root', [
    { ...nodes[0], id: 'inserted', name: '000 Before', sortkey: '000 before' },
    ...nodes
  ]);
  f.S.roots[0].folders++;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(delayed.length, 2);
  delayed[1]();
  await settle();
  // Atomic delivery also waits for the other page crossing the visible overscan.
  // Keep generation zero's response parked while releasing only the new batch.
  for (let index = 2; index < delayed.length; index++) {
    assert.ok(index < 6, 'only the bounded current viewport is prepared');
    delayed[index]();
    await settle();
  }
  assert.equal(f.host.scrollTop, before + treeModel.ROW_HEIGHT);
  assert.equal(f.document.activeElement, link);
  delayed[0]();
  await settle();
  assert.equal(f.host.scrollTop, before + treeModel.ROW_HEIGHT);
  assert.equal(f.document.activeElement, link);
  assert.equal(f.nav.layout.indexOf('folder-520'), 522);
  assert.deepEqual(f.errors, []);
});

for (const nextIntent of ['ArrowUp', 'outside pointer'])
  test(`a pending page-boundary Down cannot override ${nextIntent}`, async () => {
    const nodes = wideFolders(),
      f = fixture({
        roots: [{ ...root, folders: nodes.length }],
        pages: new Map([['root', nodes]])
      });
    await f.tree.onclick();
    await f.nav.focusTreeIndex(128);
    await settle();
    // Overscan can have prefetched the boundary page; force exactly one missing page.
    f.nav.folderTree.pages.get('root').chunks.delete(128);
    const origin = f.row('folder-127').querySelector('.category-link'),
      original = f.context.api;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.context.api = async (...args) => {
      await gate;
      return original(...args);
    };
    f.host.dispatch('keydown', { target: origin, key: 'ArrowDown', preventDefault() {} });
    await settle();
    assert.equal(f.document.activeElement, origin);
    let expected;
    if (nextIntent === 'ArrowUp') {
      f.host.dispatch('keydown', { target: origin, key: 'ArrowUp', preventDefault() {} });
      await settle();
      expected = f.row('folder-126').querySelector('.category-link');
    } else {
      f.outside.dispatch('pointerdown');
      f.outside.focus();
      expected = f.outside;
    }
    assert.equal(f.document.activeElement, expected);
    release();
    await settle();
    assert.equal(
      f.document.activeElement,
      expected,
      'newer keyboard/pointer focus wins within the same generation'
    );
    assert.ok(
      f.nav.folderTree.pages.get('root').chunks.has(128),
      'the page still enters the cache'
    );
    assert.deepEqual(f.errors, []);
  });

test('a confirmed missing focused child selects its surviving neighbor after refresh', async () => {
  const nodes = wideFolders(),
    pages = new Map([['root', nodes]]),
    f = fixture({ roots: [{ ...root, folders: nodes.length }], pages });
  await f.tree.onclick();
  await f.nav.focusTreeIndex(521);
  pages.set(
    'root',
    nodes.filter((n) => n.id !== 'folder-520')
  );
  f.S.roots[0].folders--;
  f.nav.invalidateFolderTree();
  await settle();
  assert.equal(f.nav.layout.indexOf('folder-520'), -1);
  assert.equal(f.document.activeElement.dataset.treeKey, 'folder-521:link');
  assert.ok(f.host.contains(f.document.activeElement));
  assert.deepEqual(f.errors, []);
});
