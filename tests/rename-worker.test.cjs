'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { idFor, thumbnailKey } = require('../src/model.cjs');

const windows = {
  skip: process.platform !== 'win32' ? 'Actual Windows no-overwrite rename backend' : false,
  timeout: 90000
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=',
  'base64'
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const absent = (p) => assert.rejects(fs.lstat(p), { code: 'ENOENT' });

// Real library worker, real SQLite, real Windows .NET Move, tiny owned files.
// Test-only gates surround move/complete; they never replace their implementation.
// Metadata synchronization stays real, while background decoding and all HTTP
// entry points are disabled before the product worker is required.
async function client(dataDir, config = {}) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    'use strict';
    const { workerData, parentPort } = require('node:worker_threads');
    const Module = require('node:module');
    const fs = require('node:fs/promises');
    const config = workerData.fixture;
    const control = workerData.control;
    const waiting = new Map(), released = new Set();
    const usedGates = new Set();
    let occupied = false, commitFailed = false;
    const emit = (event, data) => parentPort.postMessage({ event, data });
    const forbid = (kind) => {
      emit('forbidden-' + kind, { kind });
      throw new Error(kind + ' is forbidden in rename worker fixtures');
    };
    global.fetch = async () => forbid('network');
    for (const name of ['node:http', 'node:https']) {
      const http = require(name);
      http.request = http.get = () => forbid('network');
    }
    control.on('message', ({ release }) => {
      released.add(release);
      const resolve = waiting.get(release);
      if (resolve) { waiting.delete(release); resolve(); }
    });
    control.unref();
    async function gate(point, data) {
      if (usedGates.has(point) || released.has(point) ||
          ![config.holdAt, config.holdResourceAt, config.holdWriteAt].includes(point)) return;
      usedGates.add(point);
      const pending = new Promise((resolve) => waiting.set(point, resolve));
      emit('test-gate', { point, ...data });
      await pending;
    }
    const nativeStat = fs.stat.bind(fs), nativeOpen = fs.open.bind(fs), nativeRealpath = fs.realpath.bind(fs);
    fs.stat = async (file, ...args) => {
      if (file === config.holdStatPath) await gate('resource-stat', { file });
      return nativeStat(file, ...args);
    };
    fs.open = async (file, ...args) => {
      const handle = await nativeOpen(file, ...args);
      if (file === config.holdReadPath && args[0] === 'r') {
        const nativeRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          await gate('resource-read', { file });
          if (config.failResourceRead) throw new Error('injected resource read failure');
          return nativeRead(...readArgs);
        };
      }
      return handle;
    };
    fs.realpath = async (file, ...args) => {
      if (file === config.holdRealpath) await gate('write-realpath', { file });
      return nativeRealpath(file, ...args);
    };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'sharp') {
        const sharp = () => forbid('decode');
        sharp.cache = sharp.concurrency = () => {};
        return sharp;
      }
      const value = originalLoad.apply(this, arguments);
      if (/[\\/]media\\.cjs$/u.test(request)) return {
        ...value,
        createMedia(options) {
          const media = value.createMedia(options);
          return { ...media,
            start: async () => { emit('test-media-start', {}); return media.stats(); },
            stop: async () => { emit('test-media-stop', { stage: 'enter' }); await media.stop(); emit('test-media-stop', { stage: 'done' }); },
            ensure: async () => forbid('decode'), frame: async () => forbid('decode'), export: async () => forbid('decode')
          };
        }
      };
      if (/[\\/]image-preview\\.cjs$/u.test(request)) return {
        ...value,
        createImagePreview(options) {
          const preview = value.createImagePreview(options);
          return { ...preview, preview: async () => forbid('decode') };
        }
      };
      if (/[\\/]heif-decoder\\.cjs$/u.test(request)) return {
        ...value,
        createHeifDecoder() { return { decode: async () => forbid('decode'), stop: async () => {}, stats: () => ({ requests: 0 }) }; }
      };
      if (/[\\/]fs-rename\\.cjs$/u.test(request)) return {
        ...value,
        createFsRename(options) {
          const service = value.createFsRename({ ...options, moveNoReplace: async (source, destination, kind) => {
            await gate('before-move', { source, destination });
            await value.windowsMoveNoReplace(source, destination, kind);
            if (config.occupyOldAfterMove && !occupied) {
              occupied = true;
              await fs.writeFile(source, 'fixture outsider', { flag: 'wx' });
            }
            await gate('after-move', { source, destination });
          } });
          return { ...service,
            complete: async (receipt) => {
              await gate('before-complete', { opId: receipt.opId, source: receipt.oldPath, destination: receipt.path });
              if (config.failComplete) throw new Error('injected complete cleanup failure');
              return service.complete(receipt);
            }
          };
        }
      };
      if (/[\\/]rename-identity\\.cjs$/u.test(request)) return {
        ...value,
        createRenameIdentity(...args) {
          const service = value.createRenameIdentity(...args);
          return { ...service, commit(...commitArgs) {
            if (config.failCommit && !commitFailed) {
              commitFailed = true;
              throw new Error('injected DB rename commit failure');
            }
            return service.commit(...commitArgs);
          } };
        }
      };
      return value;
    };
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        fixture: config,
        control: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  let seq = 0,
    closed = false;
  const pending = new Map(),
    events = [],
    observers = new Set();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Rename worker did not become ready')), 30000);
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.on('message', (message) => {
      if (message.event) {
        events.push(message);
        for (const observer of [...observers]) observer();
        if (message.event === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      }
      const item = pending.get(message.request);
      if (!item) return;
      pending.delete(message.request);
      clearTimeout(item.timer);
      if (message.error)
        item.reject(
          Object.assign(new Error(message.error), {
            code: message.code,
            workerStack: message.stack
          })
        );
      else item.resolve(message.result);
    });
  });
  worker.on('error', (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  const c = {
    events,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++seq;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Rename worker RPC timed out: ' + method));
        }, 45000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    wait(event, predicate = () => true, from = 0) {
      return new Promise((resolve, reject) => {
        const inspect = () => {
          const found = events
            .slice(from)
            .find((entry) => entry.event === event && predicate(entry.data));
          if (found) {
            cleanup();
            resolve(found.data);
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          observers.delete(inspect);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('Rename worker event timed out: ' + event));
        }, 30000);
        observers.add(inspect);
        inspect();
      });
    },
    release(point) {
      port1.postMessage({ release: point });
    },
    async kill() {
      if (closed) return;
      closed = true;
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Fixture hard termination'));
      }
      pending.clear();
      port1.close();
      await worker.terminate();
    },
    async close() {
      if (closed) return;
      for (const point of [
        'resource-stat',
        'resource-read',
        'write-realpath',
        'before-move',
        'after-move',
        'before-complete'
      ])
        c.release(point);
      try {
        await c.call('shutdown');
      } catch {}
      await c.kill();
    },
    safe() {
      assert.deepEqual(
        events.filter((entry) => entry.event === 'forbidden-network'),
        [],
        'fixture must never contact HTTP'
      );
      assert.deepEqual(
        events.filter((entry) => entry.event === 'forbidden-decode'),
        [],
        'fixture must never decode media'
      );
    }
  };
  try {
    await ready;
  } catch (error) {
    await c.kill();
    throw error;
  }
  return c;
}

