'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const sharp = require('sharp');
const spec = require('../src/wallpaper-settings.cjs');
const {
  LIMITS,
  BUILTINS,
  createWallpaperService,
  wallpaperUrl,
  thumbnailUrl,
  parseWallpaperUrl,
  parseThumbnailUrl
} = require('../src/wallpaper.cjs');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const gallery = () => spec.normalize().wallpaperGallery;
const first = spec.builtinIds[0];
const second = spec.builtinIds[1];
const custom = 'custom-' + 'a'.repeat(64);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-gallery-data-owned-'));
  const dataDir = path.join(base, 'data');
  await fs.mkdir(dataDir);
  t.diagnostic('owned fixture: ' + base);
  return { base, dataDir, service: createWallpaperService({ dataDir }) };
}

async function image(file, width = 900, height = 300, color = '#89abcd') {
  await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toFile(file);
}

test('gallery defaults are bounded, deeply frozen and cloned independently by normalization', () => {
  assert.equal(spec.galleryLimit, 71);
  assert.equal(spec.defaults.wallpaperBlurAmount, 14);
  assert.deepEqual(gallery(), {
    version: 1,
    light: { hidden: [], order: [], crops: {} },
    dark: { hidden: [], order: [], crops: {} }
  });
  assert.ok(Object.isFrozen(spec.defaults.wallpaperGallery.light.hidden));
  assert.ok(Object.isFrozen(spec.defaults.wallpaperGallery.dark.crops));
  const input = gallery();
  input.light.hidden.push(first);
  input.dark.order.push(second);
  input.light.crops[custom] = { x: 12.5, y: 99, scale: 180 };
  assert.equal(spec.valid('wallpaperGallery', input), true);
  const normalized = spec.normalize({ wallpaperGallery: input }).wallpaperGallery;
  normalized.light.hidden.push(second);
  normalized.dark.order.reverse();
  normalized.light.crops[custom].scale = 50;
  assert.deepEqual(input.light.hidden, [first]);
  assert.equal(input.light.crops[custom].scale, 180);
  assert.notEqual(normalized.dark.order, input.dark.order);
  assert.deepEqual(spec.defaults.wallpaperGallery.light.hidden, []);
  assert.notEqual(gallery().light.crops, gallery().light.crops);
});

test('gallery rejects invalid shapes, unknown fields, unsafe IDs, aliases and prototype pollution', () => {
  const invalid = [undefined, null, [], {}, { ...gallery(), version: 2 }];
  const mutations = [
    (g) => {
      g.extra = 1;
    },
    (g) => {
      delete g.dark;
    },
    (g) => {
      delete g.light.order;
    },
    (g) => {
      g.light.path = 'C:/secret';
    },
    (g) => {
      g.light.hidden = [first, first];
    },
    (g) => {
      g.dark.order = [custom, custom];
    },
    (g) => {
      g.light.hidden = ['../file'];
    },
    (g) => {
      g.dark.order = ['acg-image://wallpaper/' + first];
    },
    (g) => {
      g.light.crops['__proto__'] = { x: 50, y: 50, scale: 100 };
    },
    (g) => {
      g.light.crops.constructor = { x: 50, y: 50, scale: 100 };
    },
    (g) => {
      g.light.crops['C:/secret'] = { x: 50, y: 50, scale: 100 };
    },
    (g) => {
      g.light.crops[first] = { x: 50, y: 50, scale: 100, path: 'private' };
    },
    (g) => {
      g.light.crops[first] = { x: 50, scale: 100 };
    },
    (g) => {
      g.light.crops[first] = { x: '50', y: 50, scale: 100 };
    },
    (g) => {
      g.light.crops[first] = { x: 0, y: 50, scale: 301 };
    },
    (g) => {
      g.light.crops[first] = { x: -1, y: 50, scale: 100 };
    },
    (g) => {
      g.light.crops[first] = { x: 50, y: NaN, scale: 100 };
    },
    (g) => {
      g.light.crops[first] = { x: 50, y: 50, scale: Infinity };
    },
    (g) => {
      g.dark.crops = [];
    },
    (g) => {
      Object.setPrototypeOf(g.light, { hidden: [] });
    },
    (g) => {
      Object.setPrototypeOf(g.light.crops, { [first]: { x: 0, y: 0, scale: 50 } });
    },
    (g) => {
      g.light.hidden.length = 1;
    },
    (g) => {
      g.light.order.extra = first;
    },
    (g) => {
      g[Symbol('unknown')] = 1;
    },
    (g) => {
      Object.defineProperty(g.light.crops, first, {
        get() {
          throw new Error('must not read accessor');
        }
      });
    }
  ];
  for (const mutate of mutations) {
    const value = gallery();
    mutate(value);
    invalid.push(value);
  }
  invalid.push(
    JSON.parse(
      '{"version":1,"light":{"hidden":[],"order":[],"crops":{"__proto__":{"x":0,"y":0,"scale":50}}},"dark":{"hidden":[],"order":[],"crops":{}}}'
    )
  );
  for (const value of invalid) {
    assert.equal(spec.valid('wallpaperGallery', value), false);
    assert.deepEqual(spec.normalize({ wallpaperGallery: value }).wallpaperGallery, gallery());
  }
  assert.equal({}.x, undefined);
});

