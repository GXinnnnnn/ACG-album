'use strict';
// Real generated-fixture acceptance check. Preparing this file does not run it.
// Source: node scripts/check-navigation-cache.cjs
// Packaged: set ACG_APP_PATH=<absolute exe> and optionally ACG_EXECUTABLE=<absolute exe>.
// ACG_CHECK_STAGE selects the evidence parent; REPORT always names an absolute report.json.
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
  req = createRequire(path.join(project, 'package.json')),
  target = path.resolve(process.env.ACG_APP_PATH || project),
  packaged = /\.exe$/i.test(target) || !!process.env.ACG_EXECUTABLE,
  executable = path.resolve(process.env.ACG_EXECUTABLE || (packaged ? target : req('electron'))),
  stage = path.resolve(
    process.env.ACG_CHECK_STAGE || path.join(project, 'artifacts', 'navigation-cache')
  ),
  run = path.join(
    stage,
    `generated-navigation-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`
  ),
  profile = path.join(run, 'generated-profile'),
  collection = path.join(run, 'generated-collection'),
  chromiumProfile = path.join(run, 'chromium-profile'),
  parentPath = path.join(collection, '00-Parent'),
  childPath = path.join(parentPath, 'Nested'),
  reportFile = path.join(run, 'report.json');
const idFor = (p) =>
  crypto.createHash('sha256').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 24);
