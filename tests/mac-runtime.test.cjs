'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const platform = require('../src/platform.cjs');
const source = (file) => fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
const main = source('main.cjs');
const plain = (value) => JSON.parse(JSON.stringify(value));
function section(text, start, end) {
  const a = text.indexOf(start),
    b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return text.slice(a, b);
}

test('Mac native window options and menus preserve Windows window defaults', () => {
  assert.deepEqual(platform.windowPlatformOptions('darwin'), {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 6 },
    fullscreenable: true
  });
  assert.deepEqual(platform.windowPlatformOptions('win32'), {
    titleBarStyle: 'hidden',
    thickFrame: true,
    fullscreenable: false
  });
  const actions = [];
  const menu = platform.macMenuTemplate({
    name: 'ACG-album',
    emit: (action) => actions.push(action)
  });
  const items = menu.flatMap((item) => item.submenu);
  for (const [accelerator, action] of [
    ['Command+,', 'settings'],
    ['Command+O', 'import'],
    ['Command+C', 'copy'],
    ['Command+R', 'refresh'],
    ['Command+K', 'search'],
    ['Command+[', 'back']
  ]) {
    items.find((item) => item.accelerator === accelerator).click();
    assert.equal(actions.at(-1), action);
  }
  assert.equal(items.find((item) => item.role === 'quit').accelerator, 'Command+Q');
  assert.equal(items.find((item) => item.role === 'close').accelerator, 'Command+W');
  assert.ok(items.find((item) => item.role === 'services'));
  assert.ok(items.find((item) => item.role === 'togglefullscreen'));
});

test('Mac font retirement never targets Contents/MacOS or mutates a signed app', () => {
  assert.equal(
    platform.legacyFontRuntimeDirectory(
      'darwin',
      '/Applications/ACG-album.app/Contents/MacOS/ACG-album'
    ),
    null
  );
  assert.equal(platform.legacyFontRuntimeDirectory('linux', '/opt/album/album'), null);
  const executable = path.join('C:', 'Album', 'ACG-album.exe');
  assert.equal(platform.legacyFontRuntimeDirectory('win32', executable), path.dirname(executable));
});

function runtime(os) {
  const windows = [],
    writes = [],
    calls = [],
    app = new EventEmitter();
  let quits = 0;
  app.quit = () => quits++;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.isLoadingMainFrame = () => this.loading;
      this.webContents.send = (...args) => calls.push(args);
      this.loading = true;
      this.visible = false;
      windows.push(this);
    }
    loadFile() {}
    isDestroyed() {
      return !!this.destroyed;
    }
    isMinimized() {
      return !!this.minimized;
    }
    isMaximized() {
      return false;
    }
    isFocused() {
      return !!this.focused;
    }
    isVisible() {
      return this.visible;
    }
    getNormalBounds() {
      return { width: 1600, height: 1000 };
    }
    restore() {
      this.minimized = false;
    }
    show() {
      this.visible = true;
      this.shows = (this.shows || 0) + 1;
    }
    focus() {
      this.focused = true;
    }
    close() {
      this.emit('close');
      this.destroyed = true;
      this.emit('closed');
      app.emit('window-all-closed');
    }
  }
  const context = vm.createContext({
    process: { platform: os },
    app,
    BrowserWindow: Window,
    dataDir: path.join('C:', 'isolated-mock'),
    worker: {},
    closing: false,
    win: null,
    APP_NAME: 'ACG-album',
    __dirname: path.join(__dirname, '../src'),
    path,
    pathToFileURL: require('node:url').pathToFileURL,
    fs: {
      readFileSync() {
        throw new Error('no saved state');
      },
      writeFileSync: (...args) => writes.push(args)
    },
    windowPlatformOptions: () => platform.windowPlatformOptions(os),
    call: () => Promise.resolve(),
    log() {}
  });
  vm.runInContext(section(main, 'function createWindow()', 'function handlers()'), context);
  vm.runInContext(section(main, "  app.on('second-instance'", '  app\n'), context);
  vm.runInContext(section(main, "  app.on('window-all-closed'", '  let quitReady'), context);
  return { context, app, windows, writes, calls, quits: () => quits };
}

