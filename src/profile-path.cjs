'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'ACG-album';
const MAX_DOCUMENT_ENTRIES = 16384;
const PROFILE_COLUMNS = {
  nodes: [
    'id',
    'root',
    'parent',
    'path',
    'name',
    'kind',
    'cover',
    'crop_x',
    'crop_y',
    'manual_cover',
    'subject_id'
  ],
  settings: ['key', 'value'],
  metadata: ['id', 'json', 'updated']
};

function discoveryError(message, cause) {
  return Object.assign(
    new Error(`${message} Set ACG_DATA_DIR to the intended library directory and restart.`, {
      cause
    }),
    { code: 'ACG_PROFILE_SELECTION_REQUIRED' }
  );
}

function statOrNull(filename, lstatSync) {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw discoveryError('Cannot inspect a library location safely.', error);
  }
}

function inspectDirectory(directory, lstatSync) {
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = statOrNull(current, lstatSync);
    if (!stat) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw discoveryError('A library location is linked or is not a directory.');
    }
  }
  return true;
}

function verifyLibrarySchema(filename, openDatabase) {
  let db;
  try {
    db = openDatabase(filename, { readOnly: true });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=100;');
    const tables = new Set(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('nodes', 'settings', 'metadata')"
        )
        .all()
        .map((row) => row.name)
    );
    return Object.entries(PROFILE_COLUMNS).every(([table, required]) => {
      if (!tables.has(table)) return false;
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => row.name)
      );
      return required.every((column) => columns.has(column));
    });
  } catch (error) {
    // Non-SQLite and damaged files are not verified application libraries.
    if ([11, 26].includes(error.errcode)) return false;
    throw discoveryError('Cannot verify an existing library database safely.', error);
  } finally {
    db?.close();
  }
}

function resolveDataDirectory({
  documents,
  dataDir,
  lstatSync = fs.lstatSync,
  opendirSync = fs.opendirSync,
  openDatabase = (filename, options) => new (require('node:sqlite').DatabaseSync)(filename, options)
}) {
  if (dataDir) return path.resolve(dataDir);
  const canonical = path.join(documents, APP_NAME);
  if (!inspectDirectory(documents, lstatSync)) return canonical;

  const canonicalStat = statOrNull(canonical, lstatSync);
  if (canonicalStat) {
    if (canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
      throw discoveryError('The ACG-album library directory is linked or is not a directory.');
    }
    const database = statOrNull(path.join(canonical, 'library.sqlite'), lstatSync);
    if (database) {
      if (database.isSymbolicLink() || !database.isFile()) {
        throw discoveryError('The ACG-album database is linked or is not a regular file.');
      }
      // An explicitly established canonical library always wins, including one needing repair.
      return canonical;
    }
  }

  let directory;
  const candidates = [];
  try {
    directory = opendirSync(documents, { bufferSize: 32 });
    for (let count = 0; ; count++) {
      const entry = directory.readSync();
      if (!entry) break;
      if (count >= MAX_DOCUMENT_ENTRIES) {
        throw discoveryError(
          'Documents contains too many entries for automatic library discovery.'
        );
      }
      if (entry.name === APP_NAME || entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const candidate = path.join(documents, entry.name);
      const stat = statOrNull(candidate, lstatSync);
      if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const filename = path.join(candidate, 'library.sqlite');
      const database = statOrNull(filename, lstatSync);
      if (!database || database.isSymbolicLink() || !database.isFile()) continue;
      // SQLite may use sidecars while reading a live WAL database; never follow linked sidecars.
      for (const suffix of ['-wal', '-shm', '-journal']) {
        const sidecar = statOrNull(filename + suffix, lstatSync);
        if (sidecar && (sidecar.isSymbolicLink() || !sidecar.isFile())) {
          throw discoveryError('An existing library database has an unsafe sidecar.');
        }
      }
      if (verifyLibrarySchema(filename, openDatabase)) candidates.push(candidate);
    }
  } catch (error) {
    if (error.code === 'ACG_PROFILE_SELECTION_REQUIRED') throw error;
    throw discoveryError('Cannot complete automatic library discovery safely.', error);
  } finally {
    directory?.closeSync();
  }
  if (candidates.length > 1) {
    candidates.sort();
    throw discoveryError(`Multiple application libraries were found: ${candidates.join('; ')}.`);
  }
  // Keep verified data in place: discovery never merges, renames, overwrites or deletes it.
  return candidates[0] || canonical;
}

function resolveUserDataDirectory({
  appData,
  dataDir,
  currentUserData,
  existsSync = fs.existsSync
}) {
  if (dataDir) return path.join(path.resolve(dataDir), 'chromium-profile');
  const canonical = path.join(appData, APP_NAME);
  return (
    [currentUserData, canonical].find((directory) => directory && existsSync(directory)) ||
    canonical
  );
}

module.exports = { APP_NAME, resolveDataDirectory, resolveUserDataDirectory };
