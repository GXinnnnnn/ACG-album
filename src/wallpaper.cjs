'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const spec = require('./wallpaper-settings.cjs');
const LIMITS = Object.freeze({
  fileBytes: 40 * 1024 * 1024,
  inputPixels: 80000000,
  inputEdge: 32768,
  outputEdge: 7680,
  customFiles: 64,
  thumbnailWidth: 360,
  thumbnailHeight: 240,
  thumbnailCacheEntries: 72,
  thumbnailCacheBytes: 16 * 1024 * 1024
});
const BUILTINS = Object.freeze(
  [
    '104704968_p0.png',
    '104834581_p0.jpg',
    '43affc61fe1872e0c8e811bace226a2232708462.jpg',
    'HTCNoW1boAA-ied.jpg',
    '壁纸 (1).jpg',
    '壁纸 (2).jpg',
    '拜年祭2020壁纸 (1).jpg'
  ].map((name, index) =>
    Object.freeze({
      id: spec.builtinIds[index],
      name: '壁纸' + String(index + 1).padStart(2, '0'),
      sourceName: name,
      ...(index === 4 ? { theme: 'light' } : index === 6 ? { theme: 'dark' } : {})
    })
  )
);
const builtinById = new Map(BUILTINS.map((entry) => [entry.id, entry]));
const customPattern = /^custom-[a-f0-9]{64}\.webp$/;
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const wallpaperUrl = (id) => (spec.isWallpaperId(id) ? 'acg-image://wallpaper/' + id : null);
const thumbnailUrl = (id) => (spec.isWallpaperId(id) ? 'acg-image://wallpaper-thumb/' + id : null);
function parseThumbnailUrl(url) {
  if (typeof url !== 'string') return null;
  const match = /^acg-image:\/\/wallpaper-thumb\/([a-z0-9-]+)$/.exec(url);
  return match && spec.isWallpaperId(match[1]) ? match[1] : null;
}
function parseWallpaperUrl(url) {
  if (typeof url !== 'string') return null;
  // Check the raw URL: URL() would silently canonicalize dot segments and escapes.
  const match = /^acg-image:\/\/wallpaper\/([a-z0-9-]+)$/.exec(url);
  return match && spec.isWallpaperId(match[1]) ? match[1] : null;
}
function imageError(message, code = 'WALLPAPER_INVALID') {
  return Object.assign(new Error(message), { code });
}
function rasterHeader(buffer) {
  return (
    (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    /^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) ||
    isWebp(buffer) ||
    buffer.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
    buffer.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])) ||
    (buffer.toString('ascii', 4, 8) === 'ftyp' &&
      /^(avif|avis|heic|heix|hevc|hevx|mif1|msf1)$/.test(buffer.toString('ascii', 8, 12)))
  );
}
function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  );
}
async function readBounded(file, maxBytes = LIMITS.fileBytes, noLinks = false) {
  if (noLinks) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw imageError('壁纸文件不可用。');
  }
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
      throw imageError('壁纸应为不超过 40 MiB 的图片文件。');
    const chunks = [];
    let bytes = 0;
    // Stream from the opened descriptor and bound actual reads as well as stat size.
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw imageError('壁纸文件超过大小限制。');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    await handle.close();
  }
}
async function normalizeImageFile(file) {
  const input = await readBounded(file);
  if (!rasterHeader(input))
    throw imageError('请选择 PNG、JPEG、WebP、GIF、AVIF/HEIF 或 TIFF 图片。');
  const sharp = require('sharp');
  const options = { limitInputPixels: LIMITS.inputPixels, page: 0, pages: 1, failOn: 'warning' };
  try {
    const metadata = await sharp(input, options).metadata();
    if (
      !['jpeg', 'png', 'webp', 'gif', 'heif', 'tiff'].includes(metadata.format) ||
      !Number.isInteger(metadata.width) ||
      !Number.isInteger(metadata.height) ||
      metadata.width < 1 ||
      metadata.height < 1 ||
      metadata.width > LIMITS.inputEdge ||
      metadata.height > LIMITS.inputEdge ||
      metadata.width * metadata.height > LIMITS.inputPixels
    )
      throw imageError('壁纸尺寸无效或超过 8000 万像素限制。');
    // Decode exactly one frame, apply orientation, strip all metadata and active content.
    const { data, info } = await sharp(input, options)
      .rotate()
      .resize(LIMITS.outputEdge, LIMITS.outputEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (!isWebp(data) || data.length > LIMITS.fileBytes)
      throw imageError('规范化后的壁纸超过大小限制。');
    return { data, width: info.width, height: info.height, source: metadata };
  } catch (error) {
    if (error.code === 'WALLPAPER_INVALID') throw error;
    throw imageError('图片无法安全解码，或超过壁纸尺寸限制。');
  }
}
function safeName(value, fallback) {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, 120)
        .trim() || fallback
    : fallback;
}
function createWallpaperService({
  dataDir,
  assetsDir = path.join(__dirname, 'assets', 'wallpapers')
}) {
  const managedDir = path.join(dataDir, 'wallpapers');
  // Only encoded thumbnail buffers are retained; original images never enter this cache.
  const thumbnailCache = new Map();
  let thumbnailCacheBytes = 0;
  let importing = false;
  async function thumbnail(id, data, sourceDigest) {
    const cached = thumbnailCache.get(id);
    if (cached) {
      thumbnailCache.delete(id);
      if (cached.sourceDigest === sourceDigest) {
        thumbnailCache.set(id, cached);
        return cached.data;
      }
      thumbnailCacheBytes -= cached.data.length;
    }
    const sharp = require('sharp');
    const output = await sharp(data, {
      limitInputPixels: LIMITS.inputPixels,
      page: 0,
      pages: 1,
      failOn: 'warning'
    })
      .rotate()
      .resize(LIMITS.thumbnailWidth, LIMITS.thumbnailHeight, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 76, effort: 3 })
      .toBuffer();
    if (!isWebp(output)) throw imageError('壁纸缩略图无法生成。');
    if (output.length <= LIMITS.thumbnailCacheBytes) {
      // Concurrent decodes may have inserted this ID while sharp was working.
      const replaced = thumbnailCache.get(id);
      if (replaced) {
        thumbnailCacheBytes -= replaced.data.length;
        thumbnailCache.delete(id);
      }
      while (
        thumbnailCache.size >= LIMITS.thumbnailCacheEntries ||
        thumbnailCacheBytes + output.length > LIMITS.thumbnailCacheBytes
      ) {
        const oldest = thumbnailCache.keys().next().value;
        thumbnailCacheBytes -= thumbnailCache.get(oldest).data.length;
        thumbnailCache.delete(oldest);
      }
      thumbnailCache.set(id, { sourceDigest, data: output });
      thumbnailCacheBytes += output.length;
    }
    return output;
  }
  async function managedDirectory(create = false) {
    if (create) await fs.mkdir(managedDir, { recursive: true });
    const stat = await fs.lstat(managedDir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw imageError('壁纸目录必须是资料目录内的真实目录。');
    const [realHome, realManaged] = await Promise.all([
      fs.realpath(dataDir),
      fs.realpath(managedDir)
    ]);
    if (realManaged !== path.join(realHome, 'wallpapers'))
      throw imageError('壁纸目录超出受管范围。');
    return managedDir;
  }
  async function customFiles() {
    try {
      await managedDirectory();
      return (await fs.readdir(managedDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && customPattern.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  async function customEntry(id) {
    const stat = await fs.lstat(path.join(managedDir, id + '.webp'));
    if (stat.isSymbolicLink() || !stat.isFile()) throw imageError('壁纸文件不可用。');
    let sourceName = '自定义壁纸';
    // Legacy managed copies have no timestamp metadata. Their filesystem creation
    // time is stable across repeated imports; mtime is the fallback on older filesystems.
    let createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    try {
      const metadata = JSON.parse(
        await readBounded(path.join(managedDir, id + '.json'), 2048, true)
      );
      sourceName = safeName(metadata.sourceName, safeName(metadata.name, sourceName));
      if (Number.isSafeInteger(metadata.createdAt) && metadata.createdAt > 0)
        createdAt = metadata.createdAt;
    } catch {}
    return {
      id,
      sourceName,
      createdAt,
      url: wallpaperUrl(id),
      thumbnailUrl: thumbnailUrl(id),
      builtin: false
    };
  }
  async function list() {
    const builtinEntries = BUILTINS.map((entry) => ({
      ...entry,
      url: wallpaperUrl(entry.id),
      thumbnailUrl: thumbnailUrl(entry.id),
      builtin: true
    }));
    // Only this managed directory is inspected; no library or local directory scan.
    const files = (await customFiles()).slice(0, LIMITS.customFiles);
    const customEntries = await Promise.all(files.map((file) => customEntry(file.slice(0, -5))));
    customEntries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return builtinEntries.concat(
      customEntries.map((entry, index) => ({
        ...entry,
        name: '自定义' + String(index + 1).padStart(2, '0')
      }))
    );
  }
  async function listedCustomEntry(id) {
    return (await list()).find((entry) => entry.id === id);
  }
  async function importFile(file) {
    if (importing) throw imageError('正在导入壁纸，请稍候。');
    importing = true;
    try {
      const { data } = await normalizeImageFile(file);
      await managedDirectory(true);
      const id = 'custom-' + digest(data);
      const files = await customFiles();
      const destination = path.join(managedDir, id + '.webp');
      if (files.includes(id + '.webp')) {
        const existing = await readBounded(destination, LIMITS.fileBytes, true);
        if (digest(existing) !== id.slice(7)) throw imageError('已有受管壁纸损坏，请更换图片。');
        return listedCustomEntry(id);
      }
      if (files.length >= LIMITS.customFiles) throw imageError('已达到 64 张自定义壁纸上限。');
      // Exclusive creation never follows or overwrites an existing file or link.
      await fs.writeFile(destination, data, { flag: 'wx' });
      const sourceName = safeName(path.basename(file), '自定义壁纸');
      const createdAt = Date.now();
      await fs.writeFile(
        path.join(managedDir, id + '.json'),
        JSON.stringify({ sourceName, createdAt }),
        {
          flag: 'wx'
        }
      );
      return listedCustomEntry(id);
    } finally {
      importing = false;
    }
  }
  async function response(request) {
    const thumbnailId = parseThumbnailUrl(request.url);
    const id = thumbnailId || parseWallpaperUrl(request.url);
    const empty = (status) =>
      new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!id) return empty(400);
    if (request.method && !['GET', 'HEAD'].includes(request.method)) return empty(405);
    try {
      const builtin = builtinById.has(id);
      if (!builtin) await managedDirectory();
      const file = path.join(builtin ? assetsDir : managedDir, id + '.webp');
      const source = await readBounded(file, LIMITS.fileBytes, true);
      const sourceDigest = digest(source);
      if (!isWebp(source) || (!builtin && sourceDigest !== id.slice(7))) return empty(415);
      // Revalidate managed files even on a cache hit; changed or linked files fail closed.
      const data = thumbnailId ? await thumbnail(id, source, sourceDigest) : source;
      return new Response(request.method === 'HEAD' ? null : data, {
        headers: {
          'Content-Type': 'image/webp',
          'Content-Length': String(data.length),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } catch (error) {
      return empty(error.code === 'ENOENT' ? 404 : 415);
    }
  }
  return Object.freeze({ list, importFile, response });
}
function registerWallpaperHandlers({ ipcMain, dialog, getWindow, service }) {
  let selecting = false;
  function validateEmptyArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Reflect.ownKeys(args).length)
      throw imageError('壁纸操作不接受路径、URL 或其他参数。');
  }
  ipcMain.handle('library:wallpaperList', async (_, args = {}) => {
    validateEmptyArgs(args);
    return service.list();
  });
  ipcMain.handle('library:wallpaperImport', async (_, args = {}) => {
    validateEmptyArgs(args);
    if (selecting) throw imageError('正在选择或导入壁纸，请稍候。');
    selecting = true;
    try {
      const result = await dialog.showOpenDialog(getWindow(), {
        title: '选择自定义全局壁纸',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          {
            name: '图片',
            extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'heic', 'heif', 'tif', 'tiff']
          }
        ]
      });
      if (result.canceled || !result.filePaths?.length) return null;
      return await service.importFile(result.filePaths[0]);
    } finally {
      selecting = false;
    }
  });
}
module.exports = {
  LIMITS,
  BUILTINS,
  wallpaperUrl,
  thumbnailUrl,
  parseWallpaperUrl,
  parseThumbnailUrl,
  normalizeImageFile,
  createWallpaperService,
  registerWallpaperHandlers
};
