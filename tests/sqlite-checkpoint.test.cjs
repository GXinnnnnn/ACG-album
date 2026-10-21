'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');
const { createSqliteCheckpoint } = require('../src/sqlite-checkpoint.cjs');
const { createIndexing } = require('../src/indexing.cjs');
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t, production = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-checkpoint-'));
  const filename = path.join(dir, 'fixture.sqlite');
  const db = new DatabaseSync(filename);
  const maintenance = createSqliteCheckpoint(filename);
  t.after(async () => {
    try {
      await maintenance.close();
    } finally {
      db.close();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('acg-checkpoint-'));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  if (production) {
    // Exercise the actual durable production indexes, without starting media,
    // network, account access, or opening any user library.
    const library = fs.readFileSync(path.join(__dirname, '../src/library-worker.cjs'), 'utf8');
    const media = fs.readFileSync(path.join(__dirname, '../src/media.cjs'), 'utf8');
    db.exec(library.match(/db\.exec\(`(PRAGMA journal_mode=WAL;[\s\S]*?)`\);/)[1]);
    db.exec(media.match(/db\.exec\(`(CREATE TABLE IF NOT EXISTS media\([\s\S]*?)`\);/)[1]);
  } else {
    db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT)'
    );
  }
  return { db, filename, maintenance };
}

function seed(db, count) {
  const indexing = createIndexing(db);
  const stat = { size: 1024, mtimeMs: 1700000000000, birthtimeMs: 1700000000000 };
  for (let start = 0; start < count; start += 128) {
    db.exec('BEGIN');
    for (let i = start; i < Math.min(start + 128, count); i++) {
      const name = `image-${String(i).padStart(6, '0')}.jpg`;
      indexing.upsert(
        {
          id: String(i).padStart(32, '0'),
          root: 'root',
          parent: 'root',
          path: path.join('C:\\fixture-only\\album', name),
          name,
          sortkey: name,
          kind: 'image',
          depth: 1
        },
        stat,
        1
      );
    }
    db.exec('COMMIT');
  }
}

test('checkpoint worker is lazy and closing is idempotent', async () => {
  let starts = 0;
  const maintenance = createSqliteCheckpoint('unused', {
    createWorker() {
      starts++;
      throw new Error('must remain lazy');
    }
  });
  const closed = maintenance.close();
  assert.equal(maintenance.close(), closed);
  await closed;
  assert.equal(starts, 0);
  await assert.rejects(maintenance.checkpoint(), /closed/);
});

test('persistent PASSIVE checkpoint coalesces requests and close waits for it', async (t) => {
  const { db, maintenance } = fixture(t);
  db.exec('PRAGMA wal_autocheckpoint=0; INSERT INTO sample VALUES(1,hex(randomblob(524288)))');
  const first = maintenance.checkpoint();
  assert.equal(maintenance.checkpoint(), first);
  let yielded = false;
  setImmediate(() => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sample').get().n, 1);
    db.exec("INSERT INTO sample VALUES(2,'write while checkpoint runs')");
    yielded = true;
  });
  const closing = maintenance.close();
  const result = await first;
  assert.equal(result.busy, 0);
  assert.equal(result.log, result.checkpointed);
  await closing;
  assert.ok(yielded);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sample').get().n, 2);
});

test(
  '8192-row production prune bounds dirty batches and keeps durable commits responsive',
  { timeout: 30000 },
  async (t) => {
    const { db, filename, maintenance } = fixture(t, true);
    seed(db, 8192);
    db.exec('PRAGMA wal_autocheckpoint=713');
    const batches = [];
    let previous = 0,
      walMax = 0,
      checkpointMs = 0;
    const indexing = createIndexing(db, {
      async checkpoint() {
        assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 0);
        assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
        const missing = db.prepare('SELECT COUNT(*) n FROM nodes WHERE missing=1').get().n;
        batches.push(missing - previous);
        previous = missing;
        walMax = Math.max(walMax, fs.statSync(filename + '-wal').size);
        const at = performance.now();
        const result = await maintenance.checkpoint();
        checkpointMs += performance.now() - at;
        assert.equal(result.log, result.checkpointed);
      }
    });
    let last = performance.now(),
      maxGap = 0,
      heartbeats = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      heartbeats++;
      assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE parent=?').get('root').n, 8192);
    }, 10);
    const start = performance.now();
    try {
      await indexing.prune('root', 2, yieldNow);
    } finally {
      clearInterval(timer);
      maxGap = Math.max(maxGap, performance.now() - last);
    }
    const pruneMs = performance.now() - start;
    assert.deepEqual(batches, [2048, 2048, 2048, 2048]);
    assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 713);
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE missing=1').get().n, 8192);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM media WHERE status='missing'").get().n, 8192);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM search_index').get().n, 0);
    assert.ok(heartbeats > 0);
    assert.ok(maxGap < 2000, `event loop maximum gap ${maxGap.toFixed(1)}ms`);
    // PASSIVE leaves its high-water file allocated, but the next writer reuses it.
    const highWater = fs.statSync(filename + '-wal').size;
    db.exec('UPDATE nodes SET indexed=3 WHERE rowid=1');
    assert.ok(fs.statSync(filename + '-wal').size <= highWater + 65536);
    await indexing.prune('root', 4, yieldNow);
    assert.equal(batches.length, 4, 'no missing rows means no maintenance');
    t.diagnostic(
      JSON.stringify({
        rows: 8192,
        pruneMs: Math.round(pruneMs),
        checkpointMs: Math.round(checkpointMs),
        heartbeatMaxMs: +maxGap.toFixed(1),
        heartbeats,
        walHighWaterMiB: +(walMax / 1048576).toFixed(1)
      })
    );
  }
);

