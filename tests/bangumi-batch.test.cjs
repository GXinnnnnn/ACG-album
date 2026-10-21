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

// Benchmark kind: mock. No network, credentials, profiles or application data.
// Date.now has no read side effects: only actual throttle waits and explicit
// control-port advances move time. A 1000-request run advances about 18 minutes,
// safely inside the six-hour negative-result TTL, even after a restart.
const CLOCK_START = 1800000000000;
const TIMEOUT = 15000;
const SCALE_TIMEOUT = 120000;
const HOLD = Symbol('withhold mocked response');
const IMPORT = { onlineMatch: true, subjectTypes: [2] };
const empty = () => ({ json: { data: [], total: 0 } });

async function client(
  dataDir,
  respond = empty,
  { now = CLOCK_START, timeout = TIMEOUT, token = 'fake-batch-access-a' } = {}
) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const { workerData } = require('node:worker_threads');
    const mock = workerData.mockPort, pending = new Map();
    let sequence = 0, clock = workerData.now;
    Date.now = () => clock;
    require('node:timers/promises').setTimeout = async (delay, value, options = {}) => {
      options.signal?.throwIfAborted();
      clock += Math.max(0, Number(delay) || 0);
      await new Promise(resolve => setImmediate(resolve));
      options.signal?.throwIfAborted();
      return value;
    };
    const originalAuthorization = 'Bearer ' + workerData.token;
    mock.on('message', message => {
      if (message.control) {
        clock += message.advance || 0;
        mock.postMessage({ control: message.control, now: clock });
        return;
      }
      const { seq, response } = message;
      const item = pending.get(seq);
      if (!item) return;
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
      const abort = () => { pending.delete(seq); cleanup(); reject(signal.reason); };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(seq, { resolve, reject, cleanup });
      mock.postMessage({ seq, url: String(url), body: options.body ? JSON.parse(options.body) : null,
        authorized: !!options.headers?.Authorization,
        originalAccess: options.headers?.Authorization === originalAuthorization,
        now: clock });
    });
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        token,
        now,
        mockPort: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  let next = 0,
    closed = false;
  const pending = new Map(),
    controls = new Map(),
    events = [],
    requests = [],
    observers = new Set();
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const readyTimer = setTimeout(() => readyReject(new Error('Worker startup timed out')), timeout);
  const notify = () => {
    for (const fn of observers) fn();
  };
  worker.on('error', (error) => {
    readyReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  worker.on('message', (message) => {
    if (message.event === 'ready') {
      clearTimeout(readyTimer);
      readyResolve();
    }
    if (message.event) {
      events.push(message);
      notify();
    }
    if (message.request && pending.has(message.request)) {
      const item = pending.get(message.request);
      pending.delete(message.request);
      clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
    }
  });
  port1.on('message', async (request) => {
    if (request.control) {
      const item = controls.get(request.control);
      if (item) {
        controls.delete(request.control);
        clearTimeout(item.timer);
        item.resolve(request.now);
      }
      return;
    }
    requests.push(request);
    notify();
    let response;
    try {
      response = await respond(request);
    } catch (error) {
      response = { failure: error.message };
    }
    if (!closed && response !== HOLD) port1.postMessage({ seq: request.seq, response });
  });
  const c = {
    events,
    requests,
    call(method, args = {}) {
      const request = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: ' + method));
        }, timeout);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    clock(advance = 0) {
      const control = ++next;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          controls.delete(control);
          reject(new Error('Clock control timed out'));
        }, timeout);
        controls.set(control, { resolve, reject, timer });
        port1.postMessage({ control, advance });
      });
    },
    until(predicate, description = 'worker event') {
      if (predicate()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observers.delete(check);
          reject(new Error('Timed out waiting for ' + description));
        }, timeout);
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
    async done(after = 0) {
      // Token changes can emit an idle event just before a new sync is queued.
      // Confirm the current durable state after the command has acknowledged.
      for (;;) {
        await c.until(
          () =>
            events
              .slice(after)
              .some(
                ({ event, data }) =>
                  event === 'online' &&
                  !data.active &&
                  data.pending === 0 &&
                  !data.discovering &&
                  data.paused === ''
              ),
          'completed durable queue'
        );
        const nextAfter = events.length;
        const state = await c.call('syncStatus');
        if (!state.active && state.pending === 0 && !state.discovering && state.paused === '')
          return;
        after = nextAfter;
      }
    },
    paused(reason, after = 0) {
      return c.until(
        () =>
          events
            .slice(after)
            .some(
              ({ event, data }) => event === 'online' && !data.active && data.paused === reason
            ),
        reason + ' pause'
      );
    },
    async terminate() {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      port1.close();
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(new Error('Mock worker terminated'));
      }
      pending.clear();
      await worker.terminate();
    },
    async close() {
      if (closed) return;
      try {
        await c.call('shutdown');
      } finally {
        await c.terminate();
      }
    }
  };
  try {
    await ready;
    return c;
  } catch (error) {
    await c.terminate();
    throw error;
  }
}

