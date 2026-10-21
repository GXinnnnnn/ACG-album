'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');

async function client(dataDir) {
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  const pending = new Map(),
    listeners = new Set();
  let request = 0;
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event) for (const fn of listeners) fn(m);
      const waiting = pending.get(m.request);
      if (waiting) {
        pending.delete(m.request);
        clearTimeout(waiting.timer);
        if (m.error) waiting.reject(new Error(m.error + '\n' + m.stack));
        else waiting.resolve(m.result);
      }
    });
  });
  return {
    listeners,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const number = ++request;
        const timer = setTimeout(
          () => reject(new Error('Timed out: ' + method)),
          method === 'scan' ? 240000 : 15000
        );
        pending.set(number, { resolve, reject, timer });
        worker.postMessage({ request: number, method, args });
      });
    },
    async close() {
      for (const job of pending.values()) clearTimeout(job.timer);
      await worker.terminate();
    }
  };
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-indexing-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(source);
  return { tmp, source, data };
}
async function cleanup(f) {
  const resolved = path.resolve(f.tmp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('acg-indexing-'));
  await fs.rm(resolved, { recursive: true, force: true });
}

// Real directory entries exercise opendir/lstat as well as all SQL/FTS paths.
// Empty JPGs keep fixture storage tiny; metadata decoding is deliberately not
// part of this scanner benchmark. Byte-scale behavior is checked with SQL below.
test(
  '100k-file import stays readable, searchable and cancellable; pruning is bounded',
  { timeout: 420000 },
  async (t) => {
    const f = await fixture();
    const bulk = path.join(f.source, 'bulk');
    await fs.mkdir(bulk);
    const count = 100000;
    for (let i = 0; i < count; i += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, count - i) }, (_, j) =>
          fs.writeFile(path.join(bulk, `image-${String(i + j).padStart(6, '0')}.jpg`), '')
        )
      );
    }
    let c = await client(f.data);
    try {
      await c.call('settings', { key: 'autoMatch', value: false });
      const root = idFor(f.source),
        parent = idFor(bulk);
      const progress = [],
        changed = [],
        samples = [],
        latencies = [];
      const timedCall = async (method, args) => {
        const at = performance.now();
        const result = await c.call(method, args);
        latencies.push(performance.now() - at);
        return result;
      };
      let finished = false,
        busy = false,
        sampleJob = Promise.resolve();
      let duringSearch = false,
        duringAsset = false;
      c.listeners.add((m) => {
        if (m.event === 'progress') progress.push({ at: performance.now(), ...m.data });
        if (m.event === 'changed' && m.data.root === root) changed.push(m.data);
      });
      const started = performance.now();
      const timer = setInterval(() => {
        if (busy || finished) return;
        busy = true;
        sampleJob = (async () => {
          const at = performance.now();
          const page = await timedCall('list', { parent, limit: 24 });
          await timedCall('get', { id: root });
          if (page.items.length) {
            const item = page.items[0];
            const found = await timedCall('list', { search: item.name, limit: 1 });
            assert.equal(found.items[0]?.id, item.id);
            assert.equal((await timedCall('asset', { id: item.id })).path, item.path);
            duringSearch ||= !finished;
            duringAsset ||= !finished;
          }
          samples.push(performance.now() - at);
        })().finally(() => {
          busy = false;
        });
      }, 40);
      let result;
      try {
        result = await c.call('scan', { path: f.source, offline: true });
      } finally {
        finished = true;
        clearInterval(timer);
        await sampleJob;
      }
      const duration = performance.now() - started;
      assert.equal(result.cancelled, false);
      assert.equal(result.errors, 0);
      assert.ok(duringSearch && duringAsset, 'committed items usable before scan completion');
      assert.ok(samples.length >= 5);
      const sorted = samples.toSorted((a, b) => a - b);
      const p95 = sorted[Math.floor((sorted.length - 1) * 0.95)];
      const rpc = latencies.toSorted((a, b) => a - b);
      const rpcP95 = rpc[Math.floor((rpc.length - 1) * 0.95)];
      const active = progress.filter((p) => p.active);
      t.diagnostic(
        JSON.stringify({
          files: count,
          importMs: Math.round(duration),
          samples: samples.length,
          sequenceP95Ms: +p95.toFixed(1),
          sequenceMaxMs: +sorted.at(-1).toFixed(1),
          rpcSamples: rpc.length,
          rpcP95Ms: +rpcP95.toFixed(1),
          rpcMaxMs: +rpc.at(-1).toFixed(1),
          progressEvents: active.length,
          progressHeartbeatMaxMs: +Math.max(
            ...active.slice(1).map((p, i) => p.at - active[i].at)
          ).toFixed(1)
        })
      );
      assert.ok(active.some((p) => p.images > 0 && p.images < count));
      assert.ok(changed.length >= 3);
      assert.ok(changed.every((p, i) => i === 0 || p.revision >= changed[i - 1].revision));
      for (let i = 1; i < active.length; i++)
        assert.ok(active[i].at - active[i - 1].at < 2000, 'bounded progress heartbeat');
      assert.equal((await c.call('get', { id: root })).files, count);
      assert.equal((await c.call('list', { parent, offset: 99976, limit: 24 })).items.length, 24);
      assert.equal((await c.call('list', { search: 'image-099999' })).total, 1);

      await c.close();
      const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
      assert.equal(db.prepare('SELECT COUNT(*) total FROM search_index').get().total, count + 2);
      assert.equal(db.prepare('SELECT COUNT(*) total FROM media').get().total, count);
      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id,sortkey AS page_order FROM nodes
        WHERE parent=? AND missing=0 AND kind='image'
        UNION ALL SELECT id,sortkey AS page_order FROM nodes
        WHERE parent=? AND missing=0 AND kind='video' ORDER BY page_order,id LIMIT 24`
        )
        .all(parent, parent);
      assert.ok(plan.some((p) => p.detail.includes('MERGE')));
      assert.ok(plan.every((p) => !p.detail.includes('TEMP B-TREE')));
      t.diagnostic('parent media page plan: ' + plan.map((p) => p.detail).join('; '));
      // Keep startup decoding irrelevant to cancellation/pruning checks.
      db.prepare("UPDATE media SET status='ready'").run();
      db.prepare(
        `UPDATE nodes SET favorite=1,crop_x=23,crop_y=72,crop_zoom=2,
        subject_id=42,manual_subject=1,intro=1,manual_cover=1,confirmed=1,album_kind='work' WHERE id=?`
      ).run(parent);
      db.close();
      c = await client(f.data);
      const warmAt = performance.now();
      const warm = await c.call('scan', { path: f.source, offline: true });
      const warmMs = performance.now() - warmAt;
      assert.equal(warm.cancelled, false);
      assert.equal(warm.errors, 0);
      assert.equal((await c.call('get', { id: root })).files, count);
      const incremental = path.join(f.source, 'incremental-fixture');
      await fs.mkdir(incremental);
      const added = path.join(incremental, 'fresh-sample.jpg');
      await fs.writeFile(added, '');
      const incrementalAt = performance.now();
      const incrementalResult = await c.call('scan', {
        path: f.source,
        target: incremental,
        offline: true
      });
      const incrementalMs = performance.now() - incrementalAt;
      assert.equal(incrementalResult.errors, 0);
      assert.equal((await c.call('get', { id: root })).files, count + 1);
      assert.equal((await c.call('list', { parent: idFor(incremental), limit: 1 })).total, 1);
      t.diagnostic(
        JSON.stringify({
          files: count,
          unchangedScanMs: Math.round(warmMs),
          incrementalAddedFiles: 1,
          incrementalScanMs: Math.round(incrementalMs)
        })
      );
      assert.equal(path.dirname(path.resolve(added)), path.resolve(incremental));
      await fs.unlink(added);
      await c.call('scan', { path: f.source, target: incremental, offline: true });
      assert.equal((await c.call('get', { id: root })).files, count);
      let cancelled = false;
      c.listeners.add((m) => {
        if (!cancelled && m.event === 'progress' && m.data.active && m.data.images >= 128) {
          cancelled = true;
          void c.call('cancel');
        }
      });
      const cancelStart = performance.now();
      const stopped = await c.call('scan', { path: f.source, offline: true });
      assert.equal(stopped.cancelled, true);
      assert.ok(performance.now() - cancelStart < 3000);
      const saved = await c.call('get', { id: parent });
      assert.equal(saved.favorite, 1);
      assert.equal(saved.crop_x, 23);
      assert.equal(saved.crop_y, 72);
      assert.equal(saved.crop_zoom, 2);
      assert.equal(saved.subject_id, 42);
      assert.equal(saved.manual_subject, 1);
      assert.equal(saved.intro, 1);
      assert.equal(saved.manual_cover, 1);
      assert.equal(saved.confirmed, 1);
      assert.equal(saved.album_kind, 'work');
      assert.equal(
        (await c.call('list', { parent, limit: 1 })).total,
        count,
        'an incompletely enumerated directory is not pruned'
      );
      assert.equal((await c.call('get', { id: root })).files, count);

      // Renaming our fixture subtree is O(1) and makes all 100k indexed entries
      // stale without deleting source files. The scanner must drain its SQL
      // frontier in pages while normal read requests continue to respond.
      const moved = path.join(f.tmp, 'moved-fixture');
      assert.equal(path.dirname(path.resolve(moved)), path.resolve(f.tmp));
      await fs.rename(bulk, moved);
      const pruneSamples = [];
      let pruneDone = false;
      const samplePrune = (async () => {
        while (!pruneDone) {
          const at = performance.now();
          await c.call('get', { id: root });
          pruneSamples.push(performance.now() - at);
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      })();
      const pruneStart = performance.now();
      try {
        const removed = await c.call('scan', { path: f.source, offline: true });
        assert.equal(removed.cancelled, false);
      } finally {
        pruneDone = true;
        await samplePrune;
      }
      assert.equal((await c.call('get', { id: root })).files, 0);
      assert.equal((await c.call('list', { search: 'image-' })).total, 0);
      assert.equal((await fs.stat(path.join(moved, 'image-000000.jpg'))).size, 0);
      t.diagnostic(
        JSON.stringify({
          pruneMs: Math.round(performance.now() - pruneStart),
          pruneSamples: pruneSamples.length,
          pruneMaxMs: +Math.max(...pruneSamples).toFixed(1)
        })
      );
      // Report both measured phases before enforcing the unchanged latency budgets.
      assert.ok(p95 < 750, `request sequence p95 ${p95.toFixed(1)}ms`);
      assert.ok(rpcP95 < 500, `individual request p95 ${rpcP95.toFixed(1)}ms`);
      assert.ok(rpc.at(-1) < 1500, `individual request max ${rpc.at(-1).toFixed(1)}ms`);
      assert.ok(Math.max(...pruneSamples) < 2000);
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test('300GiB byte accounting and metadata revisions preserve explicit annotations', async () => {
  const f = await fixture();
  const c = await client(f.data);
  await c.close();
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const indexing = require('../src/indexing.cjs').createIndexing(db);
    const root = idFor(f.source);
    const stamp = 1700000000000.25;
    const stat = { size: 150 * 1024 ** 3, mtimeMs: stamp, birthtimeMs: stamp - 1000 };
    const nodes = ['one.jpg', 'two.jpg'].map((name) => ({
      id: idFor(path.join(f.source, name)),
      root,
      parent: root,
      path: path.join(f.source, name),
      name,
      sortkey: name,
      kind: 'image',
      depth: 1
    }));
    indexing.upsert(
      {
        id: root,
        root,
        parent: null,
        path: f.source,
        name: 'source',
        sortkey: 'source',
        kind: 'folder',
        depth: 0
      },
      { ...stat, size: 0 },
      stamp
    );
    for (const n of nodes) indexing.upsert(n, stat, stamp);
    await indexing.totals(root, async () => {});
    const totals = db.prepare('SELECT files,total_bytes FROM nodes WHERE id=?').get(root);
    assert.equal(totals.files, 2);
    assert.equal(totals.total_bytes, 300 * 1024 ** 3);
    assert.equal(db.prepare('SELECT SUM(bytes) total FROM nodes').get().total, 300 * 1024 ** 3);
    const n = nodes[0];
    db.prepare(
      'UPDATE nodes SET favorite=1,crop_zoom=2,subject_id=42,manual_subject=1 WHERE id=?'
    ).run(n.id);
    db.prepare(
      `UPDATE media SET status='ready',width=100,place='local',place_user=1,
      latitude=12,longitude=34,coords_user=1 WHERE id=?`
    ).run(n.id);
    indexing.upsert(n, { ...stat, mtimeMs: stamp + 100 }, stamp + 100);
    const saved = db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);
    assert.equal(saved.favorite, 1);
    assert.equal(saved.crop_zoom, 2);
    assert.equal(saved.subject_id, 42);
    assert.equal(saved.manual_subject, 1);
    const media = db.prepare('SELECT * FROM media WHERE id=?').get(n.id);
    assert.equal(media.status, 'pending');
    assert.equal(media.width, null);
    assert.equal(media.place, 'local');
    assert.equal(media.latitude, 12);
    assert.equal(media.longitude, 34);
    assert.equal(
      media.revision,
      db
        .prepare("SELECT CAST(? AS TEXT)||'-'||CAST(CAST(? AS INTEGER) AS TEXT) value")
        .get(stamp + 100, stat.size).value
    );
    assert.equal(db.prepare('SELECT COUNT(*) total FROM search_index').get().total, 3);
  } finally {
    db.close();
    await cleanup(f);
  }
});

test('prune starts from the bounded frontier', { timeout: 30000 }, async (t) => {
  const f = await fixture();
  const c = await client(f.data);
  await c.close();
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const indexing = require('../src/indexing.cjs').createIndexing(db);
    const root = idFor(f.source),
      albumPath = path.join(f.source, 'bulk'),
      album = idFor(albumPath);
    const stamp = 1700000000000;
    const stat = { size: 0, mtimeMs: stamp, birthtimeMs: stamp };
    indexing.upsert(
      {
        id: root,
        root,
        parent: null,
        path: f.source,
        name: 'source',
        sortkey: 'source',
        kind: 'folder',
        depth: 0
      },
      stat,
      stamp
    );
    indexing.upsert(
      {
        id: album,
        root,
        parent: root,
        path: albumPath,
        name: 'bulk',
        sortkey: 'bulk',
        kind: 'folder',
        depth: 1
      },
      stat,
      stamp
    );
    const count = 4096;
    const seeded = performance.now();
    for (let first = 0; first < count; first += 128) {
      t.signal.throwIfAborted();
      db.exec('BEGIN');
      for (let i = first; i < Math.min(first + 128, count); i++) {
        const name = `image-${String(i).padStart(6, '0')}.jpg`,
          p = path.join(albumPath, name);
        indexing.upsert(
          {
            id: idFor(p),
            root,
            parent: album,
            path: p,
            name,
            sortkey: name,
            kind: 'image',
            depth: 2
          },
          { ...stat, size: 1024 },
          stamp
        );
      }
      db.exec('COMMIT');
      await new Promise((resolve) => setImmediate(resolve));
    }
    const seedMs = performance.now() - seeded;
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT p.id,n.rowid FROM scan_prune p
      CROSS JOIN nodes n ON n.id=p.id LIMIT 128`
      )
      .all();
    assert.ok(plan[0].detail.startsWith('SCAN p'));
    assert.ok(plan[1].detail.startsWith('SEARCH n'));
    const read = db.prepare('SELECT id FROM nodes WHERE id=?');
    const reads = [];
    const pruneStarted = performance.now();
    await indexing.prune(root, stamp + 1, async () => {
      t.signal.throwIfAborted();
      const at = performance.now();
      assert.equal(read.get(root).id, root);
      reads.push(performance.now() - at);
      await new Promise((resolve) => setImmediate(resolve));
    });
    const pruneMs = performance.now() - pruneStarted;
    t.diagnostic(
      JSON.stringify({
        sqlRows: count,
        seedMs: Math.round(seedMs),
        pruneMs: Math.round(pruneMs),
        checkpoints: reads.length,
        readMaxMs: +Math.max(...reads).toFixed(1)
      })
    );
    assert.ok(pruneMs < 10000, 'pruning must not repeatedly scan the whole library');
    assert.ok(reads.length >= count / 128, 'cleanup yields between bounded pages');
    assert.equal(
      db.prepare('SELECT COUNT(*) total FROM nodes WHERE missing=1').get().total,
      count + 1
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) total FROM media WHERE status='missing'").get().total,
      count
    );
    assert.equal(db.prepare('SELECT COUNT(*) total FROM search_index').get().total, 1);
    await indexing.totals(root, async () => {});
    assert.equal(db.prepare('SELECT files FROM nodes WHERE id=?').get(root).files, 0);
  } finally {
    db.close();
    await cleanup(f);
  }
});

