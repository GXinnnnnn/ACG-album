'use strict';
const fs = require('node:fs/promises'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { IMAGE_EXT, idFor } = require('../src/model.cjs');
const dataDir = path.resolve(process.argv[2] || '.review-data'),
  source = path.resolve('ACG图片');
async function inventory(dir, result = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && !e.isSymbolicLink()) await inventory(p, result);
    else if (e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase())) {
      const data = await fs.readFile(p);
      result.push({
        path: path.relative(source, p),
        bytes: data.length,
        sha256: crypto.createHash('sha256').update(data).digest('hex')
      });
    }
  }
  return result;
}
(async () => {
  await fs.mkdir('artifacts', { recursive: true });
  const before = await inventory(source);
  await fs.writeFile('artifacts/source-manifest.json', JSON.stringify(before, null, 2));
  console.log(
    'SOURCE',
    before.length,
    'images',
    before.reduce((s, x) => s + x.bytes, 0),
    'bytes'
  );
  const w = new Worker(path.resolve('src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event === 'online' && m.data.error) console.log('ONLINE', m.data.error);
      if (m.request) {
        const p = pending.get(m.request);
        pending.delete(m.request);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++seq;
      pending.set(request, { resolve, reject });
      w.postMessage({ request, method, args });
    });
  try {
    await ready;
    await call('settings', { key: 'autoMatch', value: false });
    await call('settings', { key: 'categoryType', value: 2 });
    const start = performance.now();
    const scanned = await call('scan', { path: source, offline: true });
    await call('patch', { id: scanned.root, changes: { search_type: 2 } });
    const albums = (await call('list', { parent: scanned.root, filter: 'folders' })).items;
    const rider = albums.find((n) => n.name.includes('假面骑士'));
    if (rider) await call('patch', { id: rider.id, changes: { search_type: 6 } });
    const report = {
      sourceImages: before.length,
      sourceBytes: before.reduce((s, x) => s + x.bytes, 0),
      scanMs: performance.now() - start,
      albums: [],
      stats: (await call('init')).stats
    };
    for (const n of albums) {
      console.log('MATCH', n.name);
      try {
        const result = await call('match', { id: n.id });
        const node = await call('get', { id: n.id });
        const row = {
          name: n.name,
          id: n.id,
          type: node.effective_search_type,
          subject: node.subject_id,
          matched: node.metadata?.name_cn || node.metadata?.name,
          candidates: (result.candidates || []).map((c) => ({
            id: c.id,
            name: c.name_cn || c.name,
            type: c.type,
            score: c.match
          }))
        };
        if (row.candidates.some((c) => c.type !== row.type))
          throw new Error('Search type filter was not respected');
        report.albums.push(row);
        console.log(JSON.stringify(row));
      } catch (e) {
        report.albums.push({ name: n.name, error: e.message });
        console.log('MATCH ERROR', e.message);
      }
    }
    const honkai = albums.find((n) => n.name.includes('崩坏3'));
    if (honkai) {
      const result = await call('match', { id: honkai.id, keyword: '黄金庭院' });
      report.honkaiAnimationSearch = (result.candidates || []).map((c) => ({
        id: c.id,
        name: c.name_cn || c.name,
        type: c.type,
        score: c.match
      }));
      const node = await call('get', { id: honkai.id });
      if (node.subject_id)
        report.honkaiAnimationBound = {
          id: node.subject_id,
          name: node.metadata?.name_cn,
          type: node.metadata?.type
        };
      console.log(
        'HONKAI ANIMATION',
        JSON.stringify(report.honkaiAnimationSearch),
        JSON.stringify(report.honkaiAnimationBound)
      );
    }
    const after = await inventory(source);
    report.sourceUnchanged = JSON.stringify(before) === JSON.stringify(after);
    if (!report.sourceUnchanged) throw new Error('Source image inventory changed');
    await fs.writeFile('artifacts/real-library-report.json', JSON.stringify(report, null, 2));
    console.log('REAL LIBRARY', JSON.stringify(report, null, 2));
  } finally {
    await w.terminate();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
