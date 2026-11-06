'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { sortKey, NATURAL_SORT_VERSION } = require('../src/natural-sort.cjs');

// Real SQLite and production worker; only background decoding/network are
// disabled. Gates wrap the migration's real yielding boundary, never its SQL.
async function client(dataDir, hold = null) {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    'use strict';
    const { workerData, parentPort } = require('node:worker_threads');
    const Module = require('node:module');
    const control = workerData.control;
    let release, held = false, holdNextYield = false;
    const gate = new Promise(resolve => { release = resolve; });
    control.on('message', message => { if (message.release) release(); });
    control.unref();
    const forbid = (kind) => {
      parentPort.postMessage({ event: 'fixture-forbidden', data: { kind } });
      throw new Error(kind + ' forbidden in browse-date worker fixture');
    };
    global.fetch = async () => forbid('network');
    for (const name of ['node:http', 'node:https']) {
      const http = require(name);
      http.request = http.get = () => forbid('network');
    }
    const fs = require('node:fs'), path = require('node:path');
    const nativeOpendir = fs.promises.opendir;
    fs.promises.opendir = async (directory, ...args) => {
      // Rename recovery may enumerate its owned journal inside the data folder.
      if (!path.resolve(directory).startsWith(path.resolve(workerData.dataDir) + path.sep))
        return forbid('source directory scan');
      return nativeOpendir(directory, ...args);
    };
    const originalLoad = Module._load;
    Module._load = function(request) {
      const value = originalLoad.apply(this, arguments);
      if (/[\\/]media\\.cjs$/u.test(request)) return {
        ...value, createMedia(options) {
          const media = value.createMedia(options);
          return { ...media, start: async () => media.stats() };
        }
      };
      if (/[\\/]browse-date\\.cjs$/u.test(request)) return {
        ...value, createBrowseDate(db) {
          const dates = value.createBrowseDate(db);
          return { ...dates, migrateAsync(options) {
            return dates.migrateAsync({ ...options, batchSize: 2,
              onProgress(state) {
                options.onProgress(state);
                const hold = workerData.hold;
                if (!held && hold && Object.entries(hold).every(([key, expected]) => state[key] === expected))
                  holdNextYield = true;
              },
              async yieldNow() {
                await options.yieldNow();
                if (holdNextYield && !held) {
                  held = true;
                  parentPort.postMessage({ event: 'fixture-held', data: dates.status() });
                  await gate;
                }
              }
            });
          } };
        }
      };
      return value;
    };
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        deferBackground: true,
        watch: false,
        hold,
        control: port2,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      },
      transferList: [port2]
    }
  );
  const events = [],
    pending = new Map(),
    observers = new Set();
  let sequence = 0,
    closed = false;
  worker.on('message', (message) => {
    if (message.event) {
      events.push(message);
      for (const observer of [...observers]) observer();
    } else {
      const request = pending.get(message.request);
      if (!request) return;
      pending.delete(message.request);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    }
  });
  worker.on('error', (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  worker.on('exit', () => {
    for (const request of pending.values()) request.reject(new Error('Fixture worker terminated'));
    pending.clear();
  });
  function call(method, args = {}) {
    return new Promise((resolve, reject) => {
      const request = ++sequence;
      pending.set(request, { resolve, reject });
      worker.postMessage({ request, method, args });
    });
  }
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        observers.delete(check);
        reject(
          new Error('Browse-date fixture event timed out: ' + JSON.stringify(events.slice(-4)))
        );
      }, 10000);
      function check() {
        const event = events.find(predicate);
        if (!event) return;
        clearTimeout(timer);
        observers.delete(check);
        resolve(event.data);
      }
      observers.add(check);
      check();
    });
  }
  const ready = await waitFor((event) => event.event === 'ready');
  return {
    ready,
    events,
    call,
    waitFor,
    release: () => port1.postMessage({ release: true }),
    async close(crash = false) {
      if (closed) return;
      closed = true;
      if (!crash) {
        port1.postMessage({ release: true });
        await call('shutdown');
      }
      await worker.terminate();
      port1.close();
      assert.deepEqual(
        events.filter((event) => event.event === 'fixture-forbidden'),
        []
      );
    }
  };
}

