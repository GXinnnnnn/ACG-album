'use strict';
// Lead runs this serially: node scripts/check-media-compat.cjs
// Optional: ACG_EXECUTABLE=<built exe>; ACG_HEIC_FIXTURE=<public HEVC/HEIC sample>.
// Workspace Node/dependencies only. Does not download, touch personal libraries, or launch an OS player.
// All generated fixtures/profile/evidence remain in realpath(artifacts)/media_compat/<timestamp_uuid>.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');

const root = path.resolve(__dirname, '..');
const WIDTH = 37,
  HEIGHT = 23;
const report = {
  started: new Date().toISOString(),
  passed: false,
  checks: [],
  errors: [],
  runtime: { isPackaged: null, version: null, executable: null },
  screenshots: [],
  coverage: {},
  fixtures: [],
  originals: [],
  previews: [],
  viewer: [],
  video: [],
  consoleErrors: [],
  blockedNetwork: [],
  node: { version: process.version, executable: process.execPath }
};
let run, profile, collection, app, page, externalHeic, externalHeicHash;
const fixtures = [];
const hashes = new Map();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const digest = (data) => createHash('sha256').update(data).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function within(parent, file) {
  const relative = path.relative(parent, file);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative),
    `Path escapes isolated directory: ${file}`
  );
}
function errorRecord(source, error) {
  return { source, message: error.message || String(error), stack: error.stack };
}
async function screenshot(name) {
  if (!page || page.isClosed()) return;
  const file = path.join(run, name.replace(/[^a-z0-9_-]/gi, '_') + '.png');
  await page.screenshot({ path: file, scale: 'css', timeout: 10000 });
  report.screenshots.push(file);
}
async function check(name, action, fatal = false) {
  const began = Date.now();
  let timer;
  try {
    const details = await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(
            Object.assign(new Error('Compatibility check timed out after 60 seconds: ' + name), {
              code: 'MEDIA_COMPAT_TIMEOUT'
            })
          );
        }, 60000);
      })
    ]);
    report.checks.push({
      name,
      passed: true,
      ms: Date.now() - began,
      ...(details === undefined ? {} : { details })
    });
    console.log('PASS ' + name);
    return true;
  } catch (error) {
    report.checks.push({
      name,
      passed: false,
      ms: Date.now() - began,
      error: error.message,
      stack: error.stack
    });
    report.errors.push(errorRecord(name, error));
    process.exitCode = 1;
    console.error('FAIL ' + name + '\n' + error.stack);
    await screenshot('failure_' + report.checks.length).catch(() => {});
    if (fatal || error.code === 'MEDIA_COMPAT_TIMEOUT') throw error;
    return false;
  } finally {
    clearTimeout(timer);
  }
}
function pixels(width = WIDTH, height = HEIGHT) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = (x * 17 + y * 3) % 256;
      data[at + 1] = (y * 23 + x * 5) % 256;
      data[at + 2] = (x * 7 + y * 11) % 256;
      data[at + 3] = x < width / 3 ? 0 : x < (width * 2) / 3 ? 96 : 255;
    }
  return data;
}
function image(width = WIDTH, height = HEIGHT) {
  return sharp(pixels(width, height), { raw: { width, height, channels: 4 } });
}
function bmp24() {
  const width = 7,
    height = 5,
    stride = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(54 + stride * height);
  data.write('BM');
  data.writeUInt32LE(data.length, 2);
  data.writeUInt32LE(54, 10);
  data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18);
  data.writeInt32LE(height, 22);
  data.writeUInt16LE(1, 26);
  data.writeUInt16LE(24, 28);
  data.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = 54 + (height - 1 - y) * stride + x * 3;
      data[at] = (x * 17 + y * 31) % 256;
      data[at + 1] = y * 41;
      data[at + 2] = x * 33;
    }
  return data;
}
function dibIco() {
  // A single 8x6 32-bit BITMAPINFOHEADER DIB, bottom-up XOR pixels + padded AND mask.
  const width = 8,
    height = 6,
    xorBytes = width * height * 4,
    maskStride = 4;
  const dib = Buffer.alloc(40 + xorBytes + maskStride * height);
  dib.writeUInt32LE(40);
  dib.writeInt32LE(width, 4);
  dib.writeInt32LE(height * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(xorBytes, 20);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = 40 + (height - 1 - y) * width * 4 + x * 4;
      dib[at] = x * 27;
      dib[at + 1] = y * 39;
      dib[at + 2] = 240 - x * 17;
      dib[at + 3] = x === 0 ? 0 : x === 1 ? 96 : 255;
      if (x === 0) dib[40 + xorBytes + (height - 1 - y) * maskStride] |= 128;
    }
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = width;
  header[7] = height;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(dib.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, dib]);
}
async function fixture(key, filename, data, options) {
  const file = path.join(collection, filename);
  within(run, file);
  await fs.writeFile(file, data, { flag: 'wx' });
  const item = { key, file, id: idFor(file), ...options };
  fixtures.push(item);
  hashes.set(file, digest(data));
  report.fixtures.push({ ...item, bytes: data.length, sha256: hashes.get(file) });
  return item;
}
const find = (key) => {
  const item = fixtures.find((entry) => entry.key === key);
  assert.ok(item, 'Missing generated fixture ' + key);
  return item;
};
async function setup() {
  const archive = await fs.realpath(path.join(root, 'artifacts'));
  assert.ok(samePath(archive, 'C:\\ACG\\资料归档'), `Unexpected artifacts realpath: ${archive}`);
  const base = path.join(archive, 'media_compat');
  await fs.mkdir(base, { recursive: true });
  assert.ok(samePath(await fs.realpath(base), base), 'media_compat must be a real child directory');
  run = path.join(base, new Date().toISOString().replace(/[:.]/g, '-') + '_' + randomUUID());
  await fs.mkdir(run);
  assert.ok(samePath(await fs.realpath(run), run));
  within(archive, run);
  profile = path.join(run, 'profile');
  collection = path.join(run, '素材 中文 #百分% 空格');
  await fs.mkdir(profile);
  await fs.mkdir(collection);
  report.run = run;
  report.archive = archive;
  report.profile = profile;
  report.collection = collection;
  sharp.cache({ memory: 24, files: 0, items: 32 });
  sharp.concurrency(1);
  const png = await image().png().toBuffer();
  await fixture('png', '01 非均匀 #100% alpha.png', png, {
    mime: 'image/png',
    width: WIDTH,
    height: HEIGHT,
    alpha: true
  });
  await fixture(
    'jpeg',
    '02 非均匀 照片.jpg',
    await image().flatten({ background: '#f5f5f5' }).jpeg({ quality: 92 }).toBuffer(),
    { mime: 'image/jpeg', width: WIDTH, height: HEIGHT }
  );
  await fixture('webp', '03 透明.webp', await image().webp({ lossless: true }).toBuffer(), {
    mime: 'image/webp',
    width: WIDTH,
    height: HEIGHT,
    alpha: true
  });
  await fixture(
    'avif',
    '04 非均匀.avif',
    await image().avif({ quality: 70, effort: 1 }).toBuffer(),
    { mime: 'image/avif', width: WIDTH, height: HEIGHT }
  );
  await fixture(
    'tiff',
    '05 TIFF 透明.tiff',
    await image().tiff({ compression: 'lzw' }).toBuffer(),
    { mime: 'image/tiff', width: WIDTH, height: HEIGHT, alpha: true, mustPreview: true }
  );
  await fixture(
    'orientation',
    '06 TIFF 方向6.tif',
    await image().withMetadata({ orientation: 6 }).tiff({ compression: 'lzw' }).toBuffer(),
    {
      mime: 'image/tiff',
      width: HEIGHT,
      height: WIDTH,
      alpha: true,
      mustPreview: true,
      orientation: 6
    }
  );
  await fixture('gif', '07 非均匀.gif', await image().gif({ colours: 32 }).toBuffer(), {
    mime: 'image/gif',
    width: WIDTH,
    height: HEIGHT
  });
  await fixture('bmp', '08 极小合法24位.bmp', bmp24(), { mime: 'image/bmp', width: 7, height: 5 });
  await fixture('ico', '09 极小DIB透明.ico', dibIco(), {
    mime: 'image/x-icon',
    width: 8,
    height: 6,
    alpha: true
  });
  // Both original transport and forced preview must identify the actual PNG bytes.
  await fixture('mismatch', '10 PNG内容 #%.jpg', png, {
    mime: 'image/png',
    width: WIDTH,
    height: HEIGHT,
    alpha: true,
    contentFormat: 'png'
  });
  await fixture('stale', '11 仅用于缓存失效的生成素材.png', await image(19, 13).png().toBuffer(), {
    mime: 'image/png',
    width: 19,
    height: 13,
    alpha: true
  });
  // One solid 27 MP source; no large raw JS buffer, no batch or stress input.
  const large = await sharp({
    create: { width: 3000, height: 9000, channels: 3, background: '#6380a5' }
  })
    .jpeg({ quality: 35 })
    .toBuffer();
  assert.ok(large.length < 1024 * 1024, '27 MP fixture must stay below 1 MiB on disk');
  await fixture('large', '12 超过编辑24MP仍应可看_27MP.jpg', large, {
    mime: 'image/jpeg',
    width: 3000,
    height: 9000
  });
  await fixture('corrupt', '90 已截断PNG真实失败.png', png.subarray(0, 40), {
    mime: 'image/png',
    corrupt: true
  });
  // Truncated ASF/EBML containers exercise a real HTMLMediaElement native error.
  await fixture(
    'wmv',
    '91 损坏容器.wmv',
    Buffer.concat([Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'), Buffer.alloc(48)]),
    { mime: 'video/x-ms-wmv', video: true }
  );
  await fixture(
    'mkv',
    '92 损坏容器.mkv',
    Buffer.from(
      '1a45dfa39f4286810142f7810142f2810442f381084282846d6174726f736b611853806701',
      'hex'
    ),
    { mime: 'video/x-matroska', video: true }
  );
  if (process.env.ACG_HEIC_FIXTURE) {
    externalHeic = await fs.realpath(path.resolve(process.env.ACG_HEIC_FIXTURE));
    const stat = await fs.stat(externalHeic);
    assert.ok(
      stat.isFile() && stat.size > 0 && stat.size <= 16 * 1024 * 1024,
      'Public HEIC sample must be a nonempty regular file <=16 MiB'
    );
    const data = await fs.readFile(externalHeic);
    assert.equal(
      data.toString('ascii', 4, 8),
      'ftyp',
      'HEIC fixture needs an ISO-BMFF ftyp header'
    );
    assert.match(
      data.subarray(8, 128).toString('ascii'),
      /heic|heix|hevc|hevx|mif1|msf1/,
      'Supply an actual public HEVC/HEIC sample'
    );
    externalHeicHash = digest(data);
    const file = path.join(collection, '13 公开样本的隔离副本.heic');
    await fs.copyFile(externalHeic, file, constants.COPYFILE_EXCL);
    const item = { key: 'heic', file, id: idFor(file), mime: 'image/heic', mustPreview: true };
    fixtures.push(item);
    hashes.set(file, externalHeicHash);
    report.fixtures.push({
      ...item,
      bytes: stat.size,
      sha256: externalHeicHash,
      source: externalHeic
    });
    report.coverage.heic = { covered: true, suppliedPublicFixture: externalHeic };
  } else {
    report.coverage.heic = {
      covered: false,
      reason:
        'ACG_HEIC_FIXTURE not supplied; no public HEIC sample copied. This run cannot certify HEIC decoding.'
    };
  }
  return {
    run,
    fixtures: fixtures.length,
    largeJpegBytes: large.length,
    largePixels: 27000000,
    heic: report.coverage.heic
  };
}
async function seed() {
  // Disable network and fs.watch before requiring the unmodified real library worker.
  const worker = new Worker(
    `
    'use strict';
    const { workerData, parentPort } = require('node:worker_threads');
    const forbidden = (operation) => {
      parentPort.postMessage({ event: 'compat:forbidden', data: operation });
      throw new Error('Media compatibility fixture worker forbids ' + operation);
    };
    globalThis.fetch = async () => forbidden('fetch');
    for (const name of ['node:http', 'node:https']) {
      const module = require(name);
      module.request = module.get = () => forbidden(name);
    }
    require('node:fs').watch = () => forbidden('fs.watch');
    require(workerData.entry);
  `,
    {
      eval: true,
      workerData: {
        entry: path.join(root, 'src/library-worker.cjs'),
        dataDir: profile,
        watch: false,
        token: '',
        localIndexPath: path.join(run, 'absent_index.sqlite')
      }
    }
  );
  const pending = new Map(),
    forbidden = [];
  let serial = 0,
    readyResolve,
    readyReject,
    readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
    readyTimer = setTimeout(() => reject(new Error('Fixture worker ready timeout')), 30000);
  });
  const fail = (error) => {
    readyReject(error);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (code !== 0 || pending.size) fail(new Error('Fixture worker exited: ' + code));
  });
  worker.on('message', (message) => {
    if (message.event === 'ready') {
      clearTimeout(readyTimer);
      readyResolve();
    }
    if (message.event === 'compat:forbidden') forbidden.push(message.data);
    const entry = pending.get(message.request);
    if (!entry) return;
    pending.delete(message.request);
    clearTimeout(entry.timer);
    message.error
      ? entry.reject(Object.assign(new Error(message.error), { code: message.code }))
      : entry.resolve(message.result);
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++serial;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Fixture worker RPC timeout: ' + method));
      }, 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await ready;
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['liquidGlass', true],
      ['motionLevel', 'high'],
      ['theme', 'light']
    ])
      await call('settings', { key, value });
    const scanned = await call('scan', {
      path: collection,
      onlineMatch: false,
      directoryKind: 'photo',
      offline: true
    });
    assert.equal(scanned.cancelled, false);
    assert.equal(scanned.errors, 0);
    const initial = await call('init');
    assert.equal(initial.settings.autoMatch, false);
    assert.equal(initial.settings.watchChanges, false);
    assert.equal(initial.roots.length, 1);
    assert.ok(samePath(initial.roots[0].path, collection));
    for (const item of fixtures) {
      const node = await call('get', { id: item.id });
      assert.ok(node && !node.missing, 'Fixture must be indexed: ' + item.key);
      assert.equal(node.kind, item.video ? 'video' : 'image');
      assert.ok(samePath(node.path, item.file));
    }
    await call('shutdown');
    assert.deepEqual(forbidden, [], 'Fixture worker must not attempt network or watches');
    return { scan: scanned, settings: { autoMatch: false, watchChanges: false }, forbidden };
  } finally {
    clearTimeout(readyTimer);
    for (const entry of pending.values()) clearTimeout(entry.timer);
    await worker.terminate();
  }
}
async function launch() {
  const executable = process.env.ACG_EXECUTABLE
    ? path.resolve(process.env.ACG_EXECUTABLE)
    : require('electron');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable,
    args: process.env.ACG_EXECUTABLE ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(errorRecord('renderer pageerror', error)));
  page.on('console', (message) => {
    if (message.type() === 'error') report.consoleErrors.push(message.text());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    const url = route.request().url();
    report.blockedNetwork.push({ source: 'renderer', url });
    await route.abort();
  });
  const runtime = await app.evaluate(
    ({ app, BrowserWindow, shell, net, session }, files) => {
      globalThis.__mediaCompat = {
        calls: [],
        failure: '',
        blockedNetwork: [],
        allowed: files.map((file) => file.toLowerCase())
      };
      // Keep library:openMedia, get-node validation and worker IPC intact; only the OS boundary is replaced.
      shell.openPath = async (file) => {
        const state = globalThis.__mediaCompat;
        state.calls.push({ path: file, failure: state.failure, time: Date.now() });
        if (!state.allowed.includes(file.toLowerCase()))
          throw new Error('Unexpected non-fixture OS path: ' + file);
        return state.failure;
      };
      const original = net.fetch.bind(net);
      net.fetch = (input, ...options) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (/^https?:\/\//i.test(url)) {
          globalThis.__mediaCompat.blockedNetwork.push(url);
          return Promise.reject(new Error('Public HTTP blocked by media compatibility check'));
        }
        return original(input, ...options);
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          globalThis.__mediaCompat.blockedNetwork.push(details.url);
          callback({ cancel: true });
        }
      );
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1400, 1000);
      win.show();
      win.focus();
      return {
        isPackaged: app.isPackaged,
        version: app.getVersion(),
        executable: process.execPath,
        userData: app.getPath('userData'),
        versions: process.versions
      };
    },
    fixtures.map((item) => item.file)
  );
  report.runtime = runtime;
  assert.ok(
    samePath(runtime.userData, path.join(profile, 'chromium-profile')),
    'Electron must use isolated Chromium profile'
  );
  if (process.env.ACG_EXECUTABLE) assert.ok(samePath(runtime.executable, executable));
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.loadVersion > 0 &&
      typeof openViewer === 'function' &&
      !!window.albumLiquidGlass
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => {
    window.__mediaCompatRejections = [];
    window.addEventListener('unhandledrejection', (event) =>
      window.__mediaCompatRejections.push(String(event.reason?.stack || event.reason))
    );
    window.__mediaCompatNativeErrors = [];
    const player = document.querySelector('#viewer-video');
    player.addEventListener('error', (event) => {
      window.__mediaCompatLastVideoError = player.onerror;
      window.__mediaCompatNativeErrors.push({
        id: V.node?.id,
        code: player.error?.code,
        trusted: event.isTrusted,
        src: player.currentSrc || player.src
      });
    });
  });
  const initial = await rpc('init');
  assert.ok(samePath(initial.dataDir, profile));
  assert.equal(initial.settings.autoMatch, false);
  assert.equal(initial.settings.watchChanges, false);
  assert.equal(initial.roots.length, 1);
  assert.ok(samePath(initial.roots[0].path, collection));
  return runtime;
}
async function original(item) {
  const response = await page.evaluate(async (id) => {
    const response = await fetch('acg-image://original/' + id, { cache: 'no-store' });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      mime: (response.headers.get('content-type') || '').split(';')[0].toLowerCase(),
      bytes: bytes.length,
      prefix: Array.from(bytes.subarray(0, 16))
    };
  }, item.id);
  report.originals.push({ key: item.key, ...response });
  assert.equal(response.status, 200, item.key + ': original HTTP status');
  assert.equal(response.mime, item.mime, item.key + ': original transport MIME');
  assert.equal(response.bytes, (await fs.stat(item.file)).size);
  assert.ok(response.bytes > 0);
  if (item.contentFormat === 'png')
    assert.deepEqual(response.prefix.slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  return response;
}
async function previewProtocol(item, width, height, size = 8192) {
  const response = await page.evaluate(
    async ({ id, size }) => {
      const response = await fetch('acg-image://preview/' + id + '?size=' + size, {
        cache: 'no-store'
      });
      const blob = await response.blob();
      const result = {
        status: response.status,
        mime: (response.headers.get('content-type') || '').split(';')[0].toLowerCase(),
        bytes: blob.size
      };
      if (!response.ok) return { ...result, error: await blob.text() };
      // Use the shipped protocol directly; product CSP deliberately disallows blob images.
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('Actual preview protocol image decode failed'));
        image.src = 'acg-image://preview/' + id + '?size=' + size;
      });
      return { ...result, width: image.naturalWidth, height: image.naturalHeight };
    },
    { id: item.id, size }
  );
  assert.equal(response.status, 200, item.key + ': preview protocol ' + JSON.stringify(response));
  assert.equal(response.mime, 'image/webp');
  assert.ok(response.bytes > 0);
  assert.ok(response.width > 0 && response.height > 0);
  if (width !== undefined) assert.equal(response.width, width);
  if (height !== undefined) assert.equal(response.height, height);
  report.previews.push({ key: item.key, protocol: response });
  return response;
}
async function open(item) {
  await page.evaluate(async (id) => {
    const node = await window.album.call('get', { id });
    if (!node || node.missing) throw new Error('Missing viewer fixture ' + id);
    await openViewer(node, 0, true);
  }, item.id);
}
async function viewerReady(item) {
  await page.waitForFunction((id) => {
    const image = document.querySelector('#viewer-image');
    return (
      document.querySelector('#viewer').open &&
      V.node?.id === id &&
      !image.hidden &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.naturalHeight > 0 &&
      document.querySelector('#viewer-loading').hidden
    );
  }, item.id);
  const state = await page.evaluate(() => {
    const image = document.querySelector('#viewer-image');
    return {
      id: V.node.id,
      src: image.src,
      width: image.naturalWidth,
      height: image.naturalHeight,
      position: document.querySelector('#viewer-position').textContent,
      path: document.querySelector('#viewer-path').textContent,
      footerChildren: [...document.querySelector('.viewer-bottom').children].map((node) => ({
        tag: node.tagName,
        id: node.id,
        className: node.className
      }))
    };
  });
  assert.equal(state.path, item.file);
  if (item.width) assert.equal(state.width, item.width, item.key + ': displayed width');
  if (item.height) assert.equal(state.height, item.height, item.key + ': displayed height');
  if (item.mustPreview) {
    assert.ok(
      state.src.startsWith('acg-image://preview/' + item.id),
      item.key + ': actual viewer must use compatibility preview'
    );
    assert.match(state.position, /SDR 静态预览/);
  }
  report.viewer.push({ key: item.key, ...state });
  return state;
}
async function forcedPreview(item, expectedFormat) {
  const first = await rpc('prepareImagePreview', { id: item.id, size: 128 });
  assert.equal(first.mime, 'image/webp');
  assert.equal(first.converted, true);
  assert.equal(first.original, false);
  assert.equal(first.width, item.width);
  assert.equal(first.height, item.height);
  assert.equal(first.sourceWidth, item.width);
  assert.equal(first.sourceHeight, item.height);
  if (expectedFormat) assert.equal(first.format, expectedFormat);
  within(profile, await fs.realpath(first.path));
  assert.ok(!samePath(first.path, item.file));
  const { data, info } = await sharp(first.path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, item.width);
  assert.equal(info.height, item.height);
  if (item.alpha) {
    const alpha = [];
    for (let at = 3; at < data.length; at += 4) alpha.push(data[at]);
    assert.ok(
      alpha.some((value) => value === 0),
      item.key + ': transparent pixels preserved'
    );
    assert.ok(
      alpha.some((value) => value > 0 && value < 255),
      item.key + ': partial alpha preserved'
    );
    assert.ok(
      alpha.some((value) => value === 255),
      item.key + ': opaque pixels preserved'
    );
  }
  if (item.orientation === 6) {
    // A clockwise rotation moves the original transparent left third to the top third.
    assert.equal(data[3], 0);
    assert.equal(data[(item.height - 1) * item.width * 4 + 3], 255);
  }
  const cached = await rpc('prepareImagePreview', { id: item.id, size: 128 });
  assert.equal(cached.decoder, 'cache');
  assert.equal(cached.path, first.path);
  assert.equal(cached.key, first.key);
  for (const key of ['width', 'height', 'sourceWidth', 'sourceHeight'])
    assert.equal(cached[key], first[key], 'Cached ' + key + ' must be retained');
  await previewProtocol(item, item.width, item.height, 128);
  report.previews.push({ key: item.key, first, cached });
  return { first, cached };
}
const shellState = () =>
  app.evaluate(() => ({
    calls: globalThis.__mediaCompat.calls,
    failure: globalThis.__mediaCompat.failure
  }));
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function videoHandoff(item, failure = '') {
  await app.evaluate((_, failure) => {
    globalThis.__mediaCompat.failure = failure;
  }, failure);
  const before = (await shellState()).calls.length;
  const nativeBefore = await page.evaluate(() => window.__mediaCompatNativeErrors.length);
  await open(item);
  await page.waitForFunction(
    ({ id, offset }) =>
      window.__mediaCompatNativeErrors
        .slice(offset)
        .some((entry) => entry.id === id && entry.trusted && [2, 3, 4].includes(entry.code)),
    { id: item.id, offset: nativeBefore },
    { timeout: 8000 }
  );
  const expectedText = failure ? '系统播放器打开失败：' : '已交给系统默认播放器。';
  await expect(page.locator('#viewer-loading')).toContainText(expectedText);
  if (failure) await expect(page.locator('#viewer-loading')).toContainText(failure);
  const after = await shellState();
  assert.equal(
    after.calls.length,
    before + 1,
    'One real native error must make exactly one openMedia OS call'
  );
  assert.ok(samePath(after.calls.at(-1).path, item.file));
  assert.equal(after.calls.at(-1).failure, failure);
  await page.evaluate(() => {
    window.__mediaCompatLastVideoError?.();
    window.__mediaCompatLastVideoError?.();
  });
  await frames();
  assert.equal(
    (await shellState()).calls.length,
    before + 1,
    'Repeated error callbacks must not hand off twice'
  );
  await screenshot('video_' + item.key + (failure ? '_os_failure' : '_handoff'));
  const nativeErrors = await page.evaluate(
    (offset) => window.__mediaCompatNativeErrors.slice(offset),
    nativeBefore
  );
  report.video.push({ key: item.key, failure, calls: after.calls.slice(before), nativeErrors });
  await open(find('png'));
  await viewerReady(find('png'));
  assert.equal(
    (await shellState()).calls.length,
    before + 1,
    'Switching back to an image must not open another OS player'
  );
  await app.evaluate(() => {
    globalThis.__mediaCompat.failure = '';
  });
}
async function main() {
  try {
    await check('isolated realpath and bounded generated media fixtures', setup, true);
    console.log('Evidence: ' + run);
    await check('Node worker prebuild: no network, no watchers, all fixtures indexed', seed, true);
    await check('real Electron startup, actual runtime and isolated profile', launch, true);
    for (const item of fixtures)
      await check(item.key + ' original protocol status/MIME/nonempty', () => original(item));
    const images = fixtures.filter((item) => !item.video && !item.corrupt);
    // Each image uses actual openViewer/get/list IPC continuously in the same open dialog.
    for (const item of images)
      await check(item.key + ' continuous real openViewer', async () => {
        await open(item);
        const state = await viewerReady(item);
        if (item.mustPreview) await previewProtocol(item, item.width, item.height);
        if (item.mustPreview || item.key === 'large') await screenshot('viewer_' + item.key);
        return state;
      });
    await check(
      'viewer has no liquid-glass hosts or canvases through multiple image-switch rounds',
      async () => {
        await open(find('png'));
        await viewerReady(find('png'));
        await page.evaluate(() => window.albumLiquidGlass.refresh({ immediate: true }));
        const beforeErrors = report.errors.length;
        for (let round = 0; round < 3; round++)
          for (const key of ['jpeg', 'bmp', 'ico', 'orientation', 'mismatch', 'png']) {
            await open(find(key));
            await viewerReady(find(key));
            assert.equal(
              await page
                .locator(
                  '#viewer.liquid-glass-canvas, #viewer[data-liquid-glass-host], #viewer .liquid-glass-canvas, #viewer [data-liquid-glass-host]'
                )
                .count(),
              0,
              'Viewer and all of its controls must stay outside the liquid-glass renderer'
            );
          }
        assert.equal(
          report.errors.length,
          beforeErrors,
          'No renderer exceptions during repeated image switching without GL decoration'
        );
        await screenshot('viewer_without_gl_switching');
        return page.evaluate(() => window.albumLiquidGlass.stats());
      }
    );
    for (const [key, format] of [
      ['bmp', 'bmp'],
      ['ico', 'ico'],
      ['png', 'png'],
      ['tiff', 'tiff'],
      ['orientation', 'tiff'],
      ['mismatch', 'png']
    ]) {
      await check(key + ' forced preview, alpha/orientation and real cache dimensions', () =>
        forcedPreview(find(key), format)
      );
    }
    await check(
      '27 MP viewing exceeds editor 24 MP limit with bounded compatibility output',
      async () => {
        const item = find('large');
        assert.ok(item.width * item.height > 24000000 && item.width * item.height <= 27000000);
        await open(item);
        const state = await viewerReady(item);
        assert.ok(
          state.src.startsWith('acg-image://original/'),
          'Large JPEG must remain viewable through original protocol'
        );
        const preview = await rpc('prepareImagePreview', { id: item.id, size: 8192 });
        assert.equal(preview.sourceWidth, 3000);
        assert.equal(preview.sourceHeight, 9000);
        assert.ok(
          preview.width > 0 &&
            preview.height > 0 &&
            preview.width <= 8192 &&
            preview.height <= 8192 &&
            preview.width * preview.height <= 24000000
        );
        await previewProtocol(item, preview.width, preview.height);
        // The existing editor frame protocol must still reject its documented render budget.
        const editor = await page.evaluate(async (id) => {
          const response = await fetch('acg-image://frame/' + id + '?index=0&size=1600');
          return { status: response.status, text: await response.text() };
        }, item.id);
        assert.equal(editor.status, 500);
        assert.match(editor.text, /2400 万像素|256 MiB/);
        await open(find('png'));
        await viewerReady(find('png'));
        return { original: state, preview, editor };
      }
    );
    await check('stale preview cache is invalidated by a generated-source revision', async () => {
      const item = find('stale');
      const first = await rpc('prepareImagePreview', { id: item.id, size: 128 });
      const cached = await rpc('prepareImagePreview', { id: item.id, size: 128 });
      assert.equal(cached.decoder, 'cache');
      assert.equal(cached.key, first.key);
      // This one disposable generated fixture is explicitly mutable. No imported/user original is written.
      within(run, item.file);
      assert.ok(samePath(await fs.realpath(item.file), item.file));
      const replacement = await image(31, 17).png().toBuffer();
      await fs.writeFile(item.file, replacement);
      const changedTime = new Date(Date.now() + 5000);
      await fs.utimes(item.file, changedTime, changedTime);
      hashes.set(item.file, digest(replacement));
      item.width = 31;
      item.height = 17;
      const fresh = await rpc('prepareImagePreview', { id: item.id, size: 128 });
      assert.notEqual(fresh.key, first.key);
      assert.notEqual(fresh.path, first.path);
      assert.equal(fresh.width, 31);
      assert.equal(fresh.height, 17);
      assert.equal(fresh.sourceWidth, 31);
      assert.equal(fresh.sourceHeight, 17);
      const recached = await rpc('prepareImagePreview', { id: item.id, size: 128 });
      assert.equal(recached.decoder, 'cache');
      assert.equal(recached.key, fresh.key);
      assert.equal(recached.width, 31);
      assert.equal(recached.height, 17);
      await previewProtocol(item, 31, 17, 128);
      await open(item);
      await viewerReady(item);
      report.previews.push({ key: item.key, first, cached, fresh, recached });
      return {
        first,
        fresh,
        recached,
        mutableGeneratedFixture: item.file,
        replacementSha256: hashes.get(item.file)
      };
    });
    await check(
      'stale image load/error callbacks cannot overwrite a newer viewer image',
      async () => {
        await open(find('orientation'));
        await viewerReady(find('orientation'));
        await page.evaluate(() => {
          const image = document.querySelector('#viewer-image');
          window.__mediaCompatOldImageCallbacks = { load: image.onload, error: image.onerror };
        });
        await open(find('jpeg'));
        const before = await viewerReady(find('jpeg'));
        await page.evaluate(() => {
          window.__mediaCompatOldImageCallbacks.load();
          window.__mediaCompatOldImageCallbacks.error();
        });
        await frames();
        const after = await viewerReady(find('jpeg'));
        assert.equal(after.src, before.src);
        assert.equal(after.position, before.position);
        return { before, after };
      }
    );
    await check(
      'corrupt PNG preserves actual decoder reason and viewer remains usable',
      async () => {
        const item = find('corrupt');
        const failure = await page.evaluate(async (id) => {
          try {
            await window.album.call('prepareImagePreview', { id, size: 128 });
            return { unexpectedlySucceeded: true };
          } catch (error) {
            return { message: error.message };
          }
        }, item.id);
        assert.ok(!failure.unexpectedlySucceeded && failure.message);
        assert.match(failure.message, /解码失败|PNG|png|corrupt|trunc|stream|损坏/i);
        const response = await page.evaluate(async (id) => {
          const response = await fetch('acg-image://preview/' + id + '?size=128', {
            cache: 'no-store'
          });
          return {
            status: response.status,
            mime: response.headers.get('content-type'),
            body: await response.json()
          };
        }, item.id);
        assert.equal(response.status, 415);
        assert.match(response.mime, /application\/json/);
        assert.equal(response.body.code, 'IMAGE_CORRUPT');
        assert.ok(response.body.error.length > 10);
        await open(item);
        await expect(page.locator('#viewer-loading')).toContainText('图片读取失败：');
        await expect(page.locator('#viewer-loading')).toContainText(failure.message);
        await expect(page.locator('#viewer-loading')).toContainText(response.body.error);
        assert.equal(await page.locator('#viewer-image').evaluate((image) => image.hidden), true);
        await screenshot('corrupt_png_actual_reason');
        await open(find('png'));
        await viewerReady(find('png'));
        return { rpc: failure, protocol: response };
      }
    );
    for (const key of ['wmv', 'mkv'])
      await check(key + ' nativeerror hands off exactly once and images keep working', () =>
        videoHandoff(find(key))
      );
    await check('system default player failure reaches UI through actual openMedia IPC', () =>
      videoHandoff(find('wmv'), 'Media compatibility simulated OS failure')
    );
    await check(
      'closing a pending video invalidates errors/timer and never opens OS player',
      async () => {
        const before = (await shellState()).calls.length;
        await page.evaluate(async (id) => {
          await openViewer(await window.album.call('get', { id }), 0, true);
          const late = document.querySelector('#viewer-video').onerror;
          document.querySelector('#viewer-close').click();
          late();
          late();
        }, find('mkv').id);
        await frames();
        await page.waitForFunction(
          () => !document.querySelector('#viewer').open && viewerVideoTimer === null
        );
        assert.equal(
          (await shellState()).calls.length,
          before,
          'Close must never trigger openMedia'
        );
        await open(find('webp'));
        await viewerReady(find('webp'));
        assert.equal((await shellState()).calls.length, before);
        return { callsBefore: before, callsAfter: (await shellState()).calls.length };
      }
    );
    await check(
      'generated originals and optional public HEIC source retain their recorded bytes',
      async () => {
        for (const [file, hash] of hashes)
          assert.equal(
            digest(await fs.readFile(file)),
            hash,
            'Unexpected fixture modification: ' + file
          );
        if (externalHeic)
          assert.equal(
            digest(await fs.readFile(externalHeic)),
            externalHeicHash,
            'Public HEIC source must remain unchanged'
          );
        return { verified: hashes.size, onlyDeliberateRevision: find('stale').file };
      }
    );
    await check(
      'renderer has no page errors or unhandled rejections and no public network',
      async () => {
        await frames();
        const rejections = await page.evaluate(() => window.__mediaCompatRejections);
        const state = await app.evaluate(() => globalThis.__mediaCompat);
        report.shellCalls = state.calls;
        assert.equal(
          state.calls.length,
          3,
          'Exactly two native video handoffs plus one OS-failure attempt; image viewing and closing must never call openPath'
        );
        for (const [index, key] of ['wmv', 'mkv', 'wmv'].entries()) {
          assert.ok(samePath(state.calls[index].path, find(key).file));
          assert.equal(
            state.calls[index].failure,
            index === 2 ? 'Media compatibility simulated OS failure' : ''
          );
        }
        report.blockedNetwork.push(
          ...state.blockedNetwork.map((url) => ({ source: 'main/session', url }))
        );
        for (const message of rejections)
          report.errors.push({ source: 'renderer unhandledrejection', message });
        assert.deepEqual(rejections, []);
        assert.deepEqual(report.blockedNetwork, []);
        assert.deepEqual(
          report.errors,
          [],
          'All compatibility assertions and renderer errors must pass'
        );
        return { shellCalls: state.calls.length, expectedCorruptResponsesRecordedSeparately: true };
      }
    );
  } catch (error) {
    if (!report.errors.some((entry) => entry.stack === error.stack))
      report.errors.push(errorRecord('fatal', error));
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        const state = await app.evaluate(() => globalThis.__mediaCompat);
        if (state) {
          report.shellCalls = state.calls;
          if (
            state.blockedNetwork.length &&
            !report.blockedNetwork.some((entry) => entry.source === 'main/session')
          )
            report.blockedNetwork.push(
              ...state.blockedNetwork.map((url) => ({ source: 'main/session', url }))
            );
        }
      } catch (error) {
        report.errors.push(errorRecord('collect main evidence', error));
      }
      try {
        await app.close();
      } catch (error) {
        report.errors.push(errorRecord('Electron shutdown', error));
      }
      app = null;
    }
    report.finished = new Date().toISOString();
    report.passed =
      report.checks.length > 0 &&
      report.checks.every((entry) => entry.passed === true) &&
      report.errors.length === 0 &&
      report.blockedNetwork.length === 0;
    if (!report.passed) process.exitCode = 1;
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    } else console.error(JSON.stringify(report, null, 2));
  }
}
main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
