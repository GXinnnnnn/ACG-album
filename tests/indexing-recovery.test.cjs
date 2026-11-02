'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createIndexing } = require('../src/indexing.cjs');

const schema = `CREATE TABLE nodes(id TEXT PRIMARY KEY,root TEXT,parent TEXT,path TEXT,name TEXT,
  sortkey TEXT,kind TEXT,depth INTEGER,bytes INTEGER DEFAULT 0,mtime REAL,birth REAL,
  missing INTEGER DEFAULT 0,indexed REAL,files INTEGER DEFAULT 0,folders INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,subject_id INTEGER,manual_subject INTEGER DEFAULT 0);
  CREATE TABLE media(id TEXT PRIMARY KEY,revision TEXT,taken REAL,date_source TEXT,status TEXT,error TEXT,
  width INTEGER,height INTEGER,format TEXT,frames INTEGER,delays TEXT,camera TEXT,hdr INTEGER,depth INTEGER,
  space TEXT,has_icc INTEGER,orientation INTEGER,page_height INTEGER,loop INTEGER,latitude REAL,
  longitude REAL,coords_user INTEGER DEFAULT 0);
  CREATE VIRTUAL TABLE search_index USING fts5(id UNINDEXED,name,tokenize='trigram');`;
const stat = { size: 1, mtimeMs: 10, birthtimeMs: 5 };
const node = (id, parent = 'root', kind = 'folder') => ({
  id,
  root: 'root',
  parent,
  path: path.resolve('source', id),
  name: id,
  sortkey: id,
  kind,
  depth: parent === null ? 0 : 1
});
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-indexing-recovery-'));
  let db;
  const open = () => {
    db = new DatabaseSync(path.join(dir, 'library.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    return db;
  };
  t.after(async () => {
    db?.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('acg-indexing-recovery-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    open,
    close: () => {
      db.close();
      db = null;
    }
  };
}

test('new-folder work persists per job, reset is scoped, and replay does not decode ready media again', async (t) => {
  const f = await fixture(t);
  let db = f.open();
  db.exec(schema);
  let indexing = createIndexing(db);
  indexing.upsert(node('legacy'), stat, 1);
  indexing.setJob('a');
  indexing.upsert(node('album-a'), stat, 1);
  indexing.upsert(node('ready.jpg', 'album-a', 'image'), stat, 1);
  db.prepare("UPDATE media SET status='ready',width=42,height=64 WHERE id='ready.jpg'").run();
  db.prepare("UPDATE nodes SET subject_id=42,manual_subject=1 WHERE id='ready.jpg'").run();
  indexing.setJob('b');
  indexing.upsert(node('album-b'), stat, 1);
  f.close();
  db = f.open();
  indexing = createIndexing(db);
  assert.deepEqual(indexing.recovery(), { job: '', newFolders: 1, prunePending: 0 });
  indexing.setJob('a');
  assert.equal(indexing.recovery().newFolders, 1);
  indexing.upsert(node('ready.jpg', 'album-a', 'image'), stat, 2);
  assert.equal(db.prepare("SELECT indexed FROM nodes WHERE id='ready.jpg'").get().indexed, 2);
  assert.equal(db.prepare("SELECT width FROM media WHERE id='ready.jpg'").get().width, 42);
  assert.equal(db.prepare("SELECT status FROM media WHERE id='ready.jpg'").get().status, 'ready');
  assert.equal(
    db.prepare("SELECT manual_subject FROM nodes WHERE id='ready.jpg'").get().manual_subject,
    1
  );
  indexing.reset();
  assert.equal(indexing.recovery().newFolders, 0);
  indexing.setJob('b');
  assert.equal(indexing.recovery().newFolders, 1);
  indexing.setJob();
  assert.equal(indexing.recovery().newFolders, 1);
});

test('a committed missing parent retains durable descendant pruning after interruption and reopen', async (t) => {
  const f = await fixture(t);
  let db = f.open();
  db.exec(schema);
  let indexing = createIndexing(db);
  indexing.setJob('a');
  for (const n of [
    node('root', null),
    node('gone'),
    node('child', 'gone'),
    node('image.jpg', 'child', 'image'),
    node('other')
  ])
    indexing.upsert(n, stat, 1);
  indexing.reset();
  // Another queued job must neither be drained nor erased by this recovery.
  db.prepare(
    'INSERT INTO scan_prune(job,node_rowid,id) SELECT ?,rowid,id FROM nodes WHERE id=?'
  ).run('b', 'other');
  await assert.rejects(
    indexing.prune('root', 2, async (changed) => {
      if (changed) throw new Error('interrupted after a durable prune batch');
    }),
    /interrupted/
  );
  assert.equal(db.prepare("SELECT missing FROM nodes WHERE id='gone'").get().missing, 1);
  assert.ok(indexing.recovery().prunePending > 0);
  f.close();
  db = f.open();
  indexing = createIndexing(db);
  indexing.setJob('a');
  await indexing.resumePrune();
  assert.equal(indexing.recovery().prunePending, 0);
  for (const id of ['child', 'image.jpg']) {
    assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(id).missing, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM search_index WHERE id=?').get(id).n, 0);
  }
  assert.equal(db.prepare("SELECT status FROM media WHERE id='image.jpg'").get().status, 'missing');
  indexing.setJob('b');
  assert.equal(indexing.recovery().prunePending, 1);
});

test('directory revalidation with a newer stamp prunes files removed while closed and seeds only new files', async (t) => {
  const f = await fixture(t),
    db = f.open();
  db.exec(schema);
  const indexing = createIndexing(db);
  indexing.setJob('resume');
  indexing.upsert(node('root', null), stat, 100);
  indexing.upsert(node('kept.jpg', 'root', 'image'), stat, 100);
  indexing.upsert(node('removed.jpg', 'root', 'image'), stat, 100);
  db.exec("UPDATE media SET status='ready',width=42");
  indexing.upsert(node('kept.jpg', 'root', 'image'), stat, 101);
  indexing.upsert(node('new.jpg', 'root', 'image'), stat, 101);
  await indexing.prune('root', 101);
  assert.equal(db.prepare("SELECT missing FROM nodes WHERE id='removed.jpg'").get().missing, 1);
  assert.equal(db.prepare("SELECT status FROM media WHERE id='kept.jpg'").get().status, 'ready');
  assert.equal(db.prepare("SELECT width FROM media WHERE id='kept.jpg'").get().width, 42);
  assert.equal(db.prepare("SELECT status FROM media WHERE id='new.jpg'").get().status, 'pending');
});

test('legacy durable queues migrate to composite job keys without losing pending rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      schema +
        `CREATE TABLE scan_new(id TEXT PRIMARY KEY);
      CREATE TABLE scan_prune(node_rowid INTEGER PRIMARY KEY,id TEXT UNIQUE);
      INSERT INTO scan_new VALUES('legacy'); INSERT INTO scan_prune VALUES(7,'missing-node');`
    );
    const indexing = createIndexing(db);
    assert.deepEqual(indexing.recovery(), { job: '', newFolders: 1, prunePending: 1 });
    assert.equal(db.prepare('SELECT stamp FROM scan_prune').get().stamp, null);
    indexing.setJob('a');
    db.prepare('INSERT INTO scan_new(job,id) VALUES(?,?)').run('a', 'legacy');
    assert.equal(indexing.recovery().newFolders, 1, 'identical ids can belong to different jobs');
    indexing.reset();
    indexing.setJob();
    assert.equal(indexing.recovery().newFolders, 1);
  } finally {
    db.close();
  }
});