async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-rename-worker-'));
  const source = path.join(tmp, 'Library'),
    data = path.join(tmp, 'data');
  await fs.mkdir(path.join(source, 'Original Album', 'Nested'), { recursive: true });
  await fs.mkdir(path.join(source, 'Stable Album'));
  const album = path.join(source, 'Original Album'),
    image = path.join(album, 'Nested', 'image.png'),
    loose = path.join(source, 'loose.png');
  await fs.writeFile(image, png);
  await fs.writeFile(loose, png);
  await fs.utimes(image, 1700000000, 1700000001);
  await fs.utimes(loose, 1700000000, 1700000002);
  const clients = [];
  const f = {
    tmp,
    source,
    data,
    album,
    image,
    loose,
    async open(config) {
      const c = await client(data, config);
      clients.push(c);
      return c;
    },
    sql(callback) {
      const db = new DatabaseSync(path.join(data, 'library.sqlite'));
      try {
        return callback(db);
      } finally {
        db.close();
      }
    },
    async journals() {
      return (await fs.readdir(path.join(data, 'rename-journal'))).filter((name) =>
        name.endsWith('.json')
      );
    }
  };
  t.after(async () => {
    for (const c of clients) await c.close();
    for (const c of clients) c.safe();
    const resolved = path.resolve(tmp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-rename-worker-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  f.seed = async () => {
    const c = await f.open();
    await c.call('settings', { key: 'autoMatch', value: false });
    const scan = await c.call('scan', {
      path: source,
      offline: true,
      onlineMatch: false,
      subjectTypes: [4],
      directoryKind: 'work'
    });
    assert.equal(scan.errors, 0);
    f.sql((db) => {
      // Internal migration markers are not renderer-editable settings. Seed the
      // fixture DB directly, using the same JSON storage format as setSetting.
      db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
        'manualTitleKeysVersion',
        '1'
      );
      db.prepare(
        `UPDATE nodes SET subject_id=42,manual_subject=1,cover=?,local_newest=?,cover_source='manual',
        manual_cover=1,confirmed=1,crop_x=23,crop_y=72,crop_zoom=2,favorite=1,intro=1,album_kind='work',custom_character=? WHERE id=?`
      ).run(
        idFor(image),
        idFor(image),
        JSON.stringify({ name: 'Saved character', note: 'user note' }),
        idFor(album)
      );
      db.prepare('UPDATE nodes SET cover=?,local_newest=? WHERE id=?').run(
        idFor(image),
        idFor(image),
        idFor(source)
      );
      db.prepare(
        `UPDATE media SET status='ready',width=1,height=1,place='explicit place',place_user=1,
        latitude=12,longitude=34,coords_user=1 WHERE id IN (?,?)`
      ).run(idFor(image), idFor(loose));
      db.prepare(
        'INSERT OR REPLACE INTO manual_title_keys(node_id,name_key,subject_id,type,name) VALUES(?,?,?,?,?)'
      ).run(idFor(album), 'trusted-original-title', 42, 4, 'Original learned title');
    });
    return c;
  };
  return f;
}
function observed(promise) {
  const state = { settled: false };
  state.promise = promise.then(
    (value) => {
      state.settled = true;
      return { value };
    },
    (error) => {
      state.settled = true;
      return { error };
    }
  );
  return state;
}
async function annotation(c, albumPath, imagePath) {
  const row = await c.call('get', { id: idFor(albumPath) });
  assert.equal(row.subject_id, 42);
  assert.equal(row.manual_subject, 1);
  assert.equal(row.cover, idFor(imagePath));
  assert.equal(row.manual_cover, 1);
  assert.equal(row.crop_x, 23);
  assert.equal(row.crop_y, 72);
  assert.equal(row.crop_zoom, 2);
  assert.equal(row.favorite, 1);
  assert.equal(row.confirmed, 1);
  assert.equal(row.intro, 1);
  assert.equal(JSON.parse(row.custom_character).note, 'user note');
  assert.equal((await c.call('asset', { id: idFor(imagePath) })).path, imagePath);
  return row;
}

test(
  'worker folder, image, case-only root and root rename preserve annotations, rows, FTS and explicit media settings',
  windows,
  async (t) => {
    const f = await fixture(t),
      c = await f.seed();
    const rowids = f.sql((db) => db.prepare('SELECT id,rowid AS rowid FROM nodes').all());
    const originalMedia = f.sql((db) => ({
      ...db.prepare('SELECT * FROM media WHERE id=?').get(idFor(f.image))
    }));
    const originalPolicy = f.sql((db) => ({
      ...db.prepare('SELECT * FROM root_match_policy WHERE root=?').get(idFor(f.source))
    }));
    const originalStat = await fs.lstat(f.image, { bigint: true });
    const renamedAlbum = path.join(f.source, 'Renamed Album'),
      renamedImage = path.join(renamedAlbum, 'Nested', 'image.png');
    const folderResult = await c.call('rename', { id: idFor(f.album), name: 'Renamed Album' });
    assert.equal(folderResult.oldId, idFor(f.album));
    assert.equal(folderResult.id, idFor(renamedAlbum));
    assert.equal(folderResult.count, 3);
    await annotation(c, renamedAlbum, renamedImage);
    await absent(f.album);
    const renamedLoose = path.join(f.source, 'renamed-loose.png');
    const imageResult = await c.call('rename', { id: idFor(f.loose), name: 'renamed-loose.png' });
    assert.equal(imageResult.count, 1);
    assert.equal((await c.call('asset', { id: imageResult.id })).path, renamedLoose);
    assert.equal(hash(await fs.readFile(renamedLoose)), hash(png));
    const upperRoot = path.join(f.tmp, 'LIBRARY');
    const caseResult = await c.call('rename', { id: idFor(f.source), name: 'LIBRARY' });
    assert.equal(caseResult.caseOnly, true);
    assert.equal(caseResult.id, idFor(f.source));
    assert.ok((await fs.readdir(f.tmp)).includes('LIBRARY'));
    await annotation(
      c,
      path.join(upperRoot, 'Renamed Album'),
      path.join(upperRoot, 'Renamed Album', 'Nested', 'image.png')
    );
    const finalRoot = path.join(f.tmp, 'Final Library'),
      finalAlbum = path.join(finalRoot, 'Renamed Album'),
      finalImage = path.join(finalAlbum, 'Nested', 'image.png');
    const rootResult = await c.call('rename', { id: idFor(upperRoot), name: 'Final Library' });
    assert.equal(rootResult.oldRoot, idFor(f.source));
    assert.equal(rootResult.root, idFor(finalRoot));
    await annotation(c, finalAlbum, finalImage);
    assert.equal((await c.call('init', { lightweight: true })).roots[0].path, finalRoot);
    const finalStat = await fs.lstat(finalImage, { bigint: true });
    assert.equal(finalStat.ino, originalStat.ino);
    assert.equal(finalStat.mtimeNs, originalStat.mtimeNs);
    assert.equal(hash(await fs.readFile(finalImage)), hash(png));
    f.sql((db) => {
      const row = db
        .prepare('SELECT rowid AS rowid,* FROM nodes WHERE id=?')
        .get(idFor(finalImage));
      assert.equal(row.rowid, rowids.find((item) => item.id === idFor(f.image)).rowid);
      assert.equal(row.root, idFor(finalRoot));
      const media = { ...db.prepare('SELECT * FROM media WHERE id=?').get(idFor(finalImage)) };
      assert.deepEqual(media, { ...originalMedia, id: idFor(finalImage) });
      const learned = db
        .prepare('SELECT * FROM manual_title_keys WHERE node_id=?')
        .get(idFor(finalAlbum));
      assert.equal(learned.name_key, 'trusted-original-title');
      assert.equal(learned.name, 'Original learned title');
      assert.deepEqual(
        { ...db.prepare('SELECT * FROM root_match_policy').get() },
        { ...originalPolicy, root: idFor(finalRoot) }
      );
      assert.equal(
        db.prepare('SELECT cover FROM nodes WHERE id=?').get(idFor(finalRoot)).cover,
        idFor(finalImage)
      );
      assert.equal(
        db.prepare('SELECT rowid AS rowid FROM search_index WHERE id=?').get(idFor(finalImage))
          .rowid,
        row.rowid
      );
      assert.equal(db.prepare('SELECT count(*) n FROM match_pending').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM match_frontier').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 4);
    });
    assert.equal(
      c.events.filter((entry) => entry.event === 'changed' && entry.data.rename).length,
      4
    );
    assert.deepEqual(await f.journals(), []);
  }
);

test(
  'worker rejects occupied targets and rolls filesystem back when the DB commit fails',
  windows,
  async (t) => {
    const f = await fixture(t);
    let c = await f.seed();
    const target = path.join(f.source, 'occupied.png');
    await fs.writeFile(target, 'outsider');
    await assert.rejects(
      c.call('rename', { id: idFor(f.loose), name: 'occupied.png' }),
      /已存在|目标/u
    );
    assert.equal(hash(await fs.readFile(f.loose)), hash(png));
    assert.equal(await fs.readFile(target, 'utf8'), 'outsider');
    await c.close();
    c = await f.open({ failCommit: true });
    await assert.rejects(
      c.call('rename', { id: idFor(f.album), name: 'Rejected Album' }),
      /injected DB rename commit failure/u
    );
    await annotation(c, f.album, f.image);
    await absent(path.join(f.source, 'Rejected Album'));
    assert.deepEqual(await f.journals(), []);
    f.sql((db) => assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 0));
    const noOp = await c.call('rename', { id: idFor(f.album), name: path.basename(f.album) });
    assert.equal(noOp.renamed, false);
  }
);

test(
  'worker reserves rename against concurrent mutations and waits resource reads without admitting decoder work',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    const c = await f.open({ holdAt: 'before-move' });
    const rename = observed(c.call('rename', { id: idFor(f.album), name: 'Held Album' }));
    await c.wait('test-gate', (data) => data.point === 'before-move');
    const startsAtGate = c.events.filter((event) => event.event === 'test-media-start').length;
    const thumb = observed(c.call('thumb', { id: idFor(f.image) }));
    const asset = observed(c.call('asset', { id: idFor(f.image) }));
    const source = observed(c.call('source', { id: idFor(f.image) }));
    await assert.rejects(
      c.call('settings', { key: 'metadataOnboardingSeen', value: true }),
      /重命名|恢复|稍后/u
    );
    await assert.rejects(c.call('scan', { path: f.source, offline: true }), /重命名|恢复|稍后/u);
    await assert.rejects(
      c.call('rename', { id: idFor(f.loose), name: 'second.png' }),
      /重命名|恢复|稍后/u
    );
    assert.ok(await c.call('get', { id: idFor(f.album) }));
    assert.equal(thumb.settled, false);
    assert.equal(asset.settled, false);
    assert.equal(source.settled, false);
    await c.call('cancel'); // Cancel pending import/matching, not an already-issued filesystem move.
    // Cross both startup timer deadlines while the filesystem gate is held.
    await new Promise((resolve) => setTimeout(resolve, 850));
    await c.call('get', { id: idFor(f.album) });
    const beforeRelease = c.events.length;
    assert.equal(
      c.events.filter((event) => event.event === 'test-media-start').length,
      startsAtGate,
      'initial media timer cannot restart consumers during reservation'
    );
    c.release('before-move');
    const renamed = await rename.promise;
    assert.ok(renamed.value);
    for (const request of [thumb, asset, source])
      assert.ok((await request.promise).error, 'old IDs are rejected after waiting for rename');
    const finalAlbum = path.join(f.source, 'Held Album'),
      finalImage = path.join(finalAlbum, 'Nested', 'image.png');
    await annotation(c, finalAlbum, finalImage);
    assert.ok(c.events.slice(beforeRelease).some((event) => event.event === 'test-media-start'));
    c.safe();
  }
);

