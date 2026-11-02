'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');
const { sortKey } = require('../src/natural-sort.cjs');
const { createRenameIdentity } = require('../src/rename-identity.cjs');

function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,root TEXT,parent TEXT,path TEXT UNIQUE COLLATE NOCASE,
    name TEXT,sortkey TEXT,kind TEXT,depth INTEGER,missing INTEGER DEFAULT 0,indexed REAL DEFAULT 1,
    cover TEXT,cover_source TEXT,local_newest TEXT,fs_identity TEXT,
    crop_x REAL DEFAULT 50,crop_y REAL DEFAULT 50,crop_zoom REAL DEFAULT 1,favorite INTEGER DEFAULT 0,
    subject_id INTEGER,manual_subject INTEGER DEFAULT 0,character_id INTEGER,manual_character INTEGER DEFAULT 0,
    manual_cover INTEGER DEFAULT 0,confirmed INTEGER DEFAULT 0,custom_character_note TEXT);
    CREATE TABLE media(id TEXT PRIMARY KEY,revision TEXT,status TEXT,width INTEGER,height INTEGER,
      latitude REAL,longitude REAL,place TEXT,coords_user INTEGER DEFAULT 0,place_user INTEGER DEFAULT 0);
    CREATE TABLE match_pending(id TEXT PRIMARY KEY,root TEXT,stamp TEXT);
    CREATE TABLE match_frontier(root TEXT PRIMARY KEY,after_id TEXT NOT NULL);
    CREATE TABLE root_match_policy(root TEXT PRIMARY KEY,enabled INTEGER,types TEXT,revision INTEGER);
    CREATE TABLE manual_title_keys(node_id TEXT PRIMARY KEY,name_key TEXT,subject_id INTEGER,type INTEGER,name TEXT);
    CREATE TABLE metadata(id INTEGER PRIMARY KEY,json TEXT);
    CREATE TEMP TABLE match_batch_done(id TEXT PRIMARY KEY,stamp TEXT NOT NULL);
    CREATE TEMP TABLE match_deferred(id TEXT PRIMARY KEY);
    CREATE VIRTUAL TABLE search_index USING fts5(id UNINDEXED,name,tokenize='trigram');`);
  t.after(() => db.close());
  const source = path.join(os.tmpdir(), 'acg-db-rename-logical', 'Library');
  const root = idFor(source);
  function seed(p, parent = root, depth = 1, kind = 'folder', rootId = root, missing = 0) {
    const id = idFor(p);
    db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,missing) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, rootId, parent, p, path.basename(p), sortKey(path.basename(p)), kind, depth, missing);
    const node = db.prepare('SELECT rowid AS node_rowid,* FROM nodes WHERE id=?').get(id);
    if (!missing)
      db.prepare('INSERT INTO search_index(rowid,id,name) VALUES(?,?,?)').run(
        node.node_rowid,
        id,
        node.name
      );
    return node;
  }
  seed(source, null, 0);
  const service = createRenameIdentity(db, options);
  const get = (id) => db.prepare('SELECT rowid AS node_rowid,* FROM nodes WHERE id=?').get(id);
  const snapshot = () =>
    Object.fromEntries(
      [
        'nodes',
        'media',
        'match_pending',
        'match_frontier',
        'root_match_policy',
        'manual_title_keys',
        'search_index'
      ].map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()])
    );
  return { db, source, root, seed, get, service, snapshot };
}

test('explicit subtree rename retains legacy and missing rows, annotations, cover relationships, media and learned bindings', async (t) => {
  const f = fixture(t),
    oldPath = path.join(f.source, 'Old Album'),
    newPath = path.join(f.source, 'Renamed Album');
  const album = f.seed(oldPath),
    image = f.seed(path.join(oldPath, 'image.jpg'), album.id, 2, 'image');
  const historic = f.seed(path.join(oldPath, 'deleted.jpg'), album.id, 2, 'image', f.root, 1);
  f.db
    .prepare(
      `UPDATE nodes SET subject_id=42,manual_subject=1,character_id=9,manual_character=1,
    custom_character_note='personal note',manual_cover=1,confirmed=1,crop_x=23,crop_y=72,crop_zoom=2,favorite=1,
    cover=?,local_newest=?,cover_source='local' WHERE id=?`
    )
    .run(image.id, image.id, album.id);
  f.db
    .prepare('UPDATE nodes SET cover=?,local_newest=? WHERE id=?')
    .run(image.id, image.id, f.root);
  f.db
    .prepare(
      "INSERT INTO media VALUES(?,'ready-revision','ready',200,300,12,34,'explicit location',1,1)"
    )
    .run(image.id);
  f.db
    .prepare("INSERT INTO manual_title_keys VALUES(?,'old learned key',42,4,'Old Album')")
    .run(album.id);
  f.db.prepare("INSERT INTO match_pending VALUES(?,?,'original-stamp')").run(album.id, f.root);
  f.db.prepare("INSERT INTO match_batch_done VALUES(?,'done-stamp')").run(image.id);
  f.db.prepare('INSERT INTO match_deferred VALUES(?)').run(album.id);
  f.db
    .prepare('INSERT INTO metadata VALUES(42,\'{"name":"subject remains keyed by subject id"}\')')
    .run();
  const beforeImage = f.get(image.id),
    metadata = f.db.prepare('SELECT * FROM metadata').all();
  const plan = await f.service.prepare({ id: album.id, newPath, operationId: 'subtree' });
  assert.equal(plan.count, 3);
  const result = f.service.commit(plan, { started: 99 });
  const newAlbumId = idFor(newPath),
    newImageId = idFor(path.join(newPath, 'image.jpg'));
  const row = f.get(newAlbumId);
  assert.equal(result.renamed, true);
  assert.equal(result.count, 3);
  assert.equal(row.node_rowid, album.node_rowid);
  assert.equal(row.subject_id, 42);
  for (const [key, expected] of Object.entries({
    manual_subject: 1,
    character_id: 9,
    manual_character: 1,
    custom_character_note: 'personal note',
    manual_cover: 1,
    confirmed: 1,
    crop_x: 23,
    crop_y: 72,
    crop_zoom: 2,
    favorite: 1,
    cover: newImageId,
    local_newest: newImageId,
    indexed: 99
  }))
    assert.equal(row[key], expected, key);
  assert.equal(f.get(newImageId).node_rowid, beforeImage.node_rowid);
  assert.equal(f.get(newImageId).parent, newAlbumId);
  assert.equal(f.get(idFor(path.join(newPath, 'deleted.jpg'))).missing, 1);
  assert.equal(f.get(idFor(path.join(newPath, 'deleted.jpg'))).fs_identity, null);
  assert.equal(f.get(historic.id), undefined);
  assert.equal(f.get(f.root).cover, newImageId);
  const media = f.db.prepare('SELECT * FROM media WHERE id=?').get(newImageId);
  assert.equal(media.status, 'ready');
  assert.equal(media.revision, 'ready-revision');
  assert.equal(media.latitude, 12);
  assert.equal(media.longitude, 34);
  assert.equal(media.coords_user, 1);
  assert.equal(media.place, 'explicit location');
  assert.equal(media.place_user, 1);
  const learned = f.db.prepare('SELECT * FROM manual_title_keys').get();
  assert.equal(learned.node_id, newAlbumId);
  assert.equal(learned.name_key, 'old learned key');
  assert.equal(learned.name, 'Old Album');
  assert.equal(
    f.db.prepare('SELECT stamp FROM match_pending WHERE id=?').get(newAlbumId).stamp,
    'original-stamp'
  );
  assert.equal(
    f.db.prepare('SELECT stamp FROM match_batch_done WHERE id=?').get(newImageId).stamp,
    'done-stamp'
  );
  assert.ok(f.db.prepare('SELECT 1 FROM match_deferred WHERE id=?').get(newAlbumId));
  assert.deepEqual(f.db.prepare('SELECT * FROM metadata').all(), metadata);
  assert.equal(f.db.prepare('SELECT count(*) n FROM search_index WHERE id=?').get(image.id).n, 0);
  assert.equal(
    f.db.prepare('SELECT rowid FROM search_index WHERE id=?').get(newImageId).rowid,
    image.node_rowid
  );
  assert.equal(f.service.isCommitted('subtree'), true);
  assert.equal(f.service.committed('subtree').id, newAlbumId);
  assert.equal(f.db.prepare('SELECT count(*) n FROM rename_identity_map').get().n, 0);
});

test('root rename migrates the exact policy and materializes only the undiscovered frontier suffix without replaying acknowledged work', async (t) => {
  const f = fixture(t, {
    pendingStampFor: (node) => (node.parent === null ? null : `current:${node.id}`)
  });
  const albums = Array.from({ length: 8 }, (_, i) => f.seed(path.join(f.source, 'Album' + i))).sort(
    (a, b) => a.id.localeCompare(b.id)
  );
  const cursor = albums[2].id,
    existing = albums[5];
  f.db.prepare('INSERT INTO match_frontier VALUES(?,?)').run(f.root, cursor);
  f.db
    .prepare("INSERT INTO match_pending VALUES(?,?,'preserve-existing-stamp')")
    .run(existing.id, f.root);
  f.db.prepare("INSERT INTO root_match_policy VALUES(?,0,'[4,6]',17)").run(f.root);
  const newPath = path.join(path.dirname(f.source), 'Renamed Library'),
    newRoot = idFor(newPath);
  const plan = await f.service.prepare({ id: f.root, newPath, operationId: 'root' });
  f.service.commit(plan);
  assert.equal(f.get(f.root), undefined);
  assert.equal(f.get(newRoot).parent, null);
  assert.equal(f.get(newRoot).root, newRoot);
  for (const row of f.db.prepare('SELECT * FROM nodes').all()) assert.equal(row.root, newRoot);
  const policy = f.db.prepare('SELECT * FROM root_match_policy').get();
  assert.equal(policy.root, newRoot);
  assert.equal(policy.enabled, 0);
  assert.equal(policy.types, '[4,6]');
  assert.equal(policy.revision, 17);
  assert.equal(f.db.prepare('SELECT count(*) n FROM match_frontier').get().n, 0);
  const expected = albums
    .filter((node) => node.id > cursor)
    .map((node) => idFor(path.join(newPath, node.name)))
    .sort();
  const pending = f.db.prepare('SELECT * FROM match_pending ORDER BY id').all();
  assert.deepEqual(
    pending.map((row) => row.id),
    expected
  );
  assert.ok(pending.every((row) => row.root === newRoot));
  assert.equal(
    pending.find((row) => row.id === idFor(path.join(newPath, existing.name))).stamp,
    'preserve-existing-stamp'
  );
  assert.equal(
    pending.find((row) => row.id === idFor(path.join(newPath, albums[7].name))).stamp,
    `current:${albums[7].id}`
  );
});

test('case-only root rename keeps path-hash IDs while correcting every descendant path and the top natural sort key', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Inner Album'));
  const image = f.seed(path.join(album.path, 'Legacy.jpg'), album.id, 2, 'image');
  const newPath = path.join(path.dirname(f.source), 'LIBRARY');
  const plan = await f.service.prepare({ id: f.root, newPath, operationId: 'case' });
  assert.equal(plan.id, f.root);
  assert.equal(plan.caseOnly, true);
  f.service.commit(plan);
  assert.equal(f.get(f.root).path, newPath);
  assert.equal(f.get(f.root).name, 'LIBRARY');
  assert.equal(f.get(f.root).sortkey, sortKey('LIBRARY'));
  assert.equal(f.get(album.id).path, path.join(newPath, album.name));
  assert.equal(f.get(image.id).path, path.join(newPath, album.name, image.name));
  assert.equal(f.get(image.id).node_rowid, image.node_rowid);
});

test('large explicit rename is paged without a 2048-node limit and yields with no global transaction while other roots can write', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Large'));
  const otherPath = path.join(path.dirname(f.source), 'Other Root'),
    otherRoot = idFor(otherPath);
  f.seed(otherPath, null, 0, 'folder', otherRoot);
  f.db.exec('BEGIN');
  for (let i = 0; i < 2052; i++)
    f.seed(path.join(album.path, `Image ${i}.jpg`), album.id, 2, 'image');
  f.db.exec('COMMIT');
  let checkpoints = 0;
  const newPath = path.join(f.source, 'Large Renamed');
  const plan = await f.service.prepare(
    { id: album.id, newPath, operationId: 'large' },
    async () => {
      assert.equal(f.db.isTransaction, false);
      f.db
        .prepare("UPDATE nodes SET custom_character_note='unrelated write' WHERE id=?")
        .run(otherRoot);
      checkpoints++;
    }
  );
  assert.equal(plan.count, 2053);
  assert.ok(checkpoints > 16);
  f.service.commit(plan);
  assert.equal(
    f.db.prepare('SELECT count(*) n FROM nodes WHERE parent=?').get(idFor(newPath)).n,
    2052
  );
  assert.equal(f.get(otherRoot).custom_character_note, 'unrelated write');
});

test('target collisions, late children and stale plans reject without partial writes or a commit receipt', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Old')),
    target = f.seed(path.join(f.source, 'Occupied'));
  const before = f.snapshot();
  await assert.rejects(
    f.service.prepare({ id: album.id, newPath: target.path, operationId: 'collision' }),
    { code: 'RENAME_CONFLICT' }
  );
  assert.deepEqual(f.snapshot(), before);
  const newPath = path.join(f.source, 'New');
  const plan = await f.service.prepare({ id: album.id, newPath, operationId: 'late' });
  f.seed(path.join(album.path, 'Late Child'), album.id, 2);
  assert.throws(() => f.service.commit(plan), { code: 'RENAME_CHANGED' });
  assert.ok(f.get(album.id));
  assert.equal(f.get(idFor(newPath)), undefined);
  assert.equal(f.service.isCommitted('late'), false);
  f.service.dispose(plan);
  assert.throws(() => f.service.commit(plan), { code: 'RENAME_PLAN' });
});

test('a media update failure rolls nodes, references, FTS, queue and the DB commit receipt back atomically', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Old')),
    image = f.seed(path.join(album.path, 'image.jpg'), album.id, 2, 'image');
  f.db.prepare('UPDATE nodes SET cover=? WHERE id=?').run(image.id, album.id);
  f.db.prepare("INSERT INTO media(id,revision,status) VALUES(?,'revision','ready')").run(image.id);
  f.db.prepare("INSERT INTO match_pending VALUES(?,?,'stamp')").run(album.id, f.root);
  f.db.exec(
    "CREATE TRIGGER reject_media BEFORE UPDATE OF id ON media BEGIN SELECT RAISE(ABORT,'injected media migration failure'); END;"
  );
  const before = f.snapshot(),
    plan = await f.service.prepare({
      id: album.id,
      newPath: path.join(f.source, 'New'),
      operationId: 'rollback'
    });
  assert.throws(() => f.service.commit(plan), /injected media migration failure/u);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.isCommitted('rollback'), false);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER reject_media');
  f.service.commit(plan);
  assert.equal(f.service.isCommitted('rollback'), true);
});

test('frontier migration requires an eligibility/stamp callback and exact no-op adds no receipt or matching work', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Album'));
  const before = f.snapshot();
  const plan = await f.service.prepare({ id: album.id, newPath: album.path, operationId: 'noop' });
  assert.equal(f.service.commit(plan).renamed, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.service.isCommitted('noop'), false);
  f.db.prepare("INSERT INTO match_frontier VALUES(?,'')").run(f.root);
  await assert.rejects(
    f.service.prepare({
      id: album.id,
      newPath: path.join(f.source, 'New'),
      operationId: 'frontier'
    }),
    { code: 'RENAME_FRONTIER' }
  );
  assert.ok(f.get(album.id));
  assert.equal(f.service.isCommitted('frontier'), false);
});

test('persisted receipt drives startup FS recovery and survives rebuilding the service', async (t) => {
  const f = fixture(t),
    album = f.seed(path.join(f.source, 'Old')),
    newPath = path.join(f.source, 'New');
  f.service.commit(await f.service.prepare({ id: album.id, newPath, operationId: 'persisted' }));
  const restarted = createRenameIdentity(f.db);
  const result = await restarted.recover({
    fsRename: {
      recover: async ({ isCommitted }) => [
        { op: 'persisted', committed: await isCommitted('persisted') },
        { op: 'uncommitted', committed: await isCommitted('uncommitted') }
      ]
    }
  });
  assert.deepEqual(result, [
    { op: 'persisted', committed: true },
    { op: 'uncommitted', committed: false }
  ]);
  assert.equal(restarted.committed('persisted').path, newPath);
});