function queuePrune(db, id, stamp) {
  db.prepare(
    'INSERT INTO scan_prune(job,node_rowid,id,stamp) SELECT ?,rowid,id,? FROM nodes WHERE id=?'
  ).run('resume', stamp, id);
}

test('durable prune skips a revalidated live node and never expands its old subtree', async () => {
  for (const currentStamp of [2, 3]) {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(schema);
      const indexing = createIndexing(db);
      indexing.setJob('resume');
      for (const n of [node('root', null), node('album'), node('image.jpg', 'album', 'image')])
        indexing.upsert(n, stat, 1);
      db.exec("UPDATE media SET status='ready',width=42");
      queuePrune(db, 'album', 2);
      indexing.protect('album', currentStamp);
      await indexing.resumePrune();
      assert.equal(indexing.recovery().prunePending, 0);
      for (const id of ['album', 'image.jpg'])
        assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(id).missing, 0);
      assert.equal(db.prepare("SELECT width FROM media WHERE id='image.jpg'").get().width, 42);
      assert.equal(
        db.prepare("SELECT COUNT(*) n FROM search_index WHERE id='image.jpg'").get().n,
        1
      );
      queuePrune(db, 'image.jpg', null);
      await indexing.resumePrune();
      assert.equal(
        db.prepare("SELECT missing FROM nodes WHERE id='image.jpg'").get().missing,
        0,
        'a migrated queue without a known stamp cannot authorize deletion'
      );
    } finally {
      db.close();
    }
  }
});