test(
  'worker admits ancestor rename after existing resource reads and drains their complete RPC lifetime',
  windows,
  async (t) => {
    for (const resource of ['thumb', 'source', 'asset', 'asset-error']) {
      await t.test(resource, async (t) => {
        const f = await fixture(t),
          seeded = await f.seed();
        const cover = path.join(f.data, 'covers', '42.webp');
        let thumbPath;
        if (resource === 'thumb' || resource === 'source') {
          await fs.mkdir(path.dirname(cover), { recursive: true });
          await fs.writeFile(cover, png);
          const stat = await fs.stat(cover);
          const album = f.sql((db) => {
            db.prepare("UPDATE nodes SET cover='subject:42' WHERE id=?").run(idFor(f.album));
            return { ...db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(f.album)) };
          });
          const key = thumbnailKey(
            { ...album, path: cover, mtime: stat.mtimeMs, bytes: stat.size },
            512
          );
          thumbPath = path.join(f.data, 'thumbnails', key + '.webp');
          await fs.mkdir(path.dirname(thumbPath), { recursive: true });
          await fs.writeFile(thumbPath, png);
          f.sql((db) =>
            db
              .prepare('INSERT OR REPLACE INTO thumbs VALUES(?,?,?,?,?)')
              .run(key, thumbPath, cover, 1, png.length)
          );
        }
        await seeded.close();
        const asset = resource.startsWith('asset');
        const point = asset ? 'resource-read' : 'resource-stat';
        const c = await f.open({
          holdResourceAt: point,
          holdStatPath: asset ? undefined : cover,
          holdReadPath: asset ? f.image : undefined,
          failResourceRead: resource === 'asset-error',
          holdAt: 'before-move'
        });
        const reading = observed(
          c.call(asset ? 'asset' : resource, {
            id: idFor(asset ? f.image : f.album),
            size: 512
          })
        );
        await c.wait('test-gate', (data) => data.point === point);
        await assert.rejects(c.call('cleanCache', { mode: 'all-thumbnails' }), /正在|稍后/u);
        if (thumbPath) assert.equal(hash(await fs.readFile(thumbPath)), hash(png));
        const renaming = observed(c.call('rename', { id: idFor(f.album), name: 'Drained Album' }));
        await c.call('get', { id: idFor(f.album) }); // Request-order barrier, not a timer.
        assert.equal(
          renaming.settled,
          false,
          'rename must admit and wait for the pre-existing resource RPC: ' +
            (renaming.settled ? (await renaming.promise).error?.message : 'still waiting')
        );
        assert.equal(
          c.events.some(({ event, data }) => event === 'test-gate' && data.point === 'before-move'),
          false
        );
        assert.deepEqual(
          await f.journals(),
          [],
          'no filesystem intent before resource handles finish'
        );
        const later = observed(c.call('asset', { id: idFor(f.image) }));
        await c.call('get', { id: idFor(f.album) });
        assert.equal(later.settled, false, 'a later resource waits outside the drain snapshot');
        await assert.rejects(
          c.call('settings', { key: 'metadataOnboardingSeen', value: true }),
          /重命名|稍后/u
        );
        c.release(point);
        const read = await reading.promise;
        if (resource === 'asset-error')
          assert.match(read.error?.message, /injected resource read failure/u);
        else {
          assert.ok(read.value);
          if (resource === 'thumb') assert.equal(read.value.path, thumbPath);
          if (resource === 'source') assert.equal(read.value.file, cover);
          if (resource === 'asset') assert.equal(read.value.path, f.image);
        }
        await c.wait('test-gate', (data) => data.point === 'before-move');
        assert.equal(
          later.settled,
          false,
          'later resources cannot join and deadlock the old-resource drain'
        );
        c.release('before-move');
        const result = await renaming.promise;
        assert.ok(result.value, result.error?.message);
        assert.equal(result.value.path, path.join(f.source, 'Drained Album'));
        assert.ok(
          (await later.promise).error,
          'old IDs are rejected only after the successful rename'
        );
        assert.ok(
          await c.call('asset', {
            id: idFor(path.join(f.source, 'Drained Album', 'Nested', 'image.png'))
          })
        );
        assert.equal(
          hash(await fs.readFile(path.join(f.source, 'Drained Album', 'Nested', 'image.png'))),
          hash(png)
        );
        await absent(f.album);
        assert.deepEqual(await f.journals(), []);
        // Completed and failed resource leases must both leave the original cache-management gate usable.
        await c.call('cleanCache', { mode: 'unused' });
        f.sql((db) => assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 1));
      });
    }
  }
);

