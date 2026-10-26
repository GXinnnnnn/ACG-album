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

// All HTTP is replaced before the real worker loads. A separate MessagePort
// lets tests hold responses while exercising ordinary worker commands.
async function client(dataDir, respond, { fastClock = true, token = 'isolated-test-token' } = {}) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const mock = workerData.mockPort, pending = new Map();
    const originalAuthorization = workerData.token ? 'Bearer ' + workerData.token : null;
    let sequence = 0;
    if (workerData.fastClock) {
      const realNow = Date.now; let tick = 0;
      Date.now = () => realNow() + (++tick * 2000);
    }
    mock.on('message', ({ seq, response }) => {
      const item = pending.get(seq); if (!item) return;
      pending.delete(seq); item.cleanup();
      if (response.failure) return item.reject(new Error(response.failure));
      const status = response.status || 200;
      item.resolve({ status, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers || {}),
        json: async () => response.json,
        arrayBuffer: async () => Uint8Array.from(response.bytes || []).buffer });
    });
    global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const seq = ++sequence, signal = options.signal;
      const abort = () => { pending.delete(seq); reject(signal.reason); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(seq, { resolve, reject, cleanup });
      mock.postMessage({ seq, url: String(url), body: options.body ? JSON.parse(options.body) : null,
        authorized: !!options.headers?.Authorization,
        originalAccess: !!originalAuthorization && options.headers?.Authorization === originalAuthorization,
        at: performance.now() });
    });
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        token,
        fastClock,
        mockPort: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  let next = 0,
    closed = false;
  const pending = new Map(),
    events = [],
    requests = [],
    observers = new Set();
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      if (message.event) {
        events.push(message);
        for (const fn of observers) fn();
      }
      if (message.request && pending.has(message.request)) {
        const item = pending.get(message.request);
        pending.delete(message.request);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
      }
    });
  });
  port1.on('message', async (request) => {
    requests.push(request);
    for (const fn of observers) fn();
    let response;
    try {
      response = await respond(request);
    } catch (error) {
      response = { failure: error.message };
    }
    if (!closed) port1.postMessage({ seq: request.seq, response });
  });
  await ready;
  const c = {
    events,
    requests,
    call(method, args = {}) {
      const request = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: ' + method));
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
          reject(new Error('Timed out waiting for worker event'));
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
        events.slice(after).some((event) => event.event === 'online' && !event.data.active)
      );
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
  return c;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(album = '月色真美') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-matching-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data'),
    folder = path.join(source, album);
  await fs.mkdir(folder, { recursive: true });
  const png = await sharp({
    create: { width: 80, height: 120, channels: 3, background: '#e9aacc' }
  })
    .png()
    .toBuffer();
  const image = path.join(folder, 'z-latest.png');
  await fs.writeFile(image, png);
  await fs.utimes(image, 1700000000, 1700000000);
  return { tmp, source, data, folder, image, png, id: idFor(folder) };
}
async function cleanup(f) {
  assert.ok(path.resolve(f.tmp).startsWith(path.join(os.tmpdir(), 'acg-matching-')));
  await fs.rm(f.tmp, { recursive: true, force: true });
}
const entry = (id = 42, type = 2) => ({
  id,
  type,
  name: '月色真美',
  name_cn: '月色真美',
  date: '2017-04-06',
  collection: { collect: 100 }
});
function responder(subject = entry(), image) {
  return (request) => {
    if (request.url.includes('/search/')) return { json: { data: [subject] } };
    if (request.url.endsWith('/persons')) return { json: [] };
    if (request.url.startsWith('https://lain.bgm.tv/')) return { bytes: [...image] };
    return { json: subject };
  };
}

