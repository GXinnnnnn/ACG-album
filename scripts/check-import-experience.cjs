'use strict';
// Lead runs serially: node scripts/check-import-experience.cjs
// This opens source Electron. Do not run beside another GUI/measurement script.
// Product files are never patched: a generated bootstrap wraps only the real
// library worker's fetch and observes messages in this run's isolated process.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const report = {
  scope:
    'Source Electron; actual import dialog, production worker/scanner/media/IPC; 40 generated folders with three decodable PNGs each. Delayed deterministic fake Bangumi only, no public HTTP or personal profile.',
  instrumentation:
    'Generated bootstrap substitutes the library Worker entry with a wrapper that installs fetch before requiring the unchanged production worker. No scanner, media, queue throttle or renderer implementation is replaced. Synthetic progress/online events and held get replies are separately labelled.',
  checks: [],
  screenshots: [],
  errors: [],
  externalRequests: [],
  samples: {},
  limitations: [
    'Generated fixture and controlled fake network only; not actual Bangumi throughput, arbitrary library performance or an installation test.'
  ],
  runtime: {
    mode: 'source-with-network-bootstrap',
    executable: require('electron'),
    version: metadata.version
  }
};
let app,
  page,
  run,
  profile,
  collection,
  albums,
  gate,
  stage = 'setup';
