'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
async function client(dataDir) {
  const w = new Worker(path.resolve('src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  let seq = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.request) {
        const p = pending.get(m.request);
        pending.delete(m.request);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  return {
    call: (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++seq;
        pending.set(request, { resolve, reject });
        w.postMessage({ request, method, args });
      }),
    stop: () => w.terminate()
  };
}
(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-benchmark-'));
  let c = await client(dir);
  await c.stop();
  try {
    const db = new DatabaseSync(path.join(dir, 'library.sqlite'));
    const insert = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,files,folders,total_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.exec('BEGIN');
    insert.run(
      'root',
      'root',
      null,
      'C:\\Benchmark',
      '十万图片测试库',
      'test',
      'folder',
      0,
      0,
      1,
      1,
      100000,
      0,
      10240000000
    );
    for (let i = 0; i < 100000; i++) {
      const name = (i % 1000 === 0 ? '黄金庭院' : 'Library Image') + ' ' + i + '.png';
      insert.run(
        i.toString(16).padStart(24, '0'),
        'root',
        'root',
        'C:\\Benchmark\\' + i + '.png',
        name,
        name.replace(/\d+/g, (n) => n.padStart(14, '0')),
        'image',
        1,
        ((i % 5000) + 1) * 1024,
        Date.now() - i * 1000,
        Date.now() - i * 1000,
        0,
        0,
        0
      );
    }
    db.exec(
      'INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);'
    );
    db.close();
    c = await client(dir);
    const cases = [
      ['name-first', { parent: 'root' }],
      ['name-page-90000', { parent: 'root', offset: 90000 }],
      ['date-page-90000', { parent: 'root', sort: 'date', offset: 90000 }],
      ['modified-page', { parent: 'root', sort: 'modified', offset: 90000 }],
      ['size-page', { parent: 'root', sort: 'size', offset: 90000 }],
      ['name-desc-page', { parent: 'root', direction: 'desc', offset: 90000 }],
      ['size-desc-page', { parent: 'root', sort: 'size', direction: 'desc', offset: 90000 }],
      ['fulltext-chinese', { search: '黄金庭院' }],
      ['short-chinese', { search: '黄金' }],
      ['global-images', { filter: 'images', offset: 90000 }]
    ];
    const report = { rows: 100000, synthetic: true, queries: [] };
    for (const [name, args] of cases) {
      const timings = [];
      let total;
      for (let j = 0; j < 4; j++) {
        const start = performance.now();
        const result = await c.call('list', { ...args, limit: 180 });
        timings.push(performance.now() - start);
        total = result.total;
        assert.ok(result.items.length > 0);
        assert.ok(result.items.length <= 180);
      }
      report.queries.push({
        name,
        total,
        coldMs: +timings[0].toFixed(2),
        warmMs: +(timings.slice(1).reduce((s, v) => s + v, 0) / 3).toFixed(2)
      });
    }
    report.databaseMB = (await fs.stat(path.join(dir, 'library.sqlite'))).size / 1024 / 1024;
    await fs.mkdir('artifacts', { recursive: true });
    await fs.writeFile('artifacts/benchmark-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await c.stop();
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'acg-benchmark-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
