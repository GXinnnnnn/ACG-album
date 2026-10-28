'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');
const { sortKey, NATURAL_SORT_VERSION } = require('../src/natural-sort.cjs');

async function client(dataDir, fixture) {
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false, token: '' }
  });
  // Track the worker before awaiting ready, so timeout cleanup also owns a worker
  // that is still migrating the 100k fixture and has not become f.client yet.
  fixture.workers.add(worker);
  worker.once('exit', () => fixture.workers.delete(worker));
  const pending = new Map();
  const events = [];
  let serial = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Worker ready timeout'));
    }, 60000);
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Worker exited before ready: ' + code));
    });
    worker.on('message', (m) => {
      if (m.event) events.push(m);
      if (m.event === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      const item = pending.get(m.request);
      if (!item) return;
      pending.delete(m.request);
      clearTimeout(item.timer);
      m.error ? item.reject(new Error(m.error)) : item.resolve(m.result);
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++serial;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout: ' + method));
      }, 15000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  let closePromise;
  return {
    call,
    events,
    close() {
      return (closePromise ||= (async () => {
        try {
          await call('shutdown');
        } finally {
          await worker.terminate();
        }
      })());
    }
  };
}
async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-directory-sort-'));
  const fixture = { workers: new Set() };
  t.signal.addEventListener(
    'abort',
    () => {
      for (const worker of fixture.workers) void worker.terminate();
    },
    { once: true }
  );
  t.after(async () => {
    try {
      if (!t.signal.aborted) await fixture.client?.close();
    } finally {
      await Promise.allSettled([...fixture.workers].map((worker) => worker.terminate()));
      assert.equal(path.dirname(tmp), path.resolve(os.tmpdir()));
      assert.ok(path.basename(tmp).startsWith('acg-directory-sort-'));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(source);
  return Object.assign(fixture, { tmp, source, data });
}
const key = (s) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\d+/g, (n) => n.padStart(14, '0'));

test('directory ordering uses actual natural names, separate filesystem dates and stable mixed-media pages', async (t) => {
  const f = await fixture(t);
  const folderNames = ['Work10', 'Work2', 'Work1'];
  const fileNames = ['image10.jpg', 'image2.jpg', 'image1.jpg', 'image3.mp4'];
  for (const name of folderNames) await fs.mkdir(path.join(f.source, name));
  for (const name of fileNames) await fs.writeFile(path.join(f.source, name), '');
  for (const [i, name] of [...folderNames, ...fileNames].entries())
    await fs.utimes(path.join(f.source, name), 1600000000 + i * 100, 1600000000 + i * 100);
  let c = (f.client = await client(f.data, f));
  await c.call('scan', {
    path: f.source,
    offline: true,
    directoryKind: 'work',
    onlineMatch: false
  });
  const parent = idFor(f.source);
  const folders = (await c.call('list', { parent, filter: 'folders' })).items;
  for (const n of folders) {
    const stat = await fs.stat(n.path);
    assert.equal(n.mtime, stat.mtimeMs, 'folder mtime comes from its actual directory stat');
    assert.equal(n.birth, stat.birthtimeMs);
  }
  await c.close();
  // Contradictory metadata titles and timestamps make the intended ordering explicit.
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const names = [...folderNames, ...fileNames];
    const update = db.prepare('UPDATE nodes SET birth=?,mtime=?,subject_id=? WHERE id=?');
    for (const [i, name] of names.entries()) {
      const subject = 100 + i;
      update.run(
        10000 + (names.length - i) * 100,
        20000,
        subject,
        idFor(path.join(f.source, name))
      );
      db.prepare('INSERT INTO metadata VALUES(?,?,?)').run(
        subject,
        JSON.stringify({ id: subject, type: 2, name: 'ReversedTitle' + (names.length - i) }),
        1
      );
    }
  } finally {
    db.close();
  }
  c = f.client = await client(f.data, f);
  t.after(() => c.close());
  const natural = [
    'Work1',
    'Work2',
    'Work10',
    'image1.jpg',
    'image2.jpg',
    'image3.mp4',
    'image10.jpg'
  ];
  const listing = async (sort, direction = 'asc', limit = 500, offset = 0) =>
    c.call('list', { parent, sort, direction, limit, offset });
  assert.deepEqual(
    (await listing('name')).items.map((n) => n.name),
    natural
  );
  assert.deepEqual(
    (await listing('modified')).items.map((n) => n.name),
    natural,
    'equal mtime uses natural name, not hashed ID'
  );
  assert.deepEqual(
    (await listing('size')).items.map((n) => n.name),
    natural,
    'equal size has the same stable tie'
  );
  assert.deepEqual(
    (await listing('name', 'desc')).items.map((n) => n.name),
    ['Work10', 'Work2', 'Work1', 'image10.jpg', 'image3.mp4', 'image2.jpg', 'image1.jpg']
  );
  assert.deepEqual(
    (await listing('date')).items.map((n) => n.name),
    ['Work1', 'Work2', 'Work10', 'image3.mp4', 'image1.jpg', 'image2.jpg', 'image10.jpg']
  );
  for (const sort of ['name', 'modified', 'date', 'size']) {
    for (const direction of ['asc', 'desc']) {
      const expected = await listing(sort, direction);
      const combined = [];
      for (let offset = 0; offset < expected.total; offset += 2)
        combined.push(...(await listing(sort, direction, 2, offset)).items.map((n) => n.id));
      assert.deepEqual(
        combined,
        expected.items.map((n) => n.id),
        `${sort}/${direction} pagination`
      );
      assert.equal(new Set(combined).size, combined.length);
    }
  }
});

test(
  '100k SQL-backed directory keeps natural date ties indexed and paginated RPCs below two seconds',
  { timeout: 90000 },
  async (t) => {
    const f = await fixture(t);
    let c = (f.client = await client(f.data, f));
    await c.close();
    const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
    const root = idFor(f.source);
    try {
      const insert = db.prepare(
        'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,mtime,birth) VALUES(?,?,?,?,?,?,?,?,?,?)'
      );
      db.exec('BEGIN');
      insert.run(root, root, null, f.source, 'source', 'source', 'folder', 0, 1, 1);
      for (let i = 100000; i >= 1; i--) {
        const name = `中文图片${i}.${i % 2 ? 'jpg' : 'mp4'}`;
        insert.run(
          'fixture-' + i,
          root,
          root,
          path.join(f.source, name),
          name,
          key(name),
          i % 2 ? 'image' : 'video',
          1,
          2,
          3
        );
      }
      db.exec('COMMIT');
      db.prepare('DELETE FROM settings WHERE key IN (?,?)').run(
        'naturalSortVersion',
        'naturalSortCursor'
      );
      const plan = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM nodes WHERE parent=? AND missing=0 AND kind='image' ORDER BY mtime,sortkey,id LIMIT 50 OFFSET 90000"
        )
        .all(root);
      assert.ok(plan.some((row) => row.detail.includes('nodes_parent_modified')));
      assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
    } finally {
      db.close();
    }
    const migrationStarted = performance.now();
    c = f.client = await client(f.data, f);
    const migrationMs = Math.round(performance.now() - migrationStarted);
    t.after(() => c.close());
    const measurements = [];
    for (const sort of ['name', 'modified', 'date', 'size']) {
      for (const direction of ['asc', 'desc']) {
        const started = performance.now();
        const page = await c.call('list', {
          parent: root,
          sort,
          direction,
          offset: 99950,
          limit: 50
        });
        const elapsed = performance.now() - started;
        measurements.push({ sort, direction, ms: Math.round(elapsed) });
        assert.equal(page.total, 100000);
        assert.equal(page.items.length, 50);
        const expected = Array.from({ length: 50 }, (_, i) =>
          direction === 'asc' ? 99951 + i : 50 - i
        );
        assert.deepEqual(
          page.items.map((n) => Number(n.name.match(/\d+/)[0])),
          expected
        );
        assert.ok(elapsed < 2000, `${sort}/${direction} RPC ${elapsed.toFixed(1)}ms`);
      }
    }
    const migrated = await c.call('get', { id: 'fixture-100000' });
    assert.equal(migrated.sortkey, sortKey(migrated.name));
    t.diagnostic(JSON.stringify({ rows: 100000, migrationMs, measurements }));
  }
);