test('nested subtree pruning yields after at most 128 missing nodes', async (t) => {
  const { db, maintenance } = fixture(t, true);
  seed(db, 1024);
  db.exec("UPDATE nodes SET parent='removed-folder'");
  const indexing = createIndexing(db, maintenance);
  indexing.upsert(
    {
      id: 'removed-folder',
      root: 'root',
      parent: 'root',
      path: 'C:\\fixture-only\\album',
      name: 'album',
      sortkey: 'album',
      kind: 'folder',
      depth: 1
    },
    { size: 0, mtimeMs: 1700000000000, birthtimeMs: 1700000000000 },
    1
  );
  const removedCount = db.prepare('SELECT COUNT(*) n FROM nodes WHERE missing=1');
  let previous = 0;
  const batches = [];
  await indexing.prune('root', 2, async () => {
    const current = removedCount.get().n;
    if (current > previous) batches.push(current - previous);
    previous = current;
    await yieldNow();
  });
  assert.equal(previous, 1025);
  assert.ok(
    batches.every((size) => size <= 128),
    `synchronous removal batches: ${batches}`
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM media WHERE status='missing'").get().n, 1024);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM search_index').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_prune').get().n, 0);
});

test('prune restores the original pragma and propagates callback and maintenance errors', async (t) => {
  const { db } = fixture(t, true);
  seed(db, 3);
  db.exec('PRAGMA wal_autocheckpoint=321');
  let drains = 0;
  const indexing = createIndexing(db, {
    async checkpoint() {
      drains++;
    }
  });
  await assert.rejects(
    indexing.prune('root', 2, async () => {
      throw new Error('progress failed');
    }),
    /progress failed/
  );
  assert.equal(drains, 1, 'committed changes are maintained even when the caller fails');
  assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 321);
  db.exec('UPDATE nodes SET missing=0');
  const broken = createIndexing(db, {
    async checkpoint() {
      throw new Error('disk maintenance failed');
    }
  });
  await assert.rejects(broken.prune('root', 2, yieldNow), /disk maintenance failed/);
  assert.equal(db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, 321);
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
});

test(
  'a pinned reader causes a bounded maintenance failure and can recover',
  { timeout: 10000 },
  async (t) => {
    const { db, filename, maintenance } = fixture(t);
    db.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO sample VALUES(1,'before')");
    await maintenance.checkpoint();
    const reader = new DatabaseSync(filename);
    try {
      reader.exec('BEGIN');
      assert.equal(reader.prepare('SELECT value FROM sample').get().value, 'before');
      db.exec("UPDATE sample SET value='after'");
      await assert.rejects(maintenance.checkpoint(), { code: 'SQLITE_CHECKPOINT_BUSY' });
      assert.equal(db.prepare('SELECT value FROM sample').get().value, 'after');
      reader.exec('COMMIT');
      const result = await maintenance.checkpoint();
      assert.equal(result.log, result.checkpointed);
    } finally {
      reader.close();
    }
  }
);

