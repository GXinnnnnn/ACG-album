'use strict';
// Lead-run isolated deletion/reimport acceptance. SQL-only large library; one
// physical placeholder image, no decoding, HTTP, GUI or user-data access.
// ACG_REMOVAL_ROWS=100000 ACG_REMOVAL_OUTPUT=<absolute.json> node scripts/check-root-removal.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { client } = require('./check-startup-performance.cjs');
const { idFor } = require('../src/model.cjs');
const { sortKey } = require('../src/natural-sort.cjs');
const rows = Number(process.env.ACG_REMOVAL_ROWS || 100000);
const output = process.env.ACG_REMOVAL_OUTPUT;
const round = (n) => +n.toFixed(3);
(async () => {
  assert.ok(Number.isSafeInteger(rows) && rows >= 1 && rows <= 200000);
  if (output) assert.ok(path.isAbsolute(output));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-root-removal-perf-'));
  const data = path.join(directory, 'data'),
    source = path.join(directory, 'source'),
    other = path.join(directory, 'other');
  const root = idFor(source),
    survivor = idFor(other),
    file = path.join(source, 'new-import.jpg');
  let active, db;
  try {
    await fs.mkdir(source);
    await fs.mkdir(other);
    await fs.writeFile(file, 'isolated placeholder; no decoder');
    active = await client(data, { suppressMedia: true });
    await active.close();
    active = null;
    db = new DatabaseSync(path.join(data, 'library.sqlite'));
    db.exec('PRAGMA synchronous=FULL; BEGIN');
    const add = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    for (const [id, p] of [
      [root, source],
      [survivor, other]
    ])
      add.run(
        id,
        id,
        null,
        p,
        path.basename(p),
        sortKey(path.basename(p)),
        'folder',
        0,
        0,
        1,
        1,
        1
      );
    const media = db.prepare(
      "INSERT INTO media(id,revision,taken,status) VALUES(?,'1.0-10',1,'pending')"
    );
    const pending = db.prepare('INSERT INTO match_pending VALUES(?,?,?)');
    for (let i = 0; i < rows; i++) {
      const p = path.join(source, `old-${i}.jpg`),
        id = idFor(p),
        name = path.basename(p);
      add.run(id, root, root, p, name, sortKey(name), 'image', 1, 10, 1, 1, 1);
      media.run(id);
      pending.run(id, root, 'old-generation');
    }
    db.exec('INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes');
    db.prepare(
      "INSERT INTO root_match_policy(root,enabled,types,revision) VALUES(?,1,'[4]',1)"
    ).run(root);
    db.prepare("INSERT INTO match_frontier VALUES(?,'')").run(root);
    db.prepare("UPDATE match_resume SET reason='access',scope=? WHERE singleton=1").run(
      createHash('sha256').update('ACGAlbum Bangumi cache v1\0').digest('hex')
    );
    db.exec('COMMIT');
    db.close();
    db = null;
    active = await client(data, { suppressMedia: true });
    const started = performance.now();
    await active.call('removeRoot', { id: root });
    const removeRpcMs = performance.now() - started;
    assert.ok(removeRpcMs < 2000, 'removeRoot RPC must finish below two seconds');
    assert.equal(await active.call('get', { id: root }), null);
    const scanStarted = performance.now();
    let completed = false,
      scanError;
    const scan = active.call('scan', { path: source, offline: true, onlineMatch: false }).then(
      (result) => {
        completed = true;
        return result;
      },
      (error) => {
        completed = true;
        scanError = error;
      }
    );
    const reads = [];
    const deadline = Date.now() + 300000;
    while (!completed) {
      assert.ok(
        Date.now() < deadline,
        'isolated cleanup/reimport did not finish within five minutes'
      );
      const readStarted = performance.now();
      assert.ok(await active.call('get', { id: survivor }));
      const elapsed = performance.now() - readStarted;
      reads.push(elapsed);
      assert.ok(elapsed < 2000, 'unrelated get RPC must remain below two seconds');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const result = await scan;
    if (scanError) throw scanError;
    assert.equal(result.cancelled, false);
    assert.equal(result.errors, 0);
    const cleanupAndReimportMs = performance.now() - scanStarted;
    const fresh = await active.call('get', { id: idFor(file) });
    assert.ok(fresh);
    assert.equal((await active.call('list', { parent: root, filter: 'images' })).total, 1);
    assert.ok(
      active.events.some(
        (event) => event.event === 'progress' && event.data.phase === '正在清理旧分类'
      ),
      'reimport exposes its asynchronous wait phase'
    );
    await active.close();
    active = null;
    db = new DatabaseSync(path.join(data, 'library.sqlite'), { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM root_removals').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE root=?').get(root).n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM match_pending WHERE root=?').get(root).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM media').get().n, 1);
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM search_index').get().n,
      db.prepare('SELECT COUNT(*) n FROM nodes').get().n
    );
    db.close();
    db = null;
    assert.equal(await fs.readFile(file, 'utf8'), 'isolated placeholder; no decoder');
    const report = {
      status: 'passed',
      createdAt: new Date().toISOString(),
      sqlRows: rows,
      physicalImages: 1,
      noDecodeOrNetwork: true,
      removeRpcMs: round(removeRpcMs),
      cleanupAndReimportMs: round(cleanupAndReimportMs),
      readSamples: reads.length,
      readP95Ms: round([...reads].sort((a, b) => a - b)[Math.floor(reads.length * 0.95)] || 0),
      readMaxMs: round(Math.max(0, ...reads)),
      fullDurability: true,
      sourceBytesPreserved: true,
      oldRowsAndQueuesRemoved: true,
      newRowsSurvive: true
    };
    if (output) await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await active?.close();
    db?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('acg-root-removal-perf-'));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
