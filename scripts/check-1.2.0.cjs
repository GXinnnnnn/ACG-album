'use strict';
// Run serially by the Lead. This file only creates its own evidence/profile/8px PNGs.
// ACG_TEST_APP (or ACG_APP_PATH / ACG_EXECUTABLE) accepts source or a packaged .exe.
// ACG_CHECK_STAGE selects the evidence parent. Evidence is retained, never auto-deleted.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { Worker, MessageChannel } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const project = path.resolve(__dirname, '..');
const requested = path.resolve(
  process.env.ACG_TEST_APP || process.env.ACG_APP_PATH || process.env.ACG_EXECUTABLE || project
);
const packaged = /\.exe$/i.test(requested);
const stage = path.resolve(process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\check-1.2.0');
const names = [
  'initial document mounts cached cards before real saved scan resumes and optional summary',
  'real folder context rename handles collision and remaps current path, tree, history and flags',
  'real image context rename preserves extension, Escape cancels and repeated Save is single flight',
  'real blank context refresh discovers deep filesystem rename and deletion'
];
const report = {
  passed: false,
  started: new Date().toISOString(),
  requested,
  packaged,
  scope:
    'Actual requested Electron app; generated cached profile and interrupted source-worker scan; initial document only, native context menus and buttons. Only generated 8px PNGs; HTTP denied before product main/worker startup. No deployment or personal data changes.',
  checks: names.map((name) => ({ name, passed: false, status: 'not-run' })),
  screenshots: [],
  errors: [],
  remote: []
};
let run, profile, collection, app, ownedChild, page, bootstrap, alpha, renamedAlpha, initialFiles;
function recordCleanupError(error) {
  report.passed = false;
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
}
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
const probe = () =>
  app.evaluate(() => {
    if (!globalThis.__check120)
      throw new Error(
        'Pre-main -r observer was not installed; refusing a reload-based startup substitute'
      );
    return globalThis.__check120;
  });
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );
function readFixture(query, ...args) {
  assert.ok(inside(run, profile));
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'), { readOnly: true });
  try {
    return db.prepare(query).all(...args);
  } finally {
    db.close();
  }
}
async function screenshot(label) {
  const file = path.join(run, label + '.png');
  await page.screenshot({ path: file });
  report.screenshots.push(file);
  return file;
}
async function check(index, body) {
  const row = report.checks[index];
  row.status = 'running';
  try {
    row.details = await body();
    row.screenshot = await screenshot(String(index + 1).padStart(2, '0') + '-passed');
    row.passed = true;
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = error.stack || String(error);
    await screenshot(String(index + 1).padStart(2, '0') + '-failed').catch(() => {});
    throw error;
  }
}

