'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const sharp = require('sharp');
sharp.cache({ memory: 48, files: 0, items: 80 });
sharp.concurrency(2);
const {
  IMAGE_EXT,
  VIDEO_EXT,
  MEDIA_EXT,
  idFor,
  newestImage,
  normalize,
  searchPlan,
  searchStages,
  subjectNames,
  parseSubjectId,
  thumbnailKey
} = require('./model.cjs');
const { SUBJECT_TYPES, importOptions } = require('./matching-policy.cjs');
const { OFFICIAL_REPOSITORY, effectiveRepository, validRepository } = require('./repository.cjs');
const { firstImage } = require('./character-matching.cjs');
const { createCharacterLibrary } = require('./character-library.cjs');
const { matchedIdentitySql, matchedAutomaticSql, pendingReviewSql } = require('./review-state.cjs');
const {
  MIN_CONFIDENCE,
  IMPORT_MIN_CONFIDENCE,
  rankSubjects,
  rankImportSubjects,
  collections,
  dateValue,
  createSearchCache
} = require('./matching.cjs');
const { searchSubjectPages } = require('./bangumi-search.cjs');
const { normalizeAccessToken, safeAccessError } = require('./bangumi-access.cjs');
const { createHash } = require('node:crypto');
const { createBangumiCache } = require('./bangumi-cache.cjs');
const cacheDirectory = require('./cache-directory.cjs');
const localIndex = require('./local-index.cjs').createLocalIndex({
  localIndexPath: workerData.localIndexPath,
  resourcesPath: workerData.resourcesPath || process.resourcesPath
});
const accessScope = () =>
  createHash('sha256')
    .update('ACGAlbum Bangumi cache v1\0' + String(workerData.token || '').trim())
    .digest('hex');