async function fixture(count = 1, { repeated = false, images = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-bangumi-batch-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(source);
  const png = images
    ? await sharp({ create: { width: 40, height: 60, channels: 3, background: '#c49cab' } })
        .png()
        .toBuffer()
    : null;
  const folders = [];
  for (let i = 0; i < count; i++) {
    const folder = repeated
      ? path.join(source, '新建文件夹 (' + i + ')', '月色真美')
      : path.join(source, 'Artwork' + String(i).padStart(4, '0'));
    await fs.mkdir(folder, { recursive: true });
    if (png) await fs.writeFile(path.join(folder, 'local.png'), png);
    folders.push(folder);
  }
  return { tmp, source, data, folders, png };
}
async function cleanup(f) {
  const resolved = path.resolve(f.tmp);
  assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith('acg-bangumi-batch-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
function database(f, fn) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function durable(f) {
  return database(f, (db) => ({
    pending: db.prepare('SELECT id,root FROM match_pending ORDER BY id').all(),
    frontier: db.prepare('SELECT root,after_id FROM match_frontier').all(),
    resume: db
      .prepare('SELECT reason,retry_at,scope,failures FROM match_resume WHERE singleton=1')
      .get()
  }));
}
function assertClean(status) {
  const { completed, total, ...rest } = status;
  assert.equal(typeof completed, 'number');
  assert.equal(total, completed);
  assert.deepEqual(rest, {
    pending: 0,
    remaining: 0,
    buffered: 0,
    discovering: false,
    paused: '',
    retryAt: 0,
    active: false
  });
}
function searches(c) {
  return c.requests.filter((r) => r.body);
}
function counts(requests) {
  return {
    search: requests.filter((r) => r.body).length,
    detail: requests.filter((r) => /\/v0\/subjects\/\d+$/.test(r.url)).length,
    persons: requests.filter((r) => r.url.endsWith('/persons')).length,
    cover: requests.filter((r) => r.url.startsWith('https://lain.bgm.tv/')).length
  };
}
const subject = () => ({
  id: 42,
  type: 2,
  name: '月色真美',
  name_cn: '月色真美',
  images: { large: 'https://lain.bgm.tv/fake-batch-cover.png' }
});
function metadataResponder(png, { brokenCover = false } = {}) {
  return (r) =>
    r.body
      ? { json: { data: [subject()], total: 1 } }
      : r.url.endsWith('/persons')
        ? { json: [] }
        : r.url.startsWith('https://lain.bgm.tv/')
          ? { bytes: brokenCover ? [0, 1, 2] : [...png] }
          : { json: subject() };
}
async function resync(c) {
  const after = c.events.length;
  await c.call('sync');
  await c.done(after);
}

test('queued manual and automatic searches reuse a newly cached raw response before another throttle wait', async (t) => {
  const f = await fixture();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const c = await client(f.data, async (request) => {
    if (request.seq === 1) await held;
    return empty();
  });
  try {
    await c.call('scan', { path: f.source, ...IMPORT });
    await c.until(() => c.requests.length === 1, 'held automatic search');
    const id = idFor(f.folders[0]);
    const manual = c.call('match', { id });
    // The following acknowledged command is a worker-side barrier: the manual
    // request has entered api() while the automatic response is still held.
    await c.call('get', { id });
    release();
    const result = await manual;
    await c.done();
    assert.equal(result.needs_selection, true);
    assert.deepEqual(result.candidates, []);
    t.diagnostic(
      JSON.stringify({
        benchmarkKind: 'mock',
        concurrentLookups: 2,
        httpRequests: c.requests.length,
        throttleWaitMs: (await c.clock()) - CLOCK_START
      })
    );
    assert.equal(searches(c).length, 1, 'the queued request must reread the raw cache');
    assert.equal(await c.clock(), CLOCK_START, 'cache reuse consumes no 1050-ms API slot');
    assert.equal((await c.call('get', { id })).subject_id, null);
    assertClean(await c.call('syncStatus'));
  } finally {
    release();
    await c.close();
    await cleanup(f);
  }
});

test('queued forced metadata refreshes bypass newly filled raw cache and keep API spacing', async () => {
  const f = await fixture();
  let release,
    holdNext = false;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const c = await client(f.data, async (request) => {
    if (/\/subjects\/42$/.test(request.url)) {
      if (holdNext) {
        holdNext = false;
        await held;
      }
      return { json: { id: 42, type: 2, name: '月色真美' } };
    }
    return { json: [] };
  });
  try {
    await c.call('scan', { path: f.source, onlineMatch: false });
    const id = idFor(f.folders[0]);
    await c.call('bind', { id, url: 'https://bgm.tv/subject/42' });
    const before = c.requests.length;
    holdNext = true;
    const first = c.call('refreshMetadata', { id });
    await c.until(() => c.requests.length > before, 'held forced refresh');
    const second = c.call('refreshMetadata', { id });
    await c.call('get', { id });
    release();
    const refreshed = await Promise.all([first, second]);
    assert.ok(refreshed.every((node) => node.subject_id === 42));
    assert.deepEqual(counts(c.requests.slice(before)), {
      search: 0,
      detail: 2,
      persons: 2,
      cover: 0
    });
    for (let i = 1; i < c.requests.length; i++)
      assert.ok(c.requests[i].now - c.requests[i - 1].now >= 1050);
  } finally {
    release();
    await c.close();
    await cleanup(f);
  }
});

test(
  'mock benchmark: 1000 empty Artwork folders finish through a bounded 64-job queue',
  { timeout: SCALE_TIMEOUT },
  async (t) => {
    const f = await fixture(1000);
    const c = await client(f.data, empty, { timeout: SCALE_TIMEOUT });
    const started = performance.now();
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done();
      assert.equal(searches(c).length, 1000);
      assert.equal(new Set(searches(c).map((r) => r.body.keyword)).size, 1000);
      const activity = c.events.filter(
        (e) => e.event === 'online' && e.data.active && !e.data.error
      );
      assert.equal(new Set(activity.map((e) => e.data.id)).size, 1000);
      assert.ok(
        activity.every((e) => e.data.buffered <= 63 && e.data.remaining <= 64),
        'durable remaining includes active and the page never exceeds 64'
      );
      assert.equal((await c.call('syncStatus')).completed, 1000);
      const statuses = c.events.filter((e) => e.event === 'online').map((e) => e.data);
      assert.ok(statuses.some((s) => s.remaining === 1 && s.completed === 999));
      assert.ok(statuses.some((s) => s.remaining === 0 && s.completed === 1000));
      for (let i = 0; i < statuses.length; i++) {
        const s = statuses[i];
        assert.equal(s.total, s.completed + s.remaining);
        assert.equal(s.pending, s.remaining);
        if (i) assert.ok(s.completed >= statuses[i - 1].completed);
      }
      for (const e of activity) {
        assert.equal(typeof e.data.discovering, 'boolean');
        assert.equal(typeof e.data.paused, 'string');
        assert.equal(typeof e.data.retryAt, 'number');
      }
      for (let i = 1; i < c.requests.length; i++)
        assert.ok(
          c.requests[i].now - c.requests[i - 1].now >= 1050,
          'API throttle remains at least 1050 ms'
        );
      assert.ok((await c.clock()) - CLOCK_START < 6 * 60 * 60 * 1000);
      assertClean(await c.call('syncStatus'));
      assert.equal(durable(f).pending.length, 0);
      assert.equal(durable(f).frontier.length, 0);
      t.diagnostic(
        JSON.stringify({
          benchmarkKind: 'mock',
          albums: 1000,
          requests: c.requests.length,
          milliseconds: Math.round(performance.now() - started),
          maxQueued: Math.max(...activity.map((e) => e.data.pending))
        })
      );
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'first 401 or 403 pauses all pages and token replacement resumes every saved job',
  { timeout: SCALE_TIMEOUT },
  async (t) => {
    for (const code of [401, 403])
      await t.test(String(code), { timeout: SCALE_TIMEOUT }, async () => {
        const f = await fixture(140);
        let c = await client(f.data, (r) =>
          r.originalAccess ? { status: code, json: {} } : empty()
        );
        const previousRequests = [];
        try {
          await c.call('scan', { path: f.source, ...IMPORT });
          await c.paused('access');
          assert.equal(c.requests.length, 1, 'no next-page access storm');
          const state = await c.call('syncStatus');
          assert.equal(state.paused, 'access');
          assert.equal(state.completed, 0);
          assert.equal(state.total, state.remaining);
          assert.ok(state.pending > 0);
          const saved = durable(f);
          const activeId = c.events.find((e) => e.event === 'online' && e.data.active).data.id;
          assert.ok(
            saved.pending.some((n) => n.id === activeId),
            'denied active job remains durable'
          );
          assert.equal(saved.resume.reason, 'access');
          assert.match(saved.resume.scope, /^[a-f0-9]{64}$/);
          await c.call('sync');
          assert.equal(c.requests.length, 1, 'sync does not bypass access pause');
          if (code === 401) {
            previousRequests.push(...c.requests);
            const now = await c.clock();
            await c.close();
            c = await client(f.data, empty, { now });
            await c.paused('access');
            assert.equal(c.requests.length, 0, 'restart preserves access pause');
            assert.ok(durable(f).pending.some((n) => n.id === activeId));
          }
          const after = c.events.length;
          await c.call('token', { value: 'fake-batch-access-b' });
          await c.done(after);
          assert.equal([...previousRequests, ...searches(c)].length, 141);
          assert.equal(
            new Set(
              searches(c)
                .filter((r) => !r.originalAccess)
                .map((r) => r.body.keyword)
            ).size,
            140
          );
          assertClean(await c.call('syncStatus'));
          assert.equal((await c.call('syncStatus')).completed, 140);
          assert.equal(durable(f).pending.length, 0);
        } finally {
          await c.close();
          await cleanup(f);
        }
      });
  }
);

test(
  'numeric and HTTP-date Retry-After persist pause across shutdown and restart',
  { timeout: SCALE_TIMEOUT },
  async (t) => {
    for (const format of ['seconds', 'date'])
      await t.test(format, { timeout: SCALE_TIMEOUT }, async () => {
        const f = await fixture(140);
        const retryAfter =
          format === 'seconds' ? '120' : new Date(CLOCK_START + 120000).toUTCString();
        let c = await client(f.data, () => ({
          status: 429,
          headers: { 'retry-after': retryAfter },
          json: {}
        }));
        try {
          await c.call('scan', { path: f.source, ...IMPORT });
          await c.paused('network');
          assert.equal(c.requests.length, 1);
          const state = await c.call('syncStatus'),
            now = await c.clock();
          assert.equal(state.completed, 0);
          assert.equal(state.total, state.remaining);
          assert.ok(state.retryAt >= CLOCK_START + 120000);
          assert.ok(state.pending > 0);
          await c.close();
          const saved = durable(f);
          assert.equal(saved.resume.reason, 'network');
          assert.equal(saved.resume.retry_at, state.retryAt);
          assert.ok(saved.pending.length > 0);
          c = await client(f.data, empty, { now });
          await c.paused('network');
          assert.equal(c.requests.length, 0);
          assert.equal((await c.call('syncStatus')).retryAt, state.retryAt);
          await c.clock(state.retryAt - now + 1);
          await resync(c);
          assert.equal(searches(c).length, 140);
          assertClean(await c.call('syncStatus'));
        } finally {
          await c.close();
          await cleanup(f);
        }
      });
  }
);

test(
  'hard termination mid-page retains active job and acknowledged frontier covers all eligible albums',
  { timeout: SCALE_TIMEOUT },
  async () => {
    const f = await fixture(140);
    let seen = 0,
      c = await client(f.data, () => (++seen === 5 ? HOLD : empty()));
    try {
      await c.call('scan', { path: f.source, ...IMPORT, offline: true });
      await c.call('sync');
      await c.until(() => c.requests.length === 5, 'withheld fifth request');
      const before = [...searches(c)],
        state = durable(f),
        held = before.at(-1);
      const heldFolder = f.folders.find((p) => path.basename(p) === held.body.keyword);
      assert.ok(
        state.pending.some((n) => n.id === idFor(heldFolder)),
        'active request remains durable until terminal acknowledgement'
      );
      assert.equal(state.frontier.length, 1);
      assert.ok(state.frontier[0].after_id, 'page cursor committed before held HTTP');
      const pendingIds = new Set(state.pending.map((n) => n.id));
      for (const folder of f.folders.filter((p) => idFor(p) <= state.frontier[0].after_id)) {
        const terminal = before.slice(0, -1).some((r) => r.body.keyword === path.basename(folder));
        assert.ok(
          terminal || pendingIds.has(idFor(folder)),
          'advanced frontier cannot lose unacknowledged page member'
        );
      }
      const now = await c.clock();
      await c.terminate();
      c = await client(f.data, empty, { now });
      await c.done();
      const all = [...before, ...searches(c)];
      assert.equal(new Set(all.map((r) => r.body.keyword)).size, 140);
      assert.equal(
        searches(c).filter((r) => r.body.keyword === held.body.keyword).length,
        1,
        'held request is replayed'
      );
      assert.equal(
        searches(c).length,
        136,
        'four acknowledged negative results are not requested again'
      );
      assertClean(await c.call('syncStatus'));
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'negative raw search cache survives restart, expires after six hours, and stays token scoped',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(3);
    let c = await client(f.data);
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done();
      assert.equal(searches(c).length, 3);
      const now = await c.clock();
      await c.close();
      database(f, (db) => {
        const rows = db.prepare('SELECT scope,expires_at-inserted_at ttl FROM bangumi_cache').all();
        assert.equal(rows.length, 3);
        assert.ok(
          rows.every((r) => r.ttl === 6 * 60 * 60 * 1000 && /^[a-f0-9]{64}$/.test(r.scope))
        );
      });
      c = await client(f.data, empty, { now });
      await resync(c);
      assert.equal(c.requests.length, 0, 'unchanged restart sync makes zero HTTP requests');
      await c.call('token', { value: 'fake-batch-access-b' });
      await resync(c);
      assert.equal(searches(c).length, 3, 'different access namespace cannot reuse old negatives');
      await c.call('token', { value: 'fake-batch-access-a' });
      await resync(c);
      assert.equal(c.requests.length, 3, 'original namespace remains reusable');
      const expiredNow = await c.clock(6 * 60 * 60 * 1000 + 1);
      await c.close();
      c = await client(f.data, empty, { now: expiredNow });
      await resync(c);
      assert.equal(searches(c).length, 3, 'expired negative results are searched again');
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'same-name albums share search/detail/persons/cover across restart and keep manual artwork and annotations',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(3, { repeated: true, images: true });
    let c = await client(f.data, metadataResponder(f.png));
    try {
      await c.call('scan', { path: f.source, ...IMPORT, offline: true });
      const manualId = idFor(f.folders[0]),
        localId = idFor(path.join(f.folders[0], 'local.png'));
      await c.call('setCover', { id: manualId, imageId: localId });
      await c.call('patch', {
        id: manualId,
        changes: { crop_x: 23, crop_y: 74, crop_zoom: 1.9, favorite: 1, intro: 0 }
      });
      await resync(c);
      assert.deepEqual(counts(c.requests), { search: 1, detail: 1, persons: 1, cover: 1 });
      for (const folder of f.folders)
        assert.equal((await c.call('get', { id: idFor(folder) })).subject_id, 42);
      const checkManual = async () => {
        const n = await c.call('get', { id: manualId });
        assert.deepEqual(
          [n.cover, n.manual_cover, n.crop_x, n.crop_y, n.crop_zoom, n.favorite, n.intro],
          [localId, 1, 23, 74, 1.9, 1, 0]
        );
      };
      await checkManual();
      assert.ok(
        c.requests.filter((r) => r.url.startsWith('https://api.bgm.tv')).every((r) => r.authorized)
      );
      assert.ok(
        c.requests
          .filter((r) => r.url.startsWith('https://lain.bgm.tv'))
          .every((r) => !r.authorized)
      );
      const cover = path.join(f.data, 'covers', '42.webp'),
        coverBefore = await fs.stat(cover);
      const now = await c.clock();
      await c.close();
      database(f, (db) => {
        const rows = db.prepare('SELECT expires_at-inserted_at ttl FROM bangumi_cache').all();
        assert.equal(rows.length, 3);
        assert.ok(rows.every((r) => r.ttl === 7 * 86400000));
      });
      const extra = path.join(f.source, '新建文件夹 (99)', '月色真美');
      await fs.mkdir(extra, { recursive: true });
      await fs.writeFile(path.join(extra, 'local.png'), f.png);
      c = await client(f.data, metadataResponder(f.png), { now });
      const after = c.events.length;
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done(after);
      assert.equal((await c.call('get', { id: idFor(extra) })).subject_id, 42);
      assert.equal(c.requests.length, 0, 'raw cache and valid same-URL cover survive restart');
      assert.equal((await fs.stat(cover)).mtimeMs, coverBefore.mtimeMs);
      await checkManual();
      const refreshBefore = c.requests.length;
      await c.call('refreshMetadata', { id: manualId });
      assert.deepEqual(counts(c.requests.slice(refreshBefore)), {
        search: 0,
        detail: 1,
        persons: 1,
        cover: 1
      });
      await checkManual();
      await c.call('token', { value: 'fake-batch-access-b' });
      const tokenBefore = c.requests.length;
      await c.call('bind', { id: idFor(extra), url: '42' });
      assert.deepEqual(counts(c.requests.slice(tokenBefore)), {
        search: 0,
        detail: 1,
        persons: 1,
        cover: 1
      });
      await checkManual();
      const expiredNow = await c.clock(7 * 86400000 + 1);
      await c.close();
      const expiredExtra = path.join(f.source, '新建文件夹 (100)', '月色真美');
      await fs.mkdir(expiredExtra, { recursive: true });
      c = await client(f.data, metadataResponder(f.png), {
        now: expiredNow,
        token: 'fake-batch-access-b'
      });
      const expiredAfter = c.events.length;
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done(expiredAfter);
      assert.equal((await c.call('get', { id: idFor(expiredExtra) })).subject_id, 42);
      assert.deepEqual(
        counts(c.requests),
        { search: 1, detail: 1, persons: 1, cover: 1 },
        'positive raw responses and saved covers refresh after seven days'
      );
      await checkManual();
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'failed cover leaves incomplete resources and next sync repairs from saved metadata without search/persons',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(1, { repeated: true, images: true });
    let c = await client(f.data, metadataResponder(f.png, { brokenCover: true }));
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done();
      const id = idFor(f.folders[0]),
        node = await c.call('get', { id });
      assert.equal(node.subject_id, 42);
      assert.equal(node.metadata.resources_complete, false);
      assert.equal(node.cover, idFor(path.join(f.folders[0], 'local.png')));
      assert.deepEqual(counts(c.requests), { search: 1, detail: 1, persons: 1, cover: 1 });
      const now = await c.clock();
      await c.close();
      c = await client(f.data, metadataResponder(f.png), { now });
      await resync(c);
      assert.deepEqual(counts(c.requests), { search: 0, detail: 0, persons: 0, cover: 1 });
      const repaired = await c.call('get', { id });
      assert.equal(repaired.metadata.resources_complete, true);
      assert.equal(repaired.cover_source, 'bangumi');
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'token replacement aborts a held search and resumes saved work in the new cache namespace',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(1, { repeated: true, images: true });
    const answer = metadataResponder(f.png);
    const c = await client(f.data, (r) => (r.body && r.originalAccess ? HOLD : answer(r)));
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.until(() => c.requests.length === 1, 'held old-access search');
      const activeId = idFor(f.folders[0]);
      assert.ok(durable(f).pending.some((n) => n.id === activeId));
      const after = c.events.length;
      await c.call('token', { value: 'fake-batch-access-b' });
      await c.done(after);
      assert.equal(searches(c).length, 2, 'old in-flight search is not reused');
      assert.equal(searches(c).filter((r) => r.originalAccess).length, 1);
      assert.equal(searches(c).filter((r) => !r.originalAccess).length, 1);
      assert.equal((await c.call('get', { id: activeId })).subject_id, 42);
      assertClean(await c.call('syncStatus'));
      database(f, (db) => {
        const scopes = db.prepare('SELECT DISTINCT scope FROM bangumi_cache').all();
        assert.equal(scopes.length, 1, 'canceled old-access response never enters disk cache');
      });
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'targeted scans discover new descendant albums without revisiting unrelated cached siblings',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(3);
    let c = await client(f.data, empty);
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done();
      const before = database(f, (db) => db.prepare('SELECT key,used_at FROM bangumi_cache').all());
      assert.equal(before.length, 3);
      const now = await c.clock();
      await c.close();
      const first = path.join(f.folders[0], '目标新作一');
      const nested = path.join(first, '目标新作二');
      await fs.mkdir(nested, { recursive: true });
      c = await client(f.data, empty, { now });
      const after = c.events.length;
      await c.call('scan', { path: f.source, target: f.folders[0] });
      await c.done(after);
      assert.deepEqual(
        new Set(searches(c).map((r) => r.body.keyword)),
        new Set(['目标新作一', '目标新作二'])
      );
      assert.ok(await c.call('get', { id: idFor(nested) }));
      const current = database(f, (db) =>
        db.prepare('SELECT key,used_at FROM bangumi_cache').all()
      );
      assert.equal(current.length, 5);
      assert.ok(
        before.filter(
          (row) => current.find((item) => item.key === row.key)?.used_at !== row.used_at
        ).length <= 1,
        'only the changed folder ancestor may revisit its old negative result'
      );
      assertClean(await c.call('syncStatus'));
      await c.call('cleanCache', { mode: 'metadata' });
      assert.equal(
        database(f, (db) => db.prepare('SELECT COUNT(*) total FROM bangumi_cache').get().total),
        0
      );
      const oldRequests = searches(c).length;
      await resync(c);
      assert.equal(
        searches(c).length - oldRequests,
        5,
        'explicit cache cleanup also evicts in-memory search responses'
      );
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'incomplete resource repair revalidates detail permissions after an account change',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(1, { repeated: true, images: true });
    let c = await client(f.data, metadataResponder(f.png, { brokenCover: true }));
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.done();
      const id = idFor(f.folders[0]);
      const before = (await c.call('get', { id })).metadata;
      assert.equal(before.resources_complete, false);
      const now = await c.clock();
      await c.close();
      c = await client(f.data, () => ({ status: 403, json: {} }), {
        now,
        token: 'fake-batch-access-b'
      });
      await c.call('sync', {});
      await c.paused('access');
      assert.deepEqual(counts(c.requests), { search: 0, detail: 1, persons: 0, cover: 0 });
      assert.equal((await c.call('get', { id })).metadata.access_scope, before.access_scope);
      assert.equal((await c.call('get', { id })).metadata.resources_complete, false);
      assert.ok(durable(f).pending.some((job) => job.id === id));
      await c.close();
      c = await client(f.data, metadataResponder(f.png), { now });
      await c.done();
      assert.deepEqual(counts(c.requests), { search: 0, detail: 0, persons: 0, cover: 1 });
      assert.equal((await c.call('get', { id })).metadata.resources_complete, true);
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test(
  'restart discards pending work whose inherited category changed to another permitted category',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(2, { repeated: true, images: true });
    let c = await client(f.data, () => HOLD);
    try {
      await c.call('scan', { path: f.source, ...IMPORT, offline: true });
      const root = idFor(f.source);
      await c.call('patch', { id: root, changes: { search_type: 2 } });
      await c.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [2, 4] });
      await c.until(() => c.requests.length === 1, 'held active request');
      assert.equal(durable(f).pending.length, 2);
      await c.call('patch', { id: root, changes: { search_type: 4 } });
      const now = await c.clock();
      await c.terminate();
      c = await client(f.data, empty, { now });
      await c.done();
      assert.equal(c.requests.length, 0, 'pending jobs retain their original policy identity');
      assertClean(await c.call('syncStatus'));
      for (const folder of f.folders)
        assert.equal((await c.call('get', { id: idFor(folder) })).subject_id, null);
      await resync(c);
      assert.equal(searches(c).length, 1, 'explicit new sync may use the new inherited category');
      assert.deepEqual(searches(c)[0].body.filter.type, [4]);
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);

test('completed counts survive retry pumps, retain final values and reset on new work', async () => {
  const f = await fixture(3);
  let recover = false,
    firstKeyword;
  const c = await client(f.data, (request) => {
    if (!firstKeyword) firstKeyword = request.body.keyword;
    if (!recover && request.body.keyword !== firstKeyword) {
      return { failure: 'mock transient network failure' };
    }
    return empty();
  });
  try {
    await c.call('scan', { path: f.source, ...IMPORT });
    await c.paused('network');
    const paused = await c.call('syncStatus');
    assert.equal(paused.completed, 1);
    assert.equal(paused.total, paused.remaining + 1);
    recover = true;
    const after = c.events.length;
    await c.clock(paused.retryAt - (await c.clock()) + 1);
    await c.call('sync', { id: durable(f).pending[0].id });
    await c.done(after);
    const done = await c.call('syncStatus');
    assert.equal(done.completed, 3);
    assert.equal(done.total, 3);
    assertClean(done);
    assert.equal((await c.call('syncStatus')).completed, 3);
    const next = c.events.length;
    await c.call('sync', { id: idFor(f.folders[0]) });
    await c.done(next);
    assert.equal((await c.call('syncStatus')).completed, 1);
    assert.equal((await c.call('syncStatus')).total, 1);
    const restarted = c.events.slice(next).filter((e) => e.event === 'online');
    assert.ok(restarted.some((e) => e.data.completed === 0 && e.data.remaining === 1));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test('restart begins counting remaining work and cancellation never completes the active job', async () => {
  const f = await fixture(3);
  let firstKeyword;
  let c = await client(f.data, (request) => {
    if (!firstKeyword) firstKeyword = request.body.keyword;
    return request.body.keyword === firstKeyword ? empty() : { status: 401, json: {} };
  });
  try {
    await c.call('scan', { path: f.source, ...IMPORT });
    await c.paused('access');
    assert.equal((await c.call('syncStatus')).completed, 1);
    const remaining = durable(f).pending.length;
    await c.close();
    c = await client(f.data, () => HOLD);
    await c.paused('access');
    assert.equal((await c.call('syncStatus')).completed, 0);
    assert.equal((await c.call('syncStatus')).total, remaining);
    await c.call('token', { value: 'fake-counting-new-access' });
    await c.until(() => c.requests.length === 1, 'active held request');
    const active = await c.call('syncStatus');
    assert.equal(active.remaining, remaining);
    assert.equal(active.completed, 0);
    await c.call('cancel');
    await c.until(
      () => c.events.some((e) => e.event === 'online' && !e.data.active && e.data.remaining === 0),
      'cancel completion'
    );
    assert.equal((await c.call('syncStatus')).completed, 0);
    assertClean(await c.call('syncStatus'));
  } finally {
    await c.close();
    await cleanup(f);
  }
});

test(
  'canceling an access-paused batch deletes saved work and restart sends no HTTP',
  { timeout: TIMEOUT },
  async () => {
    const f = await fixture(140);
    let c = await client(f.data, () => ({ status: 403, json: {} }));
    try {
      await c.call('scan', { path: f.source, ...IMPORT });
      await c.paused('access');
      assert.equal(c.requests.length, 1);
      await c.call('cancel');
      assertClean(await c.call('syncStatus'));
      const saved = durable(f);
      assert.equal(saved.pending.length, 0);
      assert.equal(saved.frontier.length, 0);
      assert.equal(saved.resume.reason, '');
      const now = await c.clock();
      await c.close();
      c = await client(f.data, empty, { now });
      assertClean(await c.call('syncStatus'));
      await c.call('init');
      assert.equal(c.requests.length, 0);
    } finally {
      await c.close();
      await cleanup(f);
    }
  }
);