test(
  'worker still rejects rename while a true writer is held alongside a resource read',
  windows,
  async (t) => {
    const f = await fixture(t),
      seeded = await f.seed();
    await seeded.close();
    const c = await f.open({
      holdResourceAt: 'resource-read',
      holdReadPath: f.image,
      holdWriteAt: 'write-realpath',
      holdRealpath: f.album
    });
    const reading = observed(c.call('asset', { id: idFor(f.image) }));
    await c.wait('test-gate', (data) => data.point === 'resource-read');
    const writing = observed(c.call('selectCoverPath', { id: idFor(f.album), file: f.image }));
    await c.wait('test-gate', (data) => data.point === 'write-realpath');
    for (const releaseResource of [false, true]) {
      if (releaseResource) {
        c.release('resource-read');
        assert.ok((await reading.promise).value);
      }
      await assert.rejects(
        c.call('rename', { id: idFor(f.album), name: 'Blocked Album' }),
        /请先等待/u
      );
      assert.equal(writing.settled, false);
      await absent(path.join(f.source, 'Blocked Album'));
      assert.deepEqual(await f.journals(), []);
    }
    c.release('write-realpath');
    assert.ok((await writing.promise).value);
    const renamed = await c.call('rename', { id: idFor(f.album), name: 'Writer Finished Album' });
    assert.equal(renamed.renamed, true);
    const album = await c.call('get', { id: renamed.id });
    assert.equal(album.cover, idFor(path.join(renamed.path, 'Nested', 'image.png')));
    assert.equal(album.manual_cover, 1);
  }
);

