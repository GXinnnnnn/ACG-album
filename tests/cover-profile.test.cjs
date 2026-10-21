'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  { Worker } = require('node:worker_threads'),
  sharp = require('sharp'),
  { idFor } = require('../src/model.cjs');
async function client(dataDir) {
  const w = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
      workerData: { dataDir, watch: false }
    }),
    pending = new Map(),
    events = [];
  let seq = 0;
  await new Promise((resolve, reject) => {
    w.on('error', reject);
    w.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event) events.push(m);
      if (m.request) {
        const p = pending.get(m.request);
        pending.delete(m.request);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  return {
    events,
    call: (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++seq;
        pending.set(request, { resolve, reject });
        w.postMessage({ request, method, args });
      }),
    stop: () => w.terminate()
  };
}
async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-cover-profile-')),
    source = path.join(tmp, 'source'),
    album = path.join(source, '作品'),
    folder = path.join(album, '设定集'),
    file = path.join(folder, '透明角色.png');
  await fs.mkdir(folder, { recursive: true });
  const png = await sharp({
    create: { width: 640, height: 900, channels: 4, background: '#eeaacc88' }
  })
    .png()
    .toBuffer();
  await fs.writeFile(file, png);
  return { tmp, source, album, file, png, data: path.join(tmp, 'data') };
}
async function cleanup(tmp) {
  assert.ok(
    path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep + 'acg-cover-profile-')
  );
  await fs.rm(tmp, { recursive: true, force: true });
}
test(
  'indexed cover selection reuses records, detects changed images, and emits targeted events',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      c = await client(f.data);
    try {
      await c.call('scan', { path: f.source, offline: true });
      const folder = idFor(f.album),
        imageId = idFor(f.file),
        root = idFor(f.source),
        imageBefore = await c.call('get', { id: imageId }),
        rootBefore = await c.call('get', { id: root });
      const selected = await c.call('selectCoverPath', { id: folder, file: f.file });
      assert.equal(selected.cover, imageId);
      assert.equal(selected.confirmed, 1);
      assert.equal(selected.manual_cover, 1);
      assert.equal((await c.call('get', { id: imageId })).indexed, imageBefore.indexed);
      assert.equal((await c.call('get', { id: root })).files, rootBefore.files);
      assert.ok(
        c.events.some((m) => m.event === 'changed' && m.data.id === folder && m.data.cover === true)
      );
      const cached = await c.call('thumb', { id: folder, size: 512, priority: true });
      assert.equal((await c.call('thumb', { id: imageId, size: 512 })).path, cached.path);
      await fs.writeFile(
        f.file,
        await sharp({ create: { width: 800, height: 600, channels: 3, background: '#aaccee' } })
          .png()
          .toBuffer()
      );
      const reselected = await c.call('selectCoverPath', { id: folder, file: f.file });
      assert.notEqual(reselected.cover_revision, selected.cover_revision);
      const changed = await c.call('get', { id: imageId });
      assert.notEqual(changed.bytes, imageBefore.bytes);
      assert.equal((await c.call('get', { id: root })).files, rootBefore.files);
      assert.notEqual(
        (await c.call('thumb', { id: folder, size: 512, priority: true })).path,
        cached.path
      );
      assert.equal((await c.call('list', { search: '透明角色' })).total, 1);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);
test(
  'automatic covers use image mtime, direct-image precedence and the newest descendant without touching manual edits',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      c = await client(f.data);
    try {
      const base = 1700000000;
      await fs.utimes(f.file, base + 100, base + 100);
      const files = ['a-oldest.png', '作品.png', 'folder.ico', 'z-newest.png'];
      for (let i = 0; i < files.length; i++) {
        const file = path.join(f.album, files[i]);
        await fs.writeFile(file, f.png);
        await fs.utimes(file, base + i, base + i);
      }
      const ini = Buffer.from(
        '\uFEFF[.ShellClassInfo]\r\nIconResource=folder.ico,0\r\n',
        'utf16le'
      );
      const iniFile = path.join(f.album, 'desktop.ini');
      await fs.writeFile(iniFile, ini);
      await c.call('scan', { path: f.source, offline: true });
      const albumId = idFor(f.album),
        rootId = idFor(f.source);
      let node = await c.call('get', { id: albumId });
      assert.equal(node.cover, idFor(path.join(f.album, 'z-newest.png')));
      assert.equal(node.cover_source, 'fallback');
      assert.deepEqual([node.crop_x, node.crop_y, node.crop_zoom], [50, 50, 1]);
      assert.equal(
        (await c.call('get', { id: rootId })).cover,
        idFor(f.file),
        'image-less ancestor inherits newest actual descendant, not an album cover'
      );
      await c.call('patch', {
        id: albumId,
        changes: { crop_x: 31, crop_y: 67, crop_zoom: 1.8, favorite: 1, intro: 0 }
      });
      const named = path.join(f.album, '作品.png');
      await fs.utimes(named, base + 200, base + 200);
      await c.call('scan', { path: f.source, offline: true });
      node = await c.call('get', { id: albumId });
      assert.equal(node.cover, idFor(named));
      assert.deepEqual(
        [node.crop_x, node.crop_y, node.crop_zoom, node.favorite, node.intro],
        [31, 67, 1.8, 1, 0]
      );
      const manual = idFor(path.join(f.album, 'a-oldest.png'));
      await c.call('setCover', { id: albumId, imageId: manual });
      const latest = path.join(f.album, 'zz-newer.png');
      await fs.writeFile(latest, f.png);
      await fs.utimes(latest, base + 300, base + 300);
      await c.call('scan', { path: f.source, offline: true });
      node = await c.call('get', { id: albumId });
      assert.equal(node.manual_cover, 1);
      assert.equal(node.cover, manual);
      assert.equal((await c.call('get', { id: rootId })).cover, idFor(latest));
      await fs.utimes(f.file, base + 500, base + 500);
      await c.call('scan', { path: f.source, target: path.dirname(f.file), offline: true });
      assert.equal((await c.call('get', { id: rootId })).cover, idFor(f.file));
      assert.equal((await c.call('get', { id: albumId })).cover, manual);
      assert.deepEqual(await fs.readFile(iniFile), ini);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);

test(
  'equal image mtimes use a stable name tie-break and refresh descendant selection after removal',
  { timeout: 15000 },
  async () => {
    const f = await fixture(),
      c = await client(f.data);
    try {
      const child = path.dirname(f.file),
        other = path.join(child, 'a-equal.png');
      await fs.writeFile(other, f.png);
      for (const file of [f.file, other]) await fs.utimes(file, 1700000200, 1700000200);
      for (let i = 0; i < 2; i++) {
        await c.call('scan', { path: f.source, offline: true });
        assert.equal((await c.call('get', { id: idFor(f.source) })).cover, idFor(other));
      }
      assert.ok(path.resolve(other).startsWith(path.resolve(f.tmp) + path.sep));
      await fs.rm(other);
      await c.call('scan', { path: f.source, offline: true });
      assert.equal((await c.call('get', { id: idFor(f.source) })).cover, idFor(f.file));
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);

test(
  'legacy profiles lazily initialize newest-descendant pointers when resetting a cover',
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    let c = await client(f.data);
    try {
      const newest = path.join(path.dirname(f.file), 'z-newest.png');
      await fs.writeFile(newest, f.png);
      await fs.utimes(f.file, 1700000000, 1700000000);
      await fs.utimes(newest, 1700000300, 1700000300);
      await c.call('scan', { path: f.source, offline: true });
      await c.call('setCover', { id: idFor(f.album), imageId: idFor(f.file) });
      await c.stop();
      const databasePath = path.join(f.data, 'library.sqlite');
      assert.ok(path.resolve(databasePath).startsWith(path.resolve(f.tmp) + path.sep));
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(databasePath);
      db.exec("UPDATE nodes SET local_newest=NULL WHERE kind='folder'");
      db.close();
      c = await client(f.data);
      const reset = await c.call('resetCover', { id: idFor(f.album) });
      assert.equal(reset.cover, idFor(newest));
      assert.equal(reset.manual_cover, 0);
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);

test(
  'personal identity and sidebar preferences validate and persist',
  { timeout: 10000 },
  async () => {
    const f = await fixture();
    let c = await client(f.data);
    try {
      assert.equal((await c.call('init')).settings.nickname, '新朋友');
      await c.call('settings', { key: 'nickname', value: '  玖玖瑠 · 星光  ' });
      await c.call('settings', { key: 'sidebarMode', value: 'compact' });
      const avatar =
        'data:image/webp;base64,' +
        (await sharp(f.png).resize(128, 128).webp().toBuffer()).toString('base64');
      await c.call('settings', { key: 'avatar', value: avatar });
      await assert.rejects(() => c.call('settings', { key: 'nickname', value: ' ' }));
      await assert.rejects(() => c.call('settings', { key: 'nickname', value: 'x'.repeat(25) }));
      await assert.rejects(() =>
        c.call('settings', { key: 'avatar', value: 'file:///private.png' })
      );
      await assert.rejects(() => c.call('settings', { key: 'sidebarMode', value: 'unsupported' }));
      await c.stop();
      c = await client(f.data);
      const settings = (await c.call('init')).settings;
      assert.equal(settings.nickname, '玖玖瑠 · 星光');
      assert.equal(settings.avatar, avatar);
      assert.equal(settings.sidebarMode, 'compact');
    } finally {
      await c.stop();
      await cleanup(f.tmp);
    }
  }
);
