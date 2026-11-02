'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scanOptions = { offline: true, onlineMatch: false };
function database(f, read, writable = false) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: !writable });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const row = (f, p) =>
  database(f, (db) => db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(p)));
const jobs = (f) => database(f, (db) => db.prepare('SELECT * FROM scan_jobs ORDER BY id').all());
const frame = (f, p) =>
  database(f, (db) => db.prepare('SELECT * FROM scan_directories WHERE id=?').get(idFor(p)));
const absent = (f, p) => {
  const n = row(f, p);
  return !n || n.missing === 1;
};
function audit(f) {
  database(
    f,
    (db) =>
      db.exec(`CREATE TABLE resume_indexed_audit(id TEXT NOT NULL);
    CREATE TRIGGER resume_indexed_writes AFTER UPDATE OF indexed ON nodes
      BEGIN INSERT INTO resume_indexed_audit VALUES(new.id); END;`),
    true
  );
}
const indexedWrites = (f, p) =>
  database(
    f,
    (db) =>
      db.prepare('SELECT COUNT(*) count FROM resume_indexed_audit WHERE id=?').get(idFor(p)).count
  );
async function images(dir, count = 1) {
  await fs.mkdir(dir, { recursive: true });
  const result = [];
  for (let start = 0; start < count; start += 32) {
    const page = Array.from({ length: Math.min(32, count - start) }, (_, offset) =>
      path.join(dir, `image-${String(start + offset).padStart(3, '0')}.jpg`)
    );
    await Promise.all(page.map((p) => fs.writeFile(p, 'scanner fixture; media decoding disabled')));
    result.push(...page);
  }
  return result;
}
async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-scan-resume-worker-'));
  const f = { tmp, source: path.join(tmp, 'source'), data: path.join(tmp, 'data'), clients: [] };
  await fs.mkdir(f.source);
  t.after(async () => {
    for (const c of f.clients) await c.close();
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('acg-scan-resume-worker-'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return f;
}
async function client(f, { gatePath = null, gateAfter = 0 } = {}) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const fs = require('node:fs'), path = require('node:path');
    const { workerData } = require('node:worker_threads');
    const port = workerData.testPort;
    let release, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    port.on('message', message => { if (message.release) release(); });
    const originalOpen = fs.promises.opendir.bind(fs.promises);
    fs.promises.opendir = async (...args) => {
      const directory = await originalOpen(...args);
      if (args[1]?.bufferSize !== 128) return directory;
      const current = path.resolve(args[0]);
      port.postMessage({ opened: current });
      if (current !== workerData.gatePath) return directory;
      const iterator = directory[Symbol.asyncIterator].bind(directory);
      directory[Symbol.asyncIterator] = async function* () {
        let entries = 0;
        for await (const entry of iterator()) {
          if (!held && entries === workerData.gateAfter) {
            held = true;
            port.postMessage({ held: true, path: current, entries });
            await gate;
          }
          entries++;
          yield entry;
        }
      };
      return directory;
    };
    global.fetch = async (url) => {
      port.postMessage({ http: String(url) });
      throw new Error('Unexpected HTTP in offline scan-resume fixture');
    };
    // Keep scanner/SQLite/identity/journal code real. These tests do not decode
    // images; the production media object and all of its SQL remain installed.
    const mediaModule = require(path.join(path.dirname(workerData.script), 'media.cjs'));
    const createMedia = mediaModule.createMedia;
    mediaModule.createMedia = (...args) => {
      const media = createMedia(...args);
      media.start = () => Promise.resolve(media.stats());
      return media;
    };
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        script: path.resolve(__dirname, '../src/library-worker.cjs'),
        dataDir: f.data,
        localIndexPath: path.join(f.data, 'absent-index.sqlite'),
        watch: false,
        gatePath: gatePath && path.resolve(gatePath),
        gateAfter,
        testPort: port2
      },
      transferList: [port2]
    }
  );
  const pending = new Map(),
    events = [],
    opened = [],
    http = [];
  let serial = 0,
    closed = false,
    failure = null,
    held = null;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  function fail(error) {
    failure = error;
    readyReject(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }
  worker.on('error', fail);
  worker.on('exit', (code) => fail(new Error('Scan fixture worker exited: ' + code)));
  worker.on('message', (message) => {
    if (message.event) events.push(message);
    if (message.event === 'ready') readyResolve();
    const request = pending.get(message.request);
    if (!request) return;
    pending.delete(message.request);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error + '\n' + (message.stack || '')));
    else request.resolve(message.result);
  });
  port1.on('message', (message) => {
    if (message.opened) opened.push(message.opened);
    if (message.http) http.push(message.http);
    if (message.held) held = message;
  });
  const c = {
    events,
    opened,
    http,
    release: () => {
      if (!closed) port1.postMessage({ release: true });
    },
    call(method, args = {}) {
      if (closed) return Promise.reject(new Error('Closed scan fixture client'));
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const request = ++serial;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: scan-resume RPC ' + method));
        }, 15000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    async until(check, label) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        assert.deepEqual(http, [], 'offline fixture must not contact HTTP');
        const result = await check();
        if (result) return result;
        const error = events.find((event) => event.event === 'error');
        if (error) throw new Error(label + ': ' + JSON.stringify(error.data));
        await delay(20);
      }
      throw new Error('Timed out: ' + label);
    },
    waitHeld() {
      return c.until(() => held, 'controlled directory enumeration checkpoint');
    },
    async terminate() {
      if (closed) return;
      closed = true;
      await worker.terminate();
      port1.close();
    },
    async shutdown() {
      if (closed) return;
      const stopping = c.call('shutdown');
      // A foreground get observes the synchronous stopping reservation while the
      // shutdown RPC is still waiting for the deliberately held filesystem read.
      await c.call('get', { id: idFor(f.source) }).catch(() => {});
      c.release();
      await stopping;
      await c.terminate();
    },
    async close() {
      if (closed) return;
      try {
        await c.shutdown();
      } finally {
        c.release();
        await c.terminate();
      }
    }
  };
  f.clients.push(c);
  await ready;
  return c;
}
async function fresh(f, options) {
  const c = await client(f, options);
  await c.call('settings', { key: 'autoMatch', value: false });
  return c;
}
const startScan = (c, f, extra = {}) =>
  c.call('scan', { path: f.source, ...scanOptions, ...extra }).then(
    (result) => ({ result }),
    (error) => ({ error })
  );
