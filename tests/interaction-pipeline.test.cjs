'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const { lookupLearnedTitleBindings } = require('../src/learned-title-bindings.cjs');

// Install the fetch replacement before loading the production worker. Requests
// travel only over this MessagePort; no real HTTP listener or network is used.
async function client(f, respond) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const mock = workerData.mockPort, pending = new Map();
    let next = 0, tick = 0;
    const realNow = Date.now;
    Date.now = () => realNow() + (++tick * 2000);
    mock.on('message', ({ seq, response }) => {
      const item = pending.get(seq);
      if (!item) return;
      pending.delete(seq);
      item.cleanup();
      if (response.failure) return item.reject(new Error(response.failure));
      const status = response.status || 200;
      item.resolve({ status, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers || {}),
        json: async () => response.json,
        arrayBuffer: async () => Uint8Array.from(response.bytes || []).buffer });
    });
    global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const seq = ++next, signal = options.signal;
      const abort = () => { pending.delete(seq); reject(signal.reason); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(seq, { resolve, reject, cleanup });
      mock.postMessage({ seq, url: String(url),
        body: options.body ? JSON.parse(options.body) : null,
        authorized: !!options.headers?.Authorization });
    });
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir: f.data,
        localIndexPath: path.join(f.tmp, 'missing-local-index.sqlite'),
        watch: false,
        token: 'isolated-interaction-test-token',
        mockPort: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  const events = [],
    requests = [],
    waiters = new Set(),
    calls = new Map();
  let sequence = 0,
    closed = false;
  const notify = () => {
    for (const check of waiters) check();
  };
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      if (message.event) {
        events.push(message);
        notify();
      }
      const call = calls.get(message.request);
      if (call) {
        calls.delete(message.request);
        clearTimeout(call.timer);
        message.error ? call.reject(new Error(message.error)) : call.resolve(message.result);
      }
    });
  });
  port1.on('message', async (request) => {
    requests.push(request);
    let response;
    try {
      const responsePromise = respond(request);
      notify();
      response = await responsePromise;
    } catch (error) {
      response = { failure: error.message };
    }
    if (!closed) port1.postMessage({ seq: request.seq, response });
  });
  await ready;
  const c = {
    events,
    requests,
    call(method, args = {}, timeout = 8000) {
      const request = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(request);
          reject(new Error('Timed out: ' + method));
        }, timeout);
        calls.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error('Timed out waiting for interaction event'));
        }, 8000);
        const check = () => {
          if (!predicate()) return;
          clearTimeout(timer);
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
      });
    },
    complete(id, after = 0) {
      return c.until(() =>
        events
          .slice(after)
          .some((e) => e.event === 'association' && e.data.id === id && e.data.state === 'complete')
      );
    },
    idle(after = 0) {
      return c.until(() => events.slice(after).some((e) => e.event === 'online' && !e.data.active));
    },
    async close() {
      if (closed) return;
      try {
        await c.call('shutdown');
      } finally {
        closed = true;
        port1.close();
        await worker.terminate();
        for (const call of calls.values()) clearTimeout(call.timer);
      }
    }
  };
  return c;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(name = '月色真美') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-interaction-'));
  const source = path.join(tmp, 'source-a'),
    data = path.join(tmp, 'data');
  const folder = path.join(source, name),
    image = path.join(folder, 'local.png');
  await fs.mkdir(folder, { recursive: true });
  const png = await sharp({
    create: {
      width: 40,
      height: 60,
      channels: 3,
      background: '#e9aacc'
    }
  })
    .png()
    .toBuffer();
  await fs.writeFile(image, png);
  return { tmp, source, data, name, folder, image, png, id: idFor(folder) };
}
async function cleanup(f) {
  const target = path.resolve(f.tmp),
    parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(target), parent);
  assert.ok(path.basename(target).startsWith('acg-interaction-'));
  await fs.rm(target, { recursive: true, force: true });
}
function subject(id) {
  return {
    id,
    type: 2,
    name: '月色真美',
    name_cn: '月色真美',
    date: '2017-04-06',
    collection: { collect: 100 }
  };
}
const candidates = () => Array.from({ length: 8 }, (_, index) => subject(101 + index));
const details = (id) => ({
  ...subject(id),
  summary: 'rich detail ' + id,
  images: { large: `https://lain.bgm.tv/interaction-${id}.png` },
  infobox: [{ key: '制作', value: '本地模拟制作组' }]
});
const staff = [{ id: 8001, name: '模拟监督', relation: '监督' }];
function responder(f, hold = async () => {}) {
  return async (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'api.bgm.tv' && u.pathname.includes('/search/'))
      return { json: { data: candidates(), total: 8 } };
    const match = u.pathname.match(/^\/v0\/subjects\/(\d+)(\/persons)?$/);
    if (u.hostname === 'api.bgm.tv' && match) {
      const id = Number(match[1]),
        stage = match[2] ? 'persons' : 'detail';
      await hold(stage, id);
      return { json: stage === 'persons' ? staff : details(id) };
    }
    if (u.hostname === 'lain.bgm.tv') {
      const id = Number(u.pathname.match(/interaction-(\d+)\.png$/)?.[1]);
      assert.ok(id > 0, 'only fixture cover URLs may be requested');
      await hold('cover', id);
      assert.equal(request.authorized, false, 'API credentials never accompany cover bytes');
      return { bytes: [...f.png] };
    }
    throw new Error('Unexpected mock HTTP request: ' + request.url);
  };
}
async function scanAndMatch(c, f) {
  await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
  const result = await c.call('match', { id: f.id });
  assert.ok(result.candidates.some((item) => item.id === 107));
  assert.ok(result.candidates.some((item) => item.id === 108));
  assert.equal(result.node.subject_id, null);
  assert.equal(
    c.requests.some((r) => /\/subjects\/108$/.test(r.url)),
    false,
    'the selected candidate is beyond the bounded detail hydration budget'
  );
  return result;
}
function persisted(f, id = f.id) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
  try {
    return db
      .prepare('SELECT subject_id,manual_subject,manual_cover,cover FROM nodes WHERE id=?')
      .get(id);
  } finally {
    db.close();
  }
}
function onlineEvents(c, after) {
  return c.events.slice(after).filter((e) => e.event === 'online');
}

