'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLibrarySummary } = require('../src/library-summary.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-library-summary-'));
  const databasePath = path.join(directory, 'library.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE nodes(id TEXT PRIMARY KEY,root TEXT,kind TEXT,missing INTEGER DEFAULT 0);
    CREATE TABLE root_removals(root TEXT PRIMARY KEY);
    CREATE TABLE media(id TEXT PRIMARY KEY,status TEXT);
    INSERT INTO nodes VALUES
      ('root','root','folder',0),('album','root','folder',0),
      ('image','root','image',0),('video','root','video',0),
      ('missing','root','image',1),
      ('removed','removed','folder',0),('hidden-image','removed','image',0),
      ('hidden-video','removed','video',0);
    INSERT INTO root_removals VALUES('removed');
    INSERT INTO media VALUES
      ('image','ready'),('video','pending'),('missing','error'),
      ('hidden-image','ready'),('hidden-video','pending'),
      ('orphan','ready'),('unknown-status',NULL);`);
  const summary = createLibrarySummary({ databasePath });
  let writerClosed = false;
  t.after(async () => {
    await summary.close();
    if (!writerClosed) db.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-library-summary-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return {
    directory,
    databasePath,
    db,
    summary,
    closeWriter() {
      db.close();
      writerClosed = true;
    }
  };
}

test('statistics counts visible present nodes and both media kinds on an independent reader', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.summary.request('statistics'), { total: 4, images: 2, folders: 2 });
  await assert.rejects(f.summary.request('vacuum'), { code: 'SUMMARY_METHOD_INVALID' });
  assert.equal(f.db.prepare('SELECT COUNT(*) count FROM nodes').get().count, 8);
});

test('mediaStats preserves missing/orphan rows, removes hidden roots, and carries the caller activity snapshot', async (t) => {
  const f = await fixture(t);
  const activity = { queued: 3, active: true, background: true };
  const requested = f.summary.request('mediaStats', activity);
  activity.queued = 99;
  activity.active = false;
  activity.background = false;
  assert.deepEqual(await requested, {
    rows: [
      { status: null, count: 1 },
      { status: 'error', count: 1 },
      { status: 'pending', count: 1 },
      { status: 'ready', count: 2 }
    ],
    queued: 3,
    active: true,
    background: true
  });
  await assert.rejects(
    f.summary.request('mediaStats', { queued: -1, active: false, background: false }),
    TypeError
  );
  await assert.rejects(
    f.summary.request('mediaStats', { queued: 0, active: 'yes', background: false }),
    TypeError
  );
});

test('fresh WAL read transactions observe commits and logical removals without retaining an old snapshot', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.summary.request('statistics'), { total: 4, images: 2, folders: 2 });
  f.db.exec("BEGIN; INSERT INTO nodes VALUES('new','root','image',0)");
  assert.deepEqual(await f.summary.request('statistics'), { total: 4, images: 2, folders: 2 });
  f.db.exec('COMMIT');
  assert.deepEqual(await f.summary.request('statistics'), { total: 5, images: 3, folders: 2 });
  f.db.exec("INSERT INTO root_removals VALUES('root')");
  assert.deepEqual(await f.summary.request('statistics'), { total: 0, images: 0, folders: 0 });
  assert.deepEqual(
    await f.summary.request('mediaStats', { queued: 0, active: false, background: false }),
    {
      rows: [
        { status: null, count: 1 },
        { status: 'ready', count: 1 }
      ],
      queued: 0,
      active: false,
      background: false
    }
  );
  f.db.exec('DELETE FROM root_removals');
  assert.deepEqual(await f.summary.request('statistics'), { total: 8, images: 5, folders: 3 });
  assert.equal(
    (await f.summary.request('mediaStats')).rows.reduce((sum, row) => sum + row.count, 0),
    7
  );
});

test('read-only summaries preserve the database bytes and support a schema without logical removals', async (t) => {
  const f = await fixture(t);
  f.db.exec('DROP TABLE root_removals; PRAGMA wal_checkpoint(TRUNCATE)');
  f.closeWriter();
  const before = await fs.readFile(f.databasePath);
  assert.deepEqual(await f.summary.request('statistics'), { total: 7, images: 4, folders: 3 });
  assert.equal(
    (await f.summary.request('mediaStats')).rows.reduce((sum, row) => sum + row.count, 0),
    7
  );
  await f.summary.close();
  assert.deepEqual(await fs.readFile(f.databasePath), before);
});

test('query failures settle requests and a later repaired schema remains readable', async (t) => {
  const f = await fixture(t);
  f.db.exec('ALTER TABLE nodes RENAME TO unavailable_nodes');
  await assert.rejects(f.summary.request('statistics'), /no such table: nodes/);
  f.db.exec('ALTER TABLE unavailable_nodes RENAME TO nodes');
  assert.deepEqual(await f.summary.request('statistics'), { total: 4, images: 2, folders: 2 });
  assert.deepEqual(await f.summary.request('statistics'), { total: 4, images: 2, folders: 2 });
});

test('missing databases are never created and close rejects pending and future requests', async (t) => {
  const f = await fixture(t);
  const absent = path.join(f.directory, 'not-created.sqlite');
  const missing = createLibrarySummary({ databasePath: absent });
  t.after(() => missing.close());
  await assert.rejects(missing.request('statistics'));
  await assert.rejects(fs.stat(absent), { code: 'ENOENT' });
  await missing.close();
  const pending = f.summary.request('statistics');
  const rejected = assert.rejects(pending, { code: 'SUMMARY_CLOSED' });
  const closing = f.summary.close();
  assert.equal(f.summary.close(), closing);
  await closing;
  await rejected;
  await assert.rejects(f.summary.request('statistics'), { code: 'SUMMARY_CLOSED' });
});