test('gallery permits exactly 71 valid IDs per collection and enforces nested crop boundaries', () => {
  const ids = spec.builtinIds.concat(
    Array.from({ length: 65 }, (_, i) => 'custom-' + i.toString(16).padStart(64, '0'))
  );
  for (const count of [71, 72]) {
    for (const field of ['hidden', 'order', 'crops']) {
      const value = gallery();
      value.light[field] =
        field === 'crops'
          ? Object.fromEntries(ids.slice(0, count).map((id) => [id, { x: 0, y: 100, scale: 50 }]))
          : ids.slice(0, count);
      assert.equal(spec.valid('wallpaperGallery', value), count === 71, field + ':' + count);
    }
  }
  const value = gallery();
  value.light.crops[first] = { x: 0, y: 100, scale: 50 };
  value.dark.crops[first] = { x: 100, y: 0, scale: 300 };
  assert.equal(spec.valid('wallpaperGallery', value), true);
  for (const blur of [0, 14, 27.5, 40]) assert.equal(spec.valid('wallpaperBlurAmount', blur), true);
  for (const blur of [-1, 41, NaN, Infinity, '14', null])
    assert.equal(spec.valid('wallpaperBlurAmount', blur), false);
});

test('theme and image crops remain independent while missing crops preserve legacy global settings', () => {
  const settings = {
    wallpaperPositionX: 23,
    wallpaperPositionY: 81,
    wallpaperScale: 144,
    wallpaperGallery: gallery()
  };
  const legacy = { x: 23, y: 81, scale: 144 };
  assert.deepEqual(spec.cropFor(settings, 'light', first), legacy);
  assert.deepEqual(spec.cropFor(settings, 'dark', custom), legacy);
  settings.wallpaperGallery.light.crops[first] = { x: 0, y: 100, scale: 50 };
  settings.wallpaperGallery.dark.crops[first] = { x: 100, y: 0, scale: 300 };
  assert.deepEqual(spec.cropFor(settings, 'light', first), { x: 0, y: 100, scale: 50 });
  assert.deepEqual(spec.cropFor(settings, 'dark', first), { x: 100, y: 0, scale: 300 });
  assert.deepEqual(spec.cropFor(settings, 'light', second), legacy);
  spec.cropFor(settings, 'light', first).x = 77;
  assert.equal(settings.wallpaperGallery.light.crops[first].x, 0);
  assert.deepEqual(spec.cropFor({ ...settings, wallpaperGallery: {} }, 'light', first), legacy);
  assert.deepEqual(spec.cropFor({ wallpaperPositionX: '23', wallpaperScale: 301 }, 'dark', first), {
    x: 50,
    y: 50,
    scale: 100
  });
  assert.deepEqual(spec.cropFor(settings, '__proto__', first), legacy);
  assert.equal(spec.normalize(settings).wallpaperPositionX, 23);
});