test('unchanged scans stamp nodes without rewriting metadata or reseeding ready media', async () => {
  const f = await fixture();
  const c = await client(f.data);
  await c.close();
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const indexing = require('../src/indexing.cjs').createIndexing(db);
    const stamp = 1700000000000.25;
    const n = {
      id: idFor(path.join(f.source, 'same.jpg')),
      root: idFor(f.source),
      parent: idFor(f.source),
      path: path.join(f.source, 'same.jpg'),
      name: 'same.jpg',
      sortkey: 'same.jpg',
      kind: 'image',
      depth: 1
    };
    const stat = { size: 123, mtimeMs: stamp, birthtimeMs: stamp - 1000 };
    indexing.upsert(n, stat, stamp);
    db.prepare("UPDATE media SET status='ready',width=42,taken=12,date_source='exif-local'").run();
    db.prepare('UPDATE nodes SET favorite=1,crop_zoom=2 WHERE id=?').run(n.id);
    db.exec(`CREATE TEMP TABLE scan_writes(kind TEXT);
      CREATE TEMP TRIGGER broad_node_write AFTER UPDATE OF root,parent,name,sortkey,kind,depth,bytes,mtime,birth ON nodes
        BEGIN INSERT INTO scan_writes VALUES('metadata'); END;
      CREATE TEMP TRIGGER media_seed_write BEFORE INSERT ON media
        BEGIN INSERT INTO scan_writes VALUES('media'); END;`);
    const before = db.prepare('SELECT * FROM media WHERE id=?').get(n.id);
    indexing.upsert(n, stat, stamp + 1);
    assert.deepEqual(db.prepare('SELECT * FROM media WHERE id=?').get(n.id), before);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM scan_writes').get().count, 0);
    const saved = db.prepare('SELECT * FROM nodes WHERE id=?').get(n.id);
    assert.equal(saved.indexed, stamp + 1);
    assert.equal(saved.favorite, 1);
    assert.equal(saved.crop_zoom, 2);
    await indexing.prune(n.parent, stamp + 1, async () => {});
    assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(n.id).missing, 0);

    // Every scanner-owned metadata field still reaches the broad write path.
    const changes = [
      ['root', 'other-root'],
      ['parent', 'other-parent'],
      ['name', 'renamed.jpg'],
      ['sortkey', 'renamed-sort'],
      ['kind', 'video'],
      ['depth', 2]
    ];
    for (const [key, value] of changes) {
      n[key] = value;
      indexing.upsert(n, stat, stamp + 2);
      assert.equal(db.prepare(`SELECT ${key} value FROM nodes WHERE id=?`).get(n.id).value, value);
    }
    for (const [key, column] of [
      ['size', 'bytes'],
      ['mtimeMs', 'mtime'],
      ['birthtimeMs', 'birth']
    ]) {
      stat[key] += 10;
      indexing.upsert(n, stat, stamp + 3);
      assert.equal(
        db.prepare(`SELECT ${column} value FROM nodes WHERE id=?`).get(n.id).value,
        stat[key]
      );
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) count FROM scan_writes WHERE kind='metadata'").get().count,
      9
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) count FROM scan_writes WHERE kind='media'").get().count,
      2
    );
    assert.equal(db.prepare('SELECT name FROM search_index WHERE id=?').get(n.id).name, n.name);
    assert.equal(
      db.prepare('SELECT favorite,crop_zoom FROM nodes WHERE id=?').get(n.id).favorite,
      1
    );
  } finally {
    db.close();
    await cleanup(f);
  }
});