test('bilingual import retrieves both titles and binds their verified shared subject; manual search keeps alternatives', async () => {
  const chinese = '天选庶民的真命之选',
    japanese = 'セレクトオブリージュ';
  const f = await fixture(chinese + japanese);
  const subject = { id: 456680, type: 4, name: japanese, name_cn: chinese };
  const alternative = { id: 987, type: 4, name: japanese + ' 後日談' };
  const c = await client(f.data, (request) => {
    if (request.body) {
      const parts = [chinese, japanese].includes(request.body.keyword);
      return { json: { data: parts ? [subject, alternative] : [], total: parts ? 2 : 0 } };
    }
    if (request.url.endsWith('/persons')) return { json: [] };
    return { json: request.url.endsWith('/987') ? alternative : subject };
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 456680);
    assert.equal(node.manual_subject, 0);
    const searches = c.requests.filter((r) => r.body);
    assert.ok(searches.some((r) => r.body.keyword === chinese));
    assert.ok(searches.some((r) => r.body.keyword === japanese));
    assert.ok(
      searches.every((r) => r.authorized && r.originalAccess && !('nsfw' in r.body.filter))
    );
    assert.equal(c.requests.filter((r) => r.url.endsWith('/456680')).length, 1);
    const manual = await c.call('match', { id: f.id });
    assert.equal(manual.needs_selection, true);
    assert.equal(manual.candidates[0].id, 456680);
    assert.ok(manual.candidates.some((s) => s.id === alternative.id));
    assert.equal(manual.node.subject_id, 456680);
    assert.equal(manual.node.manual_subject, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('bilingual import rejects conflicting titles, one-language misses and detail alias contradictions', async (t) => {
  const chinese = '天选庶民的真命之选',
    japanese = 'セレクトオブリージュ';
  const subject = { id: 456680, type: 4, name: japanese, name_cn: chinese };
  for (const mode of ['conflict', 'missing-query', 'detail-contradiction', 'detail-alias']) {
    await t.test(mode, async () => {
      const f = await fixture(chinese + japanese);
      const c = await client(f.data, (request) => {
        if (request.body) {
          const word = request.body.keyword;
          let data = [];
          if (word === japanese)
            data = [mode === 'detail-alias' ? { ...subject, name_cn: '' } : subject];
          if (word === chinese && mode !== 'missing-query')
            data =
              mode === 'conflict'
                ? [{ id: 999, type: 4, name: chinese, collection: { collect: 99999999 } }]
                : [mode === 'detail-alias' ? { ...subject, name_cn: '' } : subject];
          return { json: { data, total: data.length } };
        }
        if (request.url.endsWith('/persons')) return { json: [] };
        if (request.url.endsWith('/999')) return { json: { id: 999, type: 4, name: chinese } };
        return {
          json:
            mode === 'detail-contradiction'
              ? { ...subject, name_cn: '' }
              : mode === 'detail-alias'
                ? { ...subject, name_cn: '', infobox: [{ key: '别名', value: [{ v: chinese }] }] }
                : mode === 'conflict'
                  ? { ...subject, name_cn: '' }
                  : subject
        };
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
        await c.idle();
        assert.equal(
          (await c.call('get', { id: f.id })).subject_id,
          mode === 'detail-alias' ? 456680 : null
        );
        assert.ok(c.requests.filter((r) => /\/v0\/subjects\/\d+$/.test(r.url)).length <= 6);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
  }
});

test('explicit opt-out persists across restart/refresh despite global true; manual matching still works', async () => {
  const f = await fixture();
  let c = await client(f.data, responder());
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await c.idle();
    assert.equal(c.requests.length, 0);
    assert.equal((await c.call('init')).settings.autoMatch, true);
    await c.close();
    c = await client(f.data, responder());
    await c.call('scan', { path: f.source });
    await c.idle();
    assert.equal(c.requests.length, 0);
    const matched = await c.call('match', { id: f.id });
    assert.equal(matched.node.subject_id, null);
    assert.equal(matched.candidates[0].id, 42);
    assert.equal(matched.needs_selection, true);
    assert.deepEqual(matched.searchAccess, { tokenPresent: true });
    assert.deepEqual(c.requests.find((r) => r.body).body.filter.type, [2]);
    await c.call('removeRoot', { id: idFor(f.source) });
    await c.call('scan', { path: f.source, offline: true });
    await c.call('setAlbumKind', { id: idFor(f.source), kind: 'work' });
    const after = c.events.length;
    await c.call('scan', { path: f.source });
    await c.idle(after);
    assert.equal(
      (await c.call('get', { id: f.id })).subject_id,
      42,
      'root removal deletes the old opt-out policy'
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('legacy roots without import options preserve global fallback and shallow work-album eligibility', async () => {
  const f = await fixture(path.join('月色真美', '月色真美'));
  const c = await client(f.data, responder());
  try {
    await c.call('settings', { key: 'autoMatch', value: false });
    await c.call('scan', { path: f.source });
    await c.idle();
    await c.call('setAlbumKind', { id: idFor(f.source), kind: 'work' });
    assert.equal(c.requests.length, 0);
    await c.call('settings', { key: 'autoMatch', value: true });
    const after = c.events.length;
    await c.call('scan', { path: f.source });
    await c.idle(after);
    assert.equal((await c.call('get', { id: idFor(path.dirname(f.folder)) })).subject_id, 42);
    assert.equal(
      (await c.call('get', { id: f.id })).subject_id,
      null,
      'legacy subjectDepth=1 is retained'
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('fresh legacy-root exact and fuzzy API matches persist their actual confidence without import policy', async (t) => {
  for (const exact of [true, false])
    await t.test(exact ? 'exact' : 'fuzzy', async () => {
      const chars = Array.from({ length: 210 }, (_, i) => String.fromCodePoint(0x5000 + i));
      const title = chars.slice(0, 25).join('');
      const subject = {
        id: 420,
        type: 2,
        name: exact ? title : chars.slice(0, 23).join('') + chars[200]
      };
      const f = await fixture(title);
      const c = await client(f.data, responder(subject, f.png), { token: '' });
      try {
        await c.call('settings', { key: 'autoMatch', value: false });
        await c.call('scan', { path: f.source });
        await c.idle();
        await c.call('setAlbumKind', { id: idFor(f.source), kind: 'work' });
        const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
        assert.equal(db.prepare('SELECT count(*) AS count FROM root_match_policy').get().count, 0);
        db.close();
        await c.call('settings', { key: 'autoMatch', value: true });
        const after = c.events.length;
        await c.call('scan', { path: f.source });
        await c.idle(after);
        let node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, 420);
        assert.equal(node.match_confidence, exact ? 1 : 44 / 47);
        assert.equal(node.match_review, 0);
        assert.equal(node.confirmed, 1);
        await c.call('refreshMetadata', { id: f.id });
        node = await c.call('get', { id: f.id });
        assert.equal(node.match_confidence, exact ? 1 : 44 / 47);
        assert.equal(node.match_review, 0);
        const pending = await c.call('list', { filter: 'pending' });
        assert.equal(
          pending.items.some((item) => item.id === f.id),
          false
        );
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('explicit opt-in works with global false for first-level folders; a credible original name stops broadening and downloads safe covers', async () => {
  const title = '白色相簿2 WHITE ALBUM 2 ホワイトアルバム2 [1080p] CG';
  const f = await fixture(title);
  const gate = deferred();
  const subject = {
    id: 12,
    type: 4,
    name: 'WHITE ALBUM 2',
    name_cn: '白色相簿2',
    infobox: [{ key: '别名', value: [{ v: 'ホワイトアルバム2' }] }],
    images: { large: 'https://lain.bgm.tv/test-cover.png' }
  };
  let first = true;
  const c = await client(f.data, async (request) => {
    if (request.body && first) {
      first = false;
      await gate.promise;
    }
    return responder(subject, f.png)(request);
  });
  try {
    await c.call('settings', { key: 'autoMatch', value: false });
    const scan = await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
    assert.equal(scan.errors, 0);
    await c.until(() => c.requests.length > 0);
    assert.equal(
      (await c.call('get', { id: f.id })).subject_id,
      null,
      'scan and read finish while HTTP is held'
    );
    gate.resolve();
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 12);
    assert.equal(node.cover_source, 'bangumi');
    const queries = c.requests.filter((r) => r.body);
    assert.deepEqual(
      queries.map((r) => r.body.keyword.trim()),
      [title]
    );
    assert.ok(queries.every((r) => JSON.stringify(r.body.filter.type) === '[4]'));
    assert.ok(
      c.requests.filter((r) => r.url.startsWith('https://api.bgm.tv')).every((r) => r.authorized)
    );
    assert.equal(c.requests.find((r) => r.url.startsWith('https://lain.bgm.tv')).authorized, false);
    assert.equal((await c.call('init')).settings.autoMatch, false);
    await c.close();
    // A fresh eligible album demonstrates that persisted opt-in also survives refresh/restart.
    const extra = path.join(f.source, '白色相簿2');
    await fs.mkdir(extra, { recursive: true });
    await fs.writeFile(path.join(extra, 'image.png'), f.png);
    const restarted = await client(f.data, responder(subject, f.png));
    try {
      await restarted.call('scan', { path: f.source });
      await restarted.idle();
      assert.equal((await restarted.call('get', { id: idFor(extra) })).subject_id, 12);
    } finally {
      await restarted.close();
    }
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

test('wrong-type search and detail responses both retain the natural first local cover', async (t) => {
  for (const wrongAt of ['search', 'detail'])
    await t.test(wrongAt, async () => {
      const f = await fixture();
      const c = await client(f.data, (request) => ({
        json: request.body ? { data: [entry(42, wrongAt === 'search' ? 2 : 4)] } : entry(42, 2)
      }));
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, null);
        assert.equal(node.cover, idFor(f.image));
        assert.ok(
          c.requests
            .filter((r) => r.body)
            .every((r) => JSON.stringify(r.body.filter.type) === '[4]')
        );
        if (wrongAt === 'search')
          assert.equal(
            c.requests.some((r) => !r.body),
            false
          );
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('offline, unrelated popularity, network failure and 429 all retain local covers without forced binding', async (t) => {
  for (const mode of ['offline', 'low', 'network', '429', 'bad-image'])
    await t.test(mode, async () => {
      const f = await fixture();
      const c = await client(f.data, (request) => {
        if (mode === 'network') throw new Error('fetch failed');
        if (mode === '429') return { status: 429, headers: { 'retry-after': '1' }, json: {} };
        if (mode === 'bad-image') {
          if (request.url.startsWith('https://lain.bgm.tv')) return { bytes: [0, 1, 2] };
          return responder({ ...entry(), images: { large: 'https://lain.bgm.tv/broken.png' } })(
            request
          );
        }
        return {
          json: {
            data: [
              {
                id: 99,
                type: 2,
                name: '完全无关的作品',
                rating: { score: 10, total: 999999 },
                collection: { collect: 999999 }
              }
            ]
          }
        };
      });
      try {
        await c.call('scan', {
          path: f.source,
          onlineMatch: true,
          subjectTypes: [2],
          offline: mode === 'offline'
        });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, mode === 'bad-image' ? 42 : null);
        assert.equal(node.cover, idFor(f.image));
        assert.equal(node.cover_source, 'fallback');
        if (mode === 'offline') assert.equal(c.requests.length, 0);
        if (mode === 'network')
          assert.equal(c.requests.length, 2, 'existing single retry remains bounded');
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('manual cover/crop/annotations set during detail lookup survive automatic metadata', async () => {
  const f = await fixture(),
    gate = deferred();
  const c = await client(f.data, async (request) => {
    if (/\/subjects\/42$/.test(request.url)) await gate.promise;
    return responder(
      { ...entry(), images: { large: 'https://lain.bgm.tv/cover.png' } },
      f.png
    )(request);
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.until(() => c.requests.some((r) => /\/subjects\/42$/.test(r.url)));
    await c.call('setCover', { id: f.id, imageId: idFor(f.image) });
    await c.call('patch', {
      id: f.id,
      changes: { crop_x: 22, crop_y: 71, crop_zoom: 2.2, favorite: 1, intro: 0 }
    });
    gate.resolve();
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 42);
    assert.equal(node.manual_cover, 1);
    assert.equal(node.cover, idFor(f.image));
    assert.deepEqual(
      [node.crop_x, node.crop_y, node.crop_zoom, node.favorite, node.intro],
      [22, 71, 2.2, 1, 0]
    );
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

test('manual binding completed during automatic cover download prevents stale assignment', async () => {
  const f = await fixture(),
    gate = deferred();
  const automatic = { ...entry(), images: { large: 'https://lain.bgm.tv/held.png' } };
  const c = await client(f.data, async (request) => {
    if (request.url.startsWith('https://lain.bgm.tv')) {
      await gate.promise;
      return { bytes: [...f.png] };
    }
    if (request.url.endsWith('/persons')) return { json: [] };
    if (request.body) return { json: { data: [automatic] } };
    return { json: request.url.endsWith('/99') ? entry(99) : automatic };
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.until(() => c.requests.some((r) => r.url.startsWith('https://lain.bgm.tv')));
    await c.call('bind', { id: f.id, url: '99' });
    gate.resolve();
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 99);
    assert.equal(node.manual_subject, 1);
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

test('removal, policy change, cancellation and shutdown invalidate a delayed detail response', async (t) => {
  for (const action of ['remove', 'disable', 'cancel', 'shutdown'])
    await t.test(action, async () => {
      const f = await fixture(),
        gate = deferred();
      const c = await client(f.data, async (request) => {
        if (/\/subjects\/42$/.test(request.url)) await gate.promise;
        return responder()(request);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.until(() => c.requests.some((r) => /\/subjects\/42$/.test(r.url)));
        if (action === 'remove') await c.call('removeRoot', { id: idFor(f.source) });
        if (action === 'disable')
          await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        if (action === 'cancel') await c.call('cancel');
        if (action === 'shutdown') await c.close();
        gate.resolve();
        if (action !== 'shutdown') {
          await c.idle();
          const node = await c.call('get', { id: f.id });
          if (action === 'remove') assert.equal(node, null);
          else {
            assert.equal(node.subject_id, null);
            assert.equal(node.cover, idFor(f.image));
          }
        }
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('repeated first-level folder queries are deduplicated but different selected categories get separate searches', async () => {
  const f = await fixture('月色真美');
  const duplicateRoot = path.join(f.tmp, 'duplicate', 'source');
  const duplicate = path.join(duplicateRoot, '月色真美');
  await fs.mkdir(duplicate, { recursive: true });
  await fs.writeFile(path.join(duplicate, 'image.png'), f.png);
  const otherRoot = path.join(f.tmp, 'other', 'source'),
    otherAlbum = path.join(otherRoot, '月色真美');
  await fs.mkdir(otherAlbum, { recursive: true });
  await fs.writeFile(path.join(otherAlbum, 'image.png'), f.png);
  const c = await client(f.data, (request) => {
    if (request.body)
      return {
        json: { data: [entry(request.body.filter.type[0] + 40, request.body.filter.type[0])] }
      };
    if (request.url.endsWith('/persons')) return { json: [] };
    const id = Number(request.url.split('/').at(-1));
    return { json: entry(id, id - 40) };
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 42);
    const duplicateAfter = c.events.length;
    await c.call('scan', { path: duplicateRoot, onlineMatch: true, subjectTypes: [2] });
    await c.idle(duplicateAfter);
    assert.equal((await c.call('get', { id: idFor(duplicate) })).subject_id, 42);
    assert.equal(c.requests.filter((r) => r.body).length, 1);
    const after = c.events.length;
    await c.call('scan', { path: otherRoot, onlineMatch: true, subjectTypes: [4] });
    await c.idle(after);
    assert.equal((await c.call('get', { id: idFor(otherAlbum) })).subject_id, 44);
    assert.deepEqual(
      c.requests.filter((r) => r.body).map((r) => r.body.filter.type),
      [[2], [4]]
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('all-folder frontier processes more than one bounded page without exceeding 64 queued folders', async () => {
  const f = await fixture('Artwork000');
  for (let i = 1; i < 140; i++)
    await fs.mkdir(path.join(f.source, 'Artwork' + String(i).padStart(3, '0')));
  const c = await client(f.data, () => ({ json: { data: [] } }));
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal(c.requests.filter((r) => r.body).length, 140);
    const activity = c.events.filter((event) => event.event === 'online' && event.data.active);
    assert.equal(activity.length, 140);
    assert.ok(activity.every((event) => event.data.buffered <= 63));
    assert.ok(activity.every((event) => event.data.pending === event.data.remaining));
    assert.equal((await c.call('get', { id: f.id })).cover, idFor(f.image));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('normal API clock retains approximately one-second request throttling', async () => {
  const f = await fixture();
  const c = await client(f.data, responder(), { fastClock: false });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    const api = c.requests.filter((request) => request.url.startsWith('https://api.bgm.tv'));
    assert.equal(api.length, 3);
    for (let i = 1; i < api.length; i++) assert.ok(api[i].at - api[i - 1].at >= 1000);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('explicit matching uses own/inherited music and explicit all independently of import policy', async (t) => {
  for (const mode of ['own-music', 'inherited-music', 'global-music', 'explicit-all'])
    await t.test(mode, async () => {
      const f = await fixture();
      const c = await client(f.data, responder(entry(42, 3)));
      try {
        await c.call('settings', { key: 'autoMatch', value: false });
        await c.call('scan', {
          path: f.source,
          ...(mode === 'global-music' ? {} : { onlineMatch: false, subjectTypes: [4] })
        });
        await c.idle();
        if (mode === 'global-music') await c.call('settings', { key: 'categoryType', value: 3 });
        else
          await c.call('patch', {
            id: mode === 'own-music' ? f.id : idFor(f.source),
            changes: { search_type: 3 }
          });
        if (mode === 'explicit-all')
          await c.call('patch', { id: f.id, changes: { search_type: 0 } });
        const matched = await c.call('match', { id: f.id });
        assert.equal(matched.node.subject_id, null);
        assert.equal(matched.candidates[0].id, 42);
        assert.equal(matched.needs_selection, true);
        assert.deepEqual(matched.searchAccess, { tokenPresent: true });
        assert.deepEqual(
          c.requests.find((r) => r.body).body.filter.type,
          mode === 'explicit-all' ? [1, 2, 3, 4, 6] : [3]
        );
        await assert.rejects(
          c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [3] })
        );
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('explicit matching type changes during held search/detail cannot bind stale results', async (t) => {
  for (const held of ['search', 'detail'])
    await t.test(held, async () => {
      const f = await fixture(),
        gate = deferred();
      const c = await client(f.data, async (request) => {
        if (
          (held === 'search' && request.body) ||
          (held === 'detail' && /\/subjects\/42$/.test(request.url))
        )
          await gate.promise;
        return responder(entry(42, 3))(request);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [4] });
        await c.idle();
        await c.call('patch', { id: idFor(f.source), changes: { search_type: 3 } });
        const matching = c
          .call('match', { id: f.id })
          .catch((error) => ({ canceled: error.message }));
        await c.until(() =>
          c.requests.some((r) => (held === 'search' ? !!r.body : /\/subjects\/42$/.test(r.url)))
        );
        await c.call('patch', { id: idFor(f.source), changes: { search_type: 4 } });
        gate.resolve();
        assert.equal(await matching, null);
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, null);
        assert.equal(node.cover, idFor(f.image));
        if (held === 'search')
          assert.equal(
            c.requests.some((r) => /\/subjects\/42$/.test(r.url)),
            false
          );
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('real throttled queued search is canceled before HTTP after disable/remove/inherited photo', async (t) => {
  for (const action of ['disable', 'remove', 'photo'])
    await t.test(action, async () => {
      const f = await fixture();
      const otherRoot = path.join(f.tmp, 'fence-source'),
        otherFolder = path.join(otherRoot, 'Fence Album');
      await fs.mkdir(otherFolder, { recursive: true });
      const c = await client(f.data, () => ({ json: { data: [] } }), { fastClock: false });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        await c.idle();
        await c.call('scan', { path: otherRoot, onlineMatch: false, subjectTypes: [2] });
        await c.call('match', { id: idFor(otherFolder), keyword: 'Throttle primer' });
        const after = c.events.length;
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.until(() =>
          c.events
            .slice(after)
            .some((e) => e.event === 'online' && e.data.active && e.data.id === f.id)
        );
        await c.call('get', { id: f.id });
        if (action === 'disable')
          await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        if (action === 'remove') await c.call('removeRoot', { id: idFor(f.source) });
        if (action === 'photo')
          await c.call('setAlbumKind', { id: idFor(f.source), kind: 'photo' });
        await c.call('match', { id: idFor(otherFolder), keyword: 'Fence check' });
        const searches = c.requests.filter((r) => r.body);
        assert.deepEqual(
          searches.map((r) => r.body.keyword),
          ['Throttle primer', 'Fence check']
        );
        assert.ok(
          searches[1].at - searches[0].at >= 1000,
          'fence crossed the real rate-limit wait'
        );
        const node = await c.call('get', { id: f.id });
        if (action === 'remove') assert.equal(node, null);
        else assert.equal(node.subject_id, null);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('two shared queued consumers retain the live second consumer when the first is canceled', async () => {
  const f = await fixture(path.join('新建文件夹', '月色真美'));
  const second = path.join(f.source, '新建文件夹 (2)', '月色真美');
  await fs.mkdir(second, { recursive: true });
  await fs.writeFile(path.join(second, 'image.png'), f.png);
  const c = await client(
    f.data,
    (request) =>
      request.body?.keyword === 'Throttle primer' ? { json: { data: [] } } : responder()(request),
    { fastClock: false }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [4] });
    await c.idle();
    await c.call('patch', { id: idFor(f.source), changes: { search_type: 2 } });
    await c.call('match', { id: f.id, keyword: 'Throttle primer' });
    const first = c.call('match', { id: f.id }).catch((error) => ({ canceled: error.message }));
    await c.call('get', { id: f.id });
    const live = c.call('match', { id: idFor(second) });
    await c.call('get', { id: idFor(second) });
    await c.call('patch', { id: f.id, changes: { search_type: 4 } });
    await first;
    const result = await live;
    assert.equal(result.candidates[0].id, 42);
    assert.equal(result.node.subject_id, null);
    assert.equal((await c.call('get', { id: idFor(second) })).subject_id, null);
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
    assert.equal(c.requests.filter((r) => r.body?.keyword === '月色真美').length, 1);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('slim English-only alias search hydrates and reuses selected detail once', async () => {
  const f = await fixture('Tsuki ga Kirei');
  const detail = {
    ...entry(),
    name: '月がきれい',
    infobox: [{ key: '别名', value: [{ v: 'Tsuki ga Kirei' }] }]
  };
  const c = await client(f.data, (r) =>
    r.body
      ? { json: { data: [{ id: 42, type: 2, name: '月がきれい', name_cn: '月色真美' }] } }
      : responder(detail)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 42);
    assert.equal(c.requests.filter((r) => /\/subjects\/42$/.test(r.url)).length, 1);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('primary alias hydration deduplicates and caps safe details before deciding on note fallback', async () => {
  const title = 'Moonlit Symphony（月色交响）',
    f = await fixture(title);
  const unrelated = Array.from({ length: 8 }, (_, i) => ({
    id: 100 + i,
    type: 2,
    name: '无关作品' + i
  }));
  const hero = { id: 42, type: 2, name: '月の旋律' };
  const c = await client(f.data, (request) => {
    if (request.body)
      return {
        json: {
          data: /Moonlit/.test(request.body.keyword)
            ? [
                hero,
                ...unrelated.slice(0, 4),
                { id: 77, type: 3, name: 'Moonlit Symphony' },
                { id: Number.MAX_SAFE_INTEGER + 1, type: 2, name: title },
                { id: -1, type: 2, name: title }
              ]
            : unrelated
        }
      };
    if (request.url.endsWith('/persons')) return { json: [] };
    const id = Number(request.url.split('/').at(-1));
    return {
      json:
        id === 42
          ? { ...hero, infobox: [{ key: '别名', value: ['Moonlit Symphony'] }] }
          : unrelated.find((row) => row.id === id)
    };
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 42);
    const details = c.requests.filter((r) => /\/subjects\/\d+$/.test(r.url));
    assert.ok(details.length <= 6);
    assert.ok(details.length > 1);
    assert.equal(details.filter((r) => /\/42$/.test(r.url)).length, 1);
    assert.equal(new Set(details.map((r) => r.url)).size, details.length);
    assert.ok(details.every((r) => !/\/(77|9007199254740992)$/.test(r.url)));
    assert.deepEqual(
      new Set(c.requests.filter((r) => r.body).map((r) => r.body.keyword)),
      new Set(['Moonlit Symphony']),
      'the official primary alias succeeds without searching the bracket note'
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('unrelated, wrong-ID and wrong-category hydrated details never bind', async (t) => {
  for (const mode of ['unrelated', 'wrong-id', 'wrong-type'])
    await t.test(mode, async () => {
      const f = await fixture('Tsuki ga Kirei');
      const detail = {
        ...entry(mode === 'wrong-id' ? 99 : 42, mode === 'wrong-type' ? 4 : 2),
        infobox: [
          {
            key: '别名',
            value: [mode === 'unrelated' ? 'Something Entirely Different' : 'Tsuki ga Kirei']
          }
        ]
      };
      const c = await client(f.data, (r) =>
        r.body
          ? { json: { data: [{ id: 42, type: 2, name: '月がきれい' }] } }
          : responder(detail)(r)
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2, 4] });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, null);
        assert.equal(node.cover, idFor(f.image));
        assert.equal(c.requests.filter((r) => /\/subjects\/\d+$/.test(r.url)).length, 1);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('cached metadata aliases qualify a slim candidate without unrelated detail fanout', async () => {
  const f = await fixture('Tsuki ga Kirei'),
    seed = path.join(f.source, '新建文件夹');
  await fs.mkdir(seed);
  const detail = {
    ...entry(),
    name: '月がきれい',
    infobox: [{ key: '别名', value: ['Tsuki ga Kirei'] }]
  };
  const c = await client(f.data, (r) =>
    r.body
      ? {
          json: {
            data: [
              ...Array.from({ length: 7 }, (_, i) => ({
                id: 100 + i,
                type: 2,
                name: '其他作品' + i
              })),
              { id: 42, type: 2, name: '月がきれい' }
            ]
          }
        }
      : responder(detail)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await c.idle();
    await c.call('patch', { id: f.id, changes: { search_type: 2 } });
    await c.call('bind', { id: idFor(seed), url: '42' });
    const before = c.requests.length;
    const result = await c.call('match', { id: f.id });
    assert.equal(result.candidates[0].id, 42);
    assert.equal(result.node.subject_id, null);
    const details = c.requests.slice(before).filter((r) => /\/subjects\/\d+$/.test(r.url));
    // The independently verified detail from binding the seed album is reused.
    // Unrelated candidates must still cause no detail fanout.
    assert.deepEqual(details, []);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('opt-in skips inherited explicit photo but honors nearer first-level explicit work override', async () => {
  const f = await fixture();
  const descendant = path.join(f.folder, '月色真美 CG');
  await fs.mkdir(descendant);
  const c = await client(f.data, responder());
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2], offline: true });
    await c.idle();
    await c.call('setAlbumKind', { id: idFor(f.source), kind: 'photo' });
    let after = c.events.length;
    await c.call('scan', { path: f.source });
    await c.idle(after);
    assert.equal(c.requests.length, 0);
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
    await c.call('setAlbumKind', { id: f.id, kind: 'work' });
    after = c.events.length;
    await c.call('scan', { path: f.source });
    await c.idle(after);
    assert.equal((await c.call('get', { id: f.id })).subject_id, 42);
    assert.equal((await c.call('get', { id: idFor(descendant) })).subject_id, null);
    assert.deepEqual(
      albumSearches(c).map((request) => request.body.keyword),
      ['月色真美']
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('manual book association survives animation-only reimport with a visible type-mismatch flag', async () => {
  const f = await fixture();
  const c = await client(f.data, responder(entry(100, 1)));
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [1] });
    await c.call('bind', { id: f.id, url: '100' });
    const after = c.events.length;
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle(after);
    const n = await c.call('get', { id: f.id });
    assert.equal(n.subject_id, 100);
    assert.equal(n.manual_subject, 1);
    assert.deepEqual(n.effective_subject_types, [2]);
    assert.equal(n.association_type_mismatch, true);
    assert.equal(c.requests.filter((r) => r.body).length, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('old automatic book is detached and local cover retained if no animation result exists', async () => {
  const f = await fixture();
  let empty = false;
  const c = await client(f.data, (r) =>
    empty && r.body ? { json: { data: [] } } : responder(entry(100, 1))(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [1] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 100);
    empty = true;
    const after = c.events.length;
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle(after);
    const n = await c.call('get', { id: f.id });
    assert.equal(n.subject_id, null);
    assert.equal(n.cover, idFor(f.image));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('automatic matching intersects import types with an explicit album animation choice', async () => {
  const f = await fixture();
  const c = await client(f.data, (r) =>
    r.body ? { json: { data: [entry(100, 1), entry(200, 2)] } } : responder(entry(200, 2))(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [1, 2] });
    await c.call('patch', { id: f.id, changes: { search_type: 2 } });
    const after = c.events.length;
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [1, 2] });
    await c.idle(after);
    assert.equal((await c.call('get', { id: f.id })).subject_id, 200);
    assert.deepEqual(c.requests.find((r) => r.body).body.filter.type, [2]);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('direct binding rejects mismatched ID and a type change while detail is pending', async (t) => {
  for (const mode of ['wrong-id', 'wrong-type', 'string-type', 'type-change'])
    await t.test(mode, async () => {
      const f = await fixture(),
        gate = deferred();
      const c = await client(f.data, async (r) => {
        if (/\/subjects\/42$/.test(r.url)) await gate.promise;
        return responder(
          entry(
            mode === 'wrong-id' ? 99 : 42,
            mode === 'wrong-type' ? 1 : mode === 'string-type' ? '2' : 2
          )
        )(r);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        const binding = c.call('bind', { id: f.id, url: '42' });
        const rejected = assert.rejects(binding, /类型|ID|取消|改变/);
        await c.until(() => c.requests.some((r) => /\/subjects\/42$/.test(r.url)));
        if (mode === 'type-change')
          await c.call('patch', { id: f.id, changes: { search_type: 1 } });
        gate.resolve();
        await rejected;
        assert.equal((await c.call('get', { id: f.id })).subject_id, null);
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('metadata refresh validates ID and strict category and cancels obsolete manual responses', async (t) => {
  for (const mode of ['wrong-id', 'wrong-type', 'string-type', 'type-change'])
    await t.test(mode, async () => {
      const f = await fixture(),
        gate = deferred();
      let refreshing = false;
      const c = await client(f.data, async (r) => {
        if (refreshing && /\/subjects\/42$/.test(r.url)) {
          await gate.promise;
          return {
            json: entry(
              mode === 'wrong-id' ? 99 : 42,
              mode === 'wrong-type' ? 1 : mode === 'string-type' ? '2' : 2
            )
          };
        }
        return responder(entry(42, 2))(r);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        await c.call('bind', { id: f.id, url: '42' });
        refreshing = true;
        const before = c.requests.length;
        const refreshed = c.call('refreshMetadata', { id: f.id });
        const rejected = assert.rejects(refreshed, /类型|ID|取消|改变/);
        await c.until(() => c.requests.slice(before).some((r) => /\/subjects\/42$/.test(r.url)));
        if (mode === 'type-change')
          await c.call('patch', { id: f.id, changes: { search_type: 1 } });
        gate.resolve();
        await rejected;
        const n = await c.call('get', { id: f.id });
        assert.equal(n.subject_id, 42);
        assert.equal(n.manual_subject, 1);
        assert.equal(n.metadata.type, 2);
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('detail reranking follows and independently verifies a replacement winner', async () => {
  const f = await fixture('Moonlit Symphony');
  const a = { ...entry(101), name: 'Moonlit Symphony', collection: { collect: 9999 } };
  const b = {
    ...entry(102),
    name: '月の旋律',
    aliases: ['Moonlit Symphony'],
    collection: { collect: 100 }
  };
  const unrelated = { ...a, name: 'Completely Unrelated', name_cn: '' };
  const c = await client(f.data, (r) =>
    r.body
      ? { json: { total: 2, data: [a, b] } }
      : responder(r.url.includes('/101') ? unrelated : b)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 102);
    const details = c.requests.filter((r) => /\/subjects\/\d+$/.test(r.url));
    assert.deepEqual(
      details.map((r) => Number(r.url.split('/').at(-1))),
      [101, 102]
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('canonical Pokemon beyond the old eight-result cutoff binds and leads typed candidates', async () => {
  const f = await fixture('宝可梦');
  const original = {
    ...entry(3019, 2),
    name: 'ポケットモンスター',
    name_cn: '宝可梦',
    date: '1997-04-01',
    collection: { collect: 8511 }
  };
  const rows = [
    entry(99, 4),
    ...Array.from({ length: 8 }, (_, i) => ({
      ...entry(i + 100),
      name: `宝可梦 衍生篇${i}`,
      name_cn: ''
    })),
    original,
    ...Array.from({ length: 10 }, (_, i) => ({ ...entry(i + 200), name: `其他作品${i}` }))
  ];
  const c = await client(f.data, (r) =>
    r.body ? { json: { total: 194, limit: 20, offset: 0, data: rows } } : responder(original)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 3019);
    assert.equal(c.requests.filter((r) => r.body).length, 1);
    await c.call('bind', { id: f.id, url: '3019' });
    const result = await c.call('match', { id: f.id });
    assert.equal(result.candidates[0].id, 3019);
    assert.ok(result.candidates.length <= 10);
    assert.ok(result.candidates.every((s) => s.type === 2));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('a repeated truncated subtitle page cannot establish uniqueness', async () => {
  const f = await fixture('16bit的感动');
  const anime = {
    ...entry(413741, 2),
    name: '16bit的感动 ANOTHER LAYER',
    collection: { collect: 10206 }
  };
  const c = await client(f.data, (r) =>
    r.body ? { json: { total: 2, limit: 1, offset: 0, data: [anime] } } : responder(anime)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
    assert.equal((await c.call('match', { id: f.id })).needs_selection, true);
    assert.ok(c.requests.filter((r) => r.body).length <= 6);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('detail verification retains other candidates when an exact search title becomes a subtitle', async () => {
  const f = await fixture('16bit的感动');
  const search = { ...entry(413741, 2), name: '16bit的感动' };
  const anime = { ...search, name: '16bit的感动 ANOTHER LAYER', collection: { collect: 10206 } };
  const other = { ...entry(777, 2), name: '其他作品' };
  const c = await client(f.data, (r) =>
    r.body
      ? { json: { total: 2, data: [search, other] } }
      : responder(r.url.includes('/777') ? other : anime)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
    const result = await c.call('match', { id: f.id });
    assert.equal(result.needs_selection, true);
    assert.ok(result.candidates.some((s) => s.id === 777));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('sub85 subtitle import stays unbound while manual matching remains animation-only', async () => {
  const f = await fixture('16bit的感动');
  const book = { ...entry(314759, 1), name: '16bitセンセーション', name_cn: '16bit的感动' };
  const anime = {
    ...entry(413741, 2),
    name: '16bitセンセーション ANOTHER LAYER',
    name_cn: '16bit的感动 ANOTHER LAYER',
    infobox: [
      {
        key: '别名',
        value: [
          { v: '16位元的輝煌 Another Layer' },
          { v: '16bit Sensation: Another Layer' },
          { v: '16位的辉煌 Another Layer' }
        ]
      }
    ],
    collection: { collect: 10206 }
  };
  const c = await client(f.data, (r) =>
    r.body
      ? { json: { data: [book, anime] } }
      : responder(r.url.includes('/314759') ? book : anime)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    const automatic = await c.call('get', { id: f.id });
    assert.equal(automatic.subject_id, null);
    assert.equal(automatic.match_review, 0);
    const manual = await c.call('match', { id: f.id });
    assert.equal(manual.node.subject_id, null);
    assert.equal(manual.candidates[0].id, 413741);
    assert.ok(manual.candidates[0].match < 0.85);
    assert.equal(manual.needs_selection, true);
    await c.call('bind', { id: f.id, url: '413741' });
    const bound = await c.call('get', { id: f.id });
    assert.equal(bound.metadata.type, 2);
    assert.equal(bound.manual_subject, 1);
    assert.ok(
      c.requests.filter((r) => r.body).every((r) => JSON.stringify(r.body.filter.type) === '[2]')
    );
    assert.ok(!c.requests.some((r) => /\/subjects\/314759/.test(r.url)));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('a nearer animation override remains eligible beneath a root type conflicting with import policy', async () => {
  const f = await fixture();
  const c = await client(f.data, responder(entry(200, 2)));
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await c.call('patch', { id: idFor(f.source), changes: { search_type: 1 } });
    await c.call('patch', { id: f.id, changes: { search_type: 2 } });
    const after = c.events.length;
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle(after);
    assert.equal((await c.call('get', { id: f.id })).subject_id, 200);
    assert.ok(
      c.requests
        .filter((r) => r.body)
        .every((r) => r.body.filter.type.length === 1 && r.body.filter.type[0] === 2)
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('inherited manual lookup and direct binding obey animation-only import policy', async () => {
  const f = await fixture('16bit的感动');
  const anime = { ...entry(200, 2), name: '16bit的感动', name_cn: '16bit的感动' };
  const book = { ...anime, id: 100, type: 1 };
  const c = await client(f.data, (r) =>
    r.body ? { json: { data: [book, anime] } } : responder(r.url.endsWith('/100') ? book : anime)(r)
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await c.idle();
    const result = await c.call('match', { id: f.id });
    assert.equal(result.candidates[0].id, anime.id);
    assert.equal(result.node.subject_id, null);
    assert.deepEqual(c.requests.find((r) => r.body).body.filter.type, [2]);
    await c.call('bind', { id: f.id, url: String(anime.id) });
    await assert.rejects(c.call('bind', { id: f.id, url: '100' }), /类型/);
    assert.equal((await c.call('get', { id: f.id })).subject_id, anime.id);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('reimport repairs old automatic book association but preserves manual cover and favorite', async () => {
  const f = await fixture('16bit的感动');
  let selected = { ...entry(100, 1), name: '16bit的感动', name_cn: '16bit的感动' };
  const c = await client(f.data, (r) => responder(selected)(r));
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [1] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, 100);
    await c.call('setCover', { id: f.id, imageId: idFor(f.image) });
    await c.call('patch', { id: f.id, changes: { favorite: 1, crop_x: 35, crop_y: 65 } });
    selected = { ...selected, id: 200, type: 2 };
    const after = c.events.length;
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle(after);
    const n = await c.call('get', { id: f.id });
    assert.equal(n.subject_id, 200);
    assert.equal(n.metadata.type, 2);
    assert.equal(n.cover, idFor(f.image));
    assert.equal(n.manual_cover, 1);
    assert.equal(n.favorite, 1);
    assert.equal(n.crop_x, 35);
    assert.equal(n.crop_y, 65);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('manual exact searches preserve fresh and bound albums, covers, annotations and metadata files', async (t) => {
  for (const state of ['fresh', 'automatic', 'manual'])
    await t.test(state, async () => {
      const f = await fixture();
      const old = { ...entry(100, 1), images: { large: 'https://lain.bgm.tv/old.png' } };
      const main = { ...entry(), images: { large: 'https://lain.bgm.tv/new.png' } };
      let searching = false;
      const c = await client(f.data, (r) => {
        if (!searching) return responder(old, f.png)(r);
        if (r.body)
          return {
            json: {
              total: 200,
              data:
                r.body.sort === 'heat'
                  ? [entry(99)]
                  : [
                      main,
                      ...Array.from({ length: 19 }, (_, i) => ({
                        ...entry(200 + i),
                        name: '其他作品' + i,
                        name_cn: ''
                      }))
                    ]
            }
          };
        return responder(main, f.png)(r);
      });
      try {
        await c.call('scan', {
          path: f.source,
          onlineMatch: state === 'automatic',
          subjectTypes: [1]
        });
        await c.idle();
        if (state === 'manual') await c.call('bind', { id: f.id, url: '100' });
        await c.call('patch', {
          id: f.id,
          changes: { search_type: 2, favorite: 1, intro: 0, crop_x: 31, crop_y: 69 }
        });
        const before = await c.call('get', { id: f.id });
        const filesBefore = await fs.readdir(path.join(f.data, 'metadata'));
        const coversBefore = await fs.readdir(path.join(f.data, 'covers'));
        const changed = c.events.filter((e) => e.event === 'changed').length;
        const start = c.requests.length;
        searching = true;
        const result = await c.call('match', { id: f.id });
        assert.deepEqual(result.node, before);
        assert.deepEqual(await c.call('get', { id: f.id }), before);
        assert.equal(result.needs_selection, true);
        assert.deepEqual(result.searchAccess, { tokenPresent: true });
        assert.equal(result.candidates[0].id, 42);
        assert.equal(result.candidates.length, 10);
        assert.ok(
          result.candidates.some((s) => s.id === 99),
          'popularity alternatives survive an exact title'
        );
        assert.ok(result.candidates.every((s) => s.type === 2));
        const requests = c.requests.slice(start);
        assert.equal(requests.filter((r) => r.body).length, 3);
        assert.ok(requests.filter((r) => /\/subjects\/\d+$/.test(r.url)).length <= 6);
        assert.ok(
          !requests.some(
            (r) => r.url.endsWith('/persons') || r.url.startsWith('https://lain.bgm.tv')
          )
        );
        assert.ok(
          requests.filter((r) => r.body).every((r) => !Object.hasOwn(r.body.filter, 'nsfw'))
        );
        assert.deepEqual(await fs.readdir(path.join(f.data, 'metadata')), filesBefore);
        assert.deepEqual(await fs.readdir(path.join(f.data, 'covers')), coversBefore);
        assert.equal(c.events.filter((e) => e.event === 'changed').length, changed);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('manual recall stays separate while raw API cache is reused within one Token scope', async () => {
  const f = await fixture();
  const c = await client(f.data, responder());
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal(c.requests.filter((r) => r.body).length, 1);
    const manual = await c.call('match', { id: f.id });
    assert.equal(manual.candidates[0].id, 42);
    assert.equal(c.requests.filter((r) => r.body).length, 1);
    const before = c.requests.length;
    await c.call('match', { id: f.id });
    assert.equal(c.requests.length, before);
    await c.call('token', { value: '' });
    const anonymous = await c.call('match', { id: f.id });
    assert.deepEqual(anonymous.searchAccess, { tokenPresent: false });
    assert.equal(c.requests.filter((r) => r.body).length, 2);
    assert.equal(c.requests.at(-1).authorized, false);
    await c.call('token', { value: 'replacement-test-token' });
    const authorized = await c.call('match', { id: f.id });
    assert.deepEqual(authorized.searchAccess, { tokenPresent: true });
    assert.equal(c.requests.filter((r) => r.body).length, 3);
    assert.equal(c.requests.at(-1).authorized, true);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('Token changes discard held manual search and detail responses and their inflight cache entries', async (t) => {
  for (const held of ['search', 'detail'])
    await t.test(held, async () => {
      const f = await fixture(),
        gate = deferred();
      let first = true;
      const c = await client(f.data, async (r) => {
        if (first && (held === 'search' ? !!r.body : /\/subjects\/42$/.test(r.url))) {
          first = false;
          await gate.promise;
        }
        return responder()(r);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        await c.idle();
        const obsolete = c.call('match', { id: f.id });
        await c.until(() =>
          c.requests.some((r) => (held === 'search' ? !!r.body : /\/subjects\/42$/.test(r.url)))
        );
        await c.call('token', { value: '' });
        const fresh = c.call('match', { id: f.id });
        assert.equal(await obsolete, null);
        const result = await fresh;
        gate.resolve();
        assert.equal(result.node.subject_id, null);
        assert.equal(result.candidates[0].id, 42);
        assert.deepEqual(result.searchAccess, { tokenPresent: false });
        assert.equal(c.requests.filter((r) => r.body).length, 2);
        assert.ok(c.requests.filter((r) => /\/subjects\/42$/.test(r.url)).length <= 2);
        assert.equal(c.requests.at(-1).authorized, false);
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('Token changes preserve active and queued automatic albums under the new access generation', async (t) => {
  for (const held of ['search', 'detail'])
    for (const value of ['replacement-test-token', ''])
      await t.test(`${held}: ${value ? 'replace' : 'remove'}`, async () => {
        const f = await fixture(),
          gate = deferred();
        const subjects = ['月色真美', '四月是你的谎言', '紫罗兰永恒花园'].map((name, i) => ({
          ...entry(100 + i),
          name,
          name_cn: name
        }));
        const albums = subjects.map((subject) => ({
          subject,
          folder: path.join(f.source, subject.name),
          id: idFor(path.join(f.source, subject.name))
        }));
        for (const album of albums.slice(1)) {
          await fs.mkdir(album.folder);
          await fs.writeFile(path.join(album.folder, 'image.png'), f.png);
        }
        const stale = subjects.map((subject) => ({ ...subject, id: subject.id + 1000 }));
        const c = await client(f.data, async (r) => {
          if (r.url.endsWith('/persons')) return { json: [] };
          if (r.body) {
            const index = subjects.findIndex((subject) => subject.name === r.body.keyword);
            assert.notEqual(index, -1);
            if (r.originalAccess && held === 'search') await gate.promise;
            return {
              json: { total: 1, data: [r.originalAccess ? stale[index] : subjects[index]] }
            };
          }
          if (r.originalAccess && held === 'detail') await gate.promise;
          return {
            json: [...subjects, ...stale].find((subject) => r.url.endsWith('/' + subject.id))
          };
        });
        try {
          await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
          await c.until(() =>
            c.requests.some((r) => (held === 'search' ? !!r.body : /\/subjects\/\d+$/.test(r.url)))
          );
          const active = c.events
            .filter((event) => event.event === 'online' && event.data.active)
            .at(-1);
          assert.ok(albums.some((album) => album.id === active.data.id));
          assert.equal(
            active.data.buffered,
            2,
            'two eligible albums are already beyond the frontier'
          );
          const after = c.events.length,
            requestStart = c.requests.length;
          await c.call('token', { value });
          await c.idle(after);
          for (const album of albums) {
            const node = await c.call('get', { id: album.id });
            assert.equal(
              node.subject_id,
              album.subject.id,
              'active and queued work must all finish'
            );
            assert.equal(node.manual_subject, 0);
          }
          const fresh = c.requests.slice(requestStart);
          assert.equal(fresh.filter((r) => r.body).length, 3);
          assert.ok(fresh.every((r) => !r.originalAccess && r.authorized === !!value));
          assert.equal(
            c.events.filter(
              (event) =>
                event.event === 'online' && event.data.id === active.data.id && event.data.active
            ).length,
            2,
            'the previously active album is retried exactly once'
          );
          gate.resolve();
          for (const album of albums)
            assert.equal((await c.call('get', { id: album.id })).subject_id, album.subject.id);
          assert.equal((await fs.stat(f.image)).mtimeMs, 1700000000000);
          assert.deepEqual(await fs.readFile(f.image), f.png);
        } finally {
          gate.resolve();
          await c.close();
          await cleanup(f);
        }
      });
});

test('Token replacement never revives invalidated active or queued automatic jobs', async (t) => {
  for (const action of ['cancel', 'remove', 'disable', 'type', 'valid-type', 'manual', 'photo'])
    await t.test(action, async () => {
      const f = await fixture(),
        gate = deferred(),
        queuedFolder = path.join(f.source, '月色真美 [1080p]');
      await fs.mkdir(queuedFolder, { recursive: true });
      await fs.writeFile(path.join(queuedFolder, 'image.png'), f.png);
      const ids = [f.id, idFor(queuedFolder)],
        automatic =
          action === 'manual'
            ? { ...entry(), images: { large: 'https://lain.bgm.tv/held-token-guard.png' } }
            : entry();
      const c = await client(f.data, async (r) => {
        if (r.url.startsWith('https://lain.bgm.tv')) {
          await gate.promise;
          return { bytes: [...f.png] };
        }
        if (r.url.endsWith('/persons')) return { json: [] };
        if (r.body) return { json: { total: 1, data: [automatic] } };
        if (action !== 'manual' && /\/subjects\/42$/.test(r.url)) await gate.promise;
        return { json: r.url.endsWith('/99') ? entry(99) : automatic };
      });
      try {
        if (action === 'valid-type') {
          await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2, 4] });
          await c.call('patch', { id: idFor(f.source), changes: { search_type: 2 } });
        }
        await c.call('scan', {
          path: f.source,
          onlineMatch: true,
          subjectTypes: action === 'valid-type' ? [2, 4] : [2]
        });
        await c.until(() =>
          c.requests.some((r) =>
            action === 'manual'
              ? r.url.startsWith('https://lain.bgm.tv')
              : /\/subjects\/42$/.test(r.url)
          )
        );
        assert.equal(
          c.events.filter((event) => event.event === 'online' && event.data.active).at(-1).data
            .buffered,
          1
        );
        const after = c.events.length;
        if (action === 'cancel') await c.call('cancel');
        if (action === 'remove') await c.call('removeRoot', { id: idFor(f.source) });
        if (action === 'disable')
          await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        if (action === 'type' || action === 'valid-type')
          await c.call('patch', { id: idFor(f.source), changes: { search_type: 4 } });
        if (action === 'manual') for (const id of ids) await c.call('bind', { id, url: '99' });
        if (action === 'photo')
          await c.call('setAlbumKind', { id: idFor(f.source), kind: 'photo' });
        const requestStart = c.requests.length;
        await c.call('token', { value: 'replacement-test-token' });
        await c.until(() =>
          c.events
            .slice(after)
            .some(
              (event) =>
                event.event === 'online' &&
                !event.data.active &&
                !event.data.pending &&
                !event.data.discovering
            )
        );
        gate.resolve();
        for (const id of ids) {
          const node = await c.call('get', { id });
          if (action === 'remove') assert.equal(node, null);
          else {
            assert.equal(node.subject_id, action === 'manual' ? 99 : null);
            assert.equal(node.manual_subject, action === 'manual' ? 1 : 0);
          }
        }
        assert.equal(c.requests.length, requestStart, 'no invalidated work may restart');
        assert.deepEqual(await fs.readFile(f.image), f.png);
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('malformed Token commands reject safely and preserve the previous credential', async () => {
  const f = await fixture();
  const c = await client(f.data, (r) => responder(entry())(r));
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await assert.rejects(c.call('token', { value: 'synthetic\nprivate' }), /格式无效/);
    assert.equal(c.requests.length, 0);
    await c.call('match', { id: f.id });
    assert.ok(c.requests.length > 0);
    assert.ok(c.requests.every((r) => r.originalAccess));
    assert.ok(!JSON.stringify(c.events).includes('synthetic'));
  } finally {
    await c.close();
    await cleanup(f);
  }
});
test('malformed boot Token never reaches fetch or plaintext RPC logs', async () => {
  const f = await fixture();
  const c = await client(
    f.data,
    () => {
      throw new Error('unexpected fetch');
    },
    { token: 'synthetic\nprivate' }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await assert.rejects(c.call('match', { id: f.id }), /格式无效/);
    assert.equal(c.requests.length, 0);
    assert.ok(!JSON.stringify(c.events).includes('synthetic'));
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
  } finally {
    await c.close();
    await cleanup(f);
  }
});
test('network header errors cannot echo a synthetic credential through worker RPC or log events', async () => {
  const f = await fixture();
  const c = await client(f.data, () => {
    throw new Error('Headers.append: "Bearer isolated-test-token" is an invalid header value.');
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await assert.rejects(c.call('match', { id: f.id }), /请检查 Access Token/);
    assert.equal(c.requests.length, 1, 'credential/header failures must not retry');
    assert.ok(!JSON.stringify(c.events).includes('isolated-test-token'));
  } finally {
    await c.close();
    await cleanup(f);
  }
});
test('manual access-denied errors are actionable, generic and never retry or disclose response secrets', async (t) => {
  for (const status of [401, 403])
    await t.test(String(status), async () => {
      const f = await fixture();
      const c = await client(f.data, () => ({
        status,
        json: { error: 'secret server response isolated-test-token' }
      }));
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        await c.idle();
        await assert.rejects(c.call('match', { id: f.id }), (error) => {
          assert.equal(
            error.message,
            'Access Token 无效、已过期或权限不足，请在作品简介设置中更新后重试'
          );
          assert.ok(!error.message.includes('isolated-test-token'));
          return true;
        });
        assert.equal(c.requests.length, 1);
        assert.equal((await c.call('get', { id: f.id })).subject_id, null);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('anonymous all-type manual lookup keeps safe alternatives and caps details at six', async () => {
  const f = await fixture('Unknown English Title');
  const types = [1, 2, 3, 4, 6];
  const subjects = Array.from({ length: 20 }, (_, i) => ({
    id: i + 100,
    type: types[i % types.length],
    name: '其他作品' + i
  }));
  const c = await client(
    f.data,
    (r) =>
      r.body
        ? { json: { total: 20, data: [...subjects, { id: -1, type: 2, name: 'invalid' }] } }
        : { json: subjects.find((s) => r.url.endsWith('/' + s.id)) },
    { token: '' }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
    await c.idle();
    await c.call('patch', { id: f.id, changes: { search_type: 0 } });
    const result = await c.call('match', { id: f.id });
    assert.equal(result.node.subject_id, null);
    assert.equal(result.needs_selection, true);
    assert.deepEqual(result.searchAccess, { tokenPresent: false });
    assert.equal(result.candidates.length, 10);
    assert.deepEqual([...new Set(result.candidates.map((s) => s.type))].sort(), types);
    assert.ok(result.candidates.every((s) => Number.isSafeInteger(s.id) && s.id > 0));
    assert.equal(c.requests.filter((r) => /\/subjects\/\d+$/.test(r.url)).length, 6);
    assert.deepEqual(c.requests.find((r) => r.body).body.filter, { type: types });
    assert.ok(c.requests.every((r) => !r.authorized));
    assert.deepEqual(await fs.readdir(path.join(f.data, 'metadata')), []);
    assert.deepEqual(await fs.readdir(path.join(f.data, 'covers')), []);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('manual cancellation and removal return null without saving held details', async (t) => {
  for (const action of ['cancel', 'remove'])
    await t.test(action, async () => {
      const f = await fixture(),
        gate = deferred();
      const c = await client(f.data, async (r) => {
        if (/\/subjects\/42$/.test(r.url)) await gate.promise;
        return responder()(r);
      });
      try {
        await c.call('scan', { path: f.source, onlineMatch: false, subjectTypes: [2] });
        await c.idle();
        const pending = c.call('match', { id: f.id });
        await c.until(() => c.requests.some((r) => /\/subjects\/42$/.test(r.url)));
        if (action === 'cancel') await c.call('cancel');
        else await c.call('removeRoot', { id: idFor(f.source) });
        gate.resolve();
        assert.equal(await pending, null);
        assert.deepEqual(await fs.readdir(path.join(f.data, 'metadata')), []);
        assert.deepEqual(await fs.readdir(path.join(f.data, 'covers')), []);
      } finally {
        gate.resolve();
        await c.close();
        await cleanup(f);
      }
    });
});

test('ancestor explicit photo set during held detail prevents automatic binding', async () => {
  const f = await fixture(),
    gate = deferred();
  const c = await client(f.data, async (request) => {
    if (/\/subjects\/42$/.test(request.url)) await gate.promise;
    return responder()(request);
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.until(() => c.requests.some((r) => /\/subjects\/42$/.test(r.url)));
    await c.call('setAlbumKind', { id: idFor(f.source), kind: 'photo' });
    gate.resolve();
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, null);
    assert.equal(node.cover, idFor(f.image));
  } finally {
    gate.resolve();
    await c.close();
    await cleanup(f);
  }
});

// Opt-in scans may also search the fixture's source root. These assertions concern
// only the album lookup; every new fixture uses anonymous, intercepted HTTP.
const albumSearches = (c) => c.requests.filter((r) => r.body && r.body.keyword !== 'source');
const subjectDetails = (c) => c.requests.filter((r) => /\/v0\/subjects\/\d+$/.test(r.url));

test('single-language and interleaved titles search their complete identity without fragments', async (t) => {
  for (const title of [
    '雾海来信',
    'Silver Meadow',
    'ほしぞらの手紙',
    '雾海Silver Meadow来信',
    'ほしぞらSilver Meadowの手紙',
    'ほしぞら-Silver Meadow-の手紙'
  ])
    await t.test(title, async () => {
      const f = await fixture(title);
      const subject = { id: 801, type: 2, name: title };
      const c = await client(
        f.data,
        (r) =>
          r.body && r.body.keyword !== title ? { json: { data: [] } } : responder(subject)(r),
        { token: '' }
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle();
        assert.equal((await c.call('get', { id: f.id })).subject_id, subject.id);
        assert.deepEqual(
          albumSearches(c).map((r) => r.body.keyword),
          [title]
        );
        assert.equal(subjectDetails(c).length, 1);
        assert.ok(c.requests.every((r) => !r.authorized));
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('complete Chinese-English title pairs require independent retrieval and official identity for both parts', async (t) => {
  const chinese = '雾海来信',
    english = 'Silver Meadow';
  const subject = { id: 801, type: 2, name: english, name_cn: chinese };
  const conflicting = { id: 803, type: 2, name: chinese };
  for (const mode of ['verified', 'missing-query', 'detail-contradiction', 'conflict'])
    await t.test(mode, async () => {
      const f = await fixture(chinese + english);
      const c = await client(
        f.data,
        (r) => {
          if (r.body) {
            const word = r.body.keyword;
            const data =
              word === english
                ? [subject]
                : word === chinese && mode !== 'missing-query'
                  ? [mode === 'conflict' ? conflicting : subject]
                  : [];
            return { json: { total: data.length, data } };
          }
          return responder(
            r.url.endsWith('/803')
              ? conflicting
              : mode === 'detail-contradiction'
                ? { ...subject, name_cn: '' }
                : subject
          )(r);
        },
        { token: '' }
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle();
        assert.equal(
          (await c.call('get', { id: f.id })).subject_id,
          mode === 'verified' ? subject.id : null
        );
        const words = albumSearches(c).map((r) => r.body.keyword);
        assert.ok(words.includes(chinese));
        assert.ok(words.includes(english));
        assert.ok(words.every((word) => [chinese + english, chinese, english].includes(word)));
        assert.ok(subjectDetails(c).length <= 6);
        if (mode === 'verified' || mode === 'detail-contradiction')
          assert.equal(subjectDetails(c).filter((r) => r.url.endsWith('/801')).length, 1);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('verified main exact title ignores an unrelated meaningful bracket note in automatic and manual lookup', async (t) => {
  const main = '雾海来信',
    note = 'Silver Meadow';
  const subject = { id: 801, type: 2, name: main };
  for (const mode of ['automatic', 'manual'])
    await t.test(mode, async () => {
      const f = await fixture(`${main} [${note}]`);
      const c = await client(
        f.data,
        (r) =>
          r.body && r.body.keyword !== main
            ? { json: { data: r.body.keyword === note ? [{ id: 802, type: 2, name: note }] : [] } }
            : responder(subject)(r),
        { token: '' }
      );
      try {
        await c.call('scan', {
          path: f.source,
          onlineMatch: mode === 'automatic',
          subjectTypes: [2]
        });
        await c.idle();
        const before = await c.call('get', { id: f.id });
        assert.equal(before.subject_id, mode === 'automatic' ? subject.id : null);
        const result = await c.call('match', { id: f.id });
        assert.equal(result.needs_selection, true);
        assert.equal(result.candidates[0].id, subject.id);
        assert.deepEqual(result.node, before);
        assert.deepEqual(new Set(albumSearches(c).map((r) => r.body.keyword)), new Set([main]));
        assert.ok(subjectDetails(c).some((r) => r.url.endsWith('/801')));
        assert.ok(!c.requests.some((r) => r.url.endsWith('/802')));
        assert.ok(c.requests.every((r) => !r.authorized));
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('empty, low-score and contradicted main titles defer to an officially validated bracket fallback', async (t) => {
  const main = '雾海来信',
    note = 'Silver Meadow';
  const fallback = { id: 802, type: 2, name: note };
  for (const mode of ['empty', 'low-score', 'false-exact'])
    await t.test(mode, async () => {
      const f = await fixture(`${main} [${note}]`);
      const weakDetail = { id: 801, type: 2, name: '遥远钟楼' };
      const c = await client(
        f.data,
        (r) => {
          if (r.body) {
            const data =
              r.body.keyword === note
                ? [fallback]
                : r.body.keyword === main && mode !== 'empty'
                  ? [{ ...weakDetail, name: mode === 'false-exact' ? main : weakDetail.name }]
                  : [];
            return { json: { total: data.length, data } };
          }
          return responder(r.url.endsWith('/801') ? weakDetail : fallback)(r);
        },
        { token: '' }
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, fallback.id);
        assert.equal(node.metadata.name, note);
        assert.deepEqual(
          albumSearches(c).map((r) => r.body.keyword),
          [main, note]
        );
        assert.equal(subjectDetails(c).filter((r) => r.url.endsWith('/802')).length, 1);
        if (mode !== 'empty') {
          const mainDetail = c.requests.findIndex((r) => r.url.endsWith('/801'));
          const fallbackSearch = c.requests.findIndex((r) => r.body?.keyword === note);
          assert.ok(
            mainDetail >= 0 && mainDetail < fallbackSearch,
            'official main detail must be checked before the fallback search'
          );
        }
        assert.ok(subjectDetails(c).length <= 6);
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('import resolves close primary candidates while manual matching keeps alternatives and blocks bracket fallback', async () => {
  const main = '雾海之畔寄来的最后一封信',
    note = 'Silver Meadow';
  const f = await fixture(`${main} [${note}]`);
  const subjects = [801, 803].map((id, index) => ({
    id,
    type: 2,
    name: main.slice(0, -1) + ['笺', '札'][index],
    collection: { collect: index === 0 ? 950 : 1000 },
    date: index === 0 ? '2024-01-01' : '2020-01-01'
  }));
  const c = await client(
    f.data,
    (r) => {
      if (r.body) return { json: { total: 2, data: r.body.keyword === main ? subjects : [] } };
      return responder(subjects.find((s) => r.url.endsWith('/' + s.id)) || subjects[0])(r);
    },
    { token: '' }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    const node = await c.call('get', { id: f.id });
    assert.equal(node.subject_id, 801);
    assert.equal(node.match_review, 0);
    const result = await c.call('match', { id: f.id });
    assert.equal(result.node.subject_id, 801);
    assert.equal(result.needs_selection, true);
    assert.deepEqual(new Set(result.candidates.map((s) => s.id)), new Set([801, 803]));
    assert.deepEqual(new Set(albumSearches(c).map((r) => r.body.keyword)), new Set([main]));
    assert.deepEqual(
      new Set(subjectDetails(c).map((r) => Number(r.url.split('/').at(-1)))),
      new Set([801, 803])
    );
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('numeric, CG and 4K bracket notes never become fallback searches after an empty main', async () => {
  const main = '雾海来信';
  const f = await fixture(`${main} [12345] (CG)【4K】`);
  const c = await client(f.data, () => ({ json: { data: [] } }), { token: '' });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, null);
    await c.call('match', { id: f.id });
    assert.deepEqual(new Set(albumSearches(c).map((r) => r.body.keyword)), new Set([main]));
    assert.equal(subjectDetails(c).length, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('a bracket-only meaningful title can automatically bind its independently checked detail', async () => {
  const title = 'Silver Meadow';
  const f = await fixture(`[${title}]`);
  const subject = { id: 802, type: 2, name: title };
  const c = await client(
    f.data,
    (r) => (r.body && r.body.keyword !== title ? { json: { data: [] } } : responder(subject)(r)),
    { token: '' }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, subject.id);
    assert.deepEqual(
      albumSearches(c).map((r) => r.body.keyword),
      [title]
    );
    assert.equal(subjectDetails(c).length, 1);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('fallback search identities cannot override unrelated, wrong-ID or wrong-type official details', async (t) => {
  const main = '雾海来信',
    note = 'Silver Meadow';
  const search = { id: 802, type: 2, name: note };
  for (const mode of ['unrelated', 'wrong-id', 'wrong-type'])
    await t.test(mode, async () => {
      const f = await fixture(`${main} [${note}]`);
      const detail = {
        ...search,
        id: mode === 'wrong-id' ? 899 : search.id,
        type: mode === 'wrong-type' ? 4 : 2,
        name: mode === 'unrelated' ? 'Unrelated Clock Tower' : note
      };
      const c = await client(
        f.data,
        (r) =>
          r.body
            ? { json: { data: r.body.keyword === note ? [search] : [] } }
            : responder(detail)(r),
        { token: '' }
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, null);
        assert.equal(node.cover, idFor(f.image));
        assert.deepEqual(
          albumSearches(c).map((r) => r.body.keyword),
          [main, note]
        );
        assert.equal(subjectDetails(c).length, 1);
        assert.ok(subjectDetails(c)[0].url.endsWith('/802'));
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('many weak main candidates reserve detail capacity for each fallback within six unique requests', async () => {
  const main = '雾海来信',
    firstNote = 'Silver Meadow',
    finalNote = 'ほしぞらの手紙';
  const f = await fixture(`${main} [${firstNote}] [${finalNote}]`);
  const mainRows = Array.from({ length: 12 }, (_, i) => ({
    id: 810 + i,
    type: 2,
    name: '遥远钟楼' + i
  }));
  const noteRows = Array.from({ length: 12 }, (_, i) => ({
    id: 830 + i,
    type: 2,
    name: '夜空の旅' + i
  }));
  const winner = { id: 802, type: 2, name: finalNote };
  const c = await client(
    f.data,
    (r) => {
      if (r.body) {
        const data =
          r.body.keyword === main
            ? mainRows
            : r.body.keyword === firstNote
              ? [mainRows[0], ...noteRows]
              : r.body.keyword === finalNote
                ? [winner]
                : [];
        return { json: { total: data.length, data } };
      }
      return responder(
        [...mainRows, ...noteRows, winner].find((s) => r.url.endsWith('/' + s.id)) || winner
      )(r);
    },
    { token: '' }
  );
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    assert.equal((await c.call('get', { id: f.id })).subject_id, winner.id);
    assert.deepEqual(
      albumSearches(c).map((r) => r.body.keyword),
      [main, firstNote, finalNote]
    );
    const details = subjectDetails(c);
    const ids = details.map((r) => Number(r.url.split('/').at(-1)));
    assert.equal(details.length, 6);
    assert.equal(new Set(ids).size, details.length, 'detail hydration must be unique across plans');
    assert.equal(
      ids.filter((id) => id === mainRows[0].id).length,
      1,
      'a candidate repeated by a fallback reuses its main-plan detail'
    );
    assert.ok(ids.some((id) => mainRows.some((s) => s.id === id)));
    assert.ok(ids.some((id) => noteRows.some((s) => s.id === id)));
    assert.equal(ids.filter((id) => id === winner.id).length, 1);
    assert.ok(c.requests.every((r) => !r.authorized));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('deduplicated and capped fallback queries preserve independent bilingual identity requirements', async (t) => {
  for (const mode of ['missing-main-evidence', 'reuse-main-evidence', 'query-cap'])
    await t.test(mode, async () => {
      const main = '雾海来信';
      const english =
        mode === 'query-cap' ? 'Silver Meadow Across the Endless Summer Horizon' : 'Silver Meadow';
      const whole = `${main} ${english}`;
      const title =
        mode === 'query-cap'
          ? `主作品名称 (Alpha) (Bravo) (Charlie) (Delta) (${whole})`
          : `${main} (${whole})`;
      const f = await fixture(title);
      const subject = {
        id: 802,
        type: 2,
        name: english,
        ...(mode === 'reuse-main-evidence' ? { name_cn: main } : {})
      };
      const weak = Array.from({ length: 5 }, (_, i) => ({
        id: 810 + i,
        type: 2,
        name: '遥远钟楼'
      }));
      const c = await client(
        f.data,
        (r) => {
          if (r.body) {
            let data = [];
            if (mode === 'query-cap' && r.body.keyword === whole) data = [subject];
            if (mode !== 'query-cap' && r.body.keyword === english) data = [subject];
            if (mode === 'reuse-main-evidence' && r.body.keyword === main)
              data = [...weak, { ...subject, name: '遥远钟楼', name_cn: '' }];
            return { json: { total: data.length, data } };
          }
          return responder(weak.find((s) => r.url.endsWith('/' + s.id)) || subject)(r);
        },
        { token: '' }
      );
      try {
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle();
        const node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, mode === 'reuse-main-evidence' ? subject.id : null);
        const searches = albumSearches(c).map((r) => r.body.keyword);
        assert.equal(new Set(searches).size, searches.length);
        assert.ok(searches.length <= 6);
        assert.ok(subjectDetails(c).length <= 6);
        if (mode === 'query-cap') {
          assert.equal(searches.length, 6);
          assert.ok(!searches.includes(english));
        } else assert.deepEqual(searches, [main, whole, english]);
        if (mode !== 'reuse-main-evidence') {
          const result = await c.call('match', { id: f.id });
          assert.equal(result.node.subject_id, null);
          assert.equal(result.needs_selection, true);
          assert.ok(result.candidates.some((s) => s.id === subject.id));
        } else {
          const details = subjectDetails(c);
          assert.equal(
            details.filter((request) => request.url.endsWith('/' + subject.id)).length,
            1,
            'the independently verified bilingual candidate is hydrated once across stages'
          );
          assert.ok(
            details.some((request) => weak.some((row) => request.url.endsWith('/' + row.id))),
            'the primary stage still hydrates its independent weak candidates before fallback'
          );
        }
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});

test('import exact association is silent and remains silent after resource refresh and restart', async () => {
  const f = await fixture();
  const subject = { ...entry(), images: { large: 'https://lain.bgm.tv/test-cover.png' } };
  let c = await client(f.data, responder(subject, f.png), { token: '' });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    let node = await c.call('get', { id: f.id });
    assert.equal(node.match_confidence, 1);
    assert.equal(node.match_review, 0);
    assert.equal(node.confirmed, 1);
    assert.equal(node.cover_source, 'bangumi');
    await c.call('resetCover', { id: f.id });
    assert.equal((await c.call('get', { id: f.id })).confirmed, 1);
    await c.call('refreshMetadata', { id: f.id });
    await c.close();
    c = await client(f.data, responder(subject, f.png), { token: '' });
    node = await c.call('get', { id: f.id });
    assert.equal(node.match_confidence, 1);
    assert.equal(node.match_review, 0);
    assert.equal(node.confirmed, 1);
    assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((n) => n.id === f.id));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('exact match stays confirmed through fallback changes, reset, later Bangumi cover and manual cover refresh', async () => {
  const f = await fixture();
  let subject = entry();
  const c = await client(f.data, (request) => responder(subject, f.png)(request), { token: '' });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    let node = await c.call('get', { id: f.id });
    assert.equal(node.match_confidence, 1);
    assert.equal(node.cover_source, 'fallback');
    assert.equal(node.confirmed, 1);
    const later = path.join(f.folder, 'newest.png');
    await fs.writeFile(later, f.png);
    await fs.utimes(later, 1900000000, 1900000000);
    await c.call('scan', { path: f.source });
    node = await c.call('get', { id: f.id });
    assert.equal(node.cover, idFor(later));
    assert.equal(node.confirmed, 1);
    await c.call('resetCover', { id: f.id });
    assert.equal((await c.call('get', { id: f.id })).confirmed, 1);
    subject = { ...entry(), images: { large: 'https://lain.bgm.tv/later-cover.png' } };
    await c.call('refreshMetadata', { id: f.id });
    node = await c.call('get', { id: f.id });
    assert.equal(node.cover_source, 'bangumi');
    assert.equal(node.confirmed, 1);
    assert.equal(node.match_review, 0);
    await c.call('setCover', { id: f.id, imageId: idFor(f.image) });
    await c.call('patch', { id: f.id, changes: { confirmed: 0, crop_x: 37 } });
    await c.call('refreshMetadata', { id: f.id });
    node = await c.call('get', { id: f.id });
    assert.equal(node.manual_cover, 1);
    assert.equal(node.cover, idFor(f.image));
    assert.equal(node.crop_x, 37);
    assert.equal(node.confirmed, 0);
    assert.equal(node.match_review, 0);
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('nonexact matched identity stays confirmed through fallback changes, downloaded cover and restart while unassociated fallback stays pending', async () => {
  const chars = Array.from({ length: 230 }, (_, i) => String.fromCodePoint(0x5000 + i));
  const title = chars.slice(0, 25).join('');
  let subject = {
    id: 420,
    type: 2,
    name: chars.slice(0, 21).join('') + chars.slice(200, 203).join('')
  };
  const f = await fixture(title);
  const controlFolder = path.join(f.source, 'Unmatched Local Pictures');
  await fs.mkdir(controlFolder);
  await fs.writeFile(path.join(controlFolder, 'local.png'), f.png);
  let c = await client(f.data, (request) => responder(subject, f.png)(request), { token: '' });
  try {
    await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
    await c.idle();
    let node = await c.call('get', { id: f.id });
    assert.equal(node.match_confidence, 40 / 47);
    assert.equal(node.match_review, 0);
    assert.equal(node.cover_source, 'fallback');
    const later = path.join(f.folder, 'newest.png');
    await fs.writeFile(later, f.png);
    await fs.utimes(later, 1900000000, 1900000000);
    await c.call('scan', { path: f.source });
    node = await c.call('get', { id: f.id });
    assert.equal(node.cover, idFor(later));
    assert.equal(node.match_review, 0);
    assert.equal(node.confirmed, 1);
    subject = { ...subject, images: { large: 'https://lain.bgm.tv/uncertain-cover.png' } };
    await c.call('refreshMetadata', { id: f.id });
    node = await c.call('get', { id: f.id });
    assert.equal(node.cover_source, 'bangumi');
    assert.equal(node.match_review, 0);
    assert.equal(node.match_confidence, 40 / 47);
    assert.equal(node.confirmed, 1);
    assert.ok(c.requests.some((request) => request.url === subject.images.large));
    await c.call('resetCover', { id: f.id });
    await c.close();
    c = await client(f.data, (request) => responder(subject, f.png)(request), { token: '' });
    node = await c.call('get', { id: f.id });
    assert.equal(node.match_review, 0);
    assert.equal(node.confirmed, 1);
    assert.equal(node.match_confidence, 40 / 47);
    const control = await c.call('get', { id: idFor(controlFolder) });
    assert.equal(control.subject_id, null);
    assert.equal(control.character_id, null);
    assert.equal(control.cover_source, 'fallback');
    assert.equal(control.confirmed, 0);
    assert.equal(control.match_review, 0);
    const pending = (await c.call('list', { filter: 'pending' })).items;
    assert.ok(!pending.some((item) => item.id === f.id));
    assert.ok(pending.some((item) => item.id === control.id));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('85.1-percent identity keeps manual cover and crop confirmation through refresh and restart without identity review', async (t) => {
  for (const resolution of ['confirm', 'bind'])
    await t.test(resolution, async () => {
      const chars = Array.from({ length: 230 }, (_, i) => String.fromCodePoint(0x5000 + i));
      const title = chars.slice(0, 25).join('');
      const subject = {
        id: 420,
        type: 2,
        name: chars.slice(0, 21).join('') + chars.slice(200, 203).join('')
      };
      const f = await fixture(title);
      let c = await client(f.data, responder(subject, f.png), { token: '' });
      try {
        await c.call('scan', { path: f.source, offline: true });
        await c.call('setCover', { id: f.id, imageId: idFor(f.image) });
        await c.call('patch', {
          id: f.id,
          changes: { confirmed: 0, crop_x: 35, crop_y: 65, crop_zoom: 1.5 }
        });
        const start = c.events.length;
        await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2] });
        await c.idle(start);
        let node = await c.call('get', { id: f.id });
        assert.equal(node.subject_id, 420);
        assert.equal(node.match_confidence, 40 / 47);
        assert.equal(node.match_review, 0);
        assert.equal(node.manual_cover, 1);
        assert.equal(node.cover, idFor(f.image));
        assert.deepEqual([node.crop_x, node.crop_y, node.crop_zoom], [35, 65, 1.5]);
        assert.equal(node.confirmed, 0);
        assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((n) => n.id === f.id));
        // An explicit cover confirmation takes priority through refresh and restart.
        await c.call('patch', { id: f.id, changes: { confirmed: 1, crop_x: 36 } });
        await c.call('refreshMetadata', { id: f.id });
        await c.close();
        c = await client(f.data, responder(subject, f.png), { token: '' });
        node = await c.call('get', { id: f.id });
        assert.equal(node.match_review, 0);
        assert.equal(node.match_confidence, 40 / 47);
        assert.equal(node.confirmed, 1);
        assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((n) => n.id === f.id));
        if (resolution === 'confirm')
          await c.call('patch', { id: f.id, changes: { match_review: 0, confirmed: 1 } });
        else await c.call('bind', { id: f.id, url: '420' });
        node = await c.call('get', { id: f.id });
        assert.equal(node.match_review, 0);
        assert.equal(node.confirmed, 1);
        assert.equal(node.manual_cover, 1);
        assert.deepEqual([node.crop_x, node.crop_y, node.crop_zoom], [36, 65, 1.5]);
        assert.ok(!(await c.call('list', { filter: 'pending' })).items.some((n) => n.id === f.id));
      } finally {
        await c.close();
        await cleanup(f);
      }
    });
});