test('thumbnail URLs use a separate strict parser and reject canonicalized paths and renderer arguments', async (t) => {
  const { service } = await fixture(t);
  assert.equal(parseThumbnailUrl(thumbnailUrl(first)), first);
  assert.equal(parseWallpaperUrl(thumbnailUrl(first)), null);
  assert.equal(parseThumbnailUrl(wallpaperUrl(first)), null);
  assert.equal(thumbnailUrl('C:/secret'), null);
  for (const url of [
    'https://wallpaper-thumb/' + first,
    'acg-image://wallpaper-thumb/' + first + '/',
    'acg-image://wallpaper-thumb/' + first + '?path=C:/secret',
    'acg-image://wallpaper-thumb/' + first + '#hash',
    'acg-image://wallpaper-thumb/../' + first,
    'acg-image://wallpaper-thumb/%2e%2e/' + first,
    'acg-image://wallpaper-thumb/%62uiltin-bilibili-01',
    'acg-image://wallpaper-thumb/other/../' + first,
    'acg-image://user@wallpaper-thumb/' + first,
    'acg-image://wallpaper-thumb:80/' + first,
    'acg-image://wallpaper-thumb//C:/secret',
    'acg-image://wallpaper-thumb/..\\' + first,
    'acg-image://wallpaper-thumb/' + first + '%00',
    'acg-image://wallpaper-thumb/builtin-bilibili-08'
  ]) {
    assert.equal(parseThumbnailUrl(url), null, url);
    assert.equal((await service.response({ url })).status, 400, url);
  }
  assert.equal((await service.response({ url: thumbnailUrl(first), method: 'POST' })).status, 405);
  assert.equal((await service.response({ url: thumbnailUrl(custom) })).status, 404);
});

test('real sharp thumbnails fit inside 360x240, are metadata-free WebP, preserve originals and validate cached sources', async (t) => {
  const { service, base, dataDir } = await fixture(t);
  const original = path.join(base, 'source-landscape.png');
  await image(original);
  const before = await fs.readFile(original);
  const imported = await service.importFile(original);
  const entries = await service.list();
  assert.equal(entries.length, 8);
  for (const entry of entries) {
    assert.equal(entry.thumbnailUrl, thumbnailUrl(entry.id));
    const response = await service.response({ url: entry.thumbnailUrl, method: 'GET' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/webp');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const encoded = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), encoded.length);
    const meta = await sharp(encoded).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.pages || 1, 1);
    assert.equal(meta.exif, undefined);
    assert.ok(meta.width <= 360 && meta.height <= 240);
    const head = await service.response({ url: entry.thumbnailUrl, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(Number(head.headers.get('content-length')), encoded.length);
  }
  const thumbnail = Buffer.from(
    await (await service.response({ url: imported.thumbnailUrl })).arrayBuffer()
  );
  const meta = await sharp(thumbnail).metadata();
  assert.equal(meta.width, 360);
  assert.equal(meta.height, 120, 'fit inside preserves the original aspect ratio');
  const portrait = path.join(base, 'portrait.png');
  await image(portrait, 100, 500, 'purple');
  const portraitEntry = await service.importFile(portrait);
  const portraitMeta = await sharp(
    Buffer.from(await (await service.response({ url: portraitEntry.thumbnailUrl })).arrayBuffer())
  ).metadata();
  assert.equal(portraitMeta.width, 48);
  assert.equal(portraitMeta.height, 240);
  assert.deepEqual(await fs.readFile(original), before);
  const managed = path.join(dataDir, 'wallpapers', imported.id + '.webp');
  await fs.writeFile(
    managed,
    await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } })
      .webp()
      .toBuffer()
  );
  assert.equal(
    (await service.response({ url: imported.thumbnailUrl })).status,
    415,
    'cached thumbnail cannot bypass content integrity'
  );
  assert.deepEqual(await fs.readFile(original), before);
  assert.equal(LIMITS.fileBytes, 40 * 1024 * 1024);
  assert.equal(LIMITS.inputPixels, 80000000);
  assert.equal(LIMITS.thumbnailCacheEntries, 72);
  assert.equal(LIMITS.thumbnailCacheBytes, 16 * 1024 * 1024);
});

