'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor, normalize } = require('../src/model.cjs');

const LOCAL = { id: 700001, type: 4, name: 'Reliable Local Chronicle', date: '2000-01-01' };
const STATIC = { id: 231798, name: 'Riddle Joker' };

async function archive(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
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
      INSERT INTO metadata VALUES('source','{"dataVersion":"local-priority-fixture"}');
      CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
      CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');
    `);
    db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      LOCAL.id,
      LOCAL.type,
      LOCAL.name,
      '',
      0,
      LOCAL.date,
      'Local archive summary',
      '[]',
      '{"collect":100}',
      '[]',
      '{}'
    );
    db.prepare('INSERT INTO name_keys VALUES(?,?,?,?,?)').run(
      LOCAL.id,
      LOCAL.type,
      normalize(LOCAL.name),
      LOCAL.name,
      'name'
    );
    db.exec('INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys');
  } finally {
    db.close();
  }
}

// Only MessagePort replies can resolve mocked HTTP. Ignore AbortSignal on purpose:
// late-response tests must exercise production guards even for uncooperative I/O.
async function client(dataDir, localIndexPath) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const port = workerData.mockPort, pending = new Map(); let seq = 0;
    port.on('message', ({seq,response}) => {
      const item = pending.get(seq); if (!item) return;
      pending.delete(seq);
      const status = response.status || 200;
      item.resolve({ status, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers || {}), json: async () => response.json,
        arrayBuffer: async () => Uint8Array.from(response.bytes || []).buffer });
    });
    global.fetch = (url, options = {}) => new Promise(resolve => {
      const id = ++seq; pending.set(id, {resolve});
      port.postMessage({seq:id,url:String(url),body:options.body ? JSON.parse(options.body) : null});
    });
    for (const name of ['node:http','node:https']) {
      const module = require(name);
      module.request = module.get = () => {
        parentPort.postMessage({event:'forbidden-network'});
        throw Error('Only the isolated MessagePort HTTP mock is allowed');
      };
    }
    require(workerData.script);
  `,
    {
      eval: true,
      transferList: [port2],
      workerData: {
        dataDir,
        localIndexPath,
        watch: false,
        mockPort: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  const events = [],
    requests = [],
    observers = new Set(),
    calls = new Map();
  let sequence = 0,
    closed = false;
  const notify = () => {
    for (const check of observers) check();
  };
  port1.on('message', (request) => {
    requests.push(request);
    notify();
  });
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event) {
        events.push(message);
        notify();
      }
      if (message.event === 'ready') resolve();
      const call = calls.get(message.request);
      if (!call) return;
      calls.delete(message.request);
      clearTimeout(call.timer);
      message.error
        ? call.reject(new Error(message.error + '\n' + message.stack))
        : call.resolve(message.result);
    });
  });
  const c = {
    events,
    requests,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          calls.delete(request);
          reject(new Error('RPC timeout: ' + method));
        }, 5000);
        calls.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observers.delete(check);
          reject(new Error('Held import did not reach expected checkpoint'));
        }, 5000);
        const check = () => {
          if (!predicate()) return;
          clearTimeout(timer);
          observers.delete(check);
          resolve();
        };
        observers.add(check);
        check();
      });
    },
    answer(request, response) {
      port1.postMessage({ seq: request.seq, response });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await c.call('cancel');
      } finally {
        port1.close();
        await worker.terminate();
        for (const call of calls.values()) clearTimeout(call.timer);
      }
    }
  };
  return c;
}

