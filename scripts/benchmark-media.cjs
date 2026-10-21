'use strict';
// Synthetic SQL benchmark only: no source-media files are opened or decoded.
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const ROOT = path.resolve(__dirname, '..'),
  ROWS = 100000;
async function client(dataDir) {
  const worker = new Worker(path.join(ROOT, 'src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  const pending = new Map();
  let seq = 0;
  worker.on('message', (m) => {
    if (!m.request) return;
    const p = pending.get(m.request);
    pending.delete(m.request);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
  });
  worker.on('error', (error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++seq;
      pending.set(request, { resolve, reject });
      worker.postMessage({ request, method, args });
    });
  await new Promise((resolve, reject) => {
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
    });
    worker.once('error', reject);
  });
  return {
    call,
    stop: async () => {
      try {
        await call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-media-bench-'));
  let worker, timer;
  const report = { synthetic: true, rows: ROWS, decodedFiles: 0, queries: [] };
  try {
    worker = await client(data);
    await worker.stop();
    worker = null;
    const db = new DatabaseSync(path.join(data, 'library.sqlite'));
    const insert = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,files,folders,total_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    db.exec('BEGIN');
    insert.run(
      'root',
      'root',
      null,
      'C:\\Synthetic',
      '照片测试库',
      'root',
      'folder',
      0,
      0,
      1,
      1,
      ROWS,
      0,
      0
    );
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < ROWS; i++) {
      const id = i.toString(16).padStart(24, '0'),
        video = i % 50 === 0;
      const name =
        (i % 1000 === 0 ? '黄金庭院' : 'Library Image') + ' ' + i + (video ? '.mp4' : '.jpg');
      const time = start + i * 3600000;
      insert.run(
        id,
        'root',
        'root',
        'C:\\Synthetic\\' + name,
        name,
        name.replace(/\d+/g, (n) => n.padStart(14, '0')),
        video ? 'video' : 'image',
        1,
        1000 + i,
        time,
        time,
        0,
        0,
        0
      );
    }
    // Ready metadata prevents synthetic nonexistent paths from entering the decoder.
    db.exec(`INSERT INTO media(id,revision,width,height,format,frames,taken,date_source,place,status)
    SELECT id,CAST(mtime AS TEXT)||'-'||CAST(bytes AS TEXT),1920,CASE WHEN rowid%2=0 THEN 1080 ELSE 2880 END,
    CASE WHEN kind='video' THEN 'mp4' ELSE 'jpeg' END,1,mtime,'exif-offset',
    CASE WHEN rowid%100=0 THEN '杭州%_湖' ELSE '' END,'ready' FROM nodes WHERE kind<>'folder';
    INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes;
    COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`);
    db.close();
    const boot = performance.now();
    worker = await client(data);
    report.workerStartupMs = +(performance.now() - boot).toFixed(2);
    let last = performance.now(),
      maxDelay = 0;
    timer = setInterval(() => {
      const now = performance.now();
      maxDelay = Math.max(maxDelay, now - last - 10);
      last = now;
    }, 10);
    const cases = [
      ['name-first', { parent: 'root' }],
      ['name-deep', { parent: 'root', offset: 90000 }],
      ['date-deep', { parent: 'root', sort: 'date', offset: 90000 }],
      ['size-deep', { parent: 'root', sort: 'size', direction: 'desc', offset: 90000 }],
      ['search-chinese', { search: '黄金庭院' }],
      ['search-short', { search: '黄金' }],
      ['global-media-deep', { filter: 'images', offset: 90000 }],
      ['timeline-first', { timeline: true, direction: 'desc' }],
      ['timeline-deep', { timeline: true, direction: 'desc', offset: 90000 }],
      [
        'timeline-recursive-album',
        { parent: 'root', timeline: true, direction: 'desc', offset: 90000 }
      ],
      ['timeline-month', { timeline: true, month: '2024-01', direction: 'desc' }],
      ['timeline-literal-place', { timeline: true, place: '%_', direction: 'desc' }],
      ['timeline-month-place', { timeline: true, month: '2024-01', place: '%_', direction: 'desc' }]
    ];
    for (const [name, args] of cases) {
      const times = [];
      let total;
      for (let run = 0; run < 4; run++) {
        const start = performance.now(),
          r = await worker.call('list', { ...args, limit: 180 });
        times.push(performance.now() - start);
        assert.ok(r.items.length > 0 && r.items.length <= 180, name);
        total = r.total;
        if (args.timeline)
          for (let i = 1; i < r.items.length; i++)
            assert.ok(r.items[i - 1].taken >= r.items[i].taken, name);
      }
      report.queries.push({
        name,
        total,
        coldMs: +times[0].toFixed(2),
        warmMeanMs: +(times.slice(1).reduce((a, b) => a + b) / 3).toFixed(2),
        maxMs: +Math.max(...times).toFixed(2)
      });
    }
    report.parentTimerMaxDelayMs = +Math.max(0, maxDelay).toFixed(2);
    report.mediaStats = await worker.call('mediaStats');
    assert.equal(report.mediaStats.rows.find((r) => r.status === 'ready').count, ROWS);
    report.databaseMiB = +(
      (await fs.stat(path.join(data, 'library.sqlite'))).size / 1048576
    ).toFixed(2);
    await fs.writeFile(
      path.join(ROOT, 'artifacts/benchmark-media-report.json'),
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    clearInterval(timer);
    if (worker) await worker.stop();
    const resolved = path.resolve(data);
    assert.ok(resolved.startsWith(path.join(path.resolve(os.tmpdir()), 'acg-media-bench-')));
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
