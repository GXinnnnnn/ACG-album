'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');
const { createIndexing } = require('../src/indexing.cjs');
const { identityFor, readScanStat, createScanIdentity } = require('../src/scan-identity.cjs');

async function fixture(t, options) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-scan-identity-'));
  const source = path.join(tmp, 'source');
  await fs.mkdir(source);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,root TEXT,parent TEXT,path TEXT UNIQUE COLLATE NOCASE,
    name TEXT,sortkey TEXT,kind TEXT,depth INTEGER,bytes INTEGER DEFAULT 0,mtime REAL,birth REAL,
    missing INTEGER DEFAULT 0,indexed REAL,cover TEXT,cover_source TEXT,local_newest TEXT,
    crop_x REAL DEFAULT 50,crop_y REAL DEFAULT 50,crop_zoom REAL DEFAULT 1,
    favorite INTEGER DEFAULT 0,subject_id INTEGER,manual_subject INTEGER DEFAULT 0,
    character_id INTEGER,manual_character INTEGER DEFAULT 0,manual_cover INTEGER DEFAULT 0,
    confirmed INTEGER DEFAULT 0,intro INTEGER DEFAULT -1,album_kind TEXT DEFAULT 'auto',
    files INTEGER DEFAULT 0,folders INTEGER DEFAULT 0,total_bytes INTEGER DEFAULT 0);
    CREATE TABLE media(id TEXT PRIMARY KEY,revision TEXT,taken REAL,date_source TEXT,status TEXT,error TEXT,
    width INTEGER,height INTEGER,format TEXT,frames INTEGER,delays TEXT,camera TEXT,hdr INTEGER,
    depth INTEGER,space TEXT,has_icc INTEGER,orientation INTEGER,page_height INTEGER,loop INTEGER,
    latitude REAL,longitude REAL,place TEXT,coords_user INTEGER DEFAULT 0,place_user INTEGER DEFAULT 0);
    CREATE TABLE match_pending(id TEXT PRIMARY KEY,root TEXT,stamp TEXT);
    CREATE TABLE manual_title_keys(node_id TEXT PRIMARY KEY,name_key TEXT,subject_id INTEGER,type INTEGER,name TEXT);
    CREATE VIRTUAL TABLE search_index USING fts5(id UNINDEXED,name,tokenize='trigram');`);
  const indexing = createIndexing(db);
  const identities = createScanIdentity(db, options);
  const root = idFor(source);
  const node = (p, parent = root, depth = 1, kind = 'image') => ({
    id: idFor(p),
    root,
    parent,
    path: p,
    name: path.basename(p),
    sortkey: path.basename(p).toLowerCase(),
    kind,
    depth
  });
  const seed = async (p, parent = root, depth = 1, kind = 'image') => {
    const n = node(p, parent, depth, kind),
      s = await readScanStat(p);
    indexing.upsert(n, s, 1);
    return n;
  };
  await seed(source, null, 0, 'folder');
  indexing.reset();
  t.after(async () => {
    db.close();
    const resolved = path.resolve(tmp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-scan-identity-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { tmp, source, db, indexing, identities, root, node, seed };
}
const fake = (extras = {}) => ({
  dev: 7,
  ino: 42,
  birthtimeMs: 1700000000000.25,
  nlink: 1,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  ...extras
});

test('identity requires reliable dev/ino/birth, excludes symlinks and file hardlinks', () => {
  const identity = identityFor(fake());
  assert.equal(identity, 'v1:f:7:42:1700000000000');
  assert.equal(
    identityFor(fake({ dev: 7n, ino: 42n, birthtimeNs: 1700000000000250000n })),
    identity
  );
  assert.equal(
    identityFor(fake({ ino: 9007199254740993n })),
    'v1:f:7:9007199254740993:1700000000000'
  );
  for (const extras of [
    { ino: Number.MAX_SAFE_INTEGER + 1 },
    { ino: 0 },
    { dev: NaN },
    { birthtimeMs: 0 },
    { birthtimeMs: undefined },
    { nlink: 2 },
    { isSymbolicLink: () => true },
    { isFile: () => false }
  ])
    assert.equal(identityFor(fake(extras)), null);
  assert.match(identityFor(fake({ isDirectory: () => true, nlink: 2 })), /^v1:d:/);
});

test('readScanStat retains exact bigint inode and fractional millisecond metadata', async (t) => {
  const f = await fixture(t);
  const p = path.join(f.source, 'fraction.jpg');
  await fs.writeFile(p, 'abc');
  await fs.utimes(p, 1700000000.125, 1700000000.3755);
  const s = await readScanStat(p),
    normal = await fs.lstat(p);
  assert.equal(typeof s.ino, 'bigint');
  assert.equal(typeof s.size, 'number');
  assert.equal(s.size, normal.size);
  assert.ok(Math.abs(s.mtimeMs - normal.mtimeMs) < 0.001);
  assert.ok(Math.abs(s.birthtimeMs - normal.birthtimeMs) < 0.001);
  assert.equal(s.isFile(), true);
  assert.equal(s.fsIdentity, identityFor(s));
});

test('file rename keeps row, annotations, ready media and external cover references', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'old.jpg'),
    to = path.join(f.source, 'renamed.jpg');
  await fs.writeFile(from, 'abc');
  const old = await f.seed(from);
  f.db
    .prepare(
      `UPDATE nodes SET favorite=1,crop_x=23,crop_y=72,crop_zoom=2,
    subject_id=42,manual_subject=1,character_id=9,manual_character=1,
    manual_cover=1,confirmed=1,intro=1,album_kind='work' WHERE id=?`
    )
    .run(old.id);
  f.db.prepare('UPDATE nodes SET cover=?,local_newest=? WHERE id=?').run(old.id, old.id, f.root);
  f.db
    .prepare(
      `UPDATE media SET status='ready',width=200,height=300,place='local',place_user=1,
    latitude=12,longitude=34,coords_user=1 WHERE id=?`
    )
    .run(old.id);
  f.db.prepare('INSERT INTO match_pending VALUES(?,?,?)').run(old.id, f.root, 'old-task');
  const before = f.db.prepare('SELECT rowid,* FROM nodes WHERE id=?').get(old.id);
  const media = f.db.prepare('SELECT * FROM media WHERE id=?').get(old.id);
  await fs.rename(from, to);
  const n = f.node(to),
    s = await readScanStat(to);
  const plan = await f.identities.prepare(n, s);
  assert.ok(plan);
  f.db.exec('BEGIN');
  assert.equal(f.identities.apply(plan, 2), true);
  f.indexing.upsert(n, s, 2);
  f.db.exec('COMMIT');
  const saved = f.db.prepare('SELECT rowid,* FROM nodes WHERE id=?').get(n.id);
  for (const key of [
    'rowid',
    'favorite',
    'crop_x',
    'crop_y',
    'crop_zoom',
    'subject_id',
    'manual_subject',
    'character_id',
    'manual_character',
    'manual_cover',
    'confirmed',
    'intro',
    'album_kind'
  ])
    assert.equal(saved[key], before[key], key);
  assert.equal(saved.id, idFor(to));
  assert.equal(saved.path, to);
  assert.equal(saved.indexed, 2);
  assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id), undefined);
  assert.deepEqual(
    { ...f.db.prepare('SELECT * FROM media WHERE id=?').get(n.id) },
    { ...media, id: n.id }
  );
  assert.equal(f.db.prepare('SELECT cover FROM nodes WHERE id=?').get(f.root).cover, n.id);
  assert.equal(
    f.db.prepare('SELECT local_newest FROM nodes WHERE id=?').get(f.root).local_newest,
    n.id
  );
  assert.equal(f.db.prepare('SELECT id FROM search_index WHERE name=?').get(n.name).id, n.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM match_pending').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scan_new').get().n, 0);
  assert.equal(f.identities.apply(plan, 3), false, 'plans are single-use');
});

test('directory move atomically preserves complete subtree, depth, covers and explicit media settings', async (t) => {
  const f = await fixture(t);
  const album = path.join(f.source, 'album'),
    nested = path.join(album, 'nested');
  const destinationParent = path.join(f.source, 'destination');
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(destinationParent);
  const image = path.join(nested, 'photo.jpg');
  await fs.writeFile(image, 'abc');
  const a = await f.seed(album, f.root, 1, 'folder');
  const b = await f.seed(nested, a.id, 2, 'folder');
  const c = await f.seed(image, b.id, 3);
  const parent = await f.seed(destinationParent, f.root, 1, 'folder');
  f.db
    .prepare(
      `UPDATE nodes SET cover=?,local_newest=?,favorite=1,crop_zoom=2,
    subject_id=42,manual_subject=1,manual_cover=1,confirmed=1 WHERE id IN (?,?)`
    )
    .run(c.id, c.id, a.id, b.id);
  f.db.prepare('UPDATE nodes SET cover=?,local_newest=? WHERE id=?').run(c.id, c.id, f.root);
  f.db
    .prepare(
      `UPDATE media SET status='ready',width=42,place='local',place_user=1,
    latitude=12,longitude=34,coords_user=1 WHERE id=?`
    )
    .run(c.id);
  f.db
    .prepare('INSERT INTO manual_title_keys VALUES(?,?,?,?,?)')
    .run(a.id, 'trusted-old-name', 42, 4, 'Old title');
  f.indexing.reset();
  const to = path.join(destinationParent, 'renamed');
  await fs.rename(album, to);
  const n = f.node(to, parent.id, 2, 'folder'),
    s = await readScanStat(to);
  const plan = await f.identities.prepare(n, s);
  assert.ok(plan);
  assert.equal(f.identities.apply(plan, 2), true);
  f.indexing.upsert(n, s, 2);
  const nb = idFor(path.join(to, 'nested')),
    nc = idFor(path.join(to, 'nested', 'photo.jpg'));
  assert.equal(f.db.prepare('SELECT parent FROM nodes WHERE id=?').get(nb).parent, n.id);
  assert.equal(f.db.prepare('SELECT parent FROM nodes WHERE id=?').get(nc).parent, nb);
  assert.equal(f.db.prepare('SELECT depth FROM nodes WHERE id=?').get(nc).depth, 4);
  for (const id of [n.id, nb]) {
    const row = f.db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
    assert.equal(row.cover, nc);
    assert.equal(row.local_newest, nc);
    assert.equal(row.favorite, 1);
    assert.equal(row.crop_zoom, 2);
    assert.equal(row.subject_id, 42);
    assert.equal(row.manual_cover, 1);
  }
  assert.equal(f.db.prepare('SELECT cover FROM nodes WHERE id=?').get(f.root).cover, nc);
  const media = f.db.prepare('SELECT * FROM media WHERE id=?').get(nc);
  assert.equal(media.status, 'ready');
  assert.equal(media.width, 42);
  assert.equal(media.place, 'local');
  assert.equal(media.latitude, 12);
  assert.equal(media.longitude, 34);
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM nodes WHERE id IN (?,?,?)').get(a.id, b.id, c.id).n,
    0
  );
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scan_new').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM search_index').get().n, 5);
  const learned = f.db.prepare('SELECT * FROM manual_title_keys WHERE node_id=?').get(n.id);
  assert.equal(learned.name_key, 'trusted-old-name');
  assert.equal(learned.subject_id, 42);
  assert.equal(learned.name, 'Old title');
});

test('copy, hardlinks, legacy identity and multiple candidates do not infer a rename', async (t) => {
  const f = await fixture(t);
  const oldPath = path.join(f.source, 'original.jpg'),
    copy = path.join(f.source, 'copy.jpg');
  await fs.writeFile(oldPath, 'same content');
  const old = await f.seed(oldPath);
  await fs.copyFile(oldPath, copy);
  await fs.utimes(copy, (await fs.stat(oldPath)).atime, (await fs.stat(oldPath)).mtime);
  assert.equal(await f.identities.prepare(f.node(copy), await readScanStat(copy)), null);
  const link = path.join(f.source, 'link.jpg');
  await fs.link(oldPath, link);
  assert.equal(await f.identities.prepare(f.node(link), await readScanStat(link)), null);
  await fs.unlink(link);
  const moved = path.join(f.source, 'moved.jpg');
  await fs.rename(oldPath, moved);
  const n = f.node(moved),
    s = await readScanStat(moved);
  const identity = f.db.prepare('SELECT fs_identity FROM nodes WHERE id=?').get(old.id).fs_identity;
  f.db.prepare('UPDATE nodes SET fs_identity=NULL WHERE id=?').run(old.id);
  assert.equal(await f.identities.prepare(n, s), null, 'old databases cannot guess a rename');
  f.db.prepare('UPDATE nodes SET fs_identity=? WHERE id=?').run(identity, old.id);
  const duplicate = await f.seed(copy);
  f.db.prepare('UPDATE nodes SET fs_identity=? WHERE id=?').run(identity, duplicate.id);
  assert.equal(await f.identities.prepare(n, s), null, 'any second candidate rejects reuse');
});

test('different root and occupied target reject reuse', async (t) => {
  const f = await fixture(t);
  const oldPath = path.join(f.source, 'old.jpg'),
    moved = path.join(f.source, 'new.jpg');
  await fs.writeFile(oldPath, 'abc');
  const old = await f.seed(oldPath);
  await fs.rename(oldPath, moved);
  const n = f.node(moved),
    s = await readScanStat(moved);
  assert.equal(await f.identities.prepare({ ...n, root: 'another-root' }, s), null);
  f.indexing.upsert(n, s, 2);
  assert.equal(await f.identities.prepare(n, s), null);
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('directory identity mismatch or node limit rejects whole subtree without partial migration', async (t) => {
  const f = await fixture(t, { maxNodes: 2 });
  const album = path.join(f.source, 'album');
  await fs.mkdir(album);
  const a = await f.seed(album, f.root, 1, 'folder');
  for (const name of ['one.jpg', 'two.jpg']) {
    const p = path.join(album, name);
    await fs.writeFile(p, name);
    await f.seed(p, a.id, 2);
  }
  const moved = path.join(f.source, 'renamed');
  await fs.rename(album, moved);
  const n = f.node(moved, f.root, 1, 'folder'),
    s = await readScanStat(moved);
  assert.equal(await f.identities.prepare(n, s), null, 'bounded move cannot partially migrate');
  const unlimited = createScanIdentity(f.db);
  const one = path.join(moved, 'one.jpg');
  await fs.rename(one, path.join(f.tmp, 'saved-original.jpg'));
  await fs.writeFile(one, 'one.jpg');
  assert.equal(
    await unlimited.prepare(n, s),
    null,
    'recreated same-name file has different identity'
  );
  assert.equal(
    f.db.prepare('SELECT COUNT(*) n FROM nodes WHERE path LIKE ?').get(album + '%').n,
    3
  );
  assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(n.id), undefined);
});

test('apply revalidates source reappearance, destination replacement and single-use plans', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'old.jpg'),
    to = path.join(f.source, 'new.jpg');
  await fs.writeFile(from, 'abc');
  const old = await f.seed(from);
  await fs.rename(from, to);
  const n = f.node(to),
    s = await readScanStat(to);
  let plan = await f.identities.prepare(n, s);
  assert.ok(plan);
  await fs.writeFile(from, 'replacement at source');
  assert.equal(f.identities.apply(plan, 2), false);
  await fs.unlink(from);
  plan = await f.identities.prepare(n, s);
  assert.ok(plan);
  await fs.rename(to, path.join(f.tmp, 'saved.jpg'));
  await fs.writeFile(to, 'abc');
  assert.equal(f.identities.apply(plan, 2), false);
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('subtree symlink substitution is rejected without following it', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'album'),
    child = path.join(from, 'child');
  await fs.mkdir(child, { recursive: true });
  const a = await f.seed(from, f.root, 1, 'folder');
  await f.seed(child, a.id, 2, 'folder');
  const to = path.join(f.source, 'renamed');
  await fs.rename(from, to);
  const n = f.node(to, f.root, 1, 'folder'),
    s = await readScanStat(to);
  const plan = await f.identities.prepare(n, s);
  assert.ok(plan);
  await fs.rename(path.join(to, 'child'), path.join(f.tmp, 'saved-child'));
  try {
    await fs.symlink(path.join(f.tmp, 'saved-child'), path.join(to, 'child'), 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip('symlink unavailable');
      return;
    }
    throw error;
  }
  assert.equal(f.identities.apply(plan, 2), false);
  assert.equal(await f.identities.prepare(n, s), null);
});

test('permission failures are not evidence of removal and old existing paths reject reuse', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'old.jpg'),
    to = path.join(f.source, 'new.jpg');
  await fs.writeFile(from, 'abc');
  const old = await f.seed(from);
  await fs.rename(from, to);
  const n = f.node(to),
    s = await readScanStat(to);
  const originalLstat = fs.lstat;
  const mock = t.mock.method(fs, 'lstat', async (p, options) => {
    if (p === from) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return originalLstat(p, options);
  });
  assert.equal(await f.identities.prepare(n, s), null);
  mock.mock.restore();
  await fs.writeFile(from, 'new object at old path');
  assert.equal(await f.identities.prepare(n, s), null);
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('reference writes use indexes and are capped independently of subtree size', async (t) => {
  const f = await fixture(t, { maxNodes: 1 });
  const from = path.join(f.source, 'old.jpg'),
    to = path.join(f.source, 'new.jpg');
  await fs.writeFile(from, 'abc');
  const old = await f.seed(from);
  for (let i = 0; i < 4; i++) {
    const p = path.join(f.source, 'folder-' + i);
    await fs.mkdir(p);
    const folder = await f.seed(p, f.root, 1, 'folder');
    f.db.prepare('UPDATE nodes SET cover=? WHERE id=?').run(old.id, folder.id);
  }
  await fs.rename(from, to);
  assert.equal(await f.identities.prepare(f.node(to), await readScanStat(to)), null);
  const queryPlan = f.db
    .prepare('EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE cover=? LIMIT ?')
    .all(old.id, 4);
  assert.ok(queryPlan.some((row) => row.detail.includes('nodes_scan_cover')));
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('new database children invalidate a prepared whole-subtree plan', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'album'),
    to = path.join(f.source, 'renamed');
  await fs.mkdir(from);
  const old = await f.seed(from, f.root, 1, 'folder');
  await fs.rename(from, to);
  const n = f.node(to, f.root, 1, 'folder');
  const plan = await f.identities.prepare(n, await readScanStat(to));
  assert.ok(plan);
  const phantom = path.join(from, 'late.jpg');
  f.db
    .prepare(
      `INSERT INTO nodes(id,root,parent,path,name,kind,depth)
    VALUES(?,?,?,?,?,'image',2)`
    )
    .run(idFor(phantom), f.root, old.id, phantom, 'late.jpg');
  assert.equal(f.identities.apply(plan, 2), false);
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('already pruned directories can recover complete identity relationships', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'album'),
    to = path.join(f.source, 'renamed');
  await fs.mkdir(from);
  const p = path.join(from, 'image.jpg');
  await fs.writeFile(p, 'abc');
  const album = await f.seed(from, f.root, 1, 'folder');
  const image = await f.seed(p, album.id, 2);
  f.db
    .prepare('UPDATE nodes SET cover=?,manual_cover=1,crop_zoom=2 WHERE id=?')
    .run(image.id, album.id);
  f.db
    .prepare(
      "UPDATE media SET place='Explicit',place_user=1,latitude=12,longitude=34,coords_user=1 WHERE id=?"
    )
    .run(image.id);
  await fs.rename(from, to);
  await f.indexing.prune(f.root, 2, async () => {});
  assert.equal(f.db.prepare('SELECT missing FROM nodes WHERE id=?').get(album.id).missing, 1);
  const n = f.node(to, f.root, 1, 'folder');
  const plan = await f.identities.prepare(n, await readScanStat(to));
  assert.ok(plan);
  assert.equal(f.identities.apply(plan, 3), true);
  const newImage = idFor(path.join(to, 'image.jpg'));
  assert.equal(f.db.prepare('SELECT parent FROM nodes WHERE id=?').get(newImage).parent, n.id);
  assert.equal(f.db.prepare('SELECT cover FROM nodes WHERE id=?').get(n.id).cover, newImage);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM nodes WHERE missing=1').get().n, 0);
  assert.equal(f.db.prepare('SELECT place FROM media WHERE id=?').get(newImage).place, 'Explicit');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM search_index').get().n, 3);
});

test('savepoint rolls back every related write when a migration write fails', async (t) => {
  const f = await fixture(t);
  const from = path.join(f.source, 'old.jpg'),
    to = path.join(f.source, 'new.jpg');
  await fs.writeFile(from, 'abc');
  const old = await f.seed(from);
  await fs.rename(from, to);
  const n = f.node(to),
    plan = await f.identities.prepare(n, await readScanStat(to));
  f.db.exec(`CREATE TEMP TRIGGER reject_media_move BEFORE UPDATE OF id ON media
    BEGIN SELECT RAISE(ABORT,'test rollback'); END;`);
  assert.throws(() => f.identities.apply(plan, 2), /test rollback/);
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
  assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(n.id), undefined);
  assert.equal(f.db.prepare('SELECT id FROM search_index WHERE id=?').get(old.id).id, old.id);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM scan_identity_map').get().n, 0);
});