const rpc = (method, args = {}) =>
  bounded(
    () => page.evaluate(({ method, args }) => window.album.call(method, args), { method, args }),
    15000,
    'RPC ' + method
  );
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function inside(base, file) {
  const relative = path.relative(base, file);
  assert.ok(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    'Expected isolated descendant: ' + file
  );
}
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}
async function poll(label, action, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await pause(60);
  }
  throw new Error('Timed out: ' + label);
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  inside(run, file);
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
// Serialized into a generated worker entry. Every URL is handled here: there
// is deliberately no reference to original fetch and hence no live HTTP path.
function workerFixture() {
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs');
  const { setTimeout: delay } = require('node:timers/promises');
  const config = workerData.__importExperience;
  const notify = (data) => parentPort.postMessage({ event: 'experienceNetwork', data });
  const subject = {
    id: 890001,
    type: 4,
    name: config.positiveName,
    name_cn: config.positiveName,
    date: '2024-01-02',
    summary: 'Generated import experience fixture, not a public Bangumi record.',
    collection: { collect: 1000 },
    rating: { score: 8.4, total: 1000 },
    images: { large: 'https://lain.bgm.tv/pic/cover/l/import_experience_fixture.png' }
  };
  global.fetch = async (value, options = {}) => {
    const url = new URL(String(value));
    const body = options.body ? JSON.parse(options.body) : null;
    notify({
      phase: 'started',
      url: url.href,
      method: options.method || 'GET',
      keyword: body?.keyword || '',
      authorization: !!options.headers?.Authorization
    });
    if (options.headers?.Authorization) throw new Error('Unexpected fixture credential');
    while (!fs.existsSync(config.gate)) await delay(40, undefined, { signal: options.signal });
    // Keep an observable asynchronous transport boundary after the explicit gate.
    await delay(100, undefined, { signal: options.signal });
    let response;
    if (url.hostname === 'api.bgm.tv' && url.pathname === '/v0/search/subjects') {
      const data = body?.keyword === config.positiveName ? [subject] : [];
      response = new Response(JSON.stringify({ data, total: data.length, limit: 20, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } else if (url.hostname === 'api.bgm.tv' && url.pathname === '/v0/subjects/890001') {
      response = new Response(JSON.stringify(subject), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } else if (url.hostname === 'api.bgm.tv' && url.pathname === '/v0/subjects/890001/persons') {
      response = new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    } else if (url.href === subject.images.large) {
      const bytes = fs.readFileSync(config.onlineCover);
      response = new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) }
      });
    } else {
      notify({ phase: 'unexpected', url: url.href });
      throw new Error('Unexpected fixture HTTP request: ' + url.href);
    }
    notify({
      phase: 'returned',
      url: url.href,
      keyword: body?.keyword || '',
      status: response.status
    });
    return response;
  };
  require(config.workerSource);
}
// Serialized into the generated Electron main entry. The production main is
// required only after the worker wrapper and HTTP guards have been installed.
function mainFixture(config) {
  const fs = require('node:fs');
  const path = require('node:path');
  const electron = require('electron');
  const threads = require('node:worker_threads');
  const OriginalWorker = threads.Worker;
  const probe = (global.__importExperience = {
    requests: [],
    scans: [],
    blocked: [],
    holdId: '',
    held: [],
    worker: null
  });
  threads.Worker = class extends OriginalWorker {
    constructor(filename, options = {}) {
      const library = path.resolve(String(filename)) === config.workerSource;
      super(
        library ? config.workerWrapper : filename,
        library
          ? { ...options, workerData: { ...options.workerData, __importExperience: config } }
          : options
      );
      this.experienceRequests = new Map();
      if (library) probe.worker = this;
    }
    postMessage(message, ...rest) {
      if (this === probe.worker) {
        if (message?.method === 'scan') probe.scans.push(message.args);
        if (message?.method === 'get' && probe.holdId && message.args?.id === probe.holdId)
          this.experienceRequests.set(message.request, message.args.id);
      }
      return super.postMessage(message, ...rest);
    }
    emit(type, message, ...rest) {
      if (type === 'message' && this === probe.worker) {
        if (message?.event === 'experienceNetwork') probe.requests.push(message.data);
        if (this.experienceRequests?.has(message?.request)) {
          this.experienceRequests.delete(message.request);
          probe.held.push(message);
          return true;
        }
      }
      return super.emit(type, message, ...rest);
    }
    releaseGets() {
      probe.holdId = '';
      for (const message of probe.held.splice(0)) super.emit('message', message);
    }
  };
  const originalNetFetch = electron.net.fetch.bind(electron.net);
  electron.net.fetch = async (value, options) => {
    const url = new URL(String(value));
    if (url.protocol === 'file:') {
      const file = require('node:url').fileURLToPath(url);
      const relative = path.relative(config.run, file);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        return originalNetFetch(value, options);
    }
    probe.blocked.push({ kind: 'main-net-fetch', url: url.href });
    throw new Error('Non-fixture network blocked by import experience fixture');
  };
  electron.app.whenReady().then(() => {
    electron.session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        probe.blocked.push({ kind: 'chromium', url: details.url });
        callback({ cancel: true });
      }
    );
  });
  // A single deterministic chooser is the only native dialog substitution.
  electron.dialog.showOpenDialog = async () => ({
    canceled: false,
    filePaths: [config.collection]
  });
  fs.accessSync(config.workerSource);
  require(config.mainSource);
}
async function fixtures() {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const physicalArtifacts = await fs.realpath(path.join(root, 'artifacts'));
  run = path.join(
    physicalArtifacts,
    'import_experience',
    new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
      '_' +
      crypto.randomUUID().replace(/-/g, '_')
  );
  await fs.mkdir(run, { recursive: true });
  run = await fs.realpath(run);
  inside(physicalArtifacts, run);
  assert.ok(!/[- ]/.test(path.basename(run)), 'Underscore-only run name');
  profile = path.join(run, 'generated_profile');
  collection = path.join(run, 'generated_collection');
  gate = path.join(run, 'release_network_gate');
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(collection, { recursive: true });
  albums = [];
  for (let i = 0; i < 40; i++) {
    const folder = path.join(collection, '星海档案' + String(i).padStart(3, '0'));
    await fs.mkdir(folder);
    const files = [];
    for (let j = 0; j < 3; j++) {
      const file = path.join(folder, `image_${j + 1}.png`);
      await sharp({
        create: {
          width: 240,
          height: 340 + j * 20,
          channels: 3,
          background: { r: 70 + i * 3, g: 110 + j * 40, b: 180 - i * 2 }
        }
      })
        .png()
        .toFile(file);
      const time = new Date(Date.UTC(2024, 0, 1, 0, 0, j));
      await fs.utimes(file, time, time);
      files.push(file);
    }
    albums.push({ folder, id: idFor(folder), name: path.basename(folder), files });
  }
  const onlineCover = path.join(run, 'generated_online_cover.png');
  await sharp({ create: { width: 240, height: 340, channels: 3, background: '#bd74d2' } })
    .png()
    .toFile(onlineCover);
  const config = {
    run,
    workerSource: path.join(root, 'src', 'library-worker.cjs'),
    mainSource: path.join(root, 'src', 'main.cjs'),
    workerWrapper: path.join(run, 'worker_fixture.cjs'),
    gate,
    onlineCover,
    collection,
    positiveName: albums[0].name
  };
  await fs.writeFile(config.workerWrapper, `'use strict';\n(${workerFixture.toString()})();\n`, {
    flag: 'wx'
  });
  await fs.writeFile(
    path.join(run, 'bootstrap.cjs'),
    `'use strict';\n(${mainFixture.toString()})(${JSON.stringify(config)});\n`,
    { flag: 'wx' }
  );
  await fs.writeFile(
    path.join(run, 'package.json'),
    JSON.stringify(
      {
        name: metadata.name,
        productName: metadata.build.productName,
        version: metadata.version,
        main: 'bootstrap.cjs'
      },
      null,
      2
    ),
    { flag: 'wx' }
  );
  Object.assign(report, {
    run,
    profile,
    fixture: {
      collection,
      folders: 40,
      imagesPerFolder: 3,
      imageCount: 120,
      onlinePositive: albums[0].name,
      otherSearches: 'empty results'
    }
  });
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    executablePath: report.runtime.executable,
    args: [run],
    cwd: root,
    env,
    timeout: 30000
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.externalRequests.push({ stage, url: route.request().url() });
    await route.abort();
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) =>
    report.errors.push({ stage, kind: 'pageerror', message: error.message })
  );
  page.on('console', (message) => {
    if (message.type() === 'error')
      report.errors.push({ stage, kind: 'console', message: message.text() });
  });
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && typeof showOnlineStatus === 'function'
  );
  const actual = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    executable: process.execPath
  }));
  assert.equal(path.resolve(actual.userData), path.join(profile, 'chromium-profile'));
  assert.equal(actual.version, metadata.version);
  assert.equal(actual.isPackaged, false);
  assert.equal(
    (await fs.realpath(actual.executable)).toLowerCase(),
    (await fs.realpath(report.runtime.executable)).toLowerCase()
  );
  report.runtime.actual = actual;
  const initial = await rpc('init');
  assert.equal(initial.roots.length, 0, 'Fresh isolated library');
  assert.equal(initial.localIndex.available, false, 'Deliberately missing local index');
  assert.equal((await rpc('tokenStatus')).saved, false, 'No saved fixture credential');
  await resize(1600);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(async () => {
    for (const [key, value] of [
      ['watchChanges', false],
      ['autoMatch', false],
      ['theme', 'light'],
      ['sidebarMode', 'compact'],
      ['density', 186]
    ])
      await saveSetting(key, value);
    window.__importExperience = { events: [], observations: [], rejections: [], refs: null };
    addEventListener('unhandledrejection', (event) =>
      __importExperience.rejections.push(String(event.reason?.message || event.reason))
    );
    __importExperience.unsubscribe = window.album.onEvent((event) => {
      if (!['progress', 'online'].includes(event.type)) return;
      const panel = document.querySelector('#progress-panel');
      __importExperience.events.push({ type: event.type, data: event.data, ms: performance.now() });
      if (!panel.hidden && !__importExperience.refs)
        __importExperience.refs = [
          '#progress-panel',
          '#progress-title',
          '#progress-directory',
          '.progress-track',
          '#progress-bar',
          '#progress-detail',
          '#progress-path'
        ].map((s) => document.querySelector(s));
      if (__importExperience.refs)
        __importExperience.observations.push({
          type: event.type,
          active: event.data.active,
          title: document.querySelector('#progress-title').textContent,
          directory: document.querySelector('#progress-directory')?.textContent || '',
          stable: __importExperience.refs.every((node) => node?.isConnected),
          panelCount: document.querySelectorAll('#progress-panel').length
        });
    });
  });
}
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(width, 960);
    win.webContents.setBackgroundThrottling(false);
    win.show();
  }, width);
  await page.waitForFunction((width) => innerWidth === width && innerHeight === 960, width);
  await frames();
}
const frames = () =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
const nativeProbe = () =>
  app.evaluate(() => ({
    requests: global.__importExperience.requests,
    scans: global.__importExperience.scans,
    blocked: global.__importExperience.blocked,
    held: global.__importExperience.held.length
  }));
