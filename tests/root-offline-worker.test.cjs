'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor, thumbnailKey } = require('../src/model.cjs');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=',
  'base64'
);

async function client(dataDir, fixture = {}) {
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const Module = require('node:module'), fs = require('node:fs/promises');
    const originalLoad = Module._load, originalStat = fs.lstat;
    let held = false, release, armed = !workerData.fixture.armLater;
    let holdDecodeRoot=workerData.fixture.holdDecodeRoot, decodeReleases=[];
    parentPort.on('message', (m) => {
      if (m.fixtureRelease) { release?.(); for(const done of decodeReleases.splice(0))done(); }
      if (m.fixtureArm) armed=true;
      if (m.fixtureHoldDecoder) holdDecodeRoot=m.fixtureHoldDecoder;
    });
    fs.lstat = async (file, ...args) => {
      if (file === workerData.fixture.auditPath) parentPort.postMessage({event:'fixture-stat'});
      if (armed && file === workerData.fixture.holdPath && !held) {
        held = true;
        parentPort.postMessage({ event: 'fixture-held' });
        await new Promise((resolve) => { release = resolve; });
      }
      return originalStat(file, ...args);
    };
    global.fetch = async () => { throw new Error('network forbidden'); };
    Module._load = function(request) {
      if (request === 'sharp') {
        const sharp = (input) => {
          if(!workerData.fixture.decoder) throw new Error('decoder forbidden');
          const chain={rotate(){return this;},resize(){return this;},webp(){return this;},timeout(){return this;},destroy(){parentPort.postMessage({event:'fixture-destroy'});},
            async toFile(file) {
              parentPort.postMessage({event:'fixture-decode',data:input});
              if(typeof input==='string' && holdDecodeRoot && input.startsWith(holdDecodeRoot))
                await new Promise(resolve=>decodeReleases.push(resolve));
              await fs.writeFile(file,Buffer.from('owned-fixture-cache'));return {size:19};
            }
          };return chain;
        };
        sharp.cache = sharp.concurrency = () => {};
        return sharp;
      }
      const value = originalLoad.apply(this, arguments);
      if (/[\\/]media\\.cjs$/.test(request)) return { ...value, createMedia(options) {
        const media=value.createMedia(options); return { ...media, start: async () => media.stats() };
      }};
      return value;
    };
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: fixture.watch === true,
        fixture,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  let sequence = 0;
  const pending = new Map(),
    events = [];
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  worker.on('message', (m) => {
    if (m.event) {
      events.push(m);
      if (m.event === 'ready') resolveReady();
    }
    const p = pending.get(m.request);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(m.request);
    if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code, stack: m.stack }));
    else p.resolve(m.result);
  });
  worker.on('error', (error) => {
    rejectReady(error);
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timed out: ' + method));
      }, 15000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  await ready;
  return {
    call,
    events,
    arm: () => worker.postMessage({ fixtureArm: true }),
    holdDecoder: (root) => worker.postMessage({ fixtureHoldDecoder: root }),
    release: () => worker.postMessage({ fixtureRelease: true }),
    async close() {
      try {
        await call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-offline-owned-'));
  const data = path.join(base, 'data'),
    root = path.join(base, 'removable'),
    online = path.join(base, 'online');
  await fs.mkdir(path.join(root, 'album'), { recursive: true });
  await fs.mkdir(online);
  await fs.writeFile(path.join(root, 'album', 'a.png'), png);
  await fs.writeFile(path.join(online, 'b.png'), png);
  // Deliberately keep tiny owned fixture evidence; no recursive cleanup touches user paths.
  t.diagnostic('owned fixture: ' + base);
  return {
    base,
    data,
    root,
    online,
    db: () => new DatabaseSync(path.join(data, 'library.sqlite'))
  };
}
const options = { timeout: 60000 };
test(
  'offline is latched, cached browse remains available, explicit retry and other root work',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    try {
      await c.call('scan', { path: f.root, offline: true });
      await c.call('scan', { path: f.online, offline: true });
      const oldId = idFor(f.root),
        child = idFor(path.join(f.root, 'album'));
      const offlineDb = f.db();
      offlineDb.prepare('INSERT INTO match_frontier(root,after_id) VALUES(?,?)').run(oldId, '');
      offlineDb
        .prepare('INSERT INTO match_pending(id,root,stamp) VALUES(?,?,?)')
        .run(child, oldId, 'offline-pending');
      offlineDb.close();
      await fs.rename(f.root, f.root + '-detached');
      const eventStart = c.events.length;
      const status = await c.call('rootStatus', { id: oldId, probe: true });
      assert.equal(status.root.status, 'offline');
      const onlineEvent = c.events.slice(eventStart).findLast((event) => event.event === 'online');
      assert.ok(
        onlineEvent,
        'offline transition publishes fresh online counts even without a pump'
      );
      assert.equal(onlineEvent.data.discovering, false);
      assert.equal(onlineEvent.data.remaining, 0);
      assert.equal(onlineEvent.data.buffered, 0);
      assert.equal(onlineEvent.data.active, false);
      for (const lightweight of [true, false]) {
        const init = await c.call('init', { lightweight });
        assert.equal(init.online.discovering, false);
        assert.equal(init.online.remaining, 0);
        assert.equal(init.online.active, false);
        assert.equal(init.taskSnapshot.busy, false);
      }
      const sync = await c.call('syncStatus');
      assert.equal(sync.discovering, false);
      assert.equal(sync.remaining, 0);
      assert.equal((await c.call('get', { id: child })).rootStatus.status, 'offline');
      const list = await c.call('list', { parent: child });
      assert.equal(list.items.length, 1);
      await assert.rejects(c.call('asset', { id: list.items[0].id }), { code: 'ROOT_OFFLINE' });
      assert.deepEqual(await c.call('thumb', { id: list.items[0].id, size: 1024 }), {
        placeholder: true,
        offline: true
      });
      const rejected = await c.call('retryRoot', { id: oldId });
      assert.equal(rejected.accepted, false);
      assert.equal(
        (await c.call('rootStatus', { id: idFor(f.online), probe: true })).root.status,
        'online'
      );
      await c.call('scan', { path: f.online, offline: true });
      await c.close();
      c = await client(f.data, { auditPath: f.root, watch: true });
      assert.equal((await c.call('rootStatus', { id: oldId })).root.status, 'offline');
      await fs.rename(f.root + '-detached', f.root);
      const reads = c.events.filter((e) => e.event === 'fixture-stat').length;
      assert.equal((await c.call('rootStatus', { id: oldId, probe: true })).root.status, 'offline');
      await assert.rejects(c.call('source', { id: list.items[0].id }), { code: 'ROOT_OFFLINE' });
      await assert.rejects(c.call('asset', { id: list.items[0].id }), { code: 'ROOT_OFFLINE' });
      await c.call('filesystemSync', { id: child, reason: 'test' });
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.equal(
        c.events.filter((e) => e.event === 'fixture-stat').length,
        reads,
        'known offline causes no automatic root reads'
      );
      assert.equal((await c.call('retryRoot', { id: oldId })).accepted, true);
      assert.equal((await c.call('rootStatus', { id: oldId })).root.status, 'online');
    } finally {
      await c.close();
    }
  }
);

test(
  'active scan timeout settles idle and stale offline cancel preserves another root queue',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.call('scan', { path: f.online, offline: true });
    await c.close();
    c = await client(f.data, { holdPath: f.root, armLater: true });
    try {
      await c.call('rootStatus', { id: idFor(f.root), probe: true });
      c.arm();
      const started = Date.now(),
        scan = c.call('scan', { path: f.root, offline: true });
      const result = await scan;
      assert.equal(result.offline, true);
      assert.ok(Date.now() - started < 5000);
      const state = await c.call('init');
      assert.equal(state.taskSnapshot.busy, false);
      assert.equal(
        (await c.call('get', { id: idFor(path.join(f.root, 'album', 'a.png')) })).missing,
        0
      );
      let db = f.db();
      db.prepare('INSERT INTO match_pending(id,root,stamp) VALUES(?,?,?)').run(
        idFor(f.online),
        idFor(f.online),
        'fixture-pending'
      );
      db.close();
      await c.call('cancel');
      db = f.db();
      assert.equal(
        db.prepare('SELECT stamp FROM match_pending WHERE root=?').get(idFor(f.online)).stamp,
        'fixture-pending'
      );
      db.prepare('DELETE FROM match_pending WHERE root=?').run(idFor(f.online));
      db.close();
      await c.call('scan', { path: f.online, offline: true });
      c.release();
    } finally {
      c.release();
      await c.close();
    }
  }
);

test(
  'relink maps IDs, manual state, root policy, scan frames and cached hints atomically',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.call('scan', { path: f.online, offline: true });
    await c.close();
    const oldId = idFor(f.root),
      childPath = path.join(f.root, 'album'),
      child = idFor(childPath),
      imagePath = path.join(childPath, 'a.png'),
      image = idFor(imagePath);
    let db = f.db();
    const imageRow = db.prepare('SELECT * FROM nodes WHERE id=?').get(image);
    db.prepare(
      'UPDATE nodes SET favorite=1,confirmed=1,manual_subject=1,subject_id=123 WHERE id=?'
    ).run(child);
    const hint = path.join(f.data, 'cached-fixture.webp');
    await fs.writeFile(hint, 'fixture cache');
    const key = thumbnailKey(imageRow, 1024);
    db.prepare('INSERT INTO thumbs(key,path,source,bytes,last_used) VALUES(?,?,?,?,?)').run(
      key,
      hint,
      imagePath,
      13,
      Date.now()
    );
    db.prepare(
      'INSERT INTO scan_jobs(id,root,path,target,options,started,state,phase,counters) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(
      'offline-fixture',
      oldId,
      f.root,
      childPath,
      '{}',
      Date.now(),
      'offline',
      'indexing',
      '{}'
    );
    db.prepare(
      'INSERT INTO scan_directories(job,id,parent,path,depth,phase,stamp) VALUES(?,?,?,?,?,?,?)'
    ).run('offline-fixture', child, oldId, childPath, 1, 'enumerate', Date.now());
    db.close();
    const dest = path.join(f.base, 'relinked');
    await fs.rename(f.root, dest);
    c = await client(f.data);
    try {
      await c.call('rootStatus', { id: oldId, probe: true });
      await assert.rejects(c.call('relinkRoot', { id: oldId, path: f.online }));
      assert.equal((await c.call('get', { id: child })).favorite, 1);
      const result = await c.call('relinkRoot', { id: oldId, path: dest });
      assert.equal(result.relinked, true);
      assert.equal(result.root, idFor(dest));
      assert.equal(result.count, 3);
      const renamedChild = await c.call('get', { id: idFor(path.join(dest, 'album')) });
      assert.equal(renamedChild.favorite, 1);
      assert.equal(renamedChild.confirmed, 1);
      assert.equal(renamedChild.subject_id, 123);
      assert.equal(await c.call('get', { id: child }), null);
      assert.equal((await c.call('get', { id: idFor(f.online) })).path, f.online);
      const cached = await c.call('thumb', {
        id: idFor(path.join(dest, 'album', 'a.png')),
        size: 1024
      });
      assert.equal(cached.path, hint);
      db = f.db();
      assert.equal(
        db.prepare('SELECT path FROM scan_jobs WHERE id=?').get('offline-fixture').path,
        dest
      );
      assert.equal(
        db.prepare('SELECT id FROM scan_directories WHERE job=?').get('offline-fixture').id,
        idFor(path.join(dest, 'album'))
      );
      assert.equal(
        db.prepare('SELECT source FROM thumbs WHERE path=?').get(hint).source,
        path.join(dest, 'album', 'a.png')
      );
      db.close();
      await assert.rejects(fs.lstat(f.root), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(path.join(dest, 'album', 'a.png')), png);
    } finally {
      await c.close();
    }
  }
);

