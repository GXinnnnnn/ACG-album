'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBangumiCache } = require('../src/bangumi-cache.cjs');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SEARCH = '/v0/search/subjects?limit=20&offset=0';
const BODY = { keyword: '作品: A+B!', sort: 'match', filter: { type: [2, 4] } };
const SCOPE = 'c9b5827a866ff835';
const subject = (id = 42, extra = {}) => ({ id, type: 2, ...extra });
const search = (data = [subject()]) => ({ data, total: data.length, limit: 20, offset: 0 });

function fixture(t, options = {}) {
  let time = 1700000000000;
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const cache = createBangumiCache(db, { now: () => time, ...options });
  return { db, cache, advance: (delta) => (time += delta) };
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test('persists complete raw API responses across closing and reopening a file database', (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'acg-bangumi-cache-'));
  const filename = path.join(tmp, 'isolated.sqlite');
  let db;
  t.after(() => {
    db?.close();
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('acg-bangumi-cache-'));
    rmSync(tmp, { recursive: true, force: true });
  });
  const raw = {
    ...search([subject(42, { name: '作品', images: { small: 'https://example.test/a' } })]),
    total: 100,
    extra: { order: ['first', 'second'] }
  };
  db = new DatabaseSync(filename);
  let cache = createBangumiCache(db);
  assert.equal(cache.set(SCOPE, SEARCH, BODY, raw), true);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42', undefined, subject()), true);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42/persons', undefined, []), true);
  db.close();
  db = new DatabaseSync(filename);
  cache = createBangumiCache(db);
  assert.deepEqual(cache.get(SCOPE, SEARCH, BODY), raw);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42'), subject());
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42/persons'), []);
  const restored = cache.get(SCOPE, SEARCH, BODY);
  restored.data[0].name = 'mutated';
  assert.deepEqual(cache.get(SCOPE, SEARCH, BODY), raw);
});

test('isolates opaque auth scopes and exposes only cache totals', (t) => {
  const { cache, db } = fixture(t);
  db.exec(
    "CREATE TABLE library_items (private_data TEXT); INSERT INTO library_items VALUES ('keep')"
  );
  const a = search([subject(1)]);
  const b = search([subject(2)]);
  cache.set(SCOPE, SEARCH, BODY, a);
  assert.equal(cache.get('5cbffba3779f234a', SEARCH, BODY), undefined);
  cache.set('5cbffba3779f234a', SEARCH, BODY, b);
  assert.deepEqual(cache.get(SCOPE, SEARCH, BODY), a);
  assert.deepEqual(cache.get('5cbffba3779f234a', SEARCH, BODY), b);
  assert.deepEqual(cache.stats(), { entries: 2, bytes: bytes(a) + bytes(b) });
  cache.clear();
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  assert.equal(db.prepare('SELECT private_data FROM library_items').get().private_data, 'keep');
});

test('canonicalizes object keys and sorted deduplicated filter.type without mutating callers', (t) => {
  const { cache } = fixture(t);
  const body = Object.freeze({
    keyword: BODY.keyword,
    sort: 'match',
    filter: Object.freeze({ type: Object.freeze([4, 2, 4]) })
  });
  cache.set(SCOPE, SEARCH, body, search());
  assert.deepEqual(
    cache.get(SCOPE, SEARCH, { filter: { type: [2, 4] }, sort: 'match', keyword: BODY.keyword }),
    search()
  );
  assert.deepEqual(body.filter.type, [4, 2, 4]);
  assert.equal(cache.stats().entries, 1);
});

