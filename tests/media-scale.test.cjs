'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createMedia } = require('../src/media.cjs');

const pendingQuery =
  "SELECT m.id FROM media m CROSS JOIN nodes n ON n.id=m.id WHERE m.status='pending' AND n.missing=0 AND n.kind IN ('image','video') ORDER BY m.taken DESC,m.id DESC LIMIT 32";

test('pending metadata selection uses its partial index and preserves order and eligibility', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,missing INTEGER,kind TEXT,sortkey TEXT DEFAULT '');
    CREATE INDEX nodes_global_name ON nodes(missing,kind,sortkey,id);`);
  const options = { db, home: '', getNode: () => null };
  const media = createMedia(options);
  try {
    const index = db
      .prepare("SELECT sql FROM sqlite_master WHERE name='media_pending_taken'")
      .get();
    assert.match(index.sql, /\(taken DESC,id DESC\) WHERE status='pending'/);
    const addNode = db.prepare('INSERT INTO nodes(id,missing,kind) VALUES(?,?,?)');
    const addMedia = db.prepare('INSERT INTO media(id,taken,status) VALUES(?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < 4096 + 70; i++) {
      const id = String(i).padStart(6, '0');
      addNode.run(id, 0, i % 2 ? 'image' : 'video');
      addMedia.run(id, i < 4096 ? 100000 + i : Math.floor(i / 2), i < 4096 ? 'ready' : 'pending');
    }
    for (const [id, missing, kind] of [
      ['offline', 1, 'image'],
      ['folder', 0, 'folder']
    ]) {
      addNode.run(id, missing, kind);
      addMedia.run(id, 999999, 'pending');
    }
    addMedia.run('orphan', 999999, 'pending');
    db.exec('COMMIT');
    // Upgrade an already populated pre-index database, then restart once more.
    db.exec('DROP INDEX media_pending_taken');
    createMedia(options);
    createMedia(options);
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + pendingQuery).all();
    t.diagnostic(plan.map((row) => row.detail).join('; '));
    assert.ok(plan.some((row) => row.detail.includes('media_pending_taken')));
    assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
    const expected = db.prepare(pendingQuery.replace('media m', 'media m NOT INDEXED')).all();
    assert.equal(expected.length, 32);
    assert.deepEqual(db.prepare(pendingQuery).all(), expected);
    const first = expected[0].id;
    db.prepare("UPDATE media SET status='ready' WHERE id=?").run(first);
    db.prepare("UPDATE media SET status='pending' WHERE id='000000'").run();
    const next = db.prepare(pendingQuery).all();
    assert.equal(next[0].id, '000000');
    assert.ok(next.every((row) => row.id !== first));
    assert.deepEqual(
      next,
      db.prepare(pendingQuery.replace('media m', 'media m NOT INDEXED')).all()
    );
  } finally {
    await media.stop();
    db.close();
  }
});