test(
  'subfolder relink stays in root, preserves annotations and maps parent/depth',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await fs.mkdir(path.join(f.root, 'destination', 'nested'), { recursive: true });
    await c.call('scan', { path: f.root, offline: true });
    await c.close();
    const source = path.join(f.root, 'album'),
      dest = path.join(f.root, 'destination', 'nested', 'restored');
    let db = f.db();
    db.prepare('UPDATE nodes SET favorite=1,manual_cover=1,confirmed=1 WHERE id=?').run(
      idFor(source)
    );
    db.close();
    await fs.rename(source, dest);
    c = await client(f.data);
    try {
      await assert.rejects(c.call('relinkFolder', { id: idFor(source), path: f.online }));
      const result = await c.call('relinkFolder', { id: idFor(source), path: dest });
      assert.equal(result.root, idFor(f.root));
      assert.equal(result.relinked, true);
      const album = await c.call('get', { id: result.id });
      assert.equal(album.parent, idFor(path.dirname(dest)));
      assert.equal(album.depth, 3);
      assert.equal(album.favorite, 1);
      assert.equal(album.manual_cover, 1);
      assert.equal(album.confirmed, 1);
      const image = await c.call('get', { id: idFor(path.join(dest, 'a.png')) });
      assert.equal(image.depth, 4);
      assert.equal(image.root, idFor(f.root));
      assert.equal(image.parent, result.id);
      await assert.rejects(fs.lstat(source), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(path.join(dest, 'a.png')), png);
    } finally {
      await c.close();
    }
  }
);