test('keeps exact endpoint, pagination, keyword punctuation, sort, body and other arrays distinct', (t) => {
  const { cache, db } = fixture(t);
  cache.set(SCOPE, SEARCH, BODY, search());
  for (const endpoint of [
    '/v0/search/subjects?limit=20&offset=20',
    '/v0/search/subjects?limit=10&offset=0',
    '/v0/search/subjects?offset=0&limit=20'
  ])
    assert.equal(cache.get(SCOPE, endpoint, BODY), undefined, endpoint);
  for (const body of [
    { ...BODY, keyword: '作品 A+B!' },
    { ...BODY, keyword: '作品: A B!' },
    { ...BODY, keyword: '作品: A+B' },
    { ...BODY, keyword: '作品: A+B! ' },
    { ...BODY, keyword: '作品: a+b!' },
    { ...BODY, sort: 'heat' },
    { ...BODY, filter: { type: [2] } },
    { ...BODY, filter: { type: [2, 4], nsfw: false } }
  ])
    assert.equal(cache.get(SCOPE, SEARCH, body), undefined, JSON.stringify(body));
  cache.set(SCOPE, SEARCH, { ...BODY, other: [2, 4] }, search());
  assert.equal(cache.get(SCOPE, SEARCH, { ...BODY, other: [4, 2] }), undefined);
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  assert.equal(cache.get(SCOPE, '/v0/subjects/42', null), undefined);
  assert.match(db.prepare('SELECT key FROM bangumi_cache LIMIT 1').get().key, /^[a-f0-9]{64}$/);
});

test('allows only official search, positive subject detail and subject persons endpoints', (t) => {
  const { cache } = fixture(t);
  for (const endpoint of [
    '/search/subject/test',
    '/v0/search/subjects',
    '/v0/search/subjects?',
    '/v0/search/subjects?offset=0#fragment',
    'https://api.bgm.tv/v0/subjects/42',
    '/v0/subjects/0',
    '/v0/subjects/-1',
    '/v0/subjects/01',
    '/v0/subjects/9007199254740992',
    '/v0/subjects/42/characters',
    '/v0/subjects/42?x=1',
    '/v0/subjects/42/persons/extra'
  ]) {
    assert.equal(cache.set(SCOPE, endpoint, BODY, search()), false, endpoint);
    assert.equal(cache.get(SCOPE, endpoint, BODY), undefined, endpoint);
  }
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test('empty searches expire at six hours and nonempty search/detail/persons at seven days', (t) => {
  const { cache, advance } = fixture(t);
  cache.set(SCOPE, SEARCH, BODY, search([]));
  cache.set(SCOPE, SEARCH, { ...BODY, keyword: 'nonempty' }, search());
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  cache.set(SCOPE, '/v0/subjects/42/persons', undefined, []);
  advance(6 * HOUR - 1);
  assert.deepEqual(cache.get(SCOPE, SEARCH, BODY), search([]));
  advance(1);
  assert.equal(cache.get(SCOPE, SEARCH, BODY), undefined);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42/persons'), []);
  advance(7 * DAY - 6 * HOUR - 1);
  assert.deepEqual(cache.get(SCOPE, SEARCH, { ...BODY, keyword: 'nonempty' }), search());
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42'), subject());
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42/persons'), []);
  advance(1);
  assert.equal(cache.get(SCOPE, SEARCH, { ...BODY, keyword: 'nonempty' }), undefined);
  assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
  assert.equal(cache.get(SCOPE, '/v0/subjects/42/persons'), undefined);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test('rejects errors, undefined, malformed search schemas and non-JSON values', (t) => {
  const { cache } = fixture(t);
  const circular = search();
  circular.circular = circular;
  for (const value of [
    undefined,
    null,
    false,
    [],
    new Error('failed'),
    { error: 'failed' },
    { ...search(), error: 'failed' },
    { ...search(), errors: [] },
    { ...search(), status: 429 },
    { ...search(), statusCode: 500 },
    {},
    { data: {} },
    { data: null },
    { data: [null] },
    { data: [{ id: NaN, type: 2 }] },
    { data: [{ id: Infinity, type: 2 }] },
    { data: [{ id: -1, type: 2 }] },
    { data: [{ id: '42', type: 2 }] },
    { data: [{ id: 42, type: Infinity }] },
    { data: [{ id: 42 }] },
    { ...search(), total: NaN },
    { ...search(), offset: -1 },
    { ...search(), limit: '20' },
    circular,
    { ...search(), extra: 1n },
    { ...search(), toJSON: () => ({ error: 'serialized failure' }) }
  ])
    assert.equal(cache.set(SCOPE, SEARCH, BODY, value), false);
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
});

test('checks detail subject identity and minimal persons schema, including empty persons', (t) => {
  const { cache } = fixture(t);
  for (const value of [undefined, {}, subject(43), { id: 42 }, subject(42, { error: 'bad' })])
    assert.equal(cache.set(SCOPE, '/v0/subjects/42', undefined, value), false);
  for (const value of [undefined, {}, { data: [] }, [null], [{ id: 1 }], [{ id: 1, type: NaN }]])
    assert.equal(cache.set(SCOPE, '/v0/subjects/42/persons', undefined, value), false);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42', undefined, subject()), true);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42/persons', undefined, []), true);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42/persons'), []);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42/persons', undefined, [{ id: 9, type: 1 }]), true);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42/persons'), [{ id: 9, type: 1 }]);
});

