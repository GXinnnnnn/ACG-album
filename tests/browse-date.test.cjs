'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const {
  createBrowseDate,
  CONTENT_DATE_VERSION,
  normalizeBrowseSortPreferences
} = require('../src/browse-date.cjs');
const { sortKey } = require('../src/natural-sort.cjs');

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  // Legacy shape deliberately has no cached column or browse indexes.
  db.exec(`CREATE TABLE nodes(id TEXT PRIMARY KEY,parent TEXT,missing INTEGER DEFAULT 0,
    kind TEXT,name TEXT,sortkey TEXT,birth REAL,mtime REAL);
    CREATE TABLE media(id TEXT PRIMARY KEY,taken REAL,date_source TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);
    PRAGMA recursive_triggers=ON;`);
  const insert = (id, birth, mtime, kind = 'image', parent = 'root', name = id) =>
    db
      .prepare('INSERT INTO nodes(id,parent,kind,name,sortkey,birth,mtime) VALUES(?,?,?,?,?,?,?)')
      .run(id, parent, kind, name, sortKey(name), birth, mtime);
  const node = (id) => db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
  const media = (id, taken, source) =>
    db
      .prepare(
        `INSERT INTO media(id,taken,date_source) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET taken=excluded.taken,date_source=excluded.date_source`
      )
      .run(id, taken, source);
  return { db, insert, node, media };
}

test('content date chooses the earlier valid filesystem date and preserves raw birth/mtime', (t) => {
  const f = fixture(t);
  createBrowseDate(f.db).migrate();
  const cases = [
    [500, 100, 100],
    [100, 500, 100],
    [null, 500, 500],
    [500, null, 500],
    [0, 500, 500],
    [-1, 500, 500],
    [500, Infinity, 500],
    [Infinity, 500, 500],
    [NaN, 500, 500],
    ['invalid', 500, 500],
    [0, null, 0],
    [null, null, 0],
    [Infinity, -1, 0],
    [8640000000000001, 500, 500]
  ];
  for (const [i, [birth, mtime, expected]] of cases.entries()) {
    f.insert('file-' + i, birth, mtime);
    assert.equal(f.node('file-' + i).content_date, expected);
  }
  f.insert('folder', 900, 700, 'folder');
  f.media('folder', 10, 'exif-local');
  assert.equal(
    f.node('folder').content_date,
    900,
    'copied folder keeps creation date despite an older modification date and ignores media EXIF'
  );
  for (const [i, [birth, mtime, expected]] of [
    [null, 700, 700],
    [0, 700, 700],
    [-1, 700, 700],
    [Infinity, 700, 700],
    [NaN, 700, 700],
    ['invalid', 700, 700],
    [8640000000000001, 700, 700],
    [900, null, 900],
    [900, Infinity, 900],
    [null, null, 0],
    [0, -1, 0]
  ].entries()) {
    f.insert('folder-' + i, birth, mtime, 'folder');
    assert.equal(f.node('folder-' + i).content_date, expected);
  }
  f.insert('other', 900, 700, 'document');
  f.media('other', 10, 'exif-local');
  assert.equal(f.node('other').content_date, 700, 'other file kinds ignore media EXIF');
  const raw = f.node('file-0');
  assert.equal(raw.birth, 500, 'date continues to mean creation');
  assert.equal(raw.mtime, 100, 'modified continues to mean modification');
});

