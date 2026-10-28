'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Worker, parentPort, workerData } = require('node:worker_threads');
let sharpImplementation;
function sharp(...args) {
  sharpImplementation ||= require('sharp');
  return sharpImplementation(...args);
}
const VERSION = 1;
const MIMES = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heif: 'image/heic'
});
function sniffImage(data) {
  try {
    const format = signature(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return { format, mime: MIMES[format] };
  } catch (error) {
    if (error.code === 'IMAGE_UNSUPPORTED') return null;
    throw error;
  }
}
const LIMITS = Object.freeze({
  maxSourceBytes: 256 * 1024 * 1024,
  maxInputPixels: 80000000,
  maxJpegPixels: 400000000,
  maxBitmapPixels: 40000000,
  maxOutputPixels: 24000000,
  maxEdge: 8192,
  maxHeifBytes: 64 * 1024 * 1024,
  concurrency: 1,
  maxPending: 32,
  timeoutSeconds: 20
});
async function readBounded(file, maxBytes) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    check(
      stat.isFile() && stat.size > 0 && stat.size <= maxBytes,
      '图片字节数超过解码上限。',
      'IMAGE_LIMIT'
    );
    const data = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      check(bytesRead > 0, '读取期间原图被截断。', 'IMAGE_SOURCE_CHANGED');
      offset += bytesRead;
    }
    return data;
  } finally {
    await handle.close();
  }
}
function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function check(condition, message, code = 'IMAGE_CORRUPT') {
  if (!condition) throw failure(code, message);
}
function dimensions(width, height, maxPixels) {
  check(
    Number.isSafeInteger(width) &&
      Number.isSafeInteger(height) &&
      width > 0 &&
      height > 0 &&
      width <= 100000 &&
      height <= 100000,
    '图片尺寸无效或超出边长限制。',
    'IMAGE_LIMIT'
  );
  check(width * height <= maxPixels, '图片像素超过预览解码上限。', 'IMAGE_LIMIT');
}
function signature(data) {
  if (
    data.length >= 8 &&
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg';
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString('ascii'))) return 'gif';
  if (
    data.length >= 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  if (data.length >= 2 && data.toString('ascii', 0, 2) === 'BM') return 'bmp';
  if (data.length >= 6 && data.readUInt16LE(0) === 0 && [1, 2].includes(data.readUInt16LE(2)))
    return 'ico';
  if (
    data.length >= 4 &&
    ((data.toString('ascii', 0, 2) === 'II' && [42, 43].includes(data.readUInt16LE(2))) ||
      (data.toString('ascii', 0, 2) === 'MM' && [42, 43].includes(data.readUInt16BE(2))))
  )
    return 'tiff';
  // Walk only bounded leading ISO-BMFF boxes, never search pixel data for brands.
  for (let offset = 0, n = 0; offset + 8 <= data.length && n < 32; n++) {
    const bytes = data.readUInt32BE(offset),
      type = data.toString('ascii', offset + 4, offset + 8);
    if (bytes < 8 || offset + bytes > data.length) break;
    if (type === 'ftyp' && bytes >= 16) {
      const brands = [data.toString('ascii', offset + 8, offset + 12)];
      for (let p = offset + 16; p + 4 <= offset + bytes; p += 4)
        brands.push(data.toString('ascii', p, p + 4));
      if (brands.some((b) => ['avif', 'avis'].includes(b))) return 'avif';
      if (
        brands.some((b) =>
          ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(
            b
          )
        )
      )
        return 'heif';
      break;
    }
    offset += bytes;
  }
  throw failure('IMAGE_UNSUPPORTED', '图片内容签名不受支持；扩展名不能证明编码格式。');
}
function channel(value, mask) {
  if (!mask) return 0;
  let shift = 0,
    reduced = mask >>> 0;
  while (!(reduced & 1)) {
    shift++;
    reduced >>>= 1;
  }
  check((reduced & (reduced + 1)) === 0, 'BMP 位域不是连续掩码。');
  return Math.round((((value & mask) >>> shift) * 255) / reduced);
}
function bitmap(data, { icon = false, expectedWidth, expectedHeight, maxPixels }) {
  const base = icon ? 0 : 14;
  check(data.length >= base + 12, 'BMP 头被截断。');
  const header = data.readUInt32LE(base);
  check([12, 40, 52, 56, 108, 124].includes(header), '不支持此 BMP DIB 头。', 'IMAGE_UNSUPPORTED');
  check(data.length >= base + header, 'BMP DIB 头被截断。');
  const core = header === 12;
  const width = core ? data.readUInt16LE(base + 4) : data.readInt32LE(base + 4);
  const signedHeight = core ? data.readUInt16LE(base + 6) : data.readInt32LE(base + 8);
  const topDown = signedHeight < 0,
    height = Math.abs(signedHeight) / (icon ? 2 : 1);
  dimensions(width, height, maxPixels);
  if (icon)
    check(width === expectedWidth && height === expectedHeight, 'ICO DIB 尺寸与目录不一致。');
  check(
    (core ? data.readUInt16LE(base + 8) : data.readUInt16LE(base + 12)) === 1,
    'BMP planes 无效。'
  );
  const bits = core ? data.readUInt16LE(base + 10) : data.readUInt16LE(base + 14);
  const compression = core ? 0 : data.readUInt32LE(base + 16);
  check([1, 4, 8, 16, 24, 32].includes(bits), '不支持此 BMP 位深。', 'IMAGE_UNSUPPORTED');
  check([0, 1, 2, 3, 4, 5, 6].includes(compression), '不支持此 BMP 压缩。', 'IMAGE_UNSUPPORTED');
  check(!([1, 2].includes(compression) && topDown), 'RLE BMP 不能倒置。');
  let paletteAt = base + header,
    masks = bits === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0];
  const pixelOffset = icon ? null : data.readUInt32LE(10);
  if ([3, 6].includes(compression)) {
    check([16, 32].includes(bits), 'BMP 位域位深无效。');
    const at = base + 40,
      count =
        header >= 56 || compression === 6 || (header === 40 && pixelOffset >= at + 16) ? 4 : 3;
    check(data.length >= at + count * 4, 'BMP 位域被截断。');
    masks = Array.from({ length: 4 }, (_, i) => (i < count ? data.readUInt32LE(at + i * 4) : 0));
    if (header === 40) paletteAt = at + count * 4;
    check(
      masks.slice(0, 3).every((m) => m !== 0),
      'BMP RGB 位域缺失。'
    );
    const allowed = bits === 16 ? 0xffff : 0xffffffff;
    for (let i = 0; i < 4; i++) {
      check((masks[i] & ~allowed) === 0, 'BMP 位域越界。');
      for (let j = 0; j < i; j++) check((masks[i] & masks[j]) === 0, 'BMP 位域重叠。');
      channel(0, masks[i]);
    }
  }
  let palette = null;
  if (bits <= 8) {
    const count = (!core && data.readUInt32LE(base + 32)) || 1 << bits,
      stride = core ? 3 : 4;
    check(count <= 1 << bits && paletteAt + count * stride <= data.length, 'BMP 调色板被截断。');
    palette = Array.from({ length: count }, (_, i) => [
      data[paletteAt + i * stride + 2],
      data[paletteAt + i * stride + 1],
      data[paletteAt + i * stride],
      255
    ]);
    paletteAt += count * stride;
  }
  const start = icon ? paletteAt : pixelOffset;
  check(start >= paletteAt && start <= data.length, 'BMP 像素偏移无效。');
  if ([4, 5].includes(compression)) {
    check(!icon, 'ICO 不支持嵌入 JPEG/BMP 压缩。', 'IMAGE_UNSUPPORTED');
    return { encoded: data.subarray(start), width, height };
  }
  const rgba = Buffer.alloc(width * height * 4);
  function put(x, y, color) {
    check(x >= 0 && x < width && y >= 0 && y < height && color, 'BMP 像素或调色板索引越界。');
    const at = ((topDown ? y : height - 1 - y) * width + x) * 4;
    rgba[at] = color[0];
    rgba[at + 1] = color[1];
    rgba[at + 2] = color[2];
    rgba[at + 3] = color[3];
  }
  let end,
    alphaPresent = false;
  if ([1, 2].includes(compression)) {
    check(
      (compression === 1 && bits === 8) || (compression === 2 && bits === 4),
      'BMP RLE 位深不匹配。'
    );
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) put(x, y, palette[0]);
    let p = start,
      x = 0,
      y = 0,
      finished = false;
    while (p + 2 <= data.length) {
      const count = data[p++],
        value = data[p++];
      if (count) {
        for (let i = 0; i < count; i++)
          put(x++, y, palette[bits === 8 ? value : i & 1 ? value & 15 : value >> 4]);
      } else if (value === 0) {
        x = 0;
        y++;
      } else if (value === 1) {
        finished = true;
        break;
      } else if (value === 2) {
        check(p + 2 <= data.length, 'BMP RLE delta 被截断。');
        x += data[p++];
        y += data[p++];
        check(x <= width && y < height, 'BMP RLE delta 越界。');
      } else {
        const bytes = bits === 8 ? value : Math.ceil(value / 2);
        check(p + bytes + (bytes & 1) <= data.length, 'BMP RLE 数据被截断。');
        for (let i = 0; i < value; i++)
          put(
            x++,
            y,
            palette[
              bits === 8 ? data[p + i] : i & 1 ? data[p + (i >> 1)] & 15 : data[p + (i >> 1)] >> 4
            ]
          );
        p += bytes + (bytes & 1);
      }
    }
    check(finished, 'BMP RLE 缺少结束标记。');
    end = p;
  } else {
    check([0, 3, 6].includes(compression), 'BMP 压缩无效。');
    const stride = Math.floor((width * bits + 31) / 32) * 4;
    end = start + stride * height;
    check(end <= data.length, 'BMP 像素数据被截断。');
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const row = start + y * stride;
        let color;
        if (bits <= 8) {
          const byte = data[row + Math.floor((x * bits) / 8)],
            index =
              bits === 8
                ? byte
                : bits === 4
                  ? x & 1
                    ? byte & 15
                    : byte >> 4
                  : (byte >> (7 - (x % 8))) & 1;
          color = palette[index];
        } else if (bits === 24) {
          const at = row + x * 3;
          color = [data[at + 2], data[at + 1], data[at], 255];
        } else {
          const at = row + x * (bits / 8),
            pixel = bits === 16 ? data.readUInt16LE(at) : data.readUInt32LE(at);
          const alpha = masks[3]
            ? channel(pixel, masks[3])
            : bits === 32 && compression === 0
              ? data[at + 3]
              : 255;
          if (alpha) alphaPresent = true;
          color = [
            channel(pixel, masks[0]),
            channel(pixel, masks[1]),
            channel(pixel, masks[2]),
            alpha
          ];
        }
        put(x, y, color);
      }
    if (bits === 32 && !masks[3] && !alphaPresent)
      for (let p = 3; p < rgba.length; p += 4) rgba[p] = 255;
  }
  if (icon) {
    const stride = Math.ceil(width / 32) * 4;
    // 32-bit icons may omit an AND mask only when real alpha is present.
    if (end + stride * height <= data.length) {
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (data[end + y * stride + (x >> 3)] & (128 >> (x & 7)))
            rgba[((topDown ? y : height - 1 - y) * width + x) * 4 + 3] = 0;
    } else check(bits === 32 && alphaPresent, 'ICO AND 透明蒙版缺失。');
  }
  return { data: rgba, width, height, channels: 4 };
}
function icon(data, maxPixels) {
  check(data.length >= 6, 'ICO 头被截断。');
  const count = data.readUInt16LE(4);
  check(count > 0 && count <= 256 && 6 + count * 16 <= data.length, 'ICO 目录无效。');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const p = 6 + i * 16,
      bytes = data.readUInt32LE(p + 8),
      offset = data.readUInt32LE(p + 12),
      width = data[p] || 256,
      height = data[p + 1] || 256;
    if (bytes >= 12 && offset >= 6 + count * 16 && offset + bytes <= data.length)
      entries.push({ width, height, offset, bytes });
  }
  entries.sort((a, b) => b.width * b.height - a.width * a.height);
  for (const entry of entries) {
    const image = data.subarray(entry.offset, entry.offset + entry.bytes);
    try {
      if (image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        check(
          image.length >= 24 &&
            image.readUInt32BE(16) === entry.width &&
            image.readUInt32BE(20) === entry.height,
          'ICO PNG 尺寸不匹配。'
        );
        return { encoded: image, width: entry.width, height: entry.height };
      }
      return bitmap(image, {
        icon: true,
        expectedWidth: entry.width,
        expectedHeight: entry.height,
        maxPixels
      });
    } catch {}
  }
  throw failure('IMAGE_CORRUPT', 'ICO 没有可解码的 PNG/DIB 图层。');
}
// CPU-heavy legacy bitmap parsing is isolated from the library's RPC event loop.
if (workerData?.imagePreviewBitmap === VERSION) {
  try {
    const data = Buffer.from(
      workerData.data.buffer,
      workerData.data.byteOffset,
      workerData.data.byteLength
    );
    const result =
      workerData.format === 'ico'
        ? icon(data, workerData.maxPixels)
        : bitmap(data, { maxPixels: workerData.maxPixels });
    const bytes = result.data || result.encoded;
    parentPort.postMessage(
      {
        ...result,
        data: result.data ? bytes : undefined,
        encoded: result.encoded ? bytes : undefined
      },
      [bytes.buffer]
    );
  } catch (error) {
    parentPort.postMessage({
      error: { code: error.code || 'IMAGE_CORRUPT', message: error.message }
    });
  }
}
function legacyDecode(data, format, maxPixels, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const bytes =
      data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
        ? data
        : Uint8Array.from(data);
    const worker = new Worker(__filename, {
      workerData: { imagePreviewBitmap: VERSION, data: bytes, format, maxPixels },
      transferList: [bytes.buffer]
    });
    let settled = false;
    const finish = async (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate();
      if (error) reject(error);
      else {
        if (result.data)
          result.data = Buffer.from(
            result.data.buffer,
            result.data.byteOffset,
            result.data.byteLength
          );
        if (result.encoded)
          result.encoded = Buffer.from(
            result.encoded.buffer,
            result.encoded.byteOffset,
            result.encoded.byteLength
          );
        resolve(result);
      }
    };
    const timer = setTimeout(
      () => finish(failure('IMAGE_TIMEOUT', 'BMP/ICO 解码超时。')),
      timeoutSeconds * 1000
    );
    worker.once('message', (result) =>
      result.error ? finish(failure(result.error.code, result.error.message)) : finish(null, result)
    );
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => {
      if (!settled) finish(failure('IMAGE_CORRUPT', '图片解码器提前退出：' + code));
    });
  });
}
function createImagePreview({
  cacheDir,
  getCacheDir = () => cacheDir,
  heifDecode,
  nativeDecode,
  ...options
} = {}) {
  const limits = { ...LIMITS, ...options };
  for (const key of Object.keys(LIMITS))
    check(
      Number.isSafeInteger(limits[key]) && limits[key] > 0,
      '预览限制参数无效：' + key,
      'IMAGE_ARGUMENT'
    );
  const jobs = new Map(),
    validatedCache = new Map(),
    requests = new Set(),
    waiting = [];
  function rememberCache(file, version) {
    validatedCache.delete(file);
    validatedCache.set(file, version);
    if (validatedCache.size > 128) validatedCache.delete(validatedCache.keys().next().value);
  }
  let active = 0,
    stopped = false;
  async function slot() {
    if (active < limits.concurrency) {
      active++;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
  const stamp = (s) => [s.size, s.mtimeNs, s.ctimeNs, s.dev, s.ino].map(String).join(':');
  async function prepare({ id, file, size = limits.maxEdge, force = false, revision = '' } = {}) {
    check(
      typeof file === 'string' && path.isAbsolute(file),
      '必须提供已验证的图片绝对路径。',
      'IMAGE_ARGUMENT'
    );
    check(id === undefined || /^[a-f0-9]{24}$/.test(id), '图片 ID 无效。', 'IMAGE_ARGUMENT');
    check(
      Number.isSafeInteger(size) &&
        size > 0 &&
        typeof force === 'boolean' &&
        ['string', 'number'].includes(typeof revision),
      '图片预览参数无效。',
      'IMAGE_ARGUMENT'
    );
    check(String(revision).length <= 1024, '图片 revision 过长。', 'IMAGE_ARGUMENT');
    const source = await fs.realpath(file),
      stat = await fs.stat(source, { bigint: true });
    check(stat.isFile(), '图片源不是普通文件。', 'IMAGE_ARGUMENT');
    check(
      stat.size > 0n && stat.size <= BigInt(limits.maxSourceBytes),
      '图片源文件超过预览字节上限或为空。',
      'IMAGE_LIMIT'
    );
    const directory = await getCacheDir();
    check(
      typeof directory === 'string' && path.isAbsolute(directory),
      '必须提供预览缓存绝对目录。',
      'IMAGE_ARGUMENT'
    );
    await fs.mkdir(directory, { recursive: true });
    const root = await fs.realpath(directory),
      edge = Math.min(size, limits.maxEdge);
    const key = createHash('sha256')
      .update(
        JSON.stringify([VERSION, id || '', source, stamp(stat), String(revision), edge, limits])
      )
      .digest('hex');
    const jobKey = key + ':' + force;
    if (jobs.has(jobKey)) return jobs.get(jobKey);
    const job = (async () => {
      await slot();
      let temporary;
      try {
        const handle = await fs.open(source, 'r');
        let header;
        try {
          header = Buffer.alloc(Number(stat.size < 65536n ? stat.size : 65536n));
          const read = await handle.read(header, 0, header.length, 0);
          header = header.subarray(0, read.bytesRead);
        } finally {
          await handle.close();
        }
        const format = signature(header),
          inputLimit = format === 'jpeg' ? limits.maxJpegPixels : limits.maxInputPixels;
        const nativeFormat = ['jpeg', 'png', 'gif', 'webp', 'avif'].includes(format),
          mime = MIMES[format];
        const destination = path.join(root, 'preview-' + key + '.webp');
        check(destination !== source, '预览输出不能覆盖原图。', 'IMAGE_ARGUMENT');
        if (force || !nativeFormat)
          try {
            const cached = await fs.lstat(destination, { bigint: true });
            if (
              cached.isFile() &&
              !cached.isSymbolicLink() &&
              cached.size > 0n &&
              cached.size <= BigInt(limits.maxSourceBytes)
            ) {
              const cachedBytes = await readBounded(destination, limits.maxSourceBytes);
              const m = await sharp(cachedBytes, {
                limitInputPixels: limits.maxOutputPixels
              }).metadata();
              check(
                stamp(await fs.stat(source, { bigint: true })) === stamp(stat),
                '读取期间原图已变更。',
                'IMAGE_SOURCE_CHANGED'
              );
              if (m.format === 'webp') {
                const version = stamp(cached);
                if (validatedCache.get(destination) !== version) {
                  // A valid WebP header does not prove its pixel payload is readable.
                  // Decode each on-disk revision once, retaining bounded fast cache hits.
                  await sharp(cachedBytes, { limitInputPixels: limits.maxOutputPixels })
                    .timeout({ seconds: limits.timeoutSeconds })
                    .raw()
                    .toBuffer();
                  rememberCache(destination, version);
                }
                const info =
                  m.xmp?.length < 4096
                    ? /acg:source="(\d+),(\d+),(\d+),(0|1)"/.exec(m.xmp.toString('utf8'))
                    : null;
                return {
                  path: destination,
                  mime: 'image/webp',
                  format,
                  width: m.width,
                  height: m.height,
                  sourceWidth: info ? +info[1] : null,
                  sourceHeight: info ? +info[2] : null,
                  pages: info ? +info[3] : 1,
                  animated: info?.[4] === '1',
                  original: false,
                  converted: true,
                  animationPreserved: false,
                  decoder: 'cache',
                  key
                };
              }
            }
          } catch (error) {
            if (error.code === 'IMAGE_SOURCE_CHANGED') throw error;
          }
        let decoded,
          metadata,
          sourceInput = await readBounded(source, limits.maxSourceBytes),
          sharpOptions = {
            page: 0,
            pages: 1,
            limitInputPixels: inputLimit,
            sequentialRead: true,
            failOn: 'error'
          };
        if (format === 'bmp' || format === 'ico') {
          try {
            decoded = await legacyDecode(
              sourceInput,
              format,
              Math.min(limits.maxBitmapPixels, limits.maxInputPixels),
              limits.timeoutSeconds
            );
          } catch (error) {
            if (!nativeDecode || error.code === 'IMAGE_LIMIT') throw error;
            decoded = await nativeDecode({
              file: source,
              format,
              maxPixels: limits.maxBitmapPixels,
              maxBytes: limits.maxSourceBytes
            });
          }
        } else {
          try {
            metadata = await sharp(sourceInput, sharpOptions)
              .timeout({ seconds: limits.timeoutSeconds })
              .metadata();
          } catch (error) {
            if (format !== 'heif') throw error;
            check(
              typeof heifDecode === 'function',
              '此 HEVC/HEIF 图片需要独立 HEIF 解码器；当前未提供。',
              'IMAGE_CODEC_UNAVAILABLE'
            );
          }
        }
        if (metadata) {
          dimensions(metadata.width, metadata.pageHeight || metadata.height, inputLimit);
          if (!force && nativeFormat) {
            check(
              stamp(await fs.stat(source, { bigint: true })) === stamp(stat),
              '读取期间原图已变更。',
              'IMAGE_SOURCE_CHANGED'
            );
            const swap = metadata.orientation >= 5 && metadata.orientation <= 8;
            return {
              path: source,
              mime,
              format,
              width: swap ? metadata.pageHeight || metadata.height : metadata.width,
              height: swap ? metadata.width : metadata.pageHeight || metadata.height,
              sourceWidth: swap ? metadata.pageHeight || metadata.height : metadata.width,
              sourceHeight: swap ? metadata.width : metadata.pageHeight || metadata.height,
              pages: metadata.pages || 1,
              animated:
                (metadata.pages || 1) > 1 ||
                (format === 'png' && header.includes(Buffer.from('acTL'))),
              original: true,
              converted: false,
              animationPreserved: true,
              decoder: 'original',
              key
            };
          }
        }
        let decoder = 'sharp';
        if (format === 'heif' && metadata?.compression !== 'av1') {
          check(
            typeof heifDecode === 'function',
            '此 HEVC/HEIF 图片需要独立 HEIF 解码器；当前未提供。',
            'IMAGE_CODEC_UNAVAILABLE'
          );
          check(
            stat.size <= BigInt(limits.maxHeifBytes),
            'HEIF 源文件超过独立解码字节上限。',
            'IMAGE_LIMIT'
          );
          // Adapter must inspect dimensions BEFORE allocating pixels, and return
          // one bounded RGBA frame. No OS codec availability is assumed here.
          decoded = await heifDecode(sourceInput, {
            maxEdge: edge,
            maxPixels: limits.maxInputPixels,
            maxBytes: limits.maxHeifBytes,
            firstFrame: true
          });
          decoder = 'heif-adapter';
        }
        if (decoded) {
          if (Buffer.isBuffer(decoded) || decoded instanceof Uint8Array)
            decoded = { encoded: Buffer.from(decoded) };
          if (decoded.data) {
            dimensions(
              decoded.width,
              decoded.height,
              Math.min(inputLimit, format === 'bmp' ? limits.maxBitmapPixels : inputLimit)
            );
            check(
              decoded.channels === 4 && decoded.data.length === decoded.width * decoded.height * 4,
              '图片适配器 RGBA 长度无效。'
            );
            sourceInput = decoded.data;
            sharpOptions = {
              raw: { width: decoded.width, height: decoded.height, channels: 4 },
              limitInputPixels: inputLimit
            };
            metadata = { width: decoded.width, height: decoded.height, pages: 1 };
          } else {
            check(
              decoded.encoded?.length > 0 && decoded.encoded.length <= limits.maxSourceBytes,
              '图片适配器编码响应无效。'
            );
            sourceInput = decoded.encoded;
            metadata = await sharp(sourceInput, sharpOptions).metadata();
            if (decoded.width)
              check(
                metadata.width === decoded.width && metadata.height === decoded.height,
                '嵌入图片尺寸与容器不一致。'
              );
          }
          if (format !== 'heif')
            decoder = format === 'bmp' || format === 'ico' ? 'bitmap-adapter' : 'native-adapter';
        }
        check(metadata, '图片元数据无法读取。');
        dimensions(metadata.width, metadata.pageHeight || metadata.height, inputLimit);
        const swap = metadata.orientation >= 5 && metadata.orientation <= 8;
        const width = swap ? metadata.pageHeight || metadata.height : metadata.width,
          height = swap ? metadata.width : metadata.pageHeight || metadata.height;
        const animated =
          (metadata.pages || 1) > 1 || (format === 'png' && header.includes(Buffer.from('acTL')));
        const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:acg="urn:acg:image-preview" acg:source="${width},${height},${metadata.pages || 1},${animated ? 1 : 0}"/></rdf:RDF></x:xmpmeta>`;
        const scale = Math.min(
          1,
          edge / width,
          edge / height,
          Math.sqrt(limits.maxOutputPixels / (width * height))
        );
        temporary = path.join(root, 'preview-' + key + '-' + randomUUID() + '.tmp');
        const output = await sharp(sourceInput, sharpOptions)
          .timeout({ seconds: limits.timeoutSeconds })
          .rotate()
          .toColourspace('srgb')
          .resize({
            width: Math.max(1, Math.floor(width * scale)),
            height: Math.max(1, Math.floor(height * scale)),
            fit: 'inside',
            withoutEnlargement: true,
            fastShrinkOnLoad: true
          })
          .webp({ lossless: true, effort: 1 })
          .withXmp(xmp)
          .toFile(temporary);
        check(
          stamp(await fs.stat(source, { bigint: true })) === stamp(stat),
          '解码期间原图已变更，已丢弃过期预览。',
          'IMAGE_SOURCE_CHANGED'
        );
        await fs.rename(temporary, destination);
        temporary = null;
        rememberCache(destination, stamp(await fs.stat(destination, { bigint: true })));
        return {
          path: destination,
          mime: 'image/webp',
          format,
          width: output.width,
          height: output.height,
          sourceWidth: width,
          sourceHeight: height,
          pages: metadata.pages || 1,
          animated,
          original: false,
          converted: true,
          animationPreserved: false,
          decoder,
          key
        };
      } catch (error) {
        if (error.code?.startsWith('IMAGE_') || ['ENOENT', 'EACCES', 'EPERM'].includes(error.code))
          throw error;
        if (/pixel limit|exceeds.*pixels|limitInputPixels/i.test(error.message))
          throw failure('IMAGE_LIMIT', '图片像素超过预览解码上限。');
        throw failure('IMAGE_CORRUPT', '图片解码失败：' + error.message);
      } finally {
        if (temporary) await fs.unlink(temporary).catch(() => {});
        release();
        jobs.delete(jobKey);
      }
    })();
    jobs.set(jobKey, job);
    return job;
  }
  function preview(args) {
    if (stopped) return Promise.reject(failure('IMAGE_PREVIEW_STOPPED', '图片预览服务已停止。'));
    if (requests.size >= limits.maxPending + limits.concurrency)
      return Promise.reject(failure('IMAGE_QUEUE_FULL', '图片预览队列已满。'));
    const request = prepare(args);
    requests.add(request);
    request.then(
      () => requests.delete(request),
      () => requests.delete(request)
    );
    return request;
  }
  async function idle() {
    while (requests.size) await Promise.allSettled([...requests]);
  }
  async function stop() {
    stopped = true;
    await idle();
  }
  return {
    preview,
    idle,
    stop,
    stats: () => ({
      active,
      queued: waiting.length,
      requests: requests.size,
      jobs: jobs.size,
      stopped
    }),
    limits: { ...limits }
  };
}
module.exports = { createImagePreview, sniffImage, IMAGE_PREVIEW_LIMITS: LIMITS };