test('lightweight init retains roots/settings/dataDir while statistics returns actual counts', async () => {
  const f = await fixture();
  const c = await client(f, () => {
    throw new Error('init/statistics must not use HTTP');
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: false });
    const init = await c.call('init', { lightweight: true });
    assert.equal(init.stats, null);
    assert.equal(init.localIndex, null);
    assert.equal(init.dataDir, f.data);
    assert.equal(init.roots.length, 1);
    assert.equal(init.roots[0].id, idFor(f.source));
    assert.equal(init.roots[0].path, f.source);
    assert.equal(init.roots[0].name, path.basename(f.source));
    assert.equal(init.roots[0].folders, 1);
    assert.equal(init.roots[0].files, 1);
    assert.equal(init.settings.density, 166);
    const stats = await c.call('statistics');
    assert.deepEqual(stats, { total: 3, images: 1, folders: 2 });
    const full = await c.call('init');
    assert.deepEqual(full.stats, stats);
    assert.ok(full.localIndex && typeof full.localIndex === 'object');
    assert.equal(c.requests.length, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

for (const blockedStage of ['detail', 'persons', 'cover']) {
  test(`candidate bind commits immediately while ${blockedStage} enrichment HTTP is held`, async () => {
    const f = await fixture(),
      gate = deferred();
    let held = false;
    const c = await client(
      f,
      responder(f, async (stage, id) => {
        if (id === 108 && stage === blockedStage) {
          held = true;
          await gate.promise;
        }
      })
    );
    try {
      await scanAndMatch(c, f);
      const after = c.events.length;
      // A held HTTP response cannot complete within this bound. Successful bind
      // proves the identity transaction is independent of every enrichment stage.
      const bound = await c.call('bind', { id: f.id, url: 'https://bgm.tv/subject/108' }, 2000);
      assert.equal(bound.enrichment_pending, true);
      assert.equal(bound.subject_id, 108);
      assert.equal(bound.manual_subject, 1);
      assert.equal(persisted(f).subject_id, 108);
      assert.equal(persisted(f).manual_subject, 1);
      await c.until(() => held);
      const during = await c.call('get', { id: f.id });
      assert.equal(during.subject_id, 108);
      assert.equal(during.manual_subject, 1);
      assert.equal(during.metadata.resources_complete, false);
      assert.deepEqual(onlineEvents(c, after), [], 'manual association starts no batch matcher');
      await c.call('setCover', { id: f.id, imageId: idFor(f.image) });
      await c.call('patch', { id: f.id, changes: { crop_x: 23, crop_y: 71, favorite: 1 } });
      gate.resolve();
      await c.complete(f.id, after);
      const complete = await c.call('get', { id: f.id });
      assert.equal(complete.subject_id, 108);
      assert.equal(complete.manual_subject, 1);
      assert.equal(complete.metadata.summary, 'rich detail 108');
      assert.deepEqual(complete.metadata.staff, staff);
      assert.equal(complete.metadata.resources_complete, true);
      assert.equal(complete.metadata.details_source, 'online');
      assert.equal(complete.cover, idFor(f.image));
      assert.equal(complete.manual_cover, 1);
      assert.deepEqual([complete.crop_x, complete.crop_y, complete.favorite], [23, 71, 1]);
      assert.deepEqual(onlineEvents(c, after), []);
      const cover = await fs.stat(complete.metadata.local_cover);
      assert.ok(cover.size > 0, 'held mock cover eventually becomes a valid local image');
    } finally {
      gate.resolve();
      await c.close();
      await cleanup(f);
    }
  });
}

test('a late old detail cannot overwrite a newer rapid manual selection', async () => {
  const f = await fixture(),
    gate = deferred();
  let held = false;
  const c = await client(
    f,
    responder(f, async (stage, id) => {
      if (stage === 'detail' && id === 107) {
        held = true;
        await gate.promise;
      }
    })
  );
  try {
    await scanAndMatch(c, f);
    assert.equal(
      c.requests.some((r) => /\/subjects\/107$/.test(r.url)),
      false
    );
    const after = c.events.length;
    const first = await c.call('bind', { id: f.id, url: '107' }, 2000);
    assert.equal(first.subject_id, 107);
    await c.until(() => held);
    const second = await c.call('bind', { id: f.id, url: '108' }, 2000);
    assert.equal(second.subject_id, 108);
    assert.equal(second.enrichment_pending, true);
    assert.equal(persisted(f).subject_id, 108, 'new identity is durable before old HTTP returns');
    gate.resolve();
    await c.complete(f.id, after);
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 108);
    assert.equal(node.manual_subject, 1);
    assert.equal(node.metadata.summary, 'rich detail 108');
    assert.equal(node.cover, 'subject:108');
    const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
    try {
      const previous = JSON.parse(db.prepare('SELECT json FROM metadata WHERE id=107').get().json);
      assert.equal(
        previous.summary,
        undefined,
        'stale detail cannot enrich even its prior seed row'
      );
    } finally {
      db.close();
    }
    assert.deepEqual(onlineEvents(c, after), []);
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

test('an existing manual same-title identity is automatically reused in another root without HTTP', async () => {
  const f = await fixture();
  const c = await client(f, responder(f));
  try {
    await scanAndMatch(c, f);
    const afterBind = c.events.length;
    await c.call('bind', { id: f.id, url: '108' }, 2000);
    await c.complete(f.id, afterBind);
    const source = path.join(f.tmp, 'source-b'),
      folder = path.join(source, f.name);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'other.png'), f.png);
    const after = c.events.length,
      requestCount = c.requests.length;
    await c.call('scan', { path: source, onlineMatch: true, subjectTypes: [2] });
    await c.idle(after);
    const reused = await c.call('get', { id: idFor(folder) });
    assert.equal(reused.subject_id, 108);
    assert.equal(reused.manual_subject, 0);
    assert.equal(reused.match_confidence, 1);
    assert.equal(reused.metadata.summary, 'rich detail 108');
    assert.equal(reused.metadata.resources_complete, true);
    assert.equal(
      c.requests.length,
      requestCount,
      'saved manual title keys need no new recall or resources'
    );
    assert.equal(persisted(f).manual_subject, 1);
    const init = await c.call('init', { lightweight: true });
    assert.equal(init.roots.length, 2);
    assert.deepEqual(await c.call('statistics'), { total: 6, images: 2, folders: 4 });
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('a static exact learned title commits automatic identity before same-ID enrichment without name search', async () => {
  const f = await fixture('Adorable Witch'),
    gate = deferred();
  const learned = lookupLearnedTitleBindings(f.name, [4]);
  assert.equal(learned.ambiguous, false);
  assert.deepEqual(
    learned.subjects.map((s) => s.id),
    [390830]
  );
  const selected = learned.subjects[0];
  const rich = {
    ...selected,
    summary: 'rich learned detail',
    images: { large: 'https://lain.bgm.tv/interaction-390830.png' }
  };
  let held = false;
  const c = await client(f, async (request) => {
    const u = new URL(request.url);
    if (u.href === 'https://api.bgm.tv/v0/subjects/390830') {
      held = true;
      await gate.promise;
      return { json: rich };
    }
    if (u.href === 'https://api.bgm.tv/v0/subjects/390830/persons') return { json: staff };
    if (u.href === rich.images.large) {
      assert.equal(request.authorized, false);
      return { bytes: [...f.png] };
    }
    throw new Error('Learned identity must not search or request another ID: ' + request.url);
  });
  try {
    await c.call('scan', { path: f.source, offline: true, onlineMatch: true, subjectTypes: [4] });
    assert.equal((await c.call('localIndexStatus')).available, false);
    assert.equal(c.requests.length, 0);
    await c.call('sync', { id: f.id });
    await c.until(() => held);
    const during = await c.call('get', { id: f.id });
    assert.equal(during.subject_id, selected.id);
    assert.equal(during.manual_subject, 0);
    assert.equal(during.match_confidence, 1);
    assert.equal(during.metadata.resources_complete, false);
    const saved = persisted(f);
    assert.equal(saved.subject_id, selected.id);
    assert.equal(saved.manual_subject, 0);
    assert.equal(c.requests.length, 1, 'only held same-ID detail has started');
    const after = c.events.length;
    gate.resolve();
    await c.idle(after);
    const complete = await c.call('get', { id: f.id });
    assert.equal(complete.subject_id, selected.id);
    assert.equal(complete.manual_subject, 0);
    assert.equal(complete.match_confidence, 1);
    assert.equal(complete.metadata.summary, rich.summary);
    assert.deepEqual(complete.metadata.staff, staff);
    assert.equal(complete.metadata.resources_complete, true);
    assert.equal(complete.cover, 'subject:' + selected.id);
    assert.ok((await fs.stat(complete.metadata.local_cover)).size > 0);
    assert.deepEqual(
      c.requests.map((r) => r.url).sort(),
      [
        'https://api.bgm.tv/v0/subjects/390830',
        'https://api.bgm.tv/v0/subjects/390830/persons',
        rich.images.large
      ].sort()
    );
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

test('a static cross-type ambiguous title stays unbound even when a root admits only one learned type', async () => {
  const f = await fixture('9-nine'),
    gate = deferred();
  const all = lookupLearnedTitleBindings(f.name, [2, 4]);
  assert.equal(all.ambiguous, true);
  assert.deepEqual(all.subjects.map((s) => s.id).sort(), [290856, 496973]);
  const gameOnly = lookupLearnedTitleBindings(f.name, [4]);
  assert.equal(
    gameOnly.ambiguous,
    true,
    'category filtering must not erase static identity conflicts'
  );
  assert.deepEqual(
    gameOnly.subjects.map((s) => s.id),
    [290856]
  );
  let held = false;
  const c = await client(f, async (request) => {
    const u = new URL(request.url);
    if (u.hostname === 'api.bgm.tv' && u.pathname.includes('/search/')) {
      held = true;
      await gate.promise;
      // No independent search evidence resolves the learned-name conflict.
      return { json: { data: [], total: 0 } };
    }
    throw new Error(
      'An ambiguous learned identity must not request subject resources: ' + request.url
    );
  });
  try {
    await c.call('scan', { path: f.source, offline: true, onlineMatch: true, subjectTypes: [4] });
    assert.equal((await c.call('localIndexStatus')).available, false);
    await c.call('sync', { id: f.id });
    await c.until(() => held);
    const during = await c.call('get', { id: f.id });
    assert.equal(during.subject_id, null);
    assert.equal(during.manual_subject, 0);
    assert.equal(during.match_confidence, null);
    assert.equal(persisted(f).subject_id, null, 'filtered static singleton is not committed');
    const after = c.events.length;
    gate.resolve();
    await c.idle(after);
    const complete = await c.call('get', { id: f.id });
    assert.equal(complete.subject_id, null);
    assert.equal(complete.manual_subject, 0);
    assert.equal(complete.match_confidence, null);
    assert.ok(c.requests.length > 0, 'worker falls back to ordinary mocked recall');
    assert.ok(c.requests.every((r) => new URL(r.url).pathname.includes('/search/')));
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});