test('media metadata insert/update/delete immediately changes cached date with EXIF-only precedence', (t) => {
  const f = fixture(t);
  createBrowseDate(f.db).migrate();
  f.insert('image', 900, 700);
  f.insert('video', 800, 600, 'video');
  for (const id of ['image', 'video']) {
    const fallback = id === 'image' ? 700 : 600;
    f.media(id, 50, 'mtime');
    assert.equal(f.node(id).content_date, fallback, 'media fallback taken is not a capture date');
    for (const source of ['exif-local', 'exif-offset']) {
      for (const taken of [1200, 50, 0, -2208988800000, -8640000000000000, 8640000000000000]) {
        f.media(id, taken, source);
        assert.equal(
          f.node(id).content_date,
          taken,
          'valid EXIF overrides even an earlier filesystem date'
        );
      }
      for (const invalid of [null, NaN, Infinity, -Infinity, 'invalid', 8640000000000001]) {
        f.media(id, invalid, source);
        assert.equal(f.node(id).content_date, fallback, 'invalid EXIF falls back');
      }
    }
    f.media(id, 100, 'exif-offset');
    f.db.prepare('UPDATE media SET date_source=? WHERE id=?').run('birth', id);
    assert.equal(f.node(id).content_date, fallback, 'source-only update is observed');
    f.media(id, 100, 'exif-offset');
    f.db.prepare('DELETE FROM media WHERE id=?').run(id);
    assert.equal(
      f.node(id).content_date,
      fallback,
      'deleting metadata restores the filesystem date'
    );
  }
});

test('node refresh, kind change and both rename ID update orders converge without stale cached EXIF', (t) => {
  const f = fixture(t);
  createBrowseDate(f.db).migrate();
  f.insert('file', 900, 700);
  f.db.prepare('UPDATE nodes SET mtime=100 WHERE id=?').run('file');
  assert.equal(f.node('file').content_date, 100, 'file mtime refresh invalidates the date cache');
  f.db.prepare('UPDATE nodes SET birth=50 WHERE id=?').run('file');
  assert.equal(f.node('file').content_date, 50, 'birth refresh is observed');
  f.media('file', 2000, 'exif-offset');
  f.db.prepare('UPDATE nodes SET kind=? WHERE id=?').run('folder', 'file');
  assert.equal(f.node('file').content_date, 50);
  f.db.prepare('UPDATE nodes SET birth=900 WHERE id=?').run('file');
  assert.equal(f.node('file').content_date, 900, 'folder creation date wins over older mtime');
  f.db.prepare('UPDATE nodes SET kind=? WHERE id=?').run('video', 'file');
  assert.equal(f.node('file').content_date, 2000);
  f.db.exec(`BEGIN; UPDATE nodes SET id='renamed' WHERE id='file';
    UPDATE media SET id='renamed' WHERE id='file'; COMMIT;`);
  assert.equal(f.node('renamed').content_date, 2000, 'explicit rename nodes-first keeps EXIF');
  f.db.exec(`BEGIN; UPDATE media SET id='again' WHERE id='renamed';
    UPDATE nodes SET id='again' WHERE id='renamed'; COMMIT;`);
  assert.equal(f.node('again').content_date, 2000, 'media-first recovery keeps EXIF');
  f.media('preseeded', 123, 'exif-local');
  f.insert('preseeded', 900, 700);
  assert.equal(
    f.node('preseeded').content_date,
    123,
    'node inserted after existing metadata is synced'
  );
});

test('legacy migration backfills once with atomic marker and indexed natural-name/ID ties', (t) => {
  const f = fixture(t);
  f.insert('z-id', 900, 700, 'image', 'root', 'image2');
  f.insert('a-id', 800, 700, 'image', 'root', 'image02');
  f.insert('folder', null, 600, 'folder');
  f.media('z-id', 100, 'exif-local');
  f.media('a-id', 100, 'exif-offset');
  const dates = createBrowseDate(f.db);
  assert.equal(dates.ready(), false);
  assert.equal(f.node('z-id').content_date, null, 'schema-only cached startup does not backfill');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
  dates.migrate();
  assert.equal(dates.ready(), true);
  assert.equal(f.node('folder').content_date, 600);
  assert.equal(
    JSON.parse(
      f.db.prepare('SELECT value FROM settings WHERE key=?').get('browseContentDateVersion').value
    ),
    CONTENT_DATE_VERSION
  );
  for (const [prefix, predicate, params] of [
    ['parent', 'parent=? AND ', ['root']],
    ['global', '', []]
  ]) {
    for (const direction of ['ASC', 'DESC']) {
      const sql = `SELECT id FROM nodes WHERE ${predicate}missing=0 AND kind='image'
        ORDER BY content_date ${direction},sortkey ${direction},id ${direction} LIMIT 1 OFFSET ?`;
      const plan = f.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params, 1);
      assert.ok(plan.some((row) => row.detail.includes(`nodes_${prefix}_content_date`)));
      assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
      assert.equal(
        f.db.prepare(sql).get(...params, 1).id,
        direction === 'ASC' ? 'z-id' : 'a-id',
        'equal natural names use ID as the final deterministic tie'
      );
    }
  }
  const before = f.db.prepare('SELECT total_changes() AS n').get().n;
  const reopened = createBrowseDate(f.db);
  assert.equal(reopened.ready(), true);
  reopened.migrate();
  assert.equal(
    f.db.prepare('SELECT total_changes() AS n').get().n,
    before,
    'repeat startup/migration performs no node or setting writes'
  );
});

