'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const sharp = require('sharp');
const {
  LIMITS,
  BUILTINS,
  wallpaperUrl,
  parseWallpaperUrl,
  normalizeImageFile,
  createWallpaperService,
  registerWallpaperHandlers
} = require('../src/wallpaper.cjs');
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-wallpaper-owned-'));
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  t.diagnostic('owned fixture: ' + base);
  return { base, dataDir, service: createWallpaperService({ dataDir }) };
}
async function image(file) {
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#89abcd' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(file);
}

test('strict wallpaper URLs reject escaping, traversal, credentials, query and external paths', () => {
  const valid = BUILTINS[0].id;
  assert.equal(parseWallpaperUrl(wallpaperUrl(valid)), valid);
  assert.equal(wallpaperUrl('file:///secret'), null);
  for (const url of [
    'https://wallpaper/' + valid,
    'acg-image://wallpaper/' + valid + '/',
    'acg-image://wallpaper/' + valid + '?path=C:/secret',
    'acg-image://wallpaper/' + valid + '#hash',
    'acg-image://wallpaper/../' + valid,
    'acg-image://wallpaper/%2e%2e/' + valid,
    'acg-image://wallpaper/%62uiltin-bilibili-01',
    'acg-image://wallpaper/other/../' + valid,
    'acg-image://user@wallpaper/' + valid,
    'acg-image://wallpaper:80/' + valid,
    'acg-image://wallpaper//C:/secret',
    'acg-image://wallpaper/..\\' + valid,
    'acg-image://wallpaper/' + valid + '%00',
    'acg-image://wallpaper/builtin-bilibili-08'
  ])
    assert.equal(parseWallpaperUrl(url), null, url);
});

test('seven bundled images serve static WebP with intended light/dark IDs and safe response headers', async (t) => {
  const f = await fixture(t);
  const list = await f.service.list();
  assert.equal(list.length, 7);
  assert.equal(list.find((x) => x.theme === 'light').name, '壁纸05');
  assert.equal(list.find((x) => x.theme === 'light').sourceName, '壁纸 (1).jpg');
  assert.equal(list.find((x) => x.theme === 'dark').name, '壁纸07');
  assert.equal(list.find((x) => x.theme === 'dark').sourceName, '拜年祭2020壁纸 (1).jpg');
  for (const entry of list) {
    assert.equal(entry.builtin, true);
    const response = await f.service.response({ url: entry.url, method: 'GET' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const data = Buffer.from(await response.arrayBuffer());
    const metadata = await sharp(data).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.pages || 1, 1);
    assert.equal(metadata.exif, undefined);
    assert.ok(Math.max(metadata.width, metadata.height) <= LIMITS.outputEdge);
  }
  const head = await f.service.response({ url: list[0].url, method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal((await f.service.response({ url: list[0].url, method: 'POST' })).status, 405);
  assert.equal((await f.service.response({ url: list[0].url + '?x=1' })).status, 400);
  assert.equal(
    (await f.service.response({ url: wallpaperUrl('custom-' + '0'.repeat(64)) })).status,
    404
  );
});

test('custom import copies/normalizes without changing original; list and protocol expose no local path', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.base, 'chosen-original.jpg');
  await image(original);
  const before = await fs.readFile(original);
  const entry = await f.service.importFile(original);
  assert.match(entry.id, /^custom-[a-f0-9]{64}$/);
  assert.equal(entry.name, '自定义01');
  assert.equal(entry.sourceName, 'chosen-original.jpg');
  assert.ok(Number.isSafeInteger(entry.createdAt) && entry.createdAt > 0);
  assert.equal(entry.builtin, false);
  assert.deepEqual(await fs.readFile(original), before);
  assert.equal(JSON.stringify(entry).includes(f.base), false);
  const managed = path.join(f.dataDir, 'wallpapers', entry.id + '.webp');
  const data = await fs.readFile(managed);
  assert.equal(hash(data), entry.id.slice(7));
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.width, 24, 'EXIF rotation was applied');
  assert.equal(metadata.height, 32);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.deepEqual(
    await f.service.importFile(original),
    entry,
    'duplicate content is deduplicated'
  );
  const fresh = createWallpaperService({ dataDir: f.dataDir });
  assert.deepEqual(
    (await fresh.list()).find((x) => x.id === entry.id),
    entry
  );
  const response = await fresh.response({ url: entry.url });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  await fs.writeFile(managed, Buffer.from('<svg onload="alert(1)"/>'));
  assert.equal((await fresh.response({ url: entry.url })).status, 415);
  await fs.writeFile(
    managed,
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .webp()
      .toBuffer()
  );
  assert.equal(
    (await fresh.response({ url: entry.url })).status,
    415,
    'changed WebP must match content ID'
  );
});