test(
  'relink DB failure rolls back every node and annotation without moving files',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.close();
    let db = f.db();
    db.prepare('UPDATE nodes SET favorite=1 WHERE id=?').run(idFor(f.root));
    db.exec(
      "CREATE TRIGGER fixture_abort_relink BEFORE UPDATE OF id ON nodes WHEN NEW.id<>OLD.id BEGIN SELECT RAISE(ABORT,'fixture DB failure'); END"
    );
    db.close();
    const dest = path.join(f.base, 'restored');
    await fs.rename(f.root, dest);
    c = await client(f.data);
    try {
      await c.call('rootStatus', { id: idFor(f.root), probe: true });
      await assert.rejects(
        c.call('relinkRoot', { id: idFor(f.root), path: dest }),
        /fixture DB failure/
      );
      assert.equal((await c.call('get', { id: idFor(f.root) })).favorite, 1);
      assert.equal(await c.call('get', { id: idFor(dest) }), null);
      assert.equal((await c.call('rootStatus', { id: idFor(f.root) })).root.status, 'offline');
      assert.deepEqual(await fs.readFile(path.join(dest, 'album', 'a.png')), png);
      await assert.rejects(fs.lstat(f.root), { code: 'ENOENT' });
    } finally {
      await c.close();
    }
  }
);

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(predicate(), 'fixture condition reached within deadline');
}