test('preview v1 folder cache and all five stale triggers upgrade before one background backfill', (t) => {
  const f = fixture(t);
  f.insert('copied', 900, 700, 'folder');
  createBrowseDate(f.db).migrate();
  // Recreate the prior preview contract under its real names and marker.
  for (const [suffix, event, identity] of [
    ['node_insert', 'AFTER INSERT ON nodes', 'rowid=NEW.rowid'],
    ['node_update', 'AFTER UPDATE OF birth,mtime,kind,id ON nodes', 'rowid=NEW.rowid'],
    ['media_insert', 'AFTER INSERT ON media', 'id=NEW.id'],
    ['media_update', 'AFTER UPDATE OF taken,date_source,id ON media', 'id=OLD.id OR id=NEW.id'],
    ['media_delete', 'AFTER DELETE ON media', 'id=OLD.id']
  ]) {
    f.db.exec(`DROP TRIGGER browse_date_${suffix};
      CREATE TRIGGER browse_date_${suffix} ${event} BEGIN
        UPDATE nodes SET content_date=min(birth,mtime) WHERE ${identity};
      END;`);
  }
  f.db.exec(`UPDATE nodes SET content_date=700 WHERE id='copied';
    UPDATE settings SET value='1' WHERE key='browseContentDateVersion';`);
  const dates = createBrowseDate(f.db);
  assert.equal(dates.ready(), false, 'v1 marker cannot expose stale dates as ready');
  assert.equal(
    f.node('copied').content_date,
    700,
    'startup trigger upgrade does not backfill rows'
  );
  dates.migrate();
  assert.equal(
    f.node('copied').content_date,
    900,
    'background backfill corrects existing folder dates'
  );
  assert.equal(
    f.db.prepare('SELECT value FROM settings WHERE key=?').get('browseContentDateVersion').value,
    JSON.stringify(CONTENT_DATE_VERSION)
  );
  f.insert('fresh', 1000, 600, 'folder');
  assert.equal(f.node('fresh').content_date, 1000, 'node insert trigger was replaced');
  f.db.prepare("UPDATE nodes SET birth=1100 WHERE id='fresh'").run();
  assert.equal(f.node('fresh').content_date, 1100, 'node update trigger was replaced');
  f.media('fresh', 10, 'exif-local');
  assert.equal(f.node('fresh').content_date, 1100, 'media insert trigger was replaced');
  f.media('fresh', 20, 'exif-offset');
  assert.equal(f.node('fresh').content_date, 1100, 'media update trigger was replaced');
  f.db.prepare("DELETE FROM media WHERE id='fresh'").run();
  assert.equal(f.node('fresh').content_date, 1100, 'media delete trigger was replaced');
});

