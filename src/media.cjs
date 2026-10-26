'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const sharp = require('sharp');
const HEADER_PIXELS = 80000000,
  PIXELS = 24000000,
  MEMORY = 256 * 1024 * 1024;
// Yield between items for IPC/foreground work without a fixed per-image delay.
const yieldNow = () => new Promise((resolve) => setImmediate(resolve));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const positive = (n) => finite(n) && Number.isSafeInteger(n) && n > 0;
const fail = (message) => {
  throw new Error(message);
};
const keyPath = (p) => path.resolve(p).toLowerCase();
let exifr;
function dateTaken(exif) {
  const value = exif?.DateTimeOriginal;
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})[:-](\d\d)[:-](\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi, s),
    check = new Date(utc);
  if (
    y < 1900 ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  )
    return null;
  const offset = exif.OffsetTimeOriginal || /([+-]\d\d:\d\d|Z)$/.exec(value)?.[1];
  if (offset) {
    const z = /^([+-])(\d\d):(\d\d)$/.exec(offset);
    if (offset !== 'Z' && (!z || +z[2] > 14 || +z[3] > 59 || (+z[2] === 14 && +z[3] !== 0)))
      return null;
    return {
      taken: utc - (z ? (z[1] === '-' ? -1 : 1) * (+z[2] * 60 + +z[3]) * 60000 : 0),
      date_source: 'exif-offset'
    };
  }
  // EXIF without an offset is a camera-local wall time, interpreted in this computer's timezone.
  return { taken: new Date(y, mo - 1, d, h, mi, s).getTime(), date_source: 'exif-local' };
}

/** Worker-only service. seed(): full SQL reconciliation, returns stats().
 * sync(node): synchronous single-node revision/reset; caller owns any surrounding transaction.
 * start(): Promise<stats>, drains pending rows once (32-row batches, no polling/retry loop).
 * ensure(id): Promise<details> (ready/error), high priority and one shared job per id.
 * get(id): sync details|null with parsed delays; stats(): {rows:[{status,count}],queued,active,background}.
 * stop(): Promise<void>; await before db.close(). start() can restart a stopped background drain.
 * setPlace({id,place?,latitude?,longitude?}): sync details, explicit local overrides only.
 * setVideoInfo({id,width,height}): sync details from a later browser video measurement.
 * frame()/export() signatures and editing coordinates are documented beside those methods.
 * send('media', {id,status}) signals updates. No network, source writes, or automatic retries.
 * Extras in media store override markers, raw orientation/page height and GIF loop count.
 * Limits: sequential metadata; 24 MP / conservative estimated 256 MiB per serial render;
 * GIF <=512 selected frames, width <=8192; previews <=1600; cache <=64 files/128 MiB.
 * Exports convert to SDR sRGB and embed the target ICC for PNG/JPEG/WebP (no HDR tone mapper).
 */
