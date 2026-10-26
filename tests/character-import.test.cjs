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
const { createLocalIndex } = require('../src/local-index.cjs');

async function fixture(t, roles = [], { empty = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-character-test-'));
  let activeClient;
  t.after(async () => {
    await activeClient?.close();
    assert.ok(path.resolve(tmp).startsWith(path.join(os.tmpdir(), 'acg-character-test-')));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  const source = path.join(tmp, 'roles'),
    folder = path.join(source, '明日香'),
    data = path.join(tmp, 'data');
  await fs.mkdir(folder, { recursive: true });
  const png = await sharp({ create: { width: 64, height: 96, channels: 3, background: '#f4acbb' } })
    .png()
    .toBuffer();
  for (const [name, time] of empty
    ? []
    : [
        ['10.png', 1900000000],
        ['2.png', 1800000000],
        ['1.png', 1600000000]
      ]) {
    await fs.writeFile(path.join(folder, name), png);
    await fs.utimes(path.join(folder, name), time, time);
  }
  if (!empty) await fs.writeFile(path.join(folder, '0.mp4'), 'not decoded in these tests');
  const filename = path.join(tmp, 'archive.sqlite'),
    db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT);
    CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
    CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT);
    CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
    CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT,source TEXT);
    CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
    CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
    CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');`);
  db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
    7,
    2,
    '同ID作品',
    '',
    0,
    '',
    '作品简介不能作为角色简介',
    '[]',
    '{}',
    '[]',
    '{}'
  );
  for (const role of roles) {
    db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?)').run(
      role.kind || 'character',
      role.id,
      role.name,
      role.name_cn || '',
      role.summary || '本地角色简介',
      '[]',
      JSON.stringify(role.aliases || []),
      '{}'
    );
    for (const name of [role.name, role.name_cn, ...(role.aliases || [])].filter(Boolean)) {
      db.prepare('INSERT INTO entity_keys VALUES(?,?,?,?)').run(
        role.kind || 'character',
        role.id,
        normalize(name),
        name
      );
      db.prepare('INSERT INTO entity_names_fts VALUES(?,?,?)').run(
        normalize(name),
        role.kind || 'character',
        role.id
      );
    }
  }
  db.close();
  return {
    setClient(value) {
      activeClient = value;
    },
    tmp,
    source,
    folder,
    data,
    png,
    filename,
    id: idFor(folder),
    first: idFor(path.join(folder, '1.png')),
    second: idFor(path.join(folder, '2.png'))
  };
}
async function client(t, f, respond = () => ({ json: { total: 0, data: [] } })) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const pending = new Map(); let sequence = 0, tick = 0;
    const now = Date.now; Date.now = () => now() + (++tick * 2000);
    workerData.mock.on('message', ({ sequence, response }) => {
      const item = pending.get(sequence); if (!item) return; pending.delete(sequence);
      item.cleanup(); if (response.failure) return item.reject(new Error(response.failure));
      const status = response.status || 200;
      item.resolve({ status, ok: status >= 200 && status < 300, headers: new Headers(response.headers || {}), json: async () => response.json, arrayBuffer: async () => Uint8Array.from(response.bytes || []).buffer });
    });
    global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const current = ++sequence, signal = options.signal;
      const abort = () => { pending.delete(current); reject(signal.reason); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(current, { resolve, reject, cleanup });
      workerData.mock.postMessage({ sequence: current, url: String(url), body: options.body ? JSON.parse(options.body) : null, authorization: options.headers?.Authorization || null });
    });
    if (workerData.saveGate) {
      const module = require(workerData.characterModule), create = module.createCharacterLibrary;
      module.createCharacterLibrary = (e) => create({ ...e, refreshLocalCover: async (...args) => {
        await fetch('https://character-save-gate.test/commit');
        return e.refreshLocalCover(...args);
      } });
    }
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir: f.data,
        localIndexPath: f.filename,
        saveGate: !!f.saveGate,
        characterModule: path.resolve(__dirname, '../src/character-library.cjs'),
        watch: false,
        token: 'test-role-token',
        script: path.resolve(__dirname, '../src/library-worker.cjs'),
        mock: port2
      },
      transferList: [port2]
    }
  );
  const pending = new Map(),
    events = [],
    requests = [],
    listeners = new Set();
  let seq = 0,
    closed = false;
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      if (message.event) {
        events.push(message);
        for (const listener of listeners) listener();
      }
      const item = pending.get(message.request);
      if (item) {
        pending.delete(message.request);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
      }
    });
  });
  port1.on('message', async (request) => {
    requests.push(request);
    for (const listener of listeners) listener();
    let response;
    try {
      response = await respond(request);
    } catch (error) {
      response = { failure: error.message };
    }
    if (!closed) port1.postMessage({ sequence: request.sequence, response });
  });
  const c = {
    requests,
    events,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++seq;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: ' + method));
        }, 15000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error('Timed out waiting for character event'));
        }, 15000);
        const check = () => {
          if (predicate()) {
            clearTimeout(timer);
            listeners.delete(check);
            resolve();
          }
        };
        listeners.add(check);
      });
    },
    async idle() {
      for (;;) {
        const after = events.length,
          state = await c.call('syncStatus');
        if (!state.active && !state.pending && !state.discovering) return;
        await c.until(() =>
          events.slice(after).some((event) => event.event === 'online' && !event.data.active)
        );
      }
    },
    async close() {
      if (closed) return;
      try {
        await c.call('shutdown');
      } finally {
        closed = true;
        port1.close();
        await worker.terminate();
      }
    }
  };
  await ready;
  f.setClient(c);
  return c;
}
const options = (extra = {}) => ({
  directoryKind: 'character',
  characterCover: 'local-first',
  onlineMatch: false,
  ...extra
});
const scan = (c, f, extra = {}) => c.call('scan', { path: f.source, ...options(extra) });