test('failed legacy backfill rolls back cached dates, indexes and version before retry', (t) => {
  const f = fixture(t);
  f.insert('first', 900, 700);
  f.insert('failure', 800, 600);
  const dates = createBrowseDate(f.db);
  f.db.exec(`CREATE TRIGGER fail_date_migration BEFORE UPDATE OF content_date ON nodes
    WHEN NEW.id='failure' BEGIN SELECT RAISE(ABORT,'fixture date backfill failure'); END;`);
  assert.throws(() => dates.migrate(), /fixture date backfill failure/);
  assert.equal(dates.ready(), false);
  assert.equal(f.node('first').content_date, null);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM settings').get().n, 0);
  assert.equal(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'nodes_%_content_date'")
      .get().n,
    0
  );
  f.db.exec('DROP TRIGGER fail_date_migration');
  dates.migrate();
  assert.equal(f.node('first').content_date, 700);
  assert.equal(f.node('failure').content_date, 600);
});

test('async migration yields committed bounded batches and observes interleaved trigger updates', async (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 7; i++) f.insert('image-' + i, 900, i * 10);
  const dates = createBrowseDate(f.db);
  const progress = [];
  let interleaved = false,
    timerRan = false;
  setImmediate(() => {
    timerRan = true;
  });
  const task = dates.migrateAsync({
    batchSize: 2,
    onProgress(state) {
      progress.push(state);
      assert.equal(f.db.isTransaction, false, 'progress is published outside write transactions');
      if (state.stage === 'backfill' && state.processed === 2) {
        // Simulate callbacks queued between pages, including both rename orders.
        f.db.exec("BEGIN; UPDATE nodes SET id='renamed' WHERE id='image-1'; COMMIT");
        f.media('renamed', -100, 'exif-offset');
        f.db.prepare("UPDATE nodes SET birth=77,kind='folder' WHERE id='image-2'").run();
        f.insert('new', 500, 100);
        interleaved = true;
      }
      if (state.stage !== 'ready') {
        assert.equal(dates.ready(), false);
        assert.equal(
          f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get(),
          undefined
        );
      } else {
        assert.equal(dates.ready(), true);
        assert.equal(state.indexesCompleted, 2);
        assert.equal(
          f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get()
            .value,
          '2'
        );
      }
    }
  });
  assert.equal(dates.migrateAsync(), task, 'concurrent async calls share work');
  assert.throws(() => dates.migrate(), /already running/);
  assert.equal(await task, true);
  assert.ok(timerRan && interleaved);
  assert.deepEqual(
    progress.filter((p) => p.stage === 'backfill').map((p) => p.processed),
    [0, 2, 4, 6, 7]
  );
  assert.equal(f.node('renamed').content_date, -100);
  assert.equal(f.node('image-2').content_date, 77);
  assert.equal(
    f.node('new').content_date,
    100,
    'new rows outside the bounded snapshot use triggers'
  );
  assert.deepEqual(
    progress.filter((p) => p.stage === 'index' && p.blocking).map((p) => p.indexesCompleted),
    [0, 1]
  );
  assert.equal(dates.status().stage, 'ready');
  assert.deepEqual(
    progress.map((p) => p.revision),
    progress.map((_, i) => i + 1)
  );
  assert.equal(dates.status().revision, progress.at(-1).revision);
  const copy = dates.status();
  copy.ready = false;
  assert.equal(dates.status().ready, true, 'snapshots cannot mutate migration state');
});