async function resumed(f, count) {
  const c = await client(f);
  await c.until(
    () => jobs(f).length === 0 && row(f, f.source)?.files === count,
    'automatic saved scan completion'
  );
  assert.deepEqual(c.http, []);
  return c;
}

// 129 entries are the minimum needed to stop after a real 128-node committed
// batch and before enumeration EOF. The fixture is intentionally not a load test.
test(
  'shutdown pauses a committed partial import and a fresh worker resumes it without another scan request',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await images(f.source, 129);
    const c = await fresh(f, { gatePath: f.source, gateAfter: 128 });
    const scanning = startScan(c, f);
    await c.waitHeld();
    const saved = jobs(f)[0];
    assert.ok(saved?.id);
    assert.equal(frame(f, f.source).phase, 'enumerate');
    const committed = database(f, (db) =>
      db.prepare("SELECT * FROM nodes WHERE kind='image' ORDER BY id LIMIT 1").get()
    );
    assert.ok(committed);
    database(
      f,
      (db) => db.prepare("UPDATE media SET status='ready',width=42 WHERE id=?").run(committed.id),
      true
    );
    await c.shutdown();
    await scanning;
    assert.equal(jobs(f)[0]?.id, saved.id);
    assert.equal(jobs(f)[0]?.state, 'paused');
    const next = await resumed(f, 129);
    assert.ok(
      next.events.some(
        (event) => event.event === 'progress' && event.data.scanStamp === saved.started
      ),
      'automatic recovery retains the original job timestamp'
    );
    const media = database(f, (db) =>
      db.prepare('SELECT status,width FROM media WHERE id=?').get(committed.id)
    );
    assert.equal(media.status, 'ready');
    assert.equal(media.width, 42, 'unchanged committed media is not seeded for decoding again');
  }
);

test(
  'hard termination resumes durable directory frames and does not reopen or rewrite a completed sibling',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const dirs = ['first', 'second']
      .map((name) => path.join(f.source, name))
      .sort((a, b) => idFor(a).localeCompare(idFor(b)));
    const firstImage = (await images(dirs[0]))[0];
    await images(dirs[1]);
    const c = await fresh(f, { gatePath: dirs[1] });
    const scanning = startScan(c, f);
    await c.waitHeld();
    assert.equal(frame(f, dirs[0]).phase, 'done');
    const before = row(f, firstImage).indexed,
      job = jobs(f)[0];
    audit(f);
    await c.terminate();
    await scanning;
    assert.equal(jobs(f)[0]?.id, job.id, 'hard termination must leave a durable scan job');
    const next = await resumed(f, 2);
    assert.equal(row(f, firstImage).indexed, before);
    assert.equal(
      indexedWrites(f, firstImage),
      0,
      'completed media receives no indexed write on recovery'
    );
    assert.equal(next.opened.includes(dirs[0]), false, 'completed sibling is not enumerated again');
    assert.ok(next.opened.includes(dirs[1]));
  }
);