// This runs in an isolated fixture worker, not in the GUI or the personal library.
// Gate a real refresh before opendir so a real scan_jobs record survives termination.
function fixtureWorker() {
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const port = workerData.checkPort;
  let armed = false;
  let release;
  port.on('message', (message) => {
    if (message === 'arm') {
      armed = true;
      port.postMessage('armed');
    }
    if (message === 'release') release?.();
  });
  const open = fs.opendir;
  fs.opendir = async function (file, ...args) {
    if (
      armed &&
      path.resolve(String(file)).toLowerCase() === workerData.checkDirectory.toLowerCase()
    ) {
      armed = false;
      port.postMessage('gated');
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    return open.call(this, file, ...args);
  };
  globalThis.fetch = async (input) => {
    parentPort.postMessage({ checkHttp: String(input?.url || input) });
    throw new Error('HTTP disabled by 1.2.0 fixture preparation');
  };
  require(workerData.checkEntry);
}
async function prepare() {
  for (const protectedPath of [
    'C:\\ACG\\.review-data',
    'C:\\ACG\\当前版本',
    'C:\\ACG\\安装包',
    'C:\\ACG\\资料归档\\local-index-pilot-2026-10-20',
    project
  ])
    assert.ok(
      !samePath(stage, protectedPath) && !inside(protectedPath, stage),
      'Evidence parent is protected: ' + stage
    );
  await fs.mkdir(stage, { recursive: true });
  const resolved = await fs.realpath(stage);
  for (const protectedPath of [
    'C:\\ACG\\.review-data',
    'C:\\ACG\\当前版本',
    'C:\\ACG\\安装包',
    'C:\\ACG\\资料归档\\local-index-pilot-2026-10-20',
    project
  ])
    assert.ok(
      !samePath(resolved, protectedPath) && !inside(protectedPath, resolved),
      'Resolved evidence parent is protected'
    );
  run = path.join(
    resolved,
    'generated-1.2.0-' + new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID()
  );
  await fs.mkdir(run);
  profile = path.join(run, 'generated-profile');
  collection = path.join(run, 'generated-collection');
  alpha = path.join(collection, 'AlbumAlpha');
  renamedAlpha = path.join(collection, 'AlbumRenamed');
  Object.assign(report, {
    run,
    profile,
    collection,
    fixture: { profile, collection, pngPixels: [8, 8], sourceWorkerPreparation: true }
  });
  console.log('ISOLATED ' + run);
  initialFiles = [
    path.join(alpha, 'keep.png'),
    path.join(alpha, 'collision.png'),
    path.join(alpha, 'Nested', 'nested.png'),
    path.join(alpha, 'Nested', 'Deep', 'leaf.png'),
    path.join(alpha, 'Nested', 'Deep', 'delete.png'),
    path.join(collection, 'ExistingAlbum', 'other.png')
  ];
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#658ca8' } })
    .png()
    .toBuffer();
  for (const file of initialFiles) {
    assert.ok(inside(run, file));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, png, { flag: 'wx' });
  }
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker('(' + fixtureWorker.toString() + ')();', {
    eval: true,
    workerData: {
      dataDir: profile,
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite'),
      checkEntry: path.join(project, 'src/library-worker.cjs'),
      checkDirectory: alpha,
      checkPort: port2
    },
    transferList: [port2],
    env: {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
    }
  });
  let sequence = 0;
  let fault,
    terminatingFixture = false;
  const pending = new Map();
  const gates = new Set();
  const onFault = (error) => {
    fault = error;
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
  };
  const ready = new Promise((resolve, reject) => {
    worker.once('error', (error) => {
      onFault(error);
      reject(error);
    });
    worker.on('message', (message) => {
      if (message.checkHttp) {
        report.remote.push(message.checkHttp);
        onFault(new Error('Unexpected fixture HTTP: ' + message.checkHttp));
        return;
      }
      if (message.event === 'ready') resolve();
      const task = pending.get(message.request);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.request);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
    });
    worker.once('exit', (code) => {
      if (pending.size) {
        const error = new Error('Fixture worker exited: ' + code);
        error.code = terminatingFixture ? 'CHECK120_FIXTURE_TERMINATED' : 'CHECK120_FIXTURE_EXIT';
        onFault(error);
      }
    });
  });
  port1.on('message', (message) => gates.add(message));
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      if (fault) return reject(fault);
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Fixture RPC timeout: ' + method));
      }, 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Fixture ready timeout')), 30000).unref()
      )
    ]);
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['metadataOnboardingSeen', true],
      ['motionLevel', 'low'],
      ['sidebarMode', 'expanded']
    ])
      await call('settings', { key, value });
    const scanned = await call('scan', { path: collection, offline: true, onlineMatch: false });
    assert.equal(scanned.errors, 0);
    for (const file of initialFiles) await call('mediaInfo', { id: idFor(file) });
    await call('setCover', { id: idFor(alpha), imageId: idFor(initialFiles[0]) });
    await call('patch', {
      id: idFor(alpha),
      changes: { favorite: 1, confirmed: 1, crop_x: 23, crop_y: 67, crop_zoom: 1.2 }
    });
    await call('patch', { id: idFor(initialFiles[0]), changes: { favorite: 1, confirmed: 1 } });
    report.fixture.originalFolder = await call('get', { id: idFor(alpha) });
    report.fixture.originalImage = await call('get', { id: idFor(initialFiles[0]) });
    const added = path.join(alpha, 'resumed-only.png');
    await fs.writeFile(added, png, { flag: 'wx' });
    port1.postMessage('arm');
    await expect
      .poll(() => {
        if (fault) throw fault;
        return gates.has('armed');
      })
      .toBe(true);
    let scanOutcome;
    const interrupted = call('scan', { path: collection, matchNewOnly: true }).then(
      (result) => (scanOutcome = { result }),
      (error) => (scanOutcome = { error })
    );
    await expect
      .poll(
        () => {
          if (fault) throw fault;
          if (scanOutcome?.error) throw scanOutcome.error;
          assert.equal(scanOutcome, undefined, 'Real scan must remain pending at the opendir gate');
          return gates.has('gated');
        },
        { timeout: 30000 }
      )
      .toBe(true);
    report.fixture.savedScanJobs = readFixture(
      'SELECT id,root,path,target,started,state,phase FROM scan_jobs'
    );
    assert.equal(report.fixture.savedScanJobs.length, 1);
    assert.equal(readFixture('SELECT id FROM nodes WHERE path=? AND missing=0', added).length, 0);
    terminatingFixture = true;
    await worker.terminate();
    const interruptedResult = await interrupted;
    assert.equal(interruptedResult.error?.code, 'CHECK120_FIXTURE_TERMINATED');
    report.fixture.interruption = {
      code: interruptedResult.error.code,
      reason: interruptedResult.error.message,
      controlledWorkerTermination: true
    };
    report.fixture.resumeFile = added;
    report.fixture.interruptedRealRefresh = true;
    report.fixture.initialImageCount = initialFiles.length;
  } finally {
    port1.close();
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('Fixture closed'));
    }
    pending.clear();
    await worker.terminate();
  }
}