test('Mac close retains app and Dock activation creates one fresh window without registering IPC again', () => {
  const h = runtime('darwin');
  h.context.createWindow();
  const first = h.windows[0];
  assert.equal(first.options.icon, undefined);
  assert.equal(first.options.webPreferences.sandbox, true);
  assert.equal(first.options.webPreferences.nodeIntegration, false);
  assert.equal(first.options.webPreferences.contextIsolation, true);
  first.close();
  assert.equal(h.context.win, null);
  assert.equal(h.quits(), 0);
  assert.equal(h.writes.length, 1);
  h.app.emit('activate');
  assert.equal(h.windows.length, 2);
  const second = h.windows[1];
  second.emit('ready-to-show');
  h.app.emit('activate');
  assert.equal(h.windows.length, 2);
  assert.equal(second.focused, true);
  second.minimized = true;
  h.app.emit('second-instance');
  assert.equal(second.minimized, false);
  h.context.closing = true;
  second.close();
  h.app.emit('activate');
  assert.equal(h.windows.length, 2, 'quit must not reopen a window');
});

test('Windows still quits on last window and native actions wait for renderer load', () => {
  const h = runtime('win32');
  h.context.createWindow();
  assert.match(h.windows[0].options.icon, /app\.ico$/);
  h.context.emitApplicationAction('settings');
  assert.equal(h.calls.length, 0);
  h.windows[0].webContents.emit('did-finish-load');
  assert.deepEqual(plain(h.calls[0]), [
    'library:event',
    { type: 'application', data: { action: 'settings' } }
  ]);
  h.windows[0].close();
  assert.equal(h.quits(), 1);
});

test('preload exposes platform strings while retaining the isolated IPC allowlist', async () => {
  let bridge;
  const invocations = [];
  const context = vm.createContext({
    process: { platform: 'darwin', arch: 'arm64', env: { SECRET: 'never expose' } },
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            assert.equal(name, 'album');
            bridge = api;
          }
        },
        ipcRenderer: { invoke: (...args) => invocations.push(args), on() {}, removeListener() {} }
      };
    }
  });
  vm.runInContext(source('preload.cjs'), context);
  assert.equal(bridge.platform, 'darwin');
  assert.equal(bridge.arch, 'arm64');
  assert.equal(bridge.process, undefined);
  assert.equal(bridge.env, undefined);
  await assert.rejects(bridge.call('exec'), /不支持/);
  bridge.call('appInfo');
  assert.equal(invocations[0][0], 'library:appInfo');
});

function renderer(os) {
  const context = vm.createContext({
    window: { album: { platform: os } },
    TextEncoder,
    document: { documentElement: { dataset: {} }, querySelector: () => null }
  });
  vm.runInContext(source('ui/platform.js'), context);
  vm.runInContext(source('ui/browse-sort.js'), context);
  return context;
}

test('Mac path keys and browse scopes preserve case, Unicode and literal backslashes', () => {
  const c = renderer('darwin'),
    p = c.window.albumPlatform,
    sorts = c.window.albumBrowseSort;
  assert.equal(p.pathKey('/Volumes/作品/Album/'), '/Volumes/作品/Album');
  assert.equal(p.pathName('/Volumes/作品/Name\\part.png'), 'Name\\part.png');
  assert.equal(p.descendant('/Volumes/Album/a', '/Volumes/album'), false);
  assert.equal(p.descendant('/Volumes/Album/a', '/Volumes/Album'), true);
  assert.equal(p.descendant('/Volumes/Album-more/a', '/Volumes/Album'), false);
  assert.equal(p.descendant('/Volumes', '/'), true);
  assert.equal(sorts.normalizePath('/Volumes//作品/./Album/../ALBUM/'), '/Volumes/作品/ALBUM');
  assert.equal(sorts.normalizePath('/Volumes/Cafe\u0301\\part'), '/Volumes/Cafe\u0301\\part');
  assert.notEqual(
    sorts.scope('library', '/Volumes/Album'),
    sorts.scope('library', '/Volumes/album')
  );
  assert.equal(sorts.scope('library', 'relative/path'), null);
  const memory = sorts.create({ save: async () => {} });
  memory.set('library', '/Volumes/Album/Child', { sort: 'size', direction: 'desc' });
  memory.set('library', '/Volumes/album/Child', { sort: 'date', direction: 'asc' });
  memory.rename([{ oldPath: '/Volumes/Album', path: '/Volumes/New' }]);
  assert.equal(memory.get('library', '/Volumes/New/Child').sort, 'size');
  assert.equal(memory.get('library', '/Volumes/album/Child').sort, 'date');
});

test('Windows persisted browse scopes and primary modifier are unchanged', () => {
  const c = renderer('win32'),
    p = c.window.albumPlatform;
  assert.equal(
    c.window.albumBrowseSort.scope('library', 'C:/Album/Child/'),
    '["library","c:\\\\album\\\\child"]'
  );
  assert.equal(p.primaryModifier({ ctrlKey: true, metaKey: false }), true);
  assert.equal(p.primaryModifier({ ctrlKey: false, metaKey: true }), false);
  assert.equal(
    renderer('darwin').window.albumPlatform.primaryModifier({ ctrlKey: false, metaKey: true }),
    true
  );
});