const ids = { root: idFor(collection), parent: idFor(parentPath), child: idFor(childPath) };
const report = {
  passed: false,
  scope: 'isolated-real-navigation-cache',
  run,
  fixture: { profile, collection, chromiumProfile, ids, siblingFolders: 72 },
  sourceContract: {
    project,
    target,
    executable,
    packaged,
    preparationWorker: path.join(project, 'src/library-worker.cjs'),
    contract:
      'Real fixture worker, original main IPC results, native GUI navigation and generated data only',
    sourceHashes: {}
  },
  checks: [],
  sessions: [],
  cleanup: [],
  errors: [],
  remote: [],
  screenshots: [],
  coverage: {
    dateNotReadyProgressive: {
      status: 'not-exercised-by-this-GUI-check',
      reason:
        'The real fixture worker finishes metadata maintenance before GUI launch. No database date/status seeding or delayed/mocked IPC is used.',
      separateCoverage:
        'Existing browse-sort/date-migration unit tests; this checker neither runs them nor claims their result.'
    }
  },
  limitations: [
    'Generated PNGs and isolated profile only. No access to personal profiles or D-drive material.',
    'Preparation worker fetch, GUI main fetch/session and renderer HTTP are denied. The live application worker is not patched; autoMatch and root policy are disabled, but this is not OS network isolation.',
    'Image instrumentation forwards native src and setAttribute unchanged. IPC observation forwards original arguments and results unchanged. No business response, route state, list contents or cache result is injected.',
    'Frame observations sample DOM completeness and computed opacity at requestAnimationFrame; they are not a pixel readback or a guarantee against compositor-only artifacts.',
    'No progressive date-not-ready GUI coverage is claimed; see coverage.dateNotReadyProgressive.',
    'Only the checker-owned main PID with matching executable and creation time may be forcibly terminated; any fallback makes the run fail.'
  ]
};
let app, page, ownedChild;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function saveReport() {
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
}
async function poll(name, work, accept, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await work(); // Playwright waitForFunction does not await async predicates.
    if (accept(last)) return last;
    await pause(100);
  } while (Date.now() < deadline);
  throw new Error(`${name} timed out; last=${JSON.stringify(last)}`);
}
async function check(name, work) {
  const row = { name, passed: false, started: Date.now() };
  report.checks.push(row);
  saveReport();
  try {
    row.evidence = await work();
    row.passed = true;
  } catch (error) {
    row.error = error.stack || String(error);
    if (page && !page.isClosed()) {
      try {
        row.failureState = await state();
      } catch (failure) {
        row.captureError = String(failure);
      }
      try {
        row.failureProbe = await page.evaluate(() => window.__navigationProbe?.summary());
      } catch {}
    }
    if (app) {
      try {
        row.failureIPC = await app.evaluate(() => global.__navigationIPC);
      } catch {}
    }
    throw error;
  } finally {
    row.finished = Date.now();
    saveReport();
  }
}
async function prepare() {
  await fsp.mkdir(childPath, { recursive: true });
  await fsp.mkdir(profile);
  const sharp = req('sharp');
  const pngs = await Promise.all(
    ['#ca546b', '#54a6ca', '#78a751'].map((background, i) =>
      sharp({ create: { width: 80 + i * 8, height: 112, channels: 3, background } })
        .png()
        .toBuffer()
    )
  );
  async function image(directory, name, i) {
    const file = path.join(directory, name),
      time = new Date(Date.UTC(2020 + (i % 3), 0, 1));
    await fsp.writeFile(file, pngs[i % pngs.length]);
    await fsp.utimes(file, time, time);
  }
  for (let i = 0; i < report.fixture.siblingFolders; i++) {
    const directory = path.join(collection, `Folder-${String(i).padStart(3, '0')}`);
    await fsp.mkdir(directory);
    await image(directory, 'cover.png', i);
  }
  for (const directory of [parentPath, childPath])
    for (let i = 0; i < 3; i++) await image(directory, `${String.fromCharCode(97 + i)}.png`, i);
  for (const relative of ['src/ui/app.js', 'src/ui/masonry.js', 'src/ui/browse-sort.js'])
    report.sourceContract.sourceHashes[relative] = crypto
      .createHash('sha256')
      .update(await fsp.readFile(path.join(project, relative)))
      .digest('hex');
  function fixtureEntry() {
    const { workerData } = require('node:worker_threads');
    global.fetch = async () => {
      throw Error('Generated navigation fixture network denied');
    };
    require(workerData.entry);
  }
  const worker = new Worker('(' + fixtureEntry.toString() + ')()', {
    eval: true,
    workerData: {
      entry: report.sourceContract.preparationWorker,
      dataDir: profile,
      deferBackground: true
    }
  });
  let serial = 0,
    readySeen = false;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Fixture worker ready timeout')), 30000);
    worker.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
      for (const task of pending.values()) task.reject(error);
    });
    worker.on('exit', (code) => {
      clearTimeout(timer);
      const error = Error(`Fixture worker exited (${code})`);
      if (!readySeen) reject(error);
      for (const task of pending.values()) task.reject(error);
    });
    worker.on('message', (message) => {
      if (message.event === 'ready') {
        readySeen = true;
        clearTimeout(timer);
        resolve();
      }
      const task = pending.get(message.request);
      if (task) {
        pending.delete(message.request);
        message.error ? task.reject(Error(message.error)) : task.resolve(message.result);
      }
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++serial,
        timer = setTimeout(() => {
          pending.delete(request);
          reject(Error(`Fixture ${method} timeout`));
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
  try {
    await ready;
    for (const [key, value] of Object.entries({
      autoMatch: false,
      watchChanges: false,
      metadataOnboardingSeen: true,
      motionLevel: 'low'
    }))
      await call('settings', { key, value });
    report.fixture.scan = await call('scan', { path: collection, onlineMatch: false });
    const policy = await call('setRootMatchPolicy', { id: ids.root, enabled: false });
    assert.equal(policy.enabled, false);
    assert.equal(policy.onlineMatch, false);
    await call('startupResume');
    let previous = false;
    report.fixture.idle = await poll(
      'fixture double idle',
      () => call('init', { lightweight: true }),
      (value) => {
        const idle =
          value.taskSnapshot?.known === true &&
          value.taskSnapshot.busy === false &&
          value.taskSnapshot.scan?.status === 'idle' &&
          value.taskSnapshot.maintenance?.state === 'ready';
        const complete = idle && previous;
        previous = idle;
        return complete;
      }
    );
    assert.equal(report.fixture.idle.settings.autoMatch, false);
    assert.equal(report.fixture.idle.settings.watchChanges, false);
    const list = await call('list', {
      parent: ids.root,
      view: 'library',
      filter: 'all',
      search: '',
      sort: 'name',
      direction: 'asc',
      offset: 0,
      limit: 180
    });
    assert.equal(list.folders, report.fixture.siblingFolders + 1);
    assert.equal(list.total, report.fixture.siblingFolders + 1);
    report.fixture.rootList = list.items.map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind
    }));
    await call('shutdown');
  } finally {
    await worker.terminate();
  }
  return {
    folders: report.fixture.rootList.length,
    rootPolicy: 'disabled',
    autoMatch: false,
    watchChanges: false,
    generatedPNG: true
  };
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: chromiumProfile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'missing-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const launchStartedAt = Date.now();
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [target],
    env,
    timeout: 45000
  });
  ownedChild = app.process();
  const identity = await app.evaluate(({ app, net, session, ipcMain }) => {
    const calls = { active: [], completed: [] };
    global.__navigationIPC = calls;
    for (const [channel, original] of [...ipcMain._invokeHandlers]) {
      if (!channel.startsWith('library:')) continue;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, args) => {
        const row = { method: channel.slice(8), started: Date.now() };
        if (row.method === 'list') row.args = { ...args };
        calls.active.push(row);
        try {
          const result = await original(event, args);
          if (row.method === 'list')
            row.result = {
              total: result?.total,
              folders: result?.folders,
              sortFallback: result?.sortFallback || null,
              items: (result?.items || []).map((node) => ({
                id: node.id,
                name: node.name,
                kind: node.kind,
                content_date: node.content_date
              }))
            };
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
    global.__navigationRemote = blocked;
    const deny = (url) => {
      blocked.push(String(url));
      throw Error('Generated navigation GUI network denied');
    };
    const originalNetFetch = net.fetch.bind(net),
      originalFetch = global.fetch.bind(global);
    const remote = (input) => /^https?:/i.test(String(input?.url || input));
    net.fetch = async (input, options) =>
      remote(input) ? deny(input?.url || input) : originalNetFetch(input, options);
    global.fetch = async (input, options) =>
      remote(input) ? deny(input?.url || input) : originalFetch(input, options);
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
  assert.equal(path.resolve(identity.executable).toLowerCase(), executable.toLowerCase());
  assert.equal(path.resolve(identity.dataDir).toLowerCase(), profile.toLowerCase());
  assert.equal(path.resolve(identity.userData).toLowerCase(), chromiumProfile.toLowerCase());
  if (packaged) assert.ok(/resources[\\/]app\.asar$/i.test(identity.appPath));
  else assert.equal(path.resolve(identity.appPath).toLowerCase(), target.toLowerCase());
  assert.equal((await inspectOwnedMain('capture')).state, 'running');
  await verifyLauncherAncestry(identity, ownedChild, launchStartedAt);
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(String(error)));
  await page.route(/^https?:/i, (route) => {
    report.remote.push(route.request().url());
    return route.abort();
  });
  await poll(
    'renderer boot',
    () =>
      page.evaluate(
        () =>
          typeof S !== 'undefined' &&
          typeof grid !== 'undefined' &&
          typeof startupResumeFinished !== 'undefined' &&
          startupResumeFinished &&
          S.roots.length === 1
      ),
    Boolean
  );
  await installProbe();
  // Native window sizing keeps this small fixture scrollable on different desktops.
  const window = await app.browserWindow(page);
  try {
    await window.evaluate((w) => {
      if (w.isMaximized()) w.unmaximize();
      w.setBounds({ width: 1280, height: 900 });
    });
    identity.fixtureWindow = await window.evaluate((w) => w.getBounds());
  } finally {
    await window.dispose();
  }
  await settle();
  return identity;
}
async function installProbe() {
  await page.evaluate(() => {
    const writes = new WeakMap(),
      events = [],
      probe = {
        writes,
        events,
        references: new Map(),
        frames: [],
        sampling: false,
        finished: false,
        summary() {
          return {
            frames: this.frames,
            events: this.events.slice(-40),
            compare: this.references.size ? this.compare() : null
          };
        },
        compare() {
          const viewport = document.querySelector('#viewport');
          return {
            parent: S.parent,
            scroll: viewport.scrollTop,
            rows: [...this.references].map(([id, old]) => {
              const current = [...grid.cards.values()].find((card) => card.dataset.id === id),
                image = current?.querySelector('img');
              return {
                id,
                sameButton: current === old.button,
                sameImage: image === old.image,
                connected: old.button.isConnected,
                complete: old.image.complete && old.image.naturalWidth > 0,
                srcSame: old.image.getAttribute('src') === old.src,
                srcAssignments: (writes.get(old.image) || 0) - old.writes
              };
            })
          };
        }
      };
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src'),
      setAttribute = Element.prototype.setAttribute;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(value) {
        writes.set(this, (writes.get(this) || 0) + 1);
        return src.set.call(this, value);
      }
    });
    Element.prototype.setAttribute = function (name, value) {
      if (this instanceof HTMLImageElement && String(name).toLowerCase() === 'src')
        writes.set(this, (writes.get(this) || 0) + 1);
      return setAttribute.call(this, name, value);
    };
    window.album.onEvent((event) => {
      if (['changed', 'watch', 'tasks', 'error'].includes(event.type))
        events.push({ at: Date.now(), ...event });
    });
    window.__navigationProbe = probe;
  });
}
async function state() {
  return page.evaluate(async () => {
    const init = await window.album.call('init', { lightweight: true });
    return {
      parent: S.parent,
      path: S.current?.path,
      sort: S.sort,
      direction: S.direction,
      control: document.querySelector('#sort').value,
      preferences: browseSortMemory.snapshot(),
      args: grid.args,
      queryArgs: queryArgs(),
      scroll: document.querySelector('#viewport').scrollTop,
      total: grid.total,
      cards: grid.cards.size,
      gridActive: grid.active,
      overview: isOverview(),
      scanActive,
      libraryRefreshBusy,
      growingTask: Boolean(growingTask),
      growingTimer: growingTimer !== null,
      growingDirty,
      structuralTask: Boolean(structuralTask),
      structuralDirty,
      renamingNodes: [...renamingNodes],
      gridLoading: grid.loading.size,
      mediaDirty,
      modalOpen: document.querySelector('#modal').open,
      viewerOpen: document.querySelector('#viewer').open,
      settings: { autoMatch: S.settings.autoMatch, watchChanges: S.settings.watchChanges },
      taskSnapshot: init.taskSnapshot,
      rendererTaskSnapshot: startupTaskSnapshot,
      changedSerial: window.__navigationProbe.events.filter((event) =>
        ['changed', 'watch'].includes(event.type)
      ).length,
      structuralRevision: typeof structuralRevision === 'undefined' ? null : structuralRevision,
      rootPolicy: init.rootMatchPolicies || null
    };
  });
}
async function settle() {
  let previous;
  const result = await poll(
    'real renderer and worker double idle',
    state,
    (s) => {
      const taskIdle = (task) =>
        task?.known === true &&
        task.busy === false &&
        task.scan?.status === 'idle' &&
        task.maintenance?.state === 'ready';
      const idle =
        taskIdle(s.taskSnapshot) &&
        taskIdle(s.rendererTaskSnapshot) &&
        !s.scanActive &&
        !s.libraryRefreshBusy &&
        !s.growingTask &&
        !s.growingTimer &&
        !s.growingDirty &&
        !s.structuralTask &&
        !s.structuralDirty &&
        !s.renamingNodes.length &&
        !s.gridLoading &&
        !s.mediaDirty &&
        !s.modalOpen &&
        !s.viewerOpen &&
        s.control === s.sort &&
        (s.overview || (s.gridActive && JSON.stringify(s.args) === JSON.stringify(s.queryArgs)));
      const signature = JSON.stringify([
        s.parent,
        s.sort,
        s.direction,
        s.changedSerial,
        s.structuralRevision
      ]);
      const complete = idle && previous === signature;
      previous = idle ? signature : undefined;
      return complete;
    },
    60000
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  assert.equal(result.settings.autoMatch, false);
  assert.equal(result.settings.watchChanges, false);
  return result;
}
async function enter(id) {
  const tile = page.locator(`.collection-tile[data-id="${id}"]`);
  if (await tile.count()) await tile.click();
  else await page.locator(`.album-card[data-id="${id}"]`).click();
  await poll(
    'native folder navigation',
    () => page.evaluate(() => S.parent),
    (parent) => parent === id
  );
  return settle();
}
async function back(expected) {
  await page.locator('#back-button').click();
  await poll(
    'native back navigation',
    () => page.evaluate(() => S.parent),
    (parent) => parent === expected
  );
  return settle();
}
async function expectPair(sort, direction) {
  const s = await state();
  assert.equal(s.sort, sort);
  assert.equal(s.direction, direction);
  assert.equal(s.control, sort);
  assert.equal(s.args.sort, sort);
  assert.equal(s.args.direction, direction);
  const ipc = await app.evaluate(
    (_electron, expected) =>
      [...global.__navigationIPC.completed]
        .reverse()
        .find(
          (row) =>
            row.method === 'list' &&
            row.args?.parent === expected.parent &&
            row.args.sort === expected.sort &&
            row.args.direction === expected.direction &&
            !row.args.offset &&
            row.args.filter === 'all'
        ),
    { parent: s.parent, sort, direction }
  );
  assert.ok(
    ipc && !ipc.error && ipc.result?.items.length > 0,
    'The selected order must reach a real main list response'
  );
  assert.equal(
    ipc.result.sortFallback,
    null,
    'Prepared fixture dates must be ready rather than silently using a fallback'
  );
  const rendered = await page.evaluate(() =>
    [...grid.items].sort(([a], [b]) => a - b).map(([, node]) => node.id)
  );
  assert.deepEqual(
    rendered,
    ipc.result.items.map((node) => node.id),
    'Real main response order must reach the active grid'
  );
  for (const kind of ['folder', 'image']) {
    const nodes = ipc.result.items.filter((node) => node.kind === kind);
    if (sort === 'name') {
      const names = nodes.map((node) => node.name);
      assert.deepEqual(
        names,
        [...names].sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }))
      );
    } else if (sort === 'contentDate') {
      assert.ok(nodes.every((node) => Number.isFinite(node.content_date)));
      assert.ok(nodes.every((node, i) => !i || nodes[i - 1].content_date >= node.content_date));
    }
  }
  return { ...s, observedList: ipc };
}
async function chooseName() {
  const source = page.locator('#sort'),
    wrapper = source.locator('..');
  const index = await source.evaluate((select) =>
    [...select.options].findIndex((option) => option.value === 'name')
  );
  assert.ok(index >= 0);
  await wrapper.getByRole('combobox').click();
  await wrapper.locator(`.album-select-option[data-index='${index}']`).click();
  await poll(
    'native sort selection',
    () => page.evaluate(() => S.sort),
    (sort) => sort === 'name'
  );
  if (await page.evaluate(() => S.direction !== 'asc'))
    await page.locator('#sort-direction').click();
  await settle();
  await page.evaluate(() => browseSortMemory.flush());
  return expectPair('name', 'asc');
}
async function loadedImages() {
  return poll(
    'all rendered fixture PNGs decoded and visible covers opaque',
    () =>
      page.evaluate(() => {
        const vp = document.querySelector('#viewport').getBoundingClientRect(),
          cards = [...grid.cards.values()];
        const rows = cards.map((card) => {
          const img = card.querySelector('img'),
            box = card.getBoundingClientRect(),
            visible = box.bottom > vp.top && box.top < vp.bottom;
          return {
            id: card.dataset.id,
            visible,
            image: Boolean(img),
            decoded: Boolean(img?.complete && img.naturalWidth > 0),
            opacity: img ? Number(getComputedStyle(img).opacity) : 0
          };
        });
        return { rows, total: grid.total, viewport: vp.height };
      }),
    (s) =>
      s.rows.length > 0 &&
      s.rows.every((r) => r.image && r.decoded && (!r.visible || r.opacity >= 0.99))
  );
}
async function captureParent() {
  await loadedImages();
  return page.evaluate(() => {
    const probe = window.__navigationProbe,
      vp = document.querySelector('#viewport').getBoundingClientRect();
    probe.references.clear();
    for (const button of grid.cards.values()) {
      const image = button.querySelector('img'),
        box = button.getBoundingClientRect();
      if (image && box.bottom > vp.top && box.top < vp.bottom)
        probe.references.set(button.dataset.id, {
          button,
          image,
          src: image.getAttribute('src'),
          writes: probe.writes.get(image) || 0
        });
    }
    probe.savedScroll = document.querySelector('#viewport').scrollTop;
    probe.parent = S.parent;
    return {
      ids: [...probe.references.keys()],
      scroll: probe.savedScroll,
      parent: probe.parent,
      at: Date.now(),
      geometry: {
        wallWidth: document.querySelector('#virtual-grid').clientWidth,
        cardWidth: grid.width,
        cols: grid.cols,
        dpr: devicePixelRatio
      }
    };
  });
}
async function startFrames() {
  await page.evaluate(() => {
    const probe = window.__navigationProbe;
    probe.frames = [];
    probe.sampling = true;
    probe.finished = false;
    const sample = () => {
      if (!probe.sampling) return;
      const vp = document.querySelector('#viewport').getBoundingClientRect();
      const visible = [...document.querySelectorAll('#virtual-grid .album-card img')].filter(
        (img) => {
          const box = img.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && box.bottom > vp.top && box.top < vp.bottom;
        }
      );
      const originals = [...probe.references.values()].filter((r) => r.button.isConnected);
      probe.frames.push({
        at: Date.now(),
        parent: S.parent,
        committedParent: grid.args?.parent,
        scroll: document.querySelector('#viewport').scrollTop,
        visible: visible.length,
        decoded: visible.filter((img) => img.complete && img.naturalWidth > 0).length,
        opaque: visible.filter(
          (img) =>
            img.complete && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) >= 0.99
        ).length,
        originals: originals.length,
        assignments: [...probe.references.values()].reduce(
          (n, r) => n + (probe.writes.get(r.image) || 0) - r.writes,
          0
        )
      });
      if (probe.frames.length < 4000) requestAnimationFrame(sample);
      else probe.sampling = false;
    };
    requestAnimationFrame(sample);
  });
}
async function navigationRoundTrip(label, requestedScroll) {
  await settle();
  await page.locator('#viewport').evaluate((el, scroll) => {
    el.scrollTop = scroll;
  }, requestedScroll);
  await settle();
  await loadedImages();
  const before = await captureParent();
  assert.ok(before.ids.length > 0);
  if (!requestedScroll) assert.equal(before.scroll, 0);
  else
    assert.ok(
      before.scroll >= 2400 && before.scroll <= 2800,
      'Generated view must support a real deep scroll near 2600px'
    );
  const targetId = await page.evaluate(() => {
    const vp = document.querySelector('#viewport').getBoundingClientRect();
    for (const [index, button] of grid.cards) {
      const node = grid.items.get(index),
        box = button.getBoundingClientRect();
      if (node?.kind === 'folder' && box.top >= vp.top + 140 && box.bottom <= vp.bottom - 24)
        return node.id;
    }
    return null;
  });
  assert.ok(targetId, 'A fully exposed folder card must exist without scrolling to click it');
  const eventMark = await page.evaluate(() => window.__navigationProbe.events.length);
  await enter(targetId);
  await loadedImages();
  await startFrames();
  const mark = await app.evaluate(() => global.__navigationIPC.completed.length);
  const returned = await back(ids.root);
  await loadedImages();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  const probe = await page.evaluate(() => {
    const probe = window.__navigationProbe;
    probe.sampling = false;
    probe.finished = true;
    return probe.summary();
  });
  const ipc = await app.evaluate(
    (_electron, mark) => global.__navigationIPC.completed.slice(mark),
    mark
  );
  const changed = await page.evaluate(
    (mark) =>
      window.__navigationProbe.events
        .slice(mark)
        .filter((event) => ['changed', 'watch'].includes(event.type)),
    eventMark
  );
  assert.deepEqual(
    changed,
    [],
    'Fixture changed during retention; a maintenance invalidation would confound this check'
  );
  assert.equal(returned.parent, ids.root);
  assert.ok(Math.abs(returned.scroll - before.scroll) <= 1, 'Back restores saved pixel scroll');
  assert.equal(probe.compare.rows.length, before.ids.length);
  for (const row of probe.compare.rows) {
    assert.equal(row.sameButton, true, `${label}: same button ${row.id}`);
    assert.equal(row.sameImage, true, `${label}: same decoded image ${row.id}`);
    assert.equal(row.connected, true, `${label}: original button connected ${row.id}`);
    assert.equal(row.complete, true, `${label}: complete ${row.id}`);
    assert.equal(row.srcSame, true, `${label}: same src ${row.id}`);
    assert.equal(row.srcAssignments, 0, `${label}: src setter remains untouched ${row.id}`);
  }
  const frames = probe.frames.filter((frame) => frame.parent === ids.root);
  assert.ok(frames.length > 0, 'Real frame evidence must be nonempty');
  assert.ok(
    frames.every((frame) => frame.opaque > 0),
    'No observed return frame may have all-white covers'
  );
  const committedFrames = frames.filter((frame) => frame.committedParent === ids.root);
  assert.ok(committedFrames.length > 0, 'The restored parent must have committed frame evidence');
  assert.ok(
    committedFrames.every(
      (frame) =>
        frame.originals > 0 &&
        frame.assignments === 0 &&
        Math.abs(frame.scroll - before.scroll) <= 1
    ),
    'Every committed parent frame must already contain saved decoded DOM at the saved pixel scroll'
  );
  const lists = ipc.filter((row) => row.method === 'list' && row.args?.parent === ids.root);
  assert.ok(lists.length > 0, 'Observe the real background list validation after return');
  assert.ok(
    lists.every((row) => !row.error && row.result?.total === report.fixture.siblingFolders + 1)
  );
  return { label, before, returned, probe, ipc, changed };
}
async function resizeSameTier() {
  const before = await captureParent(),
    window = await app.browserWindow(page),
    bounds = await window.evaluate((w) => w.getBounds());
  try {
    await window.evaluate((w, width) => w.setBounds({ width }), Math.max(980, bounds.width - 180));
    await settle();
    await loadedImages();
    const resizedBounds = await window.evaluate((w) => w.getBounds());
    assert.notEqual(resizedBounds.width, bounds.width, 'The real native window width must change');
    const result = await page.evaluate(() => {
      const probe = window.__navigationProbe,
        wall = document.querySelector('#virtual-grid');
      const common = probe.compare().rows.filter((row) => row.sameImage);
      return {
        common,
        width: grid.width,
        cols: grid.cols,
        wallWidth: wall.clientWidth,
        tier: [...grid.cards.values()].map(
          (card) => /[?&]size=(\d+)/.exec(card.querySelector('img')?.getAttribute('src') || '')?.[1]
        )
      };
    });
    assert.ok(result.common.length > 0, 'Resize retains at least one original visible image');
    for (const row of result.common) {
      assert.equal(row.srcSame, true);
      assert.equal(row.srcAssignments, 0);
    }
    assert.ok(result.width <= result.wallWidth);
    assert.notEqual(
      result.wallWidth,
      before.geometry.wallWidth,
      'Native resize must change the actual grid layout width'
    );
    assert.equal(
      result.width,
      before.geometry.cardWidth,
      'This scenario keeps the density width and thumbnail tier unchanged'
    );
    return { before, bounds, resizedBounds, result };
  } finally {
    await window.evaluate((w, bounds) => w.setBounds(bounds), bounds);
    await window.dispose();
    await settle();
  }
}
async function verifyLauncherAncestry(identity, child, launchStartedAt) {
  const evidence = {
    platform: process.platform,
    launcherPID: child.pid,
    spawnfile: child.spawnfile,
    launchStartedAt,
    inspectedAt: Date.now(),
    exitCodeBefore: child.exitCode,
    signalCodeBefore: child.signalCode,
    chain: [],
    passed: false
  };
  identity.launcher = evidence;
  assert.equal(child.exitCode, null, 'The owned launcher must still be running');
  assert.equal(child.signalCode, null, 'The owned launcher must not have been signalled');
  assert.equal(child.killed, false, 'The owned launcher must not have been killed');
  if (process.platform !== 'win32') {
    assert.equal(identity.pid, child.pid);
    evidence.passed = true;
    return;
  }
  assert.ok(path.win32.isAbsolute(child.spawnfile), 'Windows launcher spawnfile must be absolute');
  assert.equal(
    path.win32.basename(child.spawnfile).toLowerCase(),
    'cmd.exe',
    'Expected Playwright Windows shell launcher'
  );
  const expected = {
    mainPID: identity.pid,
    mainExecutable: identity.executable,
    mainCreationTimeMs: identity.creationTimeMs,
    launcherPID: child.pid,
    launcherExecutable: child.spawnfile,
    launchStartedAt,
    maxDepth: 8
  };
  const payload = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$result = @{passed=$false;chain=@();launcherPID=$expected.launcherPID;launcherExecutable=$expected.launcherExecutable;maxDepth=$expected.maxDepth}
try {
  $cursorPid = [int]$expected.mainPID
  $descendantCreated = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 2000
  $seen = @{}
  for ($depth = 0; $depth -le [int]$expected.maxDepth; $depth++) {
    if ($cursorPid -le 0 -or $seen.ContainsKey($cursorPid)) { throw 'Invalid or cyclic launcher ancestry' }
    $seen[$cursorPid] = $true
    $row = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $cursorPid)
    if ($null -eq $row) { throw 'Launcher ancestry process is no longer running' }
    $created = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
    $entry = @{pid=[int]$row.ProcessId;parentPID=[int]$row.ParentProcessId;executable=[string]$row.ExecutablePath;creationTimeMs=$created;depth=$depth}
    $result.chain += $entry
    if ($created -le 0 -or $created -gt $descendantCreated) { throw 'Invalid launcher ancestry creation time or reused parent PID' }
    if (-not [IO.Path]::IsPathRooted($entry.executable)) { throw 'Launcher ancestry executable path is missing or not absolute' }
    if ($depth -eq 0 -and ($created -ne [long]$expected.mainCreationTimeMs -or -not [string]::Equals($entry.executable,[string]$expected.mainExecutable,[StringComparison]::OrdinalIgnoreCase))) { throw 'Owned main identity changed during launcher verification' }
    if ($cursorPid -eq [int]$expected.launcherPID) {
      if (-not [string]::Equals($entry.executable,[string]$expected.launcherExecutable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Owned launcher executable does not match ChildProcess.spawnfile' }
      if ($created -lt ([long]$expected.launchStartedAt - 2000)) { throw 'Owned launcher predates this launch' }
      $result.launcherCreationTimeMs = $created
      $result.passed = $true
      break
    }
    $descendantCreated = $created
    $cursorPid = [int]$row.ParentProcessId
  }
  if (-not $result.passed) { throw 'Main ancestry did not reach the owned launcher within depth limit' }
  # Re-read the complete chain to reject disappearance or PID reuse while walking it.
  foreach ($entry in $result.chain) {
    $again = Get-CimInstance Win32_Process -Filter ('ProcessId = {0}' -f $entry.pid)
    if ($null -eq $again -or ([DateTimeOffset]$again.CreationDate).ToUnixTimeMilliseconds() -ne $entry.creationTimeMs -or [int]$again.ParentProcessId -ne $entry.parentPID -or -not [string]::Equals([string]$again.ExecutablePath,$entry.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Launcher ancestry identity changed during verification' }
  }
} catch {
  $result.passed = $false
  $result.error = $_.Exception.Message
}
$result | ConvertTo-Json -Depth 8 -Compress
`;
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = await new Promise((resolve, reject) =>
    execFile(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error) return reject(Error('Owned launcher ancestry: ' + (stderr || error.message)));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
        } catch (error) {
          reject(error);
        }
      }
    )
  );
  Object.assign(evidence, result, {
    exitCodeAfter: child.exitCode,
    signalCodeAfter: child.signalCode,
    inspectedAt: Date.now()
  });
  assert.equal(
    child.exitCode,
    null,
    'The owned launcher must remain running throughout ancestry verification'
  );
  assert.equal(child.signalCode, null);
  assert.equal(child.killed, false);
  assert.equal(result.passed, true, result.error || 'Main must descend from the owned launcher');
  assert.ok(result.chain.length > 1 && result.chain.length <= expected.maxDepth + 1);
  assert.equal(result.chain[0].pid, identity.pid);
  assert.equal(result.chain.at(-1).pid, child.pid);
}
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
  const powershell = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const result = await new Promise((resolve, reject) =>
    execFile(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 65536 },
      (error, stdout, stderr) => {
        if (error) return reject(Error('Owned main ' + action + ': ' + (stderr || error.message)));
        try {
          resolve(JSON.parse(stdout.replace(/^\uFEFF/, '').trim()));
        } catch (error) {
          reject(error);
        }
      }
    )
  );
  report.cleanup.push({ action, identity, result, at: new Date().toISOString() });
  return result;
}
async function closeApp() {
  if (!app) return;
  const owned = app,
    child = ownedChild;
  app = null;
  ownedChild = null;
  const failures = [];
  try {
    const ipc = await owned.evaluate(() => global.__navigationIPC),
      remote = await owned.evaluate(() => global.__navigationRemote || []);
    report.sessions.at(-1).ipc = ipc;
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
        timer = setTimeout(() => reject(Error('Owned Electron close timeout')), 15000);
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
        failures.push(Error('Owned main did not exit normally'));
        await inspectOwnedMain('terminate');
      }
    } catch (error) {
      failures.push(error);
    }
  } else failures.push(Error('Missing verified owned identity; no termination attempted'));
  if (child && child.exitCode === null && child.signalCode === null && !child.killed)
    failures.push(Error('Owned child process has not reported normal exit'));
  if (failures.length) {
    report.cleanupFailures ||= [];
    report.cleanupFailures.push(
      ...failures.map((error) => ({
        message: error.message,
        stack: error.stack,
        identity: report.mainIdentity
      }))
    );
    throw new AggregateError(failures, 'Navigation checker owned cleanup failed');
  }
}
async function main() {
  await fsp.mkdir(run, { recursive: true });
  saveReport();
  await check(
    'real generated PNG scan, disabled matching/watch/root policy and worker double idle',
    prepare
  );
  await check('source or packaged executable uses isolated data and Chromium profiles', launch);
  await check(
    'imported root defaults to name ascending and first list is real main IPC',
    async () => {
      const mark = await app.evaluate(() => global.__navigationIPC.completed.length);
      await enter(ids.root);
      const s = await expectPair('name', 'asc');
      const lists = await app.evaluate(
        (_electron, mark) =>
          global.__navigationIPC.completed.slice(mark).filter((row) => row.method === 'list'),
        mark
      );
      const cold = lists.filter((row) => row.args?.parent === ids.root);
      assert.ok(cold.length > 0);
      assert.ok(
        cold.every(
          (row) =>
            row.args.sort === 'name' &&
            row.args.direction === 'asc' &&
            row.result?.total === report.fixture.siblingFolders + 1 &&
            !row.error
        )
      );
      return { state: s, ipc: cold };
    }
  );
  await check('first child and deeper album default to contentDate descending', async () => {
    await enter(ids.parent);
    const parent = await expectPair('contentDate', 'desc');
    await enter(ids.child);
    const child = await expectPair('contentDate', 'desc');
    const selected = await chooseName();
    await back(ids.parent);
    await expectPair('contentDate', 'desc');
    await back(ids.root);
    await expectPair('name', 'asc');
    return { parent, child, explicitUserSelection: selected };
  });
  await check('top=0 return hit restores original decoded DOM with zero src assignments', () =>
    navigationRoundTrip('top', 0)
  );
  await check('deep ~2600px return preserves scroll, real DOM and non-white sampled frames', () =>
    navigationRoundTrip('deep', 2600)
  );
  await check(
    'real window resize relayouts without assigning unchanged-tier image URLs',
    resizeSameTier
  );
  await check('normal verified close of first GUI session', async () => {
    await closeApp();
    return report.cleanup.slice();
  });
  await check('restart uses the same generated profile with a new verified main', async () => {
    const first = report.sessions[0].pid,
      identity = await launch();
    assert.notEqual(identity.pid, first);
    return identity;
  });
  await check(
    'explicit name sorting persists across restart with independent ancestor defaults',
    async () => {
      await enter(ids.root);
      const root = await expectPair('name', 'asc');
      await enter(ids.parent);
      const parent = await expectPair('contentDate', 'desc');
      await enter(ids.child);
      const child = await expectPair('name', 'asc');
      assert.ok(Object.keys(child.preferences).length > 0);
      return { root, parent, child, sessionPids: report.sessions.map((session) => session.pid) };
    }
  );
  await check('no renderer errors or attempted HTTP requests', async () => {
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.remote, []);
    const remote = await app.evaluate(() => global.__navigationRemote || []);
    assert.deepEqual(remote, []);
    return { errors: report.errors, rendererRemote: report.remote, mainRemote: remote };
  });
}
(async () => {
  try {
    await main();
    await check('normal verified close of final GUI session', async () => {
      await closeApp();
      return report.cleanup.slice();
    });
    assert.ok(report.checks.length > 0 && report.checks.every((row) => row.passed));
    report.passed = true;
  } catch (error) {
    report.error = error.stack || String(error);
    try {
      await closeApp();
    } catch (cleanup) {
      report.cleanupFailure = cleanup.stack || String(cleanup);
    }
    process.exitCode = 1;
  } finally {
    try {
      await fsp.mkdir(run, { recursive: true });
      saveReport();
    } catch (error) {
      process.exitCode = 1;
      console.error('REPORT_WRITE_FAILED ' + String(error));
    }
    console.log('REPORT ' + reportFile);
  }
})();