function createMedia({ db, home, getNode, send = () => {} }) {
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const revision = (n) =>
    one(
      "SELECT CAST(? AS TEXT)||'-'||CAST(CAST(? AS INTEGER) AS TEXT) AS revision",
      finite(n.mtime) ? n.mtime : 0,
      finite(n.bytes) ? n.bytes : 0
    ).revision;
  const cache = path.join(home, 'media-frames');
  db.exec(`CREATE TABLE IF NOT EXISTS media(
    id TEXT PRIMARY KEY,revision TEXT,width INTEGER,height INTEGER,format TEXT,frames INTEGER,delays TEXT,
    taken REAL,date_source TEXT,latitude REAL,longitude REAL,place TEXT,camera TEXT,hdr INTEGER,depth INTEGER,
    space TEXT,has_icc INTEGER,status TEXT,error TEXT,place_user INTEGER DEFAULT 0,coords_user INTEGER DEFAULT 0,
    orientation INTEGER DEFAULT 1,page_height INTEGER,loop INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS media_taken ON media(taken DESC,id DESC);
    CREATE INDEX IF NOT EXISTS media_pending_taken ON media(taken DESC,id DESC) WHERE status='pending';`);
  const initial = `INSERT INTO media(id,revision,taken,date_source,status)
    SELECT id,CAST(COALESCE(mtime,0) AS TEXT)||'-'||CAST(COALESCE(bytes,0) AS TEXT),
    CASE WHEN mtime>0 THEN mtime ELSE birth END,CASE WHEN mtime>0 THEN 'mtime' ELSE 'birth' END,'pending'
    FROM nodes WHERE kind IN ('image','video') AND missing=0`;
  const reset = ` ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,taken=excluded.taken,
    date_source=excluded.date_source,width=NULL,height=NULL,format=NULL,frames=NULL,delays=NULL,camera=NULL,
    hdr=NULL,depth=NULL,space=NULL,has_icc=NULL,orientation=1,page_height=NULL,loop=0,status='pending',error=NULL,
    latitude=CASE WHEN media.coords_user=1 THEN media.latitude ELSE NULL END,
    longitude=CASE WHEN media.coords_user=1 THEN media.longitude ELSE NULL END
    WHERE media.revision<>excluded.revision OR media.status='missing' OR (media.status='error' AND media.error='媒体服务已停止。')`;
  function seed() {
    // A set-based metadata sync: never stat or decode during the scanner's critical path.
    run(initial + reset);
    run(
      "UPDATE media SET status='missing' WHERE status<>'missing' AND NOT EXISTS(SELECT 1 FROM nodes n WHERE n.id=media.id AND n.missing=0 AND n.kind IN ('image','video'))"
    );
    return stats();
  }
  function sync(n) {
    const rev = revision(n),
      modified = finite(n.mtime) && n.mtime > 0;
    run(
      "INSERT INTO media(id,revision,taken,date_source,status) VALUES(?,?,?,?,'pending')" + reset,
      n.id,
      rev,
      modified ? n.mtime : finite(n.birth) ? n.birth : 0,
      modified ? 'mtime' : 'birth'
    );
    return rev;
  }
  function node(id) {
    if (typeof id !== 'string' || !id || id.length > 256) fail('资源编号无效。');
    const n = getNode(id);
    if (!n || n.missing || !['image', 'video'].includes(n.kind) || typeof n.path !== 'string')
      fail('资源未在索引中或已离线。');
    return n;
  }
  function get(id) {
    const r = typeof id === 'string' ? one('SELECT * FROM media WHERE id=?', id) : null;
    if (!r) return null;
    let delays = [];
    try {
      const a = JSON.parse(r.delays);
      if (Array.isArray(a))
        delays = a.slice(0, 10000).map((v) => (finite(v) && v >= 0 && v <= 655350 ? v : 100));
    } catch {}
    return {
      ...r,
      width: positive(r.width) ? r.width : null,
      height: positive(r.height) ? r.height : null,
      frames: positive(r.frames) && r.frames <= 100000 ? r.frames : 1,
      delays,
      taken: finite(r.taken) ? r.taken : null,
      latitude: finite(r.latitude) && Math.abs(r.latitude) <= 90 ? r.latitude : null,
      longitude: finite(r.longitude) && Math.abs(r.longitude) <= 180 ? r.longitude : null,
      hdr: !!r.hdr,
      has_icc: !!r.has_icc,
      hdr_note: r.hdr ? '可能为高位深或宽色域；不代表已确认 HDR。' : null
    };
  }
  const notify = (id) => {
    try {
      send('media', { id, status: get(id)?.status });
    } catch {}
  };
  const jobs = new Map(),
    queue = [];
  let pumping = null,
    background = null,
    stopped = false,
    renderTail = Promise.resolve();
  async function details(id) {
    let n = node(id),
      rev;
    const indexedRevision = revision(n);
    if (!get(id)) sync(n);
    try {
      const stat = await fsp.stat(n.path);
      if (!stat.isFile()) fail('资源不是普通文件。');
      n = { ...n, mtime: stat.mtimeMs, bytes: stat.size };
      rev = sync(n);
      if (get(id)?.status === 'ready') return get(id);
      let data;
      if (n.kind === 'video')
        data = {
          width: null,
          height: null,
          format: path.extname(n.path).slice(1),
          frames: 1,
          delays: [],
          orientation: 1
        };
      else {
        const m = await sharp(n.path, {
          limitInputPixels: HEADER_PIXELS,
          page: 0,
          pages: 1
        }).metadata();
        const width = m.width,
          height = m.pageHeight || m.height,
          orientation = m.orientation || 1;
        if (!positive(width) || !positive(height)) fail('无法读取有效图片尺寸。');
        let exif = null;
        try {
          if (exifr === undefined) {
            try {
              exifr = require('exifr');
            } catch {
              exifr = null;
            }
          }
          if (exifr) {
            const opts = {
              reviveValues: false,
              translateValues: false,
              gps: true,
              pick: [
                'DateTimeOriginal',
                'OffsetTimeOriginal',
                'Make',
                'Model',
                'GPSLatitude',
                'GPSLongitude',
                'GPSLatitudeRef',
                'GPSLongitudeRef',
                'latitude',
                'longitude'
              ]
            };
            try {
              exif = await exifr.parse(m.exif || n.path, opts);
            } catch {
              exif = await exifr.parse(n.path, opts);
            }
          }
        } catch {} // Missing EXIF/dependency never blocks local image details.
        const bits =
          m.bitsPerSample ||
          { uchar: 8, char: 8, ushort: 16, short: 16, uint: 32, int: 32, float: 32, double: 64 }[
            m.depth
          ] ||
          8;
        const profile = m.icc?.toString('latin1', 0, Math.min(m.icc.length, 65536)) || '';
        data = {
          width: orientation >= 5 ? height : width,
          height: orientation >= 5 ? width : height,
          format: m.format,
          frames: positive(m.pages) && m.pages <= 100000 ? m.pages : 1,
          delays: Array.isArray(m.delay) ? m.delay.slice(0, 10000) : [],
          ...(dateTaken(exif) || {}),
          latitude: finite(exif?.latitude) ? exif.latitude : null,
          longitude: finite(exif?.longitude) ? exif.longitude : null,
          camera:
            [exif?.Make, exif?.Model]
              .filter((v) => typeof v === 'string')
              .join(' ')
              .slice(0, 256) || null,
          hdr:
            bits > 8 ||
            /2020|display.?p3|scrgb|rgb16|2084|\bhlg\b/i.test((m.space || '') + ' ' + profile)
              ? 1
              : 0,
          depth: bits,
          space: m.space || null,
          has_icc: m.hasProfile || !!m.icc ? 1 : 0,
          orientation,
          page_height: height,
          loop: Number.isInteger(m.loop) && m.loop >= 0 ? m.loop : 0
        };
      }
      const latest = node(id),
        st = await fsp.stat(n.path);
      if (
        revision(latest) !== indexedRevision ||
        st.size !== n.bytes ||
        st.mtimeMs !== n.mtime ||
        latest.path !== n.path ||
        one('SELECT revision FROM media WHERE id=?', id)?.revision !== rev
      )
        fail('文件正在变化，请重新读取详情。');
      run(
        `UPDATE media SET width=?,height=?,format=?,frames=?,delays=?,taken=COALESCE(?,taken),date_source=COALESCE(?,date_source),
        latitude=CASE WHEN coords_user=1 THEN latitude ELSE ? END,longitude=CASE WHEN coords_user=1 THEN longitude ELSE ? END,
        camera=?,hdr=?,depth=?,space=?,has_icc=?,orientation=?,page_height=?,loop=?,status='ready',error=NULL WHERE id=? AND revision=?`,
        data.width,
        data.height,
        data.format,
        data.frames,
        JSON.stringify(data.delays),
        data.taken ?? null,
        data.date_source ?? null,
        finite(data.latitude) && Math.abs(data.latitude) <= 90 ? data.latitude : null,
        finite(data.longitude) && Math.abs(data.longitude) <= 180 ? data.longitude : null,
        data.camera ?? null,
        data.hdr ?? 0,
        data.depth ?? null,
        data.space ?? null,
        data.has_icc ?? 0,
        data.orientation,
        data.page_height ?? null,
        data.loop ?? 0,
        id,
        rev
      );
    } catch (e) {
      run(
        "UPDATE media SET status='error',error=? WHERE id=? AND (? IS NULL OR revision=?)",
        String(e.message).slice(0, 500),
        id,
        rev ?? null,
        rev ?? null
      );
    }
    notify(id);
    return get(id);
  }
  function ensure(id, lowPriority = false) {
    try {
      node(id);
    } catch (e) {
      return Promise.reject(e);
    }
    if (stopped) return Promise.reject(new Error('媒体服务已停止。'));
    if (jobs.has(id)) {
      if (!lowPriority) {
        const job = queue.find((j) => j.id === id);
        if (job) job.low = false;
      }
      return jobs.get(id);
    }
    const promise = new Promise((resolve, reject) =>
      queue.push({ id, low: lowPriority, resolve, reject })
    );
    jobs.set(id, promise);
    if (!pumping)
      pumping = (async () => {
        while (queue.length) {
          const index = queue.findIndex((j) => !j.low),
            job = queue.splice(index < 0 ? 0 : index, 1)[0];
          try {
            job.resolve(await details(job.id));
          } catch (e) {
            job.reject(e);
          } finally {
            jobs.delete(job.id);
          }
          await yieldNow();
        }
      })().finally(() => {
        pumping = null;
      });
    return promise;
  }
  function start() {
    if (background) return background;
    stopped = false;
    background = (async () => {
      while (!stopped) {
        // Keep the small pending index outermost; node indexes can otherwise
        // make SQLite visit/sort the whole library for every decoder batch.
        const batch = all(
          "SELECT m.id FROM media m CROSS JOIN nodes n ON n.id=m.id WHERE m.status='pending' AND n.missing=0 AND n.kind IN ('image','video') ORDER BY m.taken DESC,m.id DESC LIMIT 32"
        );
        if (!batch.length) break;
        for (const { id } of batch) {
          if (stopped) break;
          await yieldNow();
          if (stopped) break;
          await ensure(id, true).catch((e) => {
            if (!stopped)
              run(
                "UPDATE media SET status='error',error=? WHERE id=? AND status='pending'",
                String(e.message).slice(0, 500),
                id
              );
          });
        }
      }
      return stats();
    })().finally(() => {
      background = null;
    });
    return background;
  }
  async function stop() {
    stopped = true;
    for (const job of queue.splice(0)) {
      jobs.delete(job.id);
      job.resolve(get(job.id));
    }
    await Promise.all([pumping, background, renderTail]);
  }
  function stats() {
    return {
      rows: all('SELECT status,COUNT(*) AS count FROM media GROUP BY status'),
      queued: jobs.size,
      active: !!pumping,
      background: !!background
    };
  }
  /** Explicit local edits only. Omitted fields stay unchanged; null/empty explicitly clears them. */
  function setPlace({ id, place, latitude, longitude }) {
    const n = node(id),
      coordinates = latitude !== undefined || longitude !== undefined;
    if (place !== undefined && place !== null && (typeof place !== 'string' || place.length > 200))
      fail('地点名称最多 200 个字符。');
    if (
      coordinates &&
      !(
        (latitude === null && longitude === null) ||
        (finite(latitude) &&
          finite(longitude) &&
          Math.abs(latitude) <= 90 &&
          Math.abs(longitude) <= 180)
      )
    )
      fail('经纬度必须同时填写，纬度为 -90～90，经度为 -180～180。');
    sync(n);
    if (place !== undefined)
      run('UPDATE media SET place=?,place_user=1 WHERE id=?', place?.trim() || null, id);
    if (coordinates)
      run(
        'UPDATE media SET latitude=?,longitude=?,coords_user=1 WHERE id=?',
        latitude,
        longitude,
        id
      );
    notify(id);
    return get(id);
  }
  function setVideoInfo({ id, width, height }) {
    const n = node(id);
    if (
      n.kind !== 'video' ||
      !positive(width) ||
      !positive(height) ||
      width > 65535 ||
      height > 65535
    )
      fail('视频尺寸无效。');
    sync(n);
    run(
      "UPDATE media SET width=?,height=?,frames=1,status='ready',error=NULL WHERE id=?",
      width,
      height,
      id
    );
    notify(id);
    return get(id);
  }
  // Both preview/export renders share a serial lane; metadata jobs never decode full pixels.
  function render(fn) {
    const job = renderTail.then(() => {
      if (stopped) fail('媒体服务已停止。');
      return fn();
    });
    renderTail = job.catch(() => {});
    return job;
  }
  function budget(width, height, count, outWidth, outHeight) {
    if (
      ![width, height, count, outWidth, outHeight].every(positive) ||
      width * height * count > PIXELS ||
      outWidth * outHeight * count > PIXELS ||
      (width * height + outWidth * outHeight) * count * 16 > MEMORY
    )
      fail(
        '图片或所选帧超过 2400 万像素／256 MiB 处理预算。请缩短帧范围、减小尺寸，或使用专业图像工具。'
      );
  }
  async function ready(id) {
    const n = node(id),
      m = await ensure(id);
    if (n.kind !== 'image') fail('视频由浏览器播放，暂不支持图片帧或导出。');
    if (m?.status !== 'ready' || !m.width || !m.height)
      fail(m?.error || '图片详情尚不可用，请重试。');
    return { n: node(id), m };
  }
  /** Single zero-based frame; returns {path,width,height}. Cache is app-owned, never the source. */
  function frame(id, index = 0, size = 1600) {
    return render(async () => {
      const { n, m } = await ready(id);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= m.frames ||
        !Number.isInteger(size) ||
        size < 1 ||
        size > 1600
      )
        fail('帧编号或预览尺寸无效（最大 1600）。');
      const scale = Math.min(1, size / m.width, size / m.height),
        w = Math.max(1, Math.round(m.width * scale)),
        h = Math.max(1, Math.round(m.height * scale));
      budget(m.width, m.height, 1, w, h);
      await fsp.mkdir(cache, { recursive: true });
      const hash = createHash('sha256')
          .update(`${id}|${m.revision}|${index}|${size}`)
          .digest('hex'),
        destination = path.join(cache, hash + '.webp');
      if (!fs.existsSync(destination)) {
        const temp = path.join(cache, hash + '.' + randomUUID() + '.tmp');
        try {
          await sharp(n.path, { page: index, pages: 1, limitInputPixels: PIXELS })
            .autoOrient()
            .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
            .toColourspace('srgb')
            .webp({ quality: 85 })
            .toFile(temp);
          await fsp.rename(temp, destination);
        } finally {
          await fsp.unlink(temp).catch(() => {});
        }
      }
      const entries = await fsp.readdir(cache),
        files = [];
      for (const name of entries)
        if (/^[a-f0-9]{64}\.webp$/.test(name)) {
          const file = path.join(cache, name),
            st = await fsp.stat(file).catch(() => null);
          if (st) files.push({ file, mtime: st.mtimeMs, bytes: st.size });
        }
      files.sort((a, b) => b.mtime - a.mtime);
      let bytes = 0;
      for (let i = 0; i < files.length; i++) {
        bytes += files[i].bytes;
        if ((i >= 64 || bytes > 128 * 1024 * 1024) && files[i].file !== destination)
          await fsp.unlink(files[i].file).catch(() => {});
      }
      return {
        path: destination,
        width: Math.max(1, Math.round(m.width * Math.min(1, size / m.width, size / m.height))),
        height: Math.max(1, Math.round(m.height * Math.min(1, size / m.width, size / m.height)))
      };
    });
  }
  /** Worker INTERNAL only, after main-process SaveDialog. edit: crop {x,y,w,h} in oriented
   * 0..1 coordinates, brightness/contrast .5..1.5, saturation 0..2, rotation multiple of 90,
   * width 1..8192, from/to inclusive zero-based GIF frames, delay 0..65535 ms (number/array), loop 0..65535.
   * Output is SDR sRGB; Sharp strips EXIF/GPS by default. Existing destinations always refused.
   * Final hard-link commit is atomic and exclusive (rename would overwrite on POSIX).
   */
  function exportCopy({ id, destination, edit = {} }) {
    return render(async () => {
      const { n, m } = await ready(id);
      if (
        !edit ||
        typeof edit !== 'object' ||
        Array.isArray(edit) ||
        typeof destination !== 'string' ||
        !path.isAbsolute(destination)
      )
        fail('请选择有效的导出位置和编辑参数。');
      destination = path.resolve(destination);
      const extension = path.extname(destination).toLowerCase(),
        format = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif' }[
          extension
        ];
      if (!format) fail('请选择 PNG、JPEG、WebP 或 GIF 扩展名。');
      const parent = await fsp.realpath(path.dirname(destination)),
        target = path.join(parent, path.basename(destination));
      const source = await fsp.realpath(n.path);
      if (
        keyPath(target) === keyPath(source) ||
        one('SELECT id FROM nodes WHERE path=? COLLATE NOCASE', destination) ||
        one('SELECT id FROM nodes WHERE path=? COLLATE NOCASE', target)
      )
        fail('不能覆盖原文件或任何已索引路径，请另存为新文件。');
      try {
        await fsp.lstat(target);
        fail('目标文件已存在，请更换文件名。');
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      const value = (name, defaultValue, min, max) => {
        const v = edit[name] === undefined ? defaultValue : edit[name];
        if (!finite(v) || v < min || v > max) fail(`${name} 参数超出允许范围。`);
        return v;
      };
      const brightness = value('brightness', 1, 0.5, 1.5),
        contrast = value('contrast', 1, 0.5, 1.5),
        saturation = value('saturation', 1, 0, 2);
      const angle = value('rotation', 0, -3600, 3600);
      if (angle % 90) fail('旋转角度必须为 90 度的整数倍。');
      const rotation = ((angle % 360) + 360) % 360;
      const crop = edit.crop ?? { x: 0, y: 0, w: 1, h: 1 };
      if (
        !crop ||
        !['x', 'y', 'w', 'h'].every((k) => finite(crop[k])) ||
        crop.x < 0 ||
        crop.y < 0 ||
        crop.w <= 0 ||
        crop.h <= 0 ||
        crop.x + crop.w > 1 + 1e-9 ||
        crop.y + crop.h > 1 + 1e-9
      )
        fail('裁剪区域必须为图片内的 0～1 归一化坐标。');
      const left = Math.min(m.width - 1, Math.floor(crop.x * m.width)),
        top = Math.min(m.height - 1, Math.floor(crop.y * m.height));
      const cw = Math.max(1, Math.min(m.width - left, Math.round(crop.w * m.width))),
        ch = Math.max(1, Math.min(m.height - top, Math.round(crop.h * m.height)));
      const swap = rotation % 180 !== 0,
        width = value('width', Math.min(swap ? ch : cw, 8192), 1, 8192);
      if (!Number.isInteger(width)) fail('输出宽度必须为整数。');
      const height = Math.max(1, Math.round((width * (swap ? cw : ch)) / (swap ? ch : cw)));
      const from = value('from', 0, 0, m.frames - 1),
        to = value('to', format === 'gif' ? m.frames - 1 : from, from, m.frames - 1);
      if (!Number.isInteger(from) || !Number.isInteger(to)) fail('帧范围必须为整数。');
      const count = format === 'gif' ? to - from + 1 : 1;
      if (count > 512) fail('GIF 最多导出 512 帧，请缩短所选范围。');
      budget(m.width, m.height, count, width, height);
      const loop = value('loop', m.loop || 0, 0, 65535);
      if (!Number.isInteger(loop)) fail('循环次数必须为整数。');
      let delays = edit.delay ?? m.delays.slice(from, from + count);
      if (!Array.isArray(delays)) delays = Array(count).fill(delays);
      if (!delays.length) delays = Array(count).fill(100);
      if (delays.length !== count || delays.some((d) => !Number.isInteger(d) || d < 0 || d > 65535))
        fail('Sharp 编码器要求每帧延迟为 0～65535 毫秒整数；请调小延迟或填写完整帧列表。');
      const temp = path.join(parent, '.acg-export-' + randomUUID() + '.tmp');
      try {
        const cropImage = (image) =>
          image.autoOrient().extract({ left, top, width: cw, height: ch });
        const finish = (image) =>
          image
            .resize({ width: swap ? height : width, height: swap ? width : height, fit: 'fill' })
            .toColourspace('srgb')
            .modulate({ brightness, saturation })
            .linear(contrast, 128 * (1 - contrast))
            .rotate(rotation);
        let image;
        if (count > 1) {
          const pages = [];
          if (m.orientation !== 1) {
            // Rare oriented TIFF/WebP: orient each selected page before its oriented crop.
            for (let i = 0; i < count; i++)
              pages.push(
                await finish(
                  cropImage(sharp(n.path, { page: from + i, pages: 1, limitInputPixels: PIXELS }))
                )
                  .ensureAlpha()
                  .raw()
                  .toBuffer()
              );
          } else {
            // Read the selected animated subset and crop each page with Sharp. Resize/rotate
            // isolated raw pages: strip interpolation can bleed across frame boundaries, and
            // rotating an entire strip by 180° would reverse frame order without its delays.
            const { data, info } = await cropImage(
              sharp(n.path, { page: from, pages: count, limitInputPixels: PIXELS })
            )
              .toColourspace('srgb')
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            const frameHeight = info.height / count,
              stride = info.width * frameHeight * 4;
            if (!positive(frameHeight)) fail('无法安全分离动画帧，请尝试缩短帧范围。');
            for (let i = 0; i < count; i++) {
              pages.push(
                await finish(
                  sharp(data.subarray(i * stride, (i + 1) * stride), {
                    raw: { width: info.width, height: frameHeight, channels: 4 }
                  })
                )
                  .raw()
                  .toBuffer()
              );
              if (i % 16 === 15) await yieldNow();
            }
          }
          image = sharp(Buffer.concat(pages), {
            raw: { width, height: height * count, channels: 4, pageHeight: height },
            limitInputPixels: PIXELS
          });
        } else
          image = finish(
            cropImage(sharp(n.path, { page: from, pages: 1, limitInputPixels: PIXELS }))
          );
        if (format === 'gif') image = image.gif({ delay: delays, loop, effort: 3 });
        else if (format === 'jpeg')
          image = image.flatten({ background: '#ffffff' }).jpeg({ quality: 92 });
        else if (format === 'webp') image = image.webp({ quality: 92 });
        else image = image.png();
        if (format !== 'gif') image = image.withIccProfile('srgb');
        await image.toFile(temp);
        // File links in the chosen real parent work on NTFS; no overwrite even if another
        // process creates the target after our lstat. Unsupported filesystems fail safely.
        await fsp.link(temp, target);
        return {
          path: target,
          width,
          height,
          frames: count,
          format,
          color: 'sRGB SDR',
          metadata: 'EXIF/GPS removed'
        };
      } catch (e) {
        if (e.code === 'EEXIST') fail('目标文件已存在，请更换文件名。');
        if (['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM'].includes(e.code))
          fail('目标位置不支持安全新建副本或无写入权限，请选择可写的本地 NTFS 文件夹。');
        throw new Error('导出失败：' + e.message);
      } finally {
        await fsp.unlink(temp).catch(() => {});
      }
    });
  }
  return {
    seed,
    sync,
    start,
    ensure,
    get,
    stop,
    stats,
    setPlace,
    setVideoInfo,
    frame,
    export: exportCopy
  };
}
module.exports = { createMedia };