test('local-first role import uses natural first image, independent local metadata and persistent rescan policy', async (t) => {
  const f = await fixture(t, [{ id: 7, name: '惣流・アスカ', aliases: ['明日香'] }]),
    c = await client(t, f);
  await scan(c, f);
  await c.idle();
  let n = await c.call('get', { id: f.id });
  assert.equal(n.cover, f.first);
  assert.equal(
    n.character_id,
    7,
    JSON.stringify({
      events: c.events,
      local: await c.call('localIndexStatus'),
      sync: await c.call('syncStatus')
    })
  );
  assert.equal(n.subject_id, null);
  assert.equal(n.metadata.kind, 'character');
  assert.equal(n.metadata.summary, '本地角色简介');
  assert.equal(n.effective_album_kind, 'character');
  assert.equal(n.match_confidence, 1);
  assert.equal(n.match_review, 0);
  assert.equal(n.confirmed, 1);
  assert.equal(c.requests.length, 0);
  assert.ok(
    c.events.some(
      (event) => event.event === 'changed' && event.data.id === f.id && event.data.matching === true
    ),
    'automatic character save completes and marks its browser update for batching'
  );
  assert.ok(
    !c.events.some((event) => event.event === 'online' && event.data.error),
    'automatic local metadata save must not fail after committing'
  );
  await fs.writeFile(path.join(f.folder, '0.png'), f.png);
  await c.call('scan', { path: f.source });
  await c.idle();
  n = await c.call('get', { id: f.id });
  assert.equal(n.cover, idFor(path.join(f.folder, '0.png')));
  assert.equal(n.character_id, 7);
  assert.equal(n.confirmed, 1);
  assert.equal(n.match_confidence, 1);
  await c.call('resetCover', { id: f.id });
  assert.equal((await c.call('get', { id: f.id })).confirmed, 1);
  assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id));
  const listed = await c.call('list', { parent: idFor(f.source) });
  assert.equal(listed.items.find((item) => item.id === f.id).metadata.kind, 'character');
});

test('same-name characters stay unbound and manual ID reader selects role even with unrelated folder name', async (t) => {
  const f = await fixture(t, [
    { id: 7, name: '明日香' },
    { id: 8, name: '明日香' },
    { id: 9, name: '綾波レイ' },
    { id: 9, kind: 'person', name: 'Person' }
  ]);
  const index = createLocalIndex({ localIndexPath: f.filename });
  assert.equal(index.readCharacter(9).name, '綾波レイ');
  assert.equal(index.readCharacter(9).kind, 'character');
  assert.equal(index.readCharacter(-1), null);
  index.close();
  const c = await client(t, f);
  await scan(c, f);
  await c.idle();
  assert.equal((await c.call('get', { id: f.id })).character_id, null);
  await assert.rejects(
    c.call('bind', { id: f.id, kind: 'character', url: 'https://bgm.tv/subject/9' }),
    /角色/
  );
  const bound = await c.call('bind', {
    id: f.id,
    kind: 'character',
    url: 'https://bgm.tv/character/9'
  });
  assert.equal(bound.character_id, 9);
  assert.equal(bound.manual_character, 1);
  assert.equal(bound.match_confidence, null);
  assert.equal(bound.match_review, 0);
  assert.equal(bound.confirmed, 1);
  assert.equal(bound.cover_source, 'fallback');
  assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id));
  assert.equal(bound.subject_id, null);
  assert.equal(bound.metadata.name, '綾波レイ');
  await c.call('scan', { path: f.source });
  await c.idle();
  assert.equal((await c.call('get', { id: f.id })).character_id, 9);
  assert.equal(c.requests.length, 0);
  await c.close();
  const restarted = await client(t, f);
  const restored = await restarted.call('get', { id: f.id });
  assert.equal(restored.character_id, 9);
  assert.equal(restored.manual_character, 1);
  assert.equal(restored.match_confidence, null);
  assert.equal(restored.confirmed, 1);
  assert.equal(restored.match_review, 0);
  assert.equal(restored.cover_source, 'fallback');
  assert.ok(
    !(await restarted.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id)
  );
});

