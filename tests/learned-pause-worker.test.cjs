'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { idFor, normalize } = require('../src/model.cjs');

async function client(dataDir) {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const deny = (...args) => {
      parentPort.postMessage({ event: 'forbidden-network', data: String(args[0]) });
      throw new Error('Network is forbidden in learned pause fixtures');
    };
    global.fetch = async (...args) => deny(...args);
    for (const name of ['node:http', 'node:https']) {
      const http = require(name); http.request = deny; http.get = deny;
    }
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        localIndexPath: path.join(dataDir, 'no-local-index.sqlite'),
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  let sequence = 0,
    closed = false;
  const pending = new Map(),
    events = [],
    watchers = new Set();
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event) {
        events.push(message);
        for (const check of watchers) check();
      }
      if (message.event === 'ready') resolve();
      const request = pending.get(message.request);
      if (request) {
        pending.delete(message.request);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error + '\n' + message.stack));
        else request.resolve(message.result);
      }
    });
  });
  const c = {
    events,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: ' + method));
        }, 10000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    until(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          watchers.delete(check);
          reject(new Error('Worker did not finish its bounded local sweep'));
        }, 5000);
        const check = () => {
          if (!predicate(events)) return;
          clearTimeout(timer);
          watchers.delete(check);
          resolve();
        };
        watchers.add(check);
        check();
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await c.call('shutdown');
      } finally {
        for (const p of pending.values()) clearTimeout(p.timer);
        await worker.terminate();
      }
    }
  };
  return c;
}

test(
  'access-paused worker without an index reuses static and manual titles once, retaining unknown pending work without HTTP',
  { timeout: 30000 },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-learned-pause-worker-'));
    const source = path.join(tmp, 'source'),
      data = path.join(tmp, 'data');
    const names = [
      'Manual Donor',
      'Riddle Joker',
      'Unique Saved Title',
      'Unknown Long Search Title'
    ];
    const folders = names.map((name) => path.join(source, name));
    await fs.mkdir(source);
    for (const folder of folders) await fs.mkdir(folder);
    const clients = [];
    t.after(async () => {
      for (const c of clients) await c.close();
      assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(tmp).startsWith('acg-learned-pause-worker-'));
      await fs.rm(tmp, { recursive: true, force: true });
    });
    let c = await client(data);
    clients.push(c);
    await c.call('scan', { path: source, offline: true, onlineMatch: true, subjectTypes: [4] });
    await c.close();
    let db = new DatabaseSync(path.join(data, 'library.sqlite'));
    const scope = createHash('sha256').update('ACGAlbum Bangumi cache v1\0').digest('hex');
    try {
      db.prepare('UPDATE nodes SET subject_id=42,manual_subject=1 WHERE id=?').run(
        idFor(folders[0])
      );
      db.prepare('INSERT INTO metadata VALUES(?,?,?)').run(
        42,
        JSON.stringify({
          id: 42,
          type: 4,
          name: names[2],
          aliases: [names[2]],
          source: 'local-index',
          details_source: 'local-index',
          resources_complete: false,
          cached_at: 0,
          staff: []
        }),
        Date.now()
      );
      db.prepare('INSERT INTO manual_title_keys VALUES(?,?,?,?,?)').run(
        idFor(folders[0]),
        normalize(names[2]),
        42,
        4,
        names[2]
      );
      db.prepare("INSERT OR REPLACE INTO settings VALUES('manualTitleKeysVersion','1')").run();
      db.prepare(
        "UPDATE match_resume SET reason='access',retry_at=0,scope=?,failures=1 WHERE singleton=1"
      ).run(scope);
    } finally {
      db.close();
    }
    c = await client(data);
    clients.push(c);
    assert.equal((await c.call('localIndexStatus')).available, false);
    await c.call('sync');
    const targetIds = new Set(folders.slice(1).map(idFor));
    await c.until((events) => {
      const attempts = events.filter(
        (event) => event.event === 'online' && event.data?.active && targetIds.has(event.data.id)
      );
      return (
        new Set(attempts.map((event) => event.data.id)).size === 3 &&
        events.at(-1)?.event === 'online' &&
        events.at(-1).data?.active === false
      );
    });
    const knownStatic = await c.call('get', { id: idFor(folders[1]) });
    const knownManual = await c.call('get', { id: idFor(folders[2]) });
    const unknown = await c.call('get', { id: idFor(folders[3]) });
    assert.equal(knownStatic.subject_id, 231798);
    assert.equal(knownStatic.manual_subject, 0);
    assert.equal(knownManual.subject_id, 42);
    assert.equal(knownManual.manual_subject, 0);
    assert.equal(unknown.subject_id, null);
    const status = await c.call('syncStatus');
    assert.equal(status.paused, 'access');
    assert.equal(status.pending, 3);
    assert.equal(status.active, false);
    assert.equal(status.discovering, false);
    assert.equal(status.buffered, 0);
    const activeCount = () =>
      c.events.filter(
        (event) => event.event === 'online' && event.data?.active && targetIds.has(event.data.id)
      ).length;
    assert.equal(activeCount(), 3);
    // Observe the scheduler for a bounded interval: a retry pump must not spin
    // on the retained learned-resource or unknown-name tasks while access pauses.
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(activeCount(), 3);
    assert.equal((await c.call('syncStatus')).active, false);
    assert.equal(c.events.filter((event) => event.event === 'forbidden-network').length, 0);
    assert.equal(c.events.filter((event) => event.event === 'error').length, 0);
    db = new DatabaseSync(path.join(data, 'library.sqlite'));
    try {
      const paused = db.prepare('SELECT * FROM match_resume').get();
      assert.equal(paused.reason, 'access');
      assert.equal(paused.failures, 1);
      assert.equal(paused.scope, scope);
      for (const [folder, expected] of [
        [folders[1], 231798],
        [folders[2], 42],
        [folders[3], null]
      ]) {
        const pending = db.prepare('SELECT stamp FROM match_pending WHERE id=?').get(idFor(folder));
        assert.ok(pending);
        assert.equal(JSON.parse(pending.stamp)[1], expected);
      }
    } finally {
      db.close();
    }
  }
);