async function fixture(t) {
  // Owned tiny fixtures remain as evidence; this test never opens personal data.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-browse-date-worker-'));
  const dataDir = path.join(directory, 'data');
  const clients = [];
  t.after(async () => {
    for (const connection of clients) await connection.close();
  });
  const open = async (hold) => {
    const connection = await client(dataDir, hold);
    clients.push(connection);
    return connection;
  };
  const bootstrap = await open();
  await bootstrap.close();
  const db = new DatabaseSync(path.join(dataDir, 'library.sqlite'));
  try {
    const insert = db.prepare(`INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,birth,mtime)
      VALUES(?,'root',?,?,?,?,?,?,?)`);
    for (const [id, parent, name, kind, birth] of [
      ['root', null, 'Root', 'folder', 50],
      ['folder2', 'root', 'folder2', 'folder', 1000],
      ['folder10', 'root', 'folder10', 'folder', 500],
      ['image2', 'root', 'image2', 'image', 100],
      ['image10', 'root', 'image10', 'image', 300],
      ['video3', 'root', 'video3', 'video', 200],
      ['alpha', 'root', 'alpha', 'image', 400]
    ])
      insert.run(id, parent, path.join(directory, id), name, sortKey(name), kind, birth, 10);
    db.prepare('INSERT INTO media(id,taken,date_source) VALUES(?,?,?)').run(
      'image10',
      900,
      'exif-local'
    );
    db.exec('UPDATE nodes SET content_date=NULL');
    const set = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
    for (const [key, value] of Object.entries({
      browseContentDateVersion: 1,
      naturalSortVersion: NATURAL_SORT_VERSION,
      browseOrderVersion: 1,
      browseOptimizeVersion: 1,
      searchVersion: 1,
      mediaSeedVersion: 1
    }))
      set.run(key, JSON.stringify(value));
  } finally {
    db.close();
  }
  return { open, dataDir };
}

const query = { parent: 'root', sort: 'contentDate', direction: 'desc', limit: 3 };
const fallback = {
  requested: 'contentDate',
  sort: 'name',
  direction: 'asc',
  reason: 'content-date-migration'
};
const names = (page) => page.items.map((item) => item.id);