test(
  'scan maintenance budgets initial and warm entries and restores state after failure or cancellation',
  { timeout: 30000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-checkpoint-scan-'));
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    for (let i = 0; i < 2050; i++) fs.writeFileSync(path.join(source, `image-${i}.jpg`), '');
    // Instrument only this fixture's worker. No production diagnostic hooks or
    // private data are needed to observe connection-local pragmas and failures.
    const worker = new Worker(
      `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    let writer, injectFailure = false;
    parentPort.on('message', (m) => { if (m.injectCheckpointFailure) injectFailure = true; });
    const exec = DatabaseSync.prototype.exec;
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql.startsWith('PRAGMA journal_mode=WAL')) writer = this;
      if (sql.includes('PRAGMA wal_autocheckpoint=')) parentPort.postMessage({ event: 'test-pragma', data: this.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint });
      return result;
    };
    const checkpointModule = require(workerData.checkpointModule);
    const factory = checkpointModule.createSqliteCheckpoint;
    checkpointModule.createSqliteCheckpoint = (...args) => {
      const maintenance = factory(...args);
      return {
        close: () => maintenance.close(),
        async checkpoint() {
          parentPort.postMessage({ event: 'test-checkpoint', data: { auto: writer.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint, sync: writer.prepare('PRAGMA synchronous').get().synchronous } });
          if (injectFailure) {
            injectFailure = false;
            const error = new Error('injected checkpoint failure');
            error.code = 'SQLITE_CHECKPOINT_BUSY';
            throw error;
          }
          return maintenance.checkpoint();
        }
      };
    };
    require(workerData.libraryModule);
  `,
      {
        eval: true,
        workerData: {
          dataDir: path.join(dir, 'data'),
          watch: false,
          checkpointModule: path.resolve(__dirname, '../src/sqlite-checkpoint.cjs'),
          libraryModule: path.resolve(__dirname, '../src/library-worker.cjs')
        }
      }
    );
    const pending = new Map(),
      events = [];
    let serial = 0,
      onProgress;
    const ready = new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (m) => {
        if (m.event === 'ready') resolve();
        if (m.event) events.push(m);
        if (m.event === 'progress') onProgress?.(m.data);
        const job = pending.get(m.request);
        if (job) {
          pending.delete(m.request);
          clearTimeout(job.timer);
          if (m.error) job.reject(new Error(m.error));
          else job.resolve(m.result);
        }
      });
    });
    const call = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++serial;
        const timer = setTimeout(
          () => reject(new Error('fixture RPC timed out: ' + method)),
          10000
        );
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    t.after(async () => {
      for (const job of pending.values()) clearTimeout(job.timer);
      await worker.terminate();
      assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(dir).startsWith('acg-checkpoint-scan-'));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    await ready;
    await call('settings', { key: 'autoMatch', value: false });
    for (const label of ['initial', 'warm']) {
      const first = events.length;
      const result = await call('scan', { path: source, offline: true });
      assert.equal(result.errors, 0);
      const checkpoints = events.slice(first).filter((m) => m.event === 'test-checkpoint');
      assert.equal(
        checkpoints.length,
        2,
        label + ' maintains the 2048-entry budget and final tail'
      );
      for (const { data } of checkpoints) assert.deepEqual(data, { auto: 0, sync: 2 });
      assert.equal(events.filter((m) => m.event === 'test-pragma').at(-1).data, 1000);
    }
    worker.postMessage({ injectCheckpointFailure: true });
    await assert.rejects(
      call('scan', { path: source, offline: true }),
      /injected checkpoint failure/
    );
    assert.equal(events.filter((m) => m.event === 'test-pragma').at(-1).data, 1000);
    assert.equal(events.filter((m) => m.event === 'progress').at(-1).data.active, false);
    assert.equal(
      (await call('scan', { path: source, offline: true })).errors,
      0,
      'scanner reservation recovered'
    );
    let cancelTask;
    onProgress = (p) => {
      if (p.active && !cancelTask) cancelTask = call('cancel');
    };
    assert.equal((await call('scan', { path: source, offline: true })).cancelled, true);
    await cancelTask;
    onProgress = undefined;
    assert.equal(events.filter((m) => m.event === 'test-pragma').at(-1).data, 1000);
    assert.equal(events.filter((m) => m.event === 'progress').at(-1).data.active, false);
    assert.equal(await call('shutdown'), true, 'nested checkpoint worker closes before the writer');
  }
);

test('worker initialization, unexpected exit and timeout failures reject and clean up', async (t) => {
  await t.test('initialization error', async () => {
    const maintenance = createSqliteCheckpoint(
      path.join(os.tmpdir(), 'no-such-checkpoint-parent-' + process.pid, 'fixture.sqlite')
    );
    await assert.rejects(maintenance.checkpoint(), /open|database/i);
    await assert.rejects(maintenance.close(), /open|database/i);
  });
  for (const mode of ['exit', 'timeout', 'postMessage']) {
    await t.test(mode, async () => {
      let terminated = 0;
      const maintenance = createSqliteCheckpoint('mock', {
        timeoutMs: 20,
        createWorker() {
          const worker = new EventEmitter();
          worker.postMessage = () => {
            if (mode === 'exit') queueMicrotask(() => worker.emit('exit', 9));
            if (mode === 'postMessage') throw new Error('postMessage failed');
          };
          worker.terminate = async () => {
            terminated++;
          };
          return worker;
        }
      });
      await assert.rejects(maintenance.checkpoint(), /exited|timed out|postMessage failed/);
      await assert.rejects(maintenance.checkpoint(), /exited|timed out|postMessage failed/);
      await assert.rejects(maintenance.close(), /exited|timed out|postMessage failed/);
      assert.ok(terminated > 0);
    });
  }
});