test(
  'shutdown waits an issued filesystem move and leaves a committed consistent rename without a journal',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    const c = await f.open({ holdAt: 'before-move' });
    const rename = observed(c.call('rename', { id: idFor(f.album), name: 'Shutdown Album' }));
    await c.wait('test-gate', (data) => data.point === 'before-move');
    const shutdown = observed(c.call('shutdown'));
    await c.call('get', { id: idFor(f.album) });
    assert.equal(shutdown.settled, false);
    c.release('before-move');
    assert.ok((await rename.promise).value);
    assert.equal((await shutdown.promise).value, true);
    await c.kill();
    const newPath = path.join(f.source, 'Shutdown Album');
    assert.equal(hash(await fs.readFile(path.join(newPath, 'Nested', 'image.png'))), hash(png));
    await absent(f.album);
    assert.deepEqual(await f.journals(), []);
    f.sql((db) => {
      assert.ok(db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(newPath)));
      assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 1);
    });
  }
);

test(
  'startup rolls an uncommitted moved directory back before releasing resource reads',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    let c = await f.open({ holdAt: 'after-move' });
    const interrupted = observed(
      c.call('rename', { id: idFor(f.album), name: 'Uncommitted Album' })
    );
    await c.wait('test-gate', (data) => data.point === 'after-move');
    await c.kill();
    assert.ok((await interrupted.promise).error);
    const moved = path.join(f.source, 'Uncommitted Album');
    assert.equal(hash(await fs.readFile(path.join(moved, 'Nested', 'image.png'))), hash(png));
    f.sql((db) => assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 0));
    c = await f.open({ holdAt: 'before-move' });
    await c.wait('test-gate', (data) => data.point === 'before-move');
    const asset = observed(c.call('asset', { id: idFor(f.image) }));
    await c.call('get', { id: idFor(f.album) });
    assert.equal(asset.settled, false);
    c.release('before-move');
    await c.wait('tasks', (data) => data.maintenance.state === 'ready');
    assert.equal((await asset.promise).value.path, f.image);
    await annotation(c, f.album, f.image);
    await absent(moved);
    assert.deepEqual(await f.journals(), []);
    c.safe();
  }
);