test('evicts bad JSON, malformed stored schemas, wrong IDs and mismatched byte metadata', (t) => {
  const { cache, db } = fixture(t);
  for (const bad of ['{', JSON.stringify({ data: 'bad' }), JSON.stringify(subject(43))]) {
    cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
    db.prepare('UPDATE bangumi_cache SET value = ?, bytes = ?').run(bad, Buffer.byteLength(bad));
    assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
    assert.equal(cache.stats().entries, 0);
  }
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  db.exec('UPDATE bangumi_cache SET bytes = 1');
  assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
  assert.equal(cache.stats().entries, 0);
});

test('does not load oversized JSON inserted directly into the database', (t) => {
  const { cache, db } = fixture(t);
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  db.exec('UPDATE bangumi_cache SET value = zeroblob(2097153), bytes = 2097153');
  assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
  assert.equal(cache.stats().entries, 0);
});

test('clock rollback invalidates future inserted entries on get, set and reopen', (t) => {
  const { cache, db, advance } = fixture(t);
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  advance(-1);
  assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  advance(-1);
  cache.set(SCOPE, '/v0/subjects/43', undefined, subject(43));
  assert.equal(cache.get(SCOPE, '/v0/subjects/42'), undefined);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/43'), subject(43));
  createBangumiCache(db, { now: () => 1600000000000 });
  assert.equal(cache.stats().entries, 0);
});

test('enforces count caps immediately and get refreshes LRU even within one clock tick', (t) => {
  const { cache, db } = fixture(t, { maxEntries: 2 });
  cache.set(SCOPE, '/v0/subjects/1', undefined, subject(1));
  cache.set(SCOPE, '/v0/subjects/2', undefined, subject(2));
  cache.get(SCOPE, '/v0/subjects/1');
  cache.set(SCOPE, '/v0/subjects/3', undefined, subject(3));
  assert.equal(db.prepare('SELECT count(*) AS n FROM bangumi_cache').get().n, 2);
  assert.equal(cache.get(SCOPE, '/v0/subjects/2'), undefined);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/1'), subject(1));
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/3'), subject(3));
  cache.set(SCOPE, '/v0/subjects/1', undefined, subject(1, { name: 'updated' }));
  assert.equal(cache.stats().entries, 2);
  cache.set('other-hash', '/v0/subjects/4', undefined, subject(4));
  assert.equal(cache.get(SCOPE, '/v0/subjects/3'), undefined);
  assert.equal(cache.stats().entries, 2);
});

test('default row cap stays at 8192 after every write', (t) => {
  const { cache, db } = fixture(t);
  for (let id = 1; id <= 8193; id++) cache.set(SCOPE, `/v0/subjects/${id}`, undefined, subject(id));
  assert.equal(db.prepare('SELECT count(*) AS n FROM bangumi_cache').get().n, 8192);
  assert.equal(cache.get(SCOPE, '/v0/subjects/1'), undefined);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/8193'), subject(8193));
});