test('custom entries use stable creation order, retain source names and deduplicate without metadata rewrites', async (t) => {
  const { service, base, dataDir } = await fixture(t);
  const firstFile = path.join(base, 'first original.png');
  const secondFile = path.join(base, 'second original.png');
  await image(firstFile, 30, 20, 'red');
  await image(secondFile, 30, 20, 'blue');
  const start = Date.now();
  const one = await service.importFile(firstFile);
  const two = await service.importFile(secondFile);
  assert.ok(one.createdAt >= start && two.createdAt >= one.createdAt);
  assert.equal(one.sourceName, 'first original.png');
  assert.equal(two.sourceName, 'second original.png');
  const metadataFile = path.join(dataDir, 'wallpapers', one.id + '.json');
  const originalMetadata = await fs.readFile(metadataFile);
  assert.equal(JSON.parse(originalMetadata).createdAt, one.createdAt);
  assert.equal(
    hash(await fs.readFile(path.join(dataDir, 'wallpapers', one.id + '.webp'))),
    one.id.slice(7)
  );
  const originalList = await service.list();
  const before = originalList.filter((entry) => !entry.builtin);
  assert.deepEqual(
    before.map((entry) => entry.id),
    [one, two]
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((entry) => entry.id)
  );
  assert.deepEqual(
    before.map((entry) => entry.name),
    ['自定义01', '自定义02']
  );
  assert.deepEqual(
    await service.importFile(firstFile),
    before.find((entry) => entry.id === one.id)
  );
  assert.deepEqual(await fs.readFile(metadataFile), originalMetadata);
  assert.deepEqual(await service.list(), originalList);
  assert.deepEqual(await createWallpaperService({ dataDir }).list(), originalList);
  assert.deepEqual(
    originalList.slice(0, 7).map((entry) => entry.name),
    ['壁纸01', '壁纸02', '壁纸03', '壁纸04', '壁纸05', '壁纸06', '壁纸07']
  );
  assert.equal(originalList[0].sourceName, BUILTINS[0].sourceName);
  assert.equal(JSON.stringify(originalList).includes(base), false);
});

test('legacy custom metadata falls back to file birthtime/mtime without rewrites and timestamp ties sort deterministically', async (t) => {
  const { service, base, dataDir } = await fixture(t);
  const file = path.join(base, 'legacy.png');
  await image(file, 22, 30, 'yellow');
  const entry = await service.importFile(file);
  const managed = path.join(dataDir, 'wallpapers');
  const metadataFile = path.join(managed, entry.id + '.json');
  const oldMetadata = JSON.stringify({ name: 'legacy source.jpg' });
  await fs.writeFile(metadataFile, oldMetadata);
  const stat = await fs.lstat(path.join(managed, entry.id + '.webp'));
  const legacy = (await service.list()).find((candidate) => candidate.id === entry.id);
  assert.equal(legacy.createdAt, stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs);
  assert.equal(legacy.sourceName, 'legacy source.jpg');
  assert.equal((await service.importFile(file)).createdAt, legacy.createdAt);
  assert.equal(await fs.readFile(metadataFile, 'utf8'), oldMetadata);
  const otherFile = path.join(base, 'other.png');
  await image(otherFile, 20, 30, 'green');
  const other = await service.importFile(otherFile);
  for (const item of [entry, other])
    await fs.writeFile(
      path.join(managed, item.id + '.json'),
      JSON.stringify({ name: item.sourceName, createdAt: 1000 })
    );
  const tied = (await service.list()).filter((candidate) => !candidate.builtin);
  assert.deepEqual(
    tied.map((candidate) => candidate.id),
    [entry.id, other.id].sort()
  );
  assert.deepEqual(await createWallpaperService({ dataDir }).list(), await service.list());
});

test('thumbnail cache does not serve linked managed files or redirected managed directories', async (t) => {
  const { service, base, dataDir } = await fixture(t);
  const original = path.join(base, 'original.png');
  await image(original, 60, 40);
  const entry = await service.importFile(original);
  assert.equal((await service.response({ url: entry.thumbnailUrl })).status, 200);
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  const redirected = path.join(base, 'redirected-data');
  await fs.mkdir(redirected);
  await fs.symlink(
    outside,
    path.join(redirected, 'wallpapers'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  const unsafe = createWallpaperService({ dataDir: redirected });
  assert.equal((await unsafe.response({ url: entry.thumbnailUrl })).status, 415);
  assert.deepEqual(await fs.readdir(outside), []);
  // A file symlink, when supported by the host, must fail before decoding too.
  const linkedId = 'custom-' + 'b'.repeat(64);
  try {
    await fs.symlink(
      path.join(dataDir, 'wallpapers', entry.id + '.webp'),
      path.join(dataDir, 'wallpapers', linkedId + '.webp'),
      'file'
    );
  } catch (error) {
    if (error.code === 'EPERM') {
      t.diagnostic('file symlink requires unavailable Windows privilege');
      return;
    }
    throw error;
  }
  assert.equal((await service.response({ url: thumbnailUrl(linkedId) })).status, 415);
});
