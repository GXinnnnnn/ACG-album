'use strict';
// Isolated source-worker benchmark. SQL fixture has no real images; index fixture
// uses small MP4 placeholders and suppresses only background metadata decoding so
// enumeration/SQL costs are measured separately. No real Bangumi traffic or tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { sortKey } = require('../src/natural-sort.cjs');
const { idFor } = require('../src/model.cjs');
const rootDirectory = path.resolve(__dirname, '..');
const workerScript = path.join(rootDirectory, 'src/library-worker.cjs');
const rows = Number(process.env.ACG_PERF_ROWS || 100000);
const fileCount = Number(process.env.ACG_PERF_FILES || 4000);
const filesPerAlbum = Number(process.env.ACG_PERF_FILES_PER_ALBUM || 200);
const output =
  process.env.ACG_PERF_OUTPUT || path.join(rootDirectory, 'artifacts/startup-performance.json');
const round = (value) => +value.toFixed(3);
async function client(
  dataDir,
  { profile = false, suppressMedia = false, pauseBeforeFolderCommit = null } = {}
) {
  const { port1, port2 } = new MessageChannel();
  const start = performance.now();
  const worker = new Worker(
    `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const { workerData, parentPort } = require('node:worker_threads');
    let source = fs.readFileSync(workerData.script, 'utf8');
    if (workerData.baselineStartup) {
      // Reproduce the previous recurring startup work without changing the
      // shared runtime file. Everything else runs from this same source tree.
      const start = source.indexOf('function migrateOnce(');
      const end = source.indexOf('const { sortKey, NATURAL_SORT_VERSION }', start);
      if (start < 0 || end < 0) throw new Error('Startup baseline markers not found');
      source = source.slice(0, start) + 'function migrateOnce(key, version, migrate) { migrate(); }\\n' + source.slice(end);
      source = source.replace("parent IS NULL AND missing=0 AND kind='folder' ORDER BY sortkey", 'parent IS NULL AND missing=0 ORDER BY sortkey');
    }
    if (workerData.pauseBeforeFolderCommit) {
      if (workerData.profile) throw new Error('Commit pause uses the control port exclusively');
      const anchor = 'const saveTotals = await indexing.totals(folder.id, checkpoint, true);';
      if (!source.includes(anchor)) throw new Error('Folder commit test marker not found');
      source = source.replace(anchor, anchor + "; if (folder.id === workerData.pauseBeforeFolderCommit) await new Promise(resolve => { workerData.profilePort.once('message', resolve); workerData.profilePort.postMessage({ paused: folder.id, inTransaction: db.isTransaction }); });");
    }
    if (workerData.suppressMedia) source = source.replace(
      "const media = require('./media.cjs').createMedia({ db, home, getNode, send });",
      "const media = require('./media.cjs').createMedia({ db, home, getNode, send }); media.start = () => Promise.resolve(media.stats());");
    if (workerData.profile) source = source.replace(
      "const db = new DatabaseSync(path.join(home, 'library.sqlite'));",
      \`const db = new DatabaseSync(path.join(home, 'library.sqlite'));
      const timings = new Map();
      function measure(sql, operation, work) {
        const start = performance.now();
        try { return work(); } finally {
          const key = operation + ' ' + sql.replace(/\\\\s+/g, ' ').slice(0, 500);
          const item = timings.get(key) || { sql: key, count: 0, totalMs: 0, maxMs: 0 };
          const elapsed = performance.now() - start;
          item.count++; item.totalMs += elapsed; item.maxMs = Math.max(item.maxMs, elapsed); timings.set(key, item);
        }
      }
      const rawExec = db.exec.bind(db), rawPrepare = db.prepare.bind(db);
      db.exec = (sql) => measure(sql, 'exec', () => rawExec(sql));
      db.prepare = (sql) => {
        const statement = rawPrepare(sql);
        for (const method of ['run', 'get', 'all']) {
          const original = statement[method].bind(statement);
          statement[method] = (...args) => measure(sql, method, () => original(...args));
        }
        return statement;
      };
      workerData.profilePort.on('message', ({ id, reset }) => {
        const result = [...timings.values()].sort((a,b) => b.totalMs-a.totalMs);
        if (reset) timings.clear();
        workerData.profilePort.postMessage({ id, result });
      });\`);
    const compiled = new Module(workerData.script, module);
    compiled.filename = workerData.script;
    compiled.paths = Module._nodeModulePaths(path.dirname(workerData.script));
    compiled._compile(source, workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        script: workerScript,
        baselineStartup: process.env.ACG_PERF_BASELINE === '1',
        profile,
        suppressMedia,
        pauseBeforeFolderCommit,
        profilePort: port2
      },
      transferList: [port2]
    }
  );
  let sequence = 0;
  const pending = new Map(),
    snapshots = new Map(),
    events = [];
  let pausedResolve;
  const paused = new Promise((resolve) => {
    pausedResolve = resolve;
  });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  worker.on('error', (error) => {
    readyReject(error);
    for (const p of pending.values()) p.reject(error);
  });
  worker.on('message', (message) => {
    if (message.event) events.push(message);
    if (message.event === 'ready') readyResolve();
    if (message.request) {
      const p = pending.get(message.request);
      if (!p) return;
      pending.delete(message.request);
      message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
    }
  });
  port1.on('message', ({ id, result, paused, inTransaction }) => {
    if (paused) return pausedResolve({ id: paused, inTransaction });
    const p = snapshots.get(id);
    snapshots.delete(id);
    p(result);
  });
  try {
    await ready;
  } catch (error) {
    await worker.terminate();
    port1.close();
    throw error;
  }
  const readyMs = performance.now() - start;
  const api = {
    readyMs,
    events,
    paused,
    resume() {
      if (pauseBeforeFolderCommit) port1.postMessage({ resume: true });
    },
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        pending.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
    },
    snapshot(reset = false) {
      return new Promise((resolve) => {
        const id = ++sequence;
        snapshots.set(id, resolve);
        port1.postMessage({ id, reset });
      });
    },
    async close() {
      api.resume();
      try {
        await api.call('shutdown');
      } finally {
        await worker.terminate();
        port1.close();
      }
    }
  };
  return api;
}
async function timed(work) {
  const start = performance.now();
  const result = await work();
  return { ms: round(performance.now() - start), result };
}
async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-startup-perf-'));
  let active;
  const report = {
    schema: 1,
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      sqlite: process.versions.sqlite,
      icu: process.versions.icu,
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryGB: round(os.totalmem() / 1024 ** 3)
    },
    methodology: {
      rows,
      fileCount,
      filesPerAlbum,
      albumCount: Math.ceil(fileCount / filesPerAlbum),
      syntheticSqlLibrary: true,
      baselineStartupBehavior: process.env.ACG_PERF_BASELINE === '1',
      mediaDecodeSuppressedForIndexMeasurement: true,
      realNetwork: false
    },
    startup: {},
    indexing: {},
    rpc: []
  };
  try {
    const data = path.join(temporary, 'data');
    active = await client(data);
    report.startup.emptyReadyMs = round(active.readyMs);
    await active.close();
    active = null;
    const db = new DatabaseSync(path.join(data, 'library.sqlite'));
    const insert = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,files,total_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    const insertMedia = db.prepare(
      "INSERT INTO media(id,revision,taken,date_source,status,width,height) SELECT id,CAST(COALESCE(mtime,0) AS TEXT)||'-'||CAST(COALESCE(bytes,0) AS TEXT),mtime,'mtime','ready',320,480 FROM nodes WHERE id=?"
    );
    db.exec('BEGIN');
    insert.run(
      'perf-root',
      'perf-root',
      null,
      'C:\\SyntheticPerformanceLibrary',
      'Synthetic library',
      sortKey('Synthetic library'),
      'folder',
      0,
      0,
      1,
      1,
      rows,
      rows * 1024
    );
    for (let i = 1; i <= rows; i++) {
      const id = 'perf-' + i,
        name = `图片${i}.jpg`,
        stamp = 1700000000000 + (i % 30000);
      insert.run(
        id,
        'perf-root',
        'perf-root',
        'C:\\SyntheticPerformanceLibrary\\' + name,
        name,
        sortKey(name),
        'image',
        1,
        1024,
        stamp,
        stamp,
        0,
        0
      );
      insertMedia.run(id);
    }
    db.exec(
      'INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes; COMMIT; PRAGMA wal_checkpoint(TRUNCATE)'
    );
    db.close();
    report.startup.existing = [];
    for (let repeat = 0; repeat < 3; repeat++) {
      active = await client(data);
      const init = await timed(() => active.call('init'));
      assert.equal(init.result.stats.images, rows);
      report.startup.existing.push({
        readyMs: round(active.readyMs),
        initMs: init.ms,
        sortMigrationEvents: active.events.filter((e) => e.event === 'sortMigration').length
      });
      if (repeat === 2) {
        for (const sort of ['name', 'date', 'modified', 'size'])
          for (const direction of ['asc', 'desc']) {
            const measured = await timed(() =>
              active.call('list', {
                parent: 'perf-root',
                sort,
                direction,
                offset: Math.max(0, rows - 50),
                limit: 50
              })
            );
            assert.equal(measured.result.items.length, Math.min(50, rows));
            assert.ok(
              measured.ms < 2000,
              `${sort}/${direction} RPC ${measured.ms}ms must be strictly <2000ms`
            );
            report.rpc.push({
              sort,
              direction,
              ms: measured.ms,
              count: measured.result.items.length
            });
          }
      }
      await active.close();
      active = null;
    }
    active = await client(data, { profile: true });
    await active.call('init');
    report.startup.sqlProfile = (await active.snapshot())
      .slice(0, 15)
      .map((s) => ({ ...s, totalMs: round(s.totalMs), maxMs: round(s.maxMs) }));
    await active.close();
    active = null;
    const source = path.join(temporary, 'source'),
      indexData = path.join(temporary, 'index-data');
    await fs.mkdir(source);
    const concurrency = 32;
    for (let offset = 0; offset < fileCount; offset += concurrency)
      await Promise.all(
        Array.from({ length: Math.min(concurrency, fileCount - offset) }, async (_, n) => {
          const index = offset + n,
            folder = path.join(source, 'Album' + Math.floor(index / filesPerAlbum));
          await fs.mkdir(folder, { recursive: true });
          await fs.writeFile(path.join(folder, `video${index}.mp4`), 'placeholder');
        })
      );
    active = await client(indexData, { profile: true, suppressMedia: true });
    await active.snapshot(true);
    const first = await timed(() =>
      active.call('scan', { path: source, onlineMatch: false, directoryKind: 'work' })
    );
    assert.equal(first.result.errors, 0);
    report.indexing.first = {
      ms: first.ms,
      filesPerSecond: round(fileCount / (first.ms / 1000)),
      albumsPerSecond: round(Math.ceil(fileCount / filesPerAlbum) / (first.ms / 1000))
    };
    report.indexing.firstSqlProfile = (await active.snapshot(true))
      .slice(0, 12)
      .map((s) => ({ ...s, totalMs: round(s.totalMs), maxMs: round(s.maxMs) }));
    const repeat = await timed(() =>
      active.call('scan', { path: source, onlineMatch: false, directoryKind: 'work' })
    );
    assert.equal(repeat.result.errors, 0);
    report.indexing.repeat = {
      ms: repeat.ms,
      filesPerSecond: round(fileCount / (repeat.ms / 1000)),
      albumsPerSecond: round(Math.ceil(fileCount / filesPerAlbum) / (repeat.ms / 1000))
    };
    report.indexing.repeatSqlProfile = (await active.snapshot())
      .slice(0, 12)
      .map((s) => ({ ...s, totalMs: round(s.totalMs), maxMs: round(s.maxMs) }));
    const init = await active.call('init');
    assert.equal(init.stats.images, fileCount);
    report.indexing.stats = init.stats;
    await active.close();
    active = null;
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await active?.close();
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-startup-perf-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
module.exports = { client };
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
