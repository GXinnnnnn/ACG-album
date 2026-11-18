'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { exerciseGuiLibrary } = require('../scripts/mac-gui-library.cjs');

const importRoot = path.resolve(os.tmpdir(), 'acg GUI fixture #雪');
const originalAlbum = path.join(importRoot, 'Original Album');
const fixture = { importRoot, originalAlbum };
const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');

// This is an API-boundary unit fixture, not a substitute for native Electron GUI
// acceptance. It loads the real preload, native IPC forwarding and import handler;
// only the worker responses and Electron evaluation transport are simulated here.
function harness(options = {}) {
  const handlers = new Map();
  const workerCalls = [];
  const ipcCalls = [];
  let originalPickerCalls = 0;
  let disposed = 0;
  let album = {
    id: 'original-id',
    root: 'fixture-root',
    kind: 'folder',
    name: 'Original Album',
    path: originalAlbum,
    favorite: 0
  };
  const originalPicker = async () => {
    originalPickerCalls++;
    throw new Error('Unexpected real picker invocation');
  };
  const dialog = { showOpenDialog: originalPicker };
  const workerCall = async (method, args) => {
    args = structuredClone(args);
    workerCalls.push({ method, args });
    if (options.failMethod === method) throw options.failure;
    if (options.worker) {
      const override = await options.worker(method, args);
      if (override !== undefined) return override;
    }
    if (method === 'init') return { progress: { busy: false, active: false }, online: {} };
    if (method === 'settings') return args.value;
    if (method === 'scan') return { root: 'fixture-root', errors: 0 };
    if (method === 'get') {
      if ((args.path && args.path === album.path) || args.id === album.id)
        return structuredClone(album);
      return null;
    }
    if (method === 'patch') {
      album = { ...album, ...args.changes };
      return structuredClone(album);
    }
    if (method === 'rename') {
      const before = album;
      album = {
        ...album,
        id: 'renamed-id',
        name: args.name,
        path: path.join(path.dirname(album.path), args.name)
      };
      return {
        renamed: true,
        oldId: before.id,
        id: album.id,
        oldPath: before.path,
        path: album.path,
        root: album.root,
        node: structuredClone(album)
      };
    }
    if (method === 'list') return { items: [structuredClone(album)], total: 1, folders: 1 };
    throw new Error('Unexpected worker method: ' + method);
  };
  const mainContext = vm.createContext({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog,
    win: { fixtureWindow: true },
    importReserved: false,
    require: (name) => {
      assert.equal(name, './matching-policy.cjs');
      return require('../src/matching-policy.cjs');
    },
    call: workerCall
  });
  const methodsStart = mainSource.indexOf('  const methods = [');
  const methodsEnd = mainSource.indexOf("  ipcMain.handle('library:exportMedia'", methodsStart);
  const importStart = mainSource.indexOf("  ipcMain.handle('library:import'");
  const importEnd = mainSource.indexOf("  ipcMain.handle('library:refresh'", importStart);
  assert.ok(methodsStart >= 0 && methodsEnd > methodsStart, 'Real IPC forwarding must exist');
  assert.ok(importStart >= 0 && importEnd > importStart, 'Real native import handler must exist');
  vm.runInContext(mainSource.slice(methodsStart, methodsEnd), mainContext);
  // Capture by channel: this slice also registers relink handlers after import.
  vm.runInContext(mainSource.slice(importStart, importEnd), mainContext);
  assert.equal(typeof handlers.get('library:import'), 'function');
  const rendererContext = vm.createContext({
    window: {},
    process: { platform: process.platform, arch: process.arch },
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld: (name, api) => {
            rendererContext.window[name] = api;
          }
        },
        ipcRenderer: {
          invoke: async (channel, args) => {
            ipcCalls.push({ channel, args: structuredClone(args) });
            const handler = handlers.get(channel);
            assert.equal(typeof handler, 'function', 'Missing real main handler for ' + channel);
            if (channel === 'library:import') {
              if (options.chooserArgs) await dialog.showOpenDialog(...options.chooserArgs);
              if (options.skipPicker) return { root: 'fixture-root', errors: 0 };
            }
            const result = await handler({}, args);
            if (channel === 'library:import' && options.replacePicker)
              dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
            if (channel === 'library:import' && options.extraPicker)
              await dialog.showOpenDialog(
                {},
                {
                  title: '选择要导入的相册分类',
                  properties: ['openDirectory', 'dontAddToRecent']
                }
              );
            return structuredClone(result);
          },
          on: () => {},
          removeListener: () => {}
        }
      };
    }
  });
  vm.runInContext(preloadSource, rendererContext);
  const resolveArg = (arg) => (arg?.fixtureMainHandle ? arg.value : structuredClone(arg));
  const invokeMain = async (fn, arg) => {
    const callable = vm.runInContext('(' + fn.toString() + ')', mainContext);
    return callable({ dialog }, resolveArg(arg));
  };
  const app = {
    evaluateHandle: async (fn, arg) => ({
      fixtureMainHandle: true,
      value: await invokeMain(fn, arg),
      dispose: async () => {
        disposed++;
      }
    }),
    evaluate: async (fn, arg) => structuredClone(await invokeMain(fn, arg))
  };
  const page = {
    evaluate: async (fn, arg) => {
      const callable = vm.runInContext('(' + fn.toString() + ')', rendererContext);
      return structuredClone(await callable(structuredClone(arg)));
    }
  };
  return {
    app,
    page,
    dialog,
    originalPicker,
    workerCalls,
    ipcCalls,
    originalPickerCalls: () => originalPickerCalls,
    disposed: () => disposed
  };
}

