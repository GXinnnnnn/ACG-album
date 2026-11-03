'use strict';
// Prepared for the Lead's explicit serial source/local/full/fixed command-line runs.
// node scripts/check-external-sync.cjs
// ACG_ELECTRON_EXE=<actual packaged exe>, or ACG_APP_PATH=<source directory>.
// ACG_CHECK_STAGE=<physical evidence parent>. No reload or checker-driven refresh/sync RPC.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const project = path.resolve(__dirname, '..');
const requested = path.resolve(
  process.env.ACG_ELECTRON_EXE || process.env.ACG_APP_PATH || process.env.ACG_EXECUTABLE || project
);
const packaged = /\.exe$/i.test(requested);
const stage = path.resolve(process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\external-sync');
const subjectId = 940024;
const names = [
  'original document and cached fixture resume filesystem watching through the product handshake',
  'native external additions reach SQLite, changed event, real list response and folder/image DOM',
  'native external deletions remove folder and image DOM without scan or refresh RPC',
  'external parent identity rename remaps an open descendant, history, tree and manual association',
  'Windows case-only parent rename keeps IDs and updates descendant paths and navigation',
  'external folder and image changes while viewer is open flush structure after native close'
];
const report = {
  passed: false,
  started: new Date().toISOString(),
  requested,
  packaged,
  scope:
    'Real Electron external filesystem synchronization, isolated generated profile and 8px PNG collection. Native fs writes affect only generated fixtures. The live GUI checks do not call scan/refresh/filesystemSync/rename RPCs or reload; real product browse/focus scheduling is preserved and recorded separately where observable. No personal data, user originals, deployment or network metadata. A closed fixture is prepared offline before timing-free GUI checks.',
  networkBoundary:
    'Preparation worker fetch is denied. Actual GUI uses autoMatch=false, offline root policy, empty generated credentials and queues, missing local index, then main fetch/session and renderer HTTP denial. The existing live worker fetch is not patched; this is not OS network isolation or a startup network timing assertion.',
  checks: names.map((name) => ({ name, passed: false, status: 'not-run' })),
  records: [],
  screenshots: [],
  errors: [],
  remote: [],
  cleanup: []
};
let run, profile, collection, parent, nested, png, app, ownedChild, page;
let mainInstalled = false,
  rendererInstalled = false,
  closeRequested = false;
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (base, file) => {
  const p = path.relative(base, file);
  return !!p && !p.startsWith('..') && !path.isAbsolute(p);
};
function failure(error) {
  report.passed = false;
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
}
async function noLinks(file) {
  let cursor = path.resolve(file);
  while (true) {
    const s = await fs.lstat(cursor);
    assert.equal(s.isSymbolicLink(), false, 'No linked fixture/evidence ancestors: ' + cursor);
    const next = path.dirname(cursor);
    if (next === cursor) return;
    cursor = next;
  }
}
async function generated(file, existing = true) {
  const target = path.resolve(file);
  assert.ok(
    inside(collection, target),
    'Mutation must be inside this generated collection: ' + target
  );
  await noLinks(existing ? target : path.dirname(target));
  return target;
}
async function writePng(file) {
  await generated(file, false);
  await fs.writeFile(file, png, { flag: 'wx' });
}
async function removeFile(file) {
  await generated(file);
  assert.ok((await fs.lstat(file)).isFile());
  await fs.unlink(file);
}
async function removeEmptyDirectory(file) {
  await generated(file);
  assert.deepEqual(await fs.readdir(file), []);
  await fs.rmdir(file);
}
async function moveDirectory(from, to) {
  await generated(from);
  await generated(to, false);
  assert.ok((await fs.lstat(from)).isDirectory());
  await fs.rename(from, to);
}
function readRows(sql, ...args) {
  assert.ok(inside(run, profile));
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'), { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
}
const dbNode = (file) => readRows('SELECT * FROM nodes WHERE id=?', idFor(file))[0] || null;
const present = (file) => {
  const n = dbNode(file);
  return !!n && !n.missing && n.path === file;
};
const absent = (file) => !dbNode(file) || !!dbNode(file).missing;
async function dbWait(predicate) {
  await expect.poll(predicate, { timeout: 30000, intervals: [50, 100, 200, 400] }).toBe(true);
}
const mainProbe = () => app.evaluate(() => globalThis.__externalSyncMain);
const rendererProbe = () => page.evaluate(() => window.__externalSyncRenderer);
async function marks(label) {
  const main = await mainProbe(),
    renderer = await rendererProbe();
  const row = { label, at: Date.now(), call: main.calls.length, event: renderer.events.length };
  report.records.push({ kind: 'before-native-mutation', ...row });
  return row;
}
async function changedAfter(mark, renamePath = null, caseOnly = false) {
  await expect
    .poll(
      async () => {
        const { events } = await rendererProbe();
        return events
          .slice(mark.event)
          .some(
            (e) =>
              e.type === 'changed' &&
              e.data?.root === idFor(collection) &&
              Number.isFinite(e.data.revision) &&
              (!renamePath ||
                e.data.renames?.some(
                  (r) =>
                    r.external === true &&
                    r.renamed === true &&
                    r.path === renamePath &&
                    (!caseOnly || r.caseOnly === true)
                ))
          );
      },
      { timeout: 30000, intervals: [50, 100, 200, 400] }
    )
    .toBe(true);
}
async function settle() {
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      !libraryRefreshBusy &&
      !scanActive &&
      !growingTask &&
      growingTimer === null &&
      !growingDirty &&
      !grid.loading.size &&
      !mediaDirty &&
      !renamingNodes.size &&
      !folderTree.loading.size &&
      (typeof structuralTask === 'undefined' || !structuralTask) &&
      (typeof structuralDirty === 'undefined' || !structuralDirty)
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function uiSnapshot() {
  return page.evaluate(() => ({
    parent: S.parent,
    current: S.current && {
      id: S.current.id,
      path: S.current.path,
      name: S.current.name,
      subject_id: S.current.subject_id
    },
    roots: S.roots.map((n) => ({ id: n.id, path: n.path })),
    history: S.history.map((n) => ({ ...n })),
    footer: document.querySelector('#footer-location')?.textContent,
    cards: [...document.querySelectorAll('#virtual-grid .album-card[data-id]')].map((el) => ({
      id: el.dataset.id,
      title: el.title,
      text: el.textContent,
      connected: el.isConnected
    })),
    items: [...grid.items.values()].map((n) => ({
      id: n.id,
      path: n.path,
      parent: n.parent,
      kind: n.kind
    })),
    tree: [...folderTree.openNodes.values()].map((n) => ({ id: n.id, path: n.path })),
    treeRows: [...document.querySelectorAll('.tree-node[data-node-id]')].map((el) => ({
      id: el.dataset.nodeId,
      text: el.querySelector(':scope > .tree-row')?.textContent
    })),
    scrollKeys: [...S.scrolls.keys()],
    viewer: document.querySelector('#viewer').open,
    structuralDirty: typeof structuralDirty !== 'undefined' && structuralDirty,
    timeOrigin: performance.timeOrigin
  }));
}
async function domWait(parentPath, included, excluded = []) {
  await page.waitForFunction(
    ({ parentId, included, excluded }) => {
      const ids = new Set(
        [...document.querySelectorAll('#virtual-grid .album-card[data-id]')].map(
          (el) => el.dataset.id
        )
      );
      return (
        S.parent === parentId &&
        S.current?.id === parentId &&
        included.every((id) => ids.has(id)) &&
        excluded.every((id) => !ids.has(id))
      );
    },
    { parentId: idFor(parentPath), included: included.map(idFor), excluded: excluded.map(idFor) }
  );
  await settle();
}
async function listEvidence(mark, parentPath, included, excluded = []) {
  const matches = (await mainProbe()).calls
    .slice(mark.call)
    .filter(
      (c) =>
        c.method === 'list' &&
        c.done &&
        !c.error &&
        c.args.parent === idFor(parentPath) &&
        c.args.filter !== 'folders' &&
        c.args.limit !== 1 &&
        Array.isArray(c.items)
    );
  const row = matches.findLast(
    (c) =>
      included.every((f) => c.items.some((n) => n.id === idFor(f) && n.path === f)) &&
      excluded.every((f) => !c.items.some((n) => n.id === idFor(f)))
  );
  assert.ok(row, 'Actual UI list response must contain the new structure, without a test list RPC');
  return row;
}
async function evidence(mark, parentPath, included, excluded = []) {
  await changedAfter(mark);
  await domWait(parentPath, included, excluded);
  const renderer = await rendererProbe();
  return {
    nativeAt: mark.at,
    database: { included: included.map(dbNode), excluded: excluded.map(dbNode) },
    changed: renderer.events.slice(mark.event).filter((e) => e.type === 'changed'),
    watch: renderer.events.slice(mark.event).filter((e) => e.type === 'watch'),
    list: await listEvidence(mark, parentPath, included, excluded),
    dom: await uiSnapshot()
  };
}
async function nativeClick(locator) {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  const b = await locator.boundingBox();
  assert.ok(b && b.width > 0 && b.height > 0);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}
const card = (file) => page.locator('#virtual-grid .album-card[data-id="' + idFor(file) + '"]');
const treeRow = (file) =>
  page.locator('.tree-node[data-node-id="' + idFor(file) + '"] > .tree-row');
async function expandTree(file) {
  const row = treeRow(file);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true')
    await nativeClick(row.locator(':scope > .tree-toggle'));
  await page.waitForFunction(
    (id) => folderTree.open.has(id) && !folderTree.loading.has(id),
    idFor(file)
  );
}
async function openRoot() {
  await nativeClick(treeRow(collection).locator(':scope > .category-link'));
  await domWait(collection, [parent, path.join(collection, 'keep-root.png')]);
}
async function check(index, body) {
  const row = report.checks[index];
  row.status = 'running';
  try {
    row.details = await body();
    row.passed = true;
    row.status = 'passed';
    console.log('PASS ' + row.name);
  } catch (error) {
    row.status = 'failed';
    row.error = error.stack || String(error);
    throw error;
  }
}
function preserve(actual, expected, fields) {
  assert.ok(actual);
  for (const field of fields) assert.deepEqual(actual[field], expected[field], 'Preserve ' + field);
}
function fixtureEntry() {
  const { parentPort, workerData } = require('node:worker_threads');
  globalThis.fetch = async (input) => {
    parentPort.postMessage({ checkHttp: String(input?.url || input) });
    throw new Error('External-sync preparation HTTP denied');
  };
  require(workerData.entry);
}
async function prepare() {
  assert.equal(process.platform, 'win32', 'This checker includes real Windows case-only rename');
  for (const protectedPath of [
    project,
    'C:\\ACG\\.review-data',
    'C:\\ACG\\当前版本',
    'C:\\ACG\\安装包',
    'C:\\ACG\\资料归档\\local-index-pilot-2026-10-20'
  ])
    assert.ok(
      !samePath(stage, protectedPath) && !inside(protectedPath, stage),
      'Protected evidence parent'
    );
  await fs.mkdir(stage, { recursive: true });
  await noLinks(stage);
  run = path.join(
    await fs.realpath(stage),
    'external-sync-' +
      (packaged ? 'packaged-' : 'source-') +
      new Date().toISOString().replaceAll(':', '-') +
      '-' +
      randomUUID()
  );
  await fs.mkdir(run);
  profile = path.join(run, 'generated-profile');
  collection = path.join(run, 'generated-collection');
  await fs.mkdir(collection);
  parent = path.join(collection, 'ParentAlbum');
  nested = path.join(parent, 'NestedOpen');
  Object.assign(report, {
    run,
    profile,
    collection,
    fixture: { profile, collection, pixels: [8, 8], subjectId, offlinePreparation: true },
    cleanupOwnership: {
      generated: [profile, collection],
      preserve: ['report.json', 'external-sync.png']
    }
  });
  console.log('ISOLATED ' + run);
  png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#8facc2' } })
    .png()
    .toBuffer();
  const initial = [
    path.join(nested, 'keep.png'),
    path.join(nested, 'remove-in-viewer.png'),
    path.join(parent, 'parent.png'),
    path.join(collection, 'DeleteFolder', 'delete-child.png'),
    path.join(collection, 'delete-image.png'),
    path.join(collection, 'keep-root.png')
  ];
  for (const file of initial) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writePng(file);
  }
  const worker = new Worker('(' + fixtureEntry.toString() + ')();', {
    eval: true,
    workerData: {
      dataDir: profile,
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite'),
      entry: path.join(project, 'src/library-worker.cjs')
    },
    env: {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
    }
  });
  let sequence = 0,
    fault;
  const pending = new Map();
  const fail = (error) => {
    fault = error;
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
  };
  let readyTimer;
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Fixture ready timeout')), 30000);
    worker.on('error', (error) => {
      fail(error);
      reject(error);
    });
    worker.on('message', (message) => {
      if (message.checkHttp) {
        report.remote.push(message.checkHttp);
        fail(new Error('Fixture attempted HTTP'));
        return;
      }
      if (message.event === 'ready') {
        clearTimeout(readyTimer);
        resolve();
      }
      const task = pending.get(message.request);
      if (!task) return;
      clearTimeout(task.timer);
      pending.delete(message.request);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
    });
    worker.on('exit', (code) => {
      if (pending.size) fail(new Error('Fixture exited: ' + code));
    });
  });
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
    await ready;
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
    for (const file of initial) await call('mediaInfo', { id: idFor(file) });
    await call('setCover', { id: idFor(parent), imageId: idFor(path.join(parent, 'parent.png')) });
    await call('patch', {
      id: idFor(parent),
      changes: { favorite: 1, confirmed: 1, crop_x: 23, crop_y: 67, crop_zoom: 1.2 }
    });
    await call('patch', {
      id: idFor(path.join(nested, 'keep.png')),
      changes: { favorite: 1, confirmed: 1, crop_x: 31, crop_y: 59 }
    });
    await call('shutdown');
  } finally {
    clearTimeout(readyTimer);
    await worker.terminate();
  }
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'));
  try {
    const metadata = {
      id: subjectId,
      type: 2,
      name: 'External sync fixture association',
      name_cn: '外部变更隔离关联',
      summary: 'Generated local association; no transport or network is being tested.',
      rating: { score: 8.2 }
    };
    db.prepare('INSERT OR REPLACE INTO metadata(id,json,updated) VALUES(?,?,?)').run(
      subjectId,
      JSON.stringify(metadata),
      Date.now()
    );
    db.prepare('UPDATE nodes SET subject_id=?,manual_subject=1,intro=1 WHERE id=?').run(
      subjectId,
      idFor(parent)
    );
    db.prepare('UPDATE root_match_policy SET enabled=0,auto_enabled=0').run();
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
      'watchChanges',
      JSON.stringify(true)
    );
    for (const table of ['scan_jobs', 'match_pending', 'match_frontier', 'root_removals'])
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM ' + table).get().n,
        0,
        'No pending preparation ' + table
      );
  } finally {
    db.close();
  }
  report.fixture.originalParent = dbNode(parent);
  report.fixture.originalImage = dbNode(path.join(nested, 'keep.png'));
  assert.ok(
    report.fixture.originalParent.fs_identity,
    'Fixture must have real filesystem move identity'
  );
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  const options = {
    args: packaged ? [] : [requested],
    cwd: packaged ? path.dirname(requested) : requested,
    env,
    timeout: 60000
  };
  if (packaged) options.executablePath = requested;
  app = await _electron.launch(options);
  ownedChild = app.process();
  assert.ok(ownedChild?.pid);
  report.ownedShellPid = ownedChild.pid;
  ownedChild.on('error', failure);
  report.runtime = await app.evaluate(
    ({ app, ipcMain, net, session, BrowserWindow }, allowedBrowseIds) => {
      const state = (globalThis.__externalSyncMain = {
        calls: [],
        remote: [],
        denied: [],
        windowEvents: [],
        hookedChannels: [],
        overflow: false
      });
      const add = (array, row) => {
        if (array.length >= 2000) {
          state.overflow = true;
          throw new Error('External-sync observer cap exceeded');
        }
        array.push(row);
        return row;
      };
      const forbidden = new Set([
        'scan',
        'refresh',
        'rename',
        'import',
        'demo',
        'sync',
        'syncRoot',
        'syncAll',
        'bind',
        'reimport',
        'removeRoot'
      ]);
      const browseIds = new Set(allowedBrowseIds);
      const nativeHandle = ipcMain.handle.bind(ipcMain);
      const wrappedHandlers = new WeakSet();
      const wrapHandler = (channel, original) => {
        if (!channel.startsWith('library:') || wrappedHandlers.has(original)) return original;
        const method = channel.slice(8);
        const observed = async (event, args) => {
          const row = add(state.calls, { method, args: args || {}, started: Date.now() });
          if (
            forbidden.has(method) ||
            (method === 'filesystemSync' &&
              (args?.reason !== 'browse' ||
                !browseIds.has(args.id) ||
                Object.keys(args).some((key) => !['reason', 'id'].includes(key))))
          ) {
            row.error = 'Forbidden checker/UI RPC';
            add(state.denied, { method, args });
            throw new Error('External-sync checker forbids ' + method);
          }
          if (method === 'filesystemSync') row.source = 'product-native-browse';
          try {
            const result = await original(event, args);
            row.done = Date.now();
            if (method === 'list') {
              row.total = result?.total;
              row.folders = result?.folders;
              row.items = result?.items?.map((n) => ({
                id: n.id,
                path: n.path,
                kind: n.kind,
                parent: n.parent,
                name: n.name
              }));
            }
            return result;
          } catch (error) {
            row.done = Date.now();
            row.error = error.message;
            throw error;
          }
        };
        wrappedHandlers.add(observed);
        if (!state.hookedChannels.includes(channel)) state.hookedChannels.push(channel);
        return observed;
      };
      ipcMain.handle = (channel, original) => nativeHandle(channel, wrapHandler(channel, original));
      for (const [channel, original] of [...ipcMain._invokeHandlers]) {
        if (!channel.startsWith('library:')) continue;
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
      }
      const blocked = (input) => {
        const url = String(input?.url || input);
        add(state.remote, { url, at: Date.now() });
        throw new Error('External-sync HTTP denied: ' + url);
      };
      const nativeFetch = net.fetch.bind(net);
      net.fetch = (input, ...args) =>
        /^https?:/i.test(String(input?.url || input))
          ? blocked(input)
          : nativeFetch(input, ...args);
      globalThis.fetch = async (input) => blocked(input);
      for (const current of new Set([
        session.defaultSession,
        ...BrowserWindow.getAllWindows().map((w) => w.webContents.session)
      ]))
        current.webRequest.onBeforeRequest(
          { urls: ['http://*/*', 'https://*/*'] },
          (details, callback) => {
            add(state.remote, { url: details.url, at: Date.now() });
            callback({ cancel: true });
          }
        );
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        for (const type of ['focus', 'blur', 'show', 'restore', 'hide', 'minimize'])
          win.on(type, () =>
            add(state.windowEvents, {
              type,
              at: Date.now(),
              note: 'Product may schedule its own focus/show/restore catch-up; not a checker sync call.'
            })
          );
        if (win.isMaximized()) win.unmaximize();
        win.setSize(1320, 900);
        win.webContents.setZoomFactor(1);
        win.webContents.setBackgroundThrottling(false);
        win.show();
        win.focus();
      }
      return {
        appPath: app.getAppPath(),
        executable: process.execPath,
        pid: process.pid,
        creationTimeMs: process.getCreationTime(),
        version: app.getVersion(),
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        dataDir: process.env.ACG_DATA_DIR
      };
    },
    [
      collection,
      parent,
      nested,
      path.join(collection, 'ParentRenamed'),
      path.join(collection, 'ParentRenamed', 'NestedOpen')
    ].map(idFor)
  );
  mainInstalled = true;
  report.mainIdentity = {
    pid: report.runtime.pid,
    executable: report.runtime.executable,
    creationTimeMs: Math.trunc(report.runtime.creationTimeMs)
  };
  assert.ok(
    samePath(report.runtime.dataDir, profile) &&
      samePath(report.runtime.userData, path.join(profile, 'chromium-profile'))
  );
  assert.ok(
    packaged
      ? samePath(report.runtime.executable, requested)
      : samePath(report.runtime.appPath, requested)
  );
  assert.equal((await inspectOwnedMain('capture')).state, 'running');
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', failure);
  await app.context().route(/^https?:\/\//, async (route) => {
    report.remote.push(route.request().url());
    await route.abort();
  });
  await page.waitForFunction(
    () => typeof S !== 'undefined' && typeof grid !== 'undefined' && window.album
  );
  report.hookedChannels = (await mainProbe()).hookedChannels;
  assert.ok(
    report.hookedChannels.includes('library:init') &&
      report.hookedChannels.includes('library:list'),
    'External-sync observer must hook library:init and library:list before business checks'
  );
  await page.evaluate(() => {
    const state = (window.__externalSyncRenderer = {
      origin: performance.timeOrigin,
      events: [],
      overflow: false,
      rejections: []
    });
    window.addEventListener('unhandledrejection', (e) => state.rejections.push(String(e.reason)));
    window.album.onEvent((event) => {
      if (!['changed', 'watch', 'progress', 'tasks', 'online', 'error'].includes(event.type))
        return;
      if (state.events.length >= 2000) {
        state.overflow = true;
        return;
      }
      state.events.push({ type: event.type, data: event.data, at: Date.now() });
    });
  });
  rendererInstalled = true;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && !closeRequested)
      failure(
        new Error('Main document navigated after observer installation; reload is forbidden')
      );
  });
}
async function inspectOwnedMain(action) {
  const identity = report.mainIdentity;
  assert.ok(identity?.pid && identity.executable && identity.creationTimeMs);
  const payload = Buffer.from(JSON.stringify({ ...identity, action }), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$deadline = [DateTime]::UtcNow.AddMilliseconds(3000)
$terminated = $false
do {
  $row = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid)
  if ($null -eq $row) { @{state='exited';pid=$expected.pid;terminated=$terminated} | ConvertTo-Json -Compress; exit 0 }
  $created = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
  if (-not [string]::Equals([string]$row.ExecutablePath,[string]$expected.executable,[StringComparison]::OrdinalIgnoreCase) -or $created -ne [long]$expected.creationTimeMs) { throw 'Owned main identity changed; refusing termination' }
  if ($expected.action -eq 'capture') { @{state='running';pid=$row.ProcessId;creationTimeMs=$created} | ConvertTo-Json -Compress; exit 0 }
  if ($expected.action -eq 'terminate' -and -not $terminated) {
    $terminated=$true
    $result = (& "$env:SystemRoot\System32\taskkill.exe" /PID ([string][int]$expected.pid) /T /F 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -and (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid))) { throw ('Owned termination failed: '+$result) }
  }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
if ($expected.action -eq 'terminate') { throw 'Owned main remains after termination' }
@{state='running';pid=$expected.pid} | ConvertTo-Json -Compress
`;
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = await new Promise((resolve, reject) =>
    execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error('Owned main ' + action + ': ' + (stderr || error.message)));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
        } catch (e) {
          reject(e);
        }
      }
    )
  );
  report.cleanup.push({ action, identity, result, at: new Date().toISOString() });
  return result;
}
async function closeApp() {
  if (!app) return;
  closeRequested = true;
  const owned = app,
    child = ownedChild;
  app = null;
  ownedChild = null;
  const failures = [];
  let timer;
  try {
    await Promise.race([
      owned.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron close timeout')), 15000);
      })
    ]);
  } catch (error) {
    failures.push(error);
  } finally {
    clearTimeout(timer);
  }
  if (report.mainIdentity) {
    try {
      if ((await inspectOwnedMain('wait-exit')).state !== 'exited') {
        failures.push(new Error('Owned main did not exit normally'));
        await inspectOwnedMain('terminate');
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (child && child.exitCode === null && child.signalCode === null && !child.killed) {
    try {
      assert.ok(child.kill());
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'External-sync owned cleanup failed');
}
(async () => {
  await prepare();
  await launch();
  await check(0, async () => {
    await page.waitForFunction(
      () =>
        typeof startupResumeFinished !== 'undefined' &&
        startupResumeFinished &&
        S.roots.length === 1 &&
        !startupResumeError
    );
    await settle();
    assert.equal(await page.evaluate(() => S.settings.watchChanges), true);
    assert.equal(await page.evaluate(() => S.settings.autoMatch), false);
    await openRoot();
    await expandTree(collection);
    return {
      dom: await uiSnapshot(),
      settings: readRows(
        'SELECT key,value FROM settings WHERE key IN (?,?)',
        'watchChanges',
        'autoMatch'
      ),
      rootPolicy: readRows('SELECT * FROM root_match_policy'),
      handoff: 'Product original-document startupResume handshake; the checker did not invoke it.'
    };
  });
  const addedFolder = path.join(collection, 'ExternalAdded'),
    addedImage = path.join(collection, 'external-added.png');
  await check(1, async () => {
    const mark = await marks('add-folder-and-image');
    await generated(addedFolder, false);
    await fs.mkdir(addedFolder);
    await writePng(path.join(addedFolder, 'new-child.png'));
    await writePng(addedImage);
    await dbWait(
      () =>
        present(addedFolder) &&
        present(path.join(addedFolder, 'new-child.png')) &&
        present(addedImage)
    );
    const result = await evidence(mark, collection, [addedFolder, addedImage]);
    await expect(treeRow(addedFolder)).toBeVisible();
    return result;
  });
  await check(2, async () => {
    const removedFolder = path.join(collection, 'DeleteFolder'),
      removedImage = path.join(collection, 'delete-image.png'),
      child = path.join(removedFolder, 'delete-child.png');
    const mark = await marks('delete-folder-and-image');
    await removeFile(child);
    await removeEmptyDirectory(removedFolder);
    await removeFile(removedImage);
    await dbWait(() => absent(removedFolder) && absent(removedImage) && absent(child));
    const result = await evidence(
      mark,
      collection,
      [addedFolder, addedImage],
      [removedFolder, removedImage]
    );
    await expect(treeRow(removedFolder)).toHaveCount(0);
    return result;
  });
  await check(3, async () => {
    await expandTree(parent);
    await nativeClick(card(parent));
    await domWait(parent, [nested]);
    await nativeClick(card(nested));
    await domWait(nested, [path.join(nested, 'keep.png')]);
    const before = await uiSnapshot(),
      oldParent = parent,
      oldNested = nested;
    const next = path.join(collection, 'ParentRenamed'),
      nextNested = path.join(next, 'NestedOpen');
    const mark = await marks('identity-parent-rename-open-descendant');
    await moveDirectory(oldParent, next);
    await dbWait(
      () => present(next) && present(nextNested) && absent(oldParent) && absent(oldNested)
    );
    await changedAfter(mark, next);
    const result = await evidence(
      mark,
      nextNested,
      [path.join(nextNested, 'keep.png')],
      [path.join(oldNested, 'keep.png')]
    );
    const folder = dbNode(next),
      image = dbNode(path.join(nextNested, 'keep.png'));
    preserve(folder, report.fixture.originalParent, [
      'subject_id',
      'manual_subject',
      'manual_cover',
      'cover_source',
      'favorite',
      'confirmed',
      'crop_x',
      'crop_y',
      'crop_zoom'
    ]);
    assert.equal(folder.cover, idFor(path.join(next, 'parent.png')));
    preserve(image, report.fixture.originalImage, ['favorite', 'confirmed', 'crop_x', 'crop_y']);
    assert.equal(result.dom.current.path, nextNested);
    assert.equal(result.dom.footer, nextNested);
    assert.ok(result.dom.history.some((e) => e.parent === idFor(next)));
    assert.ok(
      !result.dom.history.some((e) => [idFor(oldParent), idFor(oldNested)].includes(e.parent))
    );
    assert.ok(!result.dom.tree.some((n) => n.path === oldParent || n.path === oldNested));
    assert.ok(result.dom.tree.some((n) => n.id === idFor(next) && n.path === next));
    const actual = await page.evaluate((id) => window.album.call('get', { id }), idFor(next));
    assert.equal(actual.metadata?.id, subjectId);
    assert.equal(actual.path, next);
    parent = next;
    nested = nextNested;
    return {
      before,
      ...result,
      preservedFolder: folder,
      preservedImage: image,
      hydratedAssociation: actual.metadata
    };
  });
  await check(4, async () => {
    const oldParent = parent,
      oldNested = nested,
      next = path.join(collection, 'PARENTRENAMED'),
      nextNested = path.join(next, 'NestedOpen');
    assert.notEqual(oldParent, next);
    assert.equal(idFor(oldParent), idFor(next));
    const mark = await marks('case-only-parent-rename');
    await moveDirectory(oldParent, next);
    await dbWait(() => present(next) && present(nextNested));
    await changedAfter(mark, next, true);
    const result = await evidence(mark, nextNested, [path.join(nextNested, 'keep.png')]);
    assert.equal(result.dom.current.id, idFor(oldNested));
    assert.equal(result.dom.current.path, nextNested);
    assert.equal(result.dom.footer, nextNested);
    assert.ok(result.dom.history.some((e) => e.parent === idFor(next) && e.parentPath === next));
    assert.ok(!result.dom.tree.some((n) => n.path === oldParent || n.path === oldNested));
    preserve(dbNode(next), report.fixture.originalParent, [
      'subject_id',
      'manual_subject',
      'manual_cover',
      'favorite',
      'confirmed',
      'crop_x',
      'crop_y'
    ]);
    parent = next;
    nested = nextNested;
    return result;
  });
  await check(5, async () => {
    const keep = path.join(nested, 'keep.png'),
      removed = path.join(nested, 'remove-in-viewer.png');
    const newFolder = path.join(nested, 'WhileViewerOpen'),
      newImage = path.join(nested, 'viewer-added.png');
    await nativeClick(card(keep));
    await page.waitForFunction(
      (id) => document.querySelector('#viewer').open && V.node?.id === id,
      idFor(keep)
    );
    await expect(page.locator('#viewer-image')).toBeVisible();
    await page.waitForFunction(
      () =>
        document.querySelector('#viewer-image').complete &&
        document.querySelector('#viewer-image').naturalWidth === 8
    );
    const mark = await marks('external-changes-with-viewer-open');
    await generated(newFolder, false);
    await fs.mkdir(newFolder);
    await writePng(path.join(newFolder, 'child.png'));
    await writePng(newImage);
    await removeFile(removed);
    await dbWait(() => present(newFolder) && present(newImage) && absent(removed));
    await changedAfter(mark);
    assert.equal(await page.evaluate(() => document.querySelector('#viewer').open), true);
    const during = await uiSnapshot();
    const mainDuring = await mainProbe();
    const closeAt = Date.now();
    await nativeClick(page.locator('#viewer-close'));
    await page.waitForFunction(() => !document.querySelector('#viewer').open);
    const result = await evidence(mark, nested, [keep, newFolder, newImage], [removed]);
    assert.ok(
      result.list.done >= closeAt,
      'The structural UI list must finish after native viewer close'
    );
    assert.ok(
      result.list.started >= closeAt,
      'Viewer close must request current structure, not reuse a test list'
    );
    return {
      during,
      listCallsWhileOpen: mainDuring.calls.slice(mark.call).filter((c) => c.method === 'list'),
      closeAt,
      ...result
    };
  });
  const main = await mainProbe(),
    renderer = await rendererProbe();
  report.observation = { main, renderer };
  assert.deepEqual(main.denied, []);
  assert.equal(main.overflow, false);
  assert.equal(renderer.overflow, false);
  assert.deepEqual(main.remote, []);
  assert.deepEqual(report.remote, []);
  assert.deepEqual(renderer.rejections, []);
  assert.ok(!renderer.events.some((e) => e.type === 'error'), 'Worker must emit no error');
  assert.ok(
    !renderer.events.some(
      (e) => e.type === 'online' && (e.data?.active || e.data?.running || e.data?.pending > 0)
    ),
    'No online matching'
  );
  assert.equal(
    await page.evaluate(() => performance.timeOrigin),
    renderer.origin,
    'Original document only'
  );
  assert.ok(!main.calls.some((c) => ['scan', 'refresh', 'rename'].includes(c.method)));
  assert.ok(
    main.calls
      .filter((c) => c.method === 'filesystemSync')
      .every((c) => c.source === 'product-native-browse')
  );
  report.synchronizationBoundary = {
    productBrowseCalls: main.calls.filter((c) => c.method === 'filesystemSync'),
    nativeWindowEvents: main.windowEvents,
    watchEvents: renderer.events.filter((e) => e.type === 'watch'),
    statement:
      'No synthetic sync request or post-mutation navigation/focus is used to push results. Native watch, product browse probes, startup and focus catch-up may overlap; event timing is evidence and does not uniquely attribute every commit to one trigger.'
  };
  assert.deepEqual(report.errors, []);
  const screenshot = path.join(run, 'external-sync.png');
  await page.screenshot({
    path: screenshot,
    clip: { x: 0, y: 0, width: 1000, height: 560 },
    scale: 'css'
  });
  report.screenshots.push(screenshot);
  report.passed = report.checks.every((row) => row.passed);
})()
  .catch(failure)
  .finally(async () => {
    try {
      if (app) {
        if (mainInstalled)
          await mainProbe()
            .then((value) => {
              report.finalMain = value;
            })
            .catch((error) => report.errors.push(error.stack || String(error)));
        if (rendererInstalled)
          await rendererProbe()
            .then((value) => {
              report.finalRenderer = value;
            })
            .catch((error) => report.errors.push(error.stack || String(error)));
        await closeApp().catch(failure);
      }
    } finally {
      report.finished = new Date().toISOString();
      if (report.errors.length) report.passed = false;
      if (!report.passed) process.exitCode = 1;
      if (run) {
        const file = path.join(run, 'report.json');
        await fs.writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
        console.log('REPORT ' + file);
      } else console.log(JSON.stringify(report, null, 2));
    }
  });
