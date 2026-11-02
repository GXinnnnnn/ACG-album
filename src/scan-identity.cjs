'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { idFor } = require('./model.cjs');

// Identity is evidence for a move, never the public ID. Do not use mtime as a
// birth fallback: copies commonly preserve mtime, and inode numbers are reused.
function identityFor(stat) {
  if (!stat || stat.isSymbolicLink?.()) return null;
  const folder = stat.isDirectory?.() === true;
  if (!folder && (stat.isFile?.() !== true || ![1, 1n].includes(stat.nlink))) return null;
  const integer = (value, zero = false) => {
    if (typeof value === 'bigint') return value >= (zero ? 0n : 1n) ? String(value) : null;
    return Number.isSafeInteger(value) && value >= (zero ? 0 : 1) ? String(value) : null;
  };
  const dev = integer(stat.dev, true),
    ino = integer(stat.ino);
  // The millisecond bucket is shared by ordinary and bigint lstat results.
  // Keep exact dev/ino strings; rounded 64-bit Windows file IDs are unsafe.
  const birth =
    typeof stat.birthtimeNs === 'bigint'
      ? stat.birthtimeNs / 1000000n
      : typeof stat.birthtimeMs === 'bigint'
        ? stat.birthtimeMs
        : Math.floor(stat.birthtimeMs);
  const born = integer(birth);
  return dev !== null && ino !== null && born !== null
    ? `v1:${folder ? 'd' : 'f'}:${dev}:${ino}:${born}`
    : null;
}
async function readScanStat(p) {
  const stat = await fs.promises.lstat(p, { bigint: true });
  const millis = (ns) => Number(ns / 1000000000n) * 1000 + Number(ns % 1000000000n) / 1000000;
  // Preserve BigIntStats methods/mode and exact dev/ino/birthtimeNs, exposing
  // numeric scanner fields without truncating fractional milliseconds.
  stat.size = Number(stat.size);
  stat.mtimeMs = millis(stat.mtimeNs);
  stat.birthtimeMs = millis(stat.birthtimeNs);
  stat.ctimeMs = millis(stat.ctimeNs);
  stat.atimeMs = millis(stat.atimeNs);
  stat.fsIdentity = identityFor(stat);
  return stat;
}
function nodeIdentity(n, stat) {
  const direct = identityFor(stat);
  if (direct) return direct;
  // A caller may supply identityFor(await lstat(path, {bigint:true})) when its
  // normal scanner stat has an inode that cannot be represented by Number.
  if (typeof n.fsIdentity !== 'string' || !/^v1:[df]:\d+:\d+:\d+$/.test(n.fsIdentity)) return null;
  if (stat.isSymbolicLink?.()) return null;
  if (stat.isDirectory?.() !== true && (stat.isFile?.() !== true || ![1, 1n].includes(stat.nlink)))
    return null;
  return n.fsIdentity;
}
function ensureIdentitySchema(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .map((c) => c.name)
  );
  if (!columns.has('fs_identity')) db.exec('ALTER TABLE nodes ADD COLUMN fs_identity TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS nodes_scan_identity ON nodes(root,fs_identity)');
  for (const column of ['cover', 'local_newest']) {
    if (columns.has(column))
      db.exec(`CREATE INDEX IF NOT EXISTS nodes_scan_${column} ON nodes(${column})`);
  }
}
const absent = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
const filesystemFailure = (error) =>
  [
    'ENOENT',
    'ENOTDIR',
    'EACCES',
    'EPERM',
    'ELOOP',
    'EBUSY',
    'ESTALE',
    'EIO',
    'ENAMETOOLONG',
    'ENODEV',
    'ENXIO',
    'EMFILE',
    'ENFILE',
    'ETIMEDOUT',
    'UNKNOWN'
  ].includes(error?.code);
function ancestors(p) {
  const absolute = path.resolve(p),
    root = path.parse(absolute).root;
  const result = [root];
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    result.push(current);
  }
  return result;
}
const within = (parent, child) => {
  const rel = path.relative(parent, child);
  return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
};

/**
 * createScanIdentity(db, {maxNodes=2048}={})
 * prepare(node, numericStat, checkpoint=async()=>{}): Promise<plan|null>.
 *   Call before opening a write transaction; null means ordinary upsert.
 * apply(plan, started): boolean.
 *   Synchronous, supports an enclosing transaction; false means revalidation
 *   failed. Always call indexing.upsert(node, numericStat, started) afterwards.
 * Schema initialization is idempotent. reset() invalidates unconsumed plans.
 * A plan is bounded, single-use and local to this instance. No source writes,
 * symlink traversal, name inference, online matching or scan_new insertion.
 */