test('Bangumi role portrait uses separate files, shared token API and credential-free image requests', async (t) => {
  const f = await fixture(t),
    c = await client(t, f, (request) => {
      if (request.url.includes('/v0/search/characters'))
        return {
          json:
            request.body.keyword === '明日香'
              ? { total: 1, data: [{ id: 7, name: '明日香' }] }
              : { total: 0, data: [] }
        };
      if (request.url.endsWith('/v0/characters/7'))
        return {
          json: {
            id: 7,
            name: '明日香',
            summary: '在线角色介绍',
            images: { large: 'https://lain.bgm.tv/pic/crt/l/7.jpg' }
          }
        };
      return { bytes: [...f.png] };
    });
  await scan(c, f, { onlineMatch: true, characterCover: 'bangumi' });
  await c.idle();
  let n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, 7);
  assert.equal(n.cover, 'character:7');
  assert.equal(n.match_confidence, 1);
  assert.equal(n.match_review, 0);
  assert.equal(n.confirmed, 1);
  await c.call('resetCover', { id: f.id });
  const refreshStart = c.events.length;
  await c.call('refreshMetadata', { id: f.id });
  assert.ok(
    c.events
      .slice(refreshStart)
      .some((event) => event.event === 'changed' && event.data.id === f.id && !event.data.matching),
    'manual metadata refresh on an automatically associated character stays immediate'
  );
  n = await c.call('get', { id: f.id });
  assert.equal(n.confirmed, 1);
  assert.equal(n.match_confidence, 1);
  assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id));
  assert.equal(n.metadata.summary, '在线角色介绍');
  const image = c.requests.find((request) => request.url.includes('lain.bgm.tv'));
  assert.equal(image.authorization, null);
  assert.ok(
    c.requests
      .filter((request) => request.url.includes('api.bgm.tv'))
      .every((request) => request.authorization === 'Bearer test-role-token')
  );
  const source = await c.call('source', { id: f.id });
  assert.equal(path.basename(source.file), 'character-7.webp');
  assert.equal((await fs.stat(path.join(f.data, 'metadata', 'character-7.md'))).isFile(), true);
  await c.call('patch', { id: f.id, changes: { crop_x: 32, crop_zoom: 1.5 } });
  await c.call('setCover', { id: f.id, imageId: f.second });
  await c.call('patch', { id: f.id, changes: { crop_x: 32, crop_zoom: 1.5, confirmed: 0 } });
  await c.call('refreshMetadata', { id: f.id });
  n = await c.call('get', { id: f.id });
  assert.equal(n.confirmed, 0);
  assert.equal(n.match_review, 0);
  assert.equal(n.cover, f.second);
  assert.equal(n.crop_x, 32);
  assert.equal(n.crop_zoom, 1.5);
  assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id));
  await c.close();
  const restarted = await client(t, f);
  const restored = await restarted.call('get', { id: f.id });
  assert.equal(restored.confirmed, 0);
  assert.equal(restored.match_review, 0);
  assert.equal(restored.manual_cover, 1);
  assert.equal(restored.cover, f.second);
  assert.deepEqual([restored.crop_x, restored.crop_zoom], [32, 1.5]);
  assert.ok(
    !(await restarted.call('list', { filter: 'pending' })).items.some((item) => item.id === f.id)
  );
});

