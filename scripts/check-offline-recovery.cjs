'use strict';
// PREPARED ONLY: Lead runs GUI checks serially; adding this file does not run Electron.
// Source: node scripts/check-offline-recovery.cjs (ACG_APP_PATH optionally selects source).
// Packaged/fixed: ACG_ELECTRON_EXE=<exe> or ACG_EXECUTABLE=<exe>.
// ACG_CHECK_STAGE selects a physical evidence parent. All reports are exclusive-create.
// Only native showOpenDialog is substituted, with queued real generated directories.
// Main handlers, preload IPC, worker results, filesystem probes and DB commits stay real.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { _electron, expect } = require('@playwright/test');
const project = path.resolve(__dirname, '..');
const req = createRequire(path.join(project, 'package.json'));
const target = path.resolve(
  process.env.ACG_ELECTRON_EXE || process.env.ACG_EXECUTABLE || process.env.ACG_APP_PATH || project
);
const packaged = /\.exe$/i.test(target);
const executable = packaged ? target : req('electron');
const stage = path.resolve(process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\offline-recovery');
const subjectId = 940122;
const report = {
  passed: false,
  started: new Date().toISOString(),
  target: {
    mode: packaged ? 'packaged' : 'source',
    target,
    executable,
    preparationSource: project
  },
  scope:
    'Real Electron/Playwright, generated profile and PNGs, root availability/retry/relink and folder relink, real GUI import, restart with missing root. No product changes or deployment.',
  boundaries: [
    'Only native dialog.showOpenDialog is replaced: queued existing checker-owned directories are returned. Original main handlers and worker business RPCs/results are always forwarded unchanged.',
    'autoMatch=false, disabled root matching policy and watchChanges=false. Explicit real rootStatus({id,probe:true}) triggers availability detection; native-watch detection is not asserted. Disabling watches prevents an external rename from consuming the relinkFolder scenario first.',
    'Manual association metadata is seeded into the closed generated DB; scan, media preparation, setCover and favorite/crop patch use the real worker. This checks preservation, not the manual-binding network UI.',
    'Preparation worker fetch and GUI main/session/renderer HTTP are denied. The running application worker is unmodified; this is not OS network isolation or a startup network timing guarantee.',
    "fs.rename only touches this run's generated collection to simulate disconnects and renames. Relink must leave its complete filesystem manifest unchanged.",
    'No personal profile, original material or D-drive access. Screenshots are written to disk only; no screenshot readback or encoded image payload is produced.',
    'Graceful close is verified against main executable and birth time. Forced termination is limited to a verified owned process tree and always fails acceptance.'
  ],
  checks: [],
  sessions: [],
  cleanup: [],
  errors: [],
  remote: [],
  screenshots: []
};
let run, profile, collection, chromiumProfile, rootA, rootB, rootNext, disconnected;
let album, nested, importOne, importTwo, app, page, child, sessionRecord;
let closing = false;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (base, file) => {
  const relative = path.relative(base, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const idFor = (file) =>
  crypto.createHash('sha256').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 24);
function fail(error) {
  report.errors.push(error.stack || String(error));
  report.passed = false;
  process.exitCode = 1;
}
async function noLinks(file, allowMissing = false) {
  let cursor = path.resolve(file);
  while (true) {
    try {
      assert.equal(
        (await fs.lstat(cursor)).isSymbolicLink(),
        false,
        'Linked path forbidden: ' + cursor
      );
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
async function ownedPath(file, existing = true) {
  const absolute = path.resolve(file);
  assert.ok(inside(collection, absolute), 'Mutation outside checker-owned collection: ' + absolute);
  await noLinks(existing ? absolute : path.dirname(absolute));
  return absolute;
}
async function moveDirectory(from, to) {
  await ownedPath(from);
  await ownedPath(to, false);
  assert.ok((await fs.lstat(from)).isDirectory());
  await assert.rejects(fs.lstat(to), { code: 'ENOENT' });
  await fs.rename(from, to);
  report.mutations ||= [];
  report.mutations.push({ from, to, operation: 'checker-owned fs.rename', at: Date.now() });
}
async function poll(label, work, accept, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await work();
    if (accept(last)) return last;
    await pause(150);
  } while (Date.now() < deadline);
  throw new Error(label + ' timed out; last=' + JSON.stringify(last));
}
async function check(name, work) {
  const row = { name, passed: false, status: 'running', started: Date.now() };
  report.checks.push(row);
  console.log('CHECK ' + name);
  try {
    row.evidence = await work();
    row.passed = true;
    row.status = 'passed';
    console.log('PASS ' + name);
  } catch (error) {
    row.status = 'failed';
    row.error = error.stack || String(error);
    if (page && !page.isClosed()) row.failureUI = await uiState().catch(String);
    throw error;
  } finally {
    row.finished = Date.now();
  }
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
async function manifest() {
  const rows = [];
  async function walk(directory) {
    await noLinks(directory);
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const file = path.join(directory, entry.name),
        stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.ok(stat.isDirectory() || stat.isFile());
      const row = {
        path: path.relative(collection, file),
        directory: stat.isDirectory(),
        ino: stat.ino,
        mtimeMs: stat.mtimeMs
      };
      if (stat.isFile())
        row.sha256 = crypto
          .createHash('sha256')
          .update(await fs.readFile(file))
          .digest('hex');
      rows.push(row);
      if (stat.isDirectory()) await walk(file);
    }
  }
  await walk(collection);
  return rows;
}
function fixtureEntry() {
  const { parentPort, workerData } = require('node:worker_threads');
  globalThis.fetch = async (input) => {
    parentPort.postMessage({ checkHttp: String(input?.url || input) });
    throw new Error('Offline recovery preparation HTTP denied');
  };
  require(workerData.entry);
}
async function prepare() {
  assert.equal(
    process.platform,
    'win32',
    'This checker verifies Windows launcher/process ownership'
  );
  for (const file of [stage, target, executable])
    assert.ok(!/^d:/i.test(file), 'No D-drive access');
  for (const protectedPath of [
    project,
    'C:\\ACG\\.review-data',
    'C:\\ACG\\当前版本',
    'C:\\ACG\\安装包',
    'C:\\ACG\\资料归档\\local-index-pilot-2026-10-20'
  ])
    assert.ok(
      !samePath(stage, protectedPath) && !inside(protectedPath, stage),
      'Protected stage parent: ' + protectedPath
    );
  await noLinks(stage, true);
  await fs.mkdir(stage, { recursive: true });
  await noLinks(stage);
  // Native decoder cache outputs need compact Windows paths even under an archive stage.
  run = path.join(await fs.realpath(stage), 'or-' + crypto.randomUUID());
  await fs.mkdir(run);
  profile = path.join(run, 'p');
  chromiumProfile = path.join(run, 'cp');
  collection = path.join(run, 'c');
  await fs.mkdir(collection);
  rootA = path.join(collection, 'A-Source');
  rootB = path.join(collection, 'B-Available');
  disconnected = path.join(collection, 'A-Disconnected');
  rootNext = path.join(collection, 'A-Selected-New-Location');
  album = path.join(rootA, 'ManualAlbum');
  nested = path.join(album, 'Nested');
  importOne = path.join(collection, 'C-New-Import');
  importTwo = path.join(collection, 'New-Import-After-Restart');
  Object.assign(report, {
    run,
    fixture: {
      profile,
      chromiumProfile,
      collection,
      rootA,
      rootB,
      album,
      nested,
      importOne,
      importTwo,
      pixels: [8, 8],
      subjectId
    }
  });
  console.log('ISOLATED ' + run);
  const png = await req('sharp')({
    create: { width: 8, height: 8, channels: 3, background: '#68a3b7' }
  })
    .png()
    .toBuffer();
  const images = [
    path.join(rootA, 'root.png'),
    path.join(album, 'cover.png'),
    path.join(nested, 'favorite.png'),
    path.join(rootB, 'BAlbum', 'b.png'),
    path.join(importOne, 'CAlbum', 'c.png'),
    path.join(importTwo, 'DAlbum', 'd.png')
  ];
  for (const file of images) {
    await ownedPath(file, false).catch(async (error) => {
      // New directory chains do not exist yet; validate the existing collection before creating them.
      if (error.code !== 'ENOENT') throw error;
      assert.ok(inside(collection, file));
      await noLinks(collection);
    });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await ownedPath(file, false);
    await fs.writeFile(file, png, { flag: 'wx' });
  }
  const worker = new Worker('(' + fixtureEntry.toString() + ')();', {
    eval: true,
    workerData: {
      entry: path.join(project, 'src/library-worker.cjs'),
      dataDir: profile,
      deferBackground: true,
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite')
    },
    env: {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
    }
  });
  const pending = new Map();
  let serial = 0,
    readyTimer,
    fault,
    stopping = false;
  function rejectPending(error) {
    fault = error;
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Fixture ready timeout')), 30000);
    worker.on('error', (error) => {
      clearTimeout(readyTimer);
      rejectPending(error);
      reject(error);
    });
    worker.on('exit', (code) => {
      clearTimeout(readyTimer);
      if (!stopping) {
        const error = new Error('Unexpected fixture exit: ' + code);
        rejectPending(error);
        reject(error);
      }
    });
    worker.on('message', (message) => {
      if (message.checkHttp) {
        report.remote.push(message.checkHttp);
        rejectPending(new Error('Fixture attempted HTTP'));
        return;
      }
      if (message.event === 'ready') {
        clearTimeout(readyTimer);
        resolve();
      }
      const task = pending.get(message.request);
      if (!task) return;
      pending.delete(message.request);
      message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
    });
  });
  function call(method, args = {}) {
    return new Promise((resolve, reject) => {
      if (fault) return reject(fault);
      const request = ++serial,
        timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Fixture RPC timeout: ' + method));
        }, 45000);
      pending.set(request, {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        }
      });
      worker.postMessage({ request, method, args });
    });
  }
  try {
    await ready;
    for (const [key, value] of Object.entries({
      autoMatch: false,
      watchChanges: false,
      metadataOnboardingSeen: true,
      motionLevel: 'low',
      sidebarMode: 'expanded'
    }))
      await call('settings', { key, value });
    report.fixture.scans = [];
    for (const root of [rootA, rootB]) {
      const scan = await call('scan', { path: root, offline: true, onlineMatch: false });
      assert.equal(scan.errors, 0);
      report.fixture.scans.push(scan);
      const policy = await call('setRootMatchPolicy', {
        id: idFor(root),
        enabled: false,
        onlineMatch: false
      });
      assert.equal(policy.enabled, false);
      assert.equal(policy.onlineMatch, false);
    }
    for (const file of images.filter((file) => inside(rootA, file) || inside(rootB, file)))
      await call('mediaInfo', { id: idFor(file) });
    for (const [folder, image] of [
      [rootA, path.join(rootA, 'root.png')],
      [album, path.join(album, 'cover.png')]
    ]) {
      await call('setCover', { id: idFor(folder), imageId: idFor(image) });
      await call('patch', {
        id: idFor(folder),
        changes: { favorite: 1, confirmed: 1, crop_x: 23, crop_y: 67, crop_zoom: 1.2 }
      });
    }
    await call('patch', {
      id: idFor(path.join(nested, 'favorite.png')),
      changes: { favorite: 1, confirmed: 1, crop_x: 31, crop_y: 59 }
    });
    await call('startupResume');
    let previous = false;
    await poll(
      'fixture real double idle',
      () => call('init', { lightweight: true }),
      (result) => {
        const idle = taskIdle(result.taskSnapshot),
          done = idle && previous;
        previous = idle;
        return done;
      }
    );
    stopping = true;
    await call('shutdown');
  } finally {
    stopping = true;
    clearTimeout(readyTimer);
    await worker.terminate();
  }
  // Closed generated DB only: association fixture, never a business-response substitution.
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'));
  try {
    const metadata = {
      id: subjectId,
      type: 2,
      name: 'Offline recovery fixture',
      name_cn: '离线恢复隔离关联',
      summary: 'Local generated metadata only.',
      rating: { score: 8.2 }
    };
    db.prepare('INSERT OR REPLACE INTO metadata(id,json,updated) VALUES(?,?,?)').run(
      subjectId,
      JSON.stringify(metadata),
      Date.now()
    );
    for (const folder of [rootA, album])
      db.prepare('UPDATE nodes SET subject_id=?,manual_subject=1,intro=1 WHERE id=?').run(
        subjectId,
        idFor(folder)
      );
    db.prepare('UPDATE root_match_policy SET enabled=0,auto_enabled=0').run();
    for (const table of ['scan_jobs', 'match_pending', 'match_frontier', 'root_removals'])
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM ' + table).get().n,
        0,
        'Fixture has no queued ' + table
      );
  } finally {
    db.close();
  }
  report.fixture.originalRoot = dbNode(rootA);
  report.fixture.originalAlbum = dbNode(album);
  report.fixture.originalImage = dbNode(path.join(nested, 'favorite.png'));
  report.fixture.originalRows = readRows(
    'SELECT * FROM nodes WHERE root=? ORDER BY path',
    idFor(rootA)
  );
  return {
    roots: [rootA, rootB],
    nodes: report.fixture.originalRows.length,
    settings: { autoMatch: false, watchChanges: false },
    preparation: 'Real source worker; association seeded only after shutdown'
  };
}
function taskIdle(task) {
  return (
    task?.known === true &&
    task.busy === false &&
    task.scan?.status === 'idle' &&
    task.maintenance?.state === 'ready' &&
    task.matching?.hasWork === false
  );
}
const ipcState = () => app.evaluate(() => globalThis.__offlineRecovery);
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function uiState() {
  return page.evaluate(() => ({
    parent: S.parent,
    current: S.current && { id: S.current.id, path: S.current.path, missing: S.current.missing },
    roots: S.roots.map((n) => ({ id: n.id, path: n.path, rootStatus: n.rootStatus })),
    history: S.history.map((entry) => ({ ...entry })),
    footer: document.querySelector('#footer-location')?.textContent,
    cards: [...document.querySelectorAll('#virtual-grid .album-card[data-id]')].map((el) => ({
      id: el.dataset.id,
      text: el.textContent,
      decoded: !!el.querySelector('img')?.complete && el.querySelector('img').naturalWidth > 0
    })),
    tree: [...document.querySelectorAll('.tree-node[data-node-id]')].map((el) => ({
      id: el.dataset.nodeId,
      text: el.querySelector(':scope > .tree-row')?.textContent
    })),
    notice: {
      hidden: document.querySelector('#source-status')?.hidden,
      text: document.querySelector('#source-status')?.textContent
    },
    importDisabled: document.querySelector('#import-sidebar').disabled,
    rendererTask: startupTaskSnapshot,
    busy: !!(
      scanActive ||
      libraryRefreshBusy ||
      growingTask ||
      growingTimer !== null ||
      growingDirty ||
      grid.loading.size ||
      mediaDirty ||
      renamingNodes.size ||
      folderTree.loading.size ||
      (typeof structuralTask !== 'undefined' && structuralTask) ||
      (typeof structuralDirty !== 'undefined' && structuralDirty) ||
      rootRecoveryRequests.size
    ),
    origin: performance.timeOrigin
  }));
}
async function settle() {
  let previous = false;
  return poll(
    'real worker/UI idle and import available',
    async () => ({ ui: await uiState(), init: await rpc('init', { lightweight: true }) }),
    ({ ui, init }) => {
      const idle =
        taskIdle(init.taskSnapshot) && taskIdle(ui.rendererTask) && !ui.busy && !ui.importDisabled;
      const done = idle && previous;
      previous = idle;
      return done;
    },
    60000
  );
}
const treeRow = (file) =>
  page.locator('.tree-node[data-node-id="' + idFor(file) + '"] > .tree-row');