test(
  'blocked journal does not reserve imports and resumes only on explicit retry',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.close();
    let db = f.db();
    db.prepare('INSERT INTO scan_jobs VALUES(?,?,?,?,?,?,?,?,?,?)').run(
      'fixture-blocked',
      idFor(f.root),
      f.root,
      '',
      '{"offline":true}',
      Date.now(),
      'blocked',
      'scan',
      '{}',
      'fixture permission denied'
    );
    db.close();
    c = await client(f.data);
    try {
      let state = await c.call('init', { lightweight: true });
      assert.equal(state.taskSnapshot.busy, false);
      assert.equal(state.taskSnapshot.blockedScans[0].state, 'blocked');
      assert.ok((await c.call('get', { id: idFor(f.root) })).id);
      await c.call('scan', { path: f.online, offline: true });
      db = f.db();
      assert.equal(
        db.prepare('SELECT state FROM scan_jobs WHERE id=?').get('fixture-blocked').state,
        'blocked'
      );
      db.close();
      assert.equal((await c.call('retryRoot', { id: idFor(f.root) })).accepted, true);
      await c.call('scan', { path: f.online, offline: true });
      db = f.db();
      assert.equal(
        db.prepare('SELECT id FROM scan_jobs WHERE id=?').get('fixture-blocked'),
        undefined
      );
      db.close();
    } finally {
      await c.close();
    }
  }
);

