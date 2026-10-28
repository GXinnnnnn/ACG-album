'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const sharp = require('sharp');
const { createImagePreview, sniffImage } = require('../src/image-preview.cjs');
const id = 'a'.repeat(24);
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-image-preview-'));
  const cache = path.join(root, 'cache');
  const services = [];
  const service = (overrides = {}) => {
    const result = createImagePreview({ cacheDir: cache, ...options, ...overrides });
    services.push(result);
    return result;
  };
  t.after(async () => {
    for (const s of services) await s.stop();
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('acg-image-preview-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    cache,
    service,
    async file(name, data) {
      const file = path.join(root, name);
      await fs.writeFile(file, data);
      return file;
    }
  };
}
const rgba = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255];
function bmp({
  width = 2,
  height = 2,
  bits = 24,
  pixels = rgba,
  topDown = false,
  core = false,
  palette,
  compression = 0,
  rle,
  masks
} = {}) {
  const header = core ? 12 : masks ? 56 : 40;
  const paletteBytes = palette ? palette.length * (core ? 3 : 4) : 0;
  const stride = Math.ceil((width * bits) / 32) * 4;
  const body = rle ? Buffer.from(rle) : Buffer.alloc(stride * height);
  if (!rle)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const source = (topDown ? y : height - 1 - y) * width + x,
          at = y * stride + Math.floor((x * bits) / 8);
        if (bits === 24 || bits === 32) {
          body[at] = pixels[source * 4 + 2];
          body[at + 1] = pixels[source * 4 + 1];
          body[at + 2] = pixels[source * 4];
          if (bits === 32) body[at + 3] = pixels[source * 4 + 3];
        } else if (bits === 16) body.writeUInt16LE(pixels[source], at);
        else if (bits === 8) body[at] = pixels[source];
        else if (bits === 4) body[at] |= pixels[source] << (x & 1 ? 0 : 4);
        else if (bits === 1) body[at] |= pixels[source] << (7 - (x & 7));
      }
  const start = 14 + header + paletteBytes,
    data = Buffer.alloc(start + body.length);
  data.write('BM');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(start, 10);
  data.writeUInt32LE(header, 14);
  if (core) {
    data.writeUInt16LE(width, 18);
    data.writeUInt16LE(height, 20);
    data.writeUInt16LE(1, 22);
    data.writeUInt16LE(bits, 24);
  } else {
    data.writeInt32LE(width, 18);
    data.writeInt32LE(topDown ? -height : height, 22);
    data.writeUInt16LE(1, 26);
    data.writeUInt16LE(bits, 28);
    data.writeUInt32LE(compression, 30);
    data.writeUInt32LE(body.length, 34);
    if (palette) data.writeUInt32LE(palette.length, 46);
    if (masks) masks.forEach((m, i) => data.writeUInt32LE(m >>> 0, 54 + i * 4));
  }
  if (palette)
    palette.forEach((p, i) => {
      const at = 14 + header + i * (core ? 3 : 4);
      data[at] = p[2];
      data[at + 1] = p[1];
      data[at + 2] = p[0];
    });
  body.copy(data, start);
  return data;
}
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((f, i) => {
    const p = 6 + i * 16;
    header[p] = f.width === 256 ? 0 : f.width;
    header[p + 1] = f.height === 256 ? 0 : f.height;
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(f.data.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += f.data.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.data)]);
}
function dibIcon() {
  const data = Buffer.from(bmp().subarray(14));
  data.writeInt32LE(4, 8);
  // Bottom row: first pixel transparent. Both rows are DWORD-padded.
  return ico([
    { width: 2, height: 2, data: Buffer.concat([data, Buffer.from([128, 0, 0, 0, 0, 0, 0, 0])]) }
  ]);
}
function gif() {
  const header = Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255])
  ]);
  const frame = (code) =>
    Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, code, 1, 0]);
  return Buffer.concat([header, frame(0x44), frame(0x4c), Buffer.from([0x3b])]);
}
function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const data = Buffer.concat([Buffer.from(type), body]),
    h = Buffer.alloc(4),
    crc = Buffer.alloc(4);
  h.writeUInt32BE(body.length);
  crc.writeUInt32BE(crc32(data));
  return Buffer.concat([h, data, crc]);
}
function apng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2);
  const fctl = (n) => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(n, 0);
    b.writeUInt32BE(1, 4);
    b.writeUInt32BE(1, 8);
    b.writeUInt16BE(1, 20);
    b.writeUInt16BE(10, 22);
    return b;
  };
  const second = Buffer.alloc(4);
  second.writeUInt32BE(2);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    chunk('fcTL', fctl(0)),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('fcTL', fctl(1)),
    chunk('fdAT', Buffer.concat([second, zlib.deflateSync(Buffer.from([0, 0, 0, 255, 255]))])),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
