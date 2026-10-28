'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/navigation.js'), 'utf8');
const treeSource = source.slice(0, source.indexOf('function updateCoverNode('));
const eventsSource = source.slice(
  source.indexOf('const sidebarShell ='),
  source.indexOf("$('#profile-button').onclick")
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
    settings = [];
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
      hover: false,
      focusVisible: false,
      listeners: new Map(),
      style: { setProperty() {} },
      get innerHTML() {
        return el.markup || '';
      },
      set innerHTML(value) {
        el.replaceChildren();
        el.markup = value;
      },
      setAttribute(name, value) {
        el.attributes[name] = String(value);
      },
      getAttribute(name) {
        return el.attributes[name] ?? null;
      },
      append(...nodes) {
        for (const child of nodes) {
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
        document.activeElement = el;
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
    'profile-button'
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
  const S = { settings: { sidebarMode: mode, nickname: 'Generated' }, roots, current };
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
      const nodes = folders.get(args.parent) || [];
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
      '\n({ folderTree, setSidebarOpen, applyNavigationSettings, openFolderTree, renderFolderTree, toggleTree, get isOpen() { return sidebarOpen; } });',
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
    errors,
    settings,
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
  assert.equal(f.host.querySelectorAll('.tree-children').length, 1);
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

test('folder click reveals the current root page and respects Windows path boundaries', async () => {
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
  assert.equal(f.nav.folderTree.rootOffset, 12);
  assert.equal(f.requests[0].parent, 'root-13');
  assert.equal(f.row('root-13').getAttribute('aria-expanded'), 'true');
  assert.ok(f.row('inside-13'));
  assert.equal(f.row('root-1'), undefined);
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