async function fixture(t, acrossPage) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-import-local-priority-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  const indexed = path.join(tmp, 'subjects.sqlite');
  await archive(indexed);
  await fs.mkdir(source);
  const local = path.join(source, LOCAL.name),
    learned = path.join(source, STATIC.name);
  const laterKnownId = [idFor(local), idFor(learned)].sort().at(-1);
  // Selection is on path hashes, never opendir order: make unknown work precede
  // both known folders, and put a known folder beyond the 64-item page boundary.
  const candidates = [];
  for (
    let i = 0;
    candidates.length < (acrossPage ? 64 : 1) ||
    !candidates.some((p) => idFor(p) < idFor(local) && idFor(p) < idFor(learned));
    i++
  ) {
    assert.ok(i < 100000, 'could not generate bounded fixture ordering');
    const p = path.join(source, 'Unindexed Novel Atlas ' + i);
    if (idFor(p) < laterKnownId) candidates.push(p);
  }
  candidates.sort((a, b) => idFor(a).localeCompare(idFor(b)));
  const unknowns = acrossPage ? candidates.slice(0, 64) : [candidates[0]];
  const unknown = unknowns[0];
  assert.ok(idFor(unknown) < idFor(local) && idFor(unknown) < idFor(learned));
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: '#82baca' } })
    .png()
    .toBuffer();
  for (const p of [...unknowns, local, learned]) await fs.mkdir(p);
  for (const p of [unknown, local, learned]) await fs.writeFile(path.join(p, 'local.png'), png);
  let c;
  t.after(async () => {
    if (c) await c.close();
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('acg-import-local-priority-'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  c = await client(data, indexed);
  await c.call('scan', { path: source, offline: true, onlineMatch: true, subjectTypes: [4] });
  assert.equal(c.requests.length, 0);
  assert.equal((await c.call('localIndexStatus')).available, true);
  return { c, tmp, source, data, unknown, local, learned, folders: unknowns.length + 2 };
}

for (const acrossPage of [false, true]) {
  test(
    `local identities and thumbnails precede an unknown folder held HTTP${acrossPage ? ' across a 64-item page' : ''}, and cancel blocks its late response`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, acrossPage),
        { c } = f;
      await c.call('sync');
      await c.until(() => c.requests.length === 1);
      const held = c.requests[0];
      assert.ok(held.url.includes('/search/subjects'));
      assert.equal(held.body.keyword, path.basename(f.unknown));
      // The first remote reply is still absent; these must come solely from local
      // and learned evidence, with the existing fallback image kept visible.
      for (const [folder, subjectId] of [
        [f.local, LOCAL.id],
        [f.learned, STATIC.id]
      ]) {
        const node = await c.call('get', { id: idFor(folder) });
        assert.equal(node.subject_id, subjectId);
        assert.equal(node.manual_subject, 0);
        assert.equal(node.match_confidence, 1);
        assert.equal(node.metadata.resources_complete, false);
        assert.equal(node.cover, idFor(path.join(folder, 'local.png')));
        assert.equal(node.cover_source, 'fallback');
        const thumb = await c.call('thumb', { id: node.id, size: 512, priority: true });
        assert.ok(thumb.path);
        assert.equal(thumb.placeholder, undefined);
        assert.equal(thumb.icon, undefined);
        assert.equal((await sharp(thumb.path).metadata()).format, 'webp');
      }
      const unknown = await c.call('get', { id: idFor(f.unknown) });
      assert.equal(unknown.subject_id, null);
      const unknownThumb = await c.call('thumb', { id: unknown.id, size: 512 });
      assert.equal((await sharp(unknownThumb.path).metadata()).format, 'webp');
      const status = await c.call('syncStatus');
      assert.equal(status.pending, f.folders);
      assert.equal(status.completed, 0);
      assert.ok(status.buffered <= 64);
      assert.equal(
        c.requests.length,
        1,
        'local pass never starts HTTP or prefetches a whole batch'
      );
      const after = c.events.length;
      await c.call('cancel');
      // Deliver a successful old response despite abort, proving stale evidence is
      // rejected after cancellation rather than relying on a cooperative fetch.
      const late = {
        id: 700099,
        type: 4,
        name: path.basename(f.unknown),
        date: '2001-01-01',
        collection: { collect: 100 }
      };
      c.answer(held, { json: { data: [late], list: [late], total: 1 } });
      await c.until(() =>
        c.events.slice(after).some((e) => e.event === 'online' && !e.data.active)
      );
      assert.equal((await c.call('get', { id: unknown.id })).subject_id, null);
      const done = await c.call('syncStatus');
      assert.equal(done.pending, 0);
      assert.equal(done.completed, 0);
      assert.equal(
        c.requests.length,
        1,
        'no late detail/persons/CDN request can survive cancellation'
      );
      const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT id FROM metadata WHERE id=?').get(late.id), undefined);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM match_pending').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM match_frontier').get().n, 0);
      } finally {
        db.close();
      }
      assert.equal(c.events.filter((e) => e.event === 'forbidden-network').length, 0);
    }
  );
}