function heifHeader() {
  const h = Buffer.alloc(24);
  h.writeUInt32BE(24);
  h.write('ftyp', 4);
  h.write('heic', 8);
  h.write('mif1', 16);
  h.write('heic', 20);
  return h;
}
async function pixels(file) {
  const { data, info } = await sharp(await fs.readFile(file))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: [...data], width: info.width, height: info.height };
}
const image = (width = 2, height = 2) =>
  sharp({
    create: { width, height, channels: 4, background: { r: 24, g: 96, b: 180, alpha: 0.5 } }
  });

test('light signature detection follows bytes instead of extensions and rejects video or unknown data', async () => {
  for (const [format, data] of [
    ['png', await image().png().toBuffer()],
    ['jpeg', await image().jpeg().toBuffer()],
    ['webp', await image().webp().toBuffer()],
    ['gif', gif()],
    ['tiff', await image().tiff().toBuffer()],
    ['bmp', bmp()],
    ['ico', dibIcon()],
    ['heif', heifHeader()]
  ])
    assert.equal(sniffImage(data)?.format, format);
  assert.equal(sniffImage(Buffer.from('not an image')), null);
  const avif = await image().avif({ lossless: true }).toBuffer();
  assert.deepEqual(sniffImage(avif), { format: 'avif', mime: 'image/avif' });
});

test('native image signatures keep source MIME and originals, while forced previews are bounded sRGB WebP', async (t) => {
  const f = await fixture(t),
    s = f.service();
  for (const [ext, format, encoder] of [
    ['jfif', 'jpeg', 'jpeg'],
    ['jpe', 'jpeg', 'jpeg'],
    ['heic', 'avif', 'avif'],
    ['webp', 'png', 'png'],
    ['jpg', 'webp', 'webp']
  ]) {
    const file = await f.file('signature.' + ext, await image(12, 8)[encoder]().toBuffer()),
      before = await fs.readFile(file);
    const original = await s.preview({ id, file });
    assert.equal(original.original, true);
    assert.equal(original.format, format);
    assert.equal(original.path, file);
    const result = await s.preview({ id, file, size: 4, force: true });
    assert.equal(result.mime, 'image/webp');
    assert.ok(result.width > 0 && result.width <= 4);
    assert.ok(result.height <= 4);
    assert.equal(path.dirname(result.path), f.cache);
    assert.match(path.basename(result.path), /^preview-[a-f0-9]{64}\.webp$/);
    assert.deepEqual(await fs.readFile(file), before);
    const cached = await s.preview({ id, file, size: 4, force: true });
    assert.equal(cached.decoder, 'cache');
    assert.equal(cached.sourceWidth, 12);
    assert.equal(cached.sourceHeight, 8);
  }
});

