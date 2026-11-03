'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');

// Faults affect real OS watchers or a single real scan directory open. Product
// handlers, directory enumeration, identity migration and SQLite remain real.
const bootstrap = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs'), path = require('node:path');
const deny = (...args) => {
  parentPort.postMessage({event:'forbidden-network',data:String(args[0])});
  throw new Error('HTTP forbidden in external-sync fixture');
};
global.fetch = async (...args) => deny(...args);
for (const name of ['node:http','node:https']) {
  const module = require(name); module.request = deny; module.get = deny;
}
const nativeWatch = fs.watch.bind(fs), nativeOpen = fs.promises.opendir.bind(fs.promises),
  nativeLstat = fs.promises.lstat.bind(fs.promises);
const watchListeners = new Map();
let watchAttempts = 0, failDirectory = null, retryDirectory = null,
  holdWatchRepair = !!workerData.holdWatchRepair, statGate = null, readGate = null;
const holdRead = value => {
  let release;
  const promise = new Promise(resolve => {release=resolve;});
  return {path:path.resolve(value),promise,release,consumed:false};
};
if (workerData.holdDirectoryRead) readGate = holdRead(workerData.holdDirectoryRead);
// Only this regression delays its first real debounce handle. Cancellation still
// goes through native clearTimeout; later watcher deadlines run unchanged.
let armFirstWatchTimer = false, firstWatchTimer = null, renameMoveGate = null;
if (workerData.observeRenameWatchTimer) {
  const nativeSetTimeout = global.setTimeout, nativeClearTimeout = global.clearTimeout;
  global.setTimeout = (callback, delay, ...args) => {
    const first = armFirstWatchTimer && !firstWatchTimer && callback.name === 'drainWatches';
    const timer = nativeSetTimeout(callback, first ? Math.max(8000, delay) : delay, ...args);
    if (first) {
      firstWatchTimer = timer;
      parentPort.postMessage({event:'fixture-watch-timer',data:{phase:'armed',delay,due:Date.now()+delay}});
    }
    return timer;
  };
  global.clearTimeout = timer => {
    const result = nativeClearTimeout(timer);
    if (timer && timer === firstWatchTimer)
      parentPort.postMessage({event:'fixture-watch-timer',data:{phase:'cancelled',destroyed:timer._destroyed}});
    return result;
  };
  const Module = require('node:module'), nativeLoad = Module._load;
  Module._load = function(request,parent,isMain) {
    const loaded = nativeLoad.apply(this,arguments);
    if (request !== './fs-rename.cjs' || parent?.filename !== workerData.script) return loaded;
    return {...loaded,createFsRename(options) {
      let used = false;
      return loaded.createFsRename({...options,moveNoReplace:async (...args) => {
        if (!used) {
          used = true;
          let release;
          const promise = new Promise(resolve => {release=resolve;});
          renameMoveGate = {release};
          parentPort.postMessage({event:'fixture-rename-move',data:{phase:'held',oldPath:args[0],path:args[1]}});
          await promise;
          parentPort.postMessage({event:'fixture-rename-move',data:{phase:'released'}});
        }
        return loaded.windowsMoveNoReplace(...args);
      }});
    }};
  };
}
// Observe the real journal row immediately before the real indexing write. This
// adds no SQL writes and does not replace the journal, scanner or transaction.
if (workerData.observeRootUpsert) {
  const Module = require('node:module'), nativeLoad = Module._load;
  Module._load = function(request,parent,isMain) {
    const loaded = nativeLoad.apply(this,arguments);
    if (request !== './indexing.cjs' || parent?.filename !== workerData.script) return loaded;
    return {...loaded,createIndexing(db,...args) {
      const indexing = loaded.createIndexing(db,...args), upsert = indexing.upsert;
      indexing.upsert = function(node,stat,...rest) {
        if (node.parent === null && path.resolve(node.path) === path.resolve(workerData.observeRootUpsert)) {
          const job = db.prepare('SELECT id,target,state FROM scan_jobs WHERE root=? LIMIT 1').get(node.root),
            before = db.prepare('SELECT mtime FROM nodes WHERE id=?').get(node.id);
          parentPort.postMessage({event:'fixture-root-upsert',data:{job:job?.id,target:job?.target,state:job?.state,beforeMtime:before?.mtime,acceptedMtime:stat.mtimeMs}});
        }
        return upsert.call(this,node,stat,...rest);
      };
      return indexing;
    }};
  };
}
fs.watch = (...args) => {
  const attempt = ++watchAttempts;
  if (attempt > 1 && holdWatchRepair) {
    parentPort.postMessage({event:'fixture-watch',data:{attempt,phase:'repair-held',path:String(args[0])}});
    throw Object.assign(new Error('Injected watch repair remains unavailable'),{code:'EMFILE'});
  }
  if (attempt === 1 && workerData.watchFailure === 'throw-first') {
    parentPort.postMessage({event:'fixture-watch',data:{attempt,phase:'throw',path:String(args[0])}});
    throw Object.assign(new Error('Injected first watch construction failure'),{code:'EMFILE'});
  }
  const listener = args[args.length - 1], rootPath = path.resolve(String(args[0]));
  if (typeof listener === 'function') args[args.length - 1] = (eventType, filename) => {
    if (workerData.muteWatchNotifications) {
      parentPort.postMessage({event:'fixture-watch-notification',data:{phase:'muted-native',path:rootPath,eventType,filename:String(filename)}});
      return;
    }
    listener(eventType, filename);
  };
  const watcher = nativeWatch(...args);
  watchListeners.set(rootPath,{watcher,listener});
  watcher.once('close',() => {
    if (watchListeners.get(rootPath)?.watcher === watcher) watchListeners.delete(rootPath);
  });
  parentPort.postMessage({event:'fixture-watch',data:{attempt,phase:'installed',path:String(args[0])}});
  if (attempt === 1 && workerData.watchFailure === 'error-first') setImmediate(() => {
    parentPort.postMessage({event:'fixture-watch',data:{attempt,phase:'error',path:String(args[0])}});
    watcher.emit('error',Object.assign(new Error('Injected first watch error'),{code:'EPERM'}));
  });
  return watcher;
};
fs.promises.opendir = async (value, options) => {
  const resolved = path.resolve(String(value)), gate = readGate;
  if (gate && !gate.consumed && options?.bufferSize === 128 && resolved === gate.path) {
    gate.consumed = true;
    parentPort.postMessage({event:'fixture-directory-read',data:{path:resolved,phase:'held'}});
    await gate.promise;
    parentPort.postMessage({event:'fixture-directory-read',data:{path:resolved,phase:'released'}});
  }
  if (options?.bufferSize === 128 && resolved === failDirectory) {
    failDirectory = null; retryDirectory = resolved;
    parentPort.postMessage({event:'fixture-directory-read',data:{path:resolved,phase:'failed'}});
    throw Object.assign(new Error('Injected one transient full-scan directory read failure'),{code:'EACCES'});
  }
  const directory = await nativeOpen(value, options);
  if (options?.bufferSize === 128 && resolved === retryDirectory) {
    retryDirectory = null;
    parentPort.postMessage({event:'fixture-directory-read',data:{path:resolved,phase:'retried-native-open'}});
  }
  return directory;
};
fs.promises.lstat = async (value, options) => {
  const gate = statGate;
  if (gate && !gate.consumed && options?.bigint && path.resolve(String(value)) === gate.path) {
    gate.consumed = true;
    parentPort.postMessage({event:'fixture-directory-stat',data:{path:gate.path,phase:'held'}});
    await gate.promise;
    parentPort.postMessage({event:'fixture-directory-stat',data:{path:gate.path,phase:'released'}});
  }
  return nativeLstat(value, options);
};
workerData.control.on('message', message => {
  if (message.type === 'arm-first-watch-timer') armFirstWatchTimer = true;
  else if (message.type === 'release-rename-move') {renameMoveGate?.release();renameMoveGate=null;}
  else if (message.type === 'fail-next-directory-read') failDirectory = path.resolve(message.path);
  else if (message.type === 'hold-next-directory-read') {
    if (readGate) return workerData.control.postMessage({request:message.request,error:'A directory read gate is already armed'});
    readGate = holdRead(message.path);
  } else if (message.type === 'release-directory-read') {
    readGate?.release(); readGate = null;
  } else if (message.type === 'release-watch-repair') holdWatchRepair = false;
  else if (message.type === 'hold-next-directory-stat') {
    if (statGate) return workerData.control.postMessage({request:message.request,error:'A directory stat gate is already armed'});
    let release;
    const promise = new Promise(resolve => {release=resolve;});
    statGate = {path:path.resolve(message.path),promise,release,consumed:false};
  } else if (message.type === 'release-directory-stat') {
    statGate?.release(); statGate = null;
  } else if (message.type === 'emit-watch-notification') {
    const record = watchListeners.get(path.resolve(message.path));
    if (!record || typeof record.listener !== 'function')
      return workerData.control.postMessage({request:message.request,error:'No real watcher is attached at the fixture root'});
    record.listener(message.eventType,message.filename);
    parentPort.postMessage({event:'fixture-watch-notification',data:{phase:'forwarded-control',path:message.path,eventType:message.eventType,filename:message.filename}});
  }
  workerData.control.postMessage({request:message.request,armed:true});
});
workerData.control.unref();
require(workerData.script);
`;

async function client(dataDir, options = {}) {
  const channel = new MessageChannel();
  const worker = new Worker(bootstrap, {
    eval: true,
    workerData: {
      dataDir,
      watch: true,
      deferBackground: true,
      watchFailure: options.watchFailure || '',
      holdWatchRepair: !!options.holdWatchRepair,
      muteWatchNotifications: !!options.muteWatchNotifications,
      holdDirectoryRead: options.holdDirectoryRead || null,
      observeRootUpsert: options.observeRootUpsert || null,
      observeRenameWatchTimer: !!options.observeRenameWatchTimer,
      control: channel.port2,
      script: path.resolve(__dirname, '../src/library-worker.cjs')
    },
    transferList: [channel.port2]
  });
  const events = [],
    pending = new Map(),
    controls = new Map();
  let sequence = 0,
    fatal = null,
    closed = false,
    scanCalls = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const settle = (map, message) => {
    const request = map.get(message.request);
    if (!request) return;
    clearTimeout(request.timer);
    map.delete(message.request);
    if (message.error) request.reject(new Error(message.error + '\n' + (message.stack || '')));
    else request.resolve(message.result === undefined ? message : message.result);
  };
  worker.on('error', (error) => {
    fatal = error;
    readyReject(error);
  });
  worker.on('exit', (code) => {
    if (!closed) {
      fatal = new Error('Unexpected external-sync worker exit: ' + code);
      readyReject(fatal);
    }
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(fatal || new Error('Worker closed'));
    }
    pending.clear();
  });
  worker.on('message', (message) => {
    if (message.event) events.push(message);
    if (message.event === 'ready') readyResolve();
    settle(pending, message);
  });
  channel.port1.on('message', (message) => settle(controls, message));
  const health = () => {
    if (fatal) throw fatal;
    assert.equal(
      events.filter((row) => row.event === 'forbidden-network').length,
      0,
      'No HTTP entry point may run'
    );
  };
  const c = {
    events,
    get scanCalls() {
      return scanCalls;
    },
    call(method, args = {}) {
      if (method === 'scan') scanCalls++;
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out RPC: ' + method));
        }, 12000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    control(args) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          controls.delete(request);
          reject(new Error('Timed out fixture control'));
        }, 12000);
        controls.set(request, { resolve, reject, timer });
        channel.port1.postMessage({ ...args, request });
      });
    },
    async until(predicate, label, timeout = 18000) {
      const deadline = Date.now() + timeout;
      do {
        health();
        const result = await predicate();
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      throw new Error('Timed out: ' + label + '\n' + JSON.stringify(events.slice(-12)));
    },
    get(value) {
      return c.call('get', { id: idFor(value) });
    },
    async live(value) {
      const row = await c.get(value);
      return row && row.missing === 0 ? row : null;
    },
    async hint() {
      const result = await c.call('filesystemSync', { reason: 'test' });
      assert.equal(result.accepted, true, 'Filesystem catch-up is accepted without a manual scan');
      return result;
    },
    async idle() {
      return c.until(async () => {
        const state = await c.call('init', { lightweight: true });
        return state.taskSnapshot.scan.status === 'idle' && !state.progress.active;
      }, 'scan idle');
    },
    async crash() {
      if (closed) return;
      closed = true;
      try {
        await worker.terminate();
      } finally {
        channel.port1.close();
        for (const request of controls.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Fixture terminated'));
        }
        controls.clear();
      }
      health();
    },
    async close() {
      if (closed) return;
      channel.port1.postMessage({ type: 'release-rename-move' });
      channel.port1.postMessage({ type: 'release-directory-read' });
      channel.port1.postMessage({ type: 'release-directory-stat' });
      closed = true;
      try {
        await c.call('shutdown');
      } finally {
        await worker.terminate();
        channel.port1.close();
        for (const request of controls.values()) {
          clearTimeout(request.timer);
          request.reject(new Error('Fixture closed'));
        }
        controls.clear();
      }
      health();
    }
  };
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out worker ready')), 12000);
        ready.finally(() => clearTimeout(timer)).catch(() => {});
      })
    ]);
    if (options.resumeStartup !== false) {
      const resumed = await c.call('startupResume');
      assert.equal(resumed.accepted, true);
      await c.until(() => {
        const state = events.filter((row) => row.event === 'tasks').at(-1)?.data?.maintenance;
        if (state?.state === 'error') throw new Error(state.error);
        return state?.state === 'ready';
      }, 'deferred startup maintenance ready');
    }
    return c;
  } catch (error) {
    closed = true;
    await worker.terminate();
    channel.port1.close();
    throw error;
  }
}

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-external-sync-worker-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(source);
  await fs.mkdir(data);
  const seed = new DatabaseSync(path.join(data, 'library.sqlite'));
  try {
    seed.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
    const insert = seed.prepare('INSERT INTO settings VALUES(?,?)');
    insert.run('autoMatch', 'false');
    insert.run('watchChanges', 'true');
  } finally {
    seed.close();
  }
  const clients = [];
  const safe = (value) => {
    const resolved = path.resolve(value),
      relative = path.relative(tmp, resolved);
    assert.ok(
      relative &&
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative),
      'Operate only inside the exact fixture'
    );
    return resolved;
  };
  t.after(async () => {
    const failures = [];
    for (const c of clients.slice().reverse()) {
      try {
        await c.close();
      } catch (error) {
        failures.push(error);
      }
    }
    const resolved = path.resolve(tmp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-external-sync-worker-'));
    await fs.rm(resolved, { recursive: true, force: true });
    if (failures.length)
      throw new AggregateError(failures, 'External-sync fixture shutdown failed');
  });
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#916b52' } })
    .png()
    .toBuffer();
  return {
    tmp,
    source,
    data,
    async image(value) {
      safe(value);
      await fs.mkdir(path.dirname(value), { recursive: true });
      await fs.writeFile(value, png);
    },
    async move(from, to, { retryWindowsBusy = false } = {}) {
      const sourcePath = safe(from),
        destinationPath = safe(to);
      if (!retryWindowsBusy || process.platform !== 'win32') {
        await fs.rename(sourcePath, destinationPath);
        return;
      }
      // Only the offline-root trigger opts in. A transient Windows sharing
      // conflict must not prevent exercising the unchanged business assertions.
      const original = await fs.lstat(sourcePath, { bigint: true });
      assert.ok(original.isDirectory() && !original.isSymbolicLink());
      const started = performance.now(),
        deadline = started + 2000;
      let attempts = 0,
        firstError;
      const errors = [];
      try {
        for (;;) {
          if (attempts && performance.now() >= deadline) throw firstError;
          try {
            safe(sourcePath);
            safe(destinationPath);
            const current = await fs.lstat(sourcePath, { bigint: true });
            assert.ok(current.isDirectory() && !current.isSymbolicLink());
            assert.equal(current.dev, original.dev, 'Offline root device must stay unchanged');
            assert.equal(current.ino, original.ino, 'Offline root inode must stay unchanged');
            assert.equal(
              current.birthtimeNs,
              original.birthtimeNs,
              'Offline root creation identity must stay unchanged'
            );
            const parent = await fs.lstat(path.dirname(destinationPath));
            assert.ok(parent.isDirectory() && !parent.isSymbolicLink());
            try {
              await fs.lstat(destinationPath);
              throw new Error('Offline root destination must remain absent');
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
          } catch (error) {
            if (firstError) {
              firstError.cause = error;
              throw firstError;
            }
            throw error;
          }
          if (attempts && performance.now() >= deadline) throw firstError;
          attempts++;
          try {
            await fs.rename(sourcePath, destinationPath);
            return;
          } catch (error) {
            if (!['EPERM', 'EBUSY'].includes(error.code)) throw error;
            firstError ||= error;
            errors.push(error.code);
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw firstError;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(25 * 2 ** Math.min(attempts - 1, 3), 200, remaining))
            );
          }
        }
      } finally {
        t.diagnostic(
          JSON.stringify({
            fixture: 'offline-root-native-rename',
            sourcePath,
            destinationPath,
            attempts,
            errors,
            elapsedMs: Number((performance.now() - started).toFixed(3)),
            budgetMs: 2000
          })
        );
      }
    },
    async remove(value) {
      await fs.rm(safe(value), { recursive: true, force: false });
    },
    async open(options) {
      const c = await client(data, options);
      clients.push(c);
      return c;
    },
    sql() {
      return new DatabaseSync(path.join(data, 'library.sqlite'));
    }
  };
}
async function importOnce(c, f) {
  const result = await c.call('scan', { path: f.source, offline: true, onlineMatch: false });
  assert.equal(result.errors, 0);
  assert.equal(result.cancelled, false);
  await c.idle();
  assert.equal(c.scanCalls, 1);
  await c.until(
    () =>
      c.events.some((row) => row.event === 'fixture-watch' && row.data.phase === 'installed') ||
      c.events.some((row) => row.event === 'fixture-watch' && row.data.phase === 'throw'),
    'real watch construction attempted'
  );
}
async function saveManualState(f, c, album, cover, unchangedImage, options) {
  await c.close();
  const db = f.sql();
  try {
    db.prepare('INSERT INTO metadata(id,json,updated) VALUES(?,?,?)').run(
      42,
      JSON.stringify({
        id: 42,
        type: 4,
        name: 'Saved manual fixture identity',
        collection: { collect: 100 }
      }),
      Date.now()
    );
    db.prepare(
      `UPDATE nodes SET subject_id=42,manual_subject=1,confirmed=1,favorite=1,
      cover=?,cover_source='manual',manual_cover=1,crop_x=23,crop_y=67,crop_zoom=1.2 WHERE id=?`
    ).run(idFor(cover), idFor(album));
    db.prepare('UPDATE nodes SET favorite=1 WHERE id=?').run(idFor(cover));
    if (unchangedImage) {
      assert.match(idFor(unchangedImage), /^[a-f0-9]+$/);
      db.exec(`CREATE TABLE external_sync_indexed_audit(id TEXT);
        CREATE TRIGGER external_sync_unchanged AFTER UPDATE OF indexed ON nodes
        WHEN NEW.id='${idFor(unchangedImage)}'
        BEGIN INSERT INTO external_sync_indexed_audit VALUES(NEW.id); END;`);
    }
  } finally {
    db.close();
  }
  return f.open(options);
}
async function assertManual(c, album, cover) {
  const row = await c.live(album);
  assert.ok(row);
  assert.equal(row.subject_id, 42);
  assert.equal(row.manual_subject, 1);
  assert.equal(row.confirmed, 1);
  assert.equal(row.favorite, 1);
  assert.equal(row.manual_cover, 1);
  assert.equal(row.cover_source, 'manual');
  assert.equal(row.cover, idFor(cover));
  assert.equal(row.crop_x, 23);
  assert.equal(row.crop_y, 67);
  assert.equal(row.crop_zoom, 1.2);
  assert.equal((await c.live(cover)).favorite, 1);
}
function renameEvents(c) {
  return c.events.filter((row) => row.event === 'changed').flatMap((row) => row.data.renames || []);
}

// This case deliberately never invokes filesystemSync: it proves the actual OS
// recursive watcher (including new child directories) drives the production path.
test(
  'native external watch discovers additions/deletions and preserves a renamed manual album without rescanning an unchanged branch',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'Original Album');
    const cover = path.join(album, 'Deep', 'keep.png'),
      stable = path.join(f.source, 'Stable', 'unchanged.png');
    const removed = path.join(f.source, 'Removed Folder'),
      loose = path.join(f.source, 'delete.png');
    for (const value of [cover, stable, path.join(removed, 'remove.png'), loose])
      await f.image(value);
    let c = await f.open();
    await importOnce(c, f);
    c = await saveManualState(f, c, album, cover, stable);
    const added = path.join(album, 'Deep', 'New Folder', 'new.png');
    await f.image(added);
    await c.until(
      async () => (await c.live(added)) && (await c.live(f.source)).files === 5,
      'watch-only nested new directory/image'
    );
    await f.remove(loose);
    await f.remove(removed);
    await c.until(
      async () =>
        !(await c.live(loose)) && !(await c.live(removed)) && (await c.live(f.source)).files === 3,
      'watch-only file and folder removal'
    );
    const renamed = path.join(f.source, 'Renamed Album');
    await f.move(album, renamed);
    const newCover = path.join(renamed, 'Deep', 'keep.png'),
      newAdded = path.join(renamed, 'Deep', 'New Folder', 'new.png');
    await c.until(
      async () => (await c.live(newCover)) && (await c.live(newAdded)) && !(await c.live(album)),
      'watch-only renamed subtree'
    );
    await c.idle();
    await assertManual(c, renamed, newCover);
    assert.ok(
      renameEvents(c).some(
        (row) =>
          row.oldId === idFor(album) &&
          row.id === idFor(renamed) &&
          row.oldPath === album &&
          row.path === renamed
      )
    );
    assert.equal((await c.call('asset', { id: idFor(newCover) })).path, newCover);
    assert.equal(c.scanCalls, 0, 'No manual scan/refresh after the initial import process');
    const db = f.sql();
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM external_sync_indexed_audit').get().n,
        0,
        'Unchanged descendant indexed writes must be skipped'
      );
      assert.equal(db.prepare('SELECT COUNT(*) n FROM match_pending').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM match_frontier').get().n, 0);
    } finally {
      db.close();
    }
  }
);

test(
  'external case-only directory rename updates every cached subtree path and emits a rename while preserving selections',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'CaseAlbum'),
      cover = path.join(album, 'InnerFolder', 'keep.png');
    await f.image(cover);
    let c = await f.open();
    await importOnce(c, f);
    c = await saveManualState(f, c, album, cover);
    const renamed = path.join(f.source, 'casealbum'),
      newInner = path.join(renamed, 'InnerFolder'),
      newCover = path.join(newInner, 'keep.png');
    assert.equal(idFor(album), idFor(renamed), 'Path IDs remain stable under Windows case folding');
    await f.move(album, renamed);
    await c.hint();
    await c.until(
      async () =>
        (await c.live(renamed))?.path === renamed &&
        (await c.live(newInner))?.path === newInner &&
        (await c.live(newCover))?.path === newCover,
      'case-only subtree path propagation'
    );
    await c.idle();
    await assertManual(c, renamed, newCover);
    assert.equal((await c.call('asset', { id: idFor(newCover) })).path, newCover);
    assert.ok(
      renameEvents(c).some(
        (row) => row.oldId === row.id && row.oldPath === album && row.path === renamed
      )
    );
    const names = await fs.readdir(f.source);
    assert.ok(names.includes('casealbum'));
    assert.ok(!names.includes('CaseAlbum'));
    assert.equal(c.scanCalls, 0);
  }
);

test(
  'reopening automatically catches deep changes made while closed without a manual scan or sync hint',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      deep = path.join(f.source, 'Album', 'Nested', 'Deep');
    const keep = path.join(deep, 'keep.png'),
      deleted = path.join(deep, 'delete.png');
    await f.image(keep);
    await f.image(deleted);
    let c = await f.open();
    await importOnce(c, f);
    await c.close();
    const renamed = path.join(deep, 'renamed.png'),
      added = path.join(deep, 'Offline Added', 'new.png');
    await f.move(keep, renamed);
    await f.remove(deleted);
    await f.image(added);
    c = await f.open();
    await c.until(
      async () =>
        (await c.live(renamed)) &&
        (await c.live(added)) &&
        !(await c.live(deleted)) &&
        !(await c.live(keep)) &&
        (await c.live(f.source)).files === 2,
      'startup deep filesystem reconciliation'
    );
    assert.equal(c.scanCalls, 0);
    assert.equal((await c.call('asset', { id: idFor(renamed) })).path, renamed);
  }
);

test(
  'a failed first watch registration or later watch error is retried with catch-up',
  { timeout: 60000 },
  async (t) => {
    for (const watchFailure of ['throw-first', 'error-first'])
      await t.test(watchFailure, { timeout: 30000 }, async (child) => {
        const f = await fixture(child),
          original = path.join(f.source, 'Album', 'keep.png');
        await f.image(original);
        const c = await f.open({ watchFailure });
        await importOnce(c, f);
        await c.until(
          () => c.events.some((row) => row.event === 'watch' && row.data.error),
          'production watch error'
        );
        const added = path.join(f.source, 'Missed While Watch Failed', 'late.png');
        await f.image(added);
        await c.hint();
        await c.until(
          async () =>
            c.events.some(
              (row) =>
                row.event === 'fixture-watch' &&
                row.data.attempt >= 2 &&
                row.data.phase === 'installed'
            ) &&
            (await c.live(added)) &&
            (await c.live(f.source)).files === 2,
          'watch retry and missed-directory catch-up'
        );
        assert.ok(await c.live(original));
        assert.equal(c.scanCalls, 1);
      });
  }
);

test(
  'one transient real scan directory-open failure is retried without deleting the existing child',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      deep = path.join(f.source, 'Album', 'Deep'),
      keep = path.join(deep, 'keep.png');
    await f.image(keep);
    const c = await f.open();
    await importOnce(c, f);
    await c.control({ type: 'fail-next-directory-read', path: deep });
    const added = path.join(deep, 'late.png');
    await f.image(added);
    await c.hint();
    await c.until(
      () =>
        c.events.some(
          (row) => row.event === 'fixture-directory-read' && row.data.phase === 'failed'
        ),
      'one injected full-scan EACCES'
    );
    assert.ok(await c.live(keep), 'A transient unreadable directory must retain known entries');
    await c.hint();
    await c.until(
      async () =>
        c.events.some(
          (row) =>
            row.event === 'fixture-directory-read' && row.data.phase === 'retried-native-open'
        ) &&
        (await c.live(added)) &&
        (await c.live(f.source)).files === 2,
      'native directory-open retry reconciles the missed child'
    );
    assert.equal(
      c.events.filter(
        (row) => row.event === 'fixture-directory-read' && row.data.phase === 'failed'
      ).length,
      1
    );
    assert.ok(await c.live(keep));
    assert.equal(c.scanCalls, 1);
  }
);

test(
  'temporarily unavailable root preserves all cached entries and catches changes after return',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      deep = path.join(f.source, 'Album', 'Deep'),
      keep = path.join(deep, 'keep.png');
    await f.image(keep);
    const c = await f.open();
    await importOnce(c, f);
    const start = c.events.length,
      parked = path.join(f.tmp, 'temporarily-offline-source');
    await f.move(f.source, parked, { retryWindowsBusy: true });
    await c.hint();
    await c.until(
      () =>
        c.events
          .slice(start)
          .some(
            (row) =>
              row.event === 'watch' &&
              row.data.root === idFor(f.source) &&
              (row.data.unavailable || row.data.error || row.data.reason)
          ),
      'unavailable root reported'
    );
    assert.ok(await c.live(f.source));
    assert.ok(await c.live(deep));
    assert.ok(await c.live(keep));
    assert.equal((await c.live(f.source)).files, 1);
    const db = f.sql();
    try {
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM nodes WHERE root=? AND missing<>0').get(idFor(f.source))
          .n,
        0
      );
    } finally {
      db.close();
    }
    await f.image(path.join(parked, 'Album', 'Deep', 'added-offline.png'));
    await f.move(parked, f.source, { retryWindowsBusy: true });
    await c.hint();
    const added = path.join(deep, 'added-offline.png');
    await c.until(
      async () =>
        (await c.live(added)) && (await c.live(keep)) && (await c.live(f.source)).files === 2,
      'returned root deep catch-up'
    );
    assert.equal(c.scanCalls, 1);
  }
);

test(
  'watch reconnection deep-scans an overwritten image even when its parent directory mtime is unchanged',
  { timeout: 60000 },
  async (t) => {
    for (const watchFailure of ['throw-first', 'error-first'])
      await t.test(watchFailure, { timeout: 30000 }, async (child) => {
        const f = await fixture(child),
          deep = path.join(f.source, 'Album', 'Deep'),
          image = path.join(deep, 'keep.png');
        await f.image(image);
        // Exact whole-second directory timestamps make this assertion independent
        // of timestamp conversion/rounding. No directory entries change below.
        const directoryTime = 1700000000;
        await fs.utimes(deep, directoryTime, directoryTime);
        const c = await f.open({ watchFailure, holdWatchRepair: true });
        await importOnce(c, f);
        await c.until(
          () => c.events.some((row) => row.event === 'watch' && row.data.error),
          'watch is unavailable before the in-place overwrite'
        );
        const before = await c.live(image),
          parentBefore = await fs.stat(deep);
        assert.ok(before);
        const raw = Buffer.alloc(64 * 32 * 3);
        let seed = 7291;
        for (let i = 0; i < raw.length; i++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          raw[i] = seed >>> 24;
        }
        const replacement = await sharp(raw, { raw: { width: 64, height: 32, channels: 3 } })
          .png()
          .toBuffer();
        assert.notEqual(
          replacement.length,
          before.bytes,
          'The overwrite changes the indexed byte size'
        );
        await fs.writeFile(image, replacement);
        await fs.utimes(image, directoryTime + 60, directoryTime + 60);
        await fs.utimes(deep, directoryTime, directoryTime);
        const changed = await fs.stat(image),
          parentAfter = await fs.stat(deep);
        assert.equal(parentAfter.mtimeMs, parentBefore.mtimeMs);
        assert.notEqual(changed.mtimeMs, before.mtime);
        assert.equal(
          (await c.live(image)).bytes,
          before.bytes,
          'The disconnected watcher has not indexed the overwrite'
        );
        const repair = c.events.length;
        await c.control({ type: 'release-watch-repair' });
        await c.hint();
        await c.until(async () => {
          const current = await c.live(image);
          return (
            c.events
              .slice(repair)
              .some(
                (row) =>
                  row.event === 'fixture-watch' &&
                  row.data.attempt >= 2 &&
                  row.data.phase === 'installed'
              ) &&
            current?.bytes === changed.size &&
            current.mtime === changed.mtimeMs
          );
        }, 'reconnected watcher performs the required deep reconciliation');
        await c.idle();
        assert.equal(
          (await c.live(deep)).mtime,
          parentBefore.mtimeMs,
          'Directory metadata alone cannot identify this change'
        );
        assert.equal((await c.live(f.source)).files, 1);
        assert.equal((await c.call('asset', { id: idFor(image) })).path, image);
        assert.equal(c.scanCalls, 1, 'Only the initial import may use the scan RPC');
      });
  }
);

test(
  'a targeted background scan discovers a missed root sibling before advancing the root metadata baseline',
  { timeout: 45000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'Album'),
      original = path.join(album, 'keep.png');
    await f.image(original);
    await fs.utimes(f.source, 1700000000, 1700000000);
    const c = await f.open({ muteWatchNotifications: true });
    await importOnce(c, f);
    const baseline = await c.live(f.source);
    await c.control({ type: 'hold-next-directory-stat', path: f.source });
    try {
      await c.hint();
      await c.until(
        () =>
          c.events.some(
            (row) => row.event === 'fixture-directory-stat' && row.data.phase === 'held'
          ),
        'directory probe is held before root metadata comparison'
      );
      const sibling = path.join(f.source, 'Offline Sibling', 'missed.png'),
        inside = path.join(album, 'new.png');
      await f.image(sibling);
      await f.image(inside);
      assert.notEqual((await fs.stat(f.source)).mtimeMs, baseline.mtime);
      assert.equal(await c.live(sibling), null);
      // Only this one Album event reaches the real production watcher callback.
      // The concurrently held probe and muted native events cannot discover the
      // missed sibling and accidentally make a target-only implementation pass.
      await c.control({
        type: 'emit-watch-notification',
        path: f.source,
        eventType: 'rename',
        filename: path.join('Album', 'new.png')
      });
      await c.until(() => c.live(inside), 'targeted Album scan finishes its indexed entry');
      await c.idle();
      assert.ok(
        await c.live(sibling),
        'Changed root metadata promotes the target before root upsert can swallow the sibling'
      );
      assert.equal((await c.live(f.source)).files, 3);
      assert.ok(await c.live(original));
      assert.equal(
        c.events.some(
          (row) => row.event === 'fixture-directory-stat' && row.data.phase === 'released'
        ),
        false
      );
      assert.equal(
        c.events.filter(
          (row) =>
            row.event === 'fixture-watch-notification' && row.data.phase === 'forwarded-control'
        ).length,
        1
      );
      assert.equal(c.scanCalls, 1, 'The catch-up uses the watch queue, not a manual scan');
    } finally {
      await c.control({ type: 'release-directory-stat' });
    }
  }
);

test(
  'a resumed child scan durably widens its target before accepting root stat and survives a second interruption',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'Album'),
      original = path.join(album, 'keep.png'),
      inside = path.join(album, 'pending.png'),
      sibling = path.join(f.source, 'Offline Sibling', 'missed.png');
    await f.image(original);
    await fs.utimes(f.source, 1700000000, 1700000000);
    const readDurable = () => {
      const db = f.sql();
      try {
        return {
          jobs: db.prepare('SELECT * FROM scan_jobs').all(),
          directories: db.prepare('SELECT * FROM scan_directories').all(),
          root: db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(f.source)),
          sibling: db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(sibling))
        };
      } finally {
        db.close();
      }
    };
    const first = await f.open({ muteWatchNotifications: true });
    await importOnce(first, f);
    const baseline = await first.live(f.source);
    await first.control({ type: 'hold-next-directory-read', path: album });
    await f.image(inside);
    assert.equal(
      (await fs.stat(f.source)).mtimeMs,
      baseline.mtime,
      'Only the Album changes before the first pause'
    );
    await first.control({
      type: 'emit-watch-notification',
      path: f.source,
      eventType: 'rename',
      filename: path.join('Album', 'pending.png')
    });
    await first.until(
      () =>
        first.events.some(
          (row) =>
            row.event === 'fixture-directory-read' &&
            row.data.path === album &&
            row.data.phase === 'held'
        ),
      'real child-target scan is journaled before its first directory open'
    );
    const pausedChild = readDurable();
    assert.equal(pausedChild.jobs.length, 1);
    const jobId = pausedChild.jobs[0].id;
    assert.equal(pausedChild.jobs[0].target, album);
    assert.equal(pausedChild.jobs[0].state, 'running');
    assert.equal(JSON.parse(pausedChild.jobs[0].options).externalSync, true);
    assert.ok(
      pausedChild.directories.some((row) => row.id === idFor(album) && row.phase === 'enumerate')
    );
    assert.equal(await first.live(inside), null);
    await first.crash();

    await f.image(sibling);
    await fs.utimes(f.source, 1700000120, 1700000120);
    const changedRoot = await fs.stat(f.source);
    assert.notEqual(changedRoot.mtimeMs, baseline.mtime);
    const second = await f.open({
      muteWatchNotifications: true,
      resumeStartup: false,
      holdDirectoryRead: f.source,
      observeRootUpsert: f.source
    });
    const accepted = await second.call('startupResume');
    assert.equal(accepted.accepted, true);
    await second.until(
      () =>
        second.events.some(
          (row) =>
            row.event === 'fixture-directory-read' &&
            row.data.path === f.source &&
            row.data.phase === 'held'
        ),
      'promoted root scan is interrupted before enumerating the new sibling'
    );
    const beforeRootWrite = second.events.find(
      (row) => row.event === 'fixture-root-upsert' && row.data.beforeMtime === baseline.mtime
    )?.data;
    assert.ok(
      beforeRootWrite,
      'The real root upsert is observed before replacing its old metadata'
    );
    assert.equal(beforeRootWrite.job, jobId);
    assert.equal(
      beforeRootWrite.target,
      f.source,
      'Root target is already durable when root stat is accepted'
    );
    assert.equal(beforeRootWrite.acceptedMtime, changedRoot.mtimeMs);
    const pausedRoot = readDurable();
    assert.equal(pausedRoot.jobs.length, 1);
    assert.equal(pausedRoot.jobs[0].id, jobId);
    assert.equal(pausedRoot.jobs[0].target, f.source);
    assert.equal(
      pausedRoot.root.mtime,
      changedRoot.mtimeMs,
      'The fresh root stat baseline is committed before the second interruption'
    );
    assert.ok(
      pausedRoot.directories.some((row) => row.id === idFor(f.source) && row.phase === 'enumerate')
    );
    assert.equal(pausedRoot.sibling, undefined, 'The sibling has not been enumerated yet');
    await second.crash();

    // Root mtime now matches the accepted baseline. Recovery must use the
    // persisted widened target rather than rely on another stat mismatch.
    const recovered = await f.open({ muteWatchNotifications: true });
    await recovered.idle();
    assert.ok(
      await recovered.live(sibling),
      'Second startup resumes the root frame and discovers the missed sibling'
    );
    assert.ok(await recovered.live(inside));
    assert.ok(await recovered.live(original));
    assert.equal((await recovered.live(f.source)).files, 3);
    const finished = readDurable();
    assert.equal(finished.jobs.length, 0);
    assert.equal(finished.directories.length, 0);
    assert.equal(first.scanCalls, 1);
    assert.equal(second.scanCalls, 0);
    assert.equal(
      recovered.scanCalls,
      0,
      'Both recoveries use durable startup continuation without a manual scan'
    );
  }
);

test(
  'manual rename cancels a queued watch debounce without starving a later native external rename',
  { timeout: 40000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'Original Album'),
      cover = path.join(album, 'Deep', 'keep.png'),
      renamed = path.join(f.source, 'Renamed Album'),
      external = path.join(f.source, 'External Album');
    await f.image(cover);
    let c = await f.open();
    await importOnce(c, f);
    await c.call('settings', { key: 'watchChanges', value: false });
    c = await saveManualState(f, c, album, cover, undefined, { observeRenameWatchTimer: true });
    await c.call('settings', { key: 'watchChanges', value: true });
    await c.until(
      () => c.events.some((row) => row.event === 'fixture-watch' && row.data.phase === 'installed'),
      'native watcher installed after maintenance is ready'
    );
    await c.control({ type: 'arm-first-watch-timer' });
    await c.control({
      type: 'emit-watch-notification',
      path: f.source,
      eventType: 'change',
      filename: path.basename(album)
    });
    const armed = await c.until(
      () =>
        c.events.find((row) => row.event === 'fixture-watch-timer' && row.data.phase === 'armed'),
      'first real debounce handle is armed'
    );
    assert.ok(armed.data.delay > 0 && armed.data.delay <= 1500);
    const manual = c.call('rename', { id: idFor(album), name: path.basename(renamed) });
    // Attach a handler before awaiting the gate so an unexpected early rejection
    // is still owned by this test and failure cleanup can unblock the mover.
    manual.catch(() => {});
    await c.until(
      () =>
        c.events.some((row) => row.event === 'fixture-rename-move' && row.data.phase === 'held'),
      'manual rename reaches the real filesystem mover'
    );
    assert.ok(
      c.events.some(
        (row) =>
          row.event === 'fixture-watch-timer' &&
          row.data.phase === 'cancelled' &&
          row.data.destroyed === true
      ),
      'rename cancelled the exact native debounce handle'
    );
    await c.until(
      () => Date.now() > armed.data.due + 50,
      'old production deadline passes while rename reserves the root'
    );
    const installedBefore = c.events.filter(
      (row) => row.event === 'fixture-watch' && row.data.phase === 'installed'
    ).length;
    await c.control({ type: 'release-rename-move' });
    const result = await manual;
    assert.equal(result.oldId, idFor(album));
    assert.equal(result.id, idFor(renamed));
    assert.equal(result.path, renamed);
    await c.until(
      () =>
        c.events.filter((row) => row.event === 'fixture-watch' && row.data.phase === 'installed')
          .length > installedBefore,
      'native watcher reinstalled after manual rename'
    );
    const renamedCover = path.join(renamed, 'Deep', 'keep.png'),
      externalCover = path.join(external, 'Deep', 'keep.png');
    await assertManual(c, renamed, renamedCover);
    const afterManual = c.events.length;
    await f.move(renamed, external);
    await c.until(
      () =>
        c.events
          .slice(afterManual)
          .some(
            (row) =>
              row.event === 'changed' &&
              row.data.renames?.some(
                (move) => move.oldId === idFor(renamed) && move.id === idFor(external)
              )
          ),
      'later native external rename is automatically reconciled',
      12000
    );
    await c.idle();
    assert.equal(await c.live(album), null);
    assert.equal(await c.live(renamed), null);
    await assertManual(c, external, externalCover);
    assert.equal((await c.live(f.source)).files, 1);
    assert.equal((await c.call('asset', { id: idFor(externalCover) })).path, externalCover);
    assert.equal(c.scanCalls, 0, 'No manual scan or refresh in the regression worker');
    assert.equal(
      c.events.filter(
        (row) =>
          row.event === 'fixture-watch-notification' && row.data.phase === 'forwarded-control'
      ).length,
      1,
      'Only the initial debounce was explicitly notified; the later rename uses the real OS watcher'
    );
  }
);
