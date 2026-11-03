'use strict';
const path = require('node:path');

const CONTENT_DATE_VERSION = 2;
const MAX_DATE = 8640000000000000;
const SORTS = new Set(['name', 'date', 'modified', 'size', 'contentDate']);
const VIEWS = new Set(['library', 'favorites', 'pending', 'timeline']);
const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function normalizeScopePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error('排序偏好的目录路径无效。');
  const normalized = path.win32.normalize(value.replace(/\//g, '\\')).toLowerCase();
  // A rooted path such as \\photos is drive-relative, rather than an absolute scope.
  if (!/^[a-z]:\\/u.test(normalized) && !/^\\\\[^\\]+\\[^\\]+/u.test(normalized))
    throw new Error('排序偏好的目录路径无效。');
  return /^(?:\\\\\?\\)?[a-z]:\\$/u.test(normalized) ? normalized : normalized.replace(/\\+$/u, '');
}

function normalizeBrowseSortPreferences(value) {
  if (!plain(value) || Reflect.ownKeys(value).length > 1024)
    throw new Error('排序偏好应为最多 1024 项的对象。');
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !key || key.length > 8192)
      throw new Error('排序偏好的范围无效。');
    let scope;
    try {
      scope = JSON.parse(key);
    } catch {
      throw new Error('排序偏好的范围无效。');
    }
    if (!Array.isArray(scope) || scope.length !== 2 || !VIEWS.has(scope[0]))
      throw new Error('排序偏好的范围无效。');
    const canonical = JSON.stringify([
      scope[0],
      scope[1] === null ? null : normalizeScopePath(scope[1])
    ]);
    if (key !== canonical) throw new Error('排序偏好的范围应使用规范化路径。');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const preference = descriptor.value;
    if (
      !plain(preference) ||
      Reflect.ownKeys(preference).length !== 2 ||
      !Object.hasOwn(preference, 'sort') ||
      !Object.hasOwn(preference, 'direction') ||
      !SORTS.has(preference.sort) ||
      !['asc', 'desc'].includes(preference.direction)
    )
      throw new Error('排序偏好的排序方式或方向无效。');
    result[key] = { sort: preference.sort, direction: preference.direction };
  }
  return result;
}

// SQLite stores NaN as NULL; the type/range checks also reject text, Infinity,
// unsupported timestamps and the zero/negative filesystem sentinel values.
const validTime = (column) =>
  `(typeof(${column}) IN ('integer','real') AND ${column}>0 AND ${column}<=${MAX_DATE})`;
const validTaken = (column) =>
  `(typeof(${column}) IN ('integer','real') AND ${column}>=-${MAX_DATE} AND ${column}<=${MAX_DATE})`;
function filesystemDateSql(alias = 'n') {
  const birth = `${alias}.birth`,
    modified = `${alias}.mtime`;
  // Explorer gives folders DateCreated as their primary date. A copied folder
  // must keep its creation date even if its modification date is older.
  return `CASE WHEN ${validTime(birth)} THEN
    CASE WHEN ${alias}.kind='folder' THEN ${birth}
      WHEN ${validTime(modified)} THEN min(${birth},${modified}) ELSE ${birth} END
    WHEN ${validTime(modified)} THEN ${modified} ELSE 0 END`;
}
function contentDateSql(alias = 'n') {
  return `COALESCE((SELECT m.taken FROM media m WHERE m.id=${alias}.id
    AND ${alias}.kind IN ('image','video') AND m.date_source IN ('exif-local','exif-offset')
    AND ${validTaken('m.taken')}),${filesystemDateSql(alias)})`;
}

/** Instantiate only after createMedia() has created media. Schema-only startup
 * work does not traverse nodes; backfill/index creation belongs to migrate().
 * Both rename update orders (nodes first or media first) converge via ID triggers.
 */
function createBrowseDate(db) {
  if (
    !db
      .prepare('PRAGMA table_info(nodes)')
      .all()
      .some((column) => column.name === 'content_date')
  )
    db.exec('ALTER TABLE nodes ADD COLUMN content_date REAL');
  const marker = db
    .prepare('SELECT value FROM settings WHERE key=?')
    .get('browseContentDateVersion');
  let ready = marker?.value === JSON.stringify(CONTENT_DATE_VERSION);
  // Preview v1 cached min(birth,mtime) for folders and installed these same
  // trigger names. Replace only stale definitions, without scanning node rows.
  db.exec('SAVEPOINT browse_date_schema');
  try {
    if (!ready)
      for (const suffix of [
        'node_insert',
        'node_update',
        'media_insert',
        'media_update',
        'media_delete'
      ])
        db.exec(`DROP TRIGGER IF EXISTS browse_date_${suffix}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS browse_date_node_insert AFTER INSERT ON nodes BEGIN
      UPDATE nodes SET content_date=${contentDateSql('nodes')} WHERE rowid=NEW.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS browse_date_node_update AFTER UPDATE OF birth,mtime,kind,id ON nodes
      WHEN OLD.birth IS NOT NEW.birth OR OLD.mtime IS NOT NEW.mtime
        OR OLD.kind IS NOT NEW.kind OR OLD.id IS NOT NEW.id BEGIN
      UPDATE nodes SET content_date=${contentDateSql('nodes')} WHERE rowid=NEW.rowid;
    END;
    CREATE TRIGGER IF NOT EXISTS browse_date_media_insert AFTER INSERT ON media BEGIN
      UPDATE nodes SET content_date=${contentDateSql('nodes')} WHERE id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS browse_date_media_update AFTER UPDATE OF taken,date_source,id ON media
      WHEN OLD.taken IS NOT NEW.taken OR OLD.date_source IS NOT NEW.date_source OR OLD.id IS NOT NEW.id BEGIN
      UPDATE nodes SET content_date=${contentDateSql('nodes')} WHERE id=OLD.id OR id=NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS browse_date_media_delete AFTER DELETE ON media BEGIN
      UPDATE nodes SET content_date=${contentDateSql('nodes')} WHERE id=OLD.id;
    END;`);
    db.exec('RELEASE browse_date_schema');
  } catch (error) {
    db.exec('ROLLBACK TO browse_date_schema; RELEASE browse_date_schema');
    throw error;
  }
  return {
    ready: () => ready,
    migrate() {
      if (ready) return;
      db.exec('BEGIN');
      try {
        db.exec(`UPDATE nodes SET content_date=${contentDateSql('nodes')};
          CREATE INDEX IF NOT EXISTS nodes_parent_content_date ON nodes(parent,missing,kind,content_date,sortkey,id);
          CREATE INDEX IF NOT EXISTS nodes_global_content_date ON nodes(missing,kind,content_date,sortkey,id);`);
        db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
          'browseContentDateVersion',
          JSON.stringify(CONTENT_DATE_VERSION)
        );
        db.exec('COMMIT');
        ready = true;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
  };
}

module.exports = {
  CONTENT_DATE_VERSION,
  createBrowseDate,
  normalizeBrowseSortPreferences
};
