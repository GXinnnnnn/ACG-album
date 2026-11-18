'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { pathKey, samePath, containsPath, pathCollation } = require('../src/filesystem-path.cjs');

// Exercise production modules with explicit platform/path semantics on any CI
// host. This does not change process.platform or touch a real album/profile.
function platformModules(platform, overrides = {}) {
  const cache = new Map();
  const runtime = Object.create(process);
  Object.defineProperty(runtime, 'platform', { value: platform });
  const api = platform === 'win32' ? path.win32 : path.posix;
  function load(file) {
    const absolute = path.resolve(__dirname, '../src', file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} };
    cache.set(absolute, module);
    const nativeRequire = createRequire(absolute);
    const requireFor = (name) => {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === 'node:path') return api;
      if (name.startsWith('./') && name.endsWith('.cjs'))
        return load(path.resolve(path.dirname(absolute), name));
      return nativeRequire(name);
    };
    vm.compileFunction(
      fs.readFileSync(absolute, 'utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname', 'process'],
      { filename: absolute }
    )(module.exports, requireFor, module, absolute, path.dirname(absolute), runtime);
    return module.exports;
  }
  return { load, runtime, api };
}
const workerSource = fs.readFileSync(path.resolve(__dirname, '../src/library-worker.cjs'), 'utf8');
function schema(db, platform) {
  // Evaluate the actual worker's initial schema, including its chosen UNIQUE
  // collation, instead of maintaining a second test-only schema definition.
  const statement = workerSource.match(/db\.exec\((`PRAGMA journal_mode=WAL;[\s\S]*?`)\);/u);
  assert.ok(statement, 'worker initialization SQL must be available');
  db.exec(
    vm.compileFunction(`return ${statement[1]}`, ['pathCollation'])(() => pathCollation(platform))
  );
}
function fixture(t, platform = 'darwin', overrides, rootOverride) {
  const modules = platformModules(platform, overrides);
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  schema(db, platform);
  db.exec('CREATE TABLE media(id TEXT PRIMARY KEY); CREATE TABLE scan_new(id TEXT PRIMARY KEY)');
  const { idFor } = modules.load('model.cjs');
  const rootPath =
    rootOverride || (platform === 'win32' ? 'C:\\图库\\Library' : '/Volumes/图库/Library');
  const root = idFor(rootPath);
  function seed(p, parent = root, depth = 1, kind = 'folder') {
    const id = idFor(p);
    db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth) VALUES(?,?,?,?,?,?,?,?)'
    ).run(id, root, parent, p, modules.api.basename(p), p, kind, depth);
    return db.prepare('SELECT rowid AS node_rowid,* FROM nodes WHERE id=?').get(id);
  }
  seed(rootPath, null, 0);
  return { db, modules, idFor, rootPath, root, seed };
}