test('async failure truly rolls back its entire batch and cursor, retaining earlier durable batches', async (t) => {
  const f = fixture(t);
  for (let i = 1; i <= 4; i++) f.insert('image-' + i, 900, i * 10);
  const dates = createBrowseDate(f.db);
  f.db.exec(`CREATE TRIGGER fail_async_date BEFORE UPDATE OF content_date ON nodes
    WHEN NEW.id='image-4' BEGIN SELECT RAISE(ABORT,'fixture async backfill failure'); END`);
  await assert.rejects(dates.migrateAsync({ batchSize: 2 }), /fixture async backfill failure/);
  assert.equal(dates.status().stage, 'error');
  assert.equal(dates.ready(), false);
  assert.equal(f.node('image-1').content_date, 10);
  assert.equal(f.node('image-2').content_date, 20);
  assert.equal(
    f.node('image-3').content_date,
    null,
    'earlier write within failed batch rolled back'
  );
  assert.equal(f.node('image-4').content_date, null);
  const cursor = JSON.parse(
    f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateCursor'").get().value
  );
  assert.equal(cursor.after, 2);
  assert.equal(cursor.processed, 2);
  assert.equal(
    f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get(),
    undefined
  );
  assert.equal(dates.status().indexesCompleted, 0);
  f.db.exec('DROP TRIGGER fail_async_date');
  const resumed = createBrowseDate(f.db);
  assert.equal(resumed.status().processed, 2);
  const batches = [];
  await resumed.migrateAsync({
    batchSize: 2,
    onProgress: (p) => {
      if (p.stage === 'backfill') batches.push(p.processed);
    }
  });
  assert.deepEqual(batches, [2, 4]);
  assert.equal(f.node('image-3').content_date, 30);
  assert.equal(
    f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateCursor'").get(),
    undefined
  );
});

test('async pause and real database reopen reuse cursor and a committed staged index', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  // Keep the tiny owned fixture as evidence; no user library or source paths are used.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-browse-date-reopen-'));
  const filename = path.join(directory, 'fixture.sqlite');
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) f.insert('image-' + i, 900, i * 10);
  const dates = createBrowseDate(f.db);
  let stop = false;
  assert.equal(
    await dates.migrateAsync({
      batchSize: 2,
      shouldStop: () => stop,
      onProgress(p) {
        if (p.stage === 'backfill' && p.processed === 2) stop = true;
      }
    }),
    false
  );
  assert.equal(dates.status().stage, 'paused');
  assert.equal(dates.ready(), false);
  // VACUUM INTO copies committed SQLite state, then a new connection actually opens it.
  f.db.prepare('VACUUM INTO ?').run(filename);
  let db = new DatabaseSync(filename);
  let reopened = createBrowseDate(db);
  const backfills = [];
  stop = false;
  assert.equal(
    await reopened.migrateAsync({
      batchSize: 2,
      shouldStop: () => stop,
      onProgress(p) {
        if (p.stage === 'backfill') backfills.push(p.processed);
        if (p.stage === 'index' && !p.blocking && p.indexesCompleted === 1) stop = true;
      }
    }),
    false
  );
  assert.deepEqual(backfills, [2, 4, 5]);
  assert.equal(reopened.ready(), false);
  assert.equal(reopened.status().indexesCompleted, 1);
  db.close();
  db = new DatabaseSync(filename);
  t.after(() => db.close());
  reopened = createBrowseDate(db);
  assert.equal(reopened.status().processed, 5);
  assert.equal(reopened.status().indexesCompleted, 1);
  assert.equal(await reopened.migrateAsync(), true);
  assert.equal(reopened.ready(), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE content_date IS NULL').get().n, 0);
});

test('async index failure leaves the version uncommitted and safely retries without backfilling again', async (t) => {
  const f = fixture(t);
  f.insert('first', 900, 100);
  const dates = createBrowseDate(f.db);
  // Name collision causes real CREATE INDEX failure after the parent index commits.
  f.db.exec('CREATE TABLE nodes_global_content_date(value TEXT)');
  await assert.rejects(dates.migrateAsync(), /already a table named nodes_global_content_date/);
  assert.equal(dates.ready(), false);
  assert.equal(dates.status().indexesCompleted, 1);
  assert.equal(
    f.db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get(),
    undefined
  );
  f.db.exec('DROP TABLE nodes_global_content_date');
  const writes = f.db.prepare('SELECT total_changes() n').get().n;
  await dates.migrateAsync();
  // Only the version insert and cursor delete change rows on retry.
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n - writes, 2);
  assert.equal(dates.ready(), true);
});