function assertRestored(h) {
  assert.equal(
    h.dialog.showOpenDialog,
    h.originalPicker,
    'Native chooser identity must be restored'
  );
  assert.equal(h.originalPickerCalls(), 0, 'Unit fixture must not invoke a real picker');
  assert.equal(h.disposed(), 1, 'Main-process handle must be disposed');
}

test('GUI import uses actual preload whitelist and main import contract, then preserves library schema', async () => {
  const h = harness();
  await assert.rejects(
    h.page.evaluate(() => window.album.call('scan', { path: '/not-a-renderer-api' })),
    /不支持的操作/
  );
  assert.equal(h.ipcCalls.length, 0, 'Worker-only scan must be rejected before IPC');
  const result = await exerciseGuiLibrary(h.app, h.page, fixture);
  assert.deepEqual(Object.keys(result), ['scan', 'before', 'rename', 'after', 'favorites']);
  assert.deepEqual(
    h.ipcCalls.map((row) => row.channel),
    [
      'library:settings',
      'library:import',
      'library:get',
      'library:patch',
      'library:rename',
      'library:get',
      'library:list'
    ]
  );
  assert.deepEqual(h.workerCalls, [
    { method: 'settings', args: { key: 'autoMatch', value: false } },
    { method: 'init', args: { lightweight: true } },
    {
      method: 'scan',
      args: {
        path: importRoot,
        onlineMatch: false,
        subjectTypes: [1, 2, 4, 6],
        directoryKind: 'photo'
      }
    },
    { method: 'get', args: { path: originalAlbum } },
    { method: 'patch', args: { id: 'original-id', changes: { favorite: 1 } } },
    { method: 'rename', args: { id: 'original-id', name: 'Renamed Album' } },
    { method: 'get', args: { id: 'renamed-id' } },
    { method: 'list', args: { favorites: true } }
  ]);
  assert.equal(result.after.favorite, 1);
  assert.equal(result.favorites.items[0].id, result.rename.id);
  assertRestored(h);
});

test('GUI import restores the native chooser and identifies the failed RPC when scan rejects', async () => {
  const failure = new Error('Fixture worker scan failed');
  const h = harness({ failMethod: 'scan', failure });
  await assert.rejects(exerciseGuiLibrary(h.app, h.page, fixture), (error) => {
    assert.match(error.message, /\[mac-gui-library:import\].*Fixture worker scan failed/);
    assert.equal(error.cause, failure);
    return true;
  });
  assertRestored(h);
  assert.equal(
    h.ipcCalls.some((row) => row.channel === 'library:patch'),
    false
  );
});

test('GUI import rejects unexpected native chooser arguments and repeated chooser calls', async (t) => {
  for (const [name, options] of [
    [
      'wrong dialog',
      { chooserArgs: [{}, { title: 'Other dialog', properties: ['openDirectory'] }] }
    ],
    [
      'extra options',
      {
        chooserArgs: [
          {},
          {
            title: '选择要导入的相册分类',
            properties: ['openDirectory', 'dontAddToRecent'],
            defaultPath: '/elsewhere'
          }
        ]
      }
    ],
    ['second request', { extraPicker: true }]
  ]) {
    await t.test(name, async () => {
      const h = harness(options);
      await assert.rejects(
        exerciseGuiLibrary(h.app, h.page, fixture),
        /Unexpected fixture chooser request/
      );
      assertRestored(h);
    });
  }
});

test('GUI import fails closed if the real main handler does not consume the fixture chooser', async () => {
  const h = harness({ skipPicker: true });
  await assert.rejects(
    exerciseGuiLibrary(h.app, h.page, fixture),
    /exactly one native directory chooser/
  );
  assertRestored(h);
});

test('GUI import restores a changed chooser and retains both verification and cleanup errors', async () => {
  const h = harness({ replacePicker: true });
  await assert.rejects(exerciseGuiLibrary(h.app, h.page, fixture), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.errors[0].message, /Fixture chooser changed during import/);
    assert.match(error.errors[1].message, /unexpectedly replaced during import/);
    assert.equal(error.cause, error.errors[0]);
    return true;
  });
  assertRestored(h);
});

test('GUI import restores the chooser before later RPC failures and reports the method', async () => {
  const failure = new Error('Fixture rename rejected');
  const h = harness({ failMethod: 'rename', failure });
  await assert.rejects(exerciseGuiLibrary(h.app, h.page, fixture), (error) => {
    assert.match(error.message, /\[mac-gui-library:rename\].*Fixture rename rejected/);
    assert.equal(error.cause, failure);
    return true;
  });
  assertRestored(h);
});

test('GUI import rejects error/cancelled scan, broken favorite and mismatched rename contracts', async (t) => {
  for (const [name, method, response, expected] of [
    ['scan errors', 'scan', { errors: 1, root: 'fixture-root' }, /without errors/],
    [
      'cancelled scan',
      'scan',
      { errors: 0, root: 'fixture-root', cancelled: true },
      /not be cancelled/
    ],
    ['empty scan', 'scan', null, /no scan result/],
    ['favorite not saved', 'patch', { id: 'original-id', favorite: 0 }, /did not persist/],
    ['wrong rename source', 'rename', { renamed: true, oldId: 'other-id' }, /different source ID/],
    ['favorites false positive', 'list', { items: [], path: 'renamed-id' }, /does not contain/]
  ]) {
    await t.test(name, async () => {
      const h = harness({ worker: (requested) => (requested === method ? response : undefined) });
      await assert.rejects(exerciseGuiLibrary(h.app, h.page, fixture), expected);
      assertRestored(h);
    });
  }
});
