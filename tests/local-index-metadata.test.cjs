'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor, normalize } = require('../src/model.cjs');

const NOW = 1800000000000;
const TOKEN = 'fixture-access-a';
const scopeFor = (token) =>
  crypto
    .createHash('sha256')
    .update('ACGAlbum Bangumi cache v1\0' + token)
    .digest('hex');
const HOLD = Symbol('hold mocked response');
const entries = [
  { id: 1, type: 4, name: 'Reliable Chronicle', summary: 'archive summary', date: '2000-01-01' },
  { id: 2, type: 4, name: 'Other Chronicle', summary: 'other archive summary', date: '2001-01-01' }
];

// Each test owns a generated library and an independent miniature archive. All
// HTTP is intercepted before loading the worker; no actual fetch is reachable.
async function fixture(t, { respond = () => ({ status: 403 }), indexed = true, albums } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-local-metadata-'));
  const dataDir = path.join(root, 'data');
  const source = path.join(root, 'source');
  const filename = path.join(root, 'subjects.sqlite');
  const d = new DatabaseSync(filename);
  d.exec(`
    CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT);
    CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
    CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT);
    CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
    CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT);
    CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
    CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    INSERT INTO metadata VALUES('source','{"dataVersion":"fixture"}');
    CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
    CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');
  `);
  for (const s of entries) {
    d.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      s.id,
      s.type,
      s.name,
      '',
      0,
      s.date,
      s.summary,
      '[]',
      '{"collect":100}',
      '[]',
      '{}'
    );
    d.prepare('INSERT INTO name_keys VALUES(?,?,?,?,?)').run(
      s.id,
      s.type,
      normalize(s.name),
      s.name,
      'name'
    );
  }
  d.exec('INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys');
  d.close();
  const png = await sharp({ create: { width: 32, height: 48, channels: 3, background: '#aaccee' } })
    .png()
    .toBuffer();
  const folders = (albums || [entries[0].name]).map((name) => path.join(source, name));
  for (const folder of folders) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'local.png'), png);
  }
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const {workerData}=require('node:worker_threads');
    const port=workerData.port, pending=new Map(); let seq=0, clock=workerData.now;
    Date.now=()=>clock;
    require('node:timers/promises').setTimeout=async(delay,value,options={})=>{
      options.signal?.throwIfAborted(); clock+=Math.max(0,Number(delay)||0);
      await new Promise(resolve=>setImmediate(resolve)); options.signal?.throwIfAborted(); return value;
    };
    port.on('message', ({seq,response})=>{
      const p=pending.get(seq); if(!p)return; pending.delete(seq); p.cleanup();
      if(response.failure)return p.reject(new Error(response.failure));
      const status=response.status||200;
      p.resolve({status,ok:status>=200&&status<300,headers:new Headers(response.headers||{}),
        json:async()=>response.json,arrayBuffer:async()=>Uint8Array.from(response.bytes||[]).buffer});
    });
    global.fetch=(url,options={})=>new Promise((resolve,reject)=>{
      const signal=options.signal, id=++seq;
      const cleanup=()=>signal?.removeEventListener('abort',abort);
      const abort=()=>{pending.delete(id);cleanup();reject(signal.reason);};
      if(signal?.aborted)return reject(signal.reason);
      signal?.addEventListener('abort',abort,{once:true});
      pending.set(id,{resolve,reject,cleanup});
      port.postMessage({seq:id,url:String(url),now:clock,authorized:!!options.headers?.Authorization});
    });
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        localIndexPath: indexed ? filename : path.join(root, 'missing.sqlite'),
        watch: false,
        token: TOKEN,
        port: port2,
        now: NOW,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  let sequence = 0,
    closed = false;
  const pending = new Map(),
    requests = [],
    events = [],
    observers = new Set();
  const notify = () => {
    for (const fn of observers) fn();
  };
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event) {
        events.push(m);
        notify();
      }
      if (m.event === 'ready') resolve();
      const p = pending.get(m.request);
      if (p) {
        pending.delete(m.request);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  const answer = (request, response) => {
    if (!closed) port1.postMessage({ seq: request.seq, response });
  };
  port1.on('message', async (request) => {
    requests.push(request);
    notify();
    try {
      const response = await respond(request, { png });
      notify();
      if (response !== HOLD) answer(request, response);
    } catch (error) {
      answer(request, { failure: error.message });
    }
  });
  await ready;
  const c = {
    root,
    source,
    dataDir,
    folders,
    png,
    requests,
    events,
    answer,
    id: idFor(folders[0]),
    imageId: idFor(path.join(folders[0], 'local.png')),
    call(method, args = {}) {
      const request = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('RPC timeout ' + method));
        }, 12000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observers.delete(check);
          reject(
            new Error(
              'fixture event timeout: ' + JSON.stringify({ requests, events: events.slice(-8) })
            )
          );
        }, 12000);
        const check = () => {
          if (predicate()) {
            clearTimeout(timer);
            observers.delete(check);
            resolve();
          }
        };
        observers.add(check);
      });
    },
    idle(after = 0) {
      return c.until(() =>
        events
          .slice(after)
          .some((m) => m.event === 'online' && !m.data.active && (!m.data.pending || m.data.paused))
      );
    },
    sql(fn) {
      const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
      db.exec('PRAGMA busy_timeout=4000');
      try {
        return fn(db);
      } finally {
        db.close();
      }
    },
    seedMetadata(data) {
      c.sql((db) =>
        db
          .prepare('INSERT OR REPLACE INTO metadata VALUES(?,?,?)')
          .run(data.id, JSON.stringify(data), NOW - 1000)
      );
    },
    pause() {
      c.sql((db) =>
        db
          .prepare("UPDATE match_resume SET reason='access',scope=?,failures=1 WHERE singleton=1")
          .run(scopeFor(TOKEN))
      );
    },
    async sync() {
      const after = events.length;
      await c.call('sync', { id: c.id });
      await c.idle(after);
    }
  };
  t.after(async () => {
    try {
      await c.call('shutdown');
    } finally {
      closed = true;
      port1.close();
      await worker.terminate();
      assert.ok(root.startsWith(path.join(os.tmpdir(), 'acg-local-metadata-')));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  await c.call('scan', { path: source, offline: true, onlineMatch: true, subjectTypes: [4] });
  await c.call('syncStatus');
  return c;
}

function online(id = 1) {
  return {
    ...entries[id - 1],
    summary: 'online summary',
    rating: { score: 9.1, total: 123 },
    images: { large: `https://lain.bgm.tv/pic/cover/l/${id}.png` },
    infobox: [{ key: '开发', value: 'Online Studio' }]
  };
}
const detailsOnly = (request, { png }) => {
  const pathname = new URL(request.url).pathname;
  if (/\/persons$/.test(pathname)) return { json: [{ name: 'Online Staff', relation: '导演' }] };
  if (/^\/v0\/subjects\/[12]$/.test(pathname))
    return { json: online(Number(pathname.split('/').at(-1))) };
  if (new URL(request.url).hostname === 'lain.bgm.tv') return { bytes: [...png] };
  throw new Error('Unexpected search: ' + request.url);
};

test('local save preserves same ID/type online fields, Markdown and actual cache scope across token changes', async (t) => {
  const f = await fixture(t);
  const prior = {
    ...online(),
    staff: [{ name: 'Online Staff', relation: 'director' }],
    details_source: 'online',
    cached_at: NOW - 50000,
    access_scope: scopeFor('older-token'),
    resources_complete: true,
    cover_url: online().images.large
  };
  f.seedMetadata(prior);
  const markdown = path.join(f.dataDir, 'metadata', '1.md');
  fs.writeFileSync(markdown, '# Original online Markdown\n');
  f.pause();
  let node = await f.call('bind', { id: f.id, url: '1' });
  for (const key of [
    'summary',
    'rating',
    'images',
    'staff',
    'infobox',
    'cached_at',
    'access_scope',
    'resources_complete'
  ])
    assert.deepEqual(node.metadata[key], prior[key], key);
  assert.equal(node.metadata.details_source, 'online');
  assert.equal(fs.readFileSync(markdown, 'utf8'), '# Original online Markdown\n');
  assert.equal(f.requests.length, 0);
  await f.call('token', { value: 'fixture-access-b' });
  node = await f.call('refreshMetadata', { id: f.id });
  assert.equal(node.metadata.cached_at, prior.cached_at);
  assert.equal(node.metadata.access_scope, prior.access_scope);
  assert.deepEqual(node.metadata.rating, prior.rating);
  assert.equal(fs.readFileSync(markdown, 'utf8'), '# Original online Markdown\n');
});

test('local save merges missing fields only for matching identity and never inherits another type', async (t) => {
  const f = await fixture(t);
  f.pause();
  f.seedMetadata({
    ...online(),
    type: 2,
    staff: [{ name: 'Wrong Type Staff' }],
    details_source: 'online',
    cached_at: NOW - 1000,
    access_scope: scopeFor(TOKEN),
    resources_complete: true
  });
  const node = await f.call('bind', { id: f.id, url: '1' });
  assert.equal(node.metadata.type, 4);
  assert.equal(node.metadata.summary, 'archive summary');
  assert.equal(node.metadata.rating, undefined);
  assert.deepEqual(node.metadata.staff, []);
  assert.equal(node.metadata.details_source, 'local-index');
  assert.equal(node.metadata.cached_at, 0);
  assert.equal(node.metadata.access_scope, '');
  assert.equal(node.metadata.resources_complete, false);
});

test('auto local identity is durable before detail, then enriches by ID without HTTP search or premature completion', async (t) => {
  let held;
  const f = await fixture(t, {
    respond: (request, context) => {
      if (new URL(request.url).pathname === '/v0/subjects/1' && !held) {
        held = request;
        return HOLD;
      }
      return detailsOnly(request, context);
    }
  });
  await f.call('sync', { id: f.id });
  await f.until(() => !!held);
  const local = await f.call('get', { id: f.id });
  assert.equal(local.subject_id, 1);
  assert.equal(local.match_confidence, 1);
  assert.equal(local.metadata.details_source, 'local-index');
  assert.equal(local.metadata.resources_complete, false);
  assert.equal(local.metadata.cached_at, 0);
  assert.equal(local.metadata.access_scope, '');
  const status = await f.call('syncStatus');
  assert.equal(status.pending, 1);
  assert.equal(status.completed, 0);
  const stamp = f.sql((db) =>
    JSON.parse(db.prepare('SELECT stamp FROM match_pending WHERE id=?').get(f.id).stamp)
  );
  assert.equal(stamp[1], 1);
  assert.equal(stamp[2], 0);
  const after = f.events.length;
  f.answer(held, { json: online() });
  await f.idle(after);
  const enriched = await f.call('get', { id: f.id });
  assert.equal(enriched.metadata.details_source, 'online');
  assert.equal(enriched.metadata.rating.score, 9.1);
  assert.equal(enriched.metadata.staff[0].name, 'Online Staff');
  assert.equal(enriched.metadata.resources_complete, true);
  assert.equal(enriched.cover, 'subject:1');
  assert.equal(enriched.cover_source, 'bangumi');
  assert.ok(fs.existsSync(path.join(f.dataDir, 'covers', '1.webp')));
  assert.equal((await f.call('syncStatus')).completed, 1);
  assert.equal((await f.call('syncStatus')).pending, 0);
  assert.deepEqual(
    f.requests.filter((r) => r.url.includes('api.bgm.tv')).map((r) => new URL(r.url).pathname),
    ['/v0/subjects/1', '/v0/subjects/1/persons']
  );
  const apiRequests = f.requests.filter((r) => r.url.includes('api.bgm.tv'));
  assert.ok(apiRequests[1].now - apiRequests[0].now >= 1050);
  assert.equal(f.requests.find((r) => r.url.includes('lain.bgm.tv')).authorized, false);
});

test('access pause keeps newly saved local identity pending, sweeps remaining local matches and resumes details after token update', async (t) => {
  let allowed = false;
  const f = await fixture(t, {
    albums: entries.map((s) => s.name),
    respond: (r, context) => (allowed ? detailsOnly(r, context) : { status: 403 })
  });
  const ids = f.folders.map(idFor);
  const policy = JSON.stringify({
    explicit: true,
    kind: 'work',
    characterCover: 'local-first',
    networkEnabled: true,
    enabled: true,
    types: [4],
    revision: 1
  });
  f.sql((db) => {
    for (const id of ids)
      db.prepare('INSERT INTO match_pending VALUES(?,?,?)').run(
        id,
        idFor(f.source),
        JSON.stringify([policy, null, 0])
      );
  });
  await f.sync();
  for (const [i, id] of ids.entries())
    assert.equal((await f.call('get', { id })).subject_id, i + 1);
  let status = await f.call('syncStatus');
  assert.equal(status.paused, 'access');
  assert.equal(status.pending, 2);
  assert.equal(status.completed, 0);
  assert.equal(f.requests.length, 1);
  const after = f.events.length;
  await f.call('sync', { id: f.id });
  await f.idle(after);
  assert.equal(f.requests.length, 1, 'same access pause must not issue a repeated request');
  allowed = true;
  const resumed = f.events.length;
  await f.call('token', { value: 'fixture-access-b' });
  await f.until(() =>
    f.events
      .slice(resumed)
      .some((m) => m.event === 'online' && !m.data.active && !m.data.paused && m.data.pending === 0)
  );
  status = await f.call('syncStatus');
  assert.equal(status.paused, '');
  assert.equal(status.pending, 0);
  assert.equal(status.completed, 2);
  assert.equal(
    f.requests.some((r) => r.url.includes('/search/')),
    false
  );
});

test('offline detail failure preserves local ID and durable network backoff without inflating completed', async (t) => {
  const f = await fixture(t, { respond: () => ({ failure: 'isolated offline fixture' }) });
  await f.sync();
  const node = await f.call('get', { id: f.id });
  const status = await f.call('syncStatus');
  assert.equal(
    node.subject_id,
    1,
    JSON.stringify({ status, events: f.events.slice(-8), requests: f.requests })
  );
  assert.equal(node.metadata.details_source, 'local-index');
  assert.equal(status.paused, 'network');
  assert.equal(status.pending, 1);
  assert.equal(status.completed, 0);
  assert.ok(status.retryAt > NOW);
  assert.equal(f.requests.length, 2, 'only the established single network retry is used');
  const after = f.events.length;
  await f.call('sync', { id: f.id });
  await f.idle(after);
  assert.equal(f.requests.length, 2);
});

test('switching subjects with no new cover restores local fallback and retains explicitly manual covers', async (t) => {
  const f = await fixture(t);
  f.pause();
  await f.call('bind', { id: f.id, url: '1' });
  f.sql((db) =>
    db
      .prepare(
        "UPDATE nodes SET cover='subject:1',cover_source='bangumi',manual_cover=0 WHERE id=?"
      )
      .run(f.id)
  );
  let node = await f.call('bind', { id: f.id, url: '2' });
  assert.equal(node.subject_id, 2);
  assert.equal(node.cover, f.imageId);
  assert.equal(node.cover_source, 'fallback');
  f.sql((db) =>
    db
      .prepare("UPDATE nodes SET cover=?,cover_source='manual',manual_cover=1 WHERE id=?")
      .run(f.imageId, f.id)
  );
  node = await f.call('bind', { id: f.id, url: '1' });
  assert.equal(node.subject_id, 1);
  assert.equal(node.cover, f.imageId);
  assert.equal(node.cover_source, 'manual');
  assert.equal(node.manual_cover, 1);
});

test('manual bind saves offline first, enriches best effort online and stays immune to auto rebinding', async (t) => {
  const f = await fixture(t, { respond: detailsOnly });
  const node = await f.call('bind', { id: f.id, url: '2' });
  assert.equal(node.subject_id, 2);
  assert.equal(node.manual_subject, 1);
  assert.equal(node.metadata.details_source, 'online');
  assert.equal(node.metadata.rating.score, 9.1);
  assert.equal(node.cover, 'subject:2');
  const requests = f.requests.length;
  await f.sync();
  assert.equal((await f.call('get', { id: f.id })).subject_id, 2);
  assert.equal(f.requests.length, requests);
});

for (const change of ['cancel', 'policy']) {
  test(`late detail after ${change} cannot overwrite durable local data or acknowledge stale progress`, async (t) => {
    let held;
    const f = await fixture(t, {
      respond: (request) => {
        held = request;
        return HOLD;
      }
    });
    await f.call('sync', { id: f.id });
    await f.until(() => !!held);
    const after = f.events.length;
    if (change === 'cancel') await f.call('cancel');
    else await f.call('patch', { id: f.id, changes: { search_type: 2 } });
    f.answer(held, { json: online() });
    await f.idle(after);
    const node = await f.call('get', { id: f.id });
    assert.equal(node.subject_id, 1);
    assert.equal(node.metadata.details_source, 'local-index');
    assert.equal(node.metadata.rating, undefined);
    assert.equal(node.metadata.cached_at, 0);
    assert.equal((await f.call('syncStatus')).completed, 0);
    assert.equal(f.requests.length, 1);
  });
}

test('local-only cache markers force a detail request even with a formerly forged fresh scope', async (t) => {
  const f = await fixture(t, { respond: detailsOnly });
  f.seedMetadata({
    ...entries[0],
    source: 'local-index',
    cached_at: NOW - 1000,
    access_scope: scopeFor(TOKEN),
    resources_complete: false,
    staff: []
  });
  f.sql((db) => db.prepare('UPDATE nodes SET subject_id=1 WHERE id=?').run(f.id));
  await f.sync();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.metadata.details_source, 'online');
  assert.equal(node.metadata.rating.score, 9.1);
  assert.equal(new URL(f.requests[0].url).pathname, '/v0/subjects/1');
  assert.equal(
    f.requests.some((r) => r.url.includes('/search/')),
    false
  );
});

test('a mismatched online detail cannot replace local identity or trigger a search for another ID', async (t) => {
  const f = await fixture(t, { respond: () => ({ json: { ...online(), type: 2 } }) });
  await f.sync();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 1);
  assert.equal(node.metadata.type, 4);
  assert.equal(node.metadata.details_source, 'local-index');
  assert.equal(node.metadata.rating, undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(new URL(f.requests[0].url).pathname, '/v0/subjects/1');
});

test('a local index miss still uses the existing online search fallback', async (t) => {
  const subject = {
    id: 3,
    type: 4,
    name: 'Unindexed Chronicle',
    summary: 'online fallback summary'
  };
  const f = await fixture(t, {
    albums: [subject.name],
    respond: (request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/v0/search/subjects') return { json: { data: [subject], total: 1 } };
      if (pathname === '/v0/subjects/3') return { json: subject };
      if (pathname === '/v0/subjects/3/persons') return { json: [] };
      throw new Error('Unexpected fixture request: ' + request.url);
    }
  });
  await f.sync();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 3);
  assert.equal(node.metadata.summary, subject.summary);
  assert.equal(node.metadata.details_source, 'online');
  assert.equal((await f.call('syncStatus')).pending, 0);
  assert.equal(new URL(f.requests[0].url).pathname, '/v0/search/subjects');
});

test('no-index import retains original online search/detail/staff flow', async (t) => {
  const f = await fixture(t, {
    indexed: false,
    respond: (request, context) => {
      if (new URL(request.url).pathname === '/v0/search/subjects')
        return { json: { data: [online()], total: 1 } };
      return detailsOnly(request, context);
    }
  });
  await f.sync();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 1);
  assert.equal(node.metadata.details_source, 'online');
  assert.equal(node.metadata.rating.score, 9.1);
  assert.equal((await f.call('syncStatus')).pending, 0);
  assert.ok(f.requests.some((r) => r.url.includes('/v0/search/subjects')));
});