test('a version marker without both indexes remains unavailable until repaired', async (t) => {
  const f = fixture(t);
  createBrowseDate(f.db).migrate();
  f.db.exec('DROP INDEX nodes_global_content_date');
  const dates = createBrowseDate(f.db);
  assert.equal(dates.ready(), false);
  await dates.migrateAsync();
  assert.equal(dates.ready(), true);
  assert.equal(dates.status().indexesCompleted, 2);
});

const scope = (view, p = null) => JSON.stringify([view, p]);
test('browse preferences accept canonical Unicode, UNC and long Windows scopes without changing LRU order', () => {
  const input = {};
  const paths = [
    null,
    'c:\\',
    'c:\\照片\\相册2',
    '\\\\server\\share',
    '\\\\server\\share\\相册',
    '\\\\?\\c:\\',
    '\\\\?\\unc\\server\\share',
    'c:\\' + '图'.repeat(4093)
  ];
  for (const [i, p] of paths.entries())
    input[scope('library', p)] = { direction: 'desc', sort: i % 2 ? 'contentDate' : 'date' };
  const actual = normalizeBrowseSortPreferences(input);
  assert.deepEqual(Object.keys(actual), Object.keys(input));
  assert.deepEqual(actual, input);
  assert.equal(Object.keys(actual).at(-1).length > 4096, true);
  for (const view of ['library', 'favorites', 'pending', 'timeline'])
    for (const sort of ['name', 'date', 'modified', 'size', 'contentDate'])
      for (const direction of ['asc', 'desc'])
        assert.deepEqual(normalizeBrowseSortPreferences({ [scope(view)]: { sort, direction } }), {
          [scope(view)]: { sort, direction }
        });
  const cap = Object.fromEntries(
    Array.from({ length: 1024 }, (_, i) => [
      scope('library', 'c:\\album' + i),
      { sort: 'name', direction: 'asc' }
    ])
  );
  assert.equal(Object.keys(normalizeBrowseSortPreferences(cap)).length, 1024);
  cap[scope('library', 'c:\\overflow')] = { sort: 'name', direction: 'asc' };
  assert.throws(() => normalizeBrowseSortPreferences(cap));
});

test('browse preferences reject malformed scopes, extra fields and prototype pollution without mutating input', () => {
  const valid = { sort: 'name', direction: 'asc' };
  for (const bad of [
    null,
    [],
    'bad',
    Object.create({ injected: true }),
    { [scope('library')]: { sort: 'taken', direction: 'asc' } },
    { [scope('library')]: { sort: 'name', direction: 'up' } },
    { [scope('library')]: { ...valid, extra: true } },
    { [scope('library')]: { sort: 'name' } },
    { [scope('library')]: null },
    { [scope('library')]: Object.assign(Object.create({ polluted: true }), valid) },
    JSON.parse('{"__proto__":{"sort":"name","direction":"asc"}}'),
    { constructor: valid },
    { [Symbol('scope')]: valid },
    { [scope('unknown')]: valid },
    { '["library", null]': valid },
    { [scope('library', 'C:\\Album')]: valid },
    { [scope('library', 'c:/album')]: valid },
    { [scope('library', 'c:\\album\\')]: valid },
    { [scope('library', 'c:\\a\\..\\b')]: valid },
    { [scope('library', '\\\\server\\share\\')]: valid },
    { [scope('library', '\\relative')]: valid },
    { [scope('library', 'c:relative')]: valid },
    { [scope('library', 'c:\\bad\u0000path')]: valid },
    { [scope('library', 'c:\\' + 'x'.repeat(4094))]: valid },
    { ['x'.repeat(8193)]: valid }
  ])
    assert.throws(() => normalizeBrowseSortPreferences(bad));
  assert.equal({}.polluted, undefined);
  const input = { [scope('library')]: { direction: 'desc', sort: 'contentDate' } };
  const snapshot = JSON.stringify(input);
  normalizeBrowseSortPreferences(input);
  assert.equal(JSON.stringify(input), snapshot);
});