const home = workerData.dataDir;
fs.mkdirSync(home, { recursive: true });
const db = new DatabaseSync(path.join(home, 'library.sqlite'));
// Keep a 16 MiB page-cache target to avoid FTS/index churn in large libraries.
// Cache budgeting does not relax the durable WAL commit policy.
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-16384; PRAGMA busy_timeout=4000;
CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,root TEXT,parent TEXT,path TEXT UNIQUE COLLATE NOCASE,name TEXT,sortkey TEXT,kind TEXT,depth INTEGER,bytes INTEGER DEFAULT 0,mtime REAL,birth REAL,missing INTEGER DEFAULT 0,cover TEXT,cover_source TEXT,crop_x REAL DEFAULT 50,crop_y REAL DEFAULT 50,confirmed INTEGER DEFAULT 0,manual_cover INTEGER DEFAULT 0,subject_id INTEGER,manual_subject INTEGER DEFAULT 0,intro INTEGER DEFAULT -1,favorite INTEGER DEFAULT 0,files INTEGER DEFAULT 0,folders INTEGER DEFAULT 0,total_bytes INTEGER DEFAULT 0,indexed REAL,scan_error TEXT);
CREATE INDEX IF NOT EXISTS nodes_parent_name ON nodes(parent,missing,kind,sortkey,id);
CREATE INDEX IF NOT EXISTS nodes_parent_date ON nodes(parent,missing,kind,birth,id);
CREATE INDEX IF NOT EXISTS nodes_parent_modified ON nodes(parent,missing,kind,mtime,id);
CREATE INDEX IF NOT EXISTS nodes_parent_size ON nodes(parent,missing,kind,(CASE WHEN kind='folder' THEN total_bytes ELSE bytes END),id);
CREATE INDEX IF NOT EXISTS nodes_global_name ON nodes(missing,kind,sortkey,id);
CREATE INDEX IF NOT EXISTS nodes_global_date ON nodes(missing,kind,birth,id);
CREATE INDEX IF NOT EXISTS nodes_global_modified ON nodes(missing,kind,mtime,id);
CREATE INDEX IF NOT EXISTS nodes_global_size ON nodes(missing,kind,(CASE WHEN kind='folder' THEN total_bytes ELSE bytes END),id);
DROP INDEX IF EXISTS nodes_parent_sort;
CREATE INDEX IF NOT EXISTS nodes_root ON nodes(root); CREATE INDEX IF NOT EXISTS nodes_subject ON nodes(subject_id);
CREATE TABLE IF NOT EXISTS metadata(id INTEGER PRIMARY KEY,json TEXT,updated REAL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
CREATE TABLE IF NOT EXISTS root_match_policy(root TEXT PRIMARY KEY,enabled INTEGER NOT NULL,types TEXT NOT NULL,revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS match_frontier(root TEXT PRIMARY KEY,after_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS match_pending(id TEXT PRIMARY KEY,root TEXT NOT NULL,stamp TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS match_pending_root ON match_pending(root,id);
CREATE TABLE IF NOT EXISTS match_resume(singleton INTEGER PRIMARY KEY CHECK(singleton=1),reason TEXT NOT NULL,retry_at REAL NOT NULL,scope TEXT NOT NULL,failures INTEGER NOT NULL);
INSERT OR IGNORE INTO match_resume VALUES(1,'',0,'',0);
CREATE INDEX IF NOT EXISTS nodes_root_matching ON nodes(root,kind,missing,id);
CREATE INDEX IF NOT EXISTS nodes_parent_newest ON nodes(parent,missing,kind,mtime DESC,sortkey,id);
CREATE TABLE IF NOT EXISTS thumbs(key TEXT PRIMARY KEY,path TEXT,source TEXT,last_used REAL,bytes INTEGER);
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED,name,tokenize='trigram');`);
let running = false,
  scanTask = null,
  cancelled = false,
  progress = { active: false },
  onlineRunning = false;
const onlineQueue = new Map(),
  rootGenerations = new Map(),
  networkControllers = new Set(),
  subjectJobs = new Set();
let onlineTask = null,
  localPauseSweep = null,
  onlineScheduled = false,
  stopping = false,
  onlineEpoch = 0,
  accessGeneration = 0,
  activeOnlineJob = null,
  onlineCompleted = 0,
  onlineBatchCancelled = false;
const searchCache = createSearchCache();
const detailCache = createSearchCache();
const staffCache = createSearchCache();
const cacheConsumers = new WeakMap();
const diskCache = createBangumiCache(db);
let onlineRetryTimer = null;
let onlineRetryMonotonic = 0;
const MANUAL_SUBJECT_TYPES = [1, 2, 3, 4, 6];
const send = (event, data) => parentPort.postMessage({ event, data });
const statements = new Map();
function prepared(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    if (statements.size >= 128) statements.delete(statements.keys().next().value);
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}
const q = (sql, ...a) => prepared(sql).all(...a);
const one = (sql, ...a) => prepared(sql).get(...a);
const run = (sql, ...a) => prepared(sql).run(...a);
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'match_confidence'))
  db.exec('ALTER TABLE nodes ADD COLUMN match_confidence REAL');
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'match_review'))
  db.exec('ALTER TABLE nodes ADD COLUMN match_review INTEGER NOT NULL DEFAULT 0');
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'search_type'))
  db.exec('ALTER TABLE nodes ADD COLUMN search_type INTEGER DEFAULT -1');
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'crop_zoom'))
  db.exec('ALTER TABLE nodes ADD COLUMN crop_zoom REAL DEFAULT 1');
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'cover_revision'))
  db.exec("ALTER TABLE nodes ADD COLUMN cover_revision TEXT DEFAULT ''");
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'local_newest'))
  db.exec('ALTER TABLE nodes ADD COLUMN local_newest TEXT');
if (!q('PRAGMA table_info(nodes)').some((c) => c.name === 'album_kind'))
  db.exec("ALTER TABLE nodes ADD COLUMN album_kind TEXT DEFAULT 'auto'");
const defaults = {
  theme: 'light',
  density: 222,
  ratio: 'poster',
  autoMatch: true,
  watchChanges: true,
  subjectDepth: 1,
  categoryType: 0,
  nickname: '新朋友',
  avatar: '',
  sidebarMode: 'auto',
  details: true,
  liquidGlass: true,
  motionLevel: 'medium',
  githubRepository: OFFICIAL_REPOSITORY
};
const setting = (key) => {
  const row = one('SELECT value FROM settings WHERE key=?', key);
  return row ? JSON.parse(row.value) : defaults[key];
};
function setSetting(key, value) {
  run('INSERT OR REPLACE INTO settings VALUES(?,?)', key, JSON.stringify(value));
  return value;
}
let cacheHome = setting('cacheDirectory') || home;
cacheDirectory.initializeCache(cacheHome);
let cacheChanging = false,
  cacheTask = null,
  activeRequests = 0;
const cacheReadMethods = new Set([
  'init',
  'list',
  'get',
  'ancestors',
  'syncStatus',
  'localIndexStatus',
  'searchLocalIndex',
  'cancel'
]);
async function changeCache(operation) {
  if (
    cacheChanging ||
    running ||
    thumbJobs.size ||
    onlineRunning ||
    onlineScheduled ||
    activeNetwork ||
    networkControllers.size ||
    subjectJobs.size ||
    activeRequests
  )
    throw new Error('正在导入、联网、保存或生成缓存，请稍后再试。');
  cacheChanging = true;
  try {
    cacheTask = operation();
    return await cacheTask;
  } finally {
    cacheChanging = false;
    cacheTask = null;
    startOnline();
  }
}
// Startup repairs are migrations, not recurring maintenance. The marker commits
// with the repair so an interrupted upgrade can safely retry on its next boot.
function migrateOnce(key, version, migrate) {
  if (setting(key) === version) return;
  db.exec('BEGIN');
  try {
    migrate();
    setSetting(key, version);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
const { sortKey, NATURAL_SORT_VERSION } = require('./natural-sort.cjs');
async function migrateSortKeys() {
  if (setting('naturalSortVersion') === NATURAL_SORT_VERSION) return;
  const cursor = setting('naturalSortCursor');
  let after = cursor?.version === NATURAL_SORT_VERSION ? cursor.after : null;
  let processed = 0;
  const update = db.prepare('UPDATE nodes SET sortkey=? WHERE rowid=?');
  while (!stopping) {
    const rows =
      after === null
        ? q('SELECT rowid,name FROM nodes ORDER BY rowid LIMIT 512')
        : q('SELECT rowid,name FROM nodes WHERE rowid>? ORDER BY rowid LIMIT 512', after);
    if (!rows.length) {
      setSetting('naturalSortVersion', NATURAL_SORT_VERSION);
      setSetting('naturalSortCursor', null);
      if (processed) send('sortMigration', { processed, active: false });
      return;
    }
    db.exec('BEGIN');
    try {
      for (const row of rows) update.run(sortKey(row.name), row.rowid);
      after = rows.at(-1).rowid;
      setSetting('naturalSortCursor', { version: NATURAL_SORT_VERSION, after });
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    processed += rows.length;
    send('sortMigration', { processed, active: true });
    await yieldNow();
  }
}
if (setting('searchVersion') !== 1) {
  db.exec(
    'DELETE FROM search_index; INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE missing=0'
  );
  setSetting('searchVersion', 1);
}
// Preserve indexed pagination when equal dates/sizes need a natural-name tie.
// Rebuild once for existing libraries; name ordering already has this shape.
if (setting('browseOrderVersion') !== 1) {
  db.exec('BEGIN');
  try {
    for (const [scope, prefix] of [
      ['parent,', 'parent'],
      ['', 'global']
    ]) {
      for (const [name, column] of [
        ['date', 'birth'],
        ['modified', 'mtime'],
        ['size', "(CASE WHEN kind='folder' THEN total_bytes ELSE bytes END)"]
      ]) {
        db.exec(`DROP INDEX IF EXISTS nodes_${prefix}_${name};
          CREATE INDEX nodes_${prefix}_${name} ON nodes(${scope}missing,kind,${column},sortkey,id)`);
      }
    }
    setSetting('browseOrderVersion', 1);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
// Bump this migration alongside future browse-index schema changes. Do not
// reconsider every large table on ordinary repeat startup.
migrateOnce('browseOptimizeVersion', 1, () => db.exec('PRAGMA optimize=0x10002'));
const getNode = (id) => one('SELECT * FROM nodes WHERE id=?', id);
const characters = createCharacterLibrary({
  db,
  q,
  one,
  run,
  getNode,
  hydrate,
  localIndex,
  policy: matchPolicy,
  api,
  assertLive: assertMatchLive,
  accessScope,
  cacheHome: () => cacheHome,
  controllers: networkControllers,
  jobs: subjectJobs,
  send,
  refreshLocalCover,
  matchGuard,
  matchJob,
  paused: onlinePause,
  tokenPresent: () => !!normalizeAccessToken(workerData.token)
});
// Repair prior versions that treated a successful nonexact match as unreviewed.
// Only unmatched local fallback covers need review; stale confidence-review flags
// must not survive an explicit confirmation or reopen a matched cover.
migrateOnce('matchReviewVersion', 1, () =>
  run(
    `UPDATE nodes SET confirmed=CASE WHEN ${matchedAutomaticSql()} THEN 1 ELSE confirmed END,match_review=0
     WHERE kind='folder' AND ((${matchedAutomaticSql()} AND confirmed<>1) OR match_review<>0)`
  )
);
const media = require('./media.cjs').createMedia({ db, home, getNode, send });
const maintenance = require('./sqlite-checkpoint.cjs').createSqliteCheckpoint(
  path.join(home, 'library.sqlite')
);
const indexing = require('./indexing.cjs').createIndexing(db, maintenance);
let libraryRevision = 0;
function albumKind(n) {
  const ancestors = [];
  for (let p = n; p; p = p.parent ? getNode(p.parent) : null) {
    ancestors.push(p);
    if (p.album_kind && p.album_kind !== 'auto') return p.album_kind;
  }
  for (const p of ancestors) {
    if (p.character_id || p.custom_character) return 'character';
    if (p.subject_id) return 'work';
  }
  const imported = n && one('SELECT directory_kind FROM root_match_policy WHERE root=?', n.root);
  if (imported) return imported.directory_kind;
  return ancestors.some(
    (p) =>
      p.depth <= 1 &&
      /(?:acg|anime|animation|galgame|comic|\b(?:games?|films?|movies?|cinema)\b|动漫|動畫|动画|番剧|游戏|遊戲|二次元|漫画|轻小说|影视|电影|電影|特摄)/i.test(
        p.name
      )
  )
    ? 'work'
    : 'photo';
}
function searchType(n) {
  for (let current = n; current; current = current.parent ? getNode(current.parent) : null)
    if (current.search_type >= 0) return current.search_type;
  return Number(setting('categoryType')) || 0;
}
function hydrate(n) {
  if (!n) return null;
  const character = albumKind(n) === 'character';
  const meta = character
    ? characters.metadata(n)
    : n.subject_id
      ? one('SELECT json,updated FROM metadata WHERE id=?', n.subject_id)
      : null;
  return {
    ...n,
    effective_album_kind: albumKind(n),
    effective_search_type: searchType(n),
    effective_subject_types: n.kind === 'folder' ? manualMatchTypes(n) : [],
    association_type_mismatch: !!(
      meta &&
      !character &&
      n.kind === 'folder' &&
      !manualMatchTypes(n).includes(JSON.parse(meta.json).type)
    ),
    metadata: meta ? JSON.parse(meta.json) : null,
    metadata_updated: meta?.updated || null
  };
}
function roots() {
  // Roots are directories. Binding kind lets the existing parent/name index
  // serve this tiny result without scanning the global name index after ANALYZE.
  return q(
    "SELECT * FROM nodes WHERE parent IS NULL AND missing=0 AND kind='folder' ORDER BY sortkey"
  );
}
function browseWhere({
  parent = null,
  search = '',
  scope = null,
  filter = 'all',
  favorites = false,
  timeline = false,
  month = '',
  place = ''
} = {}) {
  const where = ['n.missing=0'],
    args = [];
  if (search.trim()) {
    const terms = search.trim().slice(0, 160).split(/\s+/).filter(Boolean);
    if (terms.every((t) => t.length >= 3)) {
      where.push('n.rowid IN (SELECT rowid FROM search_index WHERE search_index MATCH ?)');
      args.push(terms.map((t) => '"' + t.replace(/"/g, '""') + '"').join(' AND '));
    } else
      for (const t of terms) {
        where.push("n.name LIKE ? ESCAPE '\\'");
        args.push('%' + t.replace(/[\\%_]/g, '\\$&') + '%');
      }
    if (scope) {
      where.push('n.root=?');
      args.push(scope);
    }
  } else if (favorites) where.push('n.favorite=1');
  else if (filter === 'pending') where.push(pendingReviewSql('n'));
  else if (parent && timeline) {
    const folder = getNode(parent);
    where.push("n.path LIKE ? ESCAPE '\\'");
    args.push(path.join(folder?.path || '__missing__', path.sep).replace(/[\\%_]/g, '\\$&') + '%');
  } else if (parent) {
    where.push('n.parent=?');
    args.push(parent);
  } else if (filter !== 'images' && !timeline) where.push('n.parent IS NULL');
  if (filter === 'images' || timeline) where.push("n.kind IN ('image','video')");
  else if (filter === 'folders') where.push("n.kind='folder'");
  if (search.trim() && favorites) where.push('n.favorite=1');
  if (search.trim() && filter === 'pending') where.push(pendingReviewSql('n'));
  if (timeline && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    if (m >= 1 && m <= 12) {
      where.push('m.taken>=? AND m.taken<?');
      args.push(new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime());
    }
  }
  if (timeline && place.trim()) {
    where.push("m.place LIKE ? ESCAPE '\\'");
    args.push(
      '%' +
        place
          .trim()
          .slice(0, 120)
          .replace(/[\\%_]/g, '\\$&') +
        '%'
    );
  }
  return { where, args };
}
function list(options = {}) {
  const { sort = 'name', direction = 'asc', filter = 'all', timeline = false } = options;
  const limit = Math.min(Math.max(Number(options.limit) || 180, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const { where, args } = browseWhere(options);
  const col = timeline
    ? 'm.taken'
    : {
        name: 'n.sortkey',
        date: 'n.birth',
        modified: 'n.mtime',
        size: "CASE WHEN n.kind='folder' THEN n.total_bytes ELSE n.bytes END"
      }[sort] || 'n.sortkey';
  const dir = direction === 'desc' ? 'DESC' : 'ASC',
    clause = where.join(' AND ');
  const from = timeline ? 'media m CROSS JOIN nodes n ON n.id=m.id' : 'nodes n',
    countFrom = where.some((w) => w.startsWith('m.'))
      ? 'media m JOIN nodes n ON n.id=m.id'
      : 'nodes n';
  const count = one(`SELECT COUNT(*) total FROM ${countFrom} WHERE ${clause}`, ...args).total;
  const folders =
    filter === 'images' || timeline
      ? 0
      : one(`SELECT COUNT(*) total FROM ${countFrom} WHERE ${clause} AND n.kind='folder'`, ...args)
          .total;
  const select =
    'n.*,m.width,m.height,m.frames,m.taken,m.date_source,m.place,m.latitude,m.longitude,m.hdr';
  const tie = timeline ? `m.id ${dir}` : `n.sortkey ${dir},n.id ${dir}`;
  // Limit narrow IDs before joining metadata; CROSS JOIN keeps date-index traversal first.
  const page = (kind, take, skip) => {
    // kind precedes the sort column in the existing indexes. A two-kind IN
    // range forces a complete temporary sort; merging the two ordered scans
    // lets SQLite stop at the requested page without adding eight more indexes.
    const mergeMedia = !timeline && kind === "n.kind IN ('image','video')";
    const ids = mergeMedia
      ? `SELECT n.id,n.sortkey AS page_name,${col} AS page_order FROM ${from} WHERE ${clause} AND n.kind='image'
         UNION ALL
         SELECT n.id,n.sortkey AS page_name,${col} AS page_order FROM ${from} WHERE ${clause} AND n.kind='video'
         ORDER BY page_order ${dir},page_name ${dir},id ${dir} LIMIT ? OFFSET ?`
      : `SELECT n.id FROM ${from} WHERE ${clause} AND ${kind} ORDER BY ${col} ${dir},${tie} LIMIT ? OFFSET ?`;
    return q(
      `SELECT ${select} FROM (${ids}) page JOIN nodes n ON n.id=page.id
       LEFT JOIN media m ON m.id=n.id ORDER BY ${col} ${dir},${tie}`,
      ...args,
      ...(mergeMedia ? args : []),
      take,
      skip
    );
  };
  const rows = [];
  if (offset < folders) rows.push(...page("n.kind='folder'", limit, offset));
  if (rows.length < limit && offset + rows.length < count)
    rows.push(
      ...page("n.kind IN ('image','video')", limit - rows.length, Math.max(0, offset - folders))
    );
  const items = rows.map((n) => ({
    ...n,
    effective_album_kind: n.kind === 'folder' ? albumKind(n) : undefined,
    metadata:
      albumKind(n) === 'character'
        ? (() => {
            const row = characters.metadata(n);
            if (!row) return null;
            const j = JSON.parse(row.json);
            return { name: j.name, name_cn: j.name_cn, kind: 'character' };
          })()
        : n.subject_id
          ? (() => {
              const m = one('SELECT json FROM metadata WHERE id=?', n.subject_id);
              if (!m) return null;
              const j = JSON.parse(m.json);
              return { name: j.name, name_cn: j.name_cn, rating: j.rating, date: j.date };
            })()
          : null
  }));
  return { items, total: count, folders };
}
function confirmReview({ query, previewIds = [] } = {}) {
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    !['parent', 'search', 'favorites', 'filter', 'timeline'].some((key) =>
      Object.hasOwn(query, key)
    )
  )
    throw new Error('请提供当前页面的浏览条件。');
  for (const key of ['parent', 'scope'])
    if (query[key] !== undefined && query[key] !== null && typeof query[key] !== 'string')
      throw new Error('浏览条件无效。');
  for (const key of ['search', 'month', 'place'])
    if (query[key] !== undefined && typeof query[key] !== 'string')
      throw new Error('浏览条件无效。');
  for (const key of ['favorites', 'timeline'])
    if (query[key] !== undefined && typeof query[key] !== 'boolean')
      throw new Error('浏览条件无效。');
  if (query.filter !== undefined && !['all', 'folders', 'images', 'pending'].includes(query.filter))
    throw new Error('浏览条件无效。');
  if (
    !Array.isArray(previewIds) ||
    previewIds.length > 10000 ||
    previewIds.some((id) => typeof id !== 'string' || !id.length || id.length > 512)
  )
    throw new Error('预览卡片列表无效。');
  if (
    previewIds.length &&
    (query.parent != null ||
      (query.search || '').trim() ||
      query.favorites ||
      query.timeline ||
      !['all', 'folders'].includes(query.filter || 'all'))
  )
    throw new Error('预览卡片仅适用于首页浏览条件。');
  // Inside an opened directory this action confirms every direct subfolder,
  // even if a search/media/favorites filter or pagination hides some cards.
  const { where, args } = browseWhere(query.parent ? { parent: query.parent } : query);
  const from = where.some((w) => w.startsWith('m.'))
    ? 'media m JOIN nodes n ON n.id=m.id'
    : 'nodes n';
  // One transaction confirms every selected folder, including unloaded cards
  // and covers without a visible dot. Overview preview IDs can only select live
  // direct children of live roots in the same home browse result.
  db.exec('BEGIN IMMEDIATE');
  let updated;
  try {
    updated = run(
      `WITH browse AS (SELECT n.id FROM ${from} WHERE ${where.join(' AND ')})
       UPDATE nodes AS n SET confirmed=1,match_review=0
       WHERE n.missing=0 AND n.kind='folder' AND (n.confirmed<>1 OR n.match_review<>0) AND
       (n.id IN (SELECT id FROM browse) OR
        (n.id IN (SELECT value FROM json_each(?)) AND n.root=n.parent AND
         n.parent IN (SELECT r.id FROM browse b JOIN nodes r ON r.id=b.id
                      WHERE r.parent IS NULL AND r.kind='folder' AND r.missing=0)))`,
      ...args,
      JSON.stringify([...new Set(previewIds)])
    ).changes;
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (updated) send('changed', { review: true });
  return { updated };
}
function emitProgress(force = false) {
  const now = Date.now();
  if (force || now - (progress.last || 0) >= 250) {
    progress.last = now;
    progress.revision = libraryRevision;
    send('progress', { ...progress });
    if (progress.active && (force || now - (progress.lastChanged || 0) >= 750)) {
      progress.lastChanged = now;
      send('changed', { root: progress.root, revision: libraryRevision });
    }
  }
}
const yieldNow = () => new Promise((r) => setImmediate(r));
function coverFor(folder, choice) {
  if (
    !folder ||
    folder.manual_cover ||
    (albumKind(folder) !== 'character' && folder.subject_id && folder.cover_source === 'bangumi') ||
    (albumKind(folder) === 'character' &&
      matchPolicy(folder).characterCover === 'bangumi' &&
      folder.character_id &&
      folder.cover_source === 'bangumi-character' &&
      fs.existsSync(characters.coverFile(folder.character_id)))
  )
    return;
  run(
    `UPDATE nodes SET cover=?,cover_source=?,confirmed=CASE WHEN ${matchedAutomaticSql()} THEN 1 WHEN cover=? THEN confirmed ELSE 0 END WHERE id=? AND manual_cover=0`,
    choice?.id || null,
    choice ? 'fallback' : null,
    choice?.id || null,
    folder.id
  );
}
async function refreshLocalCover(id, direct, checkpoint = yieldNow, deferWrite = false) {
  const first = ['character', 'work'].includes(albumKind(getNode(id)));
  if (first)
    direct = one(
      "SELECT id,name,sortkey,mtime FROM nodes WHERE parent=? AND missing=0 AND kind='image' ORDER BY sortkey,id LIMIT 1",
      id
    );
  else if (direct === undefined)
    direct = one(
      "SELECT id,name,sortkey,mtime FROM nodes WHERE parent=? AND missing=0 AND kind='image' ORDER BY mtime DESC,sortkey,id LIMIT 1",
      id
    );
  let newest = direct || null,
    after = '';
  while (!stopping) {
    const page = q(
      `SELECT c.id AS cursor,c.local_newest AS cached,i.id,i.name,i.sortkey,i.mtime FROM nodes c
      LEFT JOIN nodes i ON i.id=c.local_newest AND i.missing=0
      WHERE c.parent=? AND c.missing=0 AND c.kind='folder' AND c.id>? ORDER BY c.id LIMIT 64`,
      id,
      after
    );
    if (!page.length) break;
    for (const child of page) {
      let candidate = child;
      if (child.cached === null) {
        await refreshLocalCover(child.cursor, undefined, checkpoint);
        if (stopping) return;
        const pointer = getNode(child.cursor)?.local_newest;
        candidate = pointer ? getNode(pointer) : null;
      }
      if (candidate?.id)
        newest = first ? firstImage(newest, candidate) : newestImage(newest, candidate);
    }
    after = page.at(-1).cursor;
    await checkpoint();
  }
  if (stopping) return;
  const save = () => {
    // NULL means a legacy folder has not been initialized; '' caches no images.
    run('UPDATE nodes SET local_newest=? WHERE id=?', newest?.id || '', id);
    // Read manual state at commit time: a patch may have arrived while totals
    // yielded. A direct image still takes precedence over inherited descendants.
    coverFor(getNode(id), direct || newest);
  };
  if (deferWrite) return save;
  save();
}
function updateTotals(id) {
  const totals = one(
    "SELECT COALESCE(SUM(CASE WHEN kind IN ('image','video') THEN 1 ELSE files END),0) files,COALESCE(SUM(CASE WHEN kind='folder' THEN 1+folders ELSE 0 END),0) folders,COALESCE(SUM(CASE WHEN kind IN ('image','video') THEN bytes ELSE total_bytes END),0) bytes FROM nodes WHERE parent=? AND missing=0",
    id
  );
  run(
    'UPDATE nodes SET files=?,folders=?,total_bytes=? WHERE id=?',
    totals.files,
    totals.folders,
    totals.bytes,
    id
  );
}
async function scan(rootPath, options = {}) {
  if (cacheChanging) throw new Error('正在管理缓存，请稍后再导入。');
  if (running) throw new Error('已有导入任务正在运行，请等待完成或先取消。');
  running = true;
  cancelled = false;
  try {
    scanTask = scanContents(rootPath, options);
    return await scanTask;
  } finally {
    scanTask = null;
    running = false;
  }
}
async function scanContents(rootPath, options = {}) {
  const { target = null, offline = false } = options;
  const matchOptions = importOptions(options);
  if (stopping) throw new Error('媒体服务已停止。');
  const stat = await fsp.stat(rootPath);
  if (!stat.isDirectory()) throw new Error('请选择一个文件夹。');
  rootPath = path.resolve(rootPath);
  const dataRelative = path.relative(await fsp.realpath(home), await fsp.realpath(rootPath));
  if (
    !dataRelative ||
    (!path.isAbsolute(dataRelative) &&
      dataRelative !== '..' &&
      !dataRelative.startsWith('..' + path.sep))
  )
    throw new Error('不能将程序数据或缓存目录导入为相册，请选择原图库文件夹。');
  await cacheDirectory.validateCacheLocation(cacheHome, [rootPath]);
  const id = idFor(rootPath);
  const containing = q('SELECT id,path FROM nodes WHERE parent IS NULL AND missing=0').find(
    (r) =>
      r.id !== id &&
      (rootPath.toLowerCase().startsWith(r.path.toLowerCase() + path.sep) ||
        r.path.toLowerCase().startsWith(rootPath.toLowerCase() + path.sep))
  );
  if (containing) throw new Error('该目录与已导入分类重叠，请选择独立目录，避免重复索引。');
  // Validation completed under the scanner reservation.
  const started = Math.max(Date.now(), (progress.scanStamp || 0) + 1);
  progress = {
    active: true,
    root: id,
    name: path.basename(rootPath),
    phase: '扫描文件夹',
    folders: 0,
    images: 0,
    visited: 0,
    queued: 1,
    errors: 0,
    started: Date.now(),
    scanStamp: started
  };
  let autoCheckpoint = null,
    dirtyEntries = 0;
  const touched = new Map();
  const checkpoint = async (changed = false) => {
    if (changed) libraryRevision++;
    emitProgress();
    await yieldNow();
  };
  function nodeFor(p, parent, depth, kind) {
    const name = path.basename(p);
    return { id: idFor(p), root: id, parent, path: p, name, sortkey: sortKey(name), kind, depth };
  }
  // A provisional local image can be displayed before the subtree is complete.
  // Final selection below still applies the existing natural-name/newest policy.
  function publishLocalCover(folderId, image) {
    let published = false;
    for (
      let folder = getNode(folderId);
      folder;
      folder = folder.parent ? getNode(folder.parent) : null
    ) {
      if (folder.cover) continue;
      coverFor(folder, image);
      if (getNode(folder.id)?.cover === image.id) published = true;
    }
    return published;
  }
  async function primeLocalCover(folder) {
    if (getNode(folder.id)?.cover || cancelled || stopping) return false;
    // Preview siblings before descending into a large album. Across the whole
    // probe inspect at most 128 entries / 8 directories / 4 levels, stat only
    // traversed directories and the first image, and never follow symlinks.
    const queue = [{ node: folder, ancestors: [] }];
    let entries = 0,
      opened = 0;
    while (queue.length && entries < 128 && opened < 8 && !cancelled && !stopping) {
      const { node, ancestors } = queue.shift();
      try {
        const directoryStat = await fsp.lstat(node.path);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) continue;
        const chain =
          node.id === folder.id ? ancestors : [...ancestors, { node, stat: directoryStat }];
        opened++;
        for await (const entry of await fsp.opendir(node.path, { bufferSize: 32 })) {
          if (cancelled || stopping || entries++ >= 128) break;
          if (entry.isSymbolicLink()) continue;
          const p = path.join(node.path, entry.name);
          if (p.toLowerCase() === home.toLowerCase()) continue;
          if (entry.isDirectory()) {
            if (chain.length < 3 && queue.length + opened < 8)
              queue.push({ node: nodeFor(p, node.id, node.depth + 1, 'folder'), ancestors: chain });
          } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
            const stat = await fsp.lstat(p);
            if (stat.isSymbolicLink() || !stat.isFile()) continue;
            if (cancelled || stopping) return false;
            const image = nodeFor(p, node.id, node.depth + 1, 'image');
            let published;
            db.exec('BEGIN');
            try {
              for (const ancestor of chain) indexing.upsert(ancestor.node, ancestor.stat, started);
              indexing.upsert(image, stat, started);
              published = publishLocalCover(node.id, image);
              db.exec('COMMIT');
            } catch (error) {
              db.exec('ROLLBACK');
              throw error;
            }
            touched.set(folder.id, folder.depth);
            for (const ancestor of chain) touched.set(ancestor.node.id, ancestor.node.depth);
            dirtyEntries += chain.length + 1;
            libraryRevision++;
            await checkpoint();
            return published;
          }
        }
      } catch (error) {
        if (!error.code || error.code.startsWith('ERR_') || error.code.startsWith('SQLITE_'))
          throw error;
        // The full scan reports unreadable paths; preview failure is nonfatal.
      }
    }
    return false;
  }
  // lstat already supplied mtime; retain bounded direct-image candidates.
  function consider(candidates, n, stat) {
    if (n.kind === 'image') {
      candidates.available ||= n;
      candidates.newest = newestImage(candidates.newest, { ...n, mtime: stat.mtimeMs });
    }
  }
  async function visit(folder) {
    if (cancelled) return;
    let directory;
    const candidates = {};
    let complete = false;
    try {
      directory = await fsp.opendir(folder.path, { bufferSize: 128 });
      progress.folders++;
      progress.current = folder.path;
      const commit = async (entries) => {
        const batch = await Promise.all(
          entries.map(async (e) => {
            const p = path.join(folder.path, e.name);
            try {
              const s = await fsp.lstat(p);
              return s.isSymbolicLink() ? null : { p, e, s };
            } catch {
              return { failed: p };
            }
          })
        );
        // Cancellation received while statting must not publish a partial batch.
        if (cancelled) return;
        const previewFolders = [];
        let published = false;
        db.exec('BEGIN');
        try {
          for (const item of batch) {
            if (!item) continue;
            if (item.failed) {
              progress.errors++;
              indexing.protect(idFor(item.failed), started);
              continue;
            }
            const kind = item.e.isDirectory()
              ? 'folder'
              : VIDEO_EXT.has(path.extname(item.p).toLowerCase())
                ? 'video'
                : 'image';
            const n = nodeFor(item.p, folder.id, folder.depth + 1, kind);
            indexing.upsert(n, item.s, started);
            consider(candidates, n, item.s);
            if (kind === 'folder') {
              progress.queued++;
              // Incremental scans recurse only into newly discovered folders.
              // A probe must not persist partial rows in an existing skipped subtree.
              if (
                !getNode(n.id)?.cover &&
                (!target || one('SELECT 1 FROM scan_new WHERE id=?', n.id))
              )
                previewFolders.push(n);
            } else progress.images++;
          }
          if (candidates.available && !getNode(folder.id)?.cover)
            published = publishLocalCover(folder.id, candidates.available);
          db.exec('COMMIT');
          libraryRevision++;
          if (progress.images >= 128 && !progress.firstBatch) {
            progress.firstBatch = true;
            emitProgress(true);
          }
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        dirtyEntries += entries.length;
        if (published) emitProgress(true);
        await checkpoint();
        for (const child of previewFolders) {
          if (cancelled || stopping) break;
          if (await primeLocalCover(child)) emitProgress(true);
        }
        // Include unchanged scan stamps: they still dirty durable WAL pages.
        if (dirtyEntries >= 2048) {
          await maintenance.checkpoint();
          dirtyEntries = 0;
        }
      };
      let batch = [];
      // opendir bounds directory memory even for a single 100k-file folder.
      for await (const e of directory) {
        if (cancelled) break;
        const p = path.join(folder.path, e.name);
        if (
          p.toLowerCase() === home.toLowerCase() ||
          e.isSymbolicLink() ||
          (!e.isDirectory() && !MEDIA_EXT.has(path.extname(e.name).toLowerCase()))
        )
          continue;
        batch.push(e);
        if (batch.length === 128) {
          await commit(batch);
          batch = [];
        }
      }
      if (!cancelled && batch.length) await commit(batch);
      complete = !cancelled;
    } catch (e) {
      if (!e.code || e.code.startsWith('ERR_') || e.code.startsWith('SQLITE_')) throw e;
      // Read errors leave existing children intact, just like cancellation.
      progress.errors++;
      run('UPDATE nodes SET scan_error=? WHERE id=?', e.message, folder.id);
    }
    touched.set(folder.id, folder.depth);
    if (!complete) return;
    await indexing.prune(folder.id, started, checkpoint);
    libraryRevision++;
    if (cancelled) return;
    run('UPDATE nodes SET scan_error=NULL WHERE id=?', folder.id);
    let after = '';
    while (!cancelled) {
      const children = q(
        `SELECT n.* FROM nodes n WHERE n.parent=? AND n.missing=0 AND n.kind='folder' AND n.id>?
          ${target ? 'AND EXISTS(SELECT 1 FROM scan_new s WHERE s.id=n.id)' : ''}
          ORDER BY n.id LIMIT 64`,
        folder.id,
        after
      );
      if (!children.length) break;
      for (const child of children) {
        await visit(child);
        if (cancelled) break;
      }
      after = children.at(-1).id;
      await checkpoint();
    }
    if (cancelled) return;
    const saveCover = await refreshLocalCover(
      folder.id,
      candidates.newest || null,
      checkpoint,
      true
    );
    const saveTotals = await indexing.totals(folder.id, checkpoint, true);
    // One durable commit per completed directory, after all asynchronous reads.
    // Keep this block synchronous so RPC edits cannot join the transaction.
    db.exec('BEGIN');
    try {
      saveCover?.();
      saveTotals();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    touched.delete(folder.id);
    progress.visited++;
    await checkpoint();
  }
  try {
    autoCheckpoint = one('PRAGMA wal_autocheckpoint').wal_autocheckpoint;
    db.exec('PRAGMA wal_autocheckpoint=0');
    indexing.reset();
    indexing.upsert(nodeFor(rootPath, null, 0, 'folder'), stat, started);
    invalidateRoot(id, {
      preserve: !!target && !offline && !Object.hasOwn(matchOptions, 'onlineMatch')
    });
    if (Object.hasOwn(matchOptions, 'onlineMatch'))
      run(
        `INSERT INTO root_match_policy(root,enabled,types,revision,directory_kind,character_cover) VALUES(?,?,?,1,?,?) ON CONFLICT(root) DO UPDATE SET
        enabled=excluded.enabled,types=excluded.types,directory_kind=excluded.directory_kind,character_cover=excluded.character_cover,revision=root_match_policy.revision+1`,
        id,
        matchOptions.onlineMatch ? 1 : 0,
        JSON.stringify(matchOptions.subjectTypes || []),
        matchOptions.directoryKind || 'work',
        matchOptions.characterCover || 'local-first'
      );
    libraryRevision++;
    emitProgress(true);
    // A progress listener can cancel as soon as the root becomes visible.
    await yieldNow();
    const targetNode = target && getNode(idFor(target));
    const startNode = targetNode?.root === id ? targetNode : getNode(id);
    if (startNode.id !== id) progress.name = path.basename(rootPath) + ' / ' + startNode.name;
    await visit(startNode);
    // Recompute only the visited unfinished ancestry, not every library folder.
    for (const [nid] of [...touched].sort((a, b) => b[1] - a[1])) {
      await indexing.totals(nid, checkpoint);
      await checkpoint();
    }
    for (
      let p = startNode.parent ? getNode(startNode.parent) : null;
      p;
      p = p.parent ? getNode(p.parent) : null
    ) {
      await refreshLocalCover(p.id, undefined, checkpoint);
      await indexing.totals(p.id, checkpoint);
      await checkpoint();
    }
    progress.phase = cancelled ? '已取消，保留已索引内容' : '完成索引';
    if (!offline && !cancelled && matchPolicy(getNode(id)).enabled) {
      if (!target) enqueueRoot(id);
      if (target) {
        let after = '';
        while (!cancelled) {
          const page = q(
            "SELECT s.id FROM scan_new s CROSS JOIN nodes n ON n.id=s.id WHERE s.id>? AND n.kind='folder' AND n.missing=0 ORDER BY s.id LIMIT 64",
            after
          );
          if (!page.length) break;
          enqueueMatch(page.map((node) => node.id));
          after = page.at(-1).id;
          await checkpoint();
        }
        for (
          let node = getNode(startNode.id);
          node;
          node = node.parent ? getNode(node.parent) : null
        )
          if (eligibleMatch(node))
            run(
              'INSERT OR REPLACE INTO match_pending VALUES(?,?,?)',
              node.id,
              id,
              pendingStamp(node)
            );
      }
    }
    return { root: id, cancelled, errors: progress.errors };
  } finally {
    try {
      // Also drain root/cover/totals writes and partial or cancelled tail batches.
      if (autoCheckpoint !== null) await maintenance.checkpoint();
    } finally {
      try {
        if (autoCheckpoint !== null) db.exec(`PRAGMA wal_autocheckpoint=${autoCheckpoint}`);
      } finally {
        running = false;
        // Media rows were seeded in the same bounded commits as nodes. Only the
        // bounded background decoder starts here; no library-wide seed or JS queue.
        media.start().catch((e) => send('error', { message: e.message }));
        progress.active = false;
        progress.finished = Date.now();
        emitProgress(true);
        send('changed', { root: id, revision: libraryRevision });
        reconcileWatches();
        startOnline();
      }
    }
  }
}
let lastRequest = 0,
  requestTail = Promise.resolve(),
  pauseUntil = 0,
  activeNetwork = 0;
function assertMatchLive(guard = () => true) {
  if (stopping || !guard()) {
    const error = new Error('匹配任务已取消。');
    error.code = 'MATCH_CANCELLED';
    throw error;
  }
}
function api(endpoint, body, guard, { refresh = false } = {}) {
  assertMatchLive(guard);
  const scope = accessScope();
  const cached = refresh ? undefined : diskCache.get(scope, endpoint, body);
  if (cached !== undefined) return Promise.resolve(cached);
  activeNetwork++;
  const controller = new AbortController();
  networkControllers.add(controller);
  const work = requestTail.then(async () => {
    assertMatchLive(guard);
    controller.signal.throwIfAborted();
    // Separate manual/automatic recall can enqueue the same API page before its
    // first response is cached. Recheck at dequeue without spending another
    // throttle slot; forced refresh and canceled consumers still bypass reuse.
    const queuedCached = refresh ? undefined : diskCache.get(scope, endpoint, body);
    if (queuedCached !== undefined) return queuedCached;
    for (let attempt = 0; attempt < 2; attempt++) {
      assertMatchLive(guard);
      controller.signal.throwIfAborted();
      const gap = Math.max(1050 - (Date.now() - lastRequest), pauseUntil - Date.now());
      if (gap > 0)
        await require('node:timers/promises').setTimeout(gap, undefined, {
          signal: controller.signal
        });
      assertMatchLive(guard);
      lastRequest = Date.now();
      const token = normalizeAccessToken(workerData.token);
      try {
        const response = await fetch('https://api.bgm.tv' + endpoint, {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          headers: {
            'User-Agent': `ACG-album/${require('../package.json').version} (Local desktop album)`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: 'Bearer ' + token } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(16000)])
        });
        assertMatchLive(guard);
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry?.trim() ? Number(retry) : NaN;
          const deadline =
            Number.isFinite(seconds) && seconds >= 0
              ? Date.now() + seconds * 1000
              : Date.parse(retry || '');
          pauseUntil = Math.max(
            Date.now() + 1050,
            Number.isFinite(deadline) ? deadline : Date.now() + 60000
          );
          const error = new Error('Bangumi 请求过于频繁，已暂停队列，将在等待结束后自动继续。');
          error.code = 'BANGUMI_RATE_LIMIT';
          error.retryAt = pauseUntil;
          throw error;
        }
        if (response.status === 401 || response.status === 403) {
          const error = new Error(
            'Access Token 无效、已过期或权限不足，请在作品简介设置中更新后重试'
          );
          error.code = 'BANGUMI_ACCESS_DENIED';
          throw error;
        }
        if (response.status >= 500 && attempt === 0) continue;
        if (!response.ok) {
          const error = new Error(`Bangumi 请求失败 (${response.status})`);
          error.code = response.status >= 500 ? 'BANGUMI_NETWORK' : 'BANGUMI_RESPONSE';
          throw error;
        }
        const result = await response.json();
        assertMatchLive(guard);
        diskCache.set(scope, endpoint, body, result);
        return result;
      } catch (e) {
        e = safeAccessError(e, token);
        if (
          attempt === 0 &&
          !controller.signal.aborted &&
          e.code !== 'MATCH_CANCELLED' &&
          e.code !== 'BANGUMI_ACCESS_DENIED' &&
          e.code !== 'BANGUMI_TOKEN_INVALID' &&
          !/频繁|请求失败/.test(e.message)
        )
          continue;
        if (!e.code && e.name !== 'AbortError') e.code = 'BANGUMI_NETWORK';
        throw e;
      }
    }
  });
  requestTail = work.catch(() => {});
  return work.finally(() => {
    activeNetwork--;
    networkControllers.delete(controller);
  });
}
function md(subject, staff) {
  return `# ${subject.name_cn || subject.name}\n\n${subject.name || ''}\n\n- 条目：https://bgm.tv/subject/${subject.id}\n- 类型：${subject.type}\n- 日期：${subject.date || '未知'}\n- 评分：${subject.rating?.score || '暂无'}（${subject.rating?.total || 0} 人）\n- 更新：${new Date().toISOString()}\n\n## 简介\n\n${subject.summary || '暂无简介'}\n\n## Staff\n\n${staff.map((p) => '- ' + p.name + ' · ' + (p.relation || '')).join('\n')}\n\n## 信息\n\n${(subject.infobox || []).map((x) => '- ' + x.key + '：' + (typeof x.value === 'string' ? x.value : JSON.stringify(x.value))).join('\n')}\n`;
}
let coverTempCounter = 0;
function saveSubject(
  subject,
  folder,
  manual = false,
  guard,
  types = manual ? manualMatchTypes(folder) : matchPolicy(folder).types,
  options = {}
) {
  if (!safeMatchSubject(subject, types))
    throw new Error('作品类型不符合当前检索类型，请选择对应类型的 Bangumi 条目。');
  const epoch = onlineEpoch;
  const live =
    guard ||
    (() => {
      const current = getNode(folder.id);
      return (
        epoch === onlineEpoch &&
        current &&
        !current.missing &&
        (manual ||
          (current.subject_id === folder.subject_id &&
            current.manual_subject === folder.manual_subject))
      );
    });
  guard = guard
    ? live
    : () =>
        live() &&
        (manual
          ? manualMatchTypes(getNode(folder.id))
          : matchPolicy(getNode(folder.id)).types
        ).join(',') === types.join(',');
  const job = saveSubjectContents(subject, folder, manual, guard, options);
  subjectJobs.add(job);
  return job.finally(() => subjectJobs.delete(job));
}
async function saveSubjectContents(
  subject,
  folder,
  manual,
  guard,
  { refresh = false, matchConfidence, immediate = false } = {}
) {
  assertMatchLive(guard);
  if (!Number.isSafeInteger(subject.id) || subject.id <= 0)
    throw new Error('Bangumi 条目数据无效。');
  activeNetwork++;
  const controller = new AbortController();
  networkControllers.add(controller);
  try {
    const scope = accessScope();
    const row = one('SELECT json FROM metadata WHERE id=?', subject.id);
    let previous;
    try {
      previous = row && JSON.parse(row.json);
    } catch {}
    const local = subject.source === 'local-index';
    const sameIdentity = previous?.id === subject.id && previous?.type === subject.type;
    const previousOnline =
      sameIdentity &&
      previous.details_source !== 'local-index' &&
      (previous.details_source === 'online' || previous.source !== 'local-index');
    const fresh =
      !refresh &&
      sameIdentity &&
      previousOnline &&
      previous?.access_scope === scope &&
      previous.cached_at <= Date.now() &&
      Date.now() - previous.cached_at < 7 * 86400000;
    const staff = local
      ? sameIdentity && Array.isArray(previous.staff) && previous.staff.length
        ? previous.staff
        : localIndex.staffFor(subject.id)
      : fresh && Array.isArray(previous.staff)
        ? previous.staff
        : refresh
          ? await api('/v0/subjects/' + subject.id + '/persons', undefined, guard, {
              refresh: true
            })
          : await sharedMatchRequest(staffCache, String(subject.id), [], guard, (live) =>
              api('/v0/subjects/' + subject.id + '/persons', undefined, live)
            );
    assertMatchLive(guard);
    if (!Array.isArray(staff)) throw new Error('Bangumi 作者资料响应无效。');
    const data = { ...subject, staff };
    if (local) {
      // Archive reads can fill gaps for this exact identity, but cannot replace
      // richer online fields or make another credential's cache appear fresh.
      if (sameIdentity)
        for (const [key, value] of Object.entries(previous)) {
          if (
            value !== undefined &&
            value !== null &&
            value !== '' &&
            (!Array.isArray(value) || value.length > 0)
          )
            data[key] = value;
        }
      data.details_source = previousOnline ? 'online' : 'local-index';
      data.source = previousOnline ? previous.source || 'online' : 'local-index';
      data.cached_at = previousOnline ? previous.cached_at || 0 : 0;
      data.access_scope = previousOnline ? previous.access_scope || '' : '';
    } else {
      data.details_source = 'online';
      data.cached_at = fresh ? previous.cached_at : Date.now();
      data.access_scope = scope;
    }
    // Media downloads only accept Bangumi's image host; never forward the API token.
    let coverPath = fs.existsSync(path.join(cacheHome, 'covers', `${subject.id}.webp`))
      ? path.join(cacheHome, 'covers', `${subject.id}.webp`)
      : null;
    const image = data.images?.large || data.images?.common;
    let coverComplete = !image || (fresh && !!coverPath && previous.cover_url === image);
    if (!local && image && !coverComplete) {
      try {
        const u = new URL(image);
        if (u.protocol === 'https:' && /(^|\.)bgm\.tv$/.test(u.hostname)) {
          const response = await fetch(u, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
          });
          assertMatchLive(guard);
          if (response.ok && Number(response.headers.get('content-length') || 0) < 20000000) {
            const buffer = Buffer.from(await response.arrayBuffer());
            assertMatchLive(guard);
            if (buffer.length > 20000000) throw new Error('封面过大');
            const targetCover = path.join(cacheHome, 'covers', `${subject.id}.webp`);
            const temp = targetCover + `.${++coverTempCounter}.tmp`;
            try {
              await sharp(buffer, { limitInputPixels: 40000000 })
                .resize({ width: 1000, height: 1500, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: 90 })
                .toFile(temp);
              assertMatchLive(guard);
              await fsp.rename(temp, targetCover);
              coverPath = targetCover;
              coverComplete = true;
            } finally {
              if (path.dirname(path.resolve(temp)) === path.resolve(cacheHome, 'covers'))
                await fsp.rm(temp, { force: true }).catch(() => {});
            }
          }
        }
      } catch {}
    }
    assertMatchLive(guard);
    data.local_cover = coverPath;
    data.cover_url =
      local && previousOnline ? previous.cover_url || '' : coverComplete ? image || '' : '';
    data.resources_complete = local
      ? previousOnline
        ? (previous.resources_complete ?? false)
        : false
      : coverComplete;
    const serialized = JSON.stringify(data);
    const markdown = path.join(cacheHome, 'metadata', `${subject.id}.md`);
    if (
      (!local || !previousOnline || !fs.existsSync(markdown)) &&
      (row?.json !== serialized || !fs.existsSync(markdown))
    ) {
      const temp = markdown + `.${++coverTempCounter}.tmp`;
      try {
        await fsp.writeFile(temp, md(data, data.staff), 'utf8');
        assertMatchLive(guard);
        await fsp.rename(temp, markdown);
      } finally {
        if (path.dirname(path.resolve(temp)) === path.resolve(cacheHome, 'metadata'))
          await fsp.rm(temp, { force: true }).catch(() => {});
      }
    }
    assertMatchLive(guard);
    const current = getNode(folder.id);
    if (!current || current.missing) return;
    if (!manual && current.manual_subject && current.subject_id !== subject.id)
      return hydrate(current);
    // Commit the shared metadata and this album's assignment together. No file
    // I/O or asynchronous work runs inside the durable SQLite transaction.
    db.exec('BEGIN');
    try {
      if (row?.json !== serialized)
        run('INSERT OR REPLACE INTO metadata VALUES(?,?,?)', subject.id, serialized, Date.now());
      run(
        'UPDATE nodes SET subject_id=?,manual_subject=?,intro=CASE WHEN ?=1 THEN 1 ELSE intro END WHERE id=?',
        subject.id,
        manual ? 1 : current.manual_subject,
        manual ? 1 : 0,
        folder.id
      );
      if (coverPath && !current.manual_cover)
        run(
          "UPDATE nodes SET cover=?,cover_source='bangumi',confirmed=CASE WHEN ?=? AND cover_source='bangumi' THEN confirmed ELSE 0 END WHERE id=?",
          'subject:' + subject.id,
          current.subject_id,
          subject.id,
          folder.id
        );
      else if (
        current.subject_id !== subject.id &&
        !current.manual_cover &&
        (current.cover_source === 'bangumi' || current.cover?.startsWith('subject:'))
      )
        run('UPDATE nodes SET cover=NULL,cover_source=NULL,confirmed=0 WHERE id=?', folder.id);
      // Matching evidence belongs to this folder, not the shared subject cache.
      // Resource refreshes keep it; manual corrections explicitly resolve it.
      if (manual)
        run(
          'UPDATE nodes SET match_confidence=NULL,match_review=0,confirmed=CASE WHEN ?=1 THEN 1 ELSE confirmed END WHERE id=?',
          current.match_review,
          folder.id
        );
      else if (Number.isFinite(matchConfidence))
        run(
          'UPDATE nodes SET match_confidence=?,match_review=0 WHERE id=?',
          matchConfidence,
          folder.id
        );
      run(
        `UPDATE nodes SET confirmed=1,match_review=0 WHERE id=? AND ${matchedAutomaticSql()}`,
        folder.id
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    if (
      !coverPath &&
      current.subject_id !== subject.id &&
      !current.manual_cover &&
      (current.cover_source === 'bangumi' || current.cover?.startsWith('subject:'))
    )
      await refreshLocalCover(folder.id);
    send('changed', { id: folder.id, ...(!manual && !immediate ? { matching: true } : {}) });
    return hydrate(getNode(folder.id));
  } finally {
    activeNetwork--;
    networkControllers.delete(controller);
  }
}
function matchPolicy(folder) {
  const row = folder && one('SELECT * FROM root_match_policy WHERE root=?', folder.root);
  if (row) {
    let types = JSON.parse(row.types);
    for (let current = folder; current; current = current.parent ? getNode(current.parent) : null) {
      if (current.search_type >= 0) {
        if (current.search_type > 0) types = types.filter((type) => type === current.search_type);
        break;
      }
    }
    return {
      explicit: true,
      kind: albumKind(folder),
      characterCover: row.character_cover || 'local-first',
      networkEnabled: !!row.enabled,
      enabled: albumKind(folder) === 'character' ? true : !!row.enabled,
      types,
      revision: row.revision
    };
  }
  const type = folder ? searchType(folder) : 0;
  return {
    explicit: false,
    kind: folder && albumKind(folder) === 'character' ? 'character' : 'work',
    characterCover: 'local-first',
    networkEnabled: !!setting('autoMatch'),
    enabled: !!setting('autoMatch'),
    types: type ? [type] : [...SUBJECT_TYPES],
    revision: 0
  };
}
function policyStamp(folder) {
  return JSON.stringify(matchPolicy(folder));
}
function pendingStamp(folder) {
  return JSON.stringify([policyStamp(folder), folder.subject_id, folder.manual_subject]);
}
function invalidateRoot(root, { preserve = false } = {}) {
  rootGenerations.set(root, (rootGenerations.get(root) || 0) + 1);
  if (!preserve) {
    run('DELETE FROM match_frontier WHERE root=?', root);
    run('DELETE FROM match_pending WHERE root=?', root);
  }
  for (const [id, job] of onlineQueue) if (job.root === root) onlineQueue.delete(id);
}
function clearOnline({ preserve = false } = {}) {
  onlineEpoch++;
  onlineQueue.clear();
  clearTimeout(onlineRetryTimer);
  onlineRetryTimer = null;
  onlineRetryMonotonic = 0;
  if (!preserve) {
    onlineBatchCancelled = true;
    db.exec('DELETE FROM match_frontier; DELETE FROM match_pending');
    run("UPDATE match_resume SET reason='',retry_at=0,failures=0 WHERE singleton=1");
  }
  searchCache.clear();
  detailCache.clear();
  staffCache.clear();
  for (const controller of networkControllers) controller.abort();
}
function explicitAlbumKind(folder) {
  for (let current = folder; current; current = current.parent ? getNode(current.parent) : null)
    if (current.album_kind && current.album_kind !== 'auto') return current.album_kind;
  return 'auto';
}
function associationMatches(folder, types) {
  if (!folder?.subject_id) return false;
  const row = one('SELECT json FROM metadata WHERE id=?', folder.subject_id);
  try {
    if (!row) return false;
    const subject = JSON.parse(row.json);
    return !!safeMatchSubject(subject, types) && subject.id === folder.subject_id;
  } catch {
    return false;
  }
}
function incompleteResources(folder) {
  if (!folder?.subject_id) return false;
  const row = one('SELECT json FROM metadata WHERE id=?', folder.subject_id);
  if (!row) return false;
  const metadata = JSON.parse(row.json);
  return (
    metadata.resources_complete === false ||
    !!(
      metadata.cover_url &&
      !folder.manual_cover &&
      (folder.cover !== 'subject:' + folder.subject_id ||
        !fs.existsSync(path.join(cacheHome, 'covers', `${folder.subject_id}.webp`)))
    )
  );
}
function eligibleMatch(folder, policy = matchPolicy(folder)) {
  // Imports describe a collection root. Only its direct work/character albums
  // receive automatic identities; manual search remains available at any depth.
  if (!folder || folder.depth !== 1 || folder.parent !== folder.root) return false;
  if (policy.kind === 'character') return characters.eligible(folder, policy);
  if (
    !folder ||
    folder.missing ||
    folder.kind !== 'folder' ||
    (folder.subject_id &&
      associationMatches(folder, policy.types) &&
      !incompleteResources(folder)) ||
    folder.manual_subject ||
    !policy.enabled ||
    !policy.types.length
  )
    return false;
  if (policy.explicit) {
    if (explicitAlbumKind(folder) === 'photo') return false;
  } else if (albumKind(folder) !== 'work') return false;
  const { terms, fallbacks } = searchPlan(folder.name);
  return (
    terms.length > 0 ||
    fallbacks.some((plan) => plan.terms.length > 0) ||
    (policy.kind === 'work' &&
      !!one(
        "SELECT id FROM nodes WHERE parent=? AND missing=0 AND kind='folder' LIMIT 1",
        folder.id
      ))
  );
}
function manualMatchTypes(folder) {
  // An explicit album choice overrides inheritance; otherwise use the same
  // import policy as the automatic matcher before falling back to preferences.
  for (let current = folder; current; current = current.parent ? getNode(current.parent) : null) {
    if (current.search_type >= 0)
      return MANUAL_SUBJECT_TYPES.includes(current.search_type)
        ? [current.search_type]
        : [...MANUAL_SUBJECT_TYPES];
  }
  const imported = folder && one('SELECT types FROM root_match_policy WHERE root=?', folder.root);
  if (imported) return JSON.parse(imported.types);
  const type = searchType(folder);
  return MANUAL_SUBJECT_TYPES.includes(type) ? [type] : [...MANUAL_SUBJECT_TYPES];
}
function matchJob(folder, explicit = false) {
  return {
    root: folder.root,
    generation: rootGenerations.get(folder.root) || 0,
    epoch: onlineEpoch,
    access: accessGeneration,
    policy: policyStamp(folder),
    subject: folder.subject_id,
    manual: folder.manual_subject,
    character: folder.character_id,
    manualCharacter: folder.manual_character,
    customCharacter: folder.custom_character,
    manualTypes: explicit ? manualMatchTypes(folder).join(',') : ''
  };
}
function matchGuard(folder, job, explicit) {
  return () => {
    if (
      stopping ||
      onlineEpoch !== job.epoch ||
      accessGeneration !== job.access ||
      (rootGenerations.get(folder.root) || 0) !== job.generation
    )
      return false;
    const current = getNode(folder.id);
    if (
      !current ||
      current.missing ||
      current.subject_id !== job.subject ||
      current.manual_subject !== job.manual ||
      current.character_id !== job.character ||
      current.manual_character !== job.manualCharacter ||
      current.custom_character !== job.customCharacter ||
      policyStamp(current) !== job.policy
    )
      return false;
    return explicit
      ? manualMatchTypes(current).join(',') === job.manualTypes
      : eligibleMatch(current);
  };
}
// The cache owns identity/TTL/eviction; consumers only share a live request. A
// canceled first consumer must not cancel a later live consumer of that promise.
async function sharedMatchRequest(cache, key, types, guard, load) {
  for (let attempt = 0; attempt < 2; attempt++) {
    assertMatchLive(guard);
    let consumers;
    const value = cache.get(key, types, () => load(() => [...consumers].some((live) => live())));
    consumers = cacheConsumers.get(value);
    if (!consumers) cacheConsumers.set(value, (consumers = new Set()));
    consumers.add(guard);
    try {
      const result = await value;
      assertMatchLive(guard);
      return result;
    } catch (error) {
      // Failed cache entries are evicted before this continuation. A late live
      // consumer may retry one canceled pending load without changing its key.
      if (error.code !== 'MATCH_CANCELLED' || attempt || !guard() || stopping) throw error;
    } finally {
      consumers.delete(guard);
    }
  }
}
function safeMatchSubject(subject, types, expected) {
  return (
    subject &&
    Number.isSafeInteger(subject.id) &&
    subject.id > 0 &&
    types.includes(subject.type) &&
    (!expected || (subject.id === expected.id && subject.type === expected.type))
  );
}
function metadataAliases(subject, types) {
  const row = one('SELECT json FROM metadata WHERE id=?', subject.id);
  if (!row) return subject;
  let cached;
  try {
    cached = JSON.parse(row.json);
  } catch {
    return subject;
  }
  if (cached.access_scope !== accessScope() || !safeMatchSubject(cached, types, subject))
    return subject;
  return {
    ...subject,
    aliases: [...new Set([...subjectNames(subject), ...subjectNames(cached)])].slice(0, 24)
  };
}
async function matchFolder(id, explicit = false, keyword = '', queuedJob, { probe = false } = {}) {
  const folder = getNode(id);
  if (!folder || folder.kind !== 'folder' || folder.missing) return null;
  if (matchPolicy(folder).kind === 'character')
    return characters.match(folder, explicit, keyword, queuedJob);
  if (!explicit && !eligibleMatch(folder)) return hydrate(folder);
  const job = queuedJob || matchJob(folder, explicit),
    guard = matchGuard(folder, job, explicit);
  if (!guard()) return null;
  try {
    const policy = matchPolicy(folder);
    const importMatching = !explicit && policy.explicit && policy.enabled;
    const rank = importMatching ? rankImportSubjects : rankSubjects;
    const types = explicit ? manualMatchTypes(folder) : policy.types;
    // A series may have no searchable title of its own. Probe at most four
    // immediate children, then bind one verified high-scoring work to the parent.
    // Probes never mutate a child and cannot recursively enumerate descendants.
    const seriesFallback = async (otherwise) => {
      if (explicit || probe || folder.subject_id || !guard()) return otherwise;
      const children = q(
        "SELECT name FROM nodes WHERE parent=? AND missing=0 AND kind='folder' ORDER BY sortkey,id LIMIT 4",
        folder.id
      );
      const subjects = new Map();
      for (const child of children) {
        if (!guard()) return null;
        const result = await matchFolder(id, false, child.name, job, { probe: true });
        if (result?.networkDeferred) continue;
        if (result?.matchedSubject) {
          const previous = subjects.get(result.matchedSubject.id);
          if (!previous || result.matchConfidence > previous.match)
            subjects.set(result.matchedSubject.id, {
              subject: result.matchedSubject,
              match: result.matchConfidence,
              total: collections(result.matchedSubject),
              date: dateValue(result.matchedSubject.date)
            });
        }
      }
      assertMatchLive(guard);
      if (!subjects.size) return otherwise;
      // Each child has its own title evidence (including installment numbers).
      // Compare verified scores without treating distinct child names as aliases.
      const verified = [...subjects.values()].filter((item) => item.match > IMPORT_MIN_CONFIDENCE);
      const best = Math.max(...verified.map((item) => item.match));
      const close = verified.filter((item) => best - item.match <= 0.03 + Number.EPSILON * 4);
      const popular = Math.max(...close.map((item) => item.total));
      const choices = close.filter((item) => !popular || item.total >= popular * 0.9);
      choices.sort((a, b) => {
        const date =
          Number.isFinite(a.date) && Number.isFinite(b.date)
            ? b.date - a.date
            : Number.isFinite(a.date)
              ? -1
              : Number.isFinite(b.date)
                ? 1
                : 0;
        return date || b.total - a.total || b.match - a.match || a.subject.id - b.subject.id;
      });
      if (!choices.length) return otherwise;
      const saved = await saveSubject(choices[0].subject, folder, false, guard, types, {
        matchConfidence: choices[0].match
      });
      return saved && incompleteResources(saved) ? { ...saved, localIdentitySaved: true } : saved;
    };
    // The archive supplies independently stored names/aliases and full candidate
    // evidence to the current production ranker. Never hydrate through HTTP just
    // to verify a reliable local identity: restricted/offline APIs can omit it.
    if (
      localIndex.status().available &&
      types.length &&
      (explicit || !associationMatches(folder, types))
    ) {
      const local = localIndex.search({
        query: String(keyword || folder.name).slice(0, 240),
        kind: 'subject',
        types,
        mode: importMatching ? 'import' : 'manual'
      });
      const credible = local.candidates.some((candidate) =>
        importMatching ? candidate.match > IMPORT_MIN_CONFIDENCE : candidate.match >= MIN_CONFIDENCE
      );
      if (local.available && (credible || local.truncated)) {
        assertMatchLive(guard);
        if (!explicit && local.complete && local.selected) {
          if (probe)
            return { matchedSubject: local.selected, matchConfidence: local.selectedMatch };
          const saved = await saveSubject(local.selected, folder, false, guard, types, {
            matchConfidence: local.selectedMatch
          });
          return saved && incompleteResources(saved)
            ? { ...saved, localIdentitySaved: true }
            : saved;
        }
        return {
          ...(explicit
            ? { node: hydrate(getNode(id)), searchAccess: { tokenPresent: !!workerData.token } }
            : {}),
          candidates: local.candidates,
          needs_selection: true,
          localIndex: {
            ...localIndex.status(),
            complete: local.complete,
            truncated: local.truncated
          },
          complete: local.complete,
          truncated: local.truncated
        };
      }
    }
    // Paused HTTP work still gets a local-only pass; misses remain pending.
    if (!explicit && localIndex.status().available && onlinePause())
      return await seriesFallback({ networkDeferred: true });
    if (
      !explicit &&
      folder.subject_id &&
      associationMatches(folder, types) &&
      incompleteResources(folder)
    ) {
      const stored = one('SELECT json FROM metadata WHERE id=?', folder.subject_id);
      let subject = stored && JSON.parse(stored.json);
      if (
        subject?.details_source === 'local-index' ||
        (subject?.source === 'local-index' && subject.details_source !== 'online') ||
        subject?.access_scope !== accessScope() ||
        !(subject.cached_at <= Date.now() && Date.now() - subject.cached_at < 7 * 86400000)
      )
        subject = await api('/v0/subjects/' + folder.subject_id, undefined, guard);
      if (safeMatchSubject(subject, types) && subject.id === folder.subject_id)
        return await saveSubject(subject, folder, false, guard, types);
      if (localIndex.status().available) {
        const error = new Error('Bangumi 条目 ID 或类型与当前关联不一致。');
        error.code = 'BANGUMI_RESPONSE';
        throw error;
      }
    }
    if (
      !explicit &&
      folder.subject_id &&
      !folder.manual_subject &&
      !associationMatches(folder, types)
    ) {
      run(
        `UPDATE nodes SET subject_id=NULL,match_confidence=NULL,match_review=0,
      cover=CASE WHEN cover_source='bangumi' AND manual_cover=0 THEN NULL ELSE cover END,
      cover_source=CASE WHEN cover_source='bangumi' AND manual_cover=0 THEN NULL ELSE cover_source END
      WHERE id=? AND manual_subject=0`,
        folder.id
      );
      folder.subject_id = job.subject = null;
      await refreshLocalCover(folder.id);
      if (!guard()) return null;
      send('changed', { id: folder.id, ...(!explicit ? { matching: true } : {}) });
    }
    const plan = searchPlan(String(keyword || folder.name).slice(0, 240));
    const plans = searchStages(plan);
    if (!plans.length && !explicit)
      return await seriesFallback({ candidates: [], needs_selection: true });
    const details = new Map(),
      allCandidates = new Map();
    for (const [index, { terms, titleGroups, series }] of plans.entries()) {
      const rows = new Map(),
        queryHits = new Map();
      let complete = true;
      // Leave at least one independent detail check for each later note fallback.
      // The complete folder lookup still hydrates at most six unique subject IDs.
      const detailLimit = 6 - Math.min(5, plans.length - index - 1);
      for (const term of terms) {
        if (!guard()) return null;
        const data = await sharedMatchRequest(
          searchCache,
          `${explicit ? 'manual' : 'auto'} ${term}`,
          types,
          guard,
          (live) =>
            searchSubjectPages(term, types, (endpoint, body) => api(endpoint, body, live), {
              fullCandidates: explicit
            })
        );
        if (!guard()) return null;
        complete = complete && data.complete;
        for (const [position, row] of data.data.entries()) {
          if (!safeMatchSubject(row, types)) continue;
          const hits = queryHits.get(row.id) || new Set();
          hits.add(normalize(term));
          queryHits.set(row.id, hits);
          const existing = rows.get(row.id);
          if (existing && existing.subject.type !== row.type) continue;
          const subject = metadataAliases(row, types);
          if (existing) {
            existing.position = Math.min(existing.position, position);
            existing.subject = {
              ...existing.subject,
              aliases: [
                ...new Set([...subjectNames(existing.subject), ...subjectNames(subject)])
              ].slice(0, 24)
            };
          } else rows.set(row.id, { position, subject });
        }
      }
      const candidates = [...rows.values()].map((row) => row.subject);
      const rankCurrent = () =>
        rank(
          terms,
          candidates.flatMap((candidate) =>
            details.has(candidate.id) ? [details.get(candidate.id)].filter(Boolean) : [candidate]
          ),
          types,
          { complete, titleGroups, queryHits, series }
        );
      let ranked = rankCurrent();
      async function detailFor(candidate) {
        if (details.has(candidate.id)) return details.get(candidate.id);
        if (details.size >= detailLimit) return null;
        details.set(candidate.id, null);
        const detail = await sharedMatchRequest(
          detailCache,
          String(candidate.id),
          types,
          guard,
          (live) => api('/v0/subjects/' + candidate.id, undefined, live)
        );
        assertMatchLive(guard);
        const valid = safeMatchSubject(detail, types, candidate) ? detail : null;
        if (!valid) complete = false;
        details.set(candidate.id, valid);
        return valid;
      }
      const exact =
        ranked.selected &&
        ranked.candidates.some(
          (candidate) => candidate.id === ranked.selected.id && candidate.match === 1
        );
      if (!exact) {
        const scores = new Map(
          ranked.candidates.map((candidate) => [candidate.id, candidate.match])
        );
        const hydration = [...rows.values()]
          .sort(
            (a, b) =>
              (scores.get(b.subject.id) || 0) - (scores.get(a.subject.id) || 0) ||
              a.position - b.position
          )
          .map((row) => row.subject);
        if (ranked.selected) hydration.unshift(ranked.selected);
        for (const candidate of hydration) {
          if (details.size >= detailLimit) break;
          await detailFor(candidate);
          if (!guard()) return null;
        }
        ranked = rankCurrent();
      }
      const verified = new Set();
      while ((explicit || !folder.manual_subject) && ranked.selected) {
        const candidate = ranked.selected;
        if (
          verified.has(candidate.id) ||
          (!details.has(candidate.id) && details.size >= detailLimit)
        )
          break;
        verified.add(candidate.id);
        const subject = await detailFor(candidate);
        if (!guard()) return null;
        // Search aliases cannot manufacture identity evidence in a detail response.
        ranked = rankCurrent();
        if (subject && ranked.selected?.id === subject.id) {
          if (!explicit) {
            if (probe) return { matchedSubject: subject, matchConfidence: ranked.selectedMatch };
            return saveSubject(subject, folder, false, guard, types, {
              matchConfidence: ranked.selectedMatch
            });
          }
          break;
        }
      }
      for (const candidate of ranked.candidates) {
        const existing = allCandidates.get(candidate.id);
        if (!existing || candidate.match > existing.match)
          allCandidates.set(candidate.id, candidate);
      }
      // Notes must not compete with an already credible main title, even if its
      // candidates conflict and require the user to choose instead of auto-linking.
      if (
        ranked.candidates.some((candidate) =>
          importMatching
            ? candidate.match > IMPORT_MIN_CONFIDENCE
            : candidate.match >= MIN_CONFIDENCE
        )
      )
        break;
    }
    if (!guard()) return null;
    const candidates = [...allCandidates.values()].sort((a, b) => b.match - a.match);
    const result = {
      ...(explicit
        ? {
            node: hydrate(getNode(id)),
            searchAccess: { tokenPresent: !!workerData.token }
          }
        : {}),
      candidates: candidates.slice(0, 10),
      needs_selection: true
    };
    return candidates.some((candidate) =>
      importMatching ? candidate.match > IMPORT_MIN_CONFIDENCE : candidate.match >= MIN_CONFIDENCE
    )
      ? result
      : await seriesFallback(result);
  } catch (error) {
    if (error.code === 'MATCH_CANCELLED' || !guard()) return null;
    throw error;
  }
}
function beginOnlineBatch() {
  // A pump boundary, pause or retry is not a batch boundary. Durable pending
  // includes the active job; frontier pages belong to the same batch too.
  if (
    onlineBatchCancelled ||
    (!activeOnlineJob &&
      !onlineQueue.size &&
      !one('SELECT id FROM match_pending LIMIT 1') &&
      !one('SELECT root FROM match_frontier LIMIT 1'))
  ) {
    onlineCompleted = 0;
    onlineBatchCancelled = false;
  }
}
function enqueueRoot(root) {
  localPauseSweep = null;
  beginOnlineBatch();
  run("INSERT OR IGNORE INTO match_frontier VALUES(?,'')", root);
}
function enqueueMatch(ids) {
  localPauseSweep = null;
  for (const id of ids) {
    const folder = getNode(id);
    if (eligibleMatch(folder)) {
      beginOnlineBatch();
      run(
        'INSERT OR REPLACE INTO match_pending VALUES(?,?,?)',
        id,
        folder.root,
        pendingStamp(folder)
      );
      if (onlineQueue.size < 64) onlineQueue.set(id, matchJob(folder));
    }
  }
  startOnline();
}
async function fillOnlineQueue(deferred = null) {
  let pendingAfter = '';
  while (!onlineQueue.size && !running && !stopping) {
    // The active task stays on disk until a terminal result is acknowledged.
    const pending = q(
      'SELECT id,stamp FROM match_pending WHERE id>? ORDER BY id LIMIT 64',
      pendingAfter
    );
    for (const { id, stamp } of pending) {
      if (deferred?.has(id)) continue;
      const folder = getNode(id);
      if (!eligibleMatch(folder) || stamp !== pendingStamp(folder))
        run('DELETE FROM match_pending WHERE id=?', id);
      else onlineQueue.set(id, matchJob(folder));
    }
    if (onlineQueue.size) return;
    if (pending.length === 64) {
      pendingAfter = pending.at(-1).id;
      await yieldNow();
      continue;
    }
    const frontier = one('SELECT * FROM match_frontier ORDER BY root LIMIT 1');
    if (!frontier) return;
    pendingAfter = '';
    const root = getNode(frontier.root);
    if (!root || root.missing || !matchPolicy(root).enabled) {
      run('DELETE FROM match_frontier WHERE root=?', frontier.root);
      await yieldNow();
      continue;
    }
    const page = q(
      "SELECT * FROM nodes WHERE parent=? AND kind='folder' AND missing=0 AND id>? ORDER BY id LIMIT 64",
      root.id,
      frontier.after_id
    );
    // Discovery and its bounded page of tasks commit atomically, so restart
    // cannot skip unprocessed members of a page whose cursor already advanced.
    db.exec('BEGIN');
    try {
      if (!page.length) run('DELETE FROM match_frontier WHERE root=?', root.id);
      else {
        for (const folder of page)
          if (eligibleMatch(folder))
            run(
              'INSERT OR IGNORE INTO match_pending VALUES(?,?,?)',
              folder.id,
              root.id,
              pendingStamp(folder)
            );
        run('UPDATE match_frontier SET after_id=? WHERE root=?', page.at(-1).id, root.id);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    await yieldNow();
  }
}
function onlinePause() {
  const state = one('SELECT * FROM match_resume WHERE singleton=1');
  if (state.reason === 'access' && state.scope !== accessScope()) {
    run("UPDATE match_resume SET reason='',retry_at=0,failures=0 WHERE singleton=1");
    return null;
  }
  return state.reason === 'access' ||
    state.retry_at > Date.now() ||
    onlineRetryMonotonic > performance.now()
    ? state
    : null;
}
function onlineStatus(extra = {}) {
  const state = onlinePause();
  const remaining = one('SELECT COUNT(*) total FROM match_pending').total;
  return {
    pending: remaining,
    remaining,
    completed: onlineCompleted,
    // While discovering this is the known workload, not a final denominator.
    total: onlineCompleted + remaining,
    buffered: onlineQueue.size,
    discovering: !!one('SELECT root FROM match_frontier LIMIT 1'),
    paused: state?.reason || '',
    retryAt: state?.retry_at || 0,
    ...extra
  };
}
function scheduleOnlineRetry(state) {
  clearTimeout(onlineRetryTimer);
  onlineRetryTimer = null;
  if (state.reason !== 'access' && !stopping)
    onlineRetryTimer = setTimeout(
      () => {
        onlineRetryTimer = null;
        startOnline();
      },
      Math.min(
        2147483647,
        Math.max(1, state.retry_at - Date.now(), onlineRetryMonotonic - performance.now())
      )
    );
  onlineRetryTimer?.unref();
}
function localPauseKey(state) {
  return (
    state &&
    JSON.stringify([state.reason, state.scope, state.retry_at, state.failures, onlineEpoch])
  );
}
function startOnline() {
  if (cacheChanging || stopping || running || onlineRunning || onlineScheduled) return;
  const paused = onlinePause();
  if (paused && (!localIndex.status().available || localPauseSweep === localPauseKey(paused))) {
    send('online', onlineStatus({ active: false }));
    scheduleOnlineRetry(paused);
    return;
  }
  onlineScheduled = true;
  setImmediate(() => {
    onlineScheduled = false;
    if (cacheChanging || stopping || running) return;
    onlineRunning = true;
    onlineTask = pumpOnline()
      .catch((e) => send('error', { message: e.message }))
      .finally(() => {
        onlineRunning = false;
        onlineTask = null;
        send('online', onlineStatus({ active: false }));
        if (
          !stopping &&
          !running &&
          (onlineQueue.size ||
            one('SELECT id FROM match_pending LIMIT 1') ||
            one('SELECT root FROM match_frontier LIMIT 1'))
        )
          startOnline();
      });
  });
}
async function pumpOnline() {
  const deferred = new Set();
  while (!running && !stopping && (!onlinePause() || localIndex.status().available)) {
    if (!onlineQueue.size) await fillOnlineQueue(deferred);
    const next = onlineQueue.entries().next().value;
    if (!next || running || stopping) break;
    const [id, job] = next;
    onlineQueue.delete(id);
    activeOnlineJob = { id, job };
    send('online', onlineStatus({ active: true, id }));
    let terminal = false;
    try {
      const result = await matchFolder(id, false, '', job);
      terminal = result !== null && !result?.networkDeferred && !result?.localIdentitySaved;
      if (result?.networkDeferred || result?.localIdentitySaved) deferred.add(id);
      if (result?.localIdentitySaved) {
        const current = getNode(id);
        if (
          current &&
          !current.missing &&
          current.root === job.root &&
          !stopping &&
          job.epoch === onlineEpoch &&
          job.access === accessGeneration &&
          job.generation === (rootGenerations.get(job.root) || 0) &&
          policyStamp(current) === job.policy &&
          current.manual_subject === job.manual &&
          current.subject_id === result.subject_id
        )
          run(
            'UPDATE match_pending SET stamp=? WHERE id=? AND stamp=?',
            pendingStamp(current),
            id,
            JSON.stringify([job.policy, job.subject, job.manual])
          );
      }
      if (!localIndex.status().available || !onlinePause())
        run("UPDATE match_resume SET reason='',retry_at=0,failures=0 WHERE singleton=1");
    } catch (e) {
      if (e.code === 'MATCH_CANCELLED' || e.name === 'AbortError' || stopping) continue;
      const access = ['BANGUMI_ACCESS_DENIED', 'BANGUMI_TOKEN_INVALID'].includes(e.code);
      const retryable =
        access ||
        ['BANGUMI_RATE_LIMIT', 'BANGUMI_NETWORK'].includes(e.code) ||
        /429|频繁|fetch failed|timeout|网络/i.test(e.message);
      if (retryable && job.access === accessGeneration) {
        const failures = one('SELECT failures FROM match_resume WHERE singleton=1').failures + 1;
        const now = Date.now();
        const delay = access
          ? 0
          : Math.max(
              (e.retryAt || 0) - now,
              pauseUntil - now,
              Math.min(300000, 5000 * 2 ** Math.min(failures - 1, 6))
            );
        const retryAt = access ? 0 : now + delay;
        onlineRetryMonotonic = access ? 0 : performance.now() + delay;
        run(
          'UPDATE match_resume SET reason=?,retry_at=?,scope=?,failures=? WHERE singleton=1',
          access ? 'access' : 'network',
          retryAt,
          accessScope(),
          failures
        );
      } else terminal = true;
      send('online', onlineStatus({ active: true, id, error: e.message }));
      if (retryable && !localIndex.status().available) break;
      if (retryable) deferred.add(id);
    } finally {
      if (
        terminal &&
        !stopping &&
        job.epoch === onlineEpoch &&
        job.access === accessGeneration &&
        job.generation === (rootGenerations.get(job.root) || 0)
      ) {
        const removed = run(
          'DELETE FROM match_pending WHERE id=? AND stamp=?',
          id,
          JSON.stringify([job.policy, job.subject, job.manual])
        );
        // Only acknowledge the exact durable job we terminated. A replaced or
        // canceled task must not inflate progress, including the final item.
        if (removed.changes === 1) onlineCompleted++;
      }
      activeOnlineJob = null;
    }
  }
  if (localIndex.status().available && onlinePause())
    localPauseSweep = localPauseKey(onlinePause());
}
const thumbJobs = new Map();
let activeThumbs = 0;
const thumbWait = [];
async function thumbSlot(key, priority) {
  if (activeThumbs < 4) {
    activeThumbs++;
    return;
  }
  await new Promise((resolve) => {
    const item = { resolve, key, priority };
    if (priority) {
      const i = thumbWait.findIndex((t) => !t.priority);
      thumbWait.splice(i < 0 ? thumbWait.length : i, 0, item);
    } else thumbWait.push(item);
  });
}
function releaseThumb() {
  const next = thumbWait.shift();
  if (next) next.resolve();
  else activeThumbs--;
}
async function sourceFor(id) {
  const n = getNode(id);
  if (!n || n.missing) throw new Error('资源未在索引中或已离线。');
  if (n.kind === 'image' || n.kind === 'video') return { node: n, file: n.path };
  if (/^(?:subject|character):\d+$/.test(n.cover || '')) {
    const [kind, sid] = n.cover.split(':');
    const file = path.join(
      cacheHome,
      'covers',
      `${kind === 'character' ? 'character-' : ''}${Number(sid)}.webp`
    );
    try {
      const st = await fsp.stat(file);
      return { node: { ...n, path: file, mtime: st.mtimeMs, bytes: st.size }, file };
    } catch {}
  }
  if (n.cover) {
    const image = getNode(n.cover);
    if (image && !image.missing) return { node: image, file: image.path };
  }
  return { node: n, icon: true, file: n.path };
}
async function thumb(id, size = 1024, priority = false) {
  size = [512, 768, 1024].includes(Number(size)) ? Number(size) : 1024;
  const source = await sourceFor(id);
  if (source.node.kind === 'video') {
    const dest = path.join(cacheHome, 'thumbnails', thumbnailKey(source.node, 512) + '.webp');
    return fs.existsSync(dest) ? { path: dest } : { placeholder: true };
  }
  if (source.icon || path.extname(source.file).toLowerCase() === '.ico')
    return { icon: true, path: source.file };
  const key = thumbnailKey(source.node, size);
  const dest = path.join(cacheHome, 'thumbnails', key + '.webp');
  if (fs.existsSync(dest)) {
    run('UPDATE thumbs SET last_used=? WHERE key=?', Date.now(), key);
    return { path: dest };
  }
  if (thumbJobs.has(key)) {
    if (priority) {
      const i = thumbWait.findIndex((t) => t.key === key);
      if (i >= 0) {
        const [item] = thumbWait.splice(i, 1);
        item.priority = true;
        thumbWait.unshift(item);
      }
    }
    return thumbJobs.get(key);
  }
  const job = (async () => {
    await thumbSlot(key, priority);
    try {
      await sharp(source.file, { limitInputPixels: 160000000, page: 0 })
        .rotate()
        .resize({
          width: size,
          height: Math.round((size * 1400) / 1024),
          fit: 'inside',
          withoutEnlargement: true
        })
        // Fast encoding keeps cover quality/alpha while reducing first-view queue time.
        .webp({ quality: 86, alphaQuality: 100, effort: 1 })
        .toFile(dest + '.tmp');
      await fsp.rename(dest + '.tmp', dest);
      const stat = await fsp.stat(dest);
      run(
        'INSERT OR REPLACE INTO thumbs VALUES(?,?,?,?,?)',
        key,
        dest,
        source.file,
        Date.now(),
        stat.size
      );
      return { path: dest };
    } finally {
      releaseThumb();
      thumbJobs.delete(key);
    }
  })();
  thumbJobs.set(key, job);
  return job;
}
let videoSaveTail = Promise.resolve();
function storeVideoThumb({ id, bytes, width, height }) {
  const job = videoSaveTail.then(async () => {
    const n = getNode(id);
    if (!n || n.kind !== 'video' || n.missing) throw new Error('视频不存在。');
    const buffer = Buffer.from(bytes || []);
    if (!buffer.length || buffer.length > 2000000) throw new Error('缩略图数据超出限制。');
    const m = await sharp(buffer, { limitInputPixels: 2000000 }).metadata();
    if (m.format !== 'webp' || m.width > 1024 || m.height > 1024)
      throw new Error('缩略图格式或尺寸无效。');
    const key = thumbnailKey(n, 512),
      dest = path.join(cacheHome, 'thumbnails', key + '.webp'),
      temp = dest + '.tmp';
    await sharp(buffer)
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(temp);
    await fsp.rename(temp, dest);
    const st = await fsp.stat(dest);
    run('INSERT OR REPLACE INTO thumbs VALUES(?,?,?,?,?)', key, dest, n.path, Date.now(), st.size);
    media.setVideoInfo({ id, width, height });
    return { path: dest };
  });
  videoSaveTail = job.catch(() => {});
  return job;
}
async function cacheInfo() {
  return cacheDirectory.cacheStats(cacheHome, home);
}
async function rewriteCachePaths(destination) {
  const source = cacheHome;
  const replace = (file) => {
    if (typeof file !== 'string') return file;
    for (const kind of cacheDirectory.KINDS) {
      if (path.dirname(file).toLowerCase() === path.join(source, kind).toLowerCase())
        return path.join(destination, kind, path.basename(file));
    }
    return file;
  };
  const updates = [];
  for (const row of q('SELECT * FROM thumbs')) {
    let key = row.key;
    const targetSource = replace(row.source);
    let targetPath = replace(row.path);
    if (targetSource !== row.source) {
      const oldStat = await fsp.stat(row.source).catch(() => null);
      const newStat = await fsp.stat(targetSource).catch(() => null);
      if (oldStat && newStat)
        for (const size of [512, 768, 1024]) {
          if (
            thumbnailKey(
              { path: row.source, mtime: oldStat.mtimeMs, bytes: oldStat.size },
              size
            ) !== row.key
          )
            continue;
          key = thumbnailKey(
            { path: targetSource, mtime: newStat.mtimeMs, bytes: newStat.size },
            size
          );
          targetPath = path.join(destination, 'thumbnails', key + '.webp');
          if (fs.existsSync(replace(row.path)) && replace(row.path) !== targetPath)
            await fsp.rename(replace(row.path), targetPath);
          break;
        }
    }
    updates.push({ ...row, key, path: targetPath, source: targetSource });
  }
  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM thumbs');
    for (const row of updates)
      run(
        'INSERT OR REPLACE INTO thumbs VALUES(?,?,?,?,?)',
        row.key,
        row.path,
        row.source,
        row.last_used,
        row.bytes
      );
    for (const table of ['metadata', 'character_metadata'])
      for (const row of q(`SELECT id,json FROM ${table}`)) {
        const value = JSON.parse(row.json);
        if (value.local_cover && replace(value.local_cover) !== value.local_cover) {
          value.local_cover = replace(value.local_cover);
          run(`UPDATE ${table} SET json=? WHERE id=?`, JSON.stringify(value), row.id);
        }
      }
    setSetting('cacheDirectory', destination === home ? '' : destination);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  cacheHome = destination;
}
async function relocateCache(destination) {
  const result = await cacheDirectory.migrateCache({
    source: cacheHome,
    destination,
    roots: q('SELECT path FROM nodes WHERE parent IS NULL').map((row) => row.path),
    commit: rewriteCachePaths,
    progress: (data) => send('cache-progress', data)
  });
  send('changed', { cache: true });
  return {
    ...(await cacheInfo()),
    ...(result?.cleanupWarning ? { warning: result.cleanupWarning } : {})
  };
}
async function cleanCache(mode = 'unused') {
  if (!['unused', 'all-thumbnails', 'metadata', 'reset-cache'].includes(mode))
    throw new Error('不支持的缓存清理方式。');
  // Complete safety preflight before the first deletion in every cleanup mode.
  await cacheInfo();
  if (mode === 'reset-cache') {
    const result = await cacheDirectory.resetCacheFiles(cacheHome, () => {
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM thumbs; DELETE FROM metadata; DELETE FROM character_metadata');
        diskCache.clear();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      searchCache.clear();
      detailCache.clear();
      staffCache.clear();
    });
    send('changed', { cache: true });
    return result;
  }
  let removed = 0,
    bytes = 0;
  const live = new Set(
    q("SELECT path FROM nodes WHERE missing=0 AND kind IN ('image','video')").map((n) => n.path)
  );
  const valid = new Set(
    q("SELECT * FROM nodes WHERE missing=0 AND kind IN ('image','video')").flatMap((n) =>
      [512, 768, 1024].map((size) => thumbnailKey(n, size))
    )
  );
  for (const n of q('SELECT * FROM nodes WHERE missing=0 AND cover IS NOT NULL')) {
    const match = /^([a-z-]+):(\d+)$/.exec(n.cover);
    if (!match) continue;
    try {
      const filename = (match[1] === 'subject' ? '' : match[1] + '-') + match[2] + '.webp';
      const file = path.join(cacheHome, 'covers', filename),
        st = await fsp.stat(file);
      for (const size of [512, 768, 1024])
        valid.add(thumbnailKey({ ...n, path: file, mtime: st.mtimeMs, bytes: st.size }, size));
    } catch {}
  }
  for (const row of q('SELECT * FROM thumbs')) {
    if (
      mode === 'all-thumbnails' ||
      !valid.has(row.key) ||
      (!live.has(row.source) && !row.source.startsWith(path.join(cacheHome, 'covers') + path.sep))
    ) {
      const expected = path.join(cacheHome, 'thumbnails', row.key + '.webp');
      if (row.path !== expected) continue;
      try {
        await fsp.unlink(expected);
        removed++;
        bytes += row.bytes;
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      run('DELETE FROM thumbs WHERE key=?', row.key);
    }
  }
  // Orphans are safe to delete only inside the app-owned cache directory.
  const known = new Set(q('SELECT path FROM thumbs').map((t) => t.path));
  for (const e of await fsp.readdir(path.join(cacheHome, 'thumbnails'))) {
    const file = path.join(cacheHome, 'thumbnails', e);
    if (!known.has(file)) {
      const st = await fsp.stat(file);
      await fsp.unlink(file);
      removed++;
      bytes += st.size;
    }
  }
  if (mode === 'metadata') {
    if (onlineRunning) throw new Error('正在同步简介，请稍后再清理。');
    for (const e of await fsp.readdir(path.join(cacheHome, 'metadata'))) {
      const file = path.join(cacheHome, 'metadata', e);
      const st = await fsp.stat(file);
      await fsp.unlink(file);
      removed++;
      bytes += st.size;
    }
    db.exec('DELETE FROM metadata; DELETE FROM character_metadata');
    diskCache.clear();
    searchCache.clear();
    detailCache.clear();
    staffCache.clear();
  }
  // Keep covers currently referenced; preserve manual subject associations and crop settings.
  const referenced = new Set(
    q('SELECT DISTINCT subject_id AS id FROM nodes WHERE missing=0 AND subject_id IS NOT NULL').map(
      (n) => String(n.id) + '.webp'
    )
  );
  for (const row of q('SELECT DISTINCT cover FROM nodes WHERE missing=0 AND cover IS NOT NULL')) {
    const match = /^([a-z-]+):(\d+)$/.exec(row.cover);
    if (match) referenced.add((match[1] === 'subject' ? '' : match[1] + '-') + match[2] + '.webp');
  }
  for (const e of await fsp.readdir(path.join(cacheHome, 'covers'))) {
    if (!referenced.has(e)) {
      const file = path.join(cacheHome, 'covers', e);
      const st = await fsp.stat(file);
      await fsp.unlink(file);
      removed++;
      bytes += st.size;
    }
  }
  send('changed', {});
  return { removed, bytes };
}
async function setCover({ id, imageId }) {
  const folder = getNode(id),
    image = getNode(imageId);
  if (!folder || folder.kind !== 'folder' || !image || image.kind !== 'image' || image.missing)
    throw new Error('请选择相册内的图片。');
  const rel = path.relative(folder.path, image.path);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('封面必须来自该相册内部。');
  run(
    "UPDATE nodes SET cover=?,cover_source='manual',manual_cover=1,confirmed=1,crop_x=50,crop_y=50,crop_zoom=1,cover_revision=? WHERE id=?",
    imageId,
    `${image.mtime}-${image.bytes}`,
    id
  );
  send('changed', { id, cover: true });
  return hydrate(getNode(id));
}
async function selectCoverPath({ id, file }) {
  const n = getNode(id);
  if (!n || n.kind !== 'folder') throw new Error('相册不存在');
  file = path.resolve(file);
  const rel = path.relative(n.path, file);
  if (
    rel.startsWith('..') ||
    path.isAbsolute(rel) ||
    !IMAGE_EXT.has(path.extname(file).toLowerCase())
  )
    throw new Error('请选择该相册内部的图片。');
  const realFolder = await fsp.realpath(n.path),
    realFile = await fsp.realpath(file),
    realRel = path.relative(realFolder, realFile);
  if (realRel.startsWith('..') || path.isAbsolute(realRel))
    throw new Error('封面不能通过目录链接指向相册外部。');
  let parent = n;
  for (const name of rel.split(path.sep).slice(0, -1)) {
    const p = path.join(parent.path, name),
      s = await fsp.lstat(p);
    if (s.isSymbolicLink()) throw new Error('暂不支持目录链接中的封面。');
    const nid = idFor(p);
    const indexed = getNode(nid);
    if (indexed && !indexed.missing) {
      parent = indexed;
      continue;
    }
    run(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET missing=0',
      nid,
      n.root,
      parent.id,
      p,
      name,
      sortKey(name),
      'folder',
      parent.depth + 1,
      s.size,
      s.mtimeMs,
      s.birthtimeMs,
      Date.now()
    );
    run('DELETE FROM search_index WHERE id=?', nid);
    run('INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE id=?', nid);
    parent = getNode(nid);
  }
  const s = await fsp.lstat(file);
  if (s.isSymbolicLink() || !s.isFile()) throw new Error('请选择普通图片文件。');
  const imageId = idFor(file);
  const indexed = getNode(imageId);
  const changed =
    !indexed || indexed.missing || indexed.bytes !== s.size || indexed.mtime !== s.mtimeMs;
  // Manual selection can discover/revive an image without a scan. Persist its
  // media revision with the node; unchanged nodes may also need a missing row.
  db.exec('BEGIN');
  try {
    if (changed) {
      run(
        'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET missing=0,bytes=excluded.bytes,mtime=excluded.mtime',
        imageId,
        n.root,
        parent.id,
        file,
        path.basename(file),
        sortKey(path.basename(file)),
        'image',
        parent.depth + 1,
        s.size,
        s.mtimeMs,
        s.birthtimeMs,
        Date.now()
      );
      run('DELETE FROM search_index WHERE id=?', imageId);
      run(
        'INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE id=?',
        imageId
      );
    }
    media.sync(getNode(imageId));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (changed) for (let p = parent; p; p = p.parent ? getNode(p.parent) : null) updateTotals(p.id);
  if (!running && !stopping) media.start().catch((e) => send('error', { message: e.message }));
  return setCover({ id, imageId });
}
const watchers = new Map(),
  watchPending = new Map();
let watchTimer;
function queueWatch(root, filename) {
  const absolute = filename ? path.join(root.path, String(filename)) : root.path;
  const changed = getNode(idFor(absolute))?.kind === 'folder' ? absolute : path.dirname(absolute);
  if (
    changed.toLowerCase().startsWith(home.toLowerCase() + path.sep) ||
    changed.toLowerCase() === home.toLowerCase()
  )
    return;
  if (!watchPending.has(root.id)) watchPending.set(root.id, new Set());
  watchPending.get(root.id).add(changed);
  clearTimeout(watchTimer);
  watchTimer = setTimeout(drainWatches, 1400);
}
async function drainWatches() {
  if (cacheChanging || running) {
    watchTimer = setTimeout(drainWatches, 1400);
    return;
  }
  const entry = watchPending.entries().next().value;
  if (!entry) return;
  const [rootId, paths] = entry;
  watchPending.delete(rootId);
  const root = getNode(rootId);
  if (root && !root.missing) {
    const targets = [];
    for (let p of [...paths].sort((a, b) => a.length - b.length)) {
      while (
        p.toLowerCase().startsWith(root.path.toLowerCase()) &&
        (!getNode(idFor(p)) || !fs.existsSync(p)) &&
        p !== root.path
      )
        p = path.dirname(p);
      if (!targets.includes(p)) targets.push(p);
    }
    for (const target of targets) {
      try {
        await scan(root.path, { target, offline: root.path.includes(path.join('src', 'demo')) });
      } catch (e) {
        send('watch', { error: e.message, root: rootId });
      }
    }
  }
  if (watchPending.size) watchTimer = setTimeout(drainWatches, 500);
}
function reconcileWatches() {
  const live = setting('watchChanges') && workerData.watch !== false ? roots() : [];
  for (const [id, w] of watchers)
    if (!live.some((n) => n.id === id)) {
      w.close();
      watchers.delete(id);
    }
  for (const root of live)
    if (!watchers.has(root.id)) {
      try {
        const w = fs.watch(root.path, { recursive: true }, (_, filename) =>
          queueWatch(root, filename)
        );
        w.on('error', (e) => {
          send('watch', { error: e.message, root: root.id });
          w.close();
          watchers.delete(root.id);
        });
        watchers.set(root.id, w);
      } catch (e) {
        send('watch', { error: e.message, root: root.id });
      }
    }
}
const methods = {
  localIndexStatus: () => localIndex.status(),
  searchLocalIndex: (args) => localIndex.search(args),
  init: () => ({
    localIndex: localIndex.status(),
    roots: roots(),
    settings: {
      ...defaults,
      ...Object.fromEntries(
        q('SELECT * FROM settings')
          .filter((x) => x.key !== 'token')
          .map((s) => [s.key, JSON.parse(s.value)])
      ),
      githubRepository: effectiveRepository(setting('githubRepository'))
    },
    progress,
    online: onlineStatus({ active: onlineRunning }),
    stats: one(
      "SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN kind IN ('image','video') THEN 1 ELSE 0 END),0) images,COALESCE(SUM(CASE WHEN kind='folder' THEN 1 ELSE 0 END),0) folders FROM nodes WHERE missing=0"
    ),
    dataDir: home
  }),
  list,
  confirmReview,
  get: ({ id }) => hydrate(getNode(id)),
  ancestors: ({ id }) =>
    q(
      'WITH RECURSIVE chain AS (SELECT * FROM nodes WHERE id=? UNION ALL SELECT n.* FROM nodes n JOIN chain c ON n.id=c.parent) SELECT id,name,path FROM chain ORDER BY depth',
      id
    ),
  scan: ({ path: p, ...options }) => scan(p, options),
  cancel: () => {
    cancelled = true;
    clearOnline();
    return true;
  },
  thumb: ({ id, size, priority }) => thumb(id, size, priority),
  asset: async ({ id }) => {
    const n = getNode(id);
    if (!n || !['image', 'video'].includes(n.kind) || n.missing) throw new Error('媒体不存在。');
    return { path: n.path };
  },
  source: ({ id }) => sourceFor(id),
  mediaInfo: ({ id }) => media.ensure(id),
  mediaStats: () => media.stats(),
  setPlace: (args) => media.setPlace(args),
  frame: ({ id, index, size }) => media.frame(id, index, size),
  exportMedia: (args) => media.export(args),
  storeVideoThumb,
  setAlbumKind: ({ id, kind }) => {
    const n = getNode(id);
    if (n?.kind !== 'folder' || !['auto', 'work', 'character', 'photo'].includes(kind))
      throw new Error('相册类型无效。');
    run('UPDATE nodes SET album_kind=? WHERE id=?', kind, id);
    send('changed', { id });
    return hydrate(getNode(id));
  },
  setCover,
  selectCoverPath,
  patch: ({ id, changes }) => {
    const allowed = {
      crop_x: [0, 100],
      crop_y: [0, 100],
      crop_zoom: [1, 4],
      confirmed: [0, 1],
      match_review: [0, 0],
      favorite: [0, 1],
      intro: [-1, 1],
      search_type: [-1, 6]
    };
    for (const [k, v] of Object.entries(changes)) {
      if (
        (k === 'search_type' && ![-1, 0, 1, 2, 3, 4, 6].includes(v)) ||
        !allowed[k] ||
        !Number.isFinite(v) ||
        v < allowed[k][0] ||
        v > allowed[k][1]
      )
        throw new Error('无效设置');
    }
    const entries = Object.entries(changes);
    if (entries.length)
      run(
        `UPDATE nodes SET ${entries.map(([key]) => key + '=?').join(',')} WHERE id=?`,
        ...entries.map(([, value]) => value),
        id
      );
    send('changed', {
      id,
      cover: Object.keys(changes).every((k) =>
        ['crop_x', 'crop_y', 'crop_zoom', 'confirmed'].includes(k)
      )
    });
    return hydrate(getNode(id));
  },
  resetCover: async ({ id }) => {
    const n = getNode(id);
    run(
      `UPDATE nodes SET manual_cover=0,crop_x=50,crop_y=50,crop_zoom=1,cover_revision=NULL,cover_source=NULL,cover=NULL,confirmed=CASE WHEN ${matchedIdentitySql()} THEN 1 ELSE 0 END WHERE id=?`,
      id
    );
    await refreshLocalCover(id);
    const current = getNode(id);
    if (
      albumKind(current) === 'character' &&
      current.character_id &&
      matchPolicy(current).characterCover === 'bangumi' &&
      fs.existsSync(characters.coverFile(current.character_id))
    )
      run(
        `UPDATE nodes SET cover=?,cover_source='bangumi-character',confirmed=CASE WHEN ${matchedAutomaticSql()} THEN 1 ELSE 0 END WHERE id=?`,
        'character:' + current.character_id,
        id
      );
    if (
      albumKind(current) !== 'character' &&
      current.subject_id &&
      !['local-icon', 'local-name', 'folder-icon'].includes(current.cover_source)
    ) {
      const m = one('SELECT json FROM metadata WHERE id=?', current.subject_id);
      if (m && JSON.parse(m.json).local_cover)
        run(
          `UPDATE nodes SET cover=?,cover_source='bangumi',confirmed=CASE WHEN ${matchedAutomaticSql()} THEN 1 ELSE 0 END WHERE id=?`,
          'subject:' + current.subject_id,
          id
        );
    }
    send('changed', { id, cover: true });
    return hydrate(getNode(id));
  },
  settings: ({ key, value }) => {
    if (!Object.hasOwn(defaults, key) && key !== 'collapsed') throw new Error('不支持的设置');
    if (key === 'nickname') {
      value = String(value).trim();
      if (!value || value.length > 24) throw new Error('显示名称应为 1–24 个字符。');
    }
    if (
      key === 'avatar' &&
      (typeof value !== 'string' ||
        (value !== '' && !/^data:image\/webp;base64,[A-Za-z0-9+/=]{1,180000}$/.test(value)))
    )
      throw new Error('头像格式无效。');
    if (key === 'sidebarMode' && !['auto', 'expanded', 'compact'].includes(value))
      throw new Error('侧栏模式无效。');
    if (key === 'liquidGlass' && typeof value !== 'boolean')
      throw new Error('玻璃材质开关应为布尔值。');
    if (key === 'motionLevel' && !['low', 'medium', 'high'].includes(value))
      throw new Error('动效强度无效。');
    if (key === 'githubRepository') {
      value = effectiveRepository(value);
      if (!validRepository(value)) throw new Error('GitHub 仓库应填写「所有者/仓库名」。');
    }
    const result = setSetting(key, value);
    if (key === 'watchChanges') reconcileWatches();
    return result;
  },
  token: ({ value }) => {
    value = normalizeAccessToken(value);
    if (workerData.token !== value) {
      const pending = [...onlineQueue];
      if (activeOnlineJob && !onlineQueue.has(activeOnlineJob.id))
        pending.push([activeOnlineJob.id, activeOnlineJob.job]);
      // Validate before advancing access: cancellation, root/policy changes and
      // manual associations must never be revived by a credential update.
      const resumable = pending.filter(([id, job]) => {
        const folder = getNode(id);
        return folder && matchGuard(folder, job, false)();
      });
      workerData.token = value;
      accessGeneration++;
      onlineQueue.clear();
      // Copy rather than mutate so the old in-flight response remains stale.
      for (const [id, job] of resumable) onlineQueue.set(id, { ...job, access: accessGeneration });
      searchCache.clear();
      detailCache.clear();
      staffCache.clear();
      run("UPDATE match_resume SET reason='',retry_at=0,failures=0 WHERE singleton=1");
      clearTimeout(onlineRetryTimer);
      onlineRetryTimer = null;
      onlineRetryMonotonic = 0;
      for (const controller of networkControllers) controller.abort();
      startOnline();
    }
    return true;
  },
  match: ({ id, keyword }) => matchFolder(id, true, keyword),
  bind: async ({ id, url, kind, custom }) => {
    const n = getNode(id);
    if (!n || n.kind !== 'folder') throw new Error('请选择相册');
    if (kind === 'character' || matchPolicy(n).kind === 'character')
      return characters.bind(n, { url, custom });
    const subjectId = parseSubjectId(url),
      types = manualMatchTypes(n),
      job = matchJob(n, true),
      guard = matchGuard(n, job, true);
    const local = localIndex.readSubject(subjectId);
    const subject = safeMatchSubject(local, types)
      ? local
      : await api('/v0/subjects/' + subjectId, undefined, guard);
    if (!safeMatchSubject(subject, types) || subject.id !== subjectId)
      throw new Error('作品类型或条目 ID 不符合当前选择，请选择对应类型的 Bangumi 条目。');
    const saved = await saveSubject(subject, n, true, guard, types);
    if (subject.source !== 'local-index' || !saved || onlinePause()) return saved;
    const current = getNode(id),
      detailGuard = matchGuard(current, matchJob(current, true), true);
    try {
      const detail = await api('/v0/subjects/' + subjectId, undefined, detailGuard);
      if (!safeMatchSubject(detail, types, subject)) return hydrate(getNode(id));
      return await saveSubject(detail, current, true, detailGuard, types);
    } catch {
      // The explicit association is already durable and usable offline. Only a
      // live, validated detail response may enrich it; failures keep local data.
      return hydrate(getNode(id));
    }
  },
  refreshMetadata: async ({ id }) => {
    const n = getNode(id);
    if (n && matchPolicy(n).kind === 'character') return characters.refresh(n);
    if (!n?.subject_id) throw new Error('尚未绑定作品条目。');
    const types = n.manual_subject ? manualMatchTypes(n) : matchPolicy(n).types,
      job = matchJob(n, true),
      guard = matchGuard(n, job, true);
    let subject;
    try {
      subject = await api('/v0/subjects/' + n.subject_id, undefined, guard, { refresh: true });
    } catch (error) {
      assertMatchLive(guard);
      subject = localIndex.readSubject(n.subject_id);
      if (!safeMatchSubject(subject, types)) throw error;
    }
    if (!safeMatchSubject(subject, types) || subject.id !== n.subject_id)
      throw new Error('作品类型或条目 ID 不符合当前关联，请重新检索作品。');
    return saveSubject(subject, n, !!n.manual_subject, guard, types, {
      refresh: true,
      immediate: true
    });
  },
  sync: async ({ id }) => {
    if (id) enqueueMatch([id]);
    else {
      let after = '';
      while (!stopping) {
        const roots = q(
          'SELECT * FROM nodes WHERE parent IS NULL AND missing=0 AND id>? ORDER BY id LIMIT 64',
          after
        );
        if (!roots.length) break;
        for (const root of roots) if (matchPolicy(root).enabled) enqueueRoot(root.id);
        after = roots.at(-1).id;
        await yieldNow();
      }
      startOnline();
    }
    return {
      queued: onlineQueue.size + one('SELECT COUNT(*) total FROM match_frontier').total,
      ...onlineStatus()
    };
  },
  syncStatus: () => onlineStatus({ active: onlineRunning }),
  cacheInfo,
  changeCacheDirectory: ({ path: selected }) =>
    changeCache(() => {
      if (typeof selected !== 'string' || !path.isAbsolute(selected))
        throw new Error('请选择有效的缓存父目录。');
      return relocateCache(path.join(selected, cacheDirectory.DIRECTORY_NAME));
    }),
  resetCacheDirectory: () => changeCache(() => relocateCache(home)),
  cleanCache: ({ mode }) => changeCache(() => cleanCache(mode)),

  clipboardImage: async ({ id }) => {
    const { path: p } = await methods.asset({ id });
    return sharp(p, { limitInputPixels: 160000000, page: 0 }).rotate().png().toBuffer();
  },
  dimensions: async ({ id }) => {
    const { path: p } = await methods.asset({ id });
    try {
      const m = await sharp(p, { limitInputPixels: 160000000 }).metadata();
      return { width: m.width, height: m.height, format: m.format };
    } catch {
      return { width: null, height: null, format: path.extname(p) };
    }
  },
  removeRoot: ({ id }) => {
    const n = getNode(id);
    if (!n || n.parent) throw new Error('只可移除顶层分类。');
    if (running) throw new Error('请先等待导入完成。');
    invalidateRoot(id);
    db.exec('BEGIN');
    try {
      run('DELETE FROM search_index WHERE id IN (SELECT id FROM nodes WHERE root=?)', id);
      run('DELETE FROM nodes WHERE root=?', id);
      run('DELETE FROM root_match_policy WHERE root=?', id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    media.seed();
    send('changed', {});
    reconcileWatches();
    return true;
  },
  shutdown: async () => {
    if (cacheTask) await cacheTask.catch(() => {});
    stopping = true;
    cancelled = true;
    clearOnline({ preserve: true });
    if (scanTask) await scanTask.catch(() => {});
    if (onlineTask) await onlineTask.catch(() => {});
    await Promise.allSettled([...subjectJobs]);
    await requestTail;
    for (const w of watchers.values()) w.close();
    clearTimeout(watchTimer);
    clearTimeout(mediaStartupTimer);
    await videoSaveTail;
    await media.stop();
    await Promise.allSettled([...thumbJobs.values()]);
    localIndex.close();
    try {
      await maintenance.close();
    } finally {
      db.close();
    }
    return true;
  }
};
let mediaStartupTimer;
const sortKeysReady = migrateSortKeys();
parentPort.on('message', async ({ request, method, args }) => {
  let tracked = false;
  try {
    await sortKeysReady;
    if (!Object.hasOwn(methods, method)) throw new Error('未知操作');
    if (cacheChanging && method !== 'shutdown' && !cacheReadMethods.has(method))
      throw new Error('正在管理缓存，请稍后再试。');
    tracked =
      !cacheReadMethods.has(method) &&
      !['changeCacheDirectory', 'resetCacheDirectory', 'cleanCache', 'shutdown'].includes(method);
    if (tracked) activeRequests++;
    const result = await methods[method](args || {});
    parentPort.postMessage({ request, result });
  } catch (e) {
    parentPort.postMessage({ request, error: e.message, stack: e.stack });
  } finally {
    if (tracked) activeRequests--;
  }
});
sortKeysReady.then(
  () => {
    // Existing libraries need this reconciliation once. Scanner commits already
    // seed/reset individual media rows atomically with each changed node.
    migrateOnce('mediaSeedVersion', 1, () => media.seed());
    mediaStartupTimer = setTimeout(() => {
      if (!running) media.start().catch((e) => send('error', { message: e.message }));
    }, 600);
    reconcileWatches();
    parentPort.postMessage({ event: 'ready', data: {} });
    if (
      one('SELECT id FROM match_pending LIMIT 1') ||
      one('SELECT root FROM match_frontier LIMIT 1')
    )
      startOnline();
  },
  (error) => {
    setImmediate(() => {
      throw error;
    });
  }
);
