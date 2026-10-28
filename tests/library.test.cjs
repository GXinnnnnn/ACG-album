'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
sharp.cache({ files: 0 });
const { idFor } = require('../src/model.cjs');
async function client(dataDir, watch = false) {
  const w = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch }
  });
  let seq = 0;
  const pending = new Map(),
    events = new Set();
  const ready = new Promise((resolve, reject) => {
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event) for (const fn of events) fn(m);
      if (m.request) {
        const p = pending.get(m.request);
        if (!p) return;
        pending.delete(m.request);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
      }
    });
  });
  await ready;
  return {
    events,
    call: (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++seq;
        pending.set(request, { resolve, reject });
        w.postMessage({ request, method, args });
      }),
    stop: async () => {
      await w.terminate();
    }
  };
}
async function makeFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-test-')),
    source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(path.join(source, '星际牛仔 Cowboy Bebop', '设定集'), { recursive: true });
  await fs.mkdir(path.join(source, 'Album 10'));
  await fs.mkdir(path.join(source, 'Album 2'));
  const png = await sharp({
    create: {
      width: 640,
      height: 900,
      channels: 4,
      background: { r: 224, g: 161, b: 194, alpha: 0.6 }
    }
  })
    .png()
    .toBuffer();
  for (const rel of [
    'loose.png',
    '星际牛仔 Cowboy Bebop/01.png',
    '星际牛仔 Cowboy Bebop/设定集/透明角色.png',
    'Album 2/cover.png',
    'Album 10/cover.png'
  ])
    await fs.writeFile(path.join(source, rel), png);
  return { tmp, source, data, png };
}
async function cleanup(tmp) {
  assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'acg-test-')));
  await fs.rm(tmp, { recursive: true, force: true });
}
async function checksum(p) {
  return crypto
    .createHash('sha256')
    .update(await fs.readFile(p))
    .digest('hex');
}
test(
  'persistent nested library, manual overrides, thumbnails, search and source safety',
  { timeout: 30000 },
  async () => {
    const f = await makeFixture();
    let c = await client(f.data);
    try {
      await c.call('settings', { key: 'autoMatch', value: false });
      const result = await c.call('scan', { path: f.source });
      assert.equal(result.errors, 0);
      const root = (await c.call('init')).roots[0];
      assert.equal(root.files, 5);
      assert.equal(root.folders, 4);
      const children = await c.call('list', { parent: root.id });
      assert.equal(children.folders, 3);
      assert.deepEqual(
        children.items.slice(0, 2).map((x) => x.name),
        ['Album 2', 'Album 10']
      );
      assert.equal(children.items.at(-1).name, 'loose.png');
      assert.deepEqual(
        (await c.call('list', { parent: root.id, offset: 2, limit: 2 })).items.map((n) => n.name),
        ['星际牛仔 Cowboy Bebop', 'loose.png']
      );
      assert.deepEqual(
        (await c.call('list', { parent: root.id, direction: 'desc' })).items.map((n) => n.name),
        ['星际牛仔 Cowboy Bebop', 'Album 10', 'Album 2', 'loose.png']
      );
      const album = children.items.find((x) => x.name.startsWith('星际'));
      assert.equal(album.cover_source, 'fallback');
      assert.equal(album.confirmed, 0);
      await c.call('patch', { id: root.id, changes: { search_type: 2 } });
      assert.equal((await c.call('get', { id: album.id })).effective_search_type, 2);
      await c.call('patch', { id: album.id, changes: { search_type: 6 } });
      assert.equal((await c.call('get', { id: album.id })).effective_search_type, 6);
      assert.equal((await c.call('list', { search: 'Album', filter: 'pending' })).total, 2);
      assert.equal((await c.call('list', { filter: 'images' })).total, 5);
      await assert.rejects(() => c.call('patch', { id: album.id, changes: { search_type: 5 } }));
      assert.equal((await c.call('list', { search: '星际牛仔' })).total, 1);
      assert.equal((await c.call('list', { search: '星际 Cowboy' })).total, 1);
      assert.equal((await c.call('list', { search: '不存在' })).total, 0);
      const image = idFor(path.join(f.source, '星际牛仔 Cowboy Bebop', '设定集', '透明角色.png')),
        imagePath = path.join(f.source, '星际牛仔 Cowboy Bebop', '设定集', '透明角色.png');
      const hash = await checksum(imagePath);
      await c.call('setCover', { id: album.id, imageId: image });
      await c.call('patch', { id: album.id, changes: { crop_x: 23, crop_y: 72, favorite: 1 } });
      // Rapid viewport/overscan requests share work, including a later promotion
      // while other thumbnails occupy all bounded generation slots.
      const requests = [
        image,
        ...[
          'loose.png',
          'Album 2/cover.png',
          'Album 10/cover.png',
          '星际牛仔 Cowboy Bebop/01.png'
        ].map((rel) => idFor(path.join(f.source, rel))),
        image,
        album.id,
        album.id
      ];
      const thumbnails = await Promise.all(
        requests.map((id, i) => c.call('thumb', { id, priority: i >= 5 }))
      );
      const first = thumbnails[0];
      for (const i of [5, 6, 7]) assert.equal(thumbnails[i].path, first.path);
      for (const generated of thumbnails) {
        const info = await sharp(generated.path).metadata();
        assert.ok(info.width <= 1024 && info.height <= 1400 && info.hasAlpha);
      }
      const st = await fs.stat(first.path);
      assert.ok((await sharp(first.path).metadata()).hasAlpha);
      const small = await c.call('thumb', { id: album.id, size: 512 });
      const smallMeta = await sharp(small.path).metadata();
      assert.ok(smallMeta.width <= 512 && smallMeta.height <= 700 && smallMeta.hasAlpha);
      assert.notEqual(small.path, first.path);
      assert.equal((await c.call('cleanCache', { mode: 'unused' })).removed, 0);
      assert.equal((await c.call('list', { favorites: true, search: '星际' })).total, 1);
      assert.equal((await c.call('list', { favorites: true, search: 'Album' })).total, 0);
      await assert.rejects(
        () =>
          c.call('setCover', { id: album.id, imageId: idFor(path.join(f.source, 'loose.png')) }),
        /内部/
      );
      await c.call('scan', { path: f.source });
      const second = await c.call('thumb', { id: album.id });
      assert.equal(first.path, second.path);
      assert.equal(st.mtimeMs, (await fs.stat(second.path)).mtimeMs);
      let persisted = await c.call('get', { id: album.id });
      assert.equal(persisted.manual_cover, 1);
      assert.equal(persisted.crop_y, 72);
      assert.equal(await checksum(imagePath), hash);
      await c.stop();
      c = await client(f.data);
      persisted = await c.call('get', { id: album.id });
      assert.equal(persisted.cover, image);
      assert.equal(persisted.favorite, 1);
      assert.equal(persisted.crop_x, 23);
      assert.equal((await c.call('list', { search: '星际牛仔' })).total, 1);
      const nested = path.join(f.source, '星际牛仔 Cowboy Bebop', '未索引', '更深');
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(nested, '新封面.png'), f.png);
      await c.call('selectCoverPath', { id: album.id, file: path.join(nested, '新封面.png') });
      assert.equal(
        (await c.call('get', { id: idFor(path.join(nested, '新封面.png')) })).parent,
        idFor(nested)
      );
      assert.equal((await c.call('get', { id: root.id })).files, 6);
      const other = path.join(f.tmp, 'outside.png');
      await fs.writeFile(other, f.png);
      await assert.rejects(() => c.call('selectCoverPath', { id: album.id, file: other }), /内部/);
      const dead = path.join(f.source, 'Album 10', 'cover.png');
      assert.ok(dead.startsWith(f.source + path.sep));
      await fs.unlink(dead);
      await c.call('scan', { path: f.source });
      assert.equal((await c.call('get', { id: idFor(dead) })).missing, 1);
      assert.equal((await c.call('list', { search: 'cover.png' })).total, 1);
      const clean = await c.call('cleanCache', { mode: 'all-thumbnails' });
      assert.ok(clean.removed >= 1);
      assert.equal((await c.call('cacheInfo')).thumbnails.count, 0);
      assert.equal(await checksum(imagePath), hash);
      await c.call('removeRoot', { id: root.id });
      assert.equal((await c.call('init')).roots.length, 0);
      assert.equal(await checksum(imagePath), hash);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);
test(
  'automatic covers use local images without changing desktop.ini or manual choices',
  { timeout: 10000 },
  async () => {
    const f = await makeFixture(),
      c = await client(f.data);
    try {
      const folder = path.join(f.source, 'Album 2'),
        file = path.join(folder, 'desktop.ini'),
        ini = Buffer.from(
          '\uFEFF[.ShellClassInfo]\r\nIconResource="' +
            path.resolve('src/assets/app.ico') +
            '",0\r\n',
          'utf16le'
        );
      await fs.writeFile(file, ini);
      await c.call('scan', { path: f.source, offline: true });
      const id = idFor(folder);
      const imageId = idFor(path.join(folder, 'cover.png'));
      const automatic = await c.call('get', { id });
      assert.equal(automatic.cover_source, 'fallback');
      assert.equal(automatic.cover, imageId);
      assert.equal((await c.call('source', { id })).file, path.join(folder, 'cover.png'));
      await c.call('setCover', { id, imageId });
      await c.call('scan', { path: f.source, offline: true });
      const node = await c.call('get', { id });
      assert.equal(node.manual_cover, 1);
      assert.equal(node.cover, imageId);
      assert.deepEqual(await fs.readFile(file), ini);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);
test('cancel retains indexed data and accurate aggregates', { timeout: 30000 }, async () => {
  const f = await makeFixture(),
    c = await client(f.data);
  try {
    for (let i = 0; i < 900; i++)
      await fs.writeFile(path.join(f.source, 'Album 2', `image-${i}.png`), f.png);
    await c.call('settings', { key: 'autoMatch', value: false });
    let didCancel = false;
    c.events.add((m) => {
      if (m.event === 'progress' && m.data.images >= 48 && !didCancel) {
        didCancel = true;
        c.call('cancel');
      }
    });
    const result = await c.call('scan', { path: f.source });
    assert.equal(result.cancelled, true);
    const init = await c.call('init');
    assert.ok(init.stats.images > 0 && init.stats.images < 905);
    assert.equal(init.roots[0].files, init.stats.images);
    assert.ok((await c.call('list', { search: 'image-' })).total > 0);
  } finally {
    await c.stop();
    await cleanup(f.tmp);
  }
});
test(
  'native directory watcher incrementally indexes added and removed files',
  { timeout: 20000 },
  async () => {
    const f = await makeFixture(),
      c = await client(f.data, true);
    const events = [];
    c.events.add((m) => events.push(m));
    try {
      await c.call('settings', { key: 'autoMatch', value: false });
      await c.call('scan', { path: f.source });
      const target = path.join(f.source, 'Album 2', '新增监测.png');
      await fs.writeFile(target, f.png);
      async function until(predicate) {
        const end = Date.now() + 10000;
        while (Date.now() < end) {
          if (await predicate()) return;
          await new Promise((r) => setTimeout(r, 120));
        }
        assert.fail('directory watcher did not converge within 10s: ' + JSON.stringify(events));
      }
      await until(
        async () =>
          !!(await c.call('get', { id: idFor(target) })) &&
          (await c.call('init')).roots[0].files === 6
      );
      assert.equal((await c.call('list', { search: '新增监测' })).total, 1);
      assert.equal((await c.call('init')).roots[0].files, 6);
      assert.ok(target.startsWith(f.source + path.sep));
      await fs.unlink(target);
      await until(
        async () =>
          !!(await c.call('get', { id: idFor(target) }))?.missing &&
          (await c.call('init')).roots[0].files === 5
      );
      assert.equal((await c.call('list', { search: '新增监测' })).total, 0);
      assert.equal((await c.call('init')).roots[0].files, 5);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);