test('BMP bottom-up top-down core headers and legacy RGBX decode with correct rows and alpha', async (t) => {
  const f = await fixture(t),
    s = f.service();
  for (const [name, bytes] of [
    ['bottom', bmp()],
    ['top', bmp({ topDown: true })],
    ['core', bmp({ core: true })]
  ]) {
    const result = await s.preview({ id, file: await f.file(name + '.png', bytes) });
    const output = await pixels(result.path);
    assert.deepEqual(output, { data: rgba, width: 2, height: 2 });
  }
  const reserved = rgba.map((v, i) => (i % 4 === 3 ? 0 : v));
  const opaque = await s.preview({
    id,
    file: await f.file('rgbx.bmp', bmp({ bits: 32, pixels: reserved }))
  });
  assert.deepEqual((await pixels(opaque.path)).data, rgba);
});

test('BMP palette bit depths, RGB565 bitfields and explicit alpha remain supported', async (t) => {
  const f = await fixture(t),
    s = f.service(),
    palette = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255]
    ];
  for (const bits of [4, 8]) {
    const result = await s.preview({
      id,
      file: await f.file('palette' + bits + '.bmp', bmp({ bits, pixels: [0, 1, 2, 3], palette }))
    });
    assert.deepEqual((await pixels(result.path)).data, rgba);
  }
  const mono = await s.preview({
    id,
    file: await f.file(
      'mono.bmp',
      bmp({ bits: 1, pixels: [0, 1, 1, 0], palette: palette.slice(0, 2), core: true })
    )
  });
  assert.deepEqual(
    (await pixels(mono.path)).data,
    [255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 255, 0, 0, 255]
  );
  const rgb565 = await s.preview({
    id,
    file: await f.file(
      '565.bmp',
      bmp({
        bits: 16,
        pixels: [0xf800, 0x07e0, 0x001f, 0xffff],
        compression: 3,
        masks: [0xf800, 0x07e0, 0x001f, 0]
      })
    )
  });
  assert.deepEqual((await pixels(rgb565.path)).data, rgba);
  const alpha = await s.preview({
    id,
    file: await f.file(
      'alpha.bmp',
      bmp({
        bits: 32,
        pixels: [255, 0, 0, 0, 0, 255, 0, 64, 0, 0, 255, 128, 255, 255, 255, 255],
        compression: 6,
        masks: [0xff0000, 0xff00, 0xff, 0xff000000]
      })
    )
  });
  assert.deepEqual(
    (await pixels(alpha.path)).data.filter((_, i) => i % 4 === 3),
    [0, 64, 128, 255]
  );
});

test('RLE8 and RLE4 BMP imports preserve palette order without overrunning rows', async (t) => {
  const f = await fixture(t),
    s = f.service(),
    palette = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255]
    ];
  for (const [bits, rle, bottom] of [
    [8, [4, 1, 0, 0, 0, 4, 0, 1, 2, 3, 0, 0, 0, 1], [1, 1, 1, 1]],
    [4, [4, 0x12, 0, 0, 0, 4, 0x01, 0x23, 0, 0, 0, 1], [1, 2, 1, 2]]
  ]) {
    const result = await s.preview({
      id,
      file: await f.file(
        'rle' + bits + '.bmp',
        bmp({ width: 4, bits, compression: bits === 8 ? 1 : 2, palette, rle })
      )
    });
    assert.deepEqual(
      (await pixels(result.path)).data,
      [0, 1, 2, 3, ...bottom].flatMap((i) => [...palette[i], 255])
    );
  }
});

test('ICO selects the largest PNG or DIB and preserves classic AND transparency', async (t) => {
  const f = await fixture(t),
    s = f.service();
  const result = await s.preview({ id, file: await f.file('dib.ico', dibIcon()) });
  const output = await pixels(result.path);
  assert.equal(output.data[11], 0);
  assert.equal(output.data[3], 255);
  const icon = ico([
    { width: 1, height: 1, data: await image(1, 1).png().toBuffer() },
    { width: 4, height: 3, data: await image(4, 3).png().toBuffer() }
  ]);
  const png = await s.preview({ id, file: await f.file('large.ico', icon) });
  assert.equal(png.width, 4);
  assert.equal(png.height, 3);
});