test(
  'startup keeps a DB-committed rename after termination before journal cleanup',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    let c = await f.open({ holdAt: 'before-complete' });
    const interrupted = observed(c.call('rename', { id: idFor(f.album), name: 'Committed Album' }));
    await c.wait('test-gate', (data) => data.point === 'before-complete');
    await c.kill();
    assert.ok((await interrupted.promise).error);
    const newAlbum = path.join(f.source, 'Committed Album'),
      newImage = path.join(newAlbum, 'Nested', 'image.png');
    f.sql((db) => assert.equal(db.prepare('SELECT count(*) n FROM rename_commits').get().n, 1));
    assert.equal((await f.journals()).length, 1);
    c = await f.open();
    await c.wait('tasks', (data) => data.maintenance.state === 'ready');
    await annotation(c, newAlbum, newImage);
    await absent(f.album);
    assert.deepEqual(await f.journals(), []);
  }
);

test(
  'cleanup failure returns committed success and leaves an intent for the next startup instead of rolling the source back',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    let c = await f.open({ failComplete: true });
    const newAlbum = path.join(f.source, 'Cleanup Pending'),
      newImage = path.join(newAlbum, 'Nested', 'image.png');
    const result = await c.call('rename', { id: idFor(f.album), name: 'Cleanup Pending' });
    assert.equal(result.renamed, true);
    assert.equal(result.recoveryPending, true);
    await annotation(c, newAlbum, newImage);
    await absent(f.album);
    assert.equal((await f.journals()).length, 1);
    assert.ok(
      c.events.some(
        (event) => event.event === 'changed' && event.data.rename?.id === idFor(newAlbum)
      )
    );
    await c.close();
    c = await f.open();
    await c.wait('tasks', (data) => data.maintenance.state === 'ready');
    await annotation(c, newAlbum, newImage);
    assert.deepEqual(await f.journals(), []);
  }
);