test('import rejects disguised SVG, invalid raster, oversized files, pixels and input edge', async (t) => {
  const f = await fixture(t);
  const svg = path.join(f.base, 'looks-like-jpeg.jpg');
  await fs.writeFile(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><image href="file:///secret"/></svg>'
  );
  await assert.rejects(f.service.importFile(svg), { code: 'WALLPAPER_INVALID' });
  const bad = path.join(f.base, 'broken.png');
  await fs.writeFile(bad, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2]));
  await assert.rejects(normalizeImageFile(bad), { code: 'WALLPAPER_INVALID' });
  const big = path.join(f.base, 'oversize.jpg');
  const handle = await fs.open(big, 'w');
  try {
    await handle.truncate(LIMITS.fileBytes + 1);
  } finally {
    await handle.close();
  }
  await assert.rejects(normalizeImageFile(big), { code: 'WALLPAPER_INVALID' });
  const wide = path.join(f.base, 'wide.png');
  await sharp({
    create: { width: LIMITS.inputEdge + 1, height: 1, channels: 3, background: 'red' }
  })
    .png()
    .toFile(wide);
  await assert.rejects(normalizeImageFile(wide), { code: 'WALLPAPER_INVALID' });
  const bomb = path.join(f.base, 'over-pixels.png');
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } })
    .png()
    .toBuffer();
  png.writeUInt32BE(9000, 16);
  png.writeUInt32BE(9000, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  await fs.writeFile(bomb, png);
  await assert.rejects(normalizeImageFile(bomb), { code: 'WALLPAPER_INVALID' });
  assert.equal((await f.service.list()).length, 7);
});

test('animated input becomes one static frame and the custom file count is bounded', async (t) => {
  const f = await fixture(t);
  const original = path.join(f.base, 'animated.gif');
  await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), {
    raw: { width: 1, height: 2, channels: 3, pageHeight: 1 }
  })
    .gif({ loop: 0, delay: [100, 100] })
    .toFile(original);
  assert.equal((await sharp(original, { animated: true }).metadata()).pages, 2);
  const entry = await f.service.importFile(original);
  const managed = path.join(f.dataDir, 'wallpapers');
  const metadata = await sharp(path.join(managed, entry.id + '.webp')).metadata();
  assert.equal(metadata.pages || 1, 1);
  assert.equal(metadata.height, 1);
  for (let index = 0; index < LIMITS.customFiles - 1; index++) {
    const id = 'custom-' + index.toString(16).padStart(64, '0');
    await fs.writeFile(path.join(managed, id + '.webp'), 'owned count-limit fixture');
  }
  const other = path.join(f.base, 'other.png');
  await sharp({ create: { width: 2, height: 3, channels: 3, background: 'green' } })
    .png()
    .toFile(other);
  await assert.rejects(f.service.importFile(other), /64 张/);
  assert.equal((await f.service.list()).filter((x) => !x.builtin).length, 64);
  assert.deepEqual(
    await f.service.importFile(original),
    entry,
    'deduplication still works at the cap'
  );
});

test('managed listing ignores unrelated files and fails closed for redirected wallpaper directory', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.dataDir, 'wallpapers');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'outside.jpg'), 'private unrelated file');
  await fs.mkdir(path.join(directory, 'custom-' + 'a'.repeat(64) + '.webp'));
  assert.equal((await f.service.list()).length, 7);
  const g = await fixture(t);
  const outside = path.join(g.base, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(
    outside,
    path.join(g.dataDir, 'wallpapers'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(g.service.list(), { code: 'WALLPAPER_INVALID' });
  const original = path.join(g.base, 'safe.jpg');
  await image(original);
  await assert.rejects(g.service.importFile(original), { code: 'WALLPAPER_INVALID' });
  assert.deepEqual(await fs.readdir(outside), []);
  assert.equal(
    (await g.service.response({ url: wallpaperUrl('custom-' + 'a'.repeat(64)) })).status,
    415
  );
});

test('native-dialog IPC rejects renderer arguments before dialog, handles cancel and serializes imports', async () => {
  const handlers = new Map();
  const imported = [];
  let choose;
  const service = {
    list: async () => ['safe-list'],
    importFile: async (file) => {
      imported.push(file);
      return { id: 'selected' };
    }
  };
  registerWallpaperHandlers({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    dialog: {
      showOpenDialog: async (_win, options) => {
        assert.deepEqual(options.properties, ['openFile', 'dontAddToRecent']);
        return choose();
      }
    },
    getWindow: () => ({}),
    service
  });
  choose = () => {
    throw new Error('Dialog must not be opened for renderer arguments');
  };
  for (const args of [
    { path: 'C:/secret' },
    { url: 'file:///secret' },
    { id: 'custom' },
    null,
    [],
    'C:/secret'
  ]) {
    for (const channel of ['library:wallpaperList', 'library:wallpaperImport'])
      await assert.rejects(handlers.get(channel)({}, args), { code: 'WALLPAPER_INVALID' });
  }
  assert.deepEqual(imported, []);
  assert.deepEqual(await handlers.get('library:wallpaperList')({}, {}), ['safe-list']);
  choose = async () => ({ canceled: true, filePaths: [] });
  assert.equal(await handlers.get('library:wallpaperImport')({}, {}), null);
  assert.deepEqual(imported, []);
  let release;
  choose = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = handlers.get('library:wallpaperImport')({}, {});
  await assert.rejects(handlers.get('library:wallpaperImport')({}, {}), {
    code: 'WALLPAPER_INVALID'
  });
  release({ canceled: false, filePaths: ['native-chosen.png'] });
  assert.deepEqual(await first, { id: 'selected' });
  assert.deepEqual(imported, ['native-chosen.png']);
});
