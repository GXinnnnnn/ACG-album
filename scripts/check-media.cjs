'use strict';
// Full renderer/main/worker integration using generated originals and a disposable isolated profile.
// Run from C:\ACG with the bundled Node: node scripts/check-media.cjs [--packaged]
// All files written by this suite live beneath artifacts/media-integration/; source files stay unchanged.
const { _electron } = require('@playwright/test');
const sharp = require('sharp'),
  exifr = require('exifr');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const project = path.resolve(__dirname, '..'),
  packaged = process.argv.includes('--packaged'),
  focused = process.argv.includes('--focus-regressions');
const run = path.join(
  project,
  'artifacts',
  'media-integration',
  `${packaged ? 'packaged' : 'source'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
const originalRoot = path.join(run, 'fixtures', '普通相册 · 海边旅行'),
  child = path.join(originalRoot, '第二天 · 山间'),
  grandchild = path.join(child, '傍晚');
const output = path.join(run, 'exports'),
  profile = path.join(run, 'profile');
const report = {
  mode: packaged ? 'packaged' : 'source',
  focused,
  started: new Date().toISOString(),
  run,
  checks: [],
  pageerrors: [],
  unhandledrejections: [],
  consoleErrors: [],
  failedRequests: [],
  screenshots: [],
  testAssumptions: [
    'Cleared place is normalized to null; the visible field is empty.',
    'Wait for the native clipboard bitmap after Ctrl+C rather than matching a previous toast.',
    'Compare GIF preview frames through Playwright screenshots; cross-origin canvas pixel reads are not part of the editor contract.',
    'Use separate Sharp extract and rotate pipelines for the unedited comparison reference.',
    'Reset album scroll and filter before each independent layout check.'
  ],
  metrics: {}
};
const originals = [];
let app,
  page,
  rootId,
  childId,
  nodes = [],
  webmId,
  stage = 'setup';
const idFor = (file) =>
  createHash('sha256').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 24);
const closeEnough = (a, b, e = 0.8) =>
  assert.ok(Math.abs(a - b) <= e, `${a} differs from ${b} by more than ${e}`);
async function selectControl(selector, value) {
  const source = page.locator(selector);
  if (await source.isVisible()) return source.selectOption(value);
  const wrapper = source.locator('..');
  const button = wrapper.locator('.album-select-button');
  await button.waitFor({ state: 'visible' });
  const index = await source.evaluate(
    (select, value) => [...select.options].findIndex((option) => option.value === value),
    value
  );
  assert.ok(index >= 0, `${selector}: missing option ${value}`);
  await button.click();
  await wrapper.locator(`.album-select-option[data-index='${index}']`).click();
  assert.equal(await source.inputValue(), value);
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function check(name, fn) {
  if (
    focused &&
    !/generate playable|import generated|playable video|video original|native bitmap|originals hashes|renderer pageerrors/.test(
      name
    )
  )
    return;
  stage = name;
  const start = performance.now();
  console.log('CHECK ' + name);
  try {
    const details = await fn();
    report.checks.push({
      name,
      status: 'passed',
      ms: +(performance.now() - start).toFixed(1),
      ...(details === undefined ? {} : { details })
    });
    console.log('PASS ' + name);
  } catch (error) {
    const item = {
      name,
      status: 'failed',
      ms: +(performance.now() - start).toFixed(1),
      error: error.message,
      stack: error.stack
    };
    if (page && !page.isClosed())
      item.state = await page
        .evaluate(() => ({
          view: S.view,
          parent: S.parent,
          filter: S.filter,
          search: S.search,
          month: S.timelineMonth,
          place: S.timelinePlace,
          loadVersion: S.loadVersion,
          query: queryArgs(),
          grid: {
            active: grid.active,
            total: grid.total,
            folders: grid.folders,
            version: grid.version,
            args: grid.args,
            cached: grid.items.size,
            cards: grid.cards.size,
            loading: [...grid.loading].map(([page, r]) => ({
              page,
              aborted: r.controller.signal.aborted
            }))
          },
          navigation: window.__mediaNavigation?.slice(-6),
          clicks: window.__mediaClicks?.slice(-6),
          toast: $('#toast-region').textContent
        }))
        .catch((e) => ({ stateError: e.message }));
    report.checks.push(item);
    console.error('FAIL ' + JSON.stringify(item));
    if (page && !page.isClosed())
      await screenshot('failure-' + String(report.checks.length)).catch(() => {});
  }
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
}
async function resize(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w.isMaximized()) w.unmaximize();
      w.setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await page.waitForFunction((s) => innerWidth === s.width && innerHeight === s.height, {
    width,
    height
  });
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
}
async function launch() {
  const env = { ...process.env, ACG_DATA_DIR: profile, ACG_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const start = performance.now();
  app = await _electron.launch({
    executablePath: packaged
      ? path.join(
          require('./distribution-paths.cjs').runtimeDirectory(),
          `${require('../package.json').build.productName}.exe`
        )
      : require('electron'),
    args: packaged ? [] : ['.'],
    cwd: project,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false)
  );
  page.setDefaultTimeout(12000);
  page.on('pageerror', (e) =>
    report.pageerrors.push({ stage, message: e.message, stack: e.stack })
  );
  page.on('console', (m) => {
    if (m.type() === 'error') report.consoleErrors.push({ stage, text: m.text() });
  });
  page.on('requestfailed', (r) =>
    report.failedRequests.push({ stage, url: r.url(), failure: r.failure() })
  );
  await page.evaluate(() => {
    window.__integrationRejections = [];
    window.addEventListener('unhandledrejection', (e) =>
      window.__integrationRejections.push({
        message: String(e.reason?.message || e.reason),
        stack: e.reason?.stack
      })
    );
  });
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      S.settings.nickname !== undefined &&
      window.applyNavigationSettings
  );
  report.metrics.launchMs = +(performance.now() - start).toFixed(1);
  await page.evaluate(() => {
    window.__mediaNavigation = [];
    const original = navigate;
    navigate = (...args) => {
      window.__mediaNavigation.push({ args, stack: new Error().stack });
      return original(...args);
    };
    window.__mediaClicks = [];
    document.addEventListener(
      'click',
      (event) => {
        window.__mediaClicks.push({
          target: event.target.id || event.target.className,
          trusted: event.isTrusted
        });
      },
      true
    );
  });
  await resize(1920, 1032);
  await app.evaluate(({ dialog, shell, clipboard }) => {
    global.__mediaIntegration = {
      saveCalls: [],
      openCalls: [],
      clipboardBefore: clipboard.readImage().toPNG().toString('base64')
    };
    dialog.showSaveDialog = async (_win, options) => {
      const s = global.__mediaIntegration;
      s.saveCalls.push(options);
      return s.nextSave || { canceled: true };
    };
    shell.openPath = async (file) => {
      global.__mediaIntegration.openCalls.push(file);
      return '';
    };
  });
}
async function collectRejections() {
  if (page && !page.isClosed()) {
    const entries = await page.evaluate(() => window.__integrationRejections.splice(0));
    report.unhandledrejections.push(...entries.map((e) => ({ ...e, stage })));
  }
}
async function closeApp() {
  if (!app) return;
  await collectRejections();
  await app.evaluate(({ clipboard, nativeImage }) => {
    const encoded = global.__mediaIntegration?.clipboardBefore;
    if (encoded) clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')));
  });
  const start = performance.now();
  await app.close();
  report.metrics.shutdownMs = +(performance.now() - start).toFixed(1);
  app = null;
  page = null;
}
async function navigate(parent = rootId, view = 'library', filter = 'all') {
  await page.evaluate(
    async ({ parent, view, filter }) => {
      if ($('#media-editor')) $('#me-close').click();
      if ($('#modal').open) closeModal();
      if ($('#viewer').open) $('#viewer-close').click();
      S.timelineMonth = '';
      S.timelinePlace = '';
      await navigate({ parent, view, filter });
    },
    { parent, view, filter }
  );
  await page.waitForFunction(() => grid.active && grid.total > 0 && grid.cards.size > 0);
  await page.evaluate(() => {
    $('#viewport').scrollTop = 0;
    grid.render();
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
}
async function node(name) {
  const n = nodes.find((n) => n.name === name);
  assert.ok(n, 'Missing fixture node ' + name);
  return n;
}
async function openByName(name) {
  const n = await node(name);
  await page.evaluate(async (n) => {
    if ($('#media-editor')) $('#me-close').click();
    if ($('#modal').open) closeModal();
    const viewer = $('#viewer');
    if (viewer.open) {
      const closed = new Promise((r) => viewer.addEventListener('close', r, { once: true }));
      $('#viewer-close').click();
      await closed;
    }
    const offset = [...grid.items].find(([, x]) => x.id === n.id)?.[0];
    if (offset === undefined)
      throw new Error('Fixture is not in the current virtual query: ' + n.name);
    const p = grid.getPosition(offset),
      vp = $('#viewport'),
      origin =
        $('#virtual-grid').getBoundingClientRect().top -
        vp.getBoundingClientRect().top +
        vp.scrollTop;
    vp.scrollTop = Math.max(0, origin + p.top - 30);
    grid.render();
  }, n);
  await page.locator('.media-card[data-id="' + n.id + '"]').click();
  await page.waitForFunction((id) => $('#viewer').open && V.node.id === id, n.id);
  return n;
}
async function waitImage() {
  await page.waitForFunction(
    () =>
      !$('#viewer-image').hidden &&
      $('#viewer-image').complete &&
      $('#viewer-image').naturalWidth > 0 &&
      $('#viewer-loading').hidden
  );
}
async function properties(name) {
  await openByName(name);
  await page.locator('#viewer-info').click();
  await page.waitForFunction(() => $('#modal').open && !!$('#media-place'));
}
async function savePlace({ place, lat, lon }) {
  await page.locator('#media-place').fill(place);
  await page.locator('#media-latitude').fill(lat === null ? '' : String(lat));
  await page.locator('#media-longitude').fill(lon === null ? '' : String(lon));
  await page.locator('#media-place-save').click();
  await page.waitForFunction(() => !$('#modal').open);
}
async function openEditor(name) {
  await openByName(name);
  await waitImage();
  await page.locator('#viewer-edit').click();
  await page.waitForFunction(() => $('#media-editor')?.open && !$('#me-export').disabled);
}
async function setSave(file) {
  await app.evaluate((_, file) => {
    global.__mediaIntegration.nextSave = file
      ? { canceled: false, filePath: file }
      : { canceled: true };
  }, file);
}
async function exportTo(file, button = '#me-export') {
  await setSave(file);
  await page.locator(button).click();
  const expected = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  await page.waitForFunction(
    (file) =>
      !$('#me-export').disabled && !$('#me-result').hidden && $('#me-result').textContent === file,
    expected
  );
  assert.equal(await page.locator('#me-error').isVisible(), false);
  return sharp(file, { animated: true }).metadata();
}
async function input(selector, value, event = 'input') {
  await page.locator(selector).fill(String(value));
  if (event === 'change') await page.locator(selector).dispatchEvent('change');
}
async function setColor(key, value) {
  await page.locator('#me-' + key).evaluate((el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, String(value));
}
async function hashes() {
  const entries = [];
  for (const file of originals) {
    const stat = await fs.stat(file);
    entries.push({
      path: path.relative(run, file),
      sha256: createHash('sha256')
        .update(await fs.readFile(file))
        .digest('hex'),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return entries;
}
async function makeFixtures() {
  await fs.mkdir(grandchild, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  const graphic = (width, height, base, accent) =>
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="sky" x2="1" y2="1"><stop stop-color="${base}"/><stop offset="1" stop-color="${accent}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#sky)"/><circle cx="${width * 0.72}" cy="${height * 0.25}" r="${Math.min(width, height) * 0.12}" fill="#ffdfae"/><path d="M0 ${height * 0.75} L${width * 0.26} ${height * 0.4} L${width * 0.54} ${height * 0.71} L${width * 0.78} ${height * 0.52} L${width} ${height * 0.77} V${height} H0Z" fill="#354a62" opacity=".65"/><path d="M0 ${height * 0.85}Q${width * 0.35} ${height * 0.65} ${width} ${height * 0.88}V${height}H0Z" fill="#233344" opacity=".72"/></svg>`
    );
  const add = async (relative, buffer) => {
    const file = path.join(originalRoot, relative);
    await fs.writeFile(file, buffer);
    await fs.utimes(file, new Date('2023-01-02T04:00:00Z'), new Date('2023-01-02T04:00:00Z'));
    originals.push(file);
    return file;
  };
  const exif = await sharp(graphic(640, 400, '#eab6a6', '#8ba5c9'))
    .withMetadata({ orientation: 6 })
    .withExifMerge({
      IFD0: { Make: 'IntegrationCam', Model: 'Offset GPS Fixture' },
      IFD2: { DateTimeOriginal: '2024:03:14 15:09:26', OffsetTimeOriginal: '+05:30' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '35/1 30/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '139/1 45/1 0/1'
      }
    })
    .jpeg({ quality: 90 })
    .toBuffer();
  const exifFile = await add('01-拍摄时区与方向.jpg', exif);
  const tags = await exifr.parse(exifFile, {
    reviveValues: false,
    translateValues: false,
    gps: true
  });
  assert.equal(tags.OffsetTimeOriginal, '+05:30');
  assert.equal(tags.latitude, 35.5);
  assert.equal(tags.longitude, 139.75);
  assert.equal((await sharp(exif).metadata()).orientation, 6);
  await add(
    '02-海边横图.png',
    await sharp(graphic(900, 480, '#88b7d1', '#e7b7bf'))
      .png()
      .toBuffer()
  );
  await add(
    '03-山间竖图.png',
    await sharp(graphic(300, 650, '#a4bca1', '#d2c8ab'))
      .png()
      .toBuffer()
  );
  await add(
    '第二天 · 山间/04-子目录拍摄.jpg',
    await sharp(graphic(700, 420, '#d5b1d4', '#91b1c8'))
      .withExif({
        IFD0: { Make: 'IntegrationCam', Model: 'Nested' },
        IFD2: { DateTimeOriginal: '2025:10:06 09:30:00', OffsetTimeOriginal: '+08:00' }
      })
      .jpeg()
      .toBuffer()
  );
  await add(
    '第二天 · 山间/傍晚/05-递归深层.png',
    await sharp(graphic(480, 700, '#af8dbc', '#e3b68d'))
      .png()
      .toBuffer()
  );
  const frames = [];
  for (const color of ['#c94458', '#3c8e72', '#4167bb', '#d3aa44'])
    frames.push(
      await sharp({ create: { width: 160, height: 120, channels: 3, background: color } })
        .raw()
        .toBuffer()
    );
  const raw = Buffer.concat(frames);
  const anim = { raw: { width: 160, height: 480, channels: 3, pageHeight: 120 } };
  await add(
    '06-四帧动画.gif',
    await sharp(raw, anim)
      .gif({ delay: [80, 120, 160, 200], loop: 3, effort: 1 })
      .toBuffer()
  );
  await add(
    '07-四帧动画.webp',
    await sharp(raw, anim)
      .webp({ delay: [80, 120, 160, 200], loop: 3, lossless: true, effort: 0 })
      .toBuffer()
  );
  await add(
    '08-不支持的视频.mp4',
    Buffer.from('This is an intentionally non-decodable generated MP4 fixture.')
  );
  const variants = await Promise.all(
    [
      [900, 480, '#88b7d1', '#e7b7bf'],
      [320, 620, '#b5c5a7', '#deb68d'],
      [640, 640, '#adadd3', '#e2bfca'],
      [1000, 360, '#81b6bd', '#d4bf9d']
    ].map(async (a) =>
      sharp(graphic(...a))
        .jpeg({ quality: 76 })
        .toBuffer()
    )
  );
  for (let i = 0; i < 480; i++)
    await add(`旅行-${String(i + 1).padStart(3, '0')}.jpg`, variants[i % variants.length]);
  report.fixture = {
    generatedBeforeVideo: originals.length,
    exif: {
      offset: tags.OffsetTimeOriginal,
      latitude: tags.latitude,
      longitude: tags.longitude,
      orientation: 6,
      taken: Date.parse('2024-03-14T15:09:26+05:30')
    },
    nested: 2,
    rawAnimation: { width: 160, height: 120, frames: 4, delay: [80, 120, 160, 200], loop: 3 }
  };
}
(async () => {
  await fs.mkdir(run, { recursive: true });
  console.log('ARTIFACT_RUN ' + run);
  try {
    await makeFixtures();
    report.sourceSnapshot = await Promise.all(
      [
        'src/main.cjs',
        'src/media.cjs',
        'src/library-worker.cjs',
        'src/ui/app.js',
        'src/ui/media-ui.js',
        'src/ui/editor.js',
        'src/ui/masonry.js',
        'src/ui/index.html'
      ].map(async (relative) => ({
        path: relative,
        sha256: createHash('sha256')
          .update(await fs.readFile(path.join(project, relative)))
          .digest('hex')
      }))
    );
    await launch();
    await check('generate playable WebM through Chromium MediaRecorder', async () => {
      const recordingWindow = app.waitForEvent('window');
      await app.evaluate(({ BrowserWindow }) => {
        const w = new BrowserWindow({
          width: 480,
          height: 360,
          show: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            backgroundThrottling: false
          }
        });
        global.__mediaRecorderWindow = w;
        w.loadURL('about:blank');
        w.focus();
      });
      const recordingPage = await recordingWindow;
      await recordingPage.waitForLoadState();
      let encoded;
      try {
        encoded = await recordingPage.evaluate(async () => {
          const types = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
          const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
          if (!mimeType) throw new Error('No supported WebM MediaRecorder codec');
          const canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          canvas.style.cssText =
            'position:fixed;z-index:2147483647;left:140px;top:140px;width:320px;height:180px;';
          document.body.append(canvas);
          const ctx = canvas.getContext('2d', { willReadFrequently: true }),
            stream = canvas.captureStream(0),
            track = stream.getVideoTracks()[0],
            chunks = [];
          ctx.fillStyle = '#aa6c98';
          ctx.fillRect(0, 0, 320, 180);
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 300000 });
          const data = new Promise((resolve, reject) => {
            recorder.onerror = (e) => reject(new Error(e.error?.message || 'MediaRecorder error'));
            recorder.ondataavailable = (e) => {
              if (e.data.size) chunks.push(e.data);
            };
            recorder.onstop = async () => {
              stream.getTracks().forEach((t) => t.stop());
              const bytes = new Uint8Array(
                await new Blob(chunks, { type: mimeType }).arrayBuffer()
              );
              let text = '';
              for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
              resolve({ base64: btoa(text), mimeType });
            };
          });
          const recordingStarted = new Promise((resolve) => {
            recorder.onstart = resolve;
          });
          recorder.start();
          await recordingStarted;
          for (let frame = 0; frame < 15; frame++) {
            ctx.fillStyle = frame % 2 ? '#539caa' : '#aa6c98';
            ctx.fillRect(0, 0, 320, 180);
            ctx.fillStyle = '#f4dfab';
            ctx.fillRect(frame * 16, 60, 45, 45);
            ctx.getImageData(0, 0, 1, 1);
            await new Promise((r) => requestAnimationFrame(r));
            track.requestFrame();
            await new Promise((r) => setTimeout(r, 85));
          }
          recorder.stop();
          const encoded = await data;
          const probe = document.createElement('video'),
            url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
          probe.muted = true;
          probe.preload = 'auto';
          try {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Recorded WebM decode validation timed out')),
                5000
              );
              probe.onloadeddata = () => {
                clearTimeout(timer);
                if (probe.videoWidth === 320 && probe.videoHeight === 180) resolve();
                else reject(new Error('Recorded WebM dimensions are invalid'));
              };
              probe.onerror = () => {
                clearTimeout(timer);
                reject(new Error('Recorded WebM has no decodable frames'));
              };
              probe.src = url;
              probe.load();
            });
            return {
              ...encoded,
              width: probe.videoWidth,
              height: probe.videoHeight,
              validated: true
            };
          } finally {
            probe.removeAttribute('src');
            probe.load();
            URL.revokeObjectURL(url);
            canvas.remove();
          }
        });
      } finally {
        await app.evaluate(() => {
          global.__mediaRecorderWindow?.destroy();
          delete global.__mediaRecorderWindow;
        });
      }
      const file = path.join(originalRoot, '09-可播放短视频.webm');
      const bytes = Buffer.from(encoded.base64, 'base64');
      assert.ok(
        bytes.length > 1024,
        'MediaRecorder must produce actual encoded frames, not a header-only WebM'
      );
      await fs.writeFile(file, bytes);
      originals.push(file);
      report.fixture.webm = {
        bytes: bytes.length,
        mimeType: encoded.mimeType,
        width: encoded.width,
        height: encoded.height,
        validated: encoded.validated
      };
      webmId = idFor(file);
      return report.fixture.webm;
    });
    const before = await hashes();
    await fs.writeFile(path.join(run, 'originals-before.json'), JSON.stringify(before, null, 2));
    await check('import generated ordinary album and finish metadata', async () => {
      await page.evaluate(async () => {
        await saveSetting('autoMatch', false);
        await saveSetting('watchChanges', false);
        await saveSetting('sidebarMode', 'compact');
      });
      await app.evaluate(({ dialog }, folder) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
      }, originalRoot);
      const start = performance.now();
      await page.locator('#import-sidebar').click();
      await page.locator('#import-options').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#import-online-match').isChecked(), false);
      await page.locator('#import-options-confirm').click();
      rootId = idFor(originalRoot);
      childId = idFor(child);
      await page.waitForFunction((id) => S.roots.some((n) => n.id === id), rootId);
      await page.waitForFunction(() => $('#progress-panel').hidden);
      const listing = await page.evaluate(
        (parent) => api('list', { parent, timeline: true, filter: 'images', limit: 1000 }),
        rootId
      );
      nodes = listing.items;
      assert.equal(listing.total, originals.length);
      assert.equal(nodes.length, originals.length);
      await page.evaluate(
        async (ids) => {
          for (const id of ids) {
            const m = await api('mediaInfo', { id });
            if (m.status !== 'ready') throw new Error(id + ': ' + m.error);
          }
        },
        nodes.map((n) => n.id)
      );
      nodes = (
        await page.evaluate(
          (parent) => api('list', { parent, timeline: true, filter: 'images', limit: 1000 }),
          rootId
        )
      ).items;
      report.metrics.importAndMetadataMs = +(performance.now() - start).toFixed(1);
      await navigate();
      return { media: nodes.length, metadataMs: report.metrics.importAndMetadataMs };
    });
    await check('ordinary album inheritance and no Bangumi intro', async () => {
      await page.evaluate(async (id) => {
        const n = await api('get', { id });
        albumKindModal(n);
      }, rootId);
      await selectControl('#album-kind-select', 'photo');
      await page.locator('#album-kind-save').click();
      await page.waitForFunction(() => !$('#modal').open);
      await navigate(childId);
      const info = await page.evaluate(() => ({
        kind: S.current.effective_album_kind,
        intro: $('#intro-area').childElementCount
      }));
      assert.equal(info.kind, 'photo');
      assert.equal(info.intro, 0);
      await navigate();
      return info;
    });
    await check(
      'EXIF offset timestamp GPS orientation camera metadata through properties',
      async () => {
        const n = await node('01-拍摄时区与方向.jpg');
        const m = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
        assert.equal(m.status, 'ready');
        assert.equal(m.taken, report.fixture.exif.taken);
        assert.equal(m.date_source, 'exif-offset');
        assert.equal(m.latitude, 35.5);
        assert.equal(m.longitude, 139.75);
        assert.equal(m.width, 400);
        assert.equal(m.height, 640);
        assert.match(m.camera, /IntegrationCam/);
        await properties(n.name);
        const text = await page.locator('#modal-content').innerText();
        for (const label of [
          '名称',
          '类型 / 大小',
          '尺寸',
          '时间',
          '相机',
          '色彩',
          '地址',
          'EXIF 拍摄时间（含时区）'
        ])
          assert.ok(text.includes(label), 'Missing metadata label ' + label);
        assert.equal(await page.locator('#media-latitude').inputValue(), '35.5');
        assert.equal(await page.locator('#media-longitude').inputValue(), '139.75');
        await input('#media-latitude', 36);
        await input('#media-longitude', '');
        await page.locator('#media-place-save').click();
        await page.waitForFunction(() => $('#media-place-error').textContent.includes('完整'));
        assert.equal(await page.locator('#modal').evaluate((el) => el.open), true);
        await savePlace({ place: '海边 %_ literal', lat: 36.25, lon: 140.5 });
        const updated = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
        assert.equal(updated.place, '海边 %_ literal');
        assert.equal(updated.latitude, 36.25);
        await properties(n.name);
        await savePlace({ place: '', lat: null, lon: null });
        const cleared = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
        assert.equal(cleared.latitude, null);
        assert.equal(cleared.longitude, null);
        assert.equal(cleared.place ?? '', '');
        await properties(n.name);
        await savePlace({ place: '海边 %_ literal', lat: 36.25, lon: 140.5 });
        await page.locator('#viewer-close').click();
        return {
          width: m.width,
          height: m.height,
          dateSource: m.date_source,
          taken: m.taken,
          camera: m.camera,
          clearPersisted: true
        };
      }
    );
    await check('initial virtual page survives a concurrent wall render', async () => {
      await navigate(rootId, 'library', 'images');
      const state = await page.evaluate(async () => {
        const expected = grid.total,
          pending = grid.load(queryArgs(), S.loadVersion);
        grid.render();
        const total = await pending;
        return { expected, total, cached: grid.items.size, loading: grid.loading.size };
      });
      assert.ok(state.expected > 0);
      assert.equal(state.total, state.expected);
      assert.ok(state.cached > 0);
      return state;
    });
    await check('recursive timeline month literal place controls and screenshots', async () => {
      await navigate(rootId, 'timeline', 'images');
      assert.equal(await page.locator('#intro-area').evaluate((el) => el.childElementCount), 0);
      const total = await page.evaluate(() => grid.total);
      assert.equal(total, originals.length);
      const deep = await node('05-递归深层.png');
      const result = await page.evaluate(
        (parent) => api('list', { parent, timeline: true, filter: 'images', limit: 1000 }),
        rootId
      );
      assert.ok(result.items.some((n) => n.id === deep.id));
      const v = await page.evaluate(() => S.loadVersion);
      await page.locator('#timeline-month').fill('2024-03');
      await page.locator('#timeline-month').dispatchEvent('change');
      await page.waitForFunction((v) => S.loadVersion > v && grid.total === 1, v);
      assert.equal(
        await page.evaluate(() => [...grid.items.values()][0].name),
        '01-拍摄时区与方向.jpg'
      );
      await page.locator('#timeline-place').fill('%_');
      await page.waitForFunction(() => S.timelinePlace === '%_' && grid.total === 1);
      await page.locator('#timeline-place').fill('%_ missing');
      await page.waitForFunction(() => S.timelinePlace === '%_ missing' && grid.total === 0);
      await page.locator('#timeline-clear').click();
      await page.waitForFunction(
        () => S.timelineMonth === '' && S.timelinePlace === '' && grid.total > 400
      );
      await page.evaluate(() => changeTheme('light'));
      await screenshot('timeline-desktop-light');
      await page.evaluate(() => changeTheme('dark'));
      await screenshot('timeline-desktop-dark');
      await resize(980, 720);
      await screenshot('timeline-narrow-dark');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false);
      await resize(1920, 1032);
      await page.evaluate(() => changeTheme('light'));
      await navigate();
      return { recursiveTotal: total, monthMatches: 1, literalPlace: true };
    });
    await check(
      'fixed folder cards and fixed-width natural image geometry in one continuous wall',
      async () => {
        await navigate();
        const results = [];
        for (const width of [158, 186, 222]) {
          await page.locator(`#card-size-controls [data-density="${width}"]`).click();
          await page.waitForFunction((width) => S.settings.density === width, width);
          await page.evaluate(() => grid.render());
          const size = await page.evaluate(() => {
            const folder = $('.album-card:not(.media-card) .cover-shell');
            const media = $$('.media-card').map((card) => {
              const n = [...grid.items.values()].find((n) => n.id === card.dataset.id);
              const r = card.querySelector('.cover-shell').getBoundingClientRect();
              return {
                name: n.name,
                width: r.width,
                height: r.height,
                sourceWidth: n.width,
                sourceHeight: n.height
              };
            });
            const folderCards = $$('.album-card:not(.media-card)');
            const lastFolder = folderCards.at(-1);
            const firstImage = $('.media-card');
            return {
              folder: folder?.getBoundingClientRect().height,
              media,
              folderInfo: folderCards[0]?.querySelector('.card-info').getBoundingClientRect()
                .height,
              folderTop: lastFolder?.getBoundingClientRect().top,
              imageTop: firstImage?.getBoundingClientRect().top,
              imageFit: firstImage && getComputedStyle(firstImage.querySelector('img')).objectFit,
              sameRowExpected: grid.folders % grid.cols !== 0
            };
          });
          assert.ok(size.folder > 0);
          closeEnough(size.folderInfo, 70);
          if (size.sameRowExpected) closeEnough(size.folderTop, size.imageTop);
          assert.equal(size.imageFit, 'contain');
          assert.ok(
            size.media.some((card) => card.height > size.folder + 1),
            'Tall originals retain their full natural height'
          );
          for (const card of size.media) {
            closeEnough(card.width, width);
            if (card.sourceWidth && card.sourceHeight)
              closeEnough(card.height, (width * card.sourceHeight) / card.sourceWidth);
          }
          results.push({
            width,
            folderHeight: size.folder,
            mediaCount: size.media.length,
            continuousRow: size.sameRowExpected,
            naturalTallImages: true
          });
        }
        return results;
      }
    );
    await check('detail-off compact wall and local hover tooltip', async () => {
      await page.evaluate(() => changeDisplaySetting('density', 186));
      await page.locator('#details-toggle').click();
      await page.waitForFunction(
        () =>
          S.settings.details === false && document.documentElement.dataset.mediaDetails === 'off'
      );
      await page.evaluate(() => grid.render());
      const metrics = await page.evaluate(() =>
        $$('.media-card').map((c) => ({
          name: c.querySelector('.card-title').textContent,
          height: c.getBoundingClientRect().height,
          cover: c.querySelector('.cover-shell').getBoundingClientRect().height,
          details: getComputedStyle(c.querySelector('.card-info')).display,
          title: c.getAttribute('title')
        }))
      );
      assert.ok(metrics.length > 0);
      for (const m of metrics) {
        closeEnough(m.height, m.cover);
        assert.equal(m.details, 'none');
        assert.equal(m.title, null);
      }
      const target = page.locator('.media-card').first();
      const bounds = await target.boundingBox();
      await target.hover();
      assert.equal(await target.locator('.media-hover').isVisible(), true);
      const hoverText = await target.locator('.media-hover').innerText();
      assert.match(hoverText, /B|KB|MB/);
      const hovered = await target.boundingBox();
      closeEnough(hovered.width, bounds.width);
      closeEnough(hovered.height, bounds.height);
      await screenshot('wall-desktop-light');
      await page.evaluate(() => changeTheme('dark'));
      await screenshot('wall-desktop-dark');
      await resize(980, 720);
      await screenshot('wall-narrow-dark');
      await resize(3840, 2160);
      await page.evaluate(() => changeDisplaySetting('density', 158));
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );
      await screenshot('wall-4k-dark');
      const wall = await page.evaluate(() => {
        const vp = $('#viewport').getBoundingClientRect();
        const all = $$('.media-card').map((c) => {
          const r = c.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        });
        return {
          total: grid.total,
          dom: all.length,
          visible: all.filter((r) => r.bottom > vp.top && r.top < vp.bottom).length,
          overscan: all.filter((r) => r.bottom <= vp.top || r.top >= vp.bottom).length,
          cached: grid.items.size,
          columns: grid.cols,
          viewport: { top: vp.top, bottom: vp.bottom },
          outsideOverscan: all.filter((r) => r.bottom < vp.top - 361 || r.top > vp.bottom + 361)
            .length,
          overflow: document.documentElement.scrollWidth > innerWidth
        };
      });
      assert.equal(wall.overflow, false);
      assert.equal(wall.outsideOverscan, 0);
      assert.ok(wall.dom <= wall.total);
      report.metrics.wall4k = wall;
      await resize(1920, 1032);
      await page.evaluate(() => changeTheme('light'));
      return { compactCards: metrics.length, wall4k: wall };
    });
    await check('4K scrolling virtual wall coverage and frame cadence', async () => {
      await navigate(rootId, 'library', 'images');
      await resize(3840, 2160);
      await page.evaluate(() => changeDisplaySetting('density', 158));
      const perf = await page.evaluate(async () => {
        const deltas = [],
          counts = [],
          longTasks = [];
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            longTasks.push({ start: e.startTime, duration: e.duration });
        });
        observer.observe({ entryTypes: ['longtask'] });
        const viewport = $('#viewport');
        let previous = performance.now();
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => requestAnimationFrame(r));
          const now = performance.now();
          deltas.push(now - previous);
          previous = now;
          viewport.scrollTop =
            (i % 50) * Math.max(30, (viewport.scrollHeight - viewport.clientHeight) / 49);
          counts.push({
            dom: grid.cards.size,
            cache: grid.items.size,
            pages: new Set([...grid.items.keys()].map((index) => Math.floor(index / 180))).size
          });
        }
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const bounds = viewport.getBoundingClientRect();
        const cards = $$('.media-card').filter((c) => {
          const r = c.getBoundingClientRect();
          return r.bottom > bounds.top && r.top < bounds.bottom;
        });
        const placeholders = cards.filter((c) => !c.dataset.id).length;
        observer.disconnect();
        deltas.sort((a, b) => a - b);
        return {
          frames: deltas.length,
          p50: deltas[Math.floor(deltas.length * 0.5)],
          p95: deltas[Math.floor(deltas.length * 0.95)],
          max: deltas.at(-1),
          framesOver25ms: deltas.filter((t) => t > 25).length,
          framesOver50ms: deltas.filter((t) => t > 50).length,
          maxDom: Math.max(...counts.map((c) => c.dom)),
          maxCache: Math.max(...counts.map((c) => c.cache)),
          maxPages: Math.max(...counts.map((c) => c.pages)),
          visible: cards.length,
          visiblePlaceholders: placeholders,
          longTasks
        };
      });
      report.metrics.scrolling4k = perf;
      assert.ok(perf.visible > 0);
      assert.equal(perf.visiblePlaceholders, 0);
      assert.ok(perf.maxCache <= 1260);
      await resize(1920, 1032);
      return perf;
    });
    await check('playable video poster and persisted thumbnail', async () => {
      assert.ok(webmId, 'MediaRecorder fixture unavailable');
      await navigate(rootId, 'library', 'images');
      const n = await node('09-可播放短视频.webm');
      const poster = await page.evaluate(async (id) => {
        const b = await decodeVideoPoster(id);
        await api('storeVideoThumb', { id, bytes: b.bytes, width: b.width, height: b.height });
        return { width: b.width, height: b.height, bytes: b.bytes.length };
      }, n.id);
      assert.equal(poster.width, 320);
      assert.equal(poster.height, 180);
      await page.evaluate(() => grid.refreshVisible());
      const thumbnail = await page.evaluate(async (id) => {
        const r = await fetch('acg-image://thumb/' + id + '?size=512');
        const image = await createImageBitmap(await r.blob());
        return { status: r.status, width: image.width, height: image.height };
      }, n.id);
      assert.equal(thumbnail.status, 200);
      assert.ok(thumbnail.width > 0);
      return { poster, thumbnail };
    });
    await check('video original protocol range and EBML bytes', async () => {
      assert.ok(webmId, 'MediaRecorder fixture unavailable');
      const n = await node('09-可播放短视频.webm');
      const protocols = await page.evaluate(async (id) => {
        const r = await fetch('acg-image://original/' + id, { headers: { Range: 'bytes=0-31' } }),
          b = new Uint8Array(await r.arrayBuffer());
        return {
          status: r.status,
          range: r.headers.get('content-range'),
          bytes: b.length,
          magic: Array.from(b.slice(0, 4))
        };
      }, n.id);
      assert.equal(protocols.status, 206);
      assert.equal(protocols.bytes, 32);
      assert.match(protocols.range, /bytes 0-31\//);
      assert.deepEqual(protocols.magic, [26, 69, 223, 163]);
      return protocols;
    });
    await check('playable video viewer properties GPS and playback', async () => {
      assert.ok(webmId, 'MediaRecorder fixture unavailable');
      await navigate(rootId, 'library', 'images');
      const n = await node('09-可播放短视频.webm');
      await openByName(n.name);
      await page.waitForFunction(
        () => $('#viewer-video').readyState >= 2 && $('#viewer-loading').hidden
      );
      await page.locator('#viewer-video').evaluate((v) => v.play());
      await page.waitForFunction(() => $('#viewer-video').currentTime > 0.12);
      const playback = await page.locator('#viewer-video').evaluate((v) => ({
        width: v.videoWidth,
        height: v.videoHeight,
        currentTime: v.currentTime,
        paused: v.paused
      }));
      assert.equal(playback.width, 320);
      await screenshot('video-playing-dark');
      await page.locator('#viewer-info').click();
      await page.waitForFunction(() => $('#modal').open);
      assert.match(await page.locator('#modal-content').innerText(), /WEBM 视频/);
      assert.match(await page.locator('#modal-content').innerText(), /320 × 180/);
      await savePlace({ place: '短视频海边', lat: -33.86, lon: 151.2 });
      let local = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
      assert.equal(local.latitude, -33.86);
      assert.equal(local.longitude, 151.2);
      assert.equal(local.place, '短视频海边');
      await properties(n.name);
      await savePlace({ place: '', lat: null, lon: null });
      local = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
      assert.equal(local.latitude, null);
      assert.equal(local.longitude, null);
      assert.equal(local.place ?? '', '');
      await page.locator('#viewer-close').click();
      return { playback, videoCoordinatesSetAndCleared: true };
    });
    await check('unsupported video fallback system button is intercepted', async () => {
      await navigate(rootId, 'library', 'images');
      const n = await openByName('08-不支持的视频.mp4');
      await page.waitForFunction(() =>
        $('#viewer-loading').textContent.includes('浏览器不支持此视频编码')
      );
      assert.equal(await page.locator('#viewer-copy').isVisible(), false);
      assert.equal(await page.locator('#viewer-edit').isVisible(), false);
      await page.locator('#viewer-external').click();
      await page.waitForFunction(() => $('#viewer').open);
      const opened = await app.evaluate(() => global.__mediaIntegration.openCalls);
      assert.equal(opened.at(-1), n.path);
      await page.locator('#viewer-info').click();
      await page.waitForFunction(() => $('#modal').open);
      assert.match(await page.locator('#modal-content').innerText(), /MP4 视频/);
      await page.locator('#modal-close').click();
      await page.locator('#viewer-close').click();
      return { fallback: true, interceptedExternal: opened.length };
    });
    await check(
      'viewer video to image switches decoder off and keyboard arrow navigation',
      async () => {
        await navigate(rootId, 'library', 'images');
        await openByName(webmId ? '09-可播放短视频.webm' : '08-不支持的视频.mp4');
        if (webmId) await page.waitForFunction(() => $('#viewer-video').readyState >= 2);
        const wanted = await node('02-海边横图.png');
        await page.evaluate((n) => displayImage(n), wanted);
        await waitImage();
        const stopped = await page
          .locator('#viewer-video')
          .evaluate((v) => ({ src: v.getAttribute('src'), paused: v.paused, hidden: v.hidden }));
        assert.equal(stopped.src, null);
        assert.equal(stopped.paused, true);
        assert.equal(stopped.hidden, true);
        assert.equal(await page.locator('#viewer-copy').isVisible(), true);
        assert.equal(await page.locator('#viewer-edit').isVisible(), true);
        await page.locator('#viewer-close').click();
        await openByName('01-拍摄时区与方向.jpg');
        await waitImage();
        const index = await page.evaluate(() => V.index);
        await page.locator('#viewer-close').focus();
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction((index) => V.index === index + 1, index);
        assert.equal(await page.evaluate(() => V.node.name), '02-海边横图.png');
        await waitImage();
        await page.keyboard.press('ArrowLeft');
        await page.waitForFunction((index) => V.index === index, index);
        await waitImage();
        await page.locator('#viewer-close').click();
        return { stoppedVideo: stopped, arrows: true };
      }
    );
    await check('native bitmap clipboard via viewer button and Ctrl+C', async () => {
      await navigate(rootId, 'library', 'images');
      await openByName('02-海边横图.png');
      await waitImage();
      await page.locator('#viewer-copy').click();
      const copyDeadline = Date.now() + 6000;
      let clipboard;
      do {
        clipboard = await app.evaluate(({ clipboard }) => {
          const image = clipboard.readImage();
          return {
            empty: image.isEmpty(),
            size: image.getSize(),
            formats: clipboard.availableFormats()
          };
        });
        if (!clipboard.empty && clipboard.size.width === 900 && clipboard.size.height === 480)
          break;
        await new Promise((r) => setTimeout(r, 80));
      } while (Date.now() < copyDeadline);
      assert.equal(clipboard.empty, false);
      assert.deepEqual(clipboard.size, { width: 900, height: 480 });
      await openByName('03-山间竖图.png');
      await waitImage();
      await page.locator('#viewer-close').focus();
      await page.keyboard.press('Control+c');
      const deadline = Date.now() + 6000;
      let shortcut;
      do {
        shortcut = await app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
        if (shortcut.width === 300 && shortcut.height === 650) break;
        await new Promise((r) => setTimeout(r, 80));
      } while (Date.now() < deadline);
      assert.deepEqual(shortcut, { width: 300, height: 650 });
      await page.locator('#viewer-close').click();
      return { clipboard, shortcut };
    });
    await check(
      'viewer image editor crop rotate resize colors native SaveDialog export and cancel',
      async () => {
        await navigate(rootId, 'library', 'images');
        await openEditor('02-海边横图.png');
        const originalIndex = await page.evaluate(() => V.index);
        await page.locator('#me-close').focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await page.evaluate(() => V.index), originalIndex);
        assert.equal(await page.locator('#media-editor').evaluate((el) => el.open), true);
        await page.locator('[data-preset="1"]').click();
        await selectControl('#me-rotation', '90');
        await input('#me-width', 240);
        await setColor('brightness', 1.2);
        await setColor('contrast', 1.1);
        await setColor('saturation', 0.7);
        await selectControl('#me-format', 'png');
        await screenshot('editor-image-desktop-light');
        await page.evaluate(() => changeTheme('dark'));
        await screenshot('editor-image-desktop-dark');
        await resize(980, 720);
        await screenshot('editor-image-narrow-dark');
        assert.equal(await page.locator('#me-export').isVisible(), true);
        const dialogBox = await page.locator('#media-editor').boundingBox();
        assert.ok(dialogBox.x >= -0.5 && dialogBox.x + dialogBox.width <= 981);
        await resize(1920, 1032);
        const destination = path.join(output, 'image-crop-rotate-color.png');
        const meta = await exportTo(destination);
        assert.equal(meta.width, 240);
        assert.equal(meta.height, 240);
        assert.equal(meta.exif, undefined);
        const actual = await sharp(destination).removeAlpha().raw().toBuffer();
        const cropped = await sharp((await node('02-海边横图.png')).path)
          .extract({ left: 210, top: 0, width: 480, height: 480 })
          .toBuffer();
        const unedited = await sharp(cropped)
          .rotate(90)
          .resize({ width: 240 })
          .removeAlpha()
          .raw()
          .toBuffer();
        assert.notDeepEqual(actual, unedited);
        const callsBefore = await app.evaluate(() => global.__mediaIntegration.saveCalls.length);
        await setSave(null);
        await page.locator('#me-export').click();
        await page.waitForFunction(() => $('#me-status').textContent.includes('已取消另存'));
        assert.equal(await page.locator('#me-width').inputValue(), '240');
        assert.equal(
          await app.evaluate(() => global.__mediaIntegration.saveCalls.length),
          callsBefore + 1
        );
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !$('#media-editor'));
        assert.equal(await page.locator('#viewer').evaluate((el) => el.open), true);
        assert.equal(await page.evaluate(() => V.index), originalIndex);
        await page.locator('#viewer-close').click();
        return {
          export: {
            path: destination,
            width: meta.width,
            height: meta.height,
            format: meta.format
          },
          cancelPreservedEdits: true,
          keyIsolation: true
        };
      }
    );
    await check('oriented JPEG export dimensions and EXIF GPS stripping', async () => {
      await navigate(rootId, 'library', 'images');
      await openEditor('01-拍摄时区与方向.jpg');
      await page.locator('[data-preset="full"]').click();
      await selectControl('#me-format', 'jpeg');
      await input('#me-width', 400);
      const file = path.join(output, 'oriented-private-metadata-stripped.jpg');
      const m = await exportTo(file);
      assert.equal(m.width, 400);
      assert.equal(m.height, 640);
      assert.equal(m.exif, undefined);
      assert.equal(m.orientation, undefined);
      const tags = await exifr.parse(file, {
        reviveValues: false,
        translateValues: false,
        gps: true
      });
      assert.ok(!tags?.latitude && !tags?.longitude && !tags?.DateTimeOriginal);
      await page.locator('#me-close').click();
      await page.locator('#viewer-close').click();
      return { width: m.width, height: m.height, exifStripped: true };
    });
    await check(
      'GIF frame stepping playback trimming resize colors and animated export',
      async () => {
        await navigate(rootId, 'library', 'images');
        await openEditor('06-四帧动画.gif');
        assert.equal(await page.locator('#me-animation').isVisible(), true);
        assert.equal(await page.locator('#me-frame-number').inputValue(), '1');
        const first = await page.locator('#me-source').screenshot();
        await page.locator('#me-next').click();
        await page.waitForFunction(
          () => $('#me-frame-number').value === '2' && !$('#me-export').disabled
        );
        const second = await page.locator('#me-source').screenshot();
        assert.notDeepEqual(first, second);
        await page.locator('#me-prev').click();
        await page.waitForFunction(
          () => $('#me-frame-number').value === '1' && !$('#me-export').disabled
        );
        await page.locator('#me-play').click();
        await page.waitForFunction(() => Number($('#me-frame-number').value) > 1);
        await page.locator('#me-play').click();
        assert.equal(await page.locator('#me-play').getAttribute('aria-pressed'), 'false');
        await input('#me-from', 2, 'change');
        await input('#me-to', 3, 'change');
        await input('#me-delay', 90, 'change');
        await input('#me-loop', 2);
        await input('#me-width', 80);
        await setColor('brightness', 1.25);
        await setColor('saturation', 0.5);
        await selectControl('#me-format', 'gif');
        await screenshot('editor-gif-desktop-dark');
        await resize(980, 720);
        await screenshot('editor-gif-narrow-dark');
        await resize(1920, 1032);
        const destination = path.join(output, 'animation-trim-color.gif');
        const meta = await exportTo(destination);
        assert.equal(meta.width, 80);
        assert.equal(meta.pageHeight, 60);
        assert.equal(meta.pages, 2);
        assert.deepEqual(meta.delay, [90, 90]);
        assert.equal(meta.loop, 2);
        const exported = await sharp(destination, { page: 0 }).raw().toBuffer();
        assert.ok(exported.length > 0);
        const pixel = await sharp(destination, { page: 0 }).removeAlpha().raw().toBuffer();
        assert.ok(
          pixel[0] !== 60 || pixel[1] !== 142 || pixel[2] !== 114,
          'GIF color edit should change original second-frame RGB'
        );
        await exportTo(path.join(output, 'animation-current-frame.png'), '#me-export-frame');
        await page.locator('#me-close').click();
        await page.locator('#viewer-close').click();
        return {
          sourceFrames: 4,
          firstFrameSha256: createHash('sha256').update(first).digest('hex'),
          secondFrameSha256: createHash('sha256').update(second).digest('hex'),
          export: {
            path: destination,
            width: meta.width,
            height: meta.pageHeight,
            frames: meta.pages,
            delay: meta.delay,
            loop: meta.loop
          }
        };
      }
    );
    await check('animated WebP editor frame selection and still export', async () => {
      await navigate(rootId, 'library', 'images');
      await openEditor('07-四帧动画.webp');
      assert.equal(await page.locator('#me-animation').isVisible(), true);
      assert.equal(await page.locator('#me-seek').getAttribute('max'), '4');
      await input('#me-frame-number', 4, 'change');
      await page.waitForFunction(
        () => $('#me-frame-number').value === '4' && !$('#me-export').disabled
      );
      await selectControl('#me-format', 'webp');
      await input('#me-width', 96);
      const destination = path.join(output, 'webp-fourth-frame.webp');
      const meta = await exportTo(destination);
      assert.equal(meta.width, 96);
      assert.equal(meta.height, 72);
      assert.equal(meta.pages || 1, 1);
      await page.locator('#me-close').click();
      await page.locator('#viewer-close').click();
      return { width: meta.width, height: meta.height, frames: meta.pages || 1 };
    });
    await check('properties modal keyboard isolation', async () => {
      await navigate(rootId, 'library', 'images');
      await properties('02-海边横图.png');
      const index = await page.evaluate(() => V.index);
      await page.locator('#media-place').focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Control+k');
      assert.equal(await page.evaluate(() => V.index), index);
      assert.equal(await page.locator('#modal').evaluate((el) => el.open), true);
      assert.equal(
        await page.locator('#search').evaluate((el) => el === document.activeElement),
        false
      );
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !$('#modal').open);
      assert.equal(await page.locator('#viewer').evaluate((el) => el.open), true);
      await page.locator('#viewer-close').click();
      return { viewerIndexStable: true };
    });
    await check(
      'settings local edits and isolated profile persist across graceful restart',
      async () => {
        await page.evaluate(async () => {
          await changeDisplaySetting('details', false);
          await changeDisplaySetting('density', 186);
          await changeDisplaySetting('ratio', 'square');
          await saveSetting('sidebarMode', 'compact');
          await changeTheme('dark');
        });
        await closeApp();
        await launch();
        const settings = await page.evaluate(() => ({
          density: S.settings.density,
          details: S.settings.details,
          ratio: S.settings.ratio,
          theme: S.settings.theme,
          autoMatch: S.settings.autoMatch,
          watchChanges: S.settings.watchChanges,
          sidebarMode: S.settings.sidebarMode
        }));
        assert.deepEqual(settings, {
          density: 186,
          details: false,
          ratio: 'square',
          theme: 'dark',
          autoMatch: false,
          watchChanges: false,
          sidebarMode: 'compact'
        });
        await navigate(rootId, 'timeline', 'images');
        const n = await node('01-拍摄时区与方向.jpg'),
          m = await page.evaluate((id) => api('mediaInfo', { id }), n.id);
        assert.equal(m.place, '海边 %_ literal');
        assert.equal(m.latitude, 36.25);
        assert.equal(m.longitude, 140.5);
        assert.equal(await page.locator('#intro-area').evaluate((el) => el.childElementCount), 0);
        await screenshot('restart-timeline-dark');
        return { settings, place: m.place, latitude: m.latitude, longitude: m.longitude };
      }
    );
    await check('all fixture originals hashes sizes mtimes unchanged', async () => {
      const after = await hashes();
      await fs.writeFile(path.join(run, 'originals-after.json'), JSON.stringify(after, null, 2));
      assert.deepEqual(after, before);
      report.metrics.originalsUnchanged = after.length;
      return { files: after.length, sha256AndSizeAndMtime: true };
    });
    await check('renderer pageerrors and unhandled promise rejections', async () => {
      await collectRejections();
      assert.deepEqual(report.pageerrors, []);
      assert.deepEqual(report.unhandledrejections, []);
      return {
        pageerrors: 0,
        unhandledrejections: 0,
        consoleErrors: report.consoleErrors.length,
        failedRequests: report.failedRequests.length
      };
    });
  } catch (error) {
    report.fatal = { stage, message: error.message, stack: error.stack };
    console.error(error);
    if (page) await screenshot('fatal').catch(() => {});
  } finally {
    await closeApp().catch((e) => {
      report.shutdownError = e.stack;
    });
    report.finished = new Date().toISOString();
    report.passed = report.checks.filter((c) => c.status === 'passed').length;
    report.failed = report.checks.filter((c) => c.status === 'failed').length;
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    await fs.writeFile(
      path.join(
        project,
        'artifacts',
        'media-integration',
        `latest-${packaged ? 'packaged' : 'source'}.json`
      ),
      JSON.stringify(
        {
          run,
          report: path.join(run, 'report.json'),
          passed: report.passed,
          failed: report.failed,
          fatal: report.fatal || null
        },
        null,
        2
      )
    );
    console.log(
      'RESULT ' +
        JSON.stringify({
          run,
          passed: report.passed,
          failed: report.failed,
          fatal: report.fatal || null,
          metrics: report.metrics
        })
    );
    if (report.failed || report.fatal || report.shutdownError) process.exitCode = 1;
  }
})();