test('local-first still downloads chosen online metadata without replacing local cover', async (t) => {
  const f = await fixture(t, [{ id: 7, name: '明日香' }]),
    c = await client(t, f, (request) => {
      if (request.url.includes('/search/')) return { json: { total: 0, data: [] } };
      assert.ok(request.url.endsWith('/v0/characters/7'));
      return {
        json: {
          id: 7,
          name: '明日香',
          summary: '联网简介',
          images: { large: 'https://lain.bgm.tv/portrait.jpg' }
        }
      };
    });
  await scan(c, f, { onlineMatch: true });
  await c.idle();
  const n = await c.call('get', { id: f.id });
  assert.equal(n.cover, f.first);
  assert.equal(n.metadata.summary, '联网简介');
  assert.equal(c.requests.filter((request) => request.url.endsWith('/v0/characters/7')).length, 1);
  assert.ok(c.requests.every((request) => !request.url.includes('lain.bgm.tv')));
});

test('portrait absence falls back locally and custom role survives rescans and all-cache clearing', async (t) => {
  const f = await fixture(t),
    c = await client(t, f, (request) =>
      request.url.includes('/search/')
        ? {
            json:
              request.body.keyword === '明日香'
                ? { total: 1, data: [{ id: 7, name: '明日香' }] }
                : { total: 0, data: [] }
          }
        : { json: { id: 7, name: '明日香', summary: '没有立绘' } }
    );
  await scan(c, f, { onlineMatch: true, characterCover: 'bangumi' });
  await c.idle();
  assert.equal((await c.call('get', { id: f.id })).cover, f.first);
  await c.call('bind', {
    id: f.id,
    kind: 'character',
    custom: { name: '我的角色', summary: '手动简介' }
  });
  await c.call('patch', { id: f.id, changes: { crop_x: 27, crop_zoom: 1.3 } });
  await c.call('scan', { path: f.source });
  await c.idle();
  await c.call('cleanCache', { mode: 'reset-cache' });
  const n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, null);
  assert.equal(n.subject_id, null);
  assert.equal(n.manual_character, 1);
  assert.equal(n.metadata.name, '我的角色');
  assert.equal(n.metadata.summary, '手动简介');
  assert.equal(n.match_confidence, null);
  assert.equal(n.match_review, 0);
  assert.equal(n.crop_x, 27);
  assert.equal(n.crop_zoom, 1.3);
  assert.equal(n.cover, f.first);
});

test('character metadata cover paths migrate and reset-cache preserves association', async (t) => {
  const f = await fixture(t),
    c = await client(t, f, (request) => {
      if (request.url.includes('/search/'))
        return {
          json:
            request.body.keyword === '明日香'
              ? { total: 1, data: [{ id: 7, name: '明日香' }] }
              : { total: 0, data: [] }
        };
      if (request.url.includes('/characters/7'))
        return { json: { id: 7, name: '明日香', images: { large: 'https://lain.bgm.tv/7.jpg' } } };
      return { bytes: [...f.png] };
    });
  await scan(c, f, { onlineMatch: true, characterCover: 'bangumi' });
  await c.idle();
  const destination = path.join(f.tmp, 'new-cache');
  await c.call('changeCacheDirectory', { path: destination });
  const cacheRoot = (await c.call('cacheInfo')).path;
  let n = await c.call('get', { id: f.id });
  assert.equal(n.metadata.local_cover, path.join(cacheRoot, 'covers', 'character-7.webp'));
  assert.equal((await c.call('source', { id: f.id })).file, n.metadata.local_cover);
  await c.call('cleanCache', { mode: 'reset-cache' });
  n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, 7);
  assert.equal(n.metadata, null);
  await c.call('refreshMetadata', { id: f.id });
  n = await c.call('get', { id: f.id });
  assert.equal(n.cover, 'character:7');
  assert.equal(n.metadata.kind, 'character');
});

test('late online character detail cannot replace a newer custom manual association', async (t) => {
  const f = await fixture(t, [{ id: 7, name: '明日香' }]);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const c = await client(t, f, async (request) => {
    if (request.url.includes('/search/')) return { json: { total: 0, data: [] } };
    await gate;
    return { json: { id: 7, name: '明日香', summary: '迟到在线简介' } };
  });
  await scan(c, f, { onlineMatch: true });
  await c.until(() => c.requests.some((request) => request.url.endsWith('/v0/characters/7')));
  assert.equal((await c.call('get', { id: f.id })).metadata.summary, '本地角色简介');
  await c.call('bind', {
    id: f.id,
    kind: 'character',
    custom: { name: '人工角色', summary: '保留这段介绍' }
  });
  release();
  await c.idle();
  const n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, null);
  assert.equal(n.manual_character, 1);
  assert.equal(n.metadata.summary, '保留这段介绍');
  assert.equal(n.cover, f.first);
});