test('Mac rename and tree pruning never touch a differently cased sibling', () => {
  const c = renderer('darwin');
  const app = source('ui/app.js'),
    navigation = source('ui/navigation.js');
  vm.runInContext(section(app, 'function renameParts(', 'function captureRenameNavigation('), c);
  assert.equal(
    c.renamedPath('/Volumes/Album/a', '/Volumes/album', '/Volumes/New'),
    '/Volumes/Album/a'
  );
  assert.equal(
    c.renamedPath('/Volumes/album/a', '/Volumes/album', '/Volumes/New'),
    '/Volumes/New/a'
  );
  assert.equal(
    c.renameParts({ path: '/Volumes/Album/Name\\part.png', kind: 'image' }).basename,
    'Name\\part'
  );
  assert.equal(c.renameNameError('CON'), '');
  assert.equal(c.renameNameError('合法尾空格 '), '');
  assert.equal(c.renameNameError('中'.repeat(85)), '');
  assert.ok(c.renameNameError('中'.repeat(86)));
  assert.ok(c.renameNameError('bad/name'));
  c.folderTree = {
    open: new Set(['parent', 'child', 'sibling']),
    openNodes: new Map([
      ['parent', { path: '/Volumes/Album' }],
      ['child', { path: '/Volumes/Album/a' }],
      ['sibling', { path: '/Volumes/album/a' }]
    ]),
    positions: new Map(),
    pages: new Map(),
    requests: new Map(),
    loading: new Set(),
    errors: new Map()
  };
  vm.runInContext(section(navigation, 'function collapseBranch(', 'function captureTreeRow('), c);
  c.collapseBranch('parent');
  assert.deepEqual([...c.folderTree.open], ['sibling']);
});

test('Mac indexed missing directories retain their cached row for explicit repair', async () => {
  const c = renderer('darwin');
  const root = { id: 'root', path: '/Volumes/作品', kind: 'folder' };
  const current = { id: 'missing', root: root.id, path: root.path + '/Album', missing: 1 };
  const lookups = [];
  Object.assign(c, {
    S: { loadVersion: 3, parent: current.id, current, roots: [root], history: [] },
    $: () => ({ open: false }),
    viewKey: () => 'current',
    renamingNodes: new Set(),
    externalRenameQueue: [],
    api: async (command, args) => {
      lookups.push([command, args.id]);
      return root;
    }
  });
  vm.runInContext(
    section(source('ui/app.js'), 'async function recoverMissingBrowse(', 'const importChoices ='),
    c
  );
  const result = await c.recoverMissingBrowse(current, 3, 'current');
  assert.equal(result.node, current);
  assert.equal(result.unavailable, true);
  assert.deepEqual(lookups, [['get', root.id]]);
  assert.equal(c.S.parent, current.id);
});

test('native Command+C copies images or focused text and menu actions preserve open dialogs', () => {
  let listener,
    textFocus = false,
    dialog = false;
  const actions = [],
    nodes = new Map();
  for (const id of [
    'viewport',
    'sidebar-about',
    'viewer',
    'viewer-copy',
    'settings-button',
    'import-sidebar',
    'refresh-button',
    'search',
    'back-button'
  ])
    nodes.set('#' + id, {
      open: id === 'viewer',
      setAttribute() {},
      addEventListener() {},
      click: () => actions.push(id),
      focus: () => actions.push(id)
    });
  const c = vm.createContext({
    document: {
      activeElement: { closest: () => textFocus },
      querySelector: (selector) =>
        selector.startsWith('dialog[') ? (dialog ? {} : null) : nodes.get(selector)
    },
    Element: class {},
    V: { node: { kind: 'image' } },
    hideContext() {},
    window: {
      addEventListener() {},
      getSelection: () => '',
      album: {
        onEvent: (fn) => {
          listener = fn;
        },
        window: (action) => actions.push(action)
      }
    }
  });
  vm.runInContext(source('ui/menus.js'), c);
  const emit = (action) => listener({ type: 'application', data: { action } });
  emit('copy');
  assert.equal(actions.pop(), 'viewer-copy');
  textFocus = true;
  emit('copy');
  assert.equal(actions.pop(), 'copy');
  nodes.get('#viewer').open = false;
  for (const [action, target] of [
    ['settings', 'settings-button'],
    ['import', 'import-sidebar'],
    ['refresh', 'refresh-button'],
    ['search', 'search'],
    ['back', 'back-button']
  ]) {
    emit(action);
    assert.equal(actions.pop(), target);
  }
  dialog = true;
  emit('settings');
  assert.equal(actions.length, 0);
});