async function send(type, data) {
  await app.evaluate(
    ({ BrowserWindow }, event) =>
      BrowserWindow.getAllWindows()[0].webContents.send('library:event', event),
    { type, data }
  );
  await frames();
}
async function sendRepeated(type, data, count = 100) {
  const marker = crypto.randomUUID();
  await app.evaluate(
    ({ BrowserWindow }, { type, data, count, marker }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      for (let i = 0; i < count; i++)
        contents.send('library:event', { type, data: { ...data, experienceProbe: marker } });
    },
    { type, data, count, marker }
  );
  await page.waitForFunction(
    ({ marker, count }) =>
      __importExperience.events.filter((event) => event.data.experienceProbe === marker).length ===
      count,
    { marker, count }
  );
  await frames();
}
async function observeProgress() {
  await page.evaluate(() => {
    const panel = document.querySelector('#progress-panel');
    const metrics = {
      fieldMutations: { title: 0, path: 0, directory: 0 },
      states: [],
      visibility: []
    };
    const fields = Object.fromEntries(
      ['title', 'path', 'directory'].map((name) => [
        name,
        document.querySelector('#progress-' + name)
      ])
    );
    const collect = (records) => {
      for (const record of records) {
        for (const [name, field] of Object.entries(fields))
          if (field?.contains(record.target)) metrics.fieldMutations[name]++;
        if (record.target !== panel || record.type !== 'attributes') continue;
        if (record.attributeName === 'data-state')
          metrics.states.push({
            from: record.oldValue,
            to: panel.dataset.state,
            ms: performance.now()
          });
        if (record.attributeName === 'hidden')
          metrics.visibility.push({
            wasHidden: record.oldValue !== null,
            hidden: panel.hidden,
            ms: performance.now()
          });
      }
    };
    const observer = new MutationObserver(collect);
    observer.observe(panel, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true
    });
    window.__progressDomProbe = { metrics, observer, collect };
  });
}
async function progressObservations(stop = false) {
  return page.evaluate((stop) => {
    const probe = window.__progressDomProbe;
    probe.collect(probe.observer.takeRecords());
    if (stop) {
      probe.observer.disconnect();
      delete window.__progressDomProbe;
    }
    return probe.metrics;
  }, stop);
}
async function panelSnapshot() {
  return page.evaluate(() => {
    const find = (s) => document.querySelector(s),
      panel = find('#progress-panel'),
      title = find('#progress-title'),
      directory = find('#progress-directory');
    const bounds = (n) => {
      const r = n.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const style = (n) => {
      const s = getComputedStyle(n);
      return Object.fromEntries(
        [
          'backgroundColor',
          'backgroundImage',
          'borderRadius',
          'borderColor',
          'boxShadow',
          'padding',
          'fontSize',
          'fontWeight',
          'color'
        ].map((key) => [key, s[key]])
      );
    };
    return {
      hidden: panel.hidden,
      state: panel.dataset.state,
      title: title.textContent,
      directory: directory?.textContent,
      directoryTitle: directory?.title,
      directoryHidden: directory?.hidden,
      detail: find('#progress-detail').textContent,
      path: find('#progress-path').textContent,
      cancelHidden: find('#cancel-import').hidden,
      busy: panel.getAttribute('aria-busy'),
      bounds: bounds(panel),
      titleBounds: bounds(title),
      directoryBounds: bounds(directory),
      styles: {
        panel: style(panel),
        title: style(title),
        top: style(find('.progress-top')),
        track: style(find('.progress-track'))
      },
      sameNodes: __importExperience.refs?.every((n) => n?.isConnected),
      directoryCount: document.querySelectorAll('#progress-directory').length,
      text: panel.innerText
    };
  });
}
function stablePanel(a, b) {
  assert.equal(a.hidden, false);
  assert.equal(b.hidden, false);
  assert.equal(a.title, '正在检索作品简介');
  assert.equal(b.title, a.title);
  assert.deepEqual(
    a.styles,
    b.styles,
    'Scan/online event must not change the panel material or typography'
  );
  assert.ok(Math.abs(a.bounds.width - b.bounds.width) < 0.5, 'Panel width stays fixed');
  assert.ok(Math.abs(a.titleBounds.x - b.titleBounds.x) < 0.5, 'Title position stays fixed');
  for (const sample of [a, b]) {
    assert.equal(sample.sameNodes, true);
    assert.equal(sample.directoryCount, 1);
    assert.ok(
      sample.directoryBounds.x >= sample.titleBounds.right - 1,
      'Directory sits to the right of the title'
    );
    assert.ok(sample.bounds.x >= 0 && sample.bounds.right <= 1601);
  }
}
async function importAndLocalCover() {
  await page.locator('#import-sidebar').click();
  await expect(page.locator('#import-options')).toBeVisible();
  const kind = page.locator('#import-directory-kind');
  if ((await kind.inputValue()) !== 'work') {
    const button = kind.locator('..').getByRole('combobox');
    await button.click();
    const listId = await button.getAttribute('aria-controls');
    assert.ok(listId, 'Custom select exposes its visible option list');
    await page
      .locator('#' + listId)
      .getByRole('option', { name: '作品名称', exact: true })
      .click();
  }
  await expect(kind).toHaveValue('work');
  await expect(kind.locator('..').getByRole('combobox')).toHaveText('作品名称');
  await page.locator('#import-online-match').check();
  for (const type of [1, 2, 6]) {
    const button = page.locator(`[data-import-subject-type="${type}"]`);
    if ((await button.getAttribute('aria-pressed')) === 'true') await button.click();
  }
  await page.locator('#import-options-confirm').click();
  await poll('first blocked API request', async () =>
    (await nativeProbe()).requests.some((r) => r.phase === 'started')
  );
  await page.waitForFunction(() => !scanActive && pendingImport === null, null, { timeout: 60000 });
  const listing = await poll('all local covers before any fake network response', async () => {
    const result = await rpc('list', { parent: idFor(collection), sort: 'name', limit: 60 });
    return result.items.length === 40 &&
      result.items.every(
        (n) => n.files === 3 && /^[a-f0-9]{24}$/.test(n.cover || '') && !n.subject_id
      )
      ? result
      : null;
  });
  const network = await nativeProbe();
  assert.equal(network.requests.filter((r) => r.phase === 'returned').length, 0);
  assert.equal(network.scans.length, 1);
  assert.equal(network.scans[0].path, collection);
  assert.equal(network.scans[0].onlineMatch, true);
  assert.deepEqual(network.scans[0].subjectTypes, [4]);
  await page.evaluate(async (parent) => {
    if (S.parent !== parent) await navigate({ parent });
  }, idFor(collection));
  const selector = `.album-card[data-id="${albums[0].id}"] img`;
  await page.waitForFunction((selector) => {
    const image = document.querySelector(selector);
    return image?.complete && image.naturalWidth > 0 && image.currentSrc.startsWith('acg-image://');
  }, selector);
  const node = await rpc('get', { id: albums[0].id });
  assert.equal(
    node.cover,
    idFor(albums[0].files[0]),
    'Work cover uses the first local image in natural filename order'
  );
  for (const album of albums)
    assert.equal(listing.items.find((n) => n.id === album.id)?.cover, idFor(album.files[0]));
  assert.equal(node.subject_id, null);
  const image = await page.locator(selector).evaluate((img) => ({
    src: img.currentSrc,
    width: img.naturalWidth,
    height: img.naturalHeight
  }));
  const events = await page.evaluate(() => ({
    events: __importExperience.events,
    observations: __importExperience.observations
  }));
  assert.ok(events.events.some((e) => e.type === 'progress' && e.data.active));
  assert.ok(events.events.some((e) => e.type === 'online' && e.data.active));
  assert.ok(events.observations.every((s) => s.stable && s.panelCount === 1));
  const snapshot = await panelSnapshot();
  assert.equal(snapshot.title, '正在检索作品简介');
  await shot('real_import_local_cover_before_network');
  report.samples.localBeforeNetwork = {
    folders: listing.items.length,
    node,
    image,
    network,
    ...events,
    panel: snapshot
  };
  return { localCovers: 40, images: 120, completedNetworkResponses: 0, loadedImage: image };
}
async function releaseNetwork() {
  await fs.writeFile(gate, 'release\n', { flag: 'wx' });
  const matched = await poll(
    'positive fixture matched by the real worker',
    async () => {
      const node = await rpc('get', { id: albums[0].id });
      return node.subject_id === 890001 && node.metadata?.rating?.score === 8.4 ? node : null;
    },
    90000
  );
  await poll(
    'fake online queue drained',
    async () => {
      const init = await rpc('init');
      return !init.online.active && !init.online.remaining && !init.online.discovering
        ? init
        : null;
    },
    180000
  );
  await page.evaluate(async () => {
    await loadSummary();
    await loadPage(true);
  });
  await expect(page.locator(`.album-card[data-id="${albums[0].id}"] .card-rating`)).toBeVisible();
  return {
    matchedId: matched.subject_id,
    rating: matched.metadata.rating,
    requests: (await nativeProbe()).requests
  };
}
async function holdGet(id) {
  await app.evaluate((_, id) => {
    global.__importExperience.holdId = id;
  }, id);
}
async function releaseGets() {
  await app.evaluate(() => global.__importExperience.worker.releaseGets());
  await frames();
}
async function syntheticProgress() {
  const scan = {
    active: true,
    root: idFor(collection),
    current: albums[1].folder,
    images: 120,
    folders: 41,
    errors: 0
  };
  const online = (album) => ({
    active: true,
    id: album.id,
    completed: 1,
    remaining: 39,
    total: 40,
    discovering: false
  });
  const samples = [];
  await send('progress', scan);
  await expect(page.locator('#progress-directory')).toHaveText(albums[1].name);
  samples.push(await panelSnapshot());
  assert.equal(samples.at(-1).cancelHidden, false);
  await send('online', online(albums[2]));
  await expect(page.locator('#progress-directory')).toHaveText(albums[1].name);
  samples.push(await panelSnapshot());
  await send('progress', { ...scan, current: albums[3].folder });
  await expect(page.locator('#progress-directory')).toHaveText(albums[3].name);
  samples.push(await panelSnapshot());
  await send('progress', { ...scan, active: false, phase: '完成' });
  await expect(page.locator('#progress-directory')).toHaveText(albums[2].name);
  samples.push(await panelSnapshot());
  assert.equal(samples.at(-1).cancelHidden, true);
  for (const sample of samples.slice(1)) stablePanel(samples[0], sample);
  // Hold actual production get(A) IPC replies; B resolves first, then release A.
  await holdGet(albums[4].id);
  await send('online', online(albums[4]));
  await poll('held stale get reply', async () => (await nativeProbe()).held > 0);
  await send('online', online(albums[5]));
  await expect(page.locator('#progress-directory')).toHaveText(albums[5].name);
  await releaseGets();
  await expect(page.locator('#progress-directory')).toHaveText(albums[5].name);
  samples.push(await panelSnapshot());
  // Resolve another online get while a new scan owns the visible directory.
  await holdGet(albums[6].id);
  await send('online', online(albums[6]));
  await poll('held online get before new scan', async () => (await nativeProbe()).held > 0);
  await send('progress', { ...scan, current: albums[7].folder });
  await releaseGets();
  await expect(page.locator('#progress-directory')).toHaveText(albums[7].name);
  samples.push(await panelSnapshot());
  stablePanel(samples[0], samples.at(-1));
  report.samples.syntheticInterleaving = {
    note: 'Injected main-process library:event messages, with real get IPC replies deliberately reordered; not a second file scan.',
    samples
  };
  return { samples: samples.length, staleGetIgnored: true, scanRetainsDirectory: true };
}
async function syntheticProgressStability() {
  const scan = {
    active: true,
    root: idFor(collection),
    current: albums[8].folder,
    images: 9,
    folders: 9,
    errors: 0
  };
  const work = {
    active: true,
    id: albums[8].id,
    completed: 1,
    remaining: 39,
    total: 40,
    discovering: false
  };
  await send('online', work);
  await send('progress', { ...scan, active: false, phase: '完成' });
  await expect(page.locator('#progress-directory')).toHaveText(albums[8].name);
  await expect(page.locator('#progress-title')).toHaveText('正在检索作品简介');
  const initial = await panelSnapshot();
  await observeProgress();
  await sendRepeated('online', work);
  const repeated = await progressObservations(true);
  assert.deepEqual(
    repeated.fieldMutations,
    { title: 0, path: 0, directory: 0 },
    '100 identical events must not rewrite unchanged title, path or directory DOM'
  );
  assert.deepEqual(repeated.states, []);
  assert.deepEqual(repeated.visibility, []);

  // An actual delayed production get must preserve the last resolved label.
  await holdGet(albums[9].id);
  let delayed;
  try {
    await send('online', { ...work, id: albums[9].id });
    await poll(
      'held lookup for retained directory label',
      async () => (await nativeProbe()).held > 0
    );
    delayed = await panelSnapshot();
    assert.equal(delayed.directory, initial.directory);
    assert.equal(delayed.directoryHidden, false);
    assert.equal(delayed.title, initial.title);
  } finally {
    await releaseGets();
  }
  await expect(page.locator('#progress-directory')).toHaveText(albums[9].name);
  const resumed = { ...work, id: albums[9].id };
  const idle = { active: false, completed: 40, remaining: 0, total: 40, discovering: false };
  await observeProgress();
  // Both messages are scheduled in one main-process call to avoid an automation
  // round trip accidentally consuming the renderer's 300ms settling window.
  const marker = crypto.randomUUID();
  await app.evaluate(
    async ({ BrowserWindow }, { idle, resumed, marker }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.send('library:event', {
        type: 'online',
        data: { ...idle, experienceProbe: marker, probePhase: 'idle' }
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      contents.send('library:event', {
        type: 'online',
        data: { ...resumed, experienceProbe: marker, probePhase: 'resumed' }
      });
    },
    { idle, resumed, marker }
  );
  await page.waitForFunction(
    (marker) =>
      __importExperience.events.some(
        (event) => event.data.experienceProbe === marker && event.data.probePhase === 'resumed'
      ),
    marker
  );
  await frames();
  const briefIdle = await progressObservations(true);
  assert.deepEqual(briefIdle.states, [], 'A brief idle must not enter complete before new work');
  assert.deepEqual(briefIdle.visibility, [], 'A brief idle must not hide or reopen the panel');
  assert.equal(briefIdle.fieldMutations.title, 0, 'A brief idle must not flash a completion title');
  await expect(page.locator('#progress-title')).toHaveText('正在检索作品简介');
  const interval = await page.evaluate(
    (marker) =>
      __importExperience.events
        .filter((event) => event.data.experienceProbe === marker)
        .map((event) => ({ phase: event.data.probePhase, ms: event.ms })),
    marker
  );
  assert.equal(interval.length, 2);
  assert.ok(
    interval[1].ms - interval[0].ms < 300,
    'Synthetic idle must actually remain inside the 300ms settling window'
  );

  // Real panel dimensions are measured after layout, with quantity digit growth
  // and a long synthetic path. No files are scanned at this generated path.
  const dimensions = [];
  const longPath = path.join(collection, '超长目录名称_'.repeat(40));
  for (const sample of [
    scan,
    { ...scan, images: 99999, folders: 9999, errors: 99 },
    { ...scan, current: longPath, images: 999999999, folders: 9999999, errors: 9999 }
  ]) {
    await send('progress', sample);
    const value = await panelSnapshot();
    assert.equal(value.title, '正在检索作品简介');
    if (dimensions.length) {
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(
          Math.abs(value.bounds[key] - dimensions[0].bounds[key]) < 0.5,
          'Panel ' + key + ' stays stable across quantity digits and long directory labels'
        );
      stablePanel(dimensions[0], value);
    }
    dimensions.push(value);
  }
  assert.equal(
    dimensions.at(-1).directoryTitle,
    longPath,
    'The full long directory remains available as a title'
  );
  await shot('synthetic_progress_stable_digits_long_path');
  await send('progress', { ...scan, active: false, phase: '完成' });
  await expect(page.locator('#progress-directory')).toHaveText(albums[9].name);
  await observeProgress();
  await send('online', idle);
  await expect.poll(async () => (await panelSnapshot()).state, { timeout: 3000 }).toBe('complete');
  const complete = await panelSnapshot();
  assert.equal(complete.hidden, false);
  assert.equal(complete.title, '作品检索完成');
  await sendRepeated('online', idle);
  // Observe the application's real six-second hide timer; no timer is patched.
  await expect
    .poll(async () => (await panelSnapshot()).hidden, { timeout: 9000, intervals: [100, 200] })
    .toBe(true);
  await sendRepeated('online', idle);
  await page.waitForTimeout(450); // Past the completion settling window, not an animation driver.
  const final = await panelSnapshot();
  assert.equal(
    final.hidden,
    true,
    'Already hidden completion must not reopen on repeated idle events'
  );
  const completion = await progressObservations(true);
  assert.equal(
    completion.states.filter((event) => event.to === 'complete').length,
    1,
    'One stable completion transition'
  );
  assert.equal(
    completion.visibility.filter((event) => event.hidden).length,
    1,
    'One completion hide'
  );
  assert.equal(
    completion.visibility.filter((event) => !event.hidden).length,
    0,
    'No idle-triggered reopen'
  );
  report.samples.syntheticStability = {
    note: 'Synthetic main-process progress events; MutationObserver and real panel layout; delayed real get IPC; actual 300ms settle and six-second hide timers, without source/timer patches.',
    initial,
    repeated,
    delayed,
    briefIdle,
    interval,
    dimensions,
    complete,
    completion,
    final
  };
  return {
    identicalEvents: 100,
    unchangedTitlePathMutations: 0,
    retainedDirectoryWhileGetPending: true,
    briefIdleMs: interval[1].ms - interval[0].ms,
    stableGeometrySamples: dimensions.length,
    stableCompletionTransitions: 1,
    hideCount: 1,
    idleReopenedPanel: false
  };
}
async function appearanceMatrix() {
  const result = [];
  for (const width of [980, 1600]) {
    await resize(width);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async (theme) => saveSetting('theme', theme), theme);
      const scan = {
        active: true,
        root: idFor(collection),
        current: albums[7].folder,
        images: 120,
        folders: 41,
        errors: 0
      };
      await send('progress', scan);
      const scanPanel = await panelSnapshot();
      await shot(`${theme}_${width}_scan`);
      await send('online', {
        active: true,
        id: albums[0].id,
        completed: 1,
        remaining: 39,
        total: 40
      });
      await send('progress', { ...scan, active: false, phase: '完成' });
      await expect(page.locator('#progress-directory')).toHaveText(albums[0].name);
      const onlinePanel = await panelSnapshot();
      stablePanel(scanPanel, onlinePanel);
      assert.ok(onlinePanel.bounds.right <= width + 1, 'Panel stays in viewport');
      const selector = `.album-card[data-id="${albums[0].id}"]`;
      const geometry = await page.locator(selector).evaluate((card) => {
        const shell = card.querySelector('.cover-shell'),
          rating = card.querySelector('.card-rating'),
          overlay = card.querySelector('.card-bottom-overlay'),
          gradient = card.querySelector('.cover-gradient');
        const style = (n) => getComputedStyle(n);
        const rect = (n) => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          cardRadius: style(card).borderRadius,
          shellRadius: style(shell).borderRadius,
          gradientLowerRadius: style(gradient).borderBottomLeftRadius,
          ratingRadius: style(rating).borderRadius,
          overlayLeft: style(overlay).left,
          card: rect(card),
          shell: rect(shell),
          rating: rect(rating)
        };
      });
      assert.equal(
        geometry.cardRadius,
        geometry.shellRadius,
        'Card and image shell share silhouette'
      );
      assert.ok(parseFloat(geometry.cardRadius) >= 12);
      assert.ok(
        Math.abs(
          parseFloat(geometry.gradientLowerRadius) - (parseFloat(geometry.cardRadius) - 1)
        ) <= 1
      );
      assert.ok(
        parseFloat(geometry.ratingRadius) >= geometry.rating.height / 2,
        'Rating remains a capsule'
      );
      assert.equal(geometry.overlayLeft, '8px');
      assert.ok(
        geometry.rating.x >= geometry.shell.x &&
          geometry.rating.x + geometry.rating.width <= geometry.shell.x + geometry.shell.width + 1
      );
      result.push({ width, theme, scan: scanPanel, online: onlinePanel, geometry });
      await shot(`${theme}_${width}_online`);
    }
  }
  report.samples.appearanceMatrix = result;
  return {
    combinations: result.length,
    screenshots: 8,
    cardRadius: 'matches cover shell',
    overlayLeft: '8px'
  };
}
async function restoreAndVerify() {
  const state = await rpc('init');
  await send('progress', state.progress);
  await send('online', state.online);
  await page.evaluate(() => {
    __importExperience.unsubscribe?.();
    clearTimeout(progressHideTimer);
  });
  const renderer = await page.evaluate(() => ({
    observations: __importExperience.observations,
    rejections: __importExperience.rejections
  }));
  const native = await nativeProbe();
  assert.ok(renderer.observations.every((s) => s.stable && s.panelCount === 1));
  assert.deepEqual(renderer.rejections, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.externalRequests, []);
  assert.deepEqual(native.blocked, []);
  assert.equal(
    native.requests.some((r) => r.phase === 'unexpected' || r.authorization),
    false
  );
  assert.ok(
    native.requests.some((r) => r.phase === 'returned' && r.url.includes('/v0/search/subjects'))
  );
  await assert.rejects(fs.access(path.join(run, 'absent_index.sqlite')), { code: 'ENOENT' });
  report.samples.final = { renderer, native };
  await expect(page.locator('.toast.error')).toHaveCount(0);
  return {
    stableDomObservations: renderer.observations.length,
    unhandledRejections: 0,
    unexpectedPublicRequests: 0
  };
}
async function bounded(action, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      action(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function closeApp() {
  if (!app) return;
  const closing = app,
    child = closing.process();
  try {
    if (page && !page.isClosed()) {
      await bounded(releaseGets, 2000, 'Release held IPC').catch(() => {});
      await bounded(() => rpc('cancel'), 3000, 'Cancel fixture queue').catch(() => {});
    }
    await bounded(() => closing.close(), 15000, 'Electron close');
    report.closed = true;
  } catch (error) {
    // Only this script's Electron child is eligible for the fallback.
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await bounded(() => exited, 5000, 'Owned Electron exit').catch((exitError) =>
        report.errors.push({ stage: 'close', message: exitError.message })
      );
    }
    report.closed = !!child && (child.exitCode !== null || child.signalCode !== null);
    throw error;
  } finally {
    if (app === closing) app = null;
  }
}
(async () => {
  try {
    await fixtures();
    await launch();
    await check(
      'real import exposes all local covers and a loaded image before any delayed network response',
      importAndLocalCover
    );
    await check(
      'released fake network exercises real matching and creates a rating capsule',
      releaseNetwork
    );
    await check(
      'synthetic scan/online interleaving keeps DOM/style and rejects stale directory replies',
      syntheticProgress
    );
    await check(
      'synthetic repeated progress keeps DOM and geometry stable, retains labels and settles completion once',
      syntheticProgressStability
    );
    await check(
      'light/dark at 980/1600 retain card rounding, capsule, left-eight overlay and unified progress',
      appearanceMatrix
    );
    await check(
      'restore actual worker status and verify no renderer errors or public HTTP',
      restoreAndVerify
    );
    report.passed = true;
    stage = 'completed';
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    try {
      await closeApp();
    } catch (error) {
      report.errors.push({ stage: 'close', message: error.message });
      report.passed = false;
      process.exitCode = 1;
    }
    if (report.errors.length) {
      report.passed = false;
      process.exitCode = 1;
    }
    report.stage = stage;
    report.finishedAt = new Date().toISOString();
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + file);
    }
  }
})();
