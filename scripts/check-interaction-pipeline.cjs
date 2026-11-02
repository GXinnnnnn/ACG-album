'use strict';
// Prepared for the Lead's serial GUI run. Never launch this alongside another GUI checker.
// Source: node scripts/check-interaction-pipeline.cjs
// Source elsewhere: ACG_APP_PATH=<project directory>
// Packaged: ACG_APP_PATH=<absolute ACG-album.exe> (ACG_EXECUTABLE also accepted).
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const requested = path.resolve(process.env.ACG_APP_PATH || process.env.ACG_EXECUTABLE || root);
const packaged = /\.exe$/i.test(requested);
const source = packaged ? root : requested;
const executable = packaged ? requested : require('electron');
const stage = path.resolve(
  process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\interaction-pipeline'
);
const report = {
  passed: false,
  started: new Date().toISOString(),
  requested,
  packaged,
  scope:
    'Real Electron source/packaged UI and worker, generated 420 direct mixed-aspect PNGs plus 13 two-image subfolders, isolated physical profile. Directory picker is intercepted. One existing manual association is seeded in the closed generated SQLite profile to test preservation; this is not a bind-transport test. DOM, layout, IPC requests and responses are observed without replacing product handlers. No personal files, network metadata, pressure loop or runtime deployment.',
  checks: [],
  sessions: [],
  screenshots: [],
  errors: []
};
let run, profile, collection, app, page, session;
const subjectId = 940001;
const inside = (base, file) => {
  const relative = path.relative(base, file);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function check(name, callback) {
  try {
    const details = await callback();
    report.checks.push({ name, passed: true, details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack || String(error) });
    throw error;
  }
}
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function settle({ media = true } = {}) {
  await page.waitForFunction(
    (media) =>
      !libraryRefreshBusy &&
      !scanActive &&
      !growingTask &&
      growingTimer === null &&
      !growingDirty &&
      grid.loading.size === 0 &&
      (!media || typeof mediaDirty === 'undefined' || !mediaDirty),
    media
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#virtual-grid img')].every(
      (image) => image.complete && image.naturalWidth > 0
    )
  );
  await frames();
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
function observeRenderer() {
  const probe = (window.__interactionProbe = {
    origin: performance.timeOrigin,
    firstNode: null,
    firstNodeWall: null,
    firstFrame: null,
    firstDecoded: null,
    paints: [],
    unhandled: [],
    events: []
  });
  window.addEventListener('unhandledrejection', (event) =>
    probe.unhandled.push(String(event.reason))
  );
  const paints = new PerformanceObserver((entries) =>
    probe.paints.push(
      ...entries.getEntries().map((entry) => ({ name: entry.name, startTime: entry.startTime }))
    )
  );
  paints.observe({ type: 'paint', buffered: true });
  const inspect = () => {
    const card = document.querySelector(
      '.collection-tile[data-id],#virtual-grid .album-card[data-id]'
    );
    if (card && probe.firstNode === null) {
      probe.firstNode = performance.now();
      probe.firstNodeWall = Date.now();
      probe.firstId = card.dataset.id;
      requestAnimationFrame(() => {
        probe.firstFrame = performance.now();
      });
    }
    const image = card?.querySelector('img');
    if (image?.complete && image.naturalWidth && probe.firstDecoded === null)
      probe.firstDecoded = performance.now();
  };
  new MutationObserver(inspect).observe(document, {
    subtree: true,
    childList: true,
    attributes: true
  });
  document.addEventListener('load', inspect, true);
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      inspect();
      window.album.onEvent((event) => {
        if (['online', 'progress', 'changed'].includes(event.type))
          probe.events.push({ time: performance.now(), type: event.type, data: event.data });
      });
    },
    { once: true }
  );
}
async function launch(label) {
  assert.equal(app, undefined, 'Only one owned Electron may run');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  session = { label, errors: [], consoleErrors: [], rendererNetwork: [] };
  report.sessions.push(session);
  const started = performance.now();
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [source],
    cwd: packaged ? path.dirname(executable) : source,
    env,
    timeout: 60000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => {
    session.errors.push(error.stack || error.message);
    report.errors.push(error.stack || error.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') session.consoleErrors.push(message.text());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    session.rendererNetwork.push(route.request().url());
    await route.abort();
  });
  session.runtime = await app.evaluate(
    ({ app, BrowserWindow, dialog, net, session }, collection) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
      const probe = (globalThis.__interactionMain = { calls: [], events: [], blocked: [] });
      const Worker = process.mainModule.require('node:worker_threads').Worker;
      const send = Worker.prototype.postMessage,
        watched = new WeakSet(),
        pending = new Map();
      Worker.prototype.postMessage = function (message, ...args) {
        if (message?.method) {
          if (!watched.has(this)) {
            watched.add(this);
            this.on('message', (reply) => {
              const call = pending.get(reply?.request);
              if (call) {
                call.reply = Date.now();
                call.error = reply.error || null;
                pending.delete(reply.request);
              }
              if (['online', 'progress', 'changed'].includes(reply?.event))
                probe.events.push({ time: Date.now(), type: reply.event, data: reply.data });
            });
          }
          const call = {
            method: message.method,
            args: message.args,
            request: message.request,
            time: Date.now(),
            reply: null
          };
          probe.calls.push(call);
          pending.set(message.request, call);
        }
        return send.call(this, message, ...args);
      };
      const realFetch = net.fetch.bind(net);
      net.fetch = (input, ...args) => {
        const url = typeof input === 'string' ? input : input?.url || String(input);
        if (!/^https?:/i.test(url)) return realFetch(input, ...args);
        probe.blocked.push(url);
        return Promise.reject(new Error('HTTP disabled by isolated interaction checker'));
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (details, callback) => {
          probe.blocked.push(details.url);
          callback({ cancel: true });
        }
      );
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1440, 1000);
      win.webContents.setBackgroundThrottling(false);
      win.show();
      win.focus();
      win.webContents.focus();
      return {
        appPath: app.getAppPath(),
        executable: process.execPath,
        packaged: app.isPackaged,
        userData: app.getPath('userData'),
        version: app.getVersion()
      };
    },
    collection
  );
  assert.equal(session.runtime.packaged, packaged);
  assert.ok(samePath(session.runtime.executable, executable));
  assert.ok(samePath(session.runtime.userData, path.join(profile, 'chromium-profile')));
  if (!packaged) assert.ok(samePath(session.runtime.appPath, source));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumAppearanceControls
  );
  session.launchToReadyMs = Math.round(performance.now() - started);
  await page.emulateMedia({ reducedMotion: 'reduce' });
}
async function closeApp() {
  if (!app) return;
  const closing = app;
  session.main = await closing
    .evaluate(() => globalThis.__interactionMain)
    .catch((error) => ({ captureError: error.message }));
  session.renderer = await page.evaluate(() => window.__interactionProbe || null).catch(() => null);
  app = undefined;
  let timer;
  try {
    await Promise.race([
      closing.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Owned Electron close timed out')), 15000);
      })
    ]);
  } catch (error) {
    const child = closing.process();
    if (child.exitCode === null) child.kill();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function fixture() {
  await fs.mkdir(stage, { recursive: true });
  const base = await fs.realpath(stage);
  run = path.join(
    base,
    (packaged ? 'packaged-' : 'source-') +
      new Date().toISOString().replaceAll(':', '-') +
      '-' +
      randomUUID()
  );
  await fs.mkdir(run);
  run = await fs.realpath(run);
  assert.ok(inside(base, run));
  profile = path.join(run, 'generated-profile');
  collection = path.join(run, 'generated-collection');
  await fs.mkdir(collection);
  const shapes = [
    [240, 90],
    [240, 180],
    [240, 320],
    [120, 900],
    [360, 120],
    [180, 480],
    [240, 240]
  ];
  const buffers = await Promise.all(
    shapes.map(([width, height], i) =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 80 + i * 20, g: 110 + i * 9, b: 160 + i * 7 }
        }
      })
        .png()
        .toBuffer()
    )
  );
  for (let i = 0; i < 420; i++)
    await fs.writeFile(
      path.join(collection, 'image-' + String(i).padStart(3, '0') + '.png'),
      buffers[i % buffers.length]
    );
  for (let i = 0; i < 13; i++) {
    const folder = path.join(collection, '分组-' + String(i).padStart(2, '0'));
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'short.png'), buffers[0]);
    await fs.writeFile(path.join(folder, 'long.png'), buffers[3]);
  }
  report.fixture = {
    directMedia: 420,
    subfolders: 13,
    nestedMedia: 26,
    directItems: 433,
    shapes,
    profile,
    collection
  };
  report.run = run;
  console.log('ISOLATED ' + run);
}
function seedAssociation() {
  assert.equal(app, undefined, 'Only seed the closed generated database');
  const file = path.join(profile, 'library.sqlite');
  assert.ok(inside(run, file));
  const db = new DatabaseSync(file);
  try {
    const subject = {
      id: subjectId,
      type: 4,
      name: 'Generated retained association',
      name_cn: '隔离关联样本',
      summary: 'Generated fixture only',
      images: {},
      infobox: []
    };
    db.exec('BEGIN');
    db.prepare('INSERT OR REPLACE INTO metadata(id,json,updated) VALUES(?,?,?)').run(
      subjectId,
      JSON.stringify(subject),
      Date.now()
    );
    const result = db
      .prepare(
        "UPDATE nodes SET subject_id=?,manual_subject=1,search_type=4,album_kind='work',confirmed=1,match_review=0 WHERE id=?"
      )
      .run(subjectId, idFor(path.join(collection, '分组-00')));
    assert.equal(Number(result.changes), 1);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  report.associationFixture = {
    subjectId,
    originalPath: path.join(collection, '分组-00'),
    seededWhileClosed: true
  };
}
async function scrollTo(index) {
  await page.evaluate((index) => {
    const viewport = $('#viewport'),
      origin =
        $('#virtual-grid').getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
    viewport.scrollTop = origin + grid.getPosition(index).top - 180;
    grid.render();
  }, index);
  await page.waitForFunction((index) => grid.items.has(index) && grid.loading.size === 0, index);
  await settle();
}
async function geometry(label, complete = false) {
  const evidence = await page.evaluate(
    ({ label, complete }) => {
      const rects = [...grid.cards].map(([index, element]) => {
        const r = element.getBoundingClientRect(),
          p = grid.getPosition(index);
        return {
          index,
          id: element.dataset.id,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          expected: p
        };
      });
      const overlaps = [];
      for (let a = 0; a < rects.length; a++)
        for (let b = a + 1; b < rects.length; b++) {
          const x = rects[a],
            y = rects[b];
          if (
            Math.min(x.right, y.right) - Math.max(x.left, y.left) > 0.75 &&
            Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 0.75
          )
            overlaps.push([x.index, y.index]);
        }
      const rows = [...grid.items]
        .sort((a, b) => a[0] - b[0])
        .map(([index, node]) => ({
          index,
          kind: node.kind,
          width: node.width,
          height: node.height,
          p: grid.getPosition(index)
        }));
      const mismatches = [],
        boundaries = [],
        folderHeight = grid.rowHeight - grid.gap;
      if (complete) {
        const columns = Array.from(
          { length: grid.cols },
          (_, c) =>
            Math.floor(grid.folders / grid.cols) * grid.rowHeight +
            (c < grid.folders % grid.cols ? grid.rowHeight : 0)
        );
        for (const row of rows.filter((row) => row.index >= grid.folders)) {
          const column = columns.indexOf(Math.min(...columns)),
            p = row.p;
          if (
            Math.abs(p.top - columns[column]) > 0.75 ||
            Math.abs(p.left - (grid.offsetX + column * (grid.width + grid.gap))) > 0.75
          )
            mismatches.push({
              index: row.index,
              actual: p,
              expectedColumn: column,
              expectedTop: columns[column]
            });
          if (row.index === 180 || row.index === 360)
            boundaries.push({
              index: row.index,
              column,
              top: p.top,
              previousColumns: [...columns]
            });
          columns[column] = p.top + p.height + 8;
        }
      }
      return {
        label,
        count: grid.total,
        cached: rows.length,
        cols: grid.cols,
        width: grid.width,
        folderHeight,
        rects,
        overlaps,
        mismatches,
        boundaries,
        oversize: rows.filter(
          (row) => row.kind !== 'folder' && row.p.height > 2 * folderHeight + 0.75
        ),
        dimensionsKnown: rows.filter(
          (row) => row.kind !== 'folder' && row.width > 0 && row.height > 0
        ).length,
        overflow: $('#viewport').scrollWidth > $('#viewport').clientWidth + 1
      };
    },
    { label, complete }
  );
  assert.ok(evidence.rects.length > 0, label + ': actual cards exist');
  assert.deepEqual(evidence.overlaps, [], label + ': actual DOM card rectangles must not overlap');
  assert.deepEqual(evidence.oversize, [], label + ': whole media card cap is twice folder height');
  assert.equal(evidence.overflow, false);
  for (const rect of evidence.rects)
    assert.ok(
      Math.abs(rect.height - rect.expected.height) <= 1,
      label + ': DOM height equals allocated geometry at ' + rect.index
    );
  if (complete) {
    assert.equal(
      evidence.cached,
      evidence.count,
      'All three real API pages must be cached for skyline replay'
    );
    assert.equal(
      evidence.boundaries.length,
      2,
      'Both 179/180 and 359/360 boundaries are exercised'
    );
    assert.deepEqual(
      evidence.mismatches,
      [],
      label + ': global shortest-column skyline continues across API pages'
    );
    assert.equal(evidence.dimensionsKnown, 420, 'Layout uses known real image dimensions');
  }
  return evidence;
}
async function recordAnchorDiagnostics(phase) {
  const evidence = await page.evaluate((phase) => {
    if (!window.__interactionAnchorDiagnostics) {
      const state = { events: [] };
      state.read = (phase) => {
        const before = window.__interactionAnchor,
          entry = before && [...grid.items].find(([, node]) => node.id === before.id),
          card = entry && grid.cards.get(entry[0]),
          viewport = $('#viewport'),
          gridElement = $('#virtual-grid'),
          active = document.activeElement;
        const rect = (element) => {
          if (!element) return null;
          const value = element.getBoundingClientRect();
          return {
            top: value.top,
            bottom: value.bottom,
            left: value.left,
            width: value.width,
            height: value.height
          };
        };
        const identity = (element) =>
          element
            ? {
                tag: element.tagName,
                id: element.id,
                className: String(element.className),
                dataId: element.dataset?.id
              }
            : null;
        return {
          phase,
          time: performance.now(),
          wall: Date.now(),
          id: before?.id,
          index: entry?.[0],
          savedOffset: before?.offset,
          cardRect: rect(card),
          styleTop: card?.style.top,
          offsetTop: card?.offsetTop,
          offsetParent: identity(card?.offsetParent),
          gridPosition: entry ? { ...grid.getPosition(entry[0]) } : null,
          cardTransform: card ? getComputedStyle(card).transform : null,
          cardTranslate: card ? getComputedStyle(card).translate : null,
          cardTransition: card ? getComputedStyle(card).transition : null,
          shellTransform: card?.querySelector('.cover-shell')
            ? getComputedStyle(card.querySelector('.cover-shell')).transform
            : null,
          viewportRect: rect(viewport),
          gridRect: rect(gridElement),
          scrollTop: viewport.scrollTop,
          scrollHeight: viewport.scrollHeight,
          clientHeight: viewport.clientHeight,
          toolbarRect: rect($('#toolbar')),
          refreshRect: rect($('#refresh-button')),
          footerRect: rect(document.querySelector('main > .statusbar')),
          active: identity(active),
          activeTransform: active ? getComputedStyle(active).transform : null,
          cardHovered: card?.matches(':hover'),
          cardFocused: card?.matches(':focus-visible'),
          hoveredCards: [...document.querySelectorAll('.album-card:hover')].map(identity),
          loadVersion: S.loadVersion,
          revision: S.rev,
          busy: libraryRefreshBusy,
          scanActive,
          growingTask: !!growingTask,
          growingTimer: growingTimer !== null,
          growingDirty,
          gridGrowing: !!grid.growing
        };
      };
      const observe = (event) => {
        if (state.events.length < 256) state.events.push(state.read(event.type));
      };
      $('#viewport').addEventListener('scroll', observe, { passive: true });
      for (const type of ['pointerdown', 'click', 'focusin', 'focusout'])
        document.addEventListener(type, observe, { capture: true, passive: true });
      window.__interactionAnchorDiagnostics = state;
    }
    const state = window.__interactionAnchorDiagnostics;
    return { snapshot: state.read(phase), events: state.events.slice() };
  }, phase);
  (report.anchorDiagnostics ||= []).push(evidence);
  // Persist before assertions so a failure cannot discard the before/click/settle evidence.
  await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
async function rememberAnchor() {
  return page.evaluate(() => {
    const anchor = captureDisplayAnchor();
    if (anchor.kind !== 'grid') throw new Error('Expected real grid anchor');
    const node = grid.items.get(anchor.index),
      card = grid.cards.get(anchor.index);
    if (!node || !card || node.kind === 'folder')
      throw new Error('Expected loaded visible media anchor');
    window.__interactionAnchor = {
      id: node.id,
      card,
      image: card.querySelector('img'),
      src: card.querySelector('img')?.src,
      offset: card.getBoundingClientRect().top,
      loadVersion: S.loadVersion,
      revision: S.rev,
      items: grid.items
    };
    return {
      id: node.id,
      offset: card.getBoundingClientRect().top,
      scroll: $('#viewport').scrollTop
    };
  });
}
async function assertAnchor(label) {
  const state = await page.evaluate(() => {
    const before = window.__interactionAnchor,
      entry = [...grid.items].find(([, node]) => node.id === before.id),
      card = entry && grid.cards.get(entry[0]);
    return {
      id: before.id,
      found: !!entry,
      cardSame: card === before.card,
      imageSame: card?.querySelector('img') === before.image,
      srcSame: card?.querySelector('img')?.src === before.src,
      offsetDelta: card ? card.getBoundingClientRect().top - before.offset : null,
      versionSame: S.loadVersion === before.loadVersion,
      revisionSame: S.rev === before.revision,
      cacheSame: grid.items === before.items,
      scroll: $('#viewport').scrollTop
    };
  });
  assert.equal(state.found, true, label + ': anchor ID is retained');
  for (const key of [
    'cardSame',
    'imageSame',
    'srcSame',
    'versionSame',
    'revisionSame',
    'cacheSame'
  ])
    assert.equal(state[key], true, label + ': ' + key);
  assert.ok(
    Math.abs(state.offsetDelta) <= 1,
    label + ': preserve pixel scroll anchor: ' + JSON.stringify(state)
  );
  return state;
}
async function refresh(label) {
  const marker = await app.evaluate(() => ({
    events: globalThis.__interactionMain.events.length,
    calls: globalThis.__interactionMain.calls.length
  }));
  const refreshButton = page.locator('#refresh-button');
  await expect(refreshButton).toBeEnabled();
  await expect(refreshButton).toBeVisible();
  const box = await refreshButton.boundingBox(),
    viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box && box.width > 0 && box.height > 0, 'Refresh has a visible click target');
  assert.ok(
    box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= viewport.width &&
      box.y + box.height <= viewport.height,
    'Refresh click target is already entirely inside the viewport'
  );
  if (label === 'unchanged') await recordAnchorDiagnostics('before-toolbar-click');
  // Locator.click auto-scroll shifted this sticky target's scrollport by 2px before pointerdown.
  // Its visible center receives the same native pointer/click events without automation scrolling.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  if (label === 'unchanged') await recordAnchorDiagnostics('after-toolbar-click');
  await settle();
  if (label === 'unchanged') await recordAnchorDiagnostics('after-settle');
  // The real main library:refresh wrapper resolves get/root, then sends worker scan.
  // ElectronApplication.evaluate passes its Electron module before the supplied argument.
  const main = await app.evaluate(
    (_electron, marker) => ({
      events: globalThis.__interactionMain.events.slice(marker.events),
      calls: globalThis.__interactionMain.calls
        .slice(marker.calls)
        .filter((call) => call.method === 'scan')
    }),
    marker
  );
  const online = main.events.filter(
    (event) =>
      event.type === 'online' &&
      (event.data?.active ||
        (event.data?.remaining ?? event.data?.pending) > 0 ||
        event.data?.discovering ||
        event.data?.paused)
  );
  assert.deepEqual(online, [], label + ': filesystem refresh must not start an online batch');
  assert.equal(main.calls.length, 1);
  assert.ok(main.calls[0].reply && !main.calls[0].error);
  return main;
}
async function boundFolder(name) {
  const result = await rpc('list', { parent: idFor(collection), filter: 'folders', limit: 180 });
  const node = result.items.find((node) => node.name === name);
  assert.ok(node, 'Folder exists after refresh: ' + name);
  const hydrated = await rpc('get', { id: node.id });
  assert.equal(hydrated.subject_id, subjectId);
  assert.equal(hydrated.manual_subject, 1);
  assert.equal(hydrated.metadata?.id, subjectId);
  return { id: hydrated.id, name: hydrated.name, subjectId: hydrated.subject_id };
}
(async () => {
  await fixture();
  await launch('initial-real-import');
  await rpc('settings', { key: 'autoMatch', value: false });
  await rpc('settings', { key: 'watchChanges', value: false });
  await rpc('settings', { key: 'metadataOnboardingSeen', value: true });
  await page.keyboard.press('Escape');
  const imported = await rpc('import', { onlineMatch: false });
  assert.equal(imported.cancelled, false);
  assert.equal(imported.errors, 0);
  await page.waitForFunction(() => S.roots.length === 1);
  assert.equal((await rpc('get', { id: idFor(collection) })).files, 446);
  // Populate real cached dimensions via the worker before measuring the next startup.
  // Four small local PNG reads at a time; this is fixture preparation, not a throughput test.
  for (let first = 0; first < 420; first += 4) {
    await Promise.all(
      Array.from({ length: Math.min(4, 420 - first) }, (_, offset) => {
        const file = path.join(
          collection,
          'image-' + String(first + offset).padStart(3, '0') + '.png'
        );
        return rpc('mediaInfo', { id: idFor(file) });
      })
    );
  }
  await closeApp();
  seedAssociation();
  await launch('cached-profile-restart');
  await app.context().addInitScript(observeRenderer);
  await check(
    'cached renderer first paint is real imported content before optional statistics',
    async () => {
      await app.evaluate(() => {
        globalThis.__interactionMain.calls.length = 0;
      });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () =>
          typeof window.__interactionProbe?.firstFrame === 'number' &&
          typeof window.__interactionProbe?.firstDecoded === 'number'
      );
      const probe = await page.evaluate(() => window.__interactionProbe);
      await expect
        .poll(() =>
          app.evaluate((_electron, origin) => {
            const calls = globalThis.__interactionMain.calls.filter((call) => call.time >= origin);
            const init = calls.find(
              (call) => call.method === 'init' && call.args?.lightweight === true
            );
            return Boolean(
              init &&
                calls.some((call) => call.method === 'statistics' && call.request > init.request)
            );
          }, probe.origin)
        )
        .toBe(true);
      const calls = await app.evaluate(
        (_electron, origin) =>
          globalThis.__interactionMain.calls.filter((call) => call.time >= origin),
        probe.origin
      );
      // A queued IPC from the previous document may arrive after the new timeOrigin.
      // Follow this document's lightweight init before choosing its optional work.
      const init = calls.find((call) => call.method === 'init' && call.args?.lightweight === true),
        stats = calls.find((call) => call.method === 'statistics' && call.request > init?.request);
      assert.equal(init?.args?.lightweight, true);
      assert.ok(probe.firstId, 'A real data-id card appeared');
      assert.ok(probe.firstDecoded >= 0, 'Actual generated cover decoded');
      assert.ok(
        stats && stats.time >= probe.firstNodeWall,
        'Optional statistics starts after cached content enters DOM'
      );
      assert.equal((await rpc('init', { lightweight: true })).stats, null);
      return {
        timingScope:
          'Real cached renderer reload after owned process restart; not cold OS/process FCP',
        processLaunchToReadyMs: session.launchToReadyMs,
        renderer: probe,
        calls: calls.filter((call) =>
          ['init', 'statistics', 'localIndexStatus', 'list'].includes(call.method)
        )
      };
    }
  );
  await page.evaluate((parent) => navigate({ parent }), idFor(collection));
  await page.waitForFunction(() => grid.active && grid.total === 433);
  await settle();
  await check(
    'three API pages retain mixed-folder global skyline, actual rectangles and height cap',
    async () => {
      const samples = [];
      for (const index of [0, 179, 180, 359, 360, 420, 0]) {
        await scrollTo(index);
        samples.push(await geometry('index-' + index));
      }
      await page.waitForFunction(() => grid.items.size === grid.total);
      samples.push(await geometry('complete-three-page-skyline', true));
      await shot('mixed-folder-natural-media');
      return samples;
    }
  );
  await check(
    'all presets and real range keyboard input preserve focus and scroll anchor',
    async () => {
      const samples = [];
      await scrollTo(200);
      const widths = await page.evaluate(() => cardPresets());
      for (const width of widths) {
        const beforeAnchor = await page.evaluate(() => {
          const anchor = captureDisplayAnchor();
          return { ...anchor, id: grid.items.get(anchor.index)?.id };
        });
        await page.locator(`#card-size-controls [data-density="${width}"]`).focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (width) => displayChangeTask === null && S.settings.density === width,
          width
        );
        await expect(page.locator(`#card-size-controls [data-density="${width}"]`)).toBeFocused();
        await expect(page.locator(`#card-size-controls [data-density="${width}"]`)).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        await settle();
        const afterAnchor = await page.evaluate((anchor) => {
          const viewport = $('#viewport').getBoundingClientRect();
          const top =
            $('#virtual-grid').getBoundingClientRect().top -
            viewport.top +
            grid.getPosition(anchor.index).top;
          return { id: grid.items.get(anchor.index)?.id, offsetDelta: top - anchor.offset };
        }, beforeAnchor);
        assert.equal(afterAnchor.id, beforeAnchor.id, 'Preset retains anchor identity');
        assert.ok(Math.abs(afterAnchor.offsetDelta) <= 1, 'Preset retains pixel scroll anchor');
        samples.push({ geometry: await geometry('preset-' + width), beforeAnchor, afterAnchor });
      }
      await page.locator('#density-button').click();
      const range = page.locator('#modal input[type="range"][data-appearance-key="density"]');
      await expect(range).toHaveCount(1);
      await range.focus();
      const before = Number(await range.inputValue());
      const anchor = await page.evaluate(() => captureDisplayAnchor());
      await page.keyboard.press('ArrowRight');
      await expect(range).toHaveValue(String(before + 1));
      await expect(range).toBeFocused();
      await expect
        .poll(async () => (await rpc('init', { lightweight: true })).settings.density)
        .toBe(before + 1);
      const restored = await page.evaluate((anchor) => {
        const vp = $('#viewport').getBoundingClientRect(),
          top =
            $('#virtual-grid').getBoundingClientRect().top -
            vp.top +
            grid.getPosition(anchor.index).top;
        return { id: grid.items.get(anchor.index)?.id, offsetDelta: top - anchor.offset };
      }, anchor);
      assert.ok(Math.abs(restored.offsetDelta) <= 1, 'Range preview retains pixel anchor');
      await page.keyboard.press('Escape');
      await expect(page.locator('#modal')).not.toBeVisible();
      await settle();
      samples.push(await geometry('range-keyboard'));
      return { samples, before, persisted: before + 1, restored };
    }
  );
  await scrollTo(200);
  await check(
    'toolbar is unique, follows density, and shares real busy state with the modal',
    async () => {
      await expect(page.locator('#refresh-button')).toHaveCount(1);
      assert.equal(
        await page.locator('#density-button').evaluate((button) => button.nextElementSibling?.id),
        'refresh-button'
      );
      await page.locator('#density-button').click();
      await expect(page.locator('#display-refresh-button')).toHaveCount(1);
      const busy = await page.locator('#display-refresh-button').evaluate((button) => {
        button.click();
        return [...document.querySelectorAll('#refresh-button,#display-refresh-button')].map(
          (button) => ({ disabled: button.disabled, busy: button.getAttribute('aria-busy') })
        );
      });
      assert.equal(busy.length, 2);
      assert.ok(busy.every((button) => button.disabled && button.busy === 'true'));
      await settle({ media: false });
      await expect(page.locator('#display-refresh-button')).toBeEnabled();
      await page.keyboard.press('Escape');
      await settle();
      return busy;
    }
  );
  await check(
    'unchanged refresh preserves binding, decoded card identity and pixel scroll anchor without online work',
    async () => {
      const before = await rememberAnchor();
      await recordAnchorDiagnostics('remembered-anchor');
      const binding = await boundFolder('分组-00');
      const activity = await refresh('unchanged');
      return { before, binding, activity, after: await assertAnchor('unchanged') };
    }
  );
  await check(
    'rename, addition and deletion use toolbar reconciliation while retaining binding and visible cache',
    async () => {
      const records = [];
      await rememberAnchor();
      const renamed = path.join(collection, '改名-保留关联');
      assert.ok(inside(run, renamed));
      const original = path.join(collection, '分组-00');
      assert.ok(inside(run, original));
      // Both resolved endpoints are generated fixture paths verified above; never move user data.
      await fs.rename(original, renamed);
      await refresh('rename');
      records.push({
        action: 'rename',
        binding: await boundFolder('改名-保留关联'),
        anchor: await assertAnchor('rename')
      });
      await rememberAnchor();
      const added = path.join(collection, '新增-隔离目录');
      assert.ok(inside(run, added));
      await fs.mkdir(added);
      await fs.copyFile(path.join(collection, 'image-000.png'), path.join(added, 'new.png'));
      await refresh('add');
      assert.equal((await rpc('list', { parent: idFor(collection), limit: 1 })).total, 434);
      records.push({
        action: 'add',
        binding: await boundFolder('改名-保留关联'),
        anchor: await assertAnchor('add')
      });
      await rememberAnchor();
      const deleted = path.resolve(added, 'new.png');
      assert.ok(inside(run, deleted));
      // Delete only the exact generated file and its now-empty generated directory; no recursive cleanup.
      await fs.unlink(deleted);
      await fs.rmdir(added);
      await refresh('delete');
      assert.equal((await rpc('list', { parent: idFor(collection), limit: 1 })).total, 433);
      records.push({
        action: 'delete',
        binding: await boundFolder('改名-保留关联'),
        anchor: await assertAnchor('delete')
      });
      records.push(await geometry('after-rename-add-delete'));
      await shot('after-incremental-refresh');
      return records;
    }
  );
  await check(
    'renderer completes with no pageerror or unhandled rejection across the interaction chain',
    async () => {
      const probe = await page.evaluate(() => window.__interactionProbe);
      assert.deepEqual(report.errors, []);
      assert.deepEqual(probe.unhandled, []);
      const online = (await rpc('init', { lightweight: true })).online;
      assert.equal(!!online.active, false);
      assert.equal(Number(online.remaining ?? online.pending ?? 0), 0);
      return { errors: report.errors, unhandled: probe.unhandled, online };
    }
  );
  report.passed = true;
})()
  .catch((error) => {
    report.error = error.stack || String(error);
    console.error(report.error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeApp();
    } catch (error) {
      report.passed = false;
      report.closeError = error.stack || String(error);
      process.exitCode = 1;
    }
    report.finished = new Date().toISOString();
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
      console.log('REPORT ' + file);
    }
  });
