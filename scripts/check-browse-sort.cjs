'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { _electron } = require('@playwright/test');
const project = path.resolve(__dirname, '..'),
  req = createRequire(path.join(project, 'package.json'));
const target = process.env.ACG_APP_PATH || project;
const packaged = /\.exe$/i.test(target) || !!process.env.ACG_EXECUTABLE;
const executable = process.env.ACG_EXECUTABLE || (packaged ? target : req('electron'));
const stage = path.resolve(
  process.env.ACG_CHECK_STAGE || path.join(project, 'artifacts', 'browse-sort')
);
const run = path.join(
  stage,
  `generated-browse-sort-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
);
const profile = path.join(run, 'generated-profile'),
  collection = path.join(run, 'generated-collection');
const parentPath = path.join(collection, 'Parent'),
  childPath = path.join(parentPath, 'Nested'),
  paginationPath = path.join(collection, 'Folder-first');
const paginationFolders = 181; // One folder beyond the real 180-row grid page boundary.
const reportFile = path.join(run, 'report.json');
const report = {
  passed: false,
  scope: 'isolated-real-browse-sort',
  run,
  fixture: { profile, collection, chromiumProfile: path.join(run, 'chromium-profile') },
  checks: [],
  sessions: [],
  cleanup: [],
  errors: [],
  remote: [],
  screenshots: [],
  renameAttempts: [],
  limitations: [
    'Generated files and isolated profile only. No GUI reload or application/IPC response replacement.',
    'Known EXIF timestamps are seeded only in the closed generated media database after a real scan. This tests cache-backed date sorting, not an EXIF decoder.',
    'Preparation worker fetch is denied. GUI main fetch/session and renderer HTTP are denied; live worker fetch is not patched, so this is not OS network isolation.',
    'Only the checker-owned main process is eligible for verified fallback cleanup; any fallback fails the check.'
  ]
};
let app,
  page,
  ownedChild,
  closeRequested = false;
const idFor = (p) =>
  crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 24);
const keyFor = (p) =>
  JSON.stringify([
    'library',
    p === null ? null : path.win32.normalize(p).replace(/\\+$/, '').toLowerCase()
  ]);
const saveReport = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
async function check(name, work) {
  const row = { name, passed: false };
  report.checks.push(row);
  saveReport();
  try {
    row.evidence = await work();
    row.passed = true;
  } catch (error) {
    row.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      try {
        row.failureState = await page.evaluate(() => ({
          parent: S.parent,
          path: S.current?.path,
          scanActive,
          libraryRefreshBusy,
          growingTask: Boolean(growingTask),
          growingTimer: Boolean(growingTimer),
          growingDirty,
          structuralTask: Boolean(structuralTask),
          structuralDirty,
          renamingNodes: [...renamingNodes],
          gridLoading: grid.loading.size,
          mediaDirty,
          modalOpen: document.querySelector('#modal').open,
          viewerOpen: document.querySelector('#viewer').open,
          watchChanges: S.settings.watchChanges,
          preferences: browseSortMemory.snapshot(),
          externalRenames: externalRenameQueue,
          events: window.__browseSortEvents || [],
          renameError: document.querySelector('#rename-error')?.textContent,
          renameInput: document.querySelector('#rename-name')?.value,
          renameDisabled: document.querySelector('#rename-save')?.disabled,
          sort: S.sort,
          direction: S.direction,
          control: document.querySelector('#sort').value,
          gridArgs: grid.args,
          queryArgs: queryArgs()
        }));
        row.failureInit = await page.evaluate(() =>
          window.album.call('init', { lightweight: true })
        );
        if (app) row.failureIPC = await app.evaluate(() => global.__browseSortIPC || null);
      } catch (diagnosticError) {
        row.failureCaptureError = diagnosticError.stack || String(diagnosticError);
      }
    }
    throw error;
  } finally {
    saveReport();
  }
}
async function prepare() {
  await fsp.mkdir(childPath, { recursive: true });
  await fsp.mkdir(paginationPath);
  await fsp.mkdir(profile);
  for (let index = 0; index < paginationFolders; index++) {
    const directory = path.join(paginationPath, `Folder-${String(index).padStart(3, '0')}`);
    await fsp.mkdir(directory);
    const oldMtime = new Date(Date.UTC(2000, 0, 1));
    await fsp.utimes(directory, oldMtime, oldMtime);
  }
  const sharp = req('sharp');
  for (const directory of [parentPath, childPath, paginationPath]) {
    for (const [i, name] of ['a.png', 'b.png', 'c.png'].entries()) {
      const file = path.join(directory, name);
      await sharp({
        create: { width: 8, height: 8, channels: 3, background: ['#b66', '#6b6', '#66b'][i] }
      })
        .png()
        .toFile(file);
      const time = new Date(`${2021 + [2, 0, 1][i]}-01-01T00:00:00Z`);
      await fsp.utimes(file, time, time);
    }
  }
  function fixtureEntry() {
    const { workerData } = require('node:worker_threads');
    global.fetch = async () => {
      throw Error('Generated sort fixture network denied');
    };
    require(workerData.entry);
  }
  const worker = new Worker('(' + fixtureEntry.toString() + ')()', {
    eval: true,
    workerData: {
      dataDir: profile,
      entry: path.join(project, 'src/library-worker.cjs'),
      deferBackground: true
    }
  });
  let request = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    worker.on('error', (error) => {
      reject(error);
      for (const p of pending.values()) p.reject(error);
    });
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      const p = pending.get(message.request);
      if (p) {
        pending.delete(message.request);
        message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
      }
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++request, { resolve, reject });
      worker.postMessage({ request, method, args });
    });
  try {
    await ready;
    for (const [key, value] of Object.entries({
      autoMatch: false,
      watchChanges: false,
      metadataOnboardingSeen: true,
      motionLevel: 'low'
    }))
      await call('settings', { key, value });
    await call('scan', { path: collection, onlineMatch: false });
    await call('startupResume');
    let status;
    for (let i = 0; i < 200; i++) {
      status = await call('init', { lightweight: true });
      if (status.taskSnapshot?.maintenance?.state === 'ready') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.taskSnapshot.maintenance.state, 'ready');
    const policy = await call('setRootMatchPolicy', { id: idFor(collection), enabled: false });
    assert.equal(policy.enabled, false);
    assert.equal(policy.onlineMatch, false);
    await call('shutdown');
  } finally {
    await worker.terminate();
  }
  const { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(path.join(profile, 'library.sqlite'));
  try {
    for (const directory of [parentPath, childPath, paginationPath])
      for (const [i, name] of ['a.png', 'b.png', 'c.png'].entries()) {
        const id = idFor(path.join(directory, name));
        const taken = Date.UTC(
          directory === paginationPath ? [2010, 2040, 2011][i] : 2010 + i,
          0,
          1
        );
        db.prepare(
          "UPDATE media SET taken=?,date_source='exif-local',status='ready',width=8,height=8,format='png',frames=1 WHERE id=?"
        ).run(taken, id);
        assert.equal(
          db.prepare('SELECT content_date FROM nodes WHERE id=?').get(id).content_date,
          taken
        );
      }
    const folders = db
      .prepare(
        "SELECT id,name,birth,mtime,content_date FROM nodes WHERE parent=? AND kind='folder'"
      )
      .all(idFor(paginationPath));
    assert.equal(folders.length, paginationFolders);
    for (const folder of folders) {
      assert.ok(
        Number.isFinite(folder.birth) && folder.birth > folder.mtime,
        'actual Windows birth must be newer than the deliberately old directory mtime'
      );
      assert.equal(
        folder.content_date,
        folder.birth,
        'folder date follows real scanned birth, not the earlier mtime'
      );
    }
    report.fixture.pagination = {
      path: paginationPath,
      folderCount: folders.length,
      mediaCount: 3,
      expectedTotal: folders.length + 3,
      folders
    };
    const root = idFor(collection);
    const policy = db
      .prepare('SELECT enabled,auto_enabled FROM root_match_policy WHERE root=?')
      .get(root);
    assert.ok(policy, 'real setRootMatchPolicy must persist an explicit root policy');
    assert.equal(policy.enabled, 0);
    assert.equal(policy.auto_enabled, 0);
    db.prepare("UPDATE settings SET value='true' WHERE key='watchChanges'").run();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_pending').get().n, 0);
  } finally {
    db.close();
  }
  report.fixture.ids = {
    root: idFor(collection),
    parent: idFor(parentPath),
    child: idFor(childPath)
  };
  saveReport();
}
async function launch() {
  closeRequested = false;
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(run, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'missing-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [target],
    env,
    timeout: 45000
  });
  ownedChild = app.process();
  const identity = await app.evaluate(({ app, net, session, ipcMain }) => {
    const calls = { active: [], completed: [] };
    global.__browseSortIPC = calls;
    for (const [channel, original] of [...ipcMain._invokeHandlers]) {
      if (!channel.startsWith('library:')) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, args) => {
        const row = { method: channel.slice(8), started: Date.now() };
        if (row.method === 'rename') row.args = { id: args?.id, name: args?.name };
        calls.active.push(row);
        try {
          const result = await original(event, args);
          if (row.method === 'init') {
            row.watchChanges = result?.settings?.watchChanges;
            row.maintenance = result?.taskSnapshot?.maintenance;
          }
          return result;
        } catch (error) {
          row.error = error.message || String(error);
          throw error;
        } finally {
          row.finished = Date.now();
          calls.active.splice(calls.active.indexOf(row), 1);
          calls.completed.push(row);
        }
      });
    }
    const blocked = [];
    global.__browseSortRemote = blocked;
    const deny = (url) => {
      blocked.push(String(url));
      throw Error('Generated sort GUI network denied');
    };
    const originalNetFetch = net.fetch.bind(net),
      originalFetch = global.fetch.bind(global);
    const isRemote = (input) => /^https?:/i.test(String(input?.url || input));
    net.fetch = async (url, options) =>
      isRemote(url) ? deny(url?.url || url) : originalNetFetch(url, options);
    global.fetch = async (url, options) =>
      isRemote(url) ? deny(url?.url || url) : originalFetch(url, options);
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        blocked.push(details.url);
        callback({ cancel: true });
      }
    );
    return {
      pid: process.pid,
      executable: process.execPath,
      creationTimeMs: Math.trunc(process.getCreationTime()),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      dataDir: process.env.ACG_DATA_DIR,
      version: app.getVersion()
    };
  });
  report.mainIdentity = identity;
  report.sessions.push(identity);
  assert.equal(path.resolve(identity.dataDir).toLowerCase(), profile.toLowerCase());
  assert.equal(
    path.resolve(identity.executable).toLowerCase(),
    path.resolve(executable).toLowerCase()
  );
  if (packaged) assert.ok(identity.appPath.endsWith('resources\\app.asar'));
  else
    assert.equal(path.resolve(identity.appPath).toLowerCase(), path.resolve(target).toLowerCase());
  assert.equal((await inspectOwnedMain('capture')).state, 'running');
  page = await app.firstWindow();
  await page.evaluate(() => {
    window.__browseSortEvents = [];
    window.album.onEvent((event) => {
      if (['changed', 'watch', 'tasks', 'error'].includes(event.type))
        window.__browseSortEvents.push({
          at: Date.now(),
          viewerOpen: document.querySelector('#viewer')?.open,
          ...event
        });
    });
  });
  page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.route(/^https?:/i, (route) => {
    report.remote.push(route.request().url());
    return route.abort();
  });
  await page.waitForFunction(
    () =>
      typeof startupResumeFinished !== 'undefined' && startupResumeFinished && S.roots.length === 1
  );
  await settle();
  saveReport();
}
async function settle() {
  await page.waitForFunction(
    () =>
      !scanActive &&
      !libraryRefreshBusy &&
      !growingTask &&
      !growingTimer &&
      !growingDirty &&
      !structuralTask &&
      !structuralDirty &&
      !renamingNodes.size &&
      !grid.loading.size &&
      !mediaDirty &&
      !document.querySelector('#modal').open &&
      document.querySelector('#sort').value === S.sort &&
      (isOverview() || (grid.active && JSON.stringify(grid.args) === JSON.stringify(queryArgs()))),
    { timeout: 30000 }
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function submitAncestorRename() {
  const deadline = Date.now() + 30000;
  const remaining = () => {
    const timeout = deadline - Date.now();
    assert.ok(timeout > 0, 'Native rename submissions exceeded the existing 30-second budget');
    return timeout;
  };
  const expected = { id: idFor(parentPath), path: parentPath, name: 'Renamed' };
  const destination = path.join(collection, expected.name);
  const busy = '请先等待当前导入或资料修改完成，再重命名。';
  const busyUI = new Set([busy, "Error invoking remote method 'library:rename': Error: " + busy]);
  const form = await page.locator('#rename-form').elementHandle();
  assert.ok(form, 'Original rename form must exist');
  const preferences = (await state()).preferences;
  const originalDirectories = async () =>
    Promise.all(
      [parentPath, childPath].map(async (directory) => {
        const stat = await fsp.stat(directory);
        assert.ok(stat.isDirectory(), 'Original parent and child must remain directories');
        return { path: directory, dev: stat.dev, ino: stat.ino };
      })
    );
  const originals = await originalDirectories();
  const taskState = () =>
    page.evaluate(async () => ({
      taskSnapshot: (await window.album.call('init', { lightweight: true })).taskSnapshot,
      rendererTaskSnapshot: startupTaskSnapshot,
      scanActive
    }));
  const idle = (snapshot) =>
    snapshot.taskSnapshot?.known === true &&
    snapshot.taskSnapshot.busy === false &&
    snapshot.taskSnapshot.scan?.status === 'idle' &&
    snapshot.rendererTaskSnapshot?.known === true &&
    snapshot.rendererTaskSnapshot.busy === false &&
    snapshot.rendererTaskSnapshot.scan?.status === 'idle' &&
    !snapshot.scanActive;
  const preflight = async () => {
    const current = await form.evaluate(
      (original, expected) => ({
        sameForm:
          original.isConnected &&
          original === document.querySelector('#rename-form') &&
          document.querySelector('#modal').open,
        originalPath: document.querySelector('#rename-original-path')?.textContent,
        node: [...grid.items.values()].find((node) => node.id === expected.id),
        currentParent: S.parent,
        currentPath: S.current?.path,
        name: document.querySelector('#rename-name')?.value,
        saveEnabled: document.querySelector('#rename-save')?.disabled === false,
        inputEnabled: document.querySelector('#rename-name')?.disabled === false,
        renamingNodes: [...renamingNodes],
        externalRenames: externalRenameQueue,
        watchChanges: S.settings.watchChanges,
        preferences: browseSortMemory.snapshot()
      }),
      expected
    );
    assert.equal(current.sameForm, true, 'Retry must retain the same connected native form');
    assert.equal(current.originalPath, expected.path);
    assert.equal(current.node?.id, expected.id);
    assert.equal(current.node?.path, expected.path);
    assert.equal(current.currentParent, idFor(collection));
    assert.equal(current.currentPath, collection);
    assert.equal(current.name, expected.name);
    assert.equal(current.saveEnabled, true);
    assert.equal(current.inputEnabled, true);
    assert.deepEqual(current.renamingNodes, []);
    assert.deepEqual(current.externalRenames, []);
    assert.equal(current.watchChanges, true);
    assert.deepEqual(
      current.preferences,
      preferences,
      'Busy rejection must not migrate preferences'
    );
    assert.deepEqual(await originalDirectories(), originals);
    await assert.rejects(fsp.lstat(destination), { code: 'ENOENT' });
    return current;
  };
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const evidence = { attempt, waitingAt: Date.now() };
      report.renameAttempts.push(evidence);
      try {
        evidence.taskBefore = await taskState();
        saveReport();
        let candidate = evidence.taskBefore;
        for (;;) {
          remaining();
          if (idle(candidate)) {
            evidence.taskIdle = candidate;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining())));
          remaining();
          candidate = await taskState();
        }
        assert.ok(idle(evidence.taskIdle), 'Native rename requires a real idle task snapshot');
        evidence.preflight = await preflight();
        const mark = await app.evaluate(() => global.__browseSortIPC.completed.length);
        evidence.submittedAt = Date.now();
        saveReport();
        await page.locator('#rename-save').click({ timeout: remaining() });
        const finished = await page.waitForFunction(
          () => {
            const modalOpen = document.querySelector('#modal').open;
            const error = document.querySelector('#rename-error')?.textContent || '';
            return !modalOpen ||
              (error && !renamingNodes.size && !document.querySelector('#rename-save')?.disabled)
              ? { modalOpen, error, at: Date.now() }
              : false;
          },
          null,
          { timeout: remaining(), polling: 100 }
        );
        evidence.outcome = await finished.jsonValue();
        await finished.dispose();
        evidence.ipc = await app.evaluate(
          (mark) =>
            global.__browseSortIPC.completed.slice(mark).filter((row) => row.method === 'rename'),
          mark
        );
        saveReport();
        if (!evidence.outcome.modalOpen) return;
        assert.ok(
          busyUI.has(evidence.outcome.error),
          'Unexpected native rename error: ' + evidence.outcome.error
        );
        assert.equal(
          evidence.ipc.length,
          1,
          'Busy retry requires exactly one observed native rename RPC'
        );
        assert.deepEqual(evidence.ipc[0].args, { id: expected.id, name: expected.name });
        assert.equal(evidence.ipc[0].error, busy);
        assert.ok(evidence.ipc[0].started >= evidence.submittedAt);
        evidence.afterBusy = await preflight();
        evidence.taskAfterBusy = await taskState();
        assert.equal(attempt, 1, 'Second native rename submission was busy; no further retry');
      } catch (error) {
        evidence.failure = error.stack || String(error);
        throw error;
      } finally {
        saveReport();
      }
    }
  } finally {
    await form.dispose();
  }
}
async function enter(id) {
  const tile = page.locator(`.collection-tile[data-id="${id}"]`);
  if (await tile.count()) await tile.click();
  else await page.locator(`.album-card[data-id="${id}"]`).click();
  await page.waitForFunction((id) => S.parent === id && !grid.loading.size, id);
  await settle();
}
async function choose(sort, direction) {
  const source = page.locator('#sort');
  const index = await source.evaluate(
    (select, value) => [...select.options].findIndex((option) => option.value === value),
    sort
  );
  assert.ok(index >= 0, `#sort: missing option ${sort}`);
  const wrapper = source.locator('..');
  const button = wrapper.getByRole('combobox');
  await button.click();
  await wrapper.locator(`.album-select-option[data-index='${index}']`).click();
  assert.equal(await source.inputValue(), sort);
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  await page.waitForFunction((sort) => S.sort === sort && !grid.loading.size, sort);
  const current = await page.evaluate(() => S.direction);
  if (current !== direction) await page.locator('#sort-direction').click();
  await settle();
  await page.waitForFunction(
    () => !browseSortMemory.flush || Object.keys(S.settings.browseSortPreferences || {}).length > 0
  );
  await page.evaluate(() => browseSortMemory.flush());
}
async function state() {
  return page.evaluate(() => ({
    parent: S.parent,
    path: S.current?.path,
    sort: S.sort,
    direction: S.direction,
    control: document.querySelector('#sort').value,
    preferences: browseSortMemory.snapshot(),
    args: queryArgs(),
    items: [...grid.items.values()].map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind,
      content_date: n.content_date,
      birth: n.birth,
      mtime: n.mtime
    }))
  }));
}
async function expectPair(sort, direction) {
  const value = await state();
  assert.equal(value.sort, sort);
  assert.equal(value.direction, direction);
  assert.equal(value.control, sort);
  return value;
}
async function back() {
  await page.locator('#back-button').click();
  await settle();
}
async function main() {
  await prepare();
  await launch();
  const ids = report.fixture.ids;
  await check(
    'date keeps folders first in both directions across the real grid page boundary',
    async () => {
      const fixture = report.fixture.pagination,
        evidence = [];
      await enter(ids.root);
      await enter(idFor(paginationPath));
      for (const direction of ['asc', 'desc']) {
        await choose('contentDate', direction);
        await page.locator('#viewport').hover();
        await page.mouse.wheel(0, 100000);
        await page.waitForFunction(
          (total) => grid.items.has(total - 1) && !grid.loading.size,
          fixture.expectedTotal
        );
        await settle();
        const result = await page.evaluate(() => ({
          total: grid.total,
          rows: [...grid.items.entries()]
            .sort(([a], [b]) => a - b)
            .map(([index, node]) => ({
              index,
              id: node.id,
              name: node.name,
              kind: node.kind,
              birth: node.birth,
              mtime: node.mtime,
              content_date: node.content_date
            }))
        }));
        assert.equal(result.total, fixture.expectedTotal);
        assert.equal(result.rows.length, fixture.expectedTotal);
        assert.deepEqual(
          result.rows.map((node) => node.index),
          Array.from({ length: fixture.expectedTotal }, (_, index) => index)
        );
        const folders = result.rows.slice(0, fixture.folderCount),
          media = result.rows.slice(fixture.folderCount);
        assert.ok(
          folders.every(
            (node) =>
              node.kind === 'folder' && node.content_date === node.birth && node.birth > node.mtime
          )
        );
        assert.ok(media.every((node) => node.kind === 'image'));
        assert.equal(result.rows[179].kind, 'folder');
        assert.equal(result.rows[180].kind, 'folder');
        assert.equal(result.rows[181].kind, 'image');
        const sign = direction === 'asc' ? 1 : -1;
        const expectedFolders = fixture.folders
          .slice()
          .sort((a, b) => (a.birth - b.birth || a.name.localeCompare(b.name)) * sign);
        assert.deepEqual(
          folders.map((node) => node.id),
          expectedFolders.map((node) => node.id)
        );
        assert.deepEqual(
          media.map((node) => node.name),
          direction === 'asc' ? ['a.png', 'c.png', 'b.png'] : ['b.png', 'c.png', 'a.png']
        );
        evidence.push({ direction, ...result });
      }
      await back();
      await back();
      return evidence;
    }
  );
  await check(
    'toolbar date is distinct from creation and modification; known EXIF cache sorts real media',
    async () => {
      assert.deepEqual(
        await page.locator('#sort option').evaluateAll((rows) => rows.map((row) => row.value)),
        ['name', 'contentDate', 'date', 'modified', 'size']
      );
      await enter(ids.root);
      await enter(ids.parent);
      await enter(ids.child);
      await choose('contentDate', 'asc');
      const result = await state();
      const actual = await page.evaluate(() =>
        [...document.querySelectorAll('.album-card[data-id]')]
          .map((card) => ({
            name: card.querySelector('.card-title')?.textContent,
            r: card.getBoundingClientRect()
          }))
          .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)
          .map((row) => row.name)
      );
      assert.deepEqual(actual, ['a.png', 'b.png', 'c.png']);
      assert.deepEqual(
        result.items.map((n) => n.content_date).sort((a, b) => a - b),
        [2010, 2011, 2012].map((y) => Date.UTC(y, 0, 1))
      );
      await choose('modified', 'asc');
      const changed = await state();
      assert.notEqual(changed.sort, result.sort);
      return { date: result, modified: changed };
    }
  );
  await check(
    'right-click date and direction share parent-child memory, Back and search/filter scope',
    async () => {
      const contextPoint = await page.evaluate(() => {
        const viewport = document.querySelector('#viewport');
        const bounds = viewport.getBoundingClientRect();
        const wall = document.querySelector('#virtual-grid').getBoundingClientRect();
        const titlebar = document.querySelector('.titlebar').getBoundingClientRect();
        const minY = Math.max(8, bounds.top + 8, titlebar.bottom + 16);
        const maxY = Math.min(innerHeight - 8, bounds.bottom - 16);
        const ys = [Math.max(minY, Math.min(wall.top + 8, maxY)), (minY + maxY) / 2];
        for (const x of [wall.left - 8, bounds.left + 8, wall.right + 8]) {
          for (const y of ys) {
            if (x <= bounds.left || x >= Math.min(bounds.right, innerWidth) || y < minY || y > maxY)
              continue;
            const hit = document.elementFromPoint(x, y);
            if (
              hit?.closest('#viewport') === viewport &&
              !hit.closest(
                '.album-card,.collection-tile,header,.titlebar,aside,.sidebar,.page-heading,button,a,input,textarea,select,dialog,[contenteditable="true"]'
              )
            )
              return { x, y, hit: hit.tagName, className: hit.className };
          }
        }
        throw new Error('No visible blank viewport point outside cards, header and sidebar');
      });
      await page.mouse.click(contextPoint.x, contextPoint.y, { button: 'right' });
      await page
        .locator('#context-menu button')
        .filter({ hasText: /^按日期排序$/ })
        .click();
      await settle();
      await choose('contentDate', 'desc');
      const child = await state();
      await back();
      await choose('size', 'asc');
      const parent = await state();
      await enter(ids.child);
      await expectPair('contentDate', 'desc');
      const search = page.locator('#search');
      await search.fill('a');
      await page.waitForFunction(() => S.search === 'a');
      await settle();
      await expectPair('contentDate', 'desc');
      await search.fill('');
      await page.waitForFunction(() => S.search === '');
      await settle();
      await page.locator('[data-filter="images"]').click();
      await settle();
      await expectPair('contentDate', 'desc');
      await page.locator('[data-filter="all"]').click();
      await settle();
      await back();
      await expectPair('size', 'asc');
      return { child, parent, contextPoint };
    }
  );
  await check(
    'real process restart restores parent and unopened descendant sort choices',
    async () => {
      const before = await state();
      await closeApp();
      await launch();
      await enter(ids.root);
      await enter(ids.parent);
      await expectPair('size', 'asc');
      await enter(ids.child);
      await expectPair('contentDate', 'desc');
      await back();
      return { before, after: await state(), processPids: report.sessions.map((s) => s.pid) };
    }
  );
  await check(
    'manual ancestor rename migrates unopened descendants then external rename persists while viewer stays open',
    async () => {
      await back();
      await page.locator(`.album-card[data-id="${ids.parent}"]`).click({ button: 'right' });
      await page
        .locator('#context-menu button')
        .filter({ hasText: /^重命名…$/ })
        .click();
      await page.locator('#rename-name').fill('Renamed');
      await submitAncestorRename();
      await settle();
      const renamed = path.join(collection, 'Renamed'),
        nested = path.join(renamed, 'Nested');
      await page.waitForFunction(
        (id) => [...grid.items.values()].some((n) => n.id === id),
        idFor(renamed)
      );
      await enter(idFor(renamed));
      await expectPair('size', 'asc');
      const preferences = (await state()).preferences;
      assert.equal(preferences[keyFor(nested)].sort, 'contentDate');
      assert.ok(!Object.hasOwn(preferences, keyFor(childPath)));
      await enter(idFor(nested));
      const mediaId = idFor(path.join(nested, 'a.png'));
      await page.locator(`.album-card[data-id="${mediaId}"]`).click();
      await page.waitForFunction(() => document.querySelector('#viewer').open);
      const destination = path.join(collection, 'External');
      assert.equal(path.resolve(renamed), path.join(collection, 'Renamed'));
      assert.equal(path.resolve(destination), path.join(collection, 'External'));
      await fsp.rename(renamed, destination);
      await page.waitForFunction(
        (key) => browseSortMemory.snapshot()[key]?.sort === 'contentDate',
        keyFor(path.join(destination, 'Nested')),
        { timeout: 30000 }
      );
      await page.evaluate(() => browseSortMemory.flush());
      assert.equal(await page.locator('#viewer').evaluate((node) => node.open), true);
      await closeApp();
      await launch();
      await enter(ids.root);
      await enter(idFor(destination));
      await expectPair('size', 'asc');
      await enter(idFor(path.join(destination, 'Nested')));
      await expectPair('contentDate', 'desc');
      return { preferences: (await state()).preferences, externalPath: destination };
    }
  );
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.remote, []);
  report.remoteMain = await app.evaluate(() => global.__browseSortRemote);
  assert.deepEqual(report.remoteMain, []);
}
// Owned process verification and bounded close are copied from the existing checker, without changing it.
async function inspectOwnedMain(action) {
  const identity = report.mainIdentity;
  assert.ok(identity?.pid && identity.executable && identity.creationTimeMs);
  const payload = Buffer.from(
    JSON.stringify({
      pid: identity.pid,
      executable: identity.executable,
      creationTimeMs: identity.creationTimeMs,
      action
    }),
    'utf8'
  ).toString('base64');
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
  try {
    const remote = await owned.evaluate(() => global.__browseSortRemote || []);
    report.sessions.at(-1).remote = remote;
    assert.deepEqual(remote, []);
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
  if (failures.length) {
    report.cleanupFailures ||= [];
    report.cleanupFailures.push(
      ...failures.map((error) => ({
        message: error.message,
        stack: error.stack,
        identity: report.mainIdentity
      }))
    );
    throw new AggregateError(failures, 'Browse-sort owned cleanup failed');
  }
}

(async () => {
  try {
    await main();
    await closeApp();
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    try {
      await closeApp();
    } catch (cleanup) {
      report.cleanupFailure = cleanup.stack || String(cleanup);
    }
    try {
      const { DatabaseSync } = require('node:sqlite'),
        db = new DatabaseSync(path.join(profile, 'library.sqlite'), { readOnly: true });
      try {
        const paths = [
          collection,
          parentPath,
          childPath,
          path.join(collection, 'Renamed'),
          path.join(collection, 'Renamed', 'Nested'),
          path.join(collection, 'External'),
          path.join(collection, 'External', 'Nested')
        ];
        report.failureDatabase = {
          watchChanges: db.prepare("SELECT value FROM settings WHERE key='watchChanges'").get(),
          nodes: db
            .prepare("SELECT id,parent,path,missing,fs_identity FROM nodes WHERE kind='folder'")
            .all()
            .filter((node) => paths.includes(node.path)),
          filesystem: paths.map((directory) => {
            try {
              const stat = fs.statSync(directory);
              return { path: directory, dev: stat.dev, ino: stat.ino, mtime: stat.mtimeMs };
            } catch (failure) {
              return { path: directory, error: failure.code };
            }
          })
        };
      } finally {
        db.close();
      }
    } catch (diagnosticError) {
      report.failureDatabaseError = diagnosticError.stack || String(diagnosticError);
    }
    process.exitCode = 1;
  } finally {
    saveReport();
    console.log('REPORT ' + reportFile);
  }
})();
