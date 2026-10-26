'use strict';
// Lead runs this serially: node scripts/check-browser-refinement.cjs
// Source Electron only. Fixtures, SQLite and Chromium state stay below realpath(artifacts).
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const verifyMigration = process.env.ACG_VERIFY_SORT_MIGRATION === '1';
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = {
  checks: [],
  errors: [],
  screenshots: [],
  dimensions: [],
  layouts: [],
  externalRequests: [],
  scope: 'Source Electron; generated offline media; isolated profile; run all UI checks serially.',
  runtime: { mode: 'source', executable: require('electron') }
};
let app,
  page,
  run,
  profile,
  stage = 'setup';
const closeEnough = (actual, expected, label, tolerance = 2) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: actual=${actual}, expected=${expected}, tolerance=${tolerance}`
  );
async function check(name, action) {
  stage = name;
  try {
    await action();
    report.checks.push({ name, status: 'passed' });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function seed(collection, mediaPaths) {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent_index.sqlite')
    }
  });
  let sequence = 0,
    readyTimer;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Fixture worker ready timeout')), 30000);
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') {
        clearTimeout(readyTimer);
        resolve();
      }
      const request = pending.get(message.request);
      if (!request) return;
      pending.delete(message.request);
      clearTimeout(request.timer);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
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
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    await call('settings', { key: 'details', value: true });
    await call('settings', { key: 'ratio', value: 'poster' });
    await call('scan', { path: collection, onlineMatch: false, subjectTypes: [4] });
    // Persist real image measurements before launching; do not race the background metadata queue.
    for (const file of mediaPaths) await call('mediaInfo', { id: idFor(file) });
    await call('shutdown');
  } finally {
    clearTimeout(readyTimer);
    for (const request of pending.values()) clearTimeout(request.timer);
    await worker.terminate();
  }
}
async function seedOldSortKeys(parent) {
  const db = new DatabaseSync(path.join(profile, 'library.sqlite'));
  try {
    db.exec('BEGIN');
    const insert = db.prepare(
      "INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,missing) VALUES(?,?,?,?,?,?,'image',1,1)"
    );
    for (let i = 0; i < 100000; i++) {
      const name = `张${i}.png`;
      insert.run(
        (i + 1).toString(16).padStart(24, '0'),
        parent,
        parent,
        path.join(run, 'missing_migration_fixture', name),
        name,
        name
      );
    }
    db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(
      'naturalSortVersion',
      JSON.stringify('legacy-migration-fixture')
    );
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: report.runtime.executable,
    args: ['.'],
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
  if (verifyMigration)
    await check(
      'old 100k-entry library shows a usable window and migration progress before init finishes',
      async () => {
        await page.waitForFunction(
          () =>
            document.querySelector('#progress-title')?.textContent === '正在整理文件名称排序' &&
            document.querySelector('#progress-panel')?.dataset.state === 'active' &&
            typeof S !== 'undefined' &&
            S.loadVersion === 0
        );
        assert.equal(
          await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
          true
        );
        await shot('startup_sort_migration_progress');
      }
    );
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && S.settings.nickname !== undefined,
    null,
    { timeout: verifyMigration ? 60000 : 15000 }
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.mouse.move(0, 0);
  const actual = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    version: app.getVersion(),
    isPackaged: app.isPackaged
  }));
  Object.assign(report.runtime, actual);
  assert.equal(actual.isPackaged, false, 'verify the current source app');
  assert.equal(path.resolve(actual.userData), path.join(profile, 'chromium-profile'));
}
async function resize(width, height, allowMachineLimit = false) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(width, height);
    },
    { width, height }
  );
  let exact = true;
  try {
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height },
      { timeout: allowMachineLimit ? 2500 : 10000 }
    );
  } catch (error) {
    if (!allowMachineLimit) throw error;
    exact = false;
  }
  const actual = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio
  }));
  const native = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize()
  );
  report.dimensions.push({ requested: { width, height }, actual, native, exact });
  closeEnough(actual.width, native[0], 'CSS content width versus BrowserWindow', 0);
  closeEnough(actual.height, native[1], 'CSS content height versus BrowserWindow', 0);
  if (exact) {
    assert.equal(actual.width, width);
    assert.equal(actual.height, height);
  }
  return exact;
}
async function go(parent, options = {}) {
  await page.evaluate(({ parent, options }) => navigate({ parent, ...options }), {
    parent,
    options
  });
  await page.waitForFunction(
    (parent) =>
      S.parent === parent && grid.active && grid.cards.size > 0 && grid.loading.size === 0,
    parent
  );
}
async function top() {
  await page.evaluate(() => {
    $('#viewport').scrollTop = 0;
    grid.render();
  });
  await page.waitForFunction(() => grid.cards.has(0) && $('#viewport').scrollTop === 0);
  await page.mouse.move(0, 0);
}
async function density(value) {
  await top();
  await page.locator(`#card-size-controls [data-density="${value}"]`).click();
  await page.mouse.move(0, 0);
  await page.waitForFunction(
    (value) =>
      displayChangeTask === null && Number(S.settings.density) === value && grid.loading.size === 0,
    value
  );
  await expect(page.locator(`#card-size-controls [data-density="${value}"]`)).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await top();
}
async function verifyLayout(preset, mediaIds) {
  await density(preset);
  const row = await page.evaluate(() => {
    const el = $('#virtual-grid'),
      rect = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    const first = [...grid.cards.entries()]
      .filter(([i]) => i < grid.cols)
      .sort((a, b) => a[0] - b[0])
      .map(([i, card]) => {
        const r = card.getBoundingClientRect();
        return {
          index: i,
          width: r.width,
          height: r.height,
          left: r.left,
          right: r.right,
          top: r.top,
          kind: grid.items.get(i)?.kind
        };
      });
    const contentLeft =
      rect.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft);
    const contentRight =
      rect.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight);
    return {
      cols: grid.cols,
      width: grid.width,
      gap: grid.gap,
      contentLeft,
      contentRight,
      contentWidth: contentRight - contentLeft,
      first,
      folders: grid.folders,
      total: grid.total,
      firstMedia: grid.items.get(grid.folders)?.kind
    };
  });
  assert.ok(row.folders >= 25);
  assert.ok(row.cols > 1 && row.folders >= row.cols, 'fixture has a complete folder row');
  assert.equal(row.first.length, row.cols);
  assert.equal(row.firstMedia, 'image', 'folders precede media in the actual query');
  assert.ok(row.first.every((item) => item.kind === 'folder'));
  const distributed = (row.contentWidth - (row.cols - 1) * row.gap) / row.cols;
  closeEnough(row.width, distributed, 'grid.width distributes available content width', 0.05);
  closeEnough(row.first[0].left, row.contentLeft, 'first folder starts at content left');
  closeEnough(
    row.first.at(-1).right,
    row.contentRight,
    'final folder ends at content right; no right blank'
  );
  for (let i = 0; i < row.first.length; i++) {
    closeEnough(row.first[i].width, row.width, 'actual folder width');
    closeEnough(row.first[i].top, row.first[0].top, 'complete first row');
    if (i)
      closeEnough(row.first[i].left - row.first[i - 1].right, row.gap, 'actual inter-card gap');
  }
  assert.ok(row.width >= preset - 0.05);
  if (row.contentWidth - row.cols * preset - (row.cols - 1) * row.gap > 0.1)
    assert.ok(row.width > preset, 'spare width is assigned to cards');
  await shot(`density_${preset}_folder_row`);
  const media = [];
  for (const id of mediaIds) {
    await page.evaluate((id) => {
      const found = [...grid.items.entries()].find(([, n]) => n.id === id);
      if (!found) throw new Error('Imported media missing: ' + id);
      const position = grid.getPosition(found[0]);
      const viewport = $('#viewport'),
        origin =
          $('#virtual-grid').getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop;
      const clearance = $('#toolbar').getBoundingClientRect().height + 24;
      viewport.scrollTop = Math.max(0, origin + position.top - clearance);
      grid.render();
    }, id);
    const card = page.locator(`#virtual-grid .media-card[data-id="${id}"]`);
    await expect(card).toBeVisible();
    await expect
      .poll(() => card.locator('img').evaluate((image) => image.complete && image.naturalWidth > 0))
      .toBe(true);
    const metrics = await card.evaluate((card) => {
      const r = card.getBoundingClientRect(),
        shell = card.querySelector('.cover-shell').getBoundingClientRect();
      const image = card.querySelector('img'),
        ir = image.getBoundingClientRect();
      const vp = $('#viewport').getBoundingClientRect(),
        toolbar = $('#toolbar').getBoundingClientRect();
      return {
        id: card.dataset.id,
        width: r.width,
        height: r.height,
        top: r.top,
        bottom: r.bottom,
        shellHeight: shell.height,
        imageHeight: ir.height,
        objectFit: getComputedStyle(image).objectFit,
        objectPosition: getComputedStyle(image).objectPosition,
        clamped: card.dataset.mediaClamped,
        viewportTop: vp.top,
        viewportBottom: vp.bottom,
        visibleTop: Math.max(vp.top, toolbar.bottom),
        detailsVisible: !card.querySelector('.card-info').hidden
      };
    });
    closeEnough(metrics.width, row.first[0].width, 'media and folder have the same actual width');
    assert.ok(
      metrics.height <= 2 * row.first[0].height + 2,
      'entire media card is at most twice the same-width folder height'
    );
    assert.ok(
      metrics.top >= metrics.visibleTop - 2 && metrics.bottom <= metrics.viewportBottom + 2,
      'entire media card is visible inside viewport, below toolbar: ' + JSON.stringify(metrics)
    );
    assert.equal(metrics.detailsVisible, true);
    if (id === mediaIds[0]) {
      assert.equal(metrics.clamped, 'true');
      assert.equal(metrics.objectFit, 'cover');
      assert.equal(
        metrics.objectPosition,
        '50% 0%',
        'clamped image shows the top despite inline crop defaults'
      );
      closeEnough(
        metrics.height,
        2 * row.first[0].height,
        'ultratall clamp includes media details'
      );
    } else {
      assert.equal(metrics.clamped, 'false');
      assert.equal(metrics.objectFit, 'contain', 'ordinary media keeps its natural aspect ratio');
    }
    media.push(metrics);
    await shot(`density_${preset}_${id === mediaIds[0] ? 'ultratall' : 'ordinary'}_media`);
  }
  report.layouts.push({
    preset,
    viewport: await page.evaluate(() => [innerWidth, innerHeight]),
    row,
    media
  });
}
async function openBlankMenu() {
  const event = await page.evaluate(() => {
    const target = $('#virtual-grid'),
      vp = $('#viewport');
    // Find an actual visible grid gap, while requesting placement at the viewport's lower-right.
    const rect = target.getBoundingClientRect(),
      bounds = vp.getBoundingClientRect();
    const x = rect.left + grid.width + grid.gap / 2;
    let y;
    for (
      let value = Math.max(rect.top + 2, bounds.top + $('#toolbar').offsetHeight + 24);
      value < Math.min(rect.bottom, bounds.bottom) - 2;
      value += 4
    ) {
      if (document.elementFromPoint(x, value) === target) {
        y = value;
        break;
      }
    }
    if (y == null) throw new Error('No visible virtual-grid gap for blank context menu');
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: innerWidth - 1,
      clientY: innerHeight - 1
    });
    target.dispatchEvent(event);
    return { prevented: event.defaultPrevented, gap: { x, y }, target: target.id };
  });
  assert.equal(event.prevented, true);
  const menu = page.locator('#context-menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-label', '页面操作');
  const bounds = await menu.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight
    };
  });
  assert.ok(
    bounds.left >= 0 &&
      bounds.top >= 0 &&
      bounds.right <= bounds.width &&
      bounds.bottom <= bounds.height
  );
  closeEnough(bounds.right, bounds.width - 8, 'lower-right menu horizontal clamp');
  closeEnough(bounds.bottom, bounds.height - 8, 'lower-right menu vertical clamp');
  return { ...event, bounds };
}
async function focusedIndex() {
  return page
    .locator('#context-menu')
    .evaluate((menu) =>
      [...menu.querySelectorAll('button:not(:disabled)')].indexOf(document.activeElement)
    );
}
async function verifyMenus(parent, theme) {
  await page.evaluate((theme) => changeTheme(theme), theme);
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.theme === theme && themeChangeTask === null,
    theme
  );
  await go(parent);
  await top();
  const placement = await openBlankMenu();
  const menu = page.locator('#context-menu');
  await expect(
    menu.getByRole('menuitemradio', { name: '按文件名称排序', exact: true })
  ).toHaveAttribute('aria-checked', 'true');
  const enabled = await menu.locator('button:enabled').count();
  assert.equal(await focusedIndex(), 0);
  for (const [key, index] of [
    ['ArrowDown', 1],
    ['ArrowUp', 0],
    ['ArrowUp', enabled - 1],
    ['Home', 0],
    ['End', enabled - 1]
  ]) {
    await page.keyboard.press(key);
    assert.equal(await focusedIndex(), index, theme + ' keyboard ' + key);
  }
  await shot(`${theme}_blank_context_menu`);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.locator('#viewport')).toBeFocused();
  await openBlankMenu();
  const version = await page.evaluate(() => S.loadVersion);
  await menu.getByRole('menuitemradio', { name: '按修改日期排序', exact: true }).click();
  await page.waitForFunction(
    (version) =>
      S.sort === 'modified' &&
      S.loadVersion > version &&
      grid.args?.sort === 'modified' &&
      grid.loading.size === 0,
    version
  );
  await expect(page.locator('#sort')).toHaveValue('modified');
  await top();
  await openBlankMenu();
  await expect(
    menu.getByRole('menuitemradio', { name: '按修改日期排序', exact: true })
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    menu.getByRole('menuitemradio', { name: '按文件名称排序', exact: true })
  ).toHaveAttribute('aria-checked', 'false');
  await menu.getByRole('menuitemradio', { name: '按文件名称排序', exact: true }).click();
  await page.waitForFunction(
    () => S.sort === 'name' && grid.args?.sort === 'name' && grid.loading.size === 0
  );
  await expect(page.locator('#sort')).toHaveValue('name');
  await top();
  await page
    .locator('#virtual-grid .album-card')
    .first()
    .dispatchEvent('contextmenu', { button: 2, clientX: 500, clientY: 350 });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-label', '项目操作');
  await expect(menu.getByRole('menuitem', { name: '属性…', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  const inputResults = await page.evaluate(() => {
    const generated = document.createElement('input');
    generated.id = 'browser_refinement_input';
    $('#viewport').append(generated);
    try {
      return [generated, $('#search'), $('#sort')].map((input) => {
        const e = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: 600,
          clientY: 300
        });
        input.dispatchEvent(e);
        return {
          id: input.id,
          prevented: e.defaultPrevented,
          menuHidden: $('#context-menu').hidden
        };
      });
    } finally {
      generated.remove();
    }
  });
  for (const input of inputResults) {
    assert.equal(input.prevented, false, input.id + ' retains native context menu');
    assert.equal(input.menuHidden, true, input.id + ' does not open browsing context menu');
  }
  await go(parent, { view: 'timeline' });
  await top();
  await openBlankMenu();
  for (const name of ['按文件名称排序', '按创建日期排序', '按修改日期排序', '按大小排序'])
    await expect(menu.getByRole('menuitemradio', { name, exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem', { name: /改为.*序排列/ })).toBeDisabled();
  await expect(page.locator('#sort')).toBeDisabled();
  await expect(page.locator('#sort-direction')).toBeDisabled();
  await page.keyboard.press('End');
  assert.equal(await focusedIndex(), (await menu.locator('button:enabled').count()) - 1);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focusedIndex(), 1, 'timeline navigation skips disabled sort entries');
  await shot(`${theme}_timeline_disabled_sorts`);
  await page.keyboard.press('Escape');
  await go(parent);
  (report.menus ||= []).push({ theme, placement, inputResults });
}
async function sendEvents(events) {
  await app.evaluate(({ BrowserWindow }, events) => {
    for (const event of events)
      BrowserWindow.getAllWindows()[0].webContents.send('library:event', event);
  }, events);
}
async function quietFor(milliseconds) {
  // Poll for a continuous quiet window; do not use fixed sleeps to claim settling.
  await page.evaluate(() => {
    window.__browserProbe.quietStart = performance.now();
  });
  await page.waitForFunction(
    (milliseconds) => {
      const p = window.__browserProbe;
      if (
        growingTimer !== null ||
        growingTask ||
        growingDirty ||
        grid.growing ||
        grid.loading.size
      ) {
        p.quietStart = performance.now();
        return false;
      }
      return performance.now() - p.quietStart >= milliseconds;
    },
    milliseconds,
    { polling: 50, timeout: 15000 }
  );
}
async function verifyBatching(parent, folderIds) {
  await go(parent);
  await page.waitForFunction(
    () => growingTimer === null && !growingTask && !growingDirty && !grid.growing
  );
  await page.evaluate(() => {
    const p = (window.__browserProbe = {
      schedule: 0,
      refresh: 0,
      grid: 0,
      done: 0,
      events: [],
      online: 0
    });
    p.originalSchedule = scheduleGrowingRefresh;
    p.originalRefresh = refreshGrowingView;
    p.originalGrid = grid.refreshGrowing;
    scheduleGrowingRefresh = function (...args) {
      p.schedule++;
      return p.originalSchedule.apply(this, args);
    };
    refreshGrowingView = async function (...args) {
      p.refresh++;
      return p.originalRefresh.apply(this, args);
    };
    grid.refreshGrowing = async function (...args) {
      p.grid++;
      try {
        return await p.originalGrid.apply(this, args);
      } finally {
        p.done++;
      }
    };
    p.unsubscribe = window.album.onEvent((event) => {
      if (event.type === 'changed' && event.data.matching) p.events.push(event.data.id);
      if (event.type === 'online') p.online++;
    });
  });
  const snapshot = () =>
    page.evaluate(() => {
      const p = window.__browserProbe;
      return {
        schedule: p.schedule,
        refresh: p.refresh,
        grid: p.grid,
        done: p.done,
        delivered: p.events.length,
        pending: matchRefreshBatch.pending
      };
    });
  const change = (id) => ({ type: 'changed', data: { id, matching: true } });
  try {
    await sendEvents(folderIds.slice(0, 9).map(change));
    await page.waitForFunction(() => window.__browserProbe.events.length === 9);
    await quietFor(1500);
    const nine = await snapshot();
    assert.deepEqual(nine, { schedule: 0, refresh: 0, grid: 0, done: 0, delivered: 9, pending: 9 });
    await sendEvents([change(folderIds[9])]);
    await page.waitForFunction(
      () => window.__browserProbe.done === 1 && !growingTask && growingTimer === null
    );
    await quietFor(1500);
    const ten = await snapshot();
    assert.deepEqual(ten, { schedule: 1, refresh: 1, grid: 1, done: 1, delivered: 10, pending: 0 });
    await sendEvents(folderIds.slice(10, 12).map(change));
    await page.waitForFunction(() => window.__browserProbe.events.length === 12);
    await quietFor(1500);
    const remainder = await snapshot();
    assert.deepEqual(remainder, {
      schedule: 1,
      refresh: 1,
      grid: 1,
      done: 1,
      delivered: 12,
      pending: 2
    });
    await sendEvents([
      {
        type: 'online',
        data: {
          active: false,
          remaining: 0,
          pending: 0,
          completed: 12,
          total: 12,
          discovering: false,
          paused: false
        }
      }
    ]);
    await page.waitForFunction(
      () =>
        window.__browserProbe.online > 0 &&
        window.__browserProbe.done === 2 &&
        !growingTask &&
        growingTimer === null
    );
    await quietFor(1500);
    const completed = await snapshot();
    assert.deepEqual(completed, {
      schedule: 2,
      refresh: 2,
      grid: 2,
      done: 2,
      delivered: 12,
      pending: 0
    });
    report.batching = { nine, ten, remainder, completed };
    await shot('matching_batch_complete');
  } finally {
    await page.evaluate(() => {
      const p = window.__browserProbe;
      scheduleGrowingRefresh = p.originalSchedule;
      refreshGrowingView = p.originalRefresh;
      grid.refreshGrowing = p.originalGrid;
      p.unsubscribe();
    });
  }
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'browser_refinement',
      new Date().toISOString().replace(/[^0-9A-Za-z]/g, '_') +
        '_' +
        crypto.randomUUID().replaceAll('-', '_')
    );
    profile = path.join(run, 'generated_profile');
    await fs.mkdir(profile, { recursive: true });
    report.run = run;
    report.profile = profile;
    const collection = path.join(run, 'generated_collection');
    const folders = Array.from({ length: 40 }, (_, i) =>
      path.join(collection, 'Folder_' + String(i).padStart(2, '0'))
    );
    const small = await sharp({
      create: { width: 48, height: 64, channels: 3, background: '#cbb7d8' }
    })
      .png()
      .toBuffer();
    for (const folder of folders) {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'cover.png'), small, { flag: 'wx' });
    }
    const tall = path.join(collection, 'Media_00_ultratall.png');
    const normal = path.join(collection, 'Media_01_ordinary.png');
    await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="5000"><rect width="100" height="5000" fill="#91b7d8"/><rect width="100" height="500" fill="#e5a7b7"/><rect y="500" width="100" height="2000" fill="#9bbdc4"/></svg>'
      )
    )
      .png()
      .toFile(tall);
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#9bbdc4' } })
      .png()
      .toFile(normal);
    report.fixtures = {
      collection,
      folders: folders.length,
      tall: { path: tall, width: 100, height: 5000 },
      normal
    };
    await seed(collection, [
      ...folders.map((folder) => path.join(folder, 'cover.png')),
      tall,
      normal
    ]);
    const parent = idFor(collection);
    if (verifyMigration) await seedOldSortKeys(parent);
    await launch();
    await check(
      'real CSS content dimensions request 3840x2160 with machine-limit fallback',
      async () => {
        if (!(await resize(3840, 2160, true))) {
          report.runtime.machineLimit =
            'BrowserWindow could not provide 3840x2160 CSS content; requested and native dimensions are recorded.';
          if (!(await resize(2560, 1440, true))) await resize(1920, 1080);
        }
      }
    );
    await go(parent);
    await check(
      'real imported directory contains folder-first one-level fixtures and measured ultratall media',
      async () => {
        const actual = await page.evaluate(
          async (parent) => ({
            current: S.current.path,
            query: queryArgs(),
            result: await api('list', { parent, sort: 'name', limit: 180 })
          }),
          parent
        );
        assert.equal(path.resolve(actual.current), collection);
        assert.equal(actual.query.parent, parent);
        assert.equal(actual.result.folders, folders.length);
        assert.equal(actual.result.total, folders.length + 2);
        assert.ok(actual.result.items.slice(0, folders.length).every((n) => n.kind === 'folder'));
        const node = actual.result.items.find((n) => n.id === idFor(tall));
        assert.ok(node, 'ultratall image is in the browsed directory');
        assert.equal(node.width, 100);
        assert.equal(node.height, 5000);
      }
    );
    for (const preset of [158, 186, 222])
      await check(`density ${preset}: distributed full row and bounded real media cards`, () =>
        verifyLayout(preset, [idFor(tall), idFor(normal)])
      );
    for (const theme of ['light', 'dark'])
      await check(
        `${theme}: blank and item menus, sort behavior, keyboard and timeline disabled actions`,
        () => verifyMenus(parent, theme)
      );
    await check(
      'main-process library:event matching changes refresh only at ten and flush final two',
      () => verifyBatching(parent, folders.map(idFor))
    );
    await check('no renderer errors, error toasts or network requests', async () => {
      await expect(page.locator('.toast.error')).toHaveCount(0);
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.externalRequests, []);
      await assert.rejects(fs.access(path.join(run, 'absent_index.sqlite')), { code: 'ENOENT' });
    });
    report.passed = true;
    stage = 'completed';
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) {
      try {
        await app.close();
      } catch (error) {
        report.errors.push({ stage: 'close', message: error.message });
        report.passed = false;
        process.exitCode = 1;
      }
    }
    report.stage = stage;
    if (report.errors.length) {
      report.passed = false;
      process.exitCode = 1;
    }
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    }
  }
})();
