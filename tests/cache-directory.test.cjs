'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const {
  initializeCache,
  cacheStats,
  migrateCache,
  resetCacheFiles,
  validateCacheLocation,
  DIRECTORY_NAME
} = require('../src/cache-directory.cjs');
async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-cache-test-'));
  t.after(async () => {
    assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'acg-cache-test-')));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return tmp;
}
async function client(dataDir, setup = '') {
  const worker = new Worker(
    `const {workerData} = require('node:worker_threads'); ${setup}; require(workerData.entry);`,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        entry: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      if (!message.request) return;
      const job = pending.get(message.request);
      pending.delete(message.request);
      if (message.error) job.reject(new Error(message.error));
      else job.resolve(message.result);
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++seq;
      pending.set(request, { resolve, reject });
      worker.postMessage({ request, method, args });
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

test('migration copies only owned directories, leaves profile files, and rolls back failed commit', async (t) => {
  const tmp = await fixture(t),
    source = path.join(tmp, 'profile'),
    destination = path.join(tmp, 'cache');
  initializeCache(source);
  await fs.writeFile(path.join(source, 'library.sqlite'), 'library');
  await fs.writeFile(path.join(source, 'bangumi-token.enc'), 'secret');
  await fs.writeFile(path.join(source, 'covers', 'character-42.webp'), 'downloaded');
  await fs.writeFile(path.join(source, 'metadata', '42.md'), 'description');
  await assert.rejects(
    migrateCache({
      source,
      destination,
      commit() {
        throw new Error('database failed');
      }
    }),
    /database failed/
  );
  assert.equal(
    await fs.readFile(path.join(source, 'covers', 'character-42.webp'), 'utf8'),
    'downloaded'
  );
  assert.deepEqual((await fs.readdir(destination)).sort(), []);
  let committed = false;
  await migrateCache({
    source,
    destination,
    commit() {
      committed = true;
    }
  });
  assert.equal(committed, true);
  assert.equal(
    await fs.readFile(path.join(destination, 'covers', 'character-42.webp'), 'utf8'),
    'downloaded'
  );
  assert.equal(await fs.readFile(path.join(source, 'library.sqlite'), 'utf8'), 'library');
  assert.equal(await fs.readFile(path.join(source, 'bangumi-token.enc'), 'utf8'), 'secret');
  assert.equal((await cacheStats(destination, source)).covers.count, 1);
  await assert.rejects(fs.stat(path.join(source, 'covers')), { code: 'ENOENT' });
});

test('rejects overlapping collections, nested caches, occupied targets and symlinks without altering data', async (t) => {
  const tmp = await fixture(t),
    source = path.join(tmp, 'profile'),
    destination = path.join(tmp, 'target');
  initializeCache(source);
  initializeCache(destination);
  await fs.writeFile(path.join(source, 'covers', '42.webp'), 'source');
  await fs.writeFile(path.join(destination, 'covers', '42.webp'), 'unrelated');
  await assert.rejects(migrateCache({ source, destination, commit() {} }), /已存在缓存/);
  assert.equal(await fs.readFile(path.join(destination, 'covers', '42.webp'), 'utf8'), 'unrelated');
  await assert.rejects(
    validateCacheLocation(path.join(tmp, 'collection', 'cache'), [path.join(tmp, 'collection')]),
    /不能互相包含/
  );
  await assert.rejects(validateCacheLocation(tmp, [path.join(tmp, 'collection')]), /不能互相包含/);
  await assert.rejects(
    migrateCache({ source, destination: path.join(source, 'nested'), commit() {} }),
    /不能互相包含/
  );
  const outside = path.join(tmp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(
    outside,
    path.join(source, 'thumbnails', 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(
    resetCacheFiles(source, () => {}),
    /非普通文件/
  );
  await assert.rejects(
    migrateCache({ source, destination: path.join(tmp, 'safe'), commit() {} }),
    /非普通文件/
  );
  await assert.rejects(
    validateCacheLocation(path.join(source, 'thumbnails', 'linked', 'cache')),
    /符号链接/
  );
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(source, 'covers', '42.webp'), 'utf8'), 'source');
});

test('reset cache rolls back all directories if its database transaction fails', async (t) => {
  const tmp = await fixture(t);
  initializeCache(tmp);
  await fs.writeFile(path.join(tmp, 'covers', '42.webp'), 'cover');
  await fs.writeFile(path.join(tmp, 'thumbnails', 'thumb.webp'), 'thumb');
  await assert.rejects(
    resetCacheFiles(tmp, () => {
      throw new Error('rollback');
    }),
    /rollback/
  );
  assert.equal((await cacheStats(tmp, tmp)).covers.count, 1);
  const result = await resetCacheFiles(tmp, () => {});
  assert.deepEqual(result, { removed: 2, bytes: 10 });
  assert.equal((await cacheStats(tmp, tmp)).covers.count, 0);
});

test(
  'worker migrates cached bytes and persistent paths, survives restart, resets safely and regenerates thumbnails',
  { timeout: 30000 },
  async (t) => {
    const tmp = await fixture(t),
      data = path.join(tmp, 'data'),
      source = path.join(tmp, 'collection'),
      chosen = path.join(tmp, 'custom');
    await fs.mkdir(source);
    const original = path.join(source, 'cover.png');
    await sharp({ create: { width: 180, height: 240, channels: 3, background: '#ff9900' } })
      .png()
      .toFile(original);
    const originalBytes = await fs.readFile(original);
    let c = await client(data);
    try {
      await c.call('scan', { path: source, match: false });
      const root = (await c.call('init')).roots[0];
      const image = idFor(original);
      await c.call('setCover', { id: root.id, imageId: image });
      await c.call('patch', {
        id: root.id,
        changes: { crop_x: 24, crop_y: 73, crop_zoom: 2, favorite: 1 }
      });
      const first = await c.call('thumb', { id: root.id, size: 512 });
      const thumbnailBytes = await fs.readFile(first.path);
      await c.stop();
      c = null;
      // Seed a downloaded bound cover and its metadata in this isolated database only.
      await sharp(original)
        .webp()
        .toFile(path.join(data, 'covers', '42.webp'));
      const db = new DatabaseSync(path.join(data, 'library.sqlite'));
      db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?,?)').run(
        42,
        JSON.stringify({
          id: 42,
          type: 2,
          local_cover: path.join(data, 'covers', '42.webp'),
          images: { large: 'https://lain.bgm.tv/pic/cover/l/42.jpg' }
        }),
        Date.now()
      );
      db.prepare('UPDATE nodes SET subject_id=42,manual_subject=1 WHERE id=?').run(root.id);
      db.close();
      await fs.writeFile(path.join(data, 'bangumi-token.enc'), 'encrypted-test-token');
      c = await client(data);
      const moved = await c.call('changeCacheDirectory', { path: chosen });
      assert.equal(moved.path, path.join(chosen, DIRECTORY_NAME));
      assert.equal(moved.defaultPath, data);
      assert.equal(moved.isDefault, false);
      const second = await c.call('thumb', { id: root.id, size: 512 });
      assert.deepEqual(await fs.readFile(second.path), thumbnailBytes);
      assert.equal(path.dirname(second.path), moved.thumbnails.path);
      assert.equal(
        (await c.call('get', { id: root.id })).metadata.local_cover,
        path.join(moved.covers.path, '42.webp')
      );
      await assert.rejects(c.call('scan', { path: chosen, match: false }), /不能互相包含/);
      await assert.rejects(
        c.call('scan', { path: moved.covers.path, match: false }),
        /不能互相包含/
      );
      await assert.rejects(c.call('changeCacheDirectory', { path: source }), /不能互相包含/);
      await c.stop();
      c = await client(data);
      assert.equal((await c.call('cacheInfo')).path, moved.path);
      const reset = await c.call('resetCacheDirectory');
      assert.equal(reset.path, data);
      assert.equal(reset.isDefault, true);
      assert.deepEqual(
        await fs.readFile((await c.call('thumb', { id: root.id, size: 512 })).path),
        thumbnailBytes
      );
      const result = await c.call('cleanCache', { mode: 'reset-cache' });
      assert.ok(result.removed >= 2);
      assert.equal((await c.call('cacheInfo')).covers.count, 0);
      const persisted = await c.call('get', { id: root.id });
      assert.equal(persisted.subject_id, 42);
      assert.equal(persisted.manual_subject, 1);
      assert.equal(persisted.manual_cover, 1);
      assert.equal(persisted.crop_x, 24);
      assert.equal(persisted.crop_y, 73);
      assert.equal(persisted.crop_zoom, 2);
      assert.equal(persisted.favorite, 1);
      assert.equal(persisted.metadata, null);
      assert.deepEqual(
        await fs.readFile((await c.call('thumb', { id: root.id, size: 512 })).path),
        thumbnailBytes
      );
      assert.deepEqual(await fs.readFile(original), originalBytes);
      assert.equal(
        await fs.readFile(path.join(data, 'bangumi-token.enc'), 'utf8'),
        'encrypted-test-token'
      );
    } finally {
      if (c) await c.stop();
    }
  }
);

test(
  'cleared bound covers can be downloaded again via refreshMetadata, and active network prevents relocation',
  { timeout: 30000 },
  async (t) => {
    const tmp = await fixture(t),
      data = path.join(tmp, 'data'),
      source = path.join(tmp, 'collection');
    await fs.mkdir(source);
    const image = await sharp({ create: { width: 60, height: 90, channels: 3, background: 'red' } })
      .png()
      .toBuffer();
    await fs.writeFile(path.join(source, 'image.png'), image);
    const setup = `
    const realNow = Date.now; let tick = 0;
    Date.now = () => realNow() + (++tick * 2000);
    global.fetch = async (input) => {
      await new Promise(resolve => setTimeout(resolve, 30));
      const url = String(input);
      if (url.startsWith('https://lain.bgm.tv/')) return new Response(Buffer.from('${image.toString('base64')}', 'base64'));
      if (url.endsWith('/persons')) return Response.json([]);
      if (url.endsWith('/subjects/42')) return Response.json({ id:42, type:2, name:'Test subject', images:{large:'https://lain.bgm.tv/pic/cover/l/42.jpg'} });
      throw new Error('Unexpected test URL');
    };
  `;
    const c = await client(data, setup);
    try {
      await c.call('scan', { path: source, match: false });
      const root = (await c.call('init')).roots[0];
      const binding = c.call('bind', { id: root.id, url: '42' });
      await assert.rejects(
        c.call('changeCacheDirectory', { path: path.join(tmp, 'custom') }),
        /稍后再试/
      );
      const bound = await binding;
      assert.equal(bound.metadata.local_cover, path.join(data, 'covers', '42.webp'));
      await c.call('patch', { id: root.id, changes: { crop_x: 31, crop_y: 64 } });
      await c.call('cleanCache', { mode: 'reset-cache' });
      const cleared = await c.call('get', { id: root.id });
      assert.equal(cleared.subject_id, 42);
      assert.equal(cleared.manual_subject, 1);
      assert.equal(cleared.cover, 'subject:42');
      assert.equal(cleared.crop_x, 31);
      assert.equal((await c.call('cacheInfo')).covers.count, 0);
      const restored = await c.call('refreshMetadata', { id: root.id });
      assert.equal(restored.metadata.resources_complete, true);
      assert.equal(restored.cover, 'subject:42');
      assert.equal(restored.crop_x, 31);
      assert.equal(restored.crop_y, 64);
      assert.equal((await c.call('cacheInfo')).covers.count, 1);
      assert.ok((await fs.stat((await c.call('thumb', { id: root.id })).path)).size > 0);
    } finally {
      await c.stop();
    }
  }
);

test(
  'worker rewrites subject-cover thumbnail keys and excludes concurrent cache writes',
  { timeout: 30000 },
  async (t) => {
    const tmp = await fixture(t),
      data = path.join(tmp, 'data'),
      source = path.join(tmp, 'collection');
    await fs.mkdir(source);
    await sharp({ create: { width: 60, height: 90, channels: 3, background: 'blue' } })
      .png()
      .toFile(path.join(source, 'image.png'));
    let c = await client(data);
    let root;
    try {
      await c.call('scan', { path: source, match: false });
      root = (await c.call('init')).roots[0];
    } finally {
      await c.stop();
    }
    await sharp(path.join(source, 'image.png'))
      .webp()
      .toFile(path.join(data, 'covers', '42.webp'));
    const db = new DatabaseSync(path.join(data, 'library.sqlite'));
    db.prepare(
      "UPDATE nodes SET subject_id=42,manual_subject=1,cover='subject:42',cover_source='bangumi' WHERE id=?"
    ).run(root.id);
    db.close();
    c = await client(data);
    try {
      const first = await c.call('thumb', { id: root.id, size: 512 });
      const contents = await fs.readFile(first.path);
      const moving = c.call('changeCacheDirectory', { path: path.join(tmp, 'custom') });
      await assert.rejects(c.call('thumb', { id: root.id, size: 768 }), /正在管理缓存/);
      const info = await moving;
      const next = await c.call('thumb', { id: root.id, size: 512 });
      assert.equal(path.dirname(next.path), info.thumbnails.path);
      assert.deepEqual(await fs.readFile(next.path), contents);
      assert.equal((await c.call('cacheInfo')).thumbnails.count, 1);
      const generating = c.call('thumb', { id: root.id, size: 768 });
      await assert.rejects(c.call('cleanCache', { mode: 'reset-cache' }), /稍后再试/);
      await generating;
    } finally {
      await c.stop();
    }
  }
);