async function learnedSeriesFixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-learned-series-priority-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data'),
    parent = path.join(source, '合集'),
    child = path.join(parent, 'Adorable Witch'),
    unknown = path.join(source, 'Unindexed Held Archive'),
    image = path.join(child, 'local.png');
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(unknown);
  await fs.writeFile(
    image,
    await sharp({ create: { width: 16, height: 24, channels: 3, background: '#82baca' } })
      .png()
      .toBuffer()
  );
  let c;
  t.after(async () => {
    if (c) await c.close();
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('acg-learned-series-priority-'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  // A missing archive and a fresh data directory exclude both local-index and
  // prior metadata/HTTP-cache evidence. Only the reviewed child-name binding exists.
  c = await client(data, path.join(tmp, 'missing-subjects.sqlite'));
  await c.call('scan', {
    path: source,
    offline: true,
    onlineMatch: true,
    subjectTypes: [4],
    matchDepth: 1
  });
  assert.equal((await c.call('localIndexStatus')).available, false);
  assert.equal(c.requests.length, 0);
  assert.equal((await c.call('get', { id: idFor(parent) })).subject_id, null);
  const db = new DatabaseSync(path.join(data, 'library.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM metadata').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM bangumi_cache').get().n, 0);
  } finally {
    db.close();
  }
  return { c, tmp, source, data, parent, child, unknown, image };
}

async function assertLearnedSeriesIdentity(f) {
  const { c } = f;
  const node = await c.call('get', { id: idFor(f.parent) });
  assert.equal(node.subject_id, 390830, 'reviewed child identity is saved before resource HTTP');
  assert.equal(node.manual_subject, 0);
  assert.equal(node.match_confidence, 1);
  assert.equal(node.metadata.id, 390830);
  assert.equal(node.metadata.resources_complete, false);
  assert.equal(node.cover, idFor(f.image));
  assert.equal(node.cover_source, 'fallback');
  assert.equal(
    (await c.call('get', { id: idFor(f.child) })).subject_id,
    null,
    'the child probe must not bind a folder beyond matchDepth=1'
  );
  const thumb = await c.call('thumb', { id: node.id, size: 512, priority: true });
  assert.ok(thumb.path);
  assert.equal(thumb.placeholder, undefined);
  assert.equal(thumb.icon, undefined);
  assert.equal((await sharp(thumb.path).metadata()).format, 'webp');
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
  try {
    assert.equal(
      db.prepare('SELECT subject_id FROM nodes WHERE id=?').get(node.id).subject_id,
      390830,
      'identity is committed to SQLite while resource requests remain unfinished'
    );
  } finally {
    db.close();
  }
  const status = await c.call('syncStatus');
  assert.ok(status.pending > 0, 'unfinished resources remain durable pending work');
  assert.equal(status.completed, 0);
  assert.ok(status.buffered <= 64);
  assert.equal(c.events.filter((e) => e.event === 'forbidden-network').length, 0);
  return status;
}

test(
  'a learned child binds its collection and serves a local thumbnail before any persons or CDN request',
  { timeout: 15000 },
  async (t) => {
    const f = await learnedSeriesFixture(t),
      { c } = f;
    await c.call('sync', { id: idFor(f.parent) });
    await c.until(() => c.requests.length > 0);
    await assertLearnedSeriesIdentity(f);
    assert.equal(c.requests.length, 1, 'hold the first resource response without prefetch');
    assert.equal(
      c.requests[0].url,
      'https://api.bgm.tv/v0/subjects/390830',
      'resource enrichment starts with detail only after the local identity pass'
    );
  }
);

for (const pause of [
  { status: 401, reason: 'access', headers: {} },
  { status: 429, reason: 'network', headers: { 'Retry-After': '60' } }
]) {
  test(
    `a learned child binds its collection without HTTP while the production queue is paused by ${pause.status}`,
    { timeout: 15000 },
    async (t) => {
      const f = await learnedSeriesFixture(t),
        { c } = f;
      // Enter the real production pause through a failed unknown-folder search;
      // do not seed match_resume or replace the worker's pause/identity functions.
      await c.call('sync', { id: idFor(f.unknown) });
      await c.until(() => c.requests.length === 1);
      assert.ok(c.requests[0].url.includes('/search/subjects'));
      assert.equal(c.requests[0].body.keyword, path.basename(f.unknown));
      c.answer(c.requests[0], { status: pause.status, headers: pause.headers, json: {} });
      await c.until(() =>
        c.events.some(
          (e) => e.event === 'online' && !e.data.active && e.data.paused === pause.reason
        )
      );
      assert.equal((await c.call('get', { id: idFor(f.parent) })).subject_id, null);
      const after = c.events.length,
        requestCount = c.requests.length;
      await c.call('sync', { id: idFor(f.parent) });
      await c.until(
        () =>
          c.requests.length > requestCount ||
          c.events
            .slice(after)
            .some((e) => e.event === 'online' && !e.data.active && e.data.paused === pause.reason)
      );
      assert.equal(
        c.requests.length,
        requestCount,
        'a paused local child fallback must not start detail, persons, search or CDN HTTP'
      );
      const state = await assertLearnedSeriesIdentity(f);
      assert.equal(state.paused, pause.reason);
      assert.equal((await c.call('get', { id: idFor(f.unknown) })).subject_id, null);
      assert.equal(
        c.requests.length,
        requestCount,
        'local thumbnail generation also stays offline'
      );
    }
  );
}
