'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');

async function client(dataDir, respond) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const pending = new Map(); let serial = 0, ticks = 0;
    const realNow = Date.now; Date.now = () => realNow() + (++ticks * 2000);
    workerData.mock.on('message', ({ seq, response }) => {
      const item = pending.get(seq); if (!item) return;
      pending.delete(seq); item.cleanup();
      const status = response.status || 200;
      item.resolve({ status, ok: status >= 200 && status < 300,
        headers: new Headers(response.headers || {}), json: async () => response.json,
        arrayBuffer: async () => Uint8Array.from(response.bytes || []).buffer });
    });
    global.fetch = (url, options = {}) => new Promise((resolve, reject) => {
      const seq = ++serial, signal = options.signal;
      const abort = () => { pending.delete(seq); reject(signal.reason); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(seq, { resolve, reject, cleanup });
      workerData.mock.postMessage({ seq, url: String(url), body: options.body ? JSON.parse(options.body) : null });
    });
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        token: 'fixture-token',
        mock: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  let serial = 0,
    closed = false;
  const pending = new Map(),
    events = [],
    requests = [],
    observers = new Set();
  const notify = () => {
    for (const fn of observers) fn();
  };
  port1.on('message', async (request) => {
    requests.push(request);
    notify();
    const response = await respond(request);
    if (!closed) port1.postMessage({ seq: request.seq, response });
  });
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event) {
        events.push(m);
        notify();
      }
      const item = pending.get(m.request);
      if (!item) return;
      pending.delete(m.request);
      clearTimeout(item.timer);
      m.error ? item.reject(new Error(m.error)) : item.resolve(m.result);
    });
  });
  const c = {
    events,
    requests,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++serial,
          timer = setTimeout(() => reject(new Error('RPC timeout: ' + method)), 12000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observers.delete(check);
          reject(new Error('worker event timeout'));
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
    idle(after) {
      return c.until(() => events.slice(after).some((m) => m.event === 'online' && !m.data.active));
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
async function fixture(t, top = '月色真美') {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-folder-policy-'));
  const f = { tmp, source: path.join(tmp, 'source'), data: path.join(tmp, 'data') };
  f.folder = path.join(f.source, top);
  await fs.mkdir(f.folder, { recursive: true });
  f.png = await sharp({ create: { width: 8, height: 12, channels: 3, background: '#abcded' } })
    .png()
    .toBuffer();
  t.after(async () => {
    await f.client?.close();
    assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('acg-folder-policy-'));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return f;
}
const entry = (id, name, extra = {}) => ({
  id,
  type: 2,
  name,
  summary: 'summary ' + id,
  collection: { collect: 1000 },
  date: '2020-01-01',
  images: { large: `https://lain.bgm.tv/fixture-${id}.png` },
  ...extra
});
function responder(subjects, png) {
  return ({ url, body }) => {
    if (url.includes('/search/')) {
      const data = subjects.filter((s) => s.name === body.keyword);
      return { json: { data, total: data.length } };
    }
    if (url.endsWith('/persons')) return { json: [] };
    if (url.startsWith('https://lain.bgm.tv/')) return { bytes: [...png] };
    const id = Number(url.match(/\/subjects\/(\d+)/)?.[1]);
    return { json: subjects.find((s) => s.id === id) };
  };
}
async function importRoot(c, f, extra = {}) {
  const first = c.events.length;
  await c.call('scan', {
    path: f.source,
    onlineMatch: true,
    subjectTypes: [2],
    directoryKind: 'work',
    ...extra
  });
  await c.idle(first);
}

test('automatic import binds only direct first-level work albums while nested manual bindings survive refresh', async (t) => {
  const f = await fixture(t),
    child = path.join(f.folder, '装甲核心6'),
    deep = path.join(child, 'ForbiddenDeep');
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(f.folder, '1.png'), f.png);
  const subjects = [entry(42, '月色真美'), entry(43, '装甲核心6')];
  const c = (f.client = await client(f.data, responder(subjects, f.png)));
  await importRoot(c, f);
  assert.equal((await c.call('get', { id: idFor(f.folder) })).subject_id, 42);
  assert.equal((await c.call('get', { id: idFor(child) })).subject_id, null);
  assert.equal((await c.call('get', { id: idFor(deep) })).subject_id, null);
  assert.deepEqual(
    c.requests.filter((r) => r.body).map((r) => r.body.keyword),
    ['月色真美']
  );
  assert.ok(
    c.events.some(
      (m) => m.event === 'changed' && m.data.id === idFor(f.folder) && m.data.matching === true
    )
  );
  const marker = c.events.length;
  const bound = await c.call('bind', { id: idFor(child), url: '43' });
  assert.equal(bound.manual_subject, 1);
  assert.ok(
    c.events
      .slice(marker)
      .some((m) => m.event === 'changed' && m.data.id === bound.id && !m.data.matching)
  );
  const refresh = c.events.length;
  await c.call('refreshMetadata', { id: idFor(f.folder) });
  assert.ok(
    c.events
      .slice(refresh)
      .some((m) => m.event === 'changed' && m.data.id === idFor(f.folder) && !m.data.matching),
    'explicit refresh remains immediate for an automatic association'
  );
  await importRoot(c, f);
  assert.equal((await c.call('get', { id: idFor(child) })).subject_id, 43);
  assert.equal((await c.call('get', { id: idFor(child) })).manual_subject, 1);
});

test('series fallback compares at most four immediate child names and binds only the parent by popularity and newest date', async (t) => {
  const f = await fixture(t, '未能识别的机甲作品集');
  const subjects = [];
  for (let i = 1; i <= 6; i++) {
    const child = path.join(f.folder, `装甲核心${i}`);
    await fs.mkdir(path.join(child, 'ForbiddenDeep'), { recursive: true });
    subjects.push(
      entry(100 + i, `装甲核心${i}`, {
        collection: { collect: i === 2 ? 950 : i === 3 ? 899 : 1000 },
        date: i === 2 ? '2024-01-01' : i === 3 ? '2025-01-01' : '2000-01-01'
      })
    );
  }
  const c = (f.client = await client(f.data, responder(subjects, f.png)));
  await importRoot(c, f);
  const parent = await c.call('get', { id: idFor(f.folder) });
  assert.equal(parent.subject_id, 102, 'recent work in the inclusive 90% popularity cohort wins');
  assert.equal(parent.metadata.summary, 'summary 102');
  assert.equal(parent.cover_source, 'bangumi');
  assert.equal(parent.cover, 'subject:102');
  const queries = [...new Set(c.requests.filter((r) => r.body).map((r) => r.body.keyword))];
  assert.deepEqual(
    queries.filter((name) => name.startsWith('装甲核心')),
    ['装甲核心1', '装甲核心2', '装甲核心3', '装甲核心4']
  );
  assert.ok(!queries.includes('ForbiddenDeep'));
  for (let i = 1; i <= 6; i++)
    assert.equal(
      (await c.call('get', { id: idFor(path.join(f.folder, `装甲核心${i}`)) })).subject_id,
      null
    );
});

test('generic first-level work collections use at most four child names and bind only the parent', async (t) => {
  for (const name of ['合集', 'CG'])
    await t.test(name, async (t) => {
      const f = await fixture(t, name);
      await fs.mkdir(path.join(f.source, '图片'));
      const subjects = [];
      for (let number = 6; number <= 11; number++) {
        await fs.mkdir(path.join(f.folder, `装甲核心${number}`, 'ForbiddenDeep'), {
          recursive: true
        });
        subjects.push(
          entry(500 + number, `装甲核心${number}`, {
            type: 4,
            date: number === 6 ? '2024-01-01' : number > 9 ? '2025-01-01' : '2000-01-01'
          })
        );
      }
      const c = (f.client = await client(f.data, responder(subjects, f.png)));
      await importRoot(c, f, { subjectTypes: [4] });
      const parent = await c.call('get', { id: idFor(f.folder) });
      assert.equal(parent.subject_id, 506);
      assert.equal(parent.metadata.summary, 'summary 506');
      assert.equal(parent.cover_source, 'bangumi');
      assert.equal(parent.cover, 'subject:506');
      assert.deepEqual(
        c.requests.filter((r) => r.body).map((r) => r.body.keyword),
        ['装甲核心6', '装甲核心7', '装甲核心8', '装甲核心9']
      );
      assert.equal((await c.call('get', { id: idFor(f.source) })).subject_id, null);
      assert.equal(
        (await c.call('get', { id: idFor(path.join(f.source, '图片')) })).subject_id,
        null
      );
      for (let number = 6; number <= 11; number++) {
        const child = path.join(f.folder, `装甲核心${number}`);
        assert.equal((await c.call('get', { id: idFor(child) })).subject_id, null);
        assert.equal(
          (await c.call('get', { id: idFor(path.join(child, 'ForbiddenDeep')) })).subject_id,
          null
        );
      }
      assert.deepEqual(
        [
          ...new Set(
            c.events.filter((e) => e.event === 'online' && e.data.active).map((e) => e.data.id)
          )
        ],
        [parent.id]
      );
    });
});

test('unmatched work uses the natural first image instead of the newest and never probes grandchildren', async (t) => {
  const f = await fixture(t, 'UnmatchedWorkCollection');
  const deep = path.join(f.folder, 'ChildAlbum', 'ForbiddenDeep');
  await fs.mkdir(deep, { recursive: true });
  for (const [name, when] of [
    ['10.png', 1700000000],
    ['2.png', 1600000000]
  ]) {
    const file = path.join(f.folder, name);
    await fs.writeFile(file, f.png);
    await fs.utimes(file, when, when);
  }
  const c = (f.client = await client(f.data, () => ({ json: { data: [], total: 0 } })));
  await importRoot(c, f);
  const parent = await c.call('get', { id: idFor(f.folder) });
  assert.equal(parent.subject_id, null);
  assert.equal(parent.cover, idFor(path.join(f.folder, '2.png')));
  assert.equal(parent.cover_source, 'fallback');
  assert.ok(!c.requests.some((r) => r.body?.keyword === 'ForbiddenDeep'));
});

test('high confidence original bilingual name stops before split terms or child-name fallback', async (t) => {
  const name = '天选庶民的真命之选セレクトオブリージュ',
    f = await fixture(t, name);
  await fs.mkdir(path.join(f.folder, 'NeverSearchThis'));
  const c = (f.client = await client(f.data, responder([entry(77, name)], f.png)));
  await importRoot(c, f);
  assert.equal((await c.call('get', { id: idFor(f.folder) })).subject_id, 77);
  assert.deepEqual(
    c.requests.filter((r) => r.body).map((r) => r.body.keyword),
    [name]
  );
});

test('character root policies also restrict automatic identity to first-level albums', async (t) => {
  const f = await fixture(t, '初音ミク'),
    nested = path.join(f.folder, '巡音ルカ');
  await fs.mkdir(nested);
  const character = { id: 88, name: '初音ミク', summary: 'fixture character' };
  const c = (f.client = await client(f.data, ({ url, body }) => {
    if (url.includes('/search/characters'))
      return {
        json: {
          data: body.keyword === character.name ? [character] : [],
          total: body.keyword === character.name ? 1 : 0
        }
      };
    return { json: character };
  }));
  await importRoot(c, f, { directoryKind: 'character', characterCover: 'local-first' });
  assert.equal((await c.call('get', { id: idFor(f.folder) })).character_id, 88);
  assert.equal((await c.call('get', { id: idFor(nested) })).character_id, null);
  assert.deepEqual(
    c.requests.filter((r) => r.body).map((r) => r.body.keyword),
    ['初音ミク']
  );
});