test(
  'worker serves name ASC pages during real yielding preparation and recovers after interruption',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    let c = await f.open({ stage: 'backfill', processed: 2 });
    assert.equal(c.ready.dateMigration.stage, 'pending');
    assert.equal(c.ready.dateMigration.ready, false);
    const initial = await c.call('list', query);
    assert.deepEqual(initial.sortFallback, fallback);
    assert.deepEqual(names(initial), ['folder2', 'folder10', 'alpha']);
    assert.deepEqual(names(await c.call('list', { ...query, offset: 3 })), [
      'image2',
      'image10',
      'video3'
    ]);
    const accepted = await c.call('startupResume');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.dateMigration.ready, false);
    await c.waitFor((event) => event.event === 'fixture-held');
    const during = await c.call('init', { lightweight: true });
    assert.equal(during.dateMigration.stage, 'backfill');
    assert.equal(during.dateMigration.processed, 2);
    assert.equal(during.dateMigration.total, 7);
    assert.deepEqual(during.taskSnapshot.dateMigration, during.dateMigration);
    assert.deepEqual(names(await c.call('list', query)), names(initial));
    // A mutation waits for maintenance while foreground reads continue to return.
    let mutationDone = false;
    const mutation = c.call('settings', { key: 'nickname', value: 'queued fixture' }).then(
      () => {
        mutationDone = true;
      },
      () => {
        mutationDone = true;
      }
    );
    await c.call('init', { lightweight: true });
    assert.equal(mutationDone, false);
    await c.close(true);
    // Termination drops only this in-flight RPC; all committed date rows survive.
    // Do not await the deliberately interrupted request.
    void mutation;
    c = await f.open({ stage: 'index', indexesCompleted: 1, blocking: false });
    assert.equal(c.ready.dateMigration.processed, 2);
    assert.equal(c.ready.dateMigration.stage, 'pending');
    await c.call('startupResume');
    const indexState = await c.waitFor((event) => event.event === 'fixture-held');
    assert.equal(indexState.indexesCompleted, 1);
    assert.equal(indexState.processed, 7);
    const late = await c.call('init', { lightweight: true });
    assert.equal(late.dateMigration.ready, false);
    assert.equal(late.dateMigration.stage, 'index');
    assert.deepEqual((await c.call('list', query)).sortFallback, fallback);
    const db = new DatabaseSync(path.join(f.dataDir, 'library.sqlite'), { readOnly: true });
    try {
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get().value,
        '1'
      );
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('nodes_parent_content_date','nodes_global_content_date')"
          )
          .get().n,
        1
      );
    } finally {
      db.close();
    }
    c.release();
    await c.waitFor((event) => event.event === 'changed' && event.data.maintenance);
    const final = await c.call('init', { lightweight: true });
    assert.equal(final.dateMigration.ready, true);
    assert.equal(final.dateMigration.active, false);
    assert.equal(final.dateMigration.indexesCompleted, 2);
    assert.equal(final.maintenance.state, 'ready');
    const migrationEvents = c.events.filter((event) => event.event === 'dateMigration');
    assert.deepEqual(
      migrationEvents.map((event) => event.data.revision),
      migrationEvents.map((_, i) => i + 1)
    );
    assert.ok(final.dateMigration.revision > late.dateMigration.revision);
    assert.equal(final.dateMigration.revision, migrationEvents.at(-1).data.revision);
    assert.equal(final.taskSnapshot.dateMigration.revision, final.dateMigration.revision);
    const ordered = await c.call('list', { ...query, limit: 10 });
    assert.equal(ordered.sortFallback, undefined);
    assert.deepEqual(names(ordered), [
      'folder2',
      'folder10',
      'image10',
      'video3',
      'image2',
      'alpha'
    ]);
    // Backfill uses filesystem min for files, hence equal 10 dates use DESC names;
    // EXIF 900 wins and folders preserve their distinct birth values.
    const counts = c.events
      .filter((event) => event.event === 'dateMigration' && event.data.stage === 'backfill')
      .map((event) => event.data.processed);
    assert.deepEqual(counts, [2, 4, 6, 7]);
    assert.equal(
      c.events.filter((event) => event.event === 'dateMigration' && event.data.ready).length,
      1
    );
    await c.close();
  }
);

test(
  'worker shutdown pauses preparation without publishing readiness',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const c = await f.open({ stage: 'backfill', processed: 2 });
    await c.call('startupResume');
    await c.waitFor((event) => event.event === 'fixture-held');
    const shutdown = c.call('shutdown');
    // The startup task owns its cursor until the yield resumes and sees stopping.
    c.release();
    await shutdown;
    assert.equal(
      c.events.some((event) => event.event === 'dateMigration' && event.data.ready),
      false
    );
    assert.equal(
      c.events.some((event) => event.event === 'dateMigration' && event.data.stage === 'paused'),
      true
    );
    await c.close(true);
    const db = new DatabaseSync(path.join(f.dataDir, 'library.sqlite'), { readOnly: true });
    try {
      assert.equal(
        JSON.parse(
          db.prepare("SELECT value FROM settings WHERE key='browseContentDateCursor'").get().value
        ).processed,
        2
      );
      assert.equal(
        db.prepare("SELECT value FROM settings WHERE key='browseContentDateVersion'").get().value,
        '1'
      );
    } finally {
      db.close();
    }
  }
);