test(
  'rollback collision preserves both objects and recovery gates mutations until an explicit startup retry succeeds',
  windows,
  async (t) => {
    const f = await fixture(t);
    const seeded = await f.seed();
    await seeded.close();
    let c = await f.open({ failCommit: true, occupyOldAfterMove: true });
    const moved = path.join(f.source, 'Needs Recovery'),
      movedImage = path.join(moved, 'Nested', 'image.png');
    await assert.rejects(
      c.call('rename', { id: idFor(f.album), name: 'Needs Recovery' }),
      /需要恢复|检查实际位置/u
    );
    assert.equal(await fs.readFile(f.album, 'utf8'), 'fixture outsider');
    assert.equal(hash(await fs.readFile(movedImage)), hash(png));
    assert.equal((await f.journals()).length, 1);
    await assert.rejects(
      c.call('settings', { key: 'metadataOnboardingSeen', value: true }),
      /重命名|恢复/u
    );
    await assert.rejects(c.call('asset', { id: idFor(f.image) }), /重命名|恢复/u);
    await c.close();
    c = await f.open();
    await c.wait('tasks', (data) => data.maintenance.state === 'error');
    await assert.rejects(c.call('thumb', { id: idFor(f.image) }), /重命名|恢复/u);
    assert.equal((await c.call('init', { lightweight: true })).taskSnapshot.busy, true);
    // Remove exactly the collision file this fixture created; the original object
    // remains under moved and is restored by the production recovery service.
    assert.equal(await fs.readFile(f.album, 'utf8'), 'fixture outsider');
    await fs.unlink(f.album);
    const from = c.events.length;
    await c.call('startupResume');
    await c.wait('tasks', (data) => data.maintenance.state === 'ready', from);
    await annotation(c, f.album, f.image);
    await absent(moved);
    assert.deepEqual(await f.journals(), []);
    assert.equal((await c.call('init', { lightweight: true })).taskSnapshot.busy, false);
    c.safe();
  }
);