test('UTF8 byte cap evicts LRU and replacement accounting stays exact', (t) => {
  const a = subject(1, { name: '作品猫' });
  const b = subject(2, { name: '作品猫' });
  const c = subject(3, { name: '作品猫' });
  const cap = bytes(a) + bytes(b);
  const { cache, db } = fixture(t, { maxBytes: cap });
  cache.set(SCOPE, '/v0/subjects/1', undefined, a);
  cache.set(SCOPE, '/v0/subjects/2', undefined, b);
  assert.deepEqual(cache.stats(), { entries: 2, bytes: cap });
  cache.get(SCOPE, '/v0/subjects/1');
  cache.set(SCOPE, '/v0/subjects/3', undefined, c);
  assert.equal(db.prepare('SELECT sum(bytes) AS n FROM bangumi_cache').get().n, cap);
  assert.equal(cache.get(SCOPE, '/v0/subjects/2'), undefined);
  cache.set(SCOPE, '/v0/subjects/1', undefined, subject(1));
  assert.deepEqual(cache.stats(), { entries: 2, bytes: bytes(subject(1)) + bytes(c) });
});

test('per-item 2MiB limit includes exact UTF8 JSON bytes and does not evict valid rows', (t) => {
  const { cache } = fixture(t);
  const base = subject(42, { name: '' });
  const exact = subject(42, { name: 'x'.repeat(2 * 1024 * 1024 - bytes(base)) });
  assert.equal(bytes(exact), 2 * 1024 * 1024);
  assert.equal(cache.set(SCOPE, '/v0/subjects/42', undefined, exact), true);
  assert.equal(
    cache.set(SCOPE, '/v0/subjects/43', undefined, subject(43, { name: exact.name + '猫' })),
    false
  );
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 2 * 1024 * 1024 });
});

test('expiration is pruned before row and byte caps can evict live entries', (t) => {
  const { cache, advance } = fixture(t, { maxEntries: 2 });
  cache.set(SCOPE, SEARCH, BODY, search([]));
  cache.set(SCOPE, '/v0/subjects/42', undefined, subject());
  advance(6 * HOUR);
  cache.set(SCOPE, '/v0/subjects/43', undefined, subject(43));
  assert.equal(cache.get(SCOPE, SEARCH, BODY), undefined);
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/42'), subject());
  assert.deepEqual(cache.get(SCOPE, '/v0/subjects/43'), subject(43));
});

test('reopening with smaller limits restores bounds and supports a surrounding transaction', (t) => {
  const { cache, db } = fixture(t);
  for (let id = 1; id <= 3; id++) cache.set(SCOPE, `/v0/subjects/${id}`, undefined, subject(id));
  const small = createBangumiCache(db, { now: () => 1700000000000, maxEntries: 1 });
  assert.deepEqual(small.stats(), { entries: 1, bytes: bytes(subject(3)) });
  db.exec('BEGIN');
  small.set(SCOPE, '/v0/subjects/4', undefined, subject(4));
  db.exec('ROLLBACK');
  assert.deepEqual(small.get(SCOPE, '/v0/subjects/3'), subject(3));
  assert.equal(small.get(SCOPE, '/v0/subjects/4'), undefined);
});

test('zero capacities disable writes and invalid capacity options reject early', (t) => {
  const { db } = fixture(t);
  for (const options of [{ maxEntries: 0 }, { maxBytes: 0 }, { maxBytes: 1 }]) {
    const cache = createBangumiCache(db, options);
    assert.equal(cache.set(SCOPE, '/v0/subjects/42', undefined, subject()), false);
    assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 });
  }
  for (const options of [{ maxEntries: -1 }, { maxEntries: 1.2 }, { maxBytes: Infinity }])
    assert.throws(() => createBangumiCache(db, options), TypeError);
});