const card = (file) => page.locator('#virtual-grid .album-card[data-id="' + idFor(file) + '"]');
async function click(locator, button = 'left') {
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
}
async function enterRoot(file) {
  await click(treeRow(file).locator(':scope > .category-link'));
  await page.waitForFunction((id) => S.parent === id && S.current?.id === id, idFor(file));
  return settle();
}
async function enterFolder(file) {
  await click(card(file));
  await page.waitForFunction((id) => S.parent === id && S.current?.id === id, idFor(file));
  return settle();
}
async function expand(file) {
  const row = treeRow(file);
  await expect(row).toBeVisible();
  if ((await row.getAttribute('aria-expanded')) !== 'true')
    await click(row.locator(':scope > .tree-toggle'));
  await page.waitForFunction(
    (id) => folderTree.open.has(id) && !folderTree.loading.has(id),
    idFor(file)
  );
}
async function armDialog(file, kind) {
  await ownedPath(file);
  assert.ok((await fs.lstat(file)).isDirectory());
  await app.evaluate(
    (_electron, selected) => {
      const state = globalThis.__offlineRecovery;
      if (state.dialogQueue.length) throw new Error('Unconsumed native dialog selection');
      state.dialogQueue.push(selected);
    },
    { path: file, kind }
  );
}
async function completedAfter(mark, method, id) {
  return poll(
    'original main result: ' + method,
    async () =>
      (await ipcState()).calls
        .slice(mark)
        .find((row) => row.method === method && (!id || row.args?.id === id) && row.finished),
    (row) => {
      if (row?.error) throw new Error('Real ' + method + ' failed: ' + row.error);
      return !!row;
    }
  );
}
async function nativeRetry(file, accepted) {
  const mark = (await ipcState()).calls.length;
  await click(page.locator('#source-retry'));
  const call = await completedAfter(mark, 'retryRoot', idFor(file));
  assert.equal(call.result?.accepted, accepted);
  assert.equal(call.result?.root?.status, accepted ? 'online' : 'offline');
  assert.equal(call.result?.root?.id, idFor(file));
  assert.equal(call.result?.root?.path, file);
  assert.ok(call.result?.taskSnapshot?.known);
  await settle();
  await expect(page.locator('#import-sidebar')).toBeEnabled();
  return call;
}
async function nativeRelink(from, to, method) {
  await armDialog(to, 'relink');
  const beforeFS = await manifest(),
    mark = (await ipcState()).calls.length;
  await click(treeRow(from), 'right');
  // The real context handler first awaits get(); let visibility wait for that IPC.
  await click(
    page.locator('#context-menu').getByRole('menuitem', { name: '重新匹配文件夹…', exact: true })
  );
  const call = await completedAfter(mark, method, idFor(from)),
    result = call.result;
  assert.equal(result?.relinked, true);
  assert.equal(result.oldId, idFor(from));
  assert.equal(result.id, idFor(to));
  assert.equal(result.oldPath, from);
  assert.equal(result.path, to);
  assert.equal(result.node?.id, idFor(to));
  assert.equal(result.node?.path, to);
  assert.ok(result.count > 0);
  await settle();
  const afterFS = await manifest();
  assert.deepEqual(
    afterFS,
    beforeFS,
    'DB-only relink must not move, rename, write or delete original fixture filesystem entries'
  );
  await assert.rejects(fs.lstat(from), { code: 'ENOENT' });
  assert.ok((await fs.lstat(to)).isDirectory());
  return { call, beforeFS, afterFS };
}
function preserved(actual, original, fields) {
  assert.ok(actual);
  for (const field of fields) assert.deepEqual(actual[field], original[field], 'Preserve ' + field);
}
async function mapping(oldRows, oldBase, nextBase, nextRoot) {
  const rows = [];
  for (const original of oldRows) {
    const nextPath = path.join(nextBase, path.relative(oldBase, original.path)),
      current = dbNode(nextPath);
    assert.ok(current, 'Mapped node: ' + nextPath);
    assert.equal(current.id, idFor(nextPath));
    assert.equal(current.path, nextPath);
    assert.equal(current.root, idFor(nextRoot));
    assert.equal(current.parent, original.parent === null ? null : idFor(path.dirname(nextPath)));
    assert.equal(current.missing, 0);
    preserved(current, original, [
      'kind',
      'favorite',
      'confirmed',
      'subject_id',
      'manual_subject',
      'manual_cover',
      'cover_source',
      'crop_x',
      'crop_y',
      'crop_zoom'
    ]);
    const cover = oldRows.find((n) => n.id === original.cover);
    if (cover)
      assert.equal(current.cover, idFor(path.join(nextBase, path.relative(oldBase, cover.path))));
    assert.equal(dbNode(original.path), null, 'Old path-derived ID no longer owns a row');
    rows.push({
      oldId: original.id,
      id: current.id,
      oldPath: original.path,
      path: current.path,
      cover: current.cover
    });
  }
  const hydrated = await rpc('get', { id: idFor(nextBase) });
  assert.equal(hydrated.metadata?.id, subjectId);
  const ui = await uiState(),
    oldIDs = new Set(oldRows.map((n) => n.id));
  assert.ok(
    !ui.history.some((n) => oldIDs.has(n.parent)),
    'Navigation history must remap old path IDs'
  );
  assert.ok(!ui.tree.some((n) => oldIDs.has(n.id)), 'Sidebar must remap old path IDs');
  return { rows, metadata: hydrated.metadata, ui };
}
async function offline(file) {
  const result = await rpc('rootStatus', { id: idFor(file), probe: true });
  assert.ok(Array.isArray(result.roots));
  const status = result.roots.find((n) => n.id === idFor(file));
  assert.equal(status?.status, 'offline');
  assert.equal(status?.path, file);
  await expect(treeRow(file).locator('.category-total')).toHaveText('离线');
  await settle();
  return result;
}
async function quietOffline(file, eventMark) {
  const started = Date.now(),
    samples = [],
    id = idFor(file);
  const snapshot = async () => {
    const status = await rpc('rootStatus', { id }),
      init = await rpc('init', { lightweight: true }),
      observed = await ipcState();
    const root = status.roots.find((n) => n.id === id);
    const recoveryCalls = observed.calls.filter(
      (row) =>
        [
          'retryRoot',
          'relinkRoot',
          'relinkFolder',
          'import',
          'scan',
          'refresh',
          'filesystemSync'
        ].includes(row.method) ||
        (row.method === 'rootStatus' && row.args?.probe)
    );
    const related = observed.events
      .slice(eventMark)
      .filter(
        (e) =>
          (e.type === 'root-status' && e.data?.id === id) ||
          (['changed', 'watch', 'progress'].includes(e.type) && e.data?.root === id)
      );
    return {
      at: Date.now(),
      root,
      task: init.taskSnapshot,
      taskEvents: observed.events.filter((e) => e.type === 'tasks').length,
      recoveryCalls: recoveryCalls.length,
      events: related,
      importDisabled: await page.locator('#import-sidebar').isDisabled()
    };
  };
  const baseline = await snapshot();
  assert.equal(
    baseline.events.filter((e) => e.type === 'root-status' && e.data.status === 'offline').length,
    1,
    'Exactly one offline transition, observed through real main event delivery'
  );
  await poll(
    '10-second IPC-observed offline quiescence',
    async () => {
      const sample = await snapshot();
      assert.equal(sample.root.status, 'offline');
      assert.equal(
        sample.root.checkedAt,
        baseline.root.checkedAt,
        'Offline must suspend implicit re-probing'
      );
      assert.equal(sample.root.offlineSince, baseline.root.offlineSince);
      assert.equal(
        sample.recoveryCalls,
        baseline.recoveryCalls,
        'No recursive retry/sync RPC loop'
      );
      assert.equal(
        sample.taskEvents,
        baseline.taskEvents,
        'No recurring task reservation/publication loop'
      );
      assert.deepEqual(
        sample.events,
        baseline.events,
        'No repeated offline transition or root work event loop'
      );
      assert.equal(taskIdle(sample.task), true, 'An offline root must not reserve the task lane');
      assert.equal(sample.importDisabled, false);
      samples.push(sample);
      return sample.at - started;
    },
    (elapsed) => elapsed >= 10000,
    15000
  );
  return {
    durationMs: Date.now() - started,
    mechanism:
      'Repeated real read-only init/rootStatus IPC and forwarded-event/operation counts; no fixed 10-second sleep',
    baseline,
    samples
  };
}
async function nativeImport(file) {
  await settle();
  await armDialog(file, 'import');
  const mark = (await ipcState()).calls.length;
  await click(page.locator('#import-sidebar'));
  await expect(page.locator('#import-options')).toBeVisible();
  const toggle = page.locator('#import-online-match');
  if (await toggle.isChecked()) await toggle.uncheck();
  await click(page.locator('#import-options-confirm'));
  const call = await completedAfter(mark, 'import');
  assert.equal(call.args.onlineMatch, false);
  assert.equal(call.result?.errors, 0);
  assert.ok(dbNode(file));
  await poll('imported root appears through real init/UI', uiState, (ui) =>
    ui.roots.some((n) => n.id === idFor(file) && n.path === file)
  );
  await settle();
  await expect(page.locator('#import-sidebar')).toBeEnabled();
  const dialogs = (await ipcState()).dialogs;
  assert.ok(
    dialogs.some(
      (row) => row.path === file && row.kind === 'import' && /选择要导入/.test(row.title)
    )
  );
  return { call, dialogs, ui: await uiState() };
}
async function screenshot(name) {
  const file = path.join(run, name + '-session-' + report.sessions.length + '.png');
  await page.screenshot({
    path: file,
    clip: { x: 0, y: 0, width: 1000, height: 560 },
    scale: 'css'
  });
  report.screenshots.push(file);
  return file;
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: chromiumProfile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.NODE_OPTIONS;
  delete env.ELECTRON_RUN_AS_NODE;
  closing = false;
  sessionRecord = { launchStartedAt: Date.now(), mode: packaged ? 'packaged' : 'source' };
  report.sessions.push(sessionRecord);
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [target],
    cwd: packaged ? path.dirname(target) : target,
    env,
    timeout: 60000
  });
  child = app.process();
  assert.ok(child?.pid);
  // Capture actual Electron main identity first: app.process() may be a cmd launcher.
  sessionRecord.identity = await app.evaluate(({ app }) => ({
    pid: process.pid,
    executable: process.execPath,
    creationTimeMs: Math.trunc(process.getCreationTime()),
    appPath: app.getAppPath(),
    packaged: app.isPackaged,
    version: app.getVersion(),
    dataDir: process.env.ACG_DATA_DIR,
    userData: app.getPath('userData')
  }));
  await installMainObserver();
  const identity = sessionRecord.identity;
  assert.ok(samePath(identity.dataDir, profile) && samePath(identity.userData, chromiumProfile));
  assert.equal(identity.packaged, packaged);
  assert.equal(identity.version, '1.2.2');
  assert.ok(
    packaged ? samePath(identity.executable, executable) : samePath(identity.appPath, target)
  );
  assert.equal((await inspectOwned('capture')).state, 'running');
  await verifyAncestry();
  page = await app.firstWindow();
  const window = await app.browserWindow(page);
  try {
    await window.evaluate((win) => {
      if (win.isMaximized()) win.unmaximize();
      win.setSize(1320, 900);
      win.webContents.setZoomFactor(1);
      win.webContents.setBackgroundThrottling(false);
      win.show();
      win.focus();
    });
  } finally {
    await window.dispose();
  }
  page.setDefaultTimeout(30000);
  page.on('pageerror', fail);
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && !closing)
      fail(new Error('Unexpected main-document navigation/reload'));
  });
  await app.context().route(/^https?:\/\//i, async (route) => {
    report.remote.push(route.request().url());
    await route.abort();
  });
  await page.waitForFunction(
    () =>
      typeof S !== 'undefined' &&
      typeof grid !== 'undefined' &&
      window.album &&
      typeof startupResumeFinished !== 'undefined' &&
      startupResumeFinished &&
      !startupResumeError
  );
  await page.evaluate(() => {
    window.__offlineRecoveryRenderer = {
      rejections: [],
      events: [],
      origin: performance.timeOrigin
    };
    window.addEventListener('unhandledrejection', (event) =>
      window.__offlineRecoveryRenderer.rejections.push(String(event.reason))
    );
    window.album.onEvent((event) => {
      const rows = window.__offlineRecoveryRenderer.events;
      if (rows.length < 4000) rows.push(event);
      else window.__offlineRecoveryRenderer.overflow = true;
    });
  });
  await settle();
  sessionRecord.hooked = (await ipcState()).hooked;
  for (const method of ['init', 'rootStatus', 'retryRoot', 'relinkRoot', 'relinkFolder', 'import'])
    assert.ok(
      sessionRecord.hooked.includes('library:' + method),
      'Missing real main handler: ' + method
    );
  const settings = await page.evaluate(() => ({
    autoMatch: S.settings.autoMatch,
    watchChanges: S.settings.watchChanges
  }));
  assert.deepEqual(settings, { autoMatch: false, watchChanges: false });
  console.log('RUNTIME ' + JSON.stringify({ mode: sessionRecord.mode, ...identity }));
  return { identity, launcher: sessionRecord.launcher, settings };
}
async function installMainObserver() {
  await app.evaluate(({ app, BrowserWindow, ipcMain, dialog, net, session }) => {
    const state = (globalThis.__offlineRecovery = {
      calls: [],
      events: [],
      hooked: [],
      dialogQueue: [],
      dialogs: [],
      remote: [],
      overflow: false
    });
    const add = (list, row) => {
      if (list.length >= 8000) {
        state.overflow = true;
        throw new Error('Offline recovery observer cap');
      }
      list.push(row);
      return row;
    };
    const nativeHandle = ipcMain.handle.bind(ipcMain),
      wrapped = new WeakSet();
    function wrap(channel, original) {
      if (!channel.startsWith('library:') || wrapped.has(original)) return original;
      const method = channel.slice(8);
      const handler = async (event, args) => {
        const row = add(state.calls, { method, args: args || {}, started: Date.now() });
        try {
          const result = await original(event, args);
          if (['rootStatus', 'retryRoot', 'relinkRoot', 'relinkFolder', 'import'].includes(method))
            row.result = result;
          if (method === 'init')
            row.result = {
              taskSnapshot: result?.taskSnapshot,
              roots: result?.roots?.map((n) => ({
                id: n.id,
                path: n.path,
                rootStatus: n.rootStatus
              }))
            };
          if (method === 'list')
            row.result = {
              total: result?.total,
              items: result?.items?.map((n) => ({ id: n.id, path: n.path, missing: n.missing }))
            };
          return result;
        } catch (error) {
          row.error = error.message;
          throw error;
        } finally {
          row.finished = Date.now();
        }
      };
      wrapped.add(handler);
      if (!state.hooked.includes(channel)) state.hooked.push(channel);
      return handler;
    }
    ipcMain.handle = (channel, handler) => nativeHandle(channel, wrap(channel, handler));
    for (const [channel, handler] of [...ipcMain._invokeHandlers]) {
      if (!channel.startsWith('library:')) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler);
    }
    const observed = new WeakSet();
    const observeWindow = (win) => {
      if (observed.has(win.webContents)) return;
      observed.add(win.webContents);
      const send = win.webContents.send.bind(win.webContents);
      win.webContents.send = (channel, ...args) => {
        if (
          channel === 'library:event' &&
          ['root-status', 'tasks', 'changed', 'watch', 'progress', 'online', 'error'].includes(
            args[0]?.type
          )
        )
          add(state.events, { at: Date.now(), type: args[0].type, data: args[0].data });
        return send(channel, ...args);
      };
    };
    for (const win of BrowserWindow.getAllWindows()) observeWindow(win);
    app.on('browser-window-created', (_event, win) => observeWindow(win));
    dialog.showOpenDialog = async (...args) => {
      const options = args.at(-1),
        chosen = state.dialogQueue.shift();
      if (!chosen)
        throw new Error('Unexpected native open dialog; no checker-owned directory queued');
      if (!options?.properties?.includes('openDirectory'))
        throw new Error('Only native directory selection may be substituted');
      if (
        chosen.kind === 'import'
          ? !/选择要导入/.test(options.title)
          : !/重新匹配/.test(options.title)
      )
        throw new Error('Unexpected directory dialog purpose: ' + options.title);
      add(state.dialogs, {
        ...chosen,
        title: options.title,
        properties: options.properties,
        at: Date.now(),
        boundary: 'Native selection result only; original main handler and worker remain real'
      });
      return { canceled: false, filePaths: [chosen.path] };
    };
    const deny = (input) => {
      const url = String(input?.url || input);
      add(state.remote, url);
      throw new Error('Offline recovery GUI HTTP denied: ' + url);
    };
    const originalNetFetch = net.fetch.bind(net),
      originalFetch = globalThis.fetch;
    net.fetch = (input, ...args) =>
      /^https?:/i.test(String(input?.url || input))
        ? deny(input)
        : originalNetFetch(input, ...args);
    globalThis.fetch = async (input, ...args) =>
      /^https?:/i.test(String(input?.url || input)) ? deny(input) : originalFetch(input, ...args);
    for (const current of new Set([
      session.defaultSession,
      ...BrowserWindow.getAllWindows().map((win) => win.webContents.session)
    ]))
      current.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          add(state.remote, details.url);
          callback({ cancel: true });
        }
      );
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      win.setSize(1320, 900);
      win.webContents.setZoomFactor(1);
      win.webContents.setBackgroundThrottling(false);
      win.show();
      win.focus();
    }
  });
}
// No image or command encoding: JSON is a single-quoted PowerShell literal, safely escaped.
function powershell(script, expected) {
  const literal = JSON.stringify(expected).replaceAll("'", "''");
  const command =
    "$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$expected='" +
    literal +
    "' | ConvertFrom-Json\n" +
    script;
  const exe = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return new Promise((resolve, reject) =>
    execFile(
      exe,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error)
          return reject(new Error('Owned process inspection: ' + (stderr || error.message)));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
        } catch (error) {
          reject(error);
        }
      }
    )
  );
}
async function verifyAncestry() {
  const identity = sessionRecord.identity;
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(child.killed, false);
  assert.ok(path.win32.isAbsolute(child.spawnfile));
  const expected = {
    ...identity,
    launcherPID: child.pid,
    launcherExecutable: child.spawnfile,
    launchStartedAt: sessionRecord.launchStartedAt
  };
  const result = await powershell(
    String.raw`
$chain=@(); $seen=@{}; $cursorPid=[int]$expected.pid
$descendantCreated=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+2000
$found=$false
for ($depth=0; $depth -le 8; $depth++) {
  if ($cursorPid -le 0 -or $seen.ContainsKey($cursorPid)) { throw 'Invalid or cyclic owned ancestry' }
  $seen[$cursorPid]=$true
  $row=Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $cursorPid)
  if ($null -eq $row) { throw 'Owned ancestry process disappeared' }
  $created=([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
  $entry=@{pid=[int]$row.ProcessId;parentPID=[int]$row.ParentProcessId;executable=[string]$row.ExecutablePath;creationTimeMs=$created}
  $chain += $entry
  if ($created -le 0 -or $created -gt $descendantCreated -or -not [IO.Path]::IsPathRooted($entry.executable)) { throw 'Owned ancestry birth order/path invalid or PID reused' }
  if ($depth -eq 0 -and ($created -ne [long]$expected.creationTimeMs -or -not [string]::Equals($entry.executable,[string]$expected.executable,[StringComparison]::OrdinalIgnoreCase))) { throw 'Owned main identity changed' }
  if ($cursorPid -eq [int]$expected.launcherPID) {
    if (-not [string]::Equals($entry.executable,[string]$expected.launcherExecutable,[StringComparison]::OrdinalIgnoreCase) -or $created -lt ([long]$expected.launchStartedAt-2000)) { throw 'Owned launcher executable/birth mismatch' }
    $found=$true; break
  }
  $descendantCreated=$created; $cursorPid=[int]$row.ParentProcessId
}
if (-not $found) { throw 'Main does not descend from this owned launcher' }
foreach ($entry in $chain) {
  $again=Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $entry.pid)
  if ($null -eq $again -or ([DateTimeOffset]$again.CreationDate).ToUnixTimeMilliseconds() -ne $entry.creationTimeMs -or [int]$again.ParentProcessId -ne $entry.parentPID -or -not [string]::Equals([string]$again.ExecutablePath,$entry.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Owned ancestry changed during verification' }
}
@{passed=$true;chain=@($chain)} | ConvertTo-Json -Depth 6 -Compress
`,
    expected
  );
  sessionRecord.launcher = { pid: child.pid, spawnfile: child.spawnfile, ...result };
  assert.equal(result.passed, true);
  assert.equal(result.chain[0].pid, identity.pid);
  assert.equal(result.chain.at(-1).pid, child.pid);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  assert.equal(child.killed, false);
}
async function inspectOwned(action, identity = sessionRecord.identity) {
  assert.ok(identity?.pid && identity.executable && identity.creationTimeMs);
  const result = await powershell(
    String.raw`
$deadline=[DateTime]::UtcNow.AddMilliseconds(3000); $terminated=$false
 do {
  $row=Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid)
  if ($null -eq $row) { @{state='exited';pid=$expected.pid;terminated=$terminated} | ConvertTo-Json -Compress; exit 0 }
  $created=([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
  if ($created -ne [long]$expected.creationTimeMs -or -not [string]::Equals([string]$row.ExecutablePath,[string]$expected.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Owned main identity changed; refusing termination' }
  if ($expected.action -eq 'capture') { @{state='running';pid=$expected.pid;creationTimeMs=$created} | ConvertTo-Json -Compress; exit 0 }
  if ($expected.action -eq 'terminate' -and -not $terminated) {
    $terminated=$true
    $output=(& "$env:SystemRoot\System32\taskkill.exe" /PID ([string][int]$expected.pid) /T /F 2>&1 | Out-String)
    if ($LASTEXITCODE -ne 0 -and (Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f [int]$expected.pid))) { throw ('Owned tree termination failed: '+$output) }
  }
  Start-Sleep -Milliseconds 50
 } while ([DateTime]::UtcNow -lt $deadline)
if ($expected.action -eq 'terminate') { throw 'Owned main remains after termination' }
@{state='running';pid=$expected.pid} | ConvertTo-Json -Compress
`,
    {
      pid: identity.pid,
      executable: identity.executable,
      creationTimeMs: identity.creationTimeMs,
      action
    }
  );
  report.cleanup.push({ session: report.sessions.length, action, identity, result });
  return result;
}
async function closeApp() {
  if (!app) return;
  closing = true;
  const owned = app,
    ownedChild = child,
    failures = [];
  try {
    sessionRecord.observation = await ipcState();
    sessionRecord.renderer = await page.evaluate(() => window.__offlineRecoveryRenderer);
    const observation = sessionRecord.observation;
    assert.equal(observation.overflow, false);
    assert.deepEqual(observation.remote, []);
    assert.deepEqual(observation.dialogQueue, []);
    assert.deepEqual(sessionRecord.renderer.rejections, []);
    assert.ok(!sessionRecord.renderer.overflow);
    assert.equal(sessionRecord.renderer.origin, await page.evaluate(() => performance.timeOrigin));
    assert.ok(!observation.events.some((e) => e.type === 'error'), 'No worker error events');
    assert.ok(
      !observation.events.some(
        (e) => e.type === 'online' && (e.data?.active || e.data?.running || e.data?.pending > 0)
      ),
      'No online matching'
    );
  } catch (error) {
    failures.push(error);
  }
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
  let confirmedExited = false;
  try {
    if ((await inspectOwned('wait-exit')).state !== 'exited') {
      failures.push(new Error('Owned Electron did not exit normally'));
      await inspectOwned('terminate');
    }
    confirmedExited = true;
  } catch (error) {
    failures.push(error);
  }
  if (
    confirmedExited &&
    ownedChild &&
    ownedChild.exitCode === null &&
    ownedChild.signalCode === null &&
    !ownedChild.killed
  ) {
    // A cmd wrapper can lag the main exit. Await its real exit event, then verify
    // its saved executable+birth before any fallback; never equate their PIDs.
    let launcherTimer, exitListener;
    try {
      await Promise.race([
        new Promise((resolve) => {
          exitListener = resolve;
          ownedChild.once('exit', exitListener);
        }),
        new Promise((resolve) => {
          launcherTimer = setTimeout(resolve, 3000);
        })
      ]);
    } finally {
      clearTimeout(launcherTimer);
      ownedChild.removeListener('exit', exitListener);
    }
    if (ownedChild.exitCode === null && ownedChild.signalCode === null && !ownedChild.killed) {
      failures.push(new Error('Owned cmd launcher did not exit normally after main exit'));
      const launcher = sessionRecord.launcher?.chain?.at(-1);
      try {
        assert.ok(
          launcher?.pid === ownedChild.pid,
          'No verified launcher identity; refusing termination'
        );
        if ((await inspectOwned('wait-exit', launcher)).state !== 'exited')
          await inspectOwned('terminate', launcher);
      } catch (error) {
        failures.push(error);
        confirmedExited = false;
      }
    }
  }
  if (confirmedExited) {
    app = null;
    page = null;
    child = null;
  }
  if (failures.length) throw new AggregateError(failures, 'Offline recovery owned cleanup failed');
}
async function main() {
  await check('generated two-root PNG fixture and real worker database preparation', prepare);
  await check(
    'isolated real source/packaged Electron with verified cmd ancestry and main birth',
    launch
  );
  await check('warm real cached A albums and observe initial online roots', async () => {
    const result = await rpc('rootStatus', { probe: true });
    assert.equal(result.roots.length, 2);
    assert.ok(result.roots.every((root) => root.status === 'online'));
    await enterRoot(rootA);
    await expand(rootA);
    await expect(card(album).locator('img')).toBeVisible();
    await page.waitForFunction((id) => {
      const image = document.querySelector('.album-card[data-id="' + id + '"] img');
      return image?.complete && image.naturalWidth > 0;
    }, idFor(album));
    await enterFolder(album);
    await expand(album);
    await enterFolder(nested);
    await page.waitForFunction(
      (id) => {
        const image = document.querySelector('.album-card[data-id="' + id + '"] img');
        return image?.complete && image.naturalWidth > 0;
      },
      idFor(path.join(nested, 'favorite.png'))
    );
    await enterRoot(rootB);
    return { status: result, ui: await uiState() };
  });
  let eventMark;
  await check(
    'missing A emits one offline event; B remains navigable and cached A shows notice',
    async () => {
      eventMark = (await ipcState()).events.length;
      await moveDirectory(rootA, disconnected);
      const result = await offline(rootA);
      await enterRoot(rootB);
      await expect(card(path.join(rootB, 'BAlbum'))).toBeVisible();
      await expect(page.locator('#import-sidebar')).toBeEnabled();
      await enterRoot(rootA);
      await expect(page.locator('#source-status')).toBeVisible();
      await expect(page.locator('#source-retry')).toBeEnabled();
      await expect(page.locator('#source-relink')).toBeEnabled();
      await expect(card(album)).toBeVisible();
      await page.waitForFunction((id) => {
        const image = document.querySelector('.album-card[data-id="' + id + '"] img');
        return image?.complete && image.naturalWidth > 0;
      }, idFor(album));
      await enterFolder(album);
      await expect(card(nested)).toBeVisible();
      await expect(page.locator('#source-status')).toContainText('离线');
      assert.equal(dbNode(album).manual_subject, 1);
      await screenshot('offline-cached-A');
      return {
        result,
        ui: await uiState(),
        cachedRows: readRows('SELECT id,path,missing FROM nodes WHERE root=?', idFor(rootA))
      };
    }
  );
  await check('retry while A is still missing returns accepted=false and releases import', () =>
    nativeRetry(rootA, false)
  );
  await check('offline root remains quiescent for 10 seconds measured by real IPC counts', () =>
    quietOffline(rootA, eventMark)
  );
  await check('reconnecting original path enables real retry without identity loss', async () => {
    await moveDirectory(disconnected, rootA);
    const call = await nativeRetry(rootA, true);
    preserved(dbNode(rootA), report.fixture.originalRoot, [
      'subject_id',
      'manual_subject',
      'manual_cover',
      'cover',
      'favorite',
      'crop_x',
      'crop_y'
    ]);
    await expect(page.locator('#source-status')).toBeHidden();
    return { call, ui: await uiState() };
  });
  await check(
    'root right-click native directory selection performs DB-only relink and maps all old IDs',
    async () => {
      await enterRoot(rootA);
      await enterFolder(album);
      await enterFolder(nested);
      await moveDirectory(rootA, rootNext);
      await offline(rootA);
      const result = await nativeRelink(rootA, rootNext, 'relinkRoot');
      const mapped = await mapping(report.fixture.originalRows, rootA, rootNext, rootNext);
      const nextNested = path.join(rootNext, 'ManualAlbum', 'Nested');
      assert.equal(mapped.ui.parent, idFor(nextNested));
      assert.equal(mapped.ui.current.path, nextNested);
      assert.equal(mapped.ui.footer, nextNested);
      assert.ok(
        mapped.ui.roots.some((n) => n.id === idFor(rootNext) && n.rootStatus?.status === 'online')
      );
      assert.ok(!mapped.ui.roots.some((n) => n.id === idFor(rootA)));
      album = path.join(rootNext, 'ManualAlbum');
      nested = nextNested;
      await screenshot('root-relinked');
      return { ...result, mapped };
    }
  );
  await check(
    'new collection imports through real GUI options, native dialog boundary and main import',
    () => nativeImport(importOne)
  );
  await check(
    'subalbum external rename relinks only its subtree inside the original root',
    async () => {
      await enterRoot(rootNext);
      await expand(rootNext);
      await expand(album);
      await enterFolder(album);
      await enterFolder(nested);
      const oldAlbum = album,
        selected = path.join(rootNext, 'ManualAlbum-Selected');
      const oldRows = readRows(
        'SELECT * FROM nodes WHERE root=? ORDER BY path',
        idFor(rootNext)
      ).filter((n) => samePath(n.path, oldAlbum) || inside(oldAlbum, n.path));
      const unaffected = readRows(
        'SELECT * FROM nodes WHERE root=? ORDER BY path',
        idFor(rootNext)
      ).filter((n) => !oldRows.some((old) => old.id === n.id));
      const otherRoot = readRows('SELECT * FROM nodes WHERE root=? ORDER BY path', idFor(rootB));
      await moveDirectory(oldAlbum, selected);
      const result = await nativeRelink(oldAlbum, selected, 'relinkFolder');
      assert.equal(result.call.result.root, idFor(rootNext));
      const mapped = await mapping(oldRows, oldAlbum, selected, rootNext);
      for (const n of unaffected)
        preserved(dbNode(n.path), n, [
          'id',
          'path',
          'root',
          'parent',
          'subject_id',
          'manual_subject',
          'manual_cover',
          'cover',
          'favorite'
        ]);
      assert.deepEqual(
        readRows('SELECT * FROM nodes WHERE root=? ORDER BY path', idFor(rootB)),
        otherRoot
      );
      assert.equal(mapped.ui.current.path, path.join(selected, 'Nested'));
      album = selected;
      nested = path.join(selected, 'Nested');
      await screenshot('folder-relinked');
      return {
        ...result,
        mapped,
        unaffected: unaffected.map((n) => n.id),
        unchangedB: otherRoot.map((n) => n.id)
      };
    }
  );
  await check('normal close of the first owned GUI session', closeApp);
  await check(
    'restart discovers A disconnected while closed and never locks new imports',
    async () => {
      const hidden = path.join(collection, 'A-Disconnected-While-Closed');
      await moveDirectory(rootNext, hidden);
      const firstIdentity = report.sessions[0].identity;
      const launched = await launch();
      assert.ok(
        launched.identity.pid !== firstIdentity.pid ||
          launched.identity.creationTimeMs !== firstIdentity.creationTimeMs,
        'Restart must have a new process identity'
      );
      const status = await rpc('rootStatus', { id: idFor(rootNext) });
      assert.equal(status.roots[0].status, 'offline');
      await expect(treeRow(rootNext).locator('.category-total')).toHaveText('离线');
      await enterRoot(rootNext);
      await expect(page.locator('#source-status')).toBeVisible();
      await expect(card(album)).toBeVisible();
      await enterRoot(rootB);
      await expect(card(path.join(rootB, 'BAlbum'))).toBeVisible();
      await expect(page.locator('#import-sidebar')).toBeEnabled();
      const imported = await nativeImport(importTwo);
      assert.equal((await rpc('rootStatus', { id: idFor(rootNext) })).roots[0].status, 'offline');
      await screenshot('restart-offline-new-import');
      return { launched, status, imported };
    }
  );
  await check('no renderer failures or attempted HTTP; original documents retained', async () => {
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.remote, []);
    const observed = await ipcState();
    assert.deepEqual(observed.remote, []);
    assert.equal(observed.overflow, false);
    return {
      sessions: report.sessions.map((s) => s.identity),
      dialogs: observed.dialogs,
      statement: 'Screenshots remain on disk only.'
    };
  });
  await check('normal verified close of final GUI session', closeApp);
  assert.ok(report.checks.length === 14 && report.checks.every((row) => row.passed));
  report.passed = true;
}
(async () => {
  try {
    await main();
  } catch (error) {
    fail(error);
    if (app) await closeApp().catch(fail);
  } finally {
    report.finished = new Date().toISOString();
    if (report.errors.length) report.passed = false;
    if (!report.passed) process.exitCode = 1;
    if (run) {
      const file = path.join(run, 'report.json');
      try {
        await fs.writeFile(file, JSON.stringify(report, null, 2), { flag: 'wx' });
        console.log('REPORT ' + file);
      } catch (error) {
        process.exitCode = 1;
        console.error('REPORT_WRITE_FAILED ' + String(error));
      }
    } else console.log(JSON.stringify(report, null, 2));
  }
})();