function fakeStat(ino, directory = false) {
  return {
    dev: 1n,
    ino: BigInt(ino),
    birthtimeNs: 1700000000000000000n,
    nlink: directory ? 2n : 1n,
    isDirectory: () => directory,
    isFile: () => !directory,
    isSymbolicLink: () => false
  };
}
function virtualFilesystem({ caseInsensitive = false } = {}) {
  const base = '/Volumes/图库/Library';
  const paths = new Map(
    ['/', '/Volumes', '/Volumes/图库', base].map((p, i) => [p, fakeStat(i + 1, true)])
  );
  const denied = new Set(),
    extraEntries = new Map();
  const canonical = (p) =>
    [...paths.keys()].find((key) =>
      caseInsensitive ? key.toLowerCase() === p.toLowerCase() : key === p
    );
  const lstatSync = (p) => {
    const key = canonical(p);
    if (!key) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return paths.get(key);
  };
  const entries = (p) => {
    if (denied.has(p)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    const key = canonical(p);
    if (!key) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return (
      extraEntries.get(p) ||
      [...paths.keys()]
        .filter((child) => child !== key && path.posix.dirname(child) === key)
        .map((child) => path.posix.basename(child))
    ).map((name) => ({ name }));
  };
  return {
    base,
    paths,
    denied,
    extraEntries,
    fs: {
      lstatSync,
      opendirSync(p) {
        const items = entries(p);
        let cursor = 0;
        return { readSync: () => items[cursor++] || null, closeSync() {} };
      },
      promises: {
        lstat: async (p) => lstatSync(p),
        opendir: async (p) => ({
          async *[Symbol.asyncIterator]() {
            yield* entries(p);
          }
        })
      }
    }
  };
}

test('Windows path keys and hashes preserve the original algorithm, including UNC and Unicode', () => {
  const { idFor } = platformModules('win32').load('model.cjs');
  for (const p of [
    'C:\\图库\\AbC.JPG',
    'C:/图库/../Album/É.jpg',
    '\\\\NAS\\Share\\相册\\IMG.JPG'
  ]) {
    const original = path.win32.resolve(p).toLowerCase();
    assert.equal(pathKey(p, 'win32'), original);
    assert.equal(idFor(p), createHash('sha256').update(original).digest('hex').slice(0, 24));
  }
  assert.equal(samePath('C:\\Album\\a.jpg', 'c:/album/A.JPG', 'win32'), true);
  assert.equal(pathCollation('win32'), 'NOCASE');
});

test('macOS IDs retain case, Unicode spelling, literal backslashes and the full absolute path', () => {
  const { idFor } = platformModules('darwin').load('model.cjs');
  const paths = [
    '/Volumes/图库/Album/A.jpg',
    '/Volumes/图库/Album/a.jpg',
    '/Volumes/图库/Album/é.jpg',
    '/Volumes/图库/Album/e\u0301.jpg',
    '/Volumes/图库/Album/a\\b.jpg',
    '/Volumes/图库/Album/a/b.jpg',
    '/Volumes/另一卷/Album/A.jpg'
  ];
  assert.equal(new Set(paths.map(idFor)).size, paths.length);
  for (const p of paths) {
    assert.equal(pathKey(p, 'darwin'), p);
    assert.equal(idFor(p), createHash('sha256').update(p).digest('hex').slice(0, 24));
  }
  assert.equal(pathCollation('darwin'), 'BINARY');
});

test('containment handles roots, sibling boundaries and case-distinct macOS folders', () => {
  assert.equal(containsPath('/', '/Volumes/图库', 'darwin'), true);
  assert.equal(containsPath('/Volumes/Album', '/Volumes/Album/Child', 'darwin'), true);
  assert.equal(containsPath('/Volumes/Album', '/Volumes/album/Child', 'darwin'), false);
  assert.equal(containsPath('/Volumes/Album', '/Volumes/Album2/Child', 'darwin'), false);
  assert.equal(containsPath('/Volumes/Album', '/Volumes/Album/../Other', 'darwin'), false);
  assert.equal(containsPath('C:\\', 'c:\\Album', 'win32'), true);
  assert.equal(containsPath('C:\\ALBUM', 'c:\\album\\Child', 'win32'), true);
  assert.equal(containsPath('C:\\Album', 'D:\\Album', 'win32'), false);
  const cache = platformModules('darwin').load('cache-directory.cjs');
  assert.equal(cache.contains('/Volumes/Album', '/Volumes/album/Child'), false);
});

test('real worker schema admits case-distinct macOS paths and retains Windows NOCASE uniqueness', (t) => {
  const mac = fixture(t);
  const upper = mac.seed('/Volumes/图库/Library/Album');
  const lower = mac.seed('/Volumes/图库/Library/album');
  assert.notEqual(upper.id, lower.id);
  assert.equal(mac.db.prepare('SELECT count(*) n FROM nodes').get().n, 3);
  const win = fixture(t, 'win32');
  win.seed('C:\\图库\\Library\\Album');
  assert.throws(
    () =>
      win.db
        .prepare("INSERT INTO nodes(id,path) VALUES('other',?)")
        .run('c:\\图库\\library\\album'),
    /UNIQUE constraint failed: nodes.path/u
  );
});

test('macOS subtree rename keeps metadata without colliding with a case-distinct destination sibling', async (t) => {
  const f = fixture(t);
  const old = f.seed(f.rootPath + '/Old');
  const child = f.seed(old.path + '/é.jpg', old.id, 2, 'image');
  const sibling = f.seed(f.rootPath + '/album');
  f.db.prepare('UPDATE nodes SET favorite=1,cover=? WHERE id=?').run(child.id, old.id);
  const service = f.modules.load('rename-identity.cjs').createRenameIdentity(f.db);
  const plan = await service.prepare({
    id: old.id,
    newPath: f.rootPath + '/Album',
    operationId: 'macRename'
  });
  assert.equal(plan.caseOnly, false);
  const renamed = service.commit(plan);
  const album = f.db.prepare('SELECT rowid AS node_rowid,* FROM nodes WHERE id=?').get(renamed.id);
  assert.equal(album.node_rowid, old.node_rowid);
  assert.equal(album.favorite, 1);
  assert.equal(album.cover, f.idFor(f.rootPath + '/Album/é.jpg'));
  assert.equal(
    f.db.prepare('SELECT path FROM nodes WHERE id=?').get(sibling.id).path,
    sibling.path
  );
  assert.equal(
    f.db.prepare('SELECT parent FROM nodes WHERE path=?').get(f.rootPath + '/Album/é.jpg').parent,
    renamed.id
  );
  const casePlan = await service.prepare({
    id: renamed.id,
    newPath: f.rootPath + '/ALBUM',
    operationId: 'macCase'
  });
  assert.notEqual(casePlan.oldId, casePlan.id);
  assert.equal(casePlan.caseOnly, false, 'macOS case changes must follow an ID remap');
  service.dispose(casePlan);
});

test('scan identity uses exact macOS parent spelling and permits a case-distinct indexed peer', async (t) => {
  const virtual = virtualFilesystem();
  const { base, paths } = virtual;
  const stat = fakeStat;
  paths.set(base + '/Case.jpg', stat(50));
  const f = fixture(t, 'darwin', { 'node:fs': virtual.fs });
  const scan = f.modules.load('scan-identity.cjs');
  const service = scan.createScanIdentity(f.db);
  const old = f.seed(base + '/old.jpg', f.root, 1, 'image');
  const peer = f.seed(base + '/case.jpg', f.root, 1, 'image');
  f.db
    .prepare('UPDATE nodes SET fs_identity=?,favorite=1 WHERE id=?')
    .run(scan.identityFor(stat(50)), old.id);
  f.db.prepare('INSERT INTO media(id) VALUES(?)').run(old.id);
  const node = {
    ...old,
    id: f.idFor(base + '/Case.jpg'),
    path: base + '/Case.jpg',
    name: 'Case.jpg'
  };
  assert.equal(
    await service.prepare(
      {
        ...node,
        path: '/Volumes/图库/library/Case.jpg',
        id: f.idFor('/Volumes/图库/library/Case.jpg')
      },
      stat(50)
    ),
    null
  );
  const plan = await service.prepare(node, stat(50));
  assert.ok(plan);
  assert.equal(service.apply(plan, 100), true);
  assert.equal(f.db.prepare('SELECT favorite FROM nodes WHERE id=?').get(node.id).favorite, 1);
  assert.ok(f.db.prepare('SELECT id FROM media WHERE id=?').get(node.id));
  assert.equal(f.db.prepare('SELECT path FROM nodes WHERE id=?').get(peer.id).path, peer.path);
});

test('default APFS case-only scan move proves exact entries despite lstat accepting old aliases', async (t) => {
  const virtual = virtualFilesystem({ caseInsensitive: true });
  const { base, paths } = virtual;
  paths.set(base + '/Album', fakeStat(50, true));
  paths.set(base + '/Album/é.jpg', fakeStat(51));
  const f = fixture(t, 'darwin', { 'node:fs': virtual.fs });
  const scan = f.modules.load('scan-identity.cjs');
  const service = scan.createScanIdentity(f.db);
  const old = f.seed(base + '/album');
  const child = f.seed(old.path + '/é.jpg', old.id, 2, 'image');
  f.db
    .prepare('UPDATE nodes SET fs_identity=?,favorite=1 WHERE id=?')
    .run(scan.identityFor(fakeStat(50, true)), old.id);
  f.db
    .prepare('UPDATE nodes SET fs_identity=? WHERE id=?')
    .run(scan.identityFor(fakeStat(51)), child.id);
  f.db.prepare('UPDATE nodes SET cover=? WHERE id=?').run(child.id, old.id);
  f.db.prepare('INSERT INTO media(id) VALUES(?)').run(child.id);
  assert.equal(
    virtual.fs.lstatSync(old.path).ino,
    50n,
    'old spelling is still an alias on default APFS'
  );
  const node = { ...old, path: base + '/Album', id: f.idFor(base + '/Album'), name: 'Album' };
  const plan = await service.prepare(node, fakeStat(50, true));
  assert.ok(plan);
  assert.equal(plan.rows.length, 2);
  assert.equal(service.apply(plan, 100), true);
  const nextChild = f.idFor(node.path + '/é.jpg');
  assert.equal(
    f.db.prepare('SELECT favorite,cover FROM nodes WHERE id=?').get(node.id).cover,
    nextChild
  );
  assert.equal(f.db.prepare('SELECT favorite FROM nodes WHERE id=?').get(node.id).favorite, 1);
  assert.equal(f.db.prepare('SELECT parent FROM nodes WHERE id=?').get(nextChild).parent, node.id);
  assert.ok(f.db.prepare('SELECT id FROM media WHERE id=?').get(nextChild));
  assert.equal(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id), undefined);
});

