'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { normalize, subjectNames } = require('../src/model.cjs');

// Observe only the connection argument; every statement still executes against
// the real SQLite database through the production reader and search functions.
function observedReader() {
  const filename = path.resolve(__dirname, '../src/local-index.cjs');
  const nativeRequire = createRequire(filename),
    opened = [];
  function ObservedDatabaseSync(databasePath, options) {
    const db = new DatabaseSync(databasePath, options);
    opened.push({ databasePath, options, db });
    return db;
  }
  const module = { exports: {} };
  const load = (name) =>
    name === 'node:sqlite' ? { DatabaseSync: ObservedDatabaseSync } : nativeRequire(name);
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], {
    filename
  })(load, module, module.exports);
  return { createLocalIndex: module.exports.createLocalIndex, opened };
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acg-readonly-index-')));
  // A literal question mark is legal on macOS/POSIX, but Windows cannot create
  // such an entry. The native Mac fixture exercises that character as well.
  const resourcesPath = path.join(
    root,
    '中文 #百分% 空格' + (process.platform === 'win32' ? '' : ' ?')
  );
  const directory = path.join(resourcesPath, 'local-index');
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, 'subjects.sqlite');
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
      CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT,PRIMARY KEY(subject_id,key)) WITHOUT ROWID;
      CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
      CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT,PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT,PRIMARY KEY(kind,id,key)) WITHOUT ROWID;
      CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
      CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT,source TEXT);
      CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
      CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
      CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');
      BEGIN;`);
    db.prepare('INSERT INTO metadata VALUES(?,?)').run(
      'source',
      JSON.stringify({
        mode: 'full-fixture',
        rawRecordsPreserved: true,
        dataVersion: 'readonly-fixture'
      })
    );
    for (const entry of [
      { id: 172612, name: '千恋＊万花', aliases: ['千恋万花'], date: '2016-07-29' },
      { id: 232, name: 'AIR', aliases: ['エアー'], date: '2000-09-08' }
    ]) {
      const subject = {
        type: 4,
        name_cn: '',
        summary: '用于只读内置离线索引的完整简介。',
        collection: { collect: 100 },
        ...entry
      };
      db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        subject.id,
        subject.type,
        subject.name,
        subject.name_cn,
        0,
        subject.date,
        subject.summary,
        '[]',
        JSON.stringify(subject.collection),
        JSON.stringify(subject.aliases),
        JSON.stringify(subject)
      );
      for (const name of subjectNames(subject))
        db.prepare('INSERT OR IGNORE INTO name_keys VALUES(?,?,?,?,?)').run(
          subject.id,
          subject.type,
          normalize(name),
          name,
          'name'
        );
    }
    for (const entity of [
      { kind: 'character', id: 39360, name: '朝武芳乃' },
      { kind: 'person', id: 5795, name: 'こぶいち' }
    ]) {
      db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?)').run(
        entity.kind,
        entity.id,
        entity.name,
        '',
        '人物简介',
        '[]',
        '[]',
        '{}'
      );
      db.prepare('INSERT INTO entity_keys VALUES(?,?,?,?)').run(
        entity.kind,
        entity.id,
        normalize(entity.name),
        entity.name
      );
      db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?)').run(
        'subject',
        172612,
        entity.kind,
        entity.id,
        entity.kind === 'character' ? 'character' : 'illustrator',
        'fixture'
      );
    }
    db.exec(`INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys;
      INSERT INTO entity_names_fts SELECT key,kind,id FROM entity_keys;
      COMMIT;
      PRAGMA wal_checkpoint(TRUNCATE);`);
  } finally {
    db.close();
  }
  fs.writeFileSync(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      variant: 'full',
      bundled: true,
      readerSchemaVersion: 1,
      dataVersion: 'readonly-fixture',
      database: 'subjects.sqlite'
    })
  );
  const readers = [];
  t.after(() => {
    for (const reader of readers) reader.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = (options, createLocalIndex) => {
    const reader = createLocalIndex(options);
    readers.push(reader);
    return reader;
  };
  const bytes = fs.readFileSync(filename);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(bytes[18], 2);
  assert.equal(bytes[19], 2);
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.equal(fs.existsSync(filename + suffix), false);
  return { root, resourcesPath, directory, filename, open };
}
function snapshot(f) {
  const stat = fs.statSync(f.filename, { bigint: true });
  return {
    sha256: createHash('sha256').update(fs.readFileSync(f.filename)).digest('hex'),
    bytes: stat.size,
    mtimeNs: stat.mtimeNs,
    entries: fs.readdirSync(f.directory).sort()
  };
}
function assertQueries(reader) {
  for (const { id, ...query } of [
    { query: '千恋＊万花', kind: 'subject', types: [4], id: 172612 },
    { query: 'AIR', kind: 'subject', types: [4], id: 232 },
    { query: '朝武芳乃', kind: 'character', subjectId: 172612, id: 39360 },
    { query: 'こぶいち', kind: 'person', subjectId: 172612, id: 5795 }
  ]) {
    const result = reader.search(query);
    assert.equal(result.available, true, JSON.stringify(result));
    assert.ok(
      result.candidates.some((candidate) => candidate.id === id),
      JSON.stringify(result)
    );
  }
  assert.equal(reader.readSubject(172612).name, '千恋＊万花');
  assert.equal(reader.readCharacter(39360).name, '朝武芳乃');
  assert.ok(reader.staffFor(172612).some((person) => person.id === 5795));
}

test('Darwin bundled WAL reader uses an encoded immutable URI and preserves database bytes without sidecars', (t) => {
  const f = fixture(t),
    observed = observedReader(),
    before = snapshot(f);
  const reader = f.open(
    { resourcesPath: f.resourcesPath, platform: 'darwin' },
    observed.createLocalIndex
  );
  assert.deepEqual(reader.status(), {
    available: true,
    variant: 'full',
    dataVersion: 'readonly-fixture',
    entities: ['subject', 'person', 'character'],
    path: f.filename
  });
  assert.equal(observed.opened.length, 1);
  const connection = observed.opened[0];
  const expected = pathToFileURL(f.filename);
  expected.searchParams.set('mode', 'ro');
  expected.searchParams.set('immutable', '1');
  assert.equal(connection.databasePath, expected.href);
  assert.deepEqual(connection.options, { readOnly: true });
  assert.equal(fileURLToPath(connection.databasePath), f.filename);
  assert.match(connection.databasePath, /%20/);
  assert.match(connection.databasePath, /%23/);
  assert.match(connection.databasePath, /%25/);
  assert.match(connection.databasePath, /%E4%B8%AD/);
  if (process.platform !== 'win32') assert.match(connection.databasePath, /%3F/);
  assert.equal(new URL(connection.databasePath).hash, '');
  assert.deepEqual(
    [...new URL(connection.databasePath).searchParams],
    [
      ['mode', 'ro'],
      ['immutable', '1']
    ]
  );
  assert.equal(connection.db.prepare('PRAGMA query_only').get().query_only, 1);
  assert.throws(() => connection.db.exec("UPDATE subjects SET summary='forbidden'"), /readonly/i);
  assertQueries(reader);
  assert.deepEqual(snapshot(f), before, 'an open immutable reader must not add WAL/SHM files');
  reader.close();
  assert.deepEqual(snapshot(f), before);
});

test('Windows, Linux and all explicit overrides retain ordinary read-only connection paths', (t) => {
  const f = fixture(t);
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const override of [false, true]) {
      if (platform === 'darwin' && !override) continue;
      const observed = observedReader();
      const reader = f.open(
        {
          platform,
          resourcesPath: f.resourcesPath,
          ...(override ? { localIndexPath: f.filename } : {})
        },
        observed.createLocalIndex
      );
      assert.equal(reader.status().available, true, JSON.stringify(reader.status()));
      assert.equal(observed.opened[0].databasePath, f.filename);
      assert.deepEqual(observed.opened[0].options, { readOnly: true });
      assert.equal(observed.opened[0].db.prepare('PRAGMA query_only').get().query_only, 1);
      assertQueries(reader);
      reader.close();
    }
  }
});

test('Darwin explicit override still detects committed changes to the same bundled-looking filename', (t) => {
  const f = fixture(t),
    observed = observedReader();
  const writer = new DatabaseSync(f.filename);
  try {
    const reader = f.open(
      { platform: 'darwin', resourcesPath: f.resourcesPath, localIndexPath: f.filename },
      observed.createLocalIndex
    );
    const before = reader.readSubject(172612).summary;
    writer
      .prepare('UPDATE subjects SET summary=? WHERE id=?')
      .run('来自外部可变索引的新提交', 172612);
    assert.notEqual(reader.readSubject(172612).summary, before);
    assert.equal(reader.readSubject(172612).summary, '来自外部可变索引的新提交');
    assert.equal(observed.opened[0].databasePath, f.filename);
    reader.close();
  } finally {
    writer.close();
  }
});

test('Darwin bundled opening preserves manifest/schema rejection and the optional Standard index behavior', (t) => {
  const f = fixture(t),
    observed = observedReader();
  fs.writeFileSync(
    path.join(f.directory, 'manifest.json'),
    JSON.stringify({ readerSchemaVersion: 99 })
  );
  const rejected = f.open(
    { platform: 'darwin', resourcesPath: f.resourcesPath },
    observed.createLocalIndex
  );
  assert.equal(rejected.status().available, false);
  assert.match(rejected.status().error, /Unsupported local index schema version/);
  assert.equal(observed.opened.length, 0);
  fs.writeFileSync(path.join(f.directory, 'manifest.json'), '{}');
  const writer = new DatabaseSync(f.filename);
  try {
    writer.exec('DROP TABLE entity_keys');
  } finally {
    writer.close();
  }
  const badSchema = f.open(
    { platform: 'darwin', resourcesPath: f.resourcesPath },
    observed.createLocalIndex
  );
  assert.equal(badSchema.status().available, false);
  assert.match(badSchema.status().error, /entity_keys/);
  const missing = f.open(
    { platform: 'darwin', resourcesPath: path.join(f.root, 'standard-resources') },
    observed.createLocalIndex
  );
  assert.equal(missing.status().available, false);
  assert.equal(missing.status().error, undefined);
});
