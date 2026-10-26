'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  APP_NAME,
  resolveDataDirectory,
  resolveUserDataDirectory
} = require('../src/profile-path.cjs');

const schema = `
  CREATE TABLE nodes(id TEXT PRIMARY KEY, root TEXT, parent TEXT, path TEXT, name TEXT,
    kind TEXT, cover TEXT, crop_x REAL, crop_y REAL, manual_cover INTEGER, subject_id INTEGER);
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE metadata(id INTEGER PRIMARY KEY, json TEXT, updated REAL);
  INSERT INTO settings VALUES('nickname', '测试朋友');
  INSERT INTO metadata VALUES(1, '{"title":"fixture"}', 1);
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-profile-path-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.join(os.tmpdir(), 'acg-profile-path-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const documents = path.join(root, 'Documents');
  const appData = path.join(root, 'AppData');
  fs.mkdirSync(documents);
  fs.mkdirSync(appData);
  return { root, documents, appData };
}

function library(documents, name, sql = schema) {
  const directory = path.join(documents, name);
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'library.sqlite'));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
  return directory;
}

const existing = (...paths) => {
  const files = new Set(paths);
  return (file) => files.has(file);
};
const noScan = () => {
  throw new Error('unexpected discovery');
};

function snapshot(directory) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const filename = path.join(directory, name);
      const stat = fs.statSync(filename);
      return { name, bytes: fs.readFileSync(filename), size: stat.size, mtimeMs: stat.mtimeMs };
    });
}

test('fresh installs use the ACG-album library and Electron profile directories', (t) => {
  const { documents, appData } = fixture(t);
  assert.equal(APP_NAME, 'ACG-album');
  assert.equal(resolveDataDirectory({ documents }), path.join(documents, APP_NAME));
  assert.equal(resolveUserDataDirectory({ appData }), path.join(appData, APP_NAME));
  assert.deepEqual(fs.readdirSync(documents), []);
});

test('a missing Documents directory does not trigger discovery or create files', (t) => {
  const { root } = fixture(t);
  const documents = path.join(root, 'missing');
  assert.equal(
    resolveDataDirectory({ documents, opendirSync: noScan }),
    path.join(documents, APP_NAME)
  );
  assert.equal(fs.existsSync(documents), false);
});

test('an established canonical database wins without probing or inspecting other profiles', (t) => {
  const { documents } = fixture(t);
  library(documents, 'archive-one');
  library(documents, 'archive-two');
  const canonical = path.join(documents, APP_NAME);
  fs.mkdirSync(canonical);
  fs.writeFileSync(path.join(canonical, 'library.sqlite'), 'database awaiting repair');
  assert.equal(
    resolveDataDirectory({ documents, opendirSync: noScan, openDatabase: noScan }),
    canonical
  );
});

test('one verified library remains in place with all files and preferences unchanged', (t) => {
  const { documents } = fixture(t);
  const directory = library(documents, 'personal-collection');
  fs.writeFileSync(path.join(directory, 'token.bin'), Buffer.from([3, 1, 4]));
  fs.writeFileSync(path.join(directory, 'window.json'), '{"width":900}');
  const before = snapshot(directory);
  const opened = [];
  assert.equal(
    resolveDataDirectory({
      documents,
      openDatabase: (filename, options) => {
        assert.deepEqual(options, { readOnly: true });
        const db = new DatabaseSync(filename, options);
        assert.throws(
          () => db.exec("INSERT INTO settings VALUES('forbidden', 'write')"),
          /readonly/i
        );
        opened.push(db);
        return db;
      }
    }),
    directory
  );
  assert.deepEqual(snapshot(directory), before);
  assert.equal(fs.existsSync(path.join(documents, APP_NAME)), false);
  assert.equal(opened.length, 1);
  assert.throws(() => opened[0].prepare('SELECT 1'), /not open/i);
});

test('an empty canonical directory does not hide an existing verified library', (t) => {
  const { documents } = fixture(t);
  fs.mkdirSync(path.join(documents, APP_NAME));
  const directory = library(documents, 'saved-collection');
  assert.equal(resolveDataDirectory({ documents }), directory);
  assert.deepEqual(fs.readdirSync(path.join(documents, APP_NAME)), []);
});

test('multiple verified libraries fail deterministically with an explicit selection instruction', (t) => {
  const { documents } = fixture(t);
  const second = library(documents, 'z-collection');
  const first = library(documents, 'a-collection');
  const before = [snapshot(first), snapshot(second)];
  let messages = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () => resolveDataDirectory({ documents }),
      (error) => {
        assert.equal(error.code, 'ACG_PROFILE_SELECTION_REQUIRED');
        assert.match(error.message, /ACG_DATA_DIR/);
        assert.ok(error.message.indexOf(first) < error.message.indexOf(second));
        messages.push(error.message);
        return true;
      }
    );
  }
  assert.equal(messages[0], messages[1]);
  assert.deepEqual([snapshot(first), snapshot(second)], before);
  assert.equal(fs.existsSync(path.join(documents, APP_NAME)), false);
});

test('unrelated SQLite files, partial markers and nested libraries do not match', (t) => {
  const { documents } = fixture(t);
  library(documents, 'unrelated', 'CREATE TABLE notes(id TEXT, body TEXT)');
  library(
    documents,
    'partial',
    `
    CREATE TABLE settings(key TEXT, value TEXT);
    CREATE TABLE metadata(id INTEGER, json TEXT, updated REAL);
  `
  );
  library(
    documents,
    'views',
    `
    CREATE VIEW nodes AS SELECT '' AS id, '' AS root, '' AS parent, '' AS path, '' AS name,
      '' AS kind, '' AS cover, 50 AS crop_x, 50 AS crop_y, 0 AS manual_cover, 1 AS subject_id;
    CREATE TABLE settings(key TEXT, value TEXT);
    CREATE TABLE metadata(id INTEGER, json TEXT, updated REAL);
  `
  );
  const container = path.join(documents, 'container');
  fs.mkdirSync(container);
  library(container, 'nested');
  fs.mkdirSync(path.join(documents, 'empty'));
  fs.mkdirSync(path.join(documents, 'not-sqlite'));
  fs.writeFileSync(path.join(documents, 'not-sqlite', 'library.sqlite'), 'not a database');
  assert.equal(resolveDataDirectory({ documents }), path.join(documents, APP_NAME));
});

test('discovery closes its bounded iterator and fails before choosing an incomplete result', (t) => {
  const { documents } = fixture(t);
  let readCount = 0;
  let closed = false;
  assert.throws(
    () =>
      resolveDataDirectory({
        documents,
        opendirSync: (directory, options) => {
          assert.equal(directory, documents);
          assert.equal(options.bufferSize, 32);
          return {
            readSync: () => {
              readCount++;
              return {
                name: `file-${readCount}`,
                isDirectory: () => false,
                isSymbolicLink: () => false
              };
            },
            closeSync: () => {
              closed = true;
            }
          };
        },
        openDatabase: noScan
      }),
    /too many entries.*ACG_DATA_DIR/
  );
  assert.equal(readCount, 16385);
  assert.equal(closed, true);
});

test('ordinary Documents files do not exhaust discovery before an existing library is found', (t) => {
  const { documents } = fixture(t);
  const saved = library(documents, 'saved-collection');
  let count = 0;
  const resolved = resolveDataDirectory({
    documents,
    opendirSync: () => ({
      readSync: () => {
        if (++count <= 1024)
          return {
            name: `note-${count}.txt`,
            isDirectory: () => false,
            isSymbolicLink: () => false
          };
        if (count === 1025)
          return { name: 'saved-collection', isDirectory: () => true, isSymbolicLink: () => false };
        return null;
      },
      closeSync() {}
    })
  });
  assert.equal(resolved, saved);
});

test('an unreadable Documents directory fails with an actionable error', (t) => {
  const { documents } = fixture(t);
  assert.throws(
    () =>
      resolveDataDirectory({
        documents,
        opendirSync: () => {
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
      }),
    (error) => error.code === 'ACG_PROFILE_SELECTION_REQUIRED' && /ACG_DATA_DIR/.test(error.message)
  );
});

test('an unreadable database fails rather than selecting a new library and closes the iterator', (t) => {
  const { documents } = fixture(t);
  library(documents, 'saved-collection');
  let closed = false;
  assert.throws(
    () =>
      resolveDataDirectory({
        documents,
        opendirSync: (...args) => {
          const directory = fs.opendirSync(...args);
          return {
            readSync: () => directory.readSync(),
            closeSync: () => {
              closed = true;
              directory.closeSync();
            }
          };
        },
        openDatabase: () => {
          throw Object.assign(new Error('locked'), { errcode: 5 });
        }
      }),
    /Cannot verify.*ACG_DATA_DIR/
  );
  assert.equal(closed, true);
});

test('directory junctions are not traversed during discovery', (t) => {
  const { root, documents } = fixture(t);
  const outside = library(root, 'outside');
  const link = path.join(documents, 'linked-collection');
  fs.symlinkSync(outside, link, 'junction');
  assert.equal(
    resolveDataDirectory({ documents, openDatabase: noScan }),
    path.join(documents, APP_NAME)
  );
  assert.equal(fs.existsSync(path.join(outside, 'library.sqlite')), true);
});

test('linked Documents ancestors and canonical directories fail without traversal', (t) => {
  const { root, documents } = fixture(t);
  const linkedRoot = path.join(root, 'linked-documents');
  fs.symlinkSync(documents, linkedRoot, 'junction');
  assert.throws(
    () => resolveDataDirectory({ documents: linkedRoot, opendirSync: noScan }),
    /linked.*ACG_DATA_DIR/
  );
  const outside = library(root, 'outside');
  fs.symlinkSync(outside, path.join(documents, APP_NAME), 'junction');
  assert.throws(
    () => resolveDataDirectory({ documents, opendirSync: noScan }),
    /linked.*ACG_DATA_DIR/
  );
});

test('linked database files are skipped without opening them', (t) => {
  const { documents } = fixture(t);
  const directory = library(documents, 'saved-collection');
  const filename = path.join(directory, 'library.sqlite');
  const lstatSync = (target) =>
    target === filename ? { isSymbolicLink: () => true, isFile: () => true } : fs.lstatSync(target);
  assert.equal(
    resolveDataDirectory({ documents, lstatSync, openDatabase: noScan }),
    path.join(documents, APP_NAME)
  );
});

test('linked database sidecars fail before SQLite can follow them', (t) => {
  const { documents } = fixture(t);
  const directory = library(documents, 'saved-collection');
  const sidecar = path.join(directory, 'library.sqlite-wal');
  const lstatSync = (target) =>
    target === sidecar ? { isSymbolicLink: () => true, isFile: () => true } : fs.lstatSync(target);
  assert.throws(
    () => resolveDataDirectory({ documents, lstatSync, openDatabase: noScan }),
    /unsafe sidecar.*ACG_DATA_DIR/
  );
});

test('Chromium resolution only checks current and canonical profile paths', (t) => {
  const { appData } = fixture(t);
  const currentUserData = path.join(appData, 'current-profile');
  const canonical = path.join(appData, APP_NAME);
  const unrelated = path.join(appData, 'unrelated');
  assert.equal(
    resolveUserDataDirectory({
      appData,
      currentUserData,
      existsSync: existing(currentUserData, canonical, unrelated)
    }),
    currentUserData
  );
  assert.equal(
    resolveUserDataDirectory({
      appData,
      currentUserData,
      existsSync: existing(canonical, unrelated)
    }),
    canonical
  );
  assert.equal(resolveUserDataDirectory({ appData, existsSync: existing(unrelated) }), canonical);
});

test('explicit data overrides keep an isolated Chromium profile without scanning locations', (t) => {
  const { root, documents, appData } = fixture(t);
  const dataDir = path.join(root, 'custom-data');
  assert.equal(
    resolveDataDirectory({
      documents,
      dataDir,
      lstatSync: noScan,
      opendirSync: noScan,
      openDatabase: noScan
    }),
    path.resolve(dataDir)
  );
  assert.equal(
    resolveUserDataDirectory({ appData, dataDir, existsSync: noScan }),
    path.join(dataDir, 'chromium-profile')
  );
});