test('Chinese pinyin and numeric filename pages migrate legacy Unicode keys once without changing metadata', async (t) => {
  const f = await fixture(t);
  const names = ['张2', '波10', '阿10', '张1', '波2', '阿2'];
  for (const name of names) await fs.mkdir(path.join(f.source, name));
  let c = (f.client = await client(f.data, f));
  await c.call('scan', { path: f.source, onlineMatch: false, directoryKind: 'work' });
  await c.close();
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    const legacy = db.prepare(
      'UPDATE nodes SET sortkey=?,subject_id=?,confirmed=1,crop_x=31 WHERE name=?'
    );
    for (const [index, name] of names.entries()) legacy.run(key(name), index + 1, name);
    db.prepare('DELETE FROM settings WHERE key IN (?,?)').run(
      'naturalSortVersion',
      'naturalSortCursor'
    );
    // Simulate a durably committed first migration batch before process exit.
    const completed = db.prepare('SELECT rowid,name FROM nodes ORDER BY rowid LIMIT 3').all();
    for (const row of completed)
      db.prepare('UPDATE nodes SET sortkey=? WHERE rowid=?').run(sortKey(row.name), row.rowid);
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(
      'naturalSortCursor',
      JSON.stringify({ version: NATURAL_SORT_VERSION, after: completed.at(-1).rowid })
    );
  } finally {
    db.close();
  }
  c = f.client = await client(f.data, f);
  assert.deepEqual(
    c.events.filter((m) => m.event === 'sortMigration').map((m) => m.data),
    [
      { processed: 4, active: true },
      { processed: 4, active: false }
    ]
  );
  const expected = ['阿2', '阿10', '波2', '波10', '张1', '张2'];
  const parent = idFor(f.source);
  for (const direction of ['asc', 'desc']) {
    const pages = [];
    for (let offset = 0; offset < names.length; offset += 2)
      pages.push(
        ...(await c.call('list', { parent, sort: 'name', direction, offset, limit: 2 })).items
      );
    assert.deepEqual(
      pages.map((n) => n.name),
      direction === 'asc' ? expected : [...expected].reverse()
    );
    for (const node of pages) {
      assert.equal(node.sortkey, sortKey(node.name));
      assert.equal(node.subject_id, names.indexOf(node.name) + 1);
      assert.equal(node.confirmed, 1);
      assert.equal(node.crop_x, 31);
    }
  }
  await c.close();
  const check = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    assert.equal(
      JSON.parse(
        check.prepare('SELECT value FROM settings WHERE key=?').get('naturalSortVersion').value
      ),
      NATURAL_SORT_VERSION
    );
    assert.equal(
      JSON.parse(
        check.prepare('SELECT value FROM settings WHERE key=?').get('naturalSortCursor').value
      ),
      null
    );
  } finally {
    check.close();
  }
  c = f.client = await client(f.data, f);
  assert.equal(
    c.events.some((m) => m.event === 'sortMigration'),
    false,
    'completed migration is not repeated on the next boot'
  );
  assert.deepEqual(
    (await c.call('list', { parent, sort: 'name' })).items.map((n) => n.name),
    expected
  );
});

test('compact natural keys group non-Han before Chinese, retaining zh-CN names and numeric magnitudes without NUL', () => {
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  const samples = [
    '阿10',
    '波2',
    '张1',
    '阿2',
    'a10',
    'a2',
    'Image10',
    'image2',
    '中文1',
    '中文10000000000000000',
    '中文999999999999999',
    '中文2',
    'カナ2',
    'カナ10'
  ];
  const binary = (a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0);
  const expected = [
    ...samples.filter((name) => !/^\p{Script=Han}/u.test(name)).sort(collator.compare),
    ...samples.filter((name) => /^\p{Script=Han}/u.test(name)).sort(collator.compare)
  ];
  assert.deepEqual([...samples].sort(binary), expected);
  assert.equal(sortKey('Ａ０２'), sortKey('a2'));
  assert.equal(sortKey('阿02'), sortKey('阿2'));
  for (const sample of samples) assert.ok(!sortKey(sample).includes('\0'));
  assert.ok(
    Buffer.byteLength(sortKey('阿波张中文标题')) <= Buffer.byteLength('阿波张中文标题') + 1,
    'common Chinese weights add at most one group byte to UTF-8 index bytes'
  );
});