test('TIFF and JPEG EXIF orientation, CMYK and transparency use the compatibility transform', async (t) => {
  const f = await fixture(t),
    s = f.service();
  for (const type of ['tiff', 'jpeg']) {
    const file = await f.file(
      'rotated.' + type,
      await image(4, 2)[type]().withMetadata({ orientation: 6 }).toBuffer()
    );
    const result = await s.preview({ id, file, force: true });
    assert.equal(result.width, 2);
    assert.equal(result.height, 4);
    assert.equal((await sharp(await fs.readFile(result.path)).metadata()).orientation, undefined);
  }
  const cmyk = await f.file('cmyk.jpeg', await image().toColourspace('cmyk').jpeg().toBuffer());
  const converted = await s.preview({ id, file: cmyk, force: true });
  assert.equal((await sharp(await fs.readFile(converted.path)).metadata()).space, 'srgb');
  const transparent = await s.preview({
    id,
    file: await f.file('transparent.tiff', await image().tiff({ compression: 'lzw' }).toBuffer())
  });
  assert.ok((await pixels(transparent.path)).data.some((v, i) => i % 4 === 3 && v > 0 && v < 255));
});

test('GIF APNG and animated WebP preserve original playback and explicitly mark forced still fallback', async (t) => {
  const f = await fixture(t),
    s = f.service();
  const frames = gif();
  assert.equal((await sharp(frames).metadata()).pages, 2);
  const webp = await sharp(frames, { animated: true }).webp({ loop: 0 }).toBuffer();
  for (const [name, bytes] of [
    ['gif', frames],
    ['apng', apng()],
    ['webp', webp]
  ]) {
    const file = await f.file('animated.' + name, bytes),
      original = await s.preview({ id, file });
    assert.equal(original.original, true);
    assert.equal(original.animated, true);
    assert.equal(original.animationPreserved, true);
    const still = await s.preview({ id, file, force: true });
    assert.equal(still.original, false);
    assert.equal(still.animationPreserved, false);
    assert.equal(still.width, 1);
    assert.equal(still.height, 1);
  }
});

test('oversized, malformed and mislabeled contents fail without publishing partial cache output', async (t) => {
  const f = await fixture(t),
    s = f.service({ maxInputPixels: 8 });
  await assert.rejects(
    s.preview({
      id,
      file: await f.file('too-big.png', await image(4, 4).png().toBuffer()),
      force: true
    }),
    { code: 'IMAGE_LIMIT' }
  );
  const big = bmp();
  big.writeInt32LE(100000, 18);
  big.writeInt32LE(100000, 22);
  for (const [name, bytes, code] of [
    ['large.bmp', big, 'IMAGE_LIMIT'],
    ['broken.bmp', bmp().subarray(0, 55), 'IMAGE_CORRUPT'],
    ['broken.jpeg', Buffer.from([255, 216, 255]), 'IMAGE_CORRUPT'],
    ['not-image.png', Buffer.from('text'), 'IMAGE_UNSUPPORTED']
  ])
    await assert.rejects(s.preview({ id, file: await f.file(name, bytes), force: true }), { code });
  const small = f.service({ maxSourceBytes: 8 });
  await assert.rejects(
    small.preview({ id, file: await f.file('bytes.png', await image().png().toBuffer()) }),
    { code: 'IMAGE_LIMIT' }
  );
  assert.deepEqual(await fs.readdir(f.cache), []);
});