test(
  'offline changes and removal revalidate only affected completed subtrees after restart',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const dirs = ['one', 'two', 'three', 'four']
      .map((name) => path.join(f.source, name))
      .sort((a, b) => idFor(a).localeCompare(idFor(b)));
    const originals = [];
    for (const dir of dirs) originals.push((await images(dir))[0]);
    const c = await fresh(f, { gatePath: dirs[3] });
    const scanning = startScan(c, f);
    await c.waitHeld();
    for (const dir of dirs.slice(0, 3)) assert.equal(frame(f, dir).phase, 'done');
    await c.shutdown();
    await scanning;
    audit(f);
    await fs.unlink(originals[1]);
    const added = path.join(dirs[1], 'added-while-closed.jpg');
    await fs.writeFile(added, 'new');
    const removed = path.resolve(dirs[2]);
    assert.equal(path.dirname(removed), path.resolve(f.source));
    await fs.rm(removed, { recursive: true, force: true });
    const future = new Date(Date.now() + 2000);
    await fs.utimes(dirs[1], future, future);
    await fs.utimes(f.source, future, future);
    const next = await resumed(f, 3);
    assert.ok(absent(f, originals[1]));
    assert.ok(absent(f, dirs[2]));
    assert.ok(absent(f, originals[2]));
    assert.equal(row(f, added).missing, 0);
    assert.equal(row(f, originals[0]).missing, 0);
    assert.equal(indexedWrites(f, originals[0]), 0);
    assert.equal(next.opened.includes(dirs[0]), false);
    assert.ok(next.opened.includes(dirs[1]));
    assert.equal(
      database(f, (db) =>
        db
          .prepare('SELECT COUNT(*) n FROM search_index WHERE id IN (?,?)')
          .get(idFor(originals[1]), idFor(originals[2]))
      ).n,
      0
    );
  }
);

test(
  'a file deleted after its committed enumeration batch becomes missing and a late addition is not skipped',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await images(f.source, 129);
    const c = await fresh(f, { gatePath: f.source, gateAfter: 128 });
    const scanning = startScan(c, f);
    await c.waitHeld();
    const committed = database(f, (db) =>
      db.prepare("SELECT * FROM nodes WHERE kind='image' ORDER BY id LIMIT 1").get()
    );
    assert.equal(committed.missing, 0);
    await fs.unlink(committed.path);
    const late = path.join(f.source, 'late-added.jpg');
    await fs.writeFile(late, 'late');
    const future = new Date(Date.now() + 2000);
    await fs.utimes(f.source, future, future);
    c.release();
    const outcome = await scanning;
    assert.ok(!outcome.error, outcome.error?.stack);
    assert.equal(outcome.result.cancelled, false);
    assert.ok(absent(f, committed.path));
    assert.equal(row(f, late).missing, 0);
    assert.equal(row(f, f.source).files, 129);
    assert.equal(
      database(f, (db) =>
        db.prepare('SELECT COUNT(*) n FROM search_index WHERE id=?').get(committed.id)
      ).n,
      0
    );
    assert.equal(jobs(f).length, 0);
    assert.deepEqual(c.http, []);
  }
);

test(
  'refreshing an existing target traverses deep renames and deletions without rewriting another branch',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      target = path.join(f.source, 'album');
    const deep = path.join(target, 'chapter', 'deep');
    const old = await images(deep, 2),
      other = (await images(path.join(f.source, 'other')))[0];
    const c = await fresh(f);
    let result = await c.call('scan', { path: f.source, ...scanOptions });
    assert.equal(result.errors, 0);
    audit(f);
    const renamed = path.join(target, 'chapter', 'renamed');
    await fs.rename(deep, renamed);
    await fs.unlink(path.join(renamed, path.basename(old[1])));
    result = await c.call('scan', { path: f.source, target, ...scanOptions });
    assert.equal(result.errors, 0);
    assert.equal(result.cancelled, false);
    const kept = path.join(renamed, path.basename(old[0]));
    assert.equal(row(f, kept).missing, 0);
    for (const p of old) assert.ok(absent(f, p));
    assert.ok(absent(f, path.join(renamed, path.basename(old[1]))));
    assert.equal(row(f, target).files, 1);
    assert.equal(row(f, f.source).files, 2);
    assert.equal(indexedWrites(f, other), 0);
    assert.equal(jobs(f).length, 0);
    assert.deepEqual(c.http, []);
  }
);

test(
  'explicit cancellation removes the scan journal and reopening does not resume the cancelled tail',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await images(f.source, 129);
    const c = await fresh(f, { gatePath: f.source, gateAfter: 128 });
    const scanning = startScan(c, f);
    await c.waitHeld();
    assert.equal(jobs(f).length, 1);
    await c.call('cancel');
    c.release();
    await scanning;
    assert.equal(jobs(f).length, 0);
    const committed = database(f, (db) =>
      db.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='image'").get()
    ).n;
    assert.equal(committed, 128);
    await c.shutdown();
    const next = await client(f);
    // This write RPC waits for normal startup maintenance, so there cannot be a
    // merely delayed automatic scan lurking behind the ready event.
    await next.call('settings', { key: 'autoMatch', value: false });
    assert.equal(jobs(f).length, 0);
    assert.deepEqual(next.opened, []);
    assert.equal(
      database(f, (db) => db.prepare("SELECT COUNT(*) n FROM nodes WHERE kind='image'").get()).n,
      committed
    );
    assert.deepEqual(next.http, []);
  }
);