test('a newer ancestor protects old queued descendants but same-generation EOF still prunes real deletions', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schema);
    const indexing = createIndexing(db);
    indexing.setJob('resume');
    for (const n of [node('root', null), node('album'), node('image.jpg', 'album', 'image')])
      indexing.upsert(n, stat, 1);
    db.exec("UPDATE media SET status='ready',width=42");
    queuePrune(db, 'image.jpg', 2);
    indexing.protect('album', 3);
    await indexing.resumePrune();
    assert.equal(db.prepare("SELECT missing FROM nodes WHERE id='image.jpg'").get().missing, 0);
    assert.equal(db.prepare("SELECT status FROM media WHERE id='image.jpg'").get().status, 'ready');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM search_index WHERE id='image.jpg'").get().n, 1);
    await indexing.prune('album', 3);
    assert.equal(db.prepare("SELECT missing FROM nodes WHERE id='image.jpg'").get().missing, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM search_index WHERE id='image.jpg'").get().n, 0);
  } finally {
    db.close();
  }
});

test(
  'prune rechecks protected ancestors after yielding, and bad ancestry fails safely',
  { timeout: 10000 },
  async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(schema);
      const indexing = createIndexing(db);
      indexing.setJob('resume');
      for (const n of [node('root', null), node('album'), node('image.jpg', 'album', 'image')])
        indexing.upsert(n, stat, 1);
      queuePrune(db, 'album', 2);
      let protectedAfterYield = false;
      await indexing.resumePrune(async (changed) => {
        if (!changed && !protectedAfterYield) {
          indexing.protect('album', 3);
          protectedAfterYield = true;
        }
      });
      assert.equal(protectedAfterYield, true);
      for (const id of ['album', 'image.jpg'])
        assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(id).missing, 0);
      assert.equal(indexing.recovery().prunePending, 0);
      for (const n of [
        node('cycle-a', 'cycle-b'),
        node('cycle-b', 'cycle-a'),
        node('orphan', 'missing-parent')
      ])
        indexing.upsert(n, stat, 1);
      queuePrune(db, 'cycle-a', 2);
      queuePrune(db, 'orphan', 2);
      await indexing.resumePrune();
      assert.equal(indexing.recovery().prunePending, 0);
      for (const id of ['cycle-a', 'cycle-b', 'orphan'])
        assert.equal(db.prepare('SELECT missing FROM nodes WHERE id=?').get(id).missing, 0);
      await indexing.prune('cycle-b', 2);
      await indexing.prune('missing-parent', 2);
      assert.equal(
        indexing.recovery().prunePending,
        0,
        'fresh prune cannot loop re-enqueuing protected bad chains'
      );
    } finally {
      db.close();
    }
  }
);

test('existing job-scoped queues gain a safety stamp without guessing old deletion generations', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      schema +
        `CREATE TABLE scan_prune(job TEXT NOT NULL,node_rowid INTEGER NOT NULL,id TEXT NOT NULL,
      PRIMARY KEY(job,node_rowid),UNIQUE(job,id)); INSERT INTO scan_prune VALUES('resume',7,'unknown');`
    );
    const indexing = createIndexing(db);
    indexing.setJob('resume');
    assert.equal(indexing.recovery().prunePending, 1);
    assert.equal(db.prepare('SELECT stamp FROM scan_prune').get().stamp, null);
    await indexing.resumePrune();
    assert.equal(indexing.recovery().prunePending, 0);
  } finally {
    db.close();
  }
});