test('role image failure keeps first local image and the associated character introduction', async (t) => {
  const f = await fixture(t),
    c = await client(t, f, (request) => {
      if (request.url.includes('/search/'))
        return {
          json:
            request.body.keyword === '明日香'
              ? { total: 1, data: [{ id: 7, name: '明日香' }] }
              : { total: 0, data: [] }
        };
      if (request.url.includes('/characters/7'))
        return {
          json: {
            id: 7,
            name: '明日香',
            summary: '立绘失败仍有简介',
            images: { large: 'https://lain.bgm.tv/missing.jpg' }
          }
        };
      return { status: 404 };
    });
  await scan(c, f, { onlineMatch: true, characterCover: 'bangumi' });
  await c.idle();
  const n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, 7);
  assert.equal(n.cover, f.first);
  assert.equal(n.metadata.summary, '立绘失败仍有简介');
  assert.equal(n.metadata.resources_complete, false);
});

test('role detail access pause preserves local identity and resumes using the replacement token scope', async (t) => {
  const f = await fixture(t, [{ id: 7, name: '明日香' }]),
    c = await client(t, f, (request) => {
      if (request.url.includes('/search/')) return { json: { total: 0, data: [] } };
      return request.authorization === 'Bearer new-role-token'
        ? { json: { id: 7, name: '明日香', summary: '新权限简介' } }
        : { status: 403, json: { message: 'private' } };
    });
  await scan(c, f, { onlineMatch: true });
  await c.until(() =>
    c.events.some(
      (event) => event.event === 'online' && !event.data.active && event.data.paused === 'access'
    )
  );
  let n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, 7);
  assert.equal(n.metadata.summary, '本地角色简介');
  assert.equal(n.cover, f.first);
  assert.ok((await c.call('syncStatus')).pending > 0);
  await c.call('token', { value: 'new-role-token' });
  await c.idle();
  n = await c.call('get', { id: f.id });
  assert.equal(n.character_id, 7);
  assert.equal(n.metadata.summary, '新权限简介');
});

test('explicit work and photo types override role import policy on rescans, including inherited types', async (t) => {
  for (const kind of ['work', 'photo'])
    for (const inherited of [false, true])
      await t.test(`${kind}/${inherited ? 'parent' : 'self'}`, async (t) => {
        const f = await fixture(t, [{ id: 7, name: '明日香' }]),
          c = await client(t, f);
        await scan(c, f, { offline: true });
        await c.call('setAlbumKind', { id: inherited ? idFor(f.source) : f.id, kind });
        await c.call('scan', { path: f.source });
        await c.idle();
        const n = await c.call('get', { id: f.id });
        assert.equal(n.effective_album_kind, kind);
        assert.equal(n.character_id, null);
        assert.equal(c.requests.length, 0);
      });
});

test('postcommit local-cover yield preserves cancellation generations for automatic and manual enrichment', async (t) => {
  for (const manual of [false, true])
    await t.test(manual ? 'manual bind' : 'automatic match', async (t) => {
      const f = await fixture(t, [{ id: 7, name: '明日香' }], { empty: true });
      f.saveGate = true;
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const c = await client(t, f, async (request) => {
        if (request.url.includes('character-save-gate.test')) {
          await gate;
          return { json: {} };
        }
        if (request.url.includes('/search/')) return { json: { total: 0, data: [] } };
        return { json: { id: 7, name: '明日香', summary: 'AFTER_CANCEL' } };
      });
      try {
        await scan(c, f, { onlineMatch: true, offline: manual });
        const saving = manual ? c.call('bind', { id: f.id, kind: 'character', url: '7' }) : null;
        await c.until(() =>
          c.requests.some((request) => request.url.includes('character-save-gate.test'))
        );
        const before = await c.call('get', { id: f.id });
        assert.equal(before.character_id, 7);
        assert.equal(before.metadata.summary, '本地角色简介');
        await c.call('cancel');
        release();
        if (saving) await saving;
        await c.idle();
        const after = await c.call('get', { id: f.id });
        assert.equal(after.character_id, 7);
        assert.equal(after.metadata.summary, '本地角色简介');
        assert.equal(
          c.requests.filter((request) => request.url.includes('/v0/characters/')).length,
          0
        );
      } finally {
        release();
      }
    });
});