function createScanIdentity(db, { maxNodes = 2048 } = {}) {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 2048)
    throw new RangeError('maxNodes must be an integer from 1 to 2048');
  ensureIdentitySchema(db);
  const get = db.prepare('SELECT * FROM nodes WHERE id=?');
  const candidates = db.prepare('SELECT * FROM nodes WHERE root=? AND fs_identity=? LIMIT 2');
  // No ORDER BY: a large directory must stop at maxNodes + 1 without sorting
  // all of its children before LIMIT can reject the migration.
  const children = db.prepare('SELECT * FROM nodes WHERE parent=? LIMIT ?');
  const conflict = db.prepare('SELECT id FROM nodes WHERE path=? COLLATE NOCASE OR id=? LIMIT 1');
  const rename = db.prepare(
    `UPDATE nodes SET id=?,parent=?,path=?,name=?,sortkey=?,depth=?,missing=0,indexed=? WHERE id=?`
  );
  const renameMedia = db.prepare('UPDATE media SET id=? WHERE id=?');
  const deleteSearch = db.prepare('DELETE FROM search_index WHERE rowid=?');
  const insertSearch = db.prepare(
    'INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE id=?'
  );
  const rowid = db.prepare('SELECT rowid FROM nodes WHERE id=?');
  const hasPending = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='match_pending'")
    .get();
  const deletePending = hasPending ? db.prepare('DELETE FROM match_pending WHERE id=?') : null;
  const hasManualTitles = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manual_title_keys'")
    .get();
  const renameManualTitle = hasManualTitles
    ? db.prepare('UPDATE manual_title_keys SET node_id=? WHERE node_id=?')
    : null;
  const mediaConflict = db.prepare('SELECT id FROM media WHERE id=?');
  const removeNew = db.prepare('DELETE FROM scan_new WHERE id=?');
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .map((c) => c.name)
  );
  // Temporary mapping makes all relationship updates set-based and prevents a
  // replacement ID from being rewritten again by a later row in the same move.
  db.exec(
    'CREATE TEMP TABLE IF NOT EXISTS scan_identity_map(old_id TEXT PRIMARY KEY,new_id TEXT UNIQUE)'
  );
  const addMap = db.prepare('INSERT INTO scan_identity_map VALUES(?,?)');
  const references = ['parent', 'cover', 'local_newest']
    .filter((c) => columns.has(c))
    .map((c) =>
      db.prepare(`UPDATE nodes SET ${c}=(SELECT new_id FROM scan_identity_map WHERE old_id=nodes.${c})
      WHERE ${c} IN (SELECT old_id FROM scan_identity_map)`)
    );
  const referencePages = ['cover', 'local_newest']
    .filter((c) => columns.has(c))
    .map((c) => db.prepare(`SELECT id FROM nodes WHERE ${c}=? LIMIT ?`));
  const maxReferences = maxNodes * 3;
  function boundedReferences(rows) {
    let count = 0;
    for (const row of rows) {
      for (const statement of referencePages) {
        count += statement.all(row.source.id, maxReferences - count + 1).length;
        if (count > maxReferences) return false;
      }
    }
    return true;
  }
  let plans = new WeakSet();
  async function missing(p) {
    try {
      for (const current of ancestors(p)) {
        if ((await fs.promises.lstat(current, { bigint: true })).isSymbolicLink()) return false;
      }
      return false;
    } catch (error) {
      return absent(error);
    }
  }
  function missingSync(p) {
    try {
      for (const current of ancestors(p)) {
        if (fs.lstatSync(current, { bigint: true }).isSymbolicLink()) return false;
      }
      return false;
    } catch (error) {
      return absent(error);
    }
  }
  // Validate the lexical path from the registered root down. lstat of a leaf
  // alone would follow a symbolic-link ancestor, including Windows junctions.
  async function safePath(rootPath, targetPath) {
    if (!within(rootPath, targetPath)) return false;
    for (const current of ancestors(targetPath)) {
      const s = await fs.promises.lstat(current, { bigint: true });
      if (s.isSymbolicLink()) return false;
    }
    return true;
  }
  return {
    reset() {
      plans = new WeakSet();
    },
    async prepare(n, stat, checkpoint = async () => {}) {
      const identity = nodeIdentity(n, stat);
      if (!identity || !n.parent || n.id !== idFor(n.path) || get.get(n.id)) return null;
      const root = get.get(n.root),
        parent = get.get(n.parent);
      if (
        !root ||
        root.parent !== null ||
        !within(root.path, n.path) ||
        !parent ||
        parent.root !== n.root ||
        parent.kind !== 'folder' ||
        parent.missing ||
        path.dirname(n.path).toLowerCase() !== parent.path.toLowerCase() ||
        n.depth !== parent.depth + 1
      )
        return null;
      const found = candidates.all(n.root, identity);
      if (found.length !== 1) return null;
      const old = found[0];
      if (
        old.id === n.id ||
        !old.parent ||
        old.kind !== n.kind ||
        !within(root.path, old.path) ||
        !(await missing(old.path))
      )
        return null;
      try {
        if (!(await safePath(root.path, n.path))) return null;
        const actual = await fs.promises.lstat(n.path, { bigint: true });
        if (identityFor(actual) !== identity) return null;
        const rows = [],
          queue = [old],
          seen = new Set();
        for (let cursor = 0; cursor < queue.length; cursor++) {
          const source = queue[cursor];
          if (
            seen.has(source.id) ||
            source.root !== n.root ||
            source.id !== idFor(source.path) ||
            !source.fs_identity ||
            (source.id !== old.id && !within(old.path, source.path))
          )
            return null;
          seen.add(source.id);
          const destination =
            source.id === old.id ? n.path : path.join(n.path, path.relative(old.path, source.path));
          const nextId = idFor(destination);
          if (conflict.get(destination, nextId) || mediaConflict.get(nextId)) return null;
          const s =
            source.id === old.id ? actual : await fs.promises.lstat(destination, { bigint: true });
          if (
            identityFor(s) !== source.fs_identity ||
            (source.kind === 'folder' ? !s.isDirectory() : !s.isFile()) ||
            candidates.all(n.root, source.fs_identity).length !== 1
          )
            return null;
          rows.push({ source, path: destination, id: nextId });
          if (source.kind === 'folder') {
            const page = children.all(source.id, maxNodes + 1);
            if (queue.length + page.length > maxNodes) return null;
            for (const child of page) {
              // Broken parent/path relationships cannot be reconstructed safely.
              if (path.dirname(child.path).toLowerCase() !== source.path.toLowerCase()) return null;
              queue.push(child);
            }
          }
          if (rows.length % 64 === 0) await checkpoint();
        }
        if (!(await missing(old.path)) || !boundedReferences(rows)) return null;
        const plan = { rows, node: { ...n }, identity, rootPath: root.path };
        plans.add(plan);
        return plan;
      } catch (error) {
        // Filesystem failures reject identity reuse. SQL/programming errors must
        // remain visible to the scanner instead of silently dropping safeguards.
        if (filesystemFailure(error)) return null;
        throw error;
      }
    },
    apply(plan, started) {
      if (!plan || !plans.delete(plan)) return false;
      const { rows, node: n, identity, rootPath } = plan;
      if (!missingSync(rows[0].source.path)) return false;
      const root = get.get(n.root),
        parent = get.get(n.parent);
      if (
        !root ||
        root.path !== rootPath ||
        !parent ||
        parent.root !== n.root ||
        parent.kind !== 'folder' ||
        parent.missing ||
        n.depth !== parent.depth + 1 ||
        path.dirname(n.path).toLowerCase() !== parent.path.toLowerCase()
      )
        return false;
      const sourceIds = new Set(rows.map((row) => row.source.id));
      try {
        // Close the async validation gap, including symlink substitutions. Work
        // is strictly bounded by maxNodes; no decoding or traversal occurs here.
        if (!within(rootPath, n.path)) return false;
        for (const current of ancestors(n.path)) {
          if (fs.lstatSync(current, { bigint: true }).isSymbolicLink()) return false;
        }
        for (const row of rows) {
          const live = get.get(row.source.id);
          if (
            !live ||
            live.path !== row.source.path ||
            live.parent !== row.source.parent ||
            live.root !== row.source.root ||
            live.fs_identity !== row.source.fs_identity ||
            conflict.get(row.path, row.id) ||
            mediaConflict.get(row.id) ||
            candidates.all(n.root, row.source.fs_identity).length !== 1 ||
            identityFor(fs.lstatSync(row.path, { bigint: true })) !== row.source.fs_identity
          )
            return false;
          if (live.kind !== row.source.kind || live.depth !== row.source.depth) return false;
          if (
            live.kind === 'folder' &&
            children.all(live.id, maxNodes + 1).some((child) => !sourceIds.has(child.id))
          )
            return false;
        }
      } catch (error) {
        if (filesystemFailure(error)) return false;
        throw error;
      }
      if (identity !== rows[0].source.fs_identity || !boundedReferences(rows)) return false;
      db.exec('SAVEPOINT scan_identity_move');
      try {
        db.exec('DELETE FROM scan_identity_map');
        for (const row of rows) addMap.run(row.source.id, row.id);
        for (const row of rows) {
          deleteSearch.run(rowid.get(row.source.id).rowid);
          rename.run(
            row.id,
            row.source.id === rows[0].source.id ? n.parent : row.source.parent,
            row.path,
            row.source.id === rows[0].source.id ? n.name : row.source.name,
            row.source.id === rows[0].source.id ? n.sortkey : row.source.sortkey,
            row.source.depth + n.depth - rows[0].source.depth,
            started,
            row.source.id
          );
          renameMedia.run(row.id, row.source.id);
          renameManualTitle?.run(row.id, row.source.id);
          deletePending?.run(row.source.id);
          // A provisional scan_new row for an old ID must not survive a move.
          removeNew.run(row.source.id);
          insertSearch.run(row.id);
        }
        for (const statement of references) statement.run();
        db.exec('DELETE FROM scan_identity_map; RELEASE scan_identity_move');
        return true;
      } catch (error) {
        db.exec('ROLLBACK TO scan_identity_move; RELEASE scan_identity_move');
        throw error;
      }
    }
  };
}
module.exports = {
  identityFor,
  readScanStat,
  nodeIdentity,
  ensureIdentitySchema,
  createScanIdentity
};