test('APFS scan declines unknown spelling, an alias target, entry budget overflow and apply races', async (t) => {
  const virtual = virtualFilesystem({ caseInsensitive: true });
  const { base, paths, denied, extraEntries } = virtual;
  paths.set(base + '/Case.jpg', fakeStat(50));
  const f = fixture(t, 'darwin', { 'node:fs': virtual.fs });
  const scan = f.modules.load('scan-identity.cjs');
  const service = scan.createScanIdentity(f.db);
  const old = f.seed(base + '/case.jpg', f.root, 1, 'image');
  f.db
    .prepare('UPDATE nodes SET fs_identity=? WHERE id=?')
    .run(scan.identityFor(fakeStat(50)), old.id);
  const node = {
    ...old,
    path: base + '/Case.jpg',
    id: f.idFor(base + '/Case.jpg'),
    name: 'Case.jpg'
  };
  denied.add(base);
  assert.equal(await service.prepare(node, fakeStat(50)), null);
  denied.clear();
  extraEntries.set(
    base,
    Array.from({ length: 2049 }, (_, i) => 'unrelated-' + i)
  );
  assert.equal(await service.prepare(node, fakeStat(50)), null);
  extraEntries.clear();
  const alias = { ...node, path: base + '/CASE.jpg', id: f.idFor(base + '/CASE.jpg') };
  assert.equal(
    await service.prepare(alias, fakeStat(50)),
    null,
    'lstat success cannot prove the target spelling'
  );
  const plan = await service.prepare(node, fakeStat(50));
  assert.ok(plan);
  paths.set(old.path, paths.get(node.path));
  paths.delete(node.path);
  assert.equal(
    service.apply(plan, 100),
    false,
    'exact old spelling returning invalidates the plan'
  );
  assert.ok(f.db.prepare('SELECT id FROM nodes WHERE id=?').get(old.id));
});

