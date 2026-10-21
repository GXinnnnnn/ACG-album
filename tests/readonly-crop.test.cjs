'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  { Worker } = require('node:worker_threads'),
  sharp = require('sharp'),
  { idFor } = require('../src/model.cjs');
async function worker(dataDir) {
  const w = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
      workerData: { dataDir, watch: false }
    }),
    pending = new Map();
  let seq = 0;
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
async function manifest(root) {
  const rows = [];
  async function walk(dir) {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name),
        stat = await fs.stat(file);
      rows.push({
        path: path.relative(root, file),
        directory: item.isDirectory(),
        bytes: stat.size,
        mtime: stat.mtimeMs,
        hash: item.isDirectory()
          ? null
          : crypto
              .createHash('sha256')
              .update(await fs.readFile(file))
              .digest('hex')
      });
      if (item.isDirectory()) await walk(file);
    }
  }
  await walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
test(
  'cover zoom persists; all presentation edits and removal leave imported directory byte-for-byte unchanged',
  { timeout: 15000 },
  async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-readonly-')),
      source = path.join(tmp, 'source'),
      album = path.join(source, '作品'),
      file = path.join(album, '图片.png'),
      data = path.join(tmp, 'data');
    await fs.mkdir(album, { recursive: true });
    await sharp({ create: { width: 800, height: 600, channels: 3, background: '#eeaacc' } })
      .png()
      .toFile(file);
    await fs.writeFile(path.join(album, 'desktop.ini'), '[.ShellClassInfo]\r\n');
    await fs.writeFile(path.join(source, '说明.txt'), '原文件和非图片文件均须保持不变。');
    const before = await manifest(source);
    let c = await worker(data);
    try {
      await assert.rejects(() => c.call('scan', { path: data, offline: true }), /缓存目录/);
      await assert.rejects(
        () => c.call('scan', { path: path.join(data, 'thumbnails'), offline: true }),
        /缓存目录/
      );
      await c.call('scan', { path: source, offline: true });
      const id = idFor(album);
      await c.call('selectCoverPath', { id, file });
      const updated = await c.call('patch', {
        id,
        changes: {
          crop_x: 32.5,
          crop_y: 73,
          crop_zoom: 2.4,
          confirmed: 1,
          favorite: 1,
          intro: 0,
          search_type: 4
        }
      });
      assert.equal(updated.crop_zoom, 2.4);
      await assert.rejects(() => c.call('patch', { id, changes: { crop_zoom: 4.01 } }));
      await assert.rejects(() => c.call('patch', { id, changes: { crop_zoom: 0.99 } }));
      await c.call('thumb', { id, size: 512 });
      await c.stop();
      c = await worker(data);
      const saved = await c.call('get', { id });
      assert.equal(saved.crop_x, 32.5);
      assert.equal(saved.crop_y, 73);
      assert.equal(saved.crop_zoom, 2.4);
      const reset = await c.call('resetCover', { id });
      assert.equal(reset.crop_zoom, 1);
      await c.call('patch', { id, changes: { crop_zoom: 2 } });
      assert.equal((await c.call('selectCoverPath', { id, file })).crop_zoom, 1);
      await c.call('removeRoot', { id: idFor(source) });
      assert.equal((await c.call('init')).roots.length, 0);
      await c.call('cleanCache', { mode: 'all-thumbnails' });
      await c.call('cleanCache', { mode: 'metadata' });
      assert.deepEqual(await manifest(source), before);
    } finally {
      await c.stop();
      assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'acg-readonly-')));
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
);
