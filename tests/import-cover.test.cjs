'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');
const script = path.resolve(__dirname, '../src/library-worker.cjs');
async function client(dataDir, source, { pause = false } = {}) {
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    let source = fs.readFileSync(workerData.script, 'utf8');
    source = source.replace("const media = require('./media.cjs').createMedia({ db, home, getNode, send });", "const media = require('./media.cjs').createMedia({ db, home, getNode, send }); media.start = () => Promise.resolve(media.stats());");
    if (workerData.pause) {
      const anchor = 'await visit(child);';
      if (!source.includes(anchor)) throw new Error('scan visit test marker missing');
      source = source.replace(anchor, "if (!global.__pausedVisit) { global.__pausedVisit = true; parentPort.postMessage({event:'preview-paused',data:{inTransaction:db.isTransaction}}); await new Promise(resolve => parentPort.on('message', message => { if (message.resume) resolve(); })); } " + anchor);
    }
    global.fetch = async (url) => {
      const DatabaseSync = require('node:sqlite').DatabaseSync;
      const db = new DatabaseSync(path.join(workerData.dataDir, 'library.sqlite'), {readOnly:true});
      const rows = db.prepare("SELECT id,cover,cover_source FROM nodes WHERE parent=? AND kind='folder' AND missing=0").all(workerData.root);
      db.close();
      parentPort.postMessage({event:'network-observed',data:{url:String(url),rows}});
      return new Response(JSON.stringify([]), {status:200,headers:{'Content-Type':'application/json'}});
    };
    const compiled = new Module(workerData.script, module);
    compiled.filename = workerData.script;
    compiled.paths = Module._nodeModulePaths(path.dirname(workerData.script));
    compiled._compile(source, workerData.script);
  `,
    { eval: true, workerData: { script, dataDir, watch: false, pause, root: idFor(source) } }
  );
  const pending = new Map(),
    events = [];
  let seq = 0,
    readyResolve,
    readyReject,
    pausedResolve,
    networkResolve;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const paused = new Promise((resolve) => {
    pausedResolve = resolve;
  });
  const network = new Promise((resolve) => {
    networkResolve = resolve;
  });
  worker.on('error', (error) => {
    readyReject(error);
    for (const p of pending.values()) p.reject(error);
  });
  worker.on('message', (message) => {
    if (message.event) events.push(message);
    if (message.event === 'ready') readyResolve();
    if (message.event === 'preview-paused') pausedResolve(message.data);
    if (message.event === 'network-observed') networkResolve(message.data);
    if (message.request) {
      const p = pending.get(message.request);
      pending.delete(message.request);
      if (p) message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
    }
  });
  await ready;
  return {
    events,
    paused,
    network,
    resume() {
      worker.postMessage({ resume: true });
    },
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++seq;
        pending.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
    },
    async close() {
      worker.postMessage({ resume: true });
      try {
        await this.call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-import-cover-'));
  const f = {
    directory,
    source: path.join(directory, 'source'),
    data: path.join(directory, 'data'),
    active: null
  };
  await fs.mkdir(f.source);
  t.after(async () => {
    await f.active?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-import-cover-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return f;
}
async function image(file) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'isolated image placeholder; decoding suppressed');
}
function database(f, work) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

test(
  'first import publishes sibling and ancestor local covers before deep scan or any network, and cancellation preserves atomic preview rows',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const files = [
      path.join(f.source, 'one', '2.jpg'),
      path.join(f.source, 'two', 'nested', 'first.png'),
      path.join(f.source, 'three', 'deep', 'child', 'cover.webp')
    ];
    for (const file of files) await image(file);
    f.active = await client(f.data, f.source, { pause: true });
    const scanning = f.active.call('scan', {
      path: f.source,
      onlineMatch: true,
      subjectTypes: [4],
      directoryKind: 'work'
    });
    assert.deepEqual(await f.active.paused, { inTransaction: false });
    assert.equal(f.active.events.filter((event) => event.event === 'network-observed').length, 0);
    const albums = (await f.active.call('list', { parent: idFor(f.source), filter: 'folders' }))
      .items;
    assert.equal(albums.length, 3);
    for (const album of albums) {
      assert.ok(album.cover, 'every sibling has a local cover before the first subtree visit');
      assert.equal(album.cover_source, 'fallback');
      const cover = await f.active.call('get', { id: album.cover });
      assert.ok(files.includes(cover.path));
      assert.equal(cover.missing, 0);
    }
    assert.ok((await f.active.call('get', { id: idFor(f.source) })).cover);
    database(f, (db) => {
      for (const file of files) {
        const id = idFor(file);
        assert.ok(db.prepare('SELECT id FROM nodes WHERE id=?').get(id));
        assert.ok(db.prepare('SELECT id FROM search_index WHERE id=?').get(id));
        assert.equal(db.prepare('SELECT status FROM media WHERE id=?').get(id).status, 'pending');
      }
    });
    await f.active.call('cancel');
    f.active.resume();
    assert.equal((await scanning).cancelled, true);
    assert.equal(f.active.events.filter((event) => event.event === 'network-observed').length, 0);
    await f.active.close();
    f.active = await client(f.data, f.source);
    for (const album of albums) {
      const restored = await f.active.call('get', { id: album.id });
      assert.equal(restored.cover, album.cover);
      assert.equal(restored.files, 1);
    }
    assert.equal((await f.active.call('get', { id: idFor(f.source) })).files, 3);
  }
);

test(
  'first online request observes completed local covers and final selection retains natural-name and newest policies',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const first = path.join(f.source, '千恋＊万花', '2.jpg'),
      latest = path.join(f.source, '千恋＊万花', '10.jpg');
    await image(first);
    await image(latest);
    await fs.utimes(first, 1700000000, 1700000000);
    await fs.utimes(latest, 1700000200, 1700000200);
    f.active = await client(f.data, f.source);
    await f.active.call('scan', {
      path: f.source,
      onlineMatch: true,
      subjectTypes: [4],
      directoryKind: 'work'
    });
    const observed = await f.active.network;
    assert.equal(observed.rows.length, 1);
    assert.equal(observed.rows[0].cover, idFor(first));
    assert.equal(observed.rows[0].cover_source, 'fallback');
    await f.active.call('cancel');
    assert.equal(
      (await f.active.call('get', { id: idFor(path.dirname(first)) })).cover,
      idFor(first)
    );
    await f.active.call('scan', {
      path: f.source,
      offline: true,
      onlineMatch: false,
      directoryKind: 'photo'
    });
    assert.equal(
      (await f.active.call('get', { id: idFor(path.dirname(first)) })).cover,
      idFor(latest)
    );
  }
);

test(
  'target scans preview only visited new folders and never partially index a skipped existing subtree',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const existing = path.join(f.source, 'existing');
    await fs.mkdir(existing);
    f.active = await client(f.data, f.source);
    await f.active.call('scan', { path: f.source, offline: true });
    const nested = path.join(existing, 'new');
    await image(path.join(nested, 'a.jpg'));
    await image(path.join(nested, 'b.jpg'));
    await f.active.call('scan', { path: f.source, target: f.source, offline: true });
    database(f, (db) => {
      assert.equal(
        db.prepare('SELECT count(*) n FROM nodes WHERE path LIKE ?').get(nested + '%').n,
        0,
        'skipped existing subtree must not retain partial preview nodes'
      );
      const skipped = db
        .prepare('SELECT cover,local_newest FROM nodes WHERE id=?')
        .get(idFor(existing));
      assert.ok(!skipped.cover);
      assert.equal(skipped.local_newest, '');
    });
    await f.active.call('scan', { path: f.source, target: existing, offline: true });
    const result = await f.active.call('get', { id: idFor(nested) });
    assert.equal(result.files, 2);
    assert.ok(result.cover);
    assert.equal((await f.active.call('get', { id: idFor(existing) })).files, 2);
    database(f, (db) => {
      for (const name of ['a.jpg', 'b.jpg']) {
        const id = idFor(path.join(nested, name));
        assert.ok(db.prepare('SELECT id FROM nodes WHERE id=? AND missing=0').get(id));
        assert.ok(db.prepare('SELECT id FROM search_index WHERE id=?').get(id));
        assert.ok(db.prepare('SELECT id FROM media WHERE id=?').get(id));
      }
      for (const folder of [nested, existing, f.source]) {
        const row = db
          .prepare('SELECT cover,local_newest FROM nodes WHERE id=?')
          .get(idFor(folder));
        assert.ok(row.cover, 'complete target scan restores ancestor covers');
        assert.ok(
          db
            .prepare("SELECT id FROM nodes WHERE id=? AND kind='image' AND missing=0")
            .get(row.local_newest),
          'newest pointers resolve to a fully indexed live image'
        );
      }
    });
  }
);

test(
  'early scan covers preserve manual and matched Bangumi covers and manual crops',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const manualFile = path.join(f.source, 'manual', 'cover.jpg'),
      matchedFile = path.join(f.source, 'matched', 'cover.png');
    await image(manualFile);
    await image(matchedFile);
    f.active = await client(f.data, f.source);
    await f.active.call('scan', {
      path: f.source,
      offline: true,
      onlineMatch: false,
      directoryKind: 'work'
    });
    await f.active.call('setCover', {
      id: idFor(path.dirname(manualFile)),
      imageId: idFor(manualFile)
    });
    await f.active.call('patch', {
      id: idFor(path.dirname(manualFile)),
      changes: { crop_x: 23, crop_y: 74, crop_zoom: 1.9, favorite: 1 }
    });
    await f.active.close();
    f.active = null;
    database(f, (db) =>
      db
        .prepare(
          "UPDATE nodes SET subject_id=42,cover='remote-cover',cover_source='bangumi',confirmed=1 WHERE id=?"
        )
        .run(idFor(path.dirname(matchedFile)))
    );
    await image(path.join(f.source, 'manual', 'new.jpg'));
    await image(path.join(f.source, 'matched', 'new.jpg'));
    f.active = await client(f.data, f.source, { pause: true });
    const scanning = f.active.call('scan', {
      path: f.source,
      offline: true,
      onlineMatch: false,
      directoryKind: 'work'
    });
    await f.active.paused;
    const manual = await f.active.call('get', { id: idFor(path.dirname(manualFile)) });
    assert.deepEqual(
      [
        manual.cover,
        manual.manual_cover,
        manual.crop_x,
        manual.crop_y,
        manual.crop_zoom,
        manual.favorite
      ],
      [idFor(manualFile), 1, 23, 74, 1.9, 1]
    );
    assert.equal(
      (await f.active.call('get', { id: idFor(path.dirname(matchedFile)) })).cover,
      'remote-cover'
    );
    f.active.resume();
    await scanning;
    assert.equal(
      (await f.active.call('get', { id: idFor(path.dirname(matchedFile)) })).cover_source,
      'bangumi'
    );
  }
);

test(
  'preview directory walks do not traverse a directory symlink',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      outside = path.join(f.directory, 'outside'),
      linked = path.join(f.source, 'album', 'linked');
    await image(path.join(outside, 'secret.jpg'));
    await fs.mkdir(path.dirname(linked), { recursive: true });
    try {
      await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code))
        return t.skip('symlinks unavailable');
      throw error;
    }
    await image(path.join(f.source, 'other', 'local.jpg'));
    f.active = await client(f.data, f.source, { pause: true });
    const scanning = f.active.call('scan', { path: f.source, offline: true });
    await f.active.paused;
    assert.equal((await f.active.call('get', { id: idFor(path.dirname(linked)) })).cover, null);
    assert.equal(await f.active.call('get', { id: idFor(path.join(linked, 'secret.jpg')) }), null);
    f.active.resume();
    await scanning;
    assert.equal((await f.active.call('list', { filter: 'images' })).total, 1);
  }
);

test(
  'bounded preview does not walk a deep subtree, while the normal scan still finds its cover',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      album = path.join(f.source, 'deep-album'),
      file = path.join(album, ...Array.from({ length: 8 }, (_, i) => 'level-' + i), 'cover.jpg');
    await image(file);
    f.active = await client(f.data, f.source, { pause: true });
    const scanning = f.active.call('scan', { path: f.source, offline: true });
    await f.active.paused;
    assert.equal((await f.active.call('get', { id: idFor(album) })).cover, null);
    assert.equal(
      await f.active.call('get', { id: idFor(file) }),
      null,
      'preview must not index the distant descendant'
    );
    f.active.resume();
    assert.equal((await scanning).errors, 0);
    assert.equal((await f.active.call('get', { id: idFor(album) })).cover, idFor(file));
  }
);