test(
  'four disconnected decodes release slots; relink ignores another root lease and late writes',
  options,
  async (t) => {
    const f = await fixture(t);
    for (const name of ['b.png', 'c.png', 'd.png'])
      await fs.writeFile(path.join(f.root, 'album', name), png);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.call('scan', { path: f.online, offline: true });
    await c.close();
    c = await client(f.data, { decoder: true, holdDecodeRoot: f.root });
    try {
      const requests = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) =>
        c.call('thumb', { id: idFor(path.join(f.root, 'album', name)), size: 512 })
      );
      await until(() => c.events.filter((e) => e.event === 'fixture-decode').length === 4);
      const destination = f.root + '-restored';
      await fs.rename(f.root, destination);
      assert.equal(
        (await c.call('rootStatus', { id: idFor(f.root), probe: true })).root.status,
        'offline'
      );
      for (const result of await Promise.all(requests)) assert.equal(result.placeholder, true);
      const onlineId = idFor(path.join(f.online, 'b.png'));
      assert.ok(
        (await c.call('thumb', { id: onlineId, size: 512 })).path,
        'online root receives released slot'
      );
      c.holdDecoder(f.online);
      const other = c.call('thumb', { id: onlineId, size: 768 });
      await until(() => c.events.filter((e) => e.event === 'fixture-decode').length === 6);
      const started = Date.now();
      const result = await c.call('relinkRoot', { id: idFor(f.root), path: destination });
      assert.equal(result.relinked, true);
      assert.ok(Date.now() - started < 3000, 'other root lease does not delay relink');
      c.release();
      assert.ok((await other).path);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const db = f.db();
      assert.equal(
        db.prepare('SELECT count(*) total FROM thumbs WHERE source LIKE ?').get(f.root + '%').total,
        0
      );
      db.close();
    } finally {
      c.release();
      await c.close();
    }
  }
);

test(
  'relink reserves before its first probe and excludes a concurrent scan',
  options,
  async (t) => {
    const f = await fixture(t);
    let c = await client(f.data);
    await c.call('scan', { path: f.root, offline: true });
    await c.close();
    const source = path.join(f.root, 'album'),
      destination = path.join(f.root, 'restored');
    await fs.rename(source, destination);
    c = await client(f.data, { holdPath: f.root, armLater: true });
    try {
      await c.call('retryRoot', { id: idFor(f.root) });
      c.arm();
      const relink = c.call('relinkFolder', { id: idFor(source), path: destination });
      await until(() => c.events.some((e) => e.event === 'fixture-held'));
      await assert.rejects(c.call('scan', { path: f.online, offline: true }), /改名|重命名/);
      c.release();
      assert.equal((await relink).relinked, true);
      assert.equal((await c.call('init', { lightweight: true })).taskSnapshot.busy, false);
    } finally {
      c.release();
      await c.close();
    }
  }
);

test('bounded probe cannot publish a late old-path result after relink', options, async (t) => {
  const f = await fixture(t);
  let c = await client(f.data);
  await c.call('scan', { path: f.root, offline: true });
  await c.close();
  c = await client(f.data, { holdPath: f.root });
  try {
    const start = Date.now();
    const result = await c.call('rootStatus', { id: idFor(f.root), probe: true });
    assert.equal(result.root.status, 'offline');
    assert.equal(result.root.code, 'ROOT_TIMEOUT');
    assert.ok(Date.now() - start < 4500);
    const dest = path.join(f.base, 'new-root');
    await fs.rename(f.root, dest);
    const moved = await c.call('relinkRoot', { id: idFor(f.root), path: dest });
    assert.equal(moved.rootStatus.status, 'online');
    c.release();
    assert.equal((await c.call('rootStatus', { id: moved.id })).root.path, dest);
    assert.equal((await c.call('rootStatus', { id: moved.id })).root.status, 'online');
  } finally {
    c.release();
    await c.close();
  }
});