// This extra session preload observes the original document in its isolated world.
// It never replaces window.album or invokes product actions.
function rendererObserver() {
  const { ipcRenderer } = require('electron');
  const send = (kind, details = {}) =>
    ipcRenderer.send('check-1.2.0:marker', {
      kind,
      wall: Date.now(),
      documentOrigin: performance.timeOrigin,
      href: location.href,
      ...details
    });
  send('document');
  let first = false;
  const observe = () => {
    const card = document.querySelector('#category-overview [data-id],#virtual-grid [data-id]');
    if (!first && card) {
      first = true;
      send('first-card', { id: card.dataset.id, name: card.textContent.trim().slice(0, 160) });
      requestAnimationFrame(() => send('first-card-frame', { id: card.dataset.id }));
    }
  };
  new MutationObserver(observe).observe(document, { childList: true, subtree: true });
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      send('dom-content-loaded');
      observe();
    },
    { once: true }
  );
  window.addEventListener('error', (event) => {
    if (event.message) send('renderer-error', { message: event.message });
  });
  window.addEventListener('unhandledrejection', (event) =>
    send('renderer-error', { message: String(event.reason?.stack || event.reason) })
  );
  observe();
}
function productWorkerObserver() {
  const { workerData, parentPort } = require('node:worker_threads');
  globalThis.fetch = async (input) => {
    parentPort.postMessage({ check120Http: String(input?.url || input) });
    throw new Error('HTTP disabled by isolated 1.2.0 GUI check');
  };
  require(workerData.check120Entry);
}
// Loaded with -r before the real product entry, including packaged entry points.
// The private Playwright loader is the installed version's own ready handshake.
// A missing hook fails explicitly; there is no reload or alternate product fallback.
function mainObserver(config) {
  require(config.loader);
  const electron = require('electron');
  const threads = require('node:worker_threads');
  const path = require('node:path');
  const state = (globalThis.__check120 = {
    installedBeforeReady: !electron.app.isReady(),
    sequence: 0,
    calls: [],
    markers: [],
    events: [],
    remote: [],
    workerCount: 0,
    preloadInstalled: false,
    failures: []
  });
  const record = (target, data) => {
    const row = { sequence: ++state.sequence, time: Date.now(), ...data };
    target.push(row);
    return row;
  };
  const deny = (input) => {
    const url = String(input?.url || input);
    record(state.remote, { url });
    return Promise.reject(new Error('HTTP disabled by isolated 1.2.0 GUI check'));
  };
  globalThis.fetch = deny;
  const localFetch = electron.net.fetch.bind(electron.net);
  electron.net.fetch = (input, ...args) =>
    /^https?:/i.test(String(input?.url || input)) ? deny(input) : localFetch(input, ...args);
  const NativeWorker = threads.Worker;
  threads.Worker = class extends NativeWorker {
    constructor(entry, options = {}) {
      const product = !options.eval && path.basename(String(entry)) === 'library-worker.cjs';
      super(
        product ? config.worker : entry,
        product
          ? { ...options, workerData: { ...options.workerData, check120Entry: String(entry) } }
          : options
      );
      if (!product) return;
      state.workerCount++;
      this.on('message', (message) => {
        if (message.check120Http)
          record(state.remote, { url: message.check120Http, source: 'worker' });
        if (['progress', 'online', 'maintenance', 'ready'].includes(message.event))
          record(state.events, { event: message.event, data: message.data });
      });
      this.on('error', (error) => state.failures.push(error.stack || String(error)));
    }
  };
  electron.ipcMain.on('check-1.2.0:marker', (event, marker) => {
    if (!event.senderFrame?.url?.startsWith('file:') || !marker.href?.startsWith('file:')) return;
    record(state.markers, marker);
    if (marker.kind === 'renderer-error') state.failures.push(marker.message);
  });
  const handle = electron.ipcMain.handle.bind(electron.ipcMain);
  const watched = new Set([
    'init',
    'list',
    'statistics',
    'localIndexStatus',
    'startupResume',
    'rename',
    'refresh',
    'patch'
  ]);
  electron.ipcMain.handle = (channel, handler) =>
    handle(channel, async (event, args) => {
      const method = channel.startsWith('library:') ? channel.slice(8) : '';
      const call = watched.has(method) ? record(state.calls, { method, args }) : null;
      try {
        if (method === 'rename' && globalThis.__check120HoldRename) {
          globalThis.__check120HoldRename = false;
          call.fixtureLatencyGate = true;
          await new Promise((resolve) => {
            globalThis.__check120ReleaseRename = resolve;
          });
        }
        const result = await handler(event, args);
        if (call) {
          call.replySequence = ++state.sequence;
          call.replyTime = Date.now();
          if (method === 'init') call.taskSnapshot = result?.taskSnapshot;
          if (method === 'rename') call.renamed = result?.renamed;
        }
        return result;
      } catch (error) {
        if (call) {
          call.error = error.message || String(error);
          call.replySequence = ++state.sequence;
        }
        throw error;
      }
    });
  electron.app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_e, details) =>
      state.failures.push('Renderer gone: ' + details.reason)
    );
  });
  electron.app
    .whenReady()
    .then(() => {
      const session = electron.session.defaultSession;
      session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          record(state.remote, { url: details.url, source: 'session' });
          callback({ cancel: true });
        }
      );
      if (typeof session.registerPreloadScript === 'function')
        session.registerPreloadScript({ type: 'frame', filePath: config.renderer });
      else session.setPreloads([...session.getPreloads(), config.renderer]);
      state.preloadInstalled = true;
    })
    .catch((error) => state.failures.push(error.stack || String(error)));
}
async function launch() {
  const playwrightRequire = createRequire(
    createRequire(require.resolve('@playwright/test')).resolve('playwright')
  );
  const loader = path.join(
    path.dirname(playwrightRequire.resolve('playwright-core/package.json')),
    'lib/server/electron/loader.js'
  );
  await fs.access(loader);
  const renderer = path.join(run, 'observer-renderer.cjs');
  const worker = path.join(run, 'observer-worker.cjs');
  bootstrap = path.join(run, 'observer-main.cjs');
  await fs.writeFile(renderer, '(' + rendererObserver.toString() + ')();', { flag: 'wx' });
  await fs.writeFile(worker, '(' + productWorkerObserver.toString() + ')();', { flag: 'wx' });
  await fs.writeFile(
    bootstrap,
    '(' + mainObserver.toString() + ')(' + JSON.stringify({ loader, renderer, worker }) + ');',
    { flag: 'wx' }
  );
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const options = {
    args: ['-r', bootstrap, ...(packaged ? [] : [requested])],
    cwd: packaged ? path.dirname(requested) : requested,
    env,
    timeout: 60000
  };
  if (packaged) options.executablePath = requested;
  app = await _electron.launch(options);
  ownedChild = app.process();
  assert.ok(ownedChild?.pid, 'Launch must expose the owned Electron child process');
  report.ownedPid = ownedChild.pid;
  ownedChild.on('error', recordCleanupError);
  report.runtime = await app.evaluate(({ app }) => ({
    appPath: app.getAppPath(),
    executable: process.execPath,
    pid: process.pid,
    creationTimeMs: process.getCreationTime(),
    packaged: app.isPackaged,
    version: app.getVersion(),
    userData: app.getPath('userData'),
    dataDir: process.env.ACG_DATA_DIR
  }));
  assert.ok(Number.isSafeInteger(report.runtime.pid) && report.runtime.pid > 0);
  assert.ok(Number.isFinite(report.runtime.creationTimeMs) && report.runtime.creationTimeMs > 0);
  report.ownedShellPid = ownedChild.pid;
  report.mainIdentity = {
    pid: report.runtime.pid,
    executable: report.runtime.executable,
    creationTimeMs: Math.trunc(report.runtime.creationTimeMs),
    appPath: report.runtime.appPath,
    userData: report.runtime.userData,
    dataDir: report.runtime.dataDir
  };
  assert.equal((await inspectOwnedMain('capture')).state, 'running');
  assert.ok(samePath(report.runtime.userData, path.join(profile, 'chromium-profile')));
  assert.ok(samePath(report.runtime.dataDir, profile));
  assert.ok(
    packaged
      ? samePath(report.runtime.executable, requested)
      : samePath(report.runtime.appPath, requested)
  );
  const initial = await probe();
  assert.equal(initial.installedBeforeReady, true);
  assert.equal(initial.preloadInstalled, true);
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.errors.push(error.stack || String(error)));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.remote.push(route.request().url());
    await route.abort();
  });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setSize(1280, 850);
    win.webContents.setZoomFactor(1);
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.focus();
  });
}
async function settle() {
  await page.waitForFunction(
    () =>
      typeof libraryRefreshBusy !== 'undefined' &&
      !libraryRefreshBusy &&
      !scanActive &&
      !growingTask &&
      growingTimer === null &&
      !growingDirty &&
      grid.loading.size === 0 &&
      !mediaDirty &&
      renamingNodes.size === 0
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
const treeRow = (id) => page.locator('.tree-node[data-node-id="' + id + '"] > .tree-row');
async function openTree(id) {
  const row = treeRow(id);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true')
    await row.locator(':scope > .tree-toggle').click();
}
async function navigateTree(file) {
  await treeRow(idFor(file)).locator(':scope > .category-link').click();
  await page.waitForFunction((id) => S.parent === id && S.current?.id === id, idFor(file));
  await settle();
}
async function contextRename(locator) {
  await locator.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名…', exact: true }).click();
  await expect(page.locator('#modal')).toBeVisible();
  await expect(page.locator('#rename-name')).toBeEditable();
}
async function calls(method) {
  return (await probe()).calls.filter((call) => call.method === method);
}
function preserved(node, original, fields) {
  for (const field of fields)
    assert.equal(node[field], original[field], 'Preserved field: ' + field);
}
async function inspectOwnedMain(action) {
  assert.equal(process.platform, 'win32', 'Owned main identity checks require Windows CIM');
  assert.ok(['capture', 'wait-exit', 'terminate'].includes(action));
  const identity = report.mainIdentity;
  assert.ok(
    identity?.pid && identity.executable && identity.creationTimeMs,
    'A verified main identity is required; never substitute the shell PID'
  );
  const payload = Buffer.from(JSON.stringify({ ...identity, action }), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
$terminated = $false
$killOutput = ''
do {
  $row = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid)
  if ($null -eq $row) {
    @{ state = 'exited'; pid = $expected.pid; terminated = $terminated; killOutput = $killOutput } | ConvertTo-Json -Compress
    exit 0
  }
  $created = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
  if (-not [string]::Equals([string]$row.ExecutablePath, [string]$expected.executable, [StringComparison]::OrdinalIgnoreCase) -or $created -ne [long]$expected.creationTimeMs) {
    throw ('Owned main PID identity changed; refusing to kill: PID={0}, path={1}, creationMs={2}' -f $expected.pid, $row.ExecutablePath, $created)
  }
  if ($expected.action -eq 'capture') {
    @{ state = 'running'; pid = $row.ProcessId; executable = $row.ExecutablePath; creationTimeMs = $created } | ConvertTo-Json -Compress
    exit 0
  }
  if ($expected.action -eq 'terminate' -and -not $terminated) {
    $terminated = $true
    $killOutput = (& "$env:SystemRoot\System32\taskkill.exe" /PID ([string][int]$expected.pid) /T /F 2>&1 | Out-String)
    $killExit = $LASTEXITCODE
    if ($killExit -ne 0 -and (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid))) {
      throw ('Owned main tree termination failed: ' + $killOutput)
    }
  }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
if ($expected.action -eq 'terminate') { throw 'Owned main process remains after verified tree termination' }
@{ state = 'running'; pid = $expected.pid; executable = $row.ExecutablePath; creationTimeMs = $created } | ConvertTo-Json -Compress
`;
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = await new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error('Owned main ' + action + ': ' + (stderr || error.message)));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
        } catch (error) {
          reject(new Error('Invalid owned main identity response: ' + error.message));
        }
      }
    );
  });
  (report.cleanup ||= []).push({
    action,
    identity: { ...identity },
    result,
    at: new Date().toISOString()
  });
  return result;
}
async function closeApp() {
  if (!app) return;
  const owned = app;
  const child = ownedChild;
  app = null;
  ownedChild = null;
  let timer;
  const failures = [];
  try {
    await Promise.race([
      Promise.resolve().then(() => owned.close()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Owned Electron close timeout: main PID ' +
                  report.mainIdentity?.pid +
                  ', shell PID ' +
                  child?.pid
              )
            ),
          15000
        );
      })
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
  }
  try {
    const state = await inspectOwnedMain('wait-exit');
    if (state.state !== 'exited') {
      failures.push(
        new Error('Owned Electron main still running after close: PID ' + report.mainIdentity.pid)
      );
      await inspectOwnedMain('terminate');
    }
  } catch (error) {
    // Identity mismatch is retained as failure; it must never trigger an unverified kill.
    failures.push(error);
  }
  if (child?.pid && child.exitCode === null && child.signalCode === null && !child.killed) {
    try {
      if (!child.kill()) throw new Error('Could not terminate owned shell PID ' + child.pid);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    (report.cleanupFailures ||= []).push({
      identity: report.mainIdentity,
      ownedShellPid: child?.pid,
      errors: failures.map((error) => error.stack || String(error)),
      at: new Date().toISOString()
    });
    throw new AggregateError(failures, 'Owned Electron cleanup failed');
  }
}

(async () => {
  await prepare();
  await launch();
  await check(0, async () => {
    await page.waitForFunction(
      () =>
        typeof startupResumeFinished !== 'undefined' &&
        startupResumeFinished &&
        typeof S !== 'undefined' &&
        S.roots.length === 1
    );
    await expect
      .poll(
        async () =>
          (await probe()).calls.some((call) => call.method === 'statistics' && call.replySequence),
        { timeout: 30000 }
      )
      .toBe(true);
    await settle();
    const log = await probe();
    const documents = log.markers.filter((marker) => marker.kind === 'document');
    const card = log.markers.find((marker) => marker.kind === 'first-card');
    const frame = log.markers.find((marker) => marker.kind === 'first-card-frame');
    const init = log.calls.find((call) => call.method === 'init');
    const resume = log.calls.filter((call) => call.method === 'startupResume');
    const statistics = log.calls.find((call) => call.method === 'statistics');
    assert.equal(documents.length, 1, 'Only original window document, no reload');
    assert.ok(card?.id && frame && init, 'Actual cached card and paint-frame markers must exist');
    assert.equal(init.args.lightweight, true);
    assert.equal(
      init.taskSnapshot?.scan?.jobId,
      report.fixture.savedScanJobs[0].id,
      'Initial lightweight IPC exposes the actual saved scan before resuming'
    );
    assert.notEqual(init.taskSnapshot?.scan?.status, 'idle');
    assert.equal(resume.length, 1);
    assert.ok(
      init.replySequence < card.sequence &&
        card.sequence < frame.sequence &&
        frame.sequence < resume[0].sequence
    );
    assert.ok(
      resume[0].replySequence < statistics.sequence,
      'Optional statistics waits for startupResume response'
    );
    assert.equal(log.workerCount, 1);
    await expect
      .poll(() => readFixture('SELECT id FROM scan_jobs').length, { timeout: 30000 })
      .toBe(0);
    const resumed = await rpc('get', { id: idFor(report.fixture.resumeFile) });
    assert.equal(resumed.path, report.fixture.resumeFile);
    assert.equal((await rpc('get', { id: idFor(collection) })).files, initialFiles.length + 1);
    const resumedLog = await probe();
    assert.ok(
      resumedLog.events.some(
        (event) => event.event === 'progress' && event.sequence > resume[0].sequence
      ),
      'Real resume emitted scan progress'
    );
    assert.deepEqual(resumedLog.remote, []);
    assert.deepEqual(resumedLog.failures, []);
    return {
      timingScope:
        'Original document of a new owned process using a cached generated profile; not a cold OS-cache benchmark',
      init,
      card,
      frame,
      resume: resume[0],
      statistics,
      scanEvents: resumedLog.events.filter((event) => event.event === 'progress'),
      resumedFile: resumed.path,
      documentCount: documents.length
    };
  });
  await check(1, async () => {
    await openTree(idFor(collection));
    await navigateTree(alpha);
    await openTree(idFor(alpha));
    const nested = path.join(alpha, 'Nested');
    await navigateTree(nested);
    const before = await page.evaluate(() => ({
      parent: S.parent,
      current: S.current.path,
      history: S.history.map((entry) => ({ parent: entry.parent, parentPath: entry.parentPath }))
    }));
    const count = (await calls('rename')).length;
    await contextRename(treeRow(idFor(alpha)));
    await page.locator('#rename-name').fill('ExistingAlbum');
    await page.locator('#rename-save').click();
    await expect(page.locator('#rename-error')).not.toHaveText('');
    await expect(page.locator('#rename-error')).toHaveAttribute('role', 'alert');
    await expect(page.locator('#rename-name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#rename-name')).toBeEditable();
    await expect(page.locator('#modal')).toBeVisible();
    assert.equal(await exists(alpha), true);
    assert.equal(await exists(renamedAlpha), false);
    const collisionScreenshot = await screenshot('02-folder-collision-alert');
    await page.locator('#rename-name').fill('AlbumRenamed');
    await page.locator('#rename-save').click();
    await expect(page.locator('#modal')).not.toBeVisible();
    await settle();
    assert.equal(await exists(alpha), false);
    assert.equal(await exists(path.join(renamedAlpha, 'Nested', 'Deep', 'leaf.png')), true);
    const after = await page.evaluate(() => ({
      parent: S.parent,
      current: S.current.path,
      history: S.history.map((entry) => ({ parent: entry.parent, parentPath: entry.parentPath })),
      treeOpen: [...folderTree.open]
    }));
    assert.equal(after.parent, idFor(path.join(renamedAlpha, 'Nested')));
    assert.equal(after.current, path.join(renamedAlpha, 'Nested'));
    assert.ok(
      after.history.some(
        (entry) => entry.parent === idFor(renamedAlpha) && entry.parentPath === renamedAlpha
      )
    );
    assert.ok(
      !after.history.some((entry) => entry.parent === idFor(alpha) || entry.parentPath === alpha)
    );
    assert.ok(
      after.treeOpen.includes(idFor(renamedAlpha)) && !after.treeOpen.includes(idFor(alpha))
    );
    await expect(treeRow(idFor(renamedAlpha))).toBeVisible();
    await expect(page.locator('#footer-location')).toHaveText(path.join(renamedAlpha, 'Nested'));
    await page.locator('#back-button').click();
    await page.waitForFunction(
      (id) => S.parent === id && S.current?.id === id,
      idFor(renamedAlpha)
    );
    await settle();
    const actual = await rpc('get', { id: idFor(renamedAlpha) });
    preserved(actual, report.fixture.originalFolder, [
      'favorite',
      'confirmed',
      'manual_cover',
      'cover_source',
      'crop_x',
      'crop_y',
      'crop_zoom'
    ]);
    assert.equal(actual.cover, idFor(path.join(renamedAlpha, 'keep.png')));
    const recorded = (await calls('rename')).slice(count);
    assert.equal(recorded.length, 2);
    assert.ok(recorded[0].error && recorded[1].renamed);
    return {
      before,
      after,
      originalPath: alpha,
      actualPath: actual.path,
      preserved: {
        favorite: actual.favorite,
        confirmed: actual.confirmed,
        manual_cover: actual.manual_cover,
        cover: actual.cover
      },
      collisionScreenshot,
      calls: recorded
    };
  });
  await check(2, async () => {
    const oldFile = path.join(renamedAlpha, 'keep.png');
    const newFile = path.join(renamedAlpha, 'ImageRenamed.png');
    const card = () => page.locator('#virtual-grid [data-id="' + idFor(oldFile) + '"]');
    const count = (await calls('rename')).length;
    await contextRename(card());
    await expect(page.locator('#rename-name')).toHaveValue('keep');
    await expect(page.locator('#rename-extension')).toHaveText('.png');
    await page.locator('#rename-name').fill('EscapeMustNotRename');
    await page.keyboard.press('Escape');
    await expect(page.locator('#modal')).not.toBeVisible();
    assert.equal((await calls('rename')).length, count);
    assert.equal(await exists(oldFile), true);
    await contextRename(card());
    await page.locator('#rename-name').fill('collision');
    await page.locator('#rename-save').click();
    await expect(page.locator('#rename-error')).not.toHaveText('');
    await expect(page.locator('#rename-name')).toBeEditable();
    assert.equal(await exists(oldFile), true);
    const collisionScreenshot = await screenshot('03-image-collision-alert');
    await page.locator('#rename-name').fill('ImageRenamed');
    // Hold only this real handler's entry to make the pending UI boundary observable.
    // Releasing it still invokes the untouched handler and real filesystem rename.
    await app.evaluate(() => {
      globalThis.__check120HoldRename = true;
    });
    const bounds = await page.locator('#rename-save').boundingBox();
    assert.ok(bounds);
    await page.locator('#rename-save').click();
    await expect(page.locator('#rename-save')).toBeDisabled();
    await expect(page.locator('#rename-save')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#rename-name')).toBeDisabled();
    await page.mouse.dblclick(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
      delay: 10
    });
    assert.equal(
      (await calls('rename')).length,
      count + 2,
      'Repeated native clicks while pending send no extra IPC'
    );
    await app.evaluate(() => {
      if (!globalThis.__check120ReleaseRename)
        throw new Error('Real rename handler did not reach fixture latency gate');
      globalThis.__check120ReleaseRename();
      delete globalThis.__check120ReleaseRename;
    });
    await expect(page.locator('#modal')).not.toBeVisible();
    await settle();
    assert.equal(await exists(oldFile), false);
    assert.equal(await exists(newFile), true);
    assert.equal(await exists(newFile + '.png'), false);
    assert.equal(
      readFixture('SELECT id FROM nodes WHERE id=? AND missing=0', idFor(oldFile)).length,
      0
    );
    const actual = await rpc('get', { id: idFor(newFile) });
    preserved(actual, report.fixture.originalImage, ['favorite', 'confirmed']);
    assert.equal((await rpc('get', { id: idFor(renamedAlpha) })).cover, actual.id);
    await expect(page.locator('#virtual-grid [data-id="' + actual.id + '"]')).toBeVisible();
    const recorded = (await calls('rename')).slice(count);
    assert.equal(
      recorded.length,
      2,
      'One collision request and one corrected request, no Escape or duplicate request'
    );
    assert.ok(recorded[0].error && recorded[1].renamed);
    return {
      oldFile,
      newFile,
      extension: '.png',
      favorite: actual.favorite,
      confirmed: actual.confirmed,
      manualCoverTracksRenamedImage: true,
      collisionScreenshot,
      calls: recorded
    };
  });
  await check(3, async () => {
    const deep = path.join(renamedAlpha, 'Nested', 'Deep');
    const oldFile = path.join(deep, 'leaf.png');
    const newFile = path.join(deep, 'deep-renamed.png');
    const removed = path.join(deep, 'delete.png');
    for (const file of [oldFile, newFile, removed]) assert.ok(inside(run, file));
    assert.equal(await exists(oldFile), true);
    assert.equal(await exists(removed), true);
    await fs.rename(oldFile, newFile);
    await fs.unlink(removed);
    const before = (await calls('refresh')).length;
    await settle();
    // Keyboard opens the actual blank-area menu without hit-testing a card as blank.
    await page.locator('#viewport').focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: '刷新当前页面', exact: true }).click();
    await expect
      .poll(async () => (await calls('refresh')).length, { timeout: 30000 })
      .toBe(before + 1);
    await expect
      .poll(async () => (await calls('refresh')).at(-1)?.replySequence, { timeout: 30000 })
      .toBeTruthy();
    await settle();
    const refresh = (await calls('refresh')).at(-1);
    assert.equal(refresh.args.id, idFor(renamedAlpha));
    assert.equal(refresh.error, undefined);
    assert.equal(
      readFixture(
        'SELECT id FROM nodes WHERE id IN (?,?) AND missing=0',
        idFor(oldFile),
        idFor(removed)
      ).length,
      0
    );
    const actual = await rpc('get', { id: idFor(newFile) });
    assert.equal(actual.path, newFile);
    assert.equal((await rpc('get', { id: idFor(deep) })).files, 1);
    await openTree(idFor(renamedAlpha));
    await openTree(idFor(path.join(renamedAlpha, 'Nested')));
    await navigateTree(deep);
    await expect(page.locator('#virtual-grid [data-id="' + actual.id + '"]')).toBeVisible();
    await expect(page.locator('#virtual-grid [data-id="' + idFor(removed) + '"]')).toHaveCount(0);
    await expect(page.locator('#footer-location')).toHaveText(deep);
    return {
      refreshedParent: renamedAlpha,
      actualDeepPath: actual.path,
      removed,
      refresh,
      actualFiles: 1
    };
  });
  const final = await probe();
  report.observation = final;
  report.remote.push(...final.remote.map((entry) => entry.url));
  report.errors.push(...final.failures);
  assert.equal(final.markers.filter((marker) => marker.kind === 'document').length, 1);
  assert.deepEqual(report.remote, [], 'No remote request may escape the HTTP traps');
  assert.deepEqual(report.errors, []);
  report.passed = report.checks.every((row) => row.passed);
})()
  .catch((error) => {
    report.errors.push(error.stack || String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) {
      await probe()
        .then((value) => {
          report.observation = value;
        })
        .catch(() => {});
      await closeApp().catch((error) => {
        report.passed = false;
        report.errors.push(error.stack || String(error));
        process.exitCode = 1;
      });
    }
    report.finished = new Date().toISOString();
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('REPORT ' + file);
    } else console.log(JSON.stringify(report, null, 2));
  });