test('HEIC without an independent codec reports the limitation, and a bounded injected adapter is reusable', async (t) => {
  const f = await fixture(t),
    file = await f.file('input.heic', heifHeader());
  await assert.rejects(f.service().preview({ id, file }), { code: 'IMAGE_CODEC_UNAVAILABLE' });
  let calls = 0;
  const s = f.service({
    heifDecode: async (input, limits) => {
      calls++;
      assert.ok(Buffer.isBuffer(input));
      assert.ok(limits.maxPixels > 24000000);
      return { width: 2, height: 2, channels: 4, data: Buffer.from(rgba) };
    }
  });
  const result = await s.preview({ id, file });
  assert.equal(result.decoder, 'heif-adapter');
  assert.deepEqual((await pixels(result.path)).data, rgba);
  assert.equal((await s.preview({ id, file })).decoder, 'cache');
  assert.equal(calls, 1, 'Cached compatibility previews must not decode the HEIF a second time');
});

test('parallel duplicate requests decode once, serialize bounded work and stop drains admitted requests', async (t) => {
  const f = await fixture(t),
    file = await f.file('shared.heic', heifHeader());
  let calls = 0,
    release,
    started;
  const gate = new Promise((r) => (release = r)),
    start = new Promise((r) => (started = r));
  const s = f.service({
    heifDecode: async () => {
      calls++;
      started();
      await gate;
      return { width: 2, height: 2, channels: 4, data: Buffer.from(rgba) };
    }
  });
  const requests = Array.from({ length: 8 }, () => s.preview({ id, file }));
  await start;
  let drained = false;
  const closing = s.stop().then(() => {
    drained = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(drained, false);
  release();
  const results = await Promise.all(requests);
  await closing;
  assert.equal(calls, 1);
  assert.ok(results.every((r) => r.path === results[0].path));
  assert.equal(s.stats().active, 0);
  assert.equal(s.stats().jobs, 0);
  await assert.rejects(s.preview({ id, file }), { code: 'IMAGE_PREVIEW_STOPPED' });
});

test('queue admission is bounded and cache relocation resolves the current directory for every new call', async (t) => {
  const f = await fixture(t);
  let root = f.cache,
    release,
    started;
  const gate = new Promise((r) => (release = r)),
    start = new Promise((r) => (started = r));
  const s = f.service({
    getCacheDir: () => root,
    maxPending: 1,
    heifDecode: async () => {
      started();
      await gate;
      return { width: 2, height: 2, channels: 4, data: Buffer.from(rgba) };
    }
  });
  const a = await f.file('one.heic', heifHeader()),
    b = await f.file('two.heic', heifHeader());
  const first = s.preview({ id, file: a });
  await start;
  const second = s.preview({ id, file: b });
  await assert.rejects(s.preview({ id, file: b }), { code: 'IMAGE_QUEUE_FULL' });
  release();
  await Promise.all([first, second]);
  await s.idle();
  root = path.join(f.root, 'moved-cache');
  const moved = await s.preview({ id, file: a });
  assert.equal(path.dirname(moved.path), root);
  assert.ok((await fs.readdir(root)).every((n) => /^preview-[a-f0-9]{64}\.webp$/.test(n)));
});

test('source revisions change cache keys and stale in-flight output is discarded', async (t) => {
  const f = await fixture(t),
    file = await f.file('revision.png', await image(4, 2).png().toBuffer()),
    s = f.service();
  const one = await s.preview({ id, file, force: true });
  await fs.writeFile(file, await image(2, 4).png().toBuffer());
  const two = await s.preview({ id, file, force: true });
  assert.notEqual(one.key, two.key);
  assert.equal(two.height, 4);
  const pendingFile = await f.file('pending.heic', heifHeader());
  let release, started;
  const gate = new Promise((r) => (release = r)),
    start = new Promise((r) => (started = r));
  const pending = f.service({
    heifDecode: async () => {
      started();
      await gate;
      return { width: 2, height: 2, channels: 4, data: Buffer.from(rgba) };
    }
  });
  const job = pending.preview({ id, file: pendingFile });
  await start;
  await fs.appendFile(pendingFile, Buffer.from([1]));
  release();
  await assert.rejects(job, { code: 'IMAGE_SOURCE_CHANGED' });
  assert.ok(
    (await fs.readdir(f.cache)).every((n) => n.endsWith('.webp')),
    'No partial temporary files remain'
  );
});

test('pixel-corrupt preview caches rebuild even when WebP metadata remains readable', async (t) => {
  const f = await fixture(t);
  const source = await sharp(crypto.randomBytes(64 * 64 * 4), {
    raw: { width: 64, height: 64, channels: 4 }
  })
    .png()
    .toBuffer();
  const file = await f.file('source.png', source);
  const s = f.service();
  const first = await s.preview({ id, file, force: true });
  const corrupt = Buffer.from(await fs.readFile(first.path));
  const pixels = corrupt.indexOf(Buffer.from('VP8L'));
  assert.ok(pixels > 0 && corrupt.length > pixels + 320);
  corrupt.fill(0, pixels + 64, pixels + 320);
  assert.equal((await sharp(corrupt).metadata()).width, 64);
  await assert.rejects(sharp(corrupt).raw().toBuffer(), /webp|pixels|corrupt/i);
  // Exercise an already-verified cache revision in this service and an untrusted
  // pre-existing cache after restart; neither may permanently return bad pixels.
  for (const service of [s, f.service()]) {
    await fs.writeFile(first.path, corrupt);
    const nextTime = new Date(Date.now() + 2000);
    await fs.utimes(first.path, nextTime, nextTime);
    const rebuilt = await service.preview({ id, file, force: true });
    assert.equal(rebuilt.path, first.path);
    assert.equal(rebuilt.decoder, 'sharp');
    assert.equal(
      (
        await sharp(await fs.readFile(rebuilt.path))
          .raw()
          .toBuffer()
      ).length,
      64 * 64 * 4
    );
    assert.equal((await service.preview({ id, file, force: true })).decoder, 'cache');
    assert.deepEqual(await fs.readFile(file), source);
  }
});

test('audited real HEIC uses the default vendored adapter for a bounded cached preview', async (t) => {
  const audit =
    process.env.ACG_HEIF_AUDIT_DIR || 'C:\\ACG\\资料归档\\media-compat-20261028\\heif-audit';
  const file = path.join(audit, 'libheif-example-source.heic');
  try {
    await fs.access(file);
  } catch {
    t.skip('Public audit fixture is not distributed with the application');
    return;
  }
  const { createHeifDecoder } = require('../src/heif-decoder.cjs');
  const crypto = require('node:crypto');
  const source = await fs.readFile(file);
  assert.equal(
    crypto.createHash('sha256').update(source).digest('hex'),
    '7f8b363e4936c0666a25f64f3a92fda10bd8e5453be4592530b65a55dd98f3f2'
  );
  // Use the application's default vendored factory/WASM resolution.
  const decoder = createHeifDecoder();
  const f = await fixture(t);
  let calls = 0;
  const service = f.service({
    heifDecode: async (bytes, limits) => {
      calls++;
      const result = await decoder.decode(bytes, limits);
      assert.equal(
        crypto.createHash('sha256').update(result.data).digest('hex'),
        '7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b'
      );
      return result;
    }
  });
  t.after(async () => {
    await service.stop();
    await decoder.stop();
  });
  const result = await service.preview({ id, file, size: 64, force: true });
  assert.equal(result.decoder, 'heif-adapter');
  assert.equal(result.mime, 'image/webp');
  assert.equal(result.converted, true);
  assert.deepEqual([result.sourceWidth, result.sourceHeight], [1280, 854]);
  assert.ok(result.width > 0 && result.width <= 64 && result.height > 0 && result.height <= 64);
  assert.equal((await pixels(result.path)).width, result.width);
  const again = await service.preview({ id, file, size: 64, force: true });
  assert.equal(again.decoder, 'cache');
  assert.equal(again.path, result.path);
  assert.equal(calls, 1);
  await service.idle();
  await decoder.idle();
  assert.deepEqual(await fs.readFile(file), source, 'Public audit source remains unchanged');
});
