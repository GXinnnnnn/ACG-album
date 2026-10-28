'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { createHash } = require('node:crypto');
const { createRootRemoval } = require('../src/root-removal.cjs');
const { client } = require('../scripts/check-startup-performance.cjs');
const { idFor } = require('../src/model.cjs');
const { sortKey } = require('../src/natural-sort.cjs');
const { createMedia } = require('../src/media.cjs');
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-root-removal-'));
  const f = {
    directory,
    source: path.join(directory, 'source'),
    data: path.join(directory, 'data'),
    active: null,
    db: null
  };
  await fs.mkdir(f.source);
  t.after(async () => {
    await f.active?.close();
    f.db?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('acg-root-removal-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  f.active = await client(f.data, { suppressMedia: true });
  await f.active.close();
  f.active = null;
  return f;
}
function open(f) {
  return new DatabaseSync(path.join(f.data, 'library.sqlite'));
}
function seed(db, source, count) {
  const root = idFor(source),
    insert = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed,favorite) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
  db.exec('BEGIN');
  try {
    insert.run(
      root,
      root,
      null,
      source,
      path.basename(source),
      sortKey(path.basename(source)),
      'folder',
      0,
      0,
      1,
      1,
      1,
      0
    );
    for (let i = 0; i < count; i++) {
      const p = path.join(source, `item-${i}.jpg`),
        id = idFor(p);
      insert.run(
        id,
        root,
        root,
        p,
        path.basename(p),
        sortKey(path.basename(p)),
        'image',
        1,
        10,
        1700000000000,
        1,
        1,
        1
      );
      db.prepare(
        "INSERT INTO media(id,revision,taken,status) VALUES(?,'1700000000000.0-10',1700000000000,'pending')"
      ).run(id);
      db.prepare('INSERT INTO match_pending VALUES(?,?,?)').run(id, root, 'old-queue');
    }
    db.prepare(
      'INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE root=?'
    ).run(root);
    db.prepare("INSERT INTO match_frontier VALUES(?,'')").run(root);
    db.prepare(
      "INSERT INTO root_match_policy(root,enabled,types,revision) VALUES(?,1,'[4]',1)"
    ).run(root);
    // Keep the persisted pending queue paused: this isolates deletion latency
    // from startup's independent validation of intentionally stale fixture jobs.
    db.prepare("UPDATE match_resume SET reason='access',scope=? WHERE singleton=1").run(
      createHash('sha256').update('ACGAlbum Bangumi cache v1\0').digest('hex')
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return root;
}
const count = (db, table) => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

test(
  '5000-row removal hides immediately, drains bounded indexed batches, and resumes after an interrupted shutdown',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.db = open(f);
    const root = seed(f.db, f.source, 5000);
    const oldMedia = createMedia({
      db: f.db,
      home: f.data,
      getNode: (id) => f.db.prepare('SELECT * FROM nodes WHERE id=?').get(id)
    });
    const oldStarted = performance.now();
    // Reproduce the previous synchronous SQL path, including pending deletion
    // and full-library media.seed; no network, decoder or source writes.
    f.db.prepare('DELETE FROM match_frontier WHERE root=?').run(root);
    f.db.prepare('DELETE FROM match_pending WHERE root=?').run(root);
    f.db.exec('BEGIN');
    f.db
      .prepare('DELETE FROM search_index WHERE id IN (SELECT id FROM nodes WHERE root=?)')
      .run(root);
    f.db.prepare('DELETE FROM nodes WHERE root=?').run(root);
    f.db.prepare('DELETE FROM root_match_policy WHERE root=?').run(root);
    f.db.exec('COMMIT');
    oldMedia.seed();
    const oldSynchronousMs = performance.now() - oldStarted;
    f.db.exec('DELETE FROM media');
    seed(f.db, f.source, 5000);
    let release, entered;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const service = createRootRemoval(f.db, {
      yieldNow: async () => {
        entered();
        await gate;
      }
    });
    const plan = f.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT rowid,id FROM nodes WHERE root=? ORDER BY rowid LIMIT 128'
      )
      .all(root);
    assert.ok(plan.some((row) => row.detail.includes('nodes_root')));
    assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
    const before = performance.now();
    service.enqueue(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(root));
    const ackMs = performance.now() - before;
    assert.ok(ackMs < 500, 'logical removal must not synchronously delete the 5000 rows');
    assert.equal(service.isHidden(root), true);
    assert.equal(count(f.db, 'nodes'), 5001, 'enqueue only commits the tombstone');
    assert.equal(
      f.db.prepare(`SELECT COUNT(*) n FROM nodes n WHERE ${service.visibleSql('n')}`).get().n,
      0
    );
    assert.equal(count(f.db, 'match_frontier'), 0);
    assert.equal(count(f.db, 'root_match_policy'), 0);
    assert.equal(count(f.db, 'match_pending'), 5000, 'large queue deletion is deferred');
    await paused;
    assert.equal(f.db.isTransaction, false);
    assert.equal(count(f.db, 'nodes'), 5001 - 128);
    const stopping = service.stop();
    release();
    await stopping;
    assert.equal(count(f.db, 'root_removals'), 1);
    f.db.close();
    f.db = open(f);
    let checkpoints = 0,
      yields = 0,
      last = count(f.db, 'nodes'),
      maxBatch = 0;
    const resumed = createRootRemoval(f.db, {
      checkpoint: async () => {
        checkpoints++;
      },
      yieldNow: async () => {
        const current = count(f.db, 'nodes');
        maxBatch = Math.max(maxBatch, last - current);
        last = current;
        yields++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    });
    const readTimes = [];
    const reader = setInterval(() => {
      const start = performance.now();
      f.db.prepare('SELECT id FROM nodes WHERE id=?').get(root);
      readTimes.push(performance.now() - start);
    }, 1);
    const cleanupStart = performance.now();
    try {
      await resumed.wait(root);
    } finally {
      clearInterval(reader);
      await resumed.stop();
    }
    const cleanupMs = performance.now() - cleanupStart;
    assert.ok(maxBatch <= 128);
    assert.ok(yields >= Math.ceil((5001 - 128) / 128));
    assert.ok(checkpoints > 0);
    for (const table of [
      'nodes',
      'search_index',
      'media',
      'match_pending',
      'match_frontier',
      'root_match_policy',
      'root_removals'
    ])
      assert.equal(count(f.db, table), 0, table);
    assert.equal(resumed.isHidden(root), false);
    assert.equal(f.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    t.diagnostic(
      JSON.stringify({
        rows: 5001,
        oldSynchronousMs: +oldSynchronousMs.toFixed(3),
        ackMs: +ackMs.toFixed(3),
        resumedCleanupMs: +cleanupMs.toFixed(3),
        maxBatch,
        yields,
        checkpoints,
        readSamples: readTimes.length,
        readMaxMs: +Math.max(0, ...readTimes).toFixed(3)
      })
    );
  }
);

test('a failed batch rolls back all dependent deletes and retains the durable hidden root', async (t) => {
  const f = await fixture(t);
  f.db = open(f);
  const root = seed(f.db, f.source, 20);
  f.db.exec(
    "CREATE TRIGGER fail_removal BEFORE DELETE ON nodes BEGIN SELECT RAISE(ABORT,'forced deletion failure'); END"
  );
  let failure;
  const service = createRootRemoval(f.db, {
    error: (error) => {
      failure = error;
    }
  });
  service.enqueue(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(root));
  await assert.rejects(service.wait(root), /forced deletion failure/);
  assert.ok(failure);
  assert.equal(service.isHidden(root), true);
  assert.equal(count(f.db, 'nodes'), 21);
  assert.equal(count(f.db, 'search_index'), 21);
  assert.equal(count(f.db, 'media'), 20);
  assert.equal(count(f.db, 'match_pending'), 20);
  assert.equal(f.db.isTransaction, false);
  await service.stop();
  f.db.exec('DROP TRIGGER fail_removal');
  const resumed = createRootRemoval(f.db);
  await resumed.wait(root);
  await resumed.stop();
  assert.equal(count(f.db, 'nodes'), 0);
});

test(
  'worker removal immediately hides all read surfaces, and same-path reimport waits for old cleanup without deleting new rows or source files',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t);
    const file = path.join(f.source, 'actual.jpg');
    await fs.writeFile(file, 'source bytes remain unchanged');
    f.db = open(f);
    const root = seed(f.db, f.source, 5000);
    f.db.close();
    f.db = null;
    const image = idFor(path.join(f.source, 'item-4999.jpg'));
    f.active = await client(f.data, { profile: true, suppressMedia: true });
    await f.active.snapshot(true);
    const started = performance.now();
    assert.equal(await f.active.call('removeRoot', { id: root }), true);
    const ackMs = performance.now() - started;
    assert.ok(ackMs < 1000);
    assert.equal(await f.active.call('get', { id: root }), null);
    assert.equal(await f.active.call('get', { id: image }), null);
    assert.deepEqual(await f.active.call('ancestors', { id: image }), []);
    for (const args of [
      {},
      { filter: 'images' },
      { timeline: true },
      { search: 'item' },
      { favorites: true },
      { parent: root },
      { filter: 'pending' }
    ])
      assert.equal((await f.active.call('list', args)).total, 0, JSON.stringify(args));
    const init = await f.active.call('init');
    assert.deepEqual(init.roots, []);
    assert.equal(init.stats.total, 0);
    assert.equal(init.online.pending, 0);
    assert.equal(
      (await f.active.call('mediaStats')).rows.reduce((sum, row) => sum + row.count, 0),
      0
    );
    for (const method of ['source', 'asset', 'mediaInfo'])
      await assert.rejects(f.active.call(method, { id: image }));
    const scans = await f.active.call('scan', { path: f.source, offline: true });
    assert.equal(scans.cancelled, false);
    const after = await f.active.call('init');
    assert.equal(after.roots.length, 1);
    assert.equal(after.stats.images, 1);
    const fresh = await f.active.call('get', { id: idFor(file) });
    assert.ok(fresh);
    assert.equal(fresh.favorite, 0);
    const sql = await f.active.snapshot();
    assert.ok(
      !sql.some(
        (row) =>
          row.sql.includes('DELETE FROM nodes WHERE root=') ||
          row.sql.includes('DELETE FROM search_index WHERE id IN') ||
          row.sql.startsWith('run INSERT INTO media(id,revision,taken,date_source,status) SELECT')
      )
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(await f.active.call('get', { id: idFor(file) }));
    assert.equal(await fs.readFile(file, 'utf8'), 'source bytes remain unchanged');
    await f.active.close();
    f.active = await client(f.data, { suppressMedia: true });
    assert.equal((await f.active.call('init')).roots.length, 1);
    assert.ok(await f.active.call('get', { id: idFor(file) }));
    t.diagnostic(
      JSON.stringify({
        rows: 5001,
        removeRpcMs: +ackMs.toFixed(3),
        readSurfacesHidden: true,
        reimportedImages: 1
      })
    );
  }
);

test(
  'shutdown preserves unfinished cleanup and startup resumes it without exposing removed rows',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    f.db = open(f);
    const root = seed(f.db, f.source, 5000);
    f.db.close();
    f.db = null;
    f.active = await client(f.data, { suppressMedia: true });
    await f.active.call('removeRoot', { id: root });
    await f.active.close();
    f.active = null;
    f.db = open(f);
    const remaining = count(f.db, 'nodes');
    assert.ok(remaining > 0, 'shutdown should persist rather than drain every old row');
    assert.equal(count(f.db, 'root_removals'), 1);
    f.db.close();
    f.db = null;
    f.active = await client(f.data, { suppressMedia: true });
    assert.deepEqual((await f.active.call('init')).roots, []);
    // scan is the public wait barrier and must not conflict with the restarted cleanup.
    const scanned = await f.active.call('scan', { path: f.source, offline: true });
    assert.equal(scanned.cancelled, false);
    assert.equal((await f.active.call('init')).stats.images, 0);
  }
);

test('cancelled cleanup wait releases the scanner promptly while background deletion remains resumable', async (t) => {
  const f = await fixture(t);
  f.db = open(f);
  const root = seed(f.db, f.source, 200);
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const service = createRootRemoval(f.db, {
    yieldNow: async () => {
      entered();
      await gate;
    }
  });
  service.enqueue(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(root));
  await paused;
  assert.deepEqual(
    service.blockers(path.join(f.source, 'child')).map((row) => row.root),
    [root]
  );
  assert.deepEqual(
    service.blockers(f.directory).map((row) => row.root),
    [root]
  );
  assert.deepEqual(service.blockers(path.join(f.directory, 'different')), []);
  const controller = new AbortController(),
    waiting = service.wait(root, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(service.isHidden(root), true);
  const stopping = service.stop();
  release();
  await stopping;
  assert.equal(count(f.db, 'root_removals'), 1);
});

test(
  'a root enqueued during the previous final checkpoint is not stranded',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    f.db = open(f);
    const first = seed(f.db, f.source, 1),
      secondPath = path.join(f.directory, 'second');
    const second = seed(f.db, secondPath, 1);
    let entered,
      release,
      checkpoints = 0;
    const paused = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const service = createRootRemoval(f.db, {
      checkpoint: async () => {
        if (++checkpoints === 1) {
          entered();
          await gate;
        }
      }
    });
    service.enqueue(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(first));
    await paused;
    service.enqueue(f.db.prepare('SELECT * FROM nodes WHERE id=?').get(second));
    const finished = service.wait(second);
    release();
    await finished;
    await service.stop();
    assert.equal(count(f.db, 'nodes'), 0);
    assert.equal(count(f.db, 'root_removals'), 0);
  }
);

test('a decoder paused in stat cannot recreate old media or overwrite a reimported row', async (t) => {
  const f = await fixture(t),
    file = path.join(f.source, 'race.jpg');
  await fs.writeFile(file, 'fake jpeg');
  f.db = open(f);
  const root = seed(f.db, f.source, 0),
    id = idFor(file);
  f.db
    .prepare(
      'INSERT INTO nodes(id,root,parent,path,name,kind,indexed,mtime,bytes) VALUES(?,?,?,?,?,?,?,?,?)'
    )
    .run(id, root, root, file, 'race.jpg', 'image', 1, 1, 1);
  const original = fs.stat;
  let release, entered;
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  // media.cjs uses the same fs.promises object; restore before cleanup and all other tests.
  fs.stat = async (...args) => {
    if (args[0] === file) {
      entered();
      await gate;
    }
    return original(...args);
  };
  let visible = true;
  const getNode = (key) =>
    visible ? f.db.prepare('SELECT * FROM nodes WHERE id=?').get(key) : null;
  const media = createMedia({ db: f.db, home: f.data, getNode });
  try {
    const details = media.ensure(id);
    await paused;
    visible = false;
    f.db.prepare('DELETE FROM media WHERE id=?').run(id);
    // A fast replacement has the same stable path/id, but a newer scan stamp.
    f.db.prepare('UPDATE nodes SET indexed=2 WHERE id=?').run(id);
    f.db
      .prepare(
        "INSERT INTO media(id,revision,status,width,place,place_user) VALUES(?,'new','ready',777,'new manual place',1)"
      )
      .run(id);
    visible = true;
    release();
    await details;
    const replacement = f.db.prepare('SELECT * FROM media WHERE id=?').get(id);
    assert.equal(replacement.revision, 'new');
    assert.equal(replacement.status, 'ready');
    assert.equal(replacement.width, 777);
    assert.equal(replacement.place, 'new manual place');
  } finally {
    fs.stat = original;
    release();
    await media.stop();
  }
});
