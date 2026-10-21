'use strict';
const { createHash } = require('node:crypto');

const SCHEMA_VERSION = 1;
const ITEM_BYTES = 2 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const EMPTY_SEARCH_TTL = 6 * 60 * 60 * 1000;

function endpointKind(endpoint) {
  if (typeof endpoint !== 'string') return undefined;
  if (/^\/v0\/search\/subjects\?[^#\s]+$/.test(endpoint)) return { kind: 'search' };
  const match = /^\/v0\/subjects\/([1-9]\d*)(\/persons)?$/.exec(endpoint);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return undefined;
  return { kind: match[2] ? 'persons' : 'detail', id: Number(match[1]) };
}

// Preserve all JSON values and array order except the API's set-like filter.type.
function canonical(value, path = []) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    const rows = Array.from(value, (entry) => canonical(entry, [...path, '[]']));
    if (path.length === 2 && path[0] === 'filter' && path[1] === 'type') {
      if (!rows.every((entry) => typeof entry === 'number' && Number.isFinite(entry)))
        throw new TypeError('Invalid subject types');
      return [...new Set(rows)].sort((a, b) => a - b);
    }
    return rows;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key], [...path, key])])
    );
  }
  throw new TypeError('Expected a JSON request body');
}

function requestKey(scope, endpoint, body) {
  if (typeof scope !== 'string' || !scope || !endpointKind(endpoint)) return undefined;
  try {
    return createHash('sha256')
      .update(
        JSON.stringify([SCHEMA_VERSION, endpoint, body === undefined ? [] : [canonical(body)]])
      )
      .digest('hex');
  } catch {
    return undefined;
  }
}

function hasError(value) {
  return (
    value instanceof Error ||
    Object.hasOwn(value, 'error') ||
    Object.hasOwn(value, 'errors') ||
    (Number.isFinite(value.status) && value.status >= 400) ||
    (Number.isFinite(value.statusCode) && value.statusCode >= 400)
  );
}
function validRow(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !hasError(value) &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    Number.isFinite(value.type)
  );
}
function validPayload(route, value) {
  if (route.kind === 'persons') return Array.isArray(value) && value.every(validRow);
  if (!value || typeof value !== 'object' || Array.isArray(value) || hasError(value)) return false;
  if (route.kind === 'detail') return validRow(value) && value.id === route.id;
  return (
    Array.isArray(value.data) &&
    value.data.every(validRow) &&
    ['total', 'limit', 'offset'].every(
      (key) => !Object.hasOwn(value, key) || (Number.isSafeInteger(value[key]) && value[key] >= 0)
    )
  );
}

function createBangumiCache(
  db,
  { now = Date.now, maxEntries = 8192, maxBytes = 64 * 1024 * 1024 } = {}
) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
    throw new TypeError('maxEntries must be a nonnegative safe integer');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new TypeError('maxBytes must be a nonnegative safe integer');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bangumi_cache (
      scope TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      inserted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );
    CREATE INDEX IF NOT EXISTS bangumi_cache_expiry ON bangumi_cache(expires_at);
    CREATE INDEX IF NOT EXISTS bangumi_cache_lru ON bangumi_cache(used_at);
  `);
  const expire = db.prepare(`DELETE FROM bangumi_cache
    WHERE expires_at <= ? OR inserted_at > ? OR expires_at <= inserted_at`);
  // Inspect byte length in SQLite before allowing even a single JSON value into JS.
  const lookup = db.prepare(`SELECT inserted_at, expires_at, bytes,
    CASE WHEN length(CAST(value AS BLOB)) BETWEEN 1 AND ${ITEM_BYTES}
      AND length(CAST(value AS BLOB)) = bytes THEN value END AS value
    FROM bangumi_cache WHERE scope = ? AND key = ?`);
  const remove = db.prepare('DELETE FROM bangumi_cache WHERE scope = ? AND key = ?');
  const touch = db.prepare(`UPDATE bangumi_cache
    SET used_at = max(?, (SELECT coalesce(max(used_at), 0) + 1 FROM bangumi_cache))
    WHERE scope = ? AND key = ?`);
  const insert = db.prepare(`INSERT INTO bangumi_cache
    (scope, key, value, bytes, inserted_at, expires_at, used_at)
    VALUES (?, ?, ?, ?, ?, ?, max(?, (SELECT coalesce(max(used_at), 0) + 1 FROM bangumi_cache)))
    ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes,
      inserted_at = excluded.inserted_at, expires_at = excluded.expires_at,
      used_at = excluded.used_at`);
  const trim = db.prepare(`DELETE FROM bangumi_cache WHERE rowid IN (
    SELECT rowid FROM (
      SELECT rowid, row_number() OVER recent AS position, sum(bytes) OVER recent AS running_bytes
      FROM bangumi_cache WINDOW recent AS (ORDER BY used_at DESC, rowid DESC)
    ) WHERE position > ? OR running_bytes > ?
  )`);
  const totals = db.prepare(
    'SELECT count(*) AS entries, coalesce(sum(bytes), 0) AS bytes FROM bangumi_cache'
  );

  function prune(time) {
    expire.run(time, time);
    const { entries, bytes } = totals.get();
    if (entries > maxEntries || bytes > maxBytes) trim.run(maxEntries, maxBytes);
  }
  // Opening a cache also restores bounds if a previous process used larger limits.
  prune(now());

  return {
    get(scope, endpoint, body) {
      const key = requestKey(scope, endpoint, body);
      if (!key) return undefined;
      const row = lookup.get(scope, key);
      if (!row) return undefined;
      const time = now();
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(row.inserted_at) ||
        !Number.isFinite(row.expires_at) ||
        row.inserted_at > time ||
        row.expires_at <= time ||
        row.expires_at <= row.inserted_at ||
        typeof row.value !== 'string'
      ) {
        remove.run(scope, key);
        return undefined;
      }
      let value;
      try {
        value = JSON.parse(row.value);
      } catch {
        remove.run(scope, key);
        return undefined;
      }
      if (!validPayload(endpointKind(endpoint), value)) {
        remove.run(scope, key);
        return undefined;
      }
      touch.run(time, scope, key);
      return value;
    },
    set(scope, endpoint, body, value) {
      const key = requestKey(scope, endpoint, body);
      const route = endpointKind(endpoint);
      if (!key || !validPayload(route, value)) return false;
      let json, stored, bytes;
      try {
        json = JSON.stringify(value);
        if (typeof json !== 'string') return false;
        bytes = Buffer.byteLength(json, 'utf8');
        if (bytes > ITEM_BYTES || bytes > maxBytes || !maxEntries) return false;
        stored = JSON.parse(json);
        if (!validPayload(route, stored)) return false;
      } catch {
        return false;
      }
      const time = now();
      if (!Number.isFinite(time)) return false;
      const ttl = route.kind === 'search' && stored.data.length === 0 ? EMPTY_SEARCH_TTL : 7 * DAY;
      db.exec('SAVEPOINT bangumi_cache_write');
      try {
        insert.run(scope, key, json, bytes, time, time + ttl, time);
        prune(time);
        db.exec('RELEASE bangumi_cache_write');
      } catch (error) {
        db.exec('ROLLBACK TO bangumi_cache_write; RELEASE bangumi_cache_write');
        throw error;
      }
      return true;
    },
    clear() {
      db.exec('DELETE FROM bangumi_cache');
    },
    stats() {
      prune(now());
      return { ...totals.get() };
    }
  };
}

module.exports = { createBangumiCache };