test('APFS scan reads each directory once per validation phase for a shared subtree', async (t) => {
  const virtual = virtualFilesystem({ caseInsensitive: true });
  const { base, paths } = virtual;
  paths.set(base + '/Album', fakeStat(50, true));
  const f = fixture(t, 'darwin', { 'node:fs': virtual.fs });
  const scan = f.modules.load('scan-identity.cjs'),
    service = scan.createScanIdentity(f.db);
  const old = f.seed(base + '/album');
  f.db
    .prepare('UPDATE nodes SET fs_identity=? WHERE id=?')
    .run(scan.identityFor(fakeStat(50, true)), old.id);
  for (let i = 0; i < 120; i++) {
    const stat = fakeStat(100 + i),
      name = i + '.jpg';
    paths.set(base + '/Album/' + name, stat);
    const child = f.seed(old.path + '/' + name, old.id, 2, 'image');
    f.db.prepare('UPDATE nodes SET fs_identity=? WHERE id=?').run(scan.identityFor(stat), child.id);
  }
  const node = { ...old, path: base + '/Album', id: f.idFor(base + '/Album'), name: 'Album' };
  const plan = await service.prepare(node, fakeStat(50, true));
  assert.ok(plan);
  const opened = [],
    originalOpen = virtual.fs.opendirSync;
  virtual.fs.opendirSync = (p) => {
    opened.push(p);
    return originalOpen(p);
  };
  assert.equal(service.apply(plan, 100), true);
  assert.equal(new Set(opened).size, opened.length);
  assert.equal(opened.filter((p) => p === node.path).length, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM nodes WHERE parent=?').get(node.id).n, 120);
});

test(
  'real macOS filesystem preserves subtree identity after case-only directory rename',
  {
    skip: process.platform !== 'darwin'
  },
  async (t) => {
    const os = require('node:os');
    const temporary = fs.realpathSync(
      fs.mkdtempSync(path.join(process.env.ACG_MAC_TEST_ROOT || os.tmpdir(), 'acg-mac-data-'))
    );
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const oldPath = path.join(temporary, 'album');
    const nextPath = path.join(temporary, 'Album');
    fs.mkdirSync(oldPath);
    fs.writeFileSync(path.join(oldPath, '图e\u0301.jpg'), 'fixture');
    const f = fixture(t, 'darwin', undefined, temporary);
    const old = f.seed(oldPath);
    const child = f.seed(path.join(oldPath, '图e\u0301.jpg'), old.id, 2, 'image');
    const scan = f.modules.load('scan-identity.cjs');
    const service = scan.createScanIdentity(f.db);
    for (const node of [old, child])
      f.db
        .prepare('UPDATE nodes SET fs_identity=?,favorite=1 WHERE id=?')
        .run(scan.identityFor(fs.lstatSync(node.path, { bigint: true })), node.id);
    fs.renameSync(oldPath, nextPath);
    t.diagnostic('old case alias after rename: ' + fs.existsSync(oldPath));
    const node = { ...old, id: f.idFor(nextPath), path: nextPath, name: 'Album' };
    const plan = await service.prepare(node, fs.lstatSync(nextPath, { bigint: true }));
    assert.ok(plan);
    assert.equal(service.apply(plan, 100), true);
    assert.equal(f.db.prepare('SELECT favorite FROM nodes WHERE id=?').get(node.id).favorite, 1);
    const newChild = f.db.prepare('SELECT parent,path FROM nodes WHERE parent=?').get(node.id);
    assert.equal(newChild.path, path.join(nextPath, '图e\u0301.jpg'));
  }
);

test('macOS timeline scope selects only the exact case and handles SQL wildcard characters literally', (t) => {
  const f = fixture(t);
  const album = f.seed(f.rootPath + '/A_%');
  const peer = f.seed(f.rootPath + '/a_%');
  f.seed(album.path + '/one.jpg', album.id, 2, 'image');
  f.seed(peer.path + '/two.jpg', peer.id, 2, 'image');
  const body = workerSource.slice(
    workerSource.indexOf('function browseWhere('),
    workerSource.indexOf('\nfunction list(')
  );
  const browseWhere = vm.compileFunction(`${body}; return browseWhere;`, [
    'path',
    'process',
    'rootRemoval',
    'getNode'
  ])(path.posix, { platform: 'darwin' }, { visibleSql: () => '1' }, (id) =>
    f.db.prepare('SELECT * FROM nodes WHERE id=?').get(id)
  );
  const query = browseWhere({ parent: album.id, timeline: true });
  const rows = f.db
    .prepare(`SELECT n.path FROM nodes n WHERE ${query.where.join(' AND ')}`)
    .all(...query.args);
  assert.deepEqual(
    rows.map((r) => r.path),
    [album.path + '/one.jpg']
  );
});

test('macOS removal blockers distinguish case siblings and recognize root containment', async (t) => {
  const f = fixture(t);
  const removal = f.modules.load('root-removal.cjs').createRootRemoval(f.db);
  t.after(() => removal.stop());
  f.db
    .prepare('INSERT INTO root_removals(root,path,name,removed_at) VALUES(?,?,?,1)')
    .run('removed', f.rootPath + '/Album', 'Album');
  assert.equal(removal.blockers(f.rootPath + '/Album/child').length, 1);
  assert.equal(removal.blockers(f.rootPath + '/album/child').length, 0);
  assert.equal(removal.blockers('/').length, 1);
});

test('macOS browse preferences retain POSIX case, Unicode and backslash spelling', () => {
  const { normalizeBrowseSortPreferences } = require('../src/browse-date.cjs');
  const preference = { sort: 'contentDate', direction: 'desc' };
  const keys = [
    '/',
    '/Volumes/图库/Album',
    '/Volumes/图库/album',
    '/Volumes/图库/e\u0301',
    '/Volumes/图库/é',
    '/Volumes/图库/a\\b'
  ];
  const input = Object.fromEntries(keys.map((p) => [JSON.stringify(['library', p]), preference]));
  assert.deepEqual(normalizeBrowseSortPreferences(input, 'darwin'), input);
  for (const p of [
    'relative/path',
    'C:\\Library',
    '/Volumes/Album/',
    '/Volumes//Album',
    '/Volumes/./Album'
  ]) {
    assert.throws(
      () =>
        normalizeBrowseSortPreferences({ [JSON.stringify(['library', p])]: preference }, 'darwin'),
      /路径|规范化/u
    );
  }
  const oldKey = JSON.stringify(['library', 'c:\\图库\\album']);
  assert.deepEqual(normalizeBrowseSortPreferences({ [oldKey]: preference }, 'win32'), {
    [oldKey]: preference
  });
});