test('unchanged scans recover missing and stopped media without retrying ordinary errors', async () => {
  const f = await fixture();
  const c = await client(f.data);
  await c.close();
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const indexing = require('../src/indexing.cjs').createIndexing(db);
    const stamp = 1700000000000.25;
    const n = {
      id: idFor(path.join(f.source, 'recover.jpg')),
      root: idFor(f.source),
      parent: idFor(f.source),
      path: path.join(f.source, 'recover.jpg'),
      name: 'recover.jpg',
      sortkey: 'recover.jpg',
      kind: 'image',
      depth: 1
    };
    const stat = { size: 123, mtimeMs: stamp, birthtimeMs: stamp - 1000 };
    indexing.upsert(n, stat, stamp);
    const read = db.prepare('SELECT * FROM media WHERE id=?');
    for (const [status, error] of [
      ['missing', null],
      ['error', '媒体服务已停止。']
    ]) {
      db.prepare(
        'UPDATE media SET status=?,error=?,width=42,place=?,place_user=1,latitude=12,longitude=34,coords_user=1 WHERE id=?'
      ).run(status, error, 'local', n.id);
      indexing.upsert(n, stat, stamp + 1);
      const media = read.get(n.id);
      assert.equal(media.status, 'pending');
      assert.equal(media.error, null);
      assert.equal(media.width, null);
      assert.equal(media.place, 'local');
      assert.equal(media.latitude, 12);
      assert.equal(media.longitude, 34);
    }
    db.prepare("UPDATE media SET status='error',error='bad image' WHERE id=?").run(n.id);
    indexing.upsert(n, stat, stamp + 2);
    assert.equal(read.get(n.id).error, 'bad image');
    db.prepare('DELETE FROM media WHERE id=?').run(n.id);
    indexing.upsert(n, stat, stamp + 3);
    assert.equal(read.get(n.id).status, 'pending');
    db.prepare("UPDATE media SET revision='stale',status='ready',width=42 WHERE id=?").run(n.id);
    indexing.upsert(n, stat, stamp + 4);
    assert.equal(read.get(n.id).status, 'pending');
    assert.equal(read.get(n.id).width, null);

    await indexing.prune(n.parent, stamp + 5, async () => {});
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM search_index WHERE id=?').get(n.id).count,
      0
    );
    indexing.upsert(n, stat, stamp + 6);
    assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(n.id).missing, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM search_index WHERE id=?').get(n.id).count,
      1
    );
    assert.equal(read.get(n.id).status, 'pending');
    const folder = {
      ...n,
      id: idFor(f.source),
      parent: 'outer',
      path: f.source,
      name: 'source',
      kind: 'folder',
      depth: 0
    };
    indexing.upsert(folder, stat, stamp);
    indexing.reset();
    await indexing.prune(folder.parent, stamp + 7, async () => {});
    indexing.upsert(folder, stat, stamp + 8);
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM scan_new WHERE id=?').get(folder.id).count,
      1
    );
  } finally {
    db.close();
    await cleanup(f);
  }
});

test('simultaneous scans reserve a single scanner before asynchronous validation', async () => {
  const f = await fixture();
  const c = await client(f.data);
  try {
    const results = await Promise.allSettled([
      c.call('scan', { path: f.source, offline: true }),
      c.call('scan', { path: f.source, offline: true })
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /已有导入/);
    await assert.rejects(c.call('scan', { path: path.join(f.tmp, 'not-found') }), /ENOENT/);
    assert.equal((await c.call('scan', { path: f.source, offline: true })).errors, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});
