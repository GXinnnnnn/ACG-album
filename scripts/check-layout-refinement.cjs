'use strict';
// Run serially only after the lead releases the GUI lane. Fixtures and profiles are generated here.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.env.ACG_EXECUTABLE
  ? path.resolve(process.env.ACG_EXECUTABLE)
  : require('electron');
const report = { checks: [], errors: [], previews: [], timelines: [], screenshots: [] };
let app, page, run, profile, albums, photos;
async function check(name, action) {
  try {
    await action();
    report.checks.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function seed() {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite')
    }
  });
  const pending = new Map();
  let sequence = 0;
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const item = pending.get(message.request);
        if (!item) return;
        pending.delete(message.request);
        clearTimeout(item.timer);
        message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
      });
    });
    const rpc = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++sequence,
          timer = setTimeout(() => reject(new Error('Seed RPC timeout: ' + method)), 30000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    await rpc('settings', { key: 'watchChanges', value: false });
    await rpc('settings', { key: 'autoMatch', value: false });
    for (const collection of [albums, photos])
      await rpc('scan', { path: collection, onlineMatch: false, subjectTypes: [4] });
    await rpc('setAlbumKind', { id: idFor(photos), kind: 'photo' });
    await rpc('shutdown');
  } finally {
    for (const item of pending.values()) clearTimeout(item.timer);
    await worker.terminate();
  }
}
async function resize(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await page.waitForFunction((width) => innerWidth === width, width);
}
async function snapshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function waitPreview() {
  await page.waitForFunction((parent) => {
    const preview = document.querySelector(
      `.collection-tile[data-id="${parent}"] .collection-preview`
    );
    if (!preview || preview.getAttribute('aria-busy') === 'true') return false;
    const columns = getComputedStyle(preview).gridTemplateColumns.trim().split(/\s+/).length;
    return preview.querySelectorAll('.album-card').length === Math.min(64, 2 * columns);
  }, idFor(albums));
}
async function overview() {
  await page.evaluate(() => navigate({}));
  const tile = page.locator(`.collection-tile[data-id="${idFor(albums)}"]`);
  if ((await tile.locator('.category-expand').getAttribute('aria-expanded')) !== 'true')
    await tile.locator('.category-expand').click();
  await waitPreview();
}
async function previewGeometry() {
  return page.evaluate((parent) => {
    const tile = document.querySelector(`.collection-tile[data-id="${parent}"]`),
      preview = tile.querySelector('.collection-preview'),
      style = getComputedStyle(preview),
      cards = [...preview.querySelectorAll('.album-card')],
      first = cards[0].getBoundingClientRect(),
      rows = [
        ...new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top * 100) / 100))
      ],
      columns = style.gridTemplateColumns.trim().split(/\s+/).length,
      right = preview.getBoundingClientRect().right - parseFloat(style.paddingRight),
      viewport = document.querySelector('#viewport'),
      viewportStyle = getComputedStyle(viewport),
      contentRight =
        viewport.getBoundingClientRect().left +
        viewport.clientWidth -
        parseFloat(viewportStyle.paddingRight),
      icons = [...tile.querySelectorAll('.category-enter,.category-expand')].map((button) => {
        const b = button.getBoundingClientRect(),
          s = button.querySelector('svg').getBoundingClientRect();
        return {
          name: button.className,
          x: s.left + s.width / 2 - b.left - b.width / 2,
          y: s.top + s.height / 2 - b.top - b.height / 2
        };
      });
    return {
      width: innerWidth,
      density: S.settings.density,
      theme: document.documentElement.dataset.theme,
      count: cards.length,
      columns,
      rows: rows.length,
      actualWidth: first.width,
      preset: parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--card-width')
      ),
      rowCounts: rows.map(
        (top) =>
          cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 0.75).length
      ),
      rightErrors: rows.map(
        (top) =>
          right -
          Math.max(
            ...cards
              .filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 0.75)
              .map((card) => card.getBoundingClientRect().right)
          )
      ),
      tileRightError: contentRight - tile.getBoundingClientRect().right,
      icons
    };
  }, idFor(albums));
}
async function assertPreview() {
  const result = await previewGeometry();
  report.previews.push(result);
  assert.equal(result.count, Math.min(64, result.columns * 2));
  assert.equal(result.rows, 2);
  assert.deepEqual(result.rowCounts, [result.columns, result.columns]);
  assert.ok(result.actualWidth >= result.preset - 0.75);
  assert.ok(Math.abs(result.tileRightError) <= 0.75, 'expanded tile fills content width');
  for (const error of result.rightErrors)
    assert.ok(Math.abs(error) <= 0.75, 'both rows reach the preview right edge');
  for (const icon of result.icons) {
    assert.ok(Math.abs(icon.x) <= 0.75, icon.name + ' x center');
    assert.ok(Math.abs(icon.y) <= 0.75, icon.name + ' y center');
  }
  return result;
}
async function timelineGeometry() {
  await page.evaluate(
    (parent) => navigate({ view: 'timeline', parent, filter: 'images' }),
    idFor(photos)
  );
  await page.waitForFunction(
    () => grid.active && grid.total === 80 && grid.cards.size >= grid.cols
  );
  // Exercise the real worker notification path rather than revealing a hidden control manually.
  await page.evaluate(() =>
    api('setPlace', { id: [...grid.items.values()][0].id, place: 'Generated layout fixture' })
  );
  await expect(page.locator('#timeline-refresh')).toBeVisible();
  return page.evaluate(() => {
    const viewport = document.querySelector('#viewport'),
      vs = getComputedStyle(viewport),
      wall = document.querySelector('#virtual-grid').getBoundingClientRect(),
      controls = document.querySelector('#timeline-controls').getBoundingClientRect(),
      clear = document.querySelector('#timeline-clear').getBoundingClientRect(),
      refresh = document.querySelector('#timeline-refresh').getBoundingClientRect(),
      right = Math.max(
        ...[...grid.cards.values()].map((card) => card.getBoundingClientRect().right)
      ),
      contentRight =
        viewport.getBoundingClientRect().left + viewport.clientWidth - parseFloat(vs.paddingRight);
    return {
      width: innerWidth,
      density: S.settings.density,
      theme: document.documentElement.dataset.theme,
      columns: grid.cols,
      total: grid.total,
      rightError: wall.right - right,
      contentRightError: contentRight - wall.right,
      controlsRightError: contentRight - controls.right,
      buttonYError: clear.top + clear.height / 2 - refresh.top - refresh.height / 2,
      clearHeight: clear.height,
      refreshHeight: refresh.height,
      overflow: document.documentElement.scrollWidth - innerWidth,
      controlsOverflow: document.querySelector('#timeline-controls').scrollWidth - controls.width
    };
  });
}
async function assertTimeline() {
  const result = await timelineGeometry();
  report.timelines.push(result);
  for (const key of ['rightError', 'contentRightError', 'controlsRightError', 'buttonYError'])
    assert.ok(Math.abs(result[key]) <= 0.75, key + ': ' + result[key]);
  assert.equal(result.clearHeight, 33);
  assert.equal(result.refreshHeight, 33);
  assert.ok(result.overflow <= 0.75);
  assert.ok(result.controlsOverflow <= 0.75);
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'layout-refinement',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    albums = path.join(run, 'generated-albums');
    photos = path.join(run, 'generated-timeline');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(photos, { recursive: true });
    const buffers = await Promise.all(
      [
        [120, 180],
        [240, 160],
        [160, 90]
      ].map(([width, height], index) =>
        sharp({
          create: {
            width,
            height,
            channels: 3,
            background: ['#c6a3c8', '#8cacbe', '#d3b98a'][index]
          }
        })
          .png()
          .toBuffer()
      )
    );
    for (let i = 0; i < 64; i++) {
      const folder = path.join(albums, 'Album ' + String(i).padStart(3, '0'));
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'cover.png'), buffers[i % 3]);
    }
    for (let i = 0; i < 80; i++)
      await fs.writeFile(
        path.join(photos, 'Photo ' + String(i).padStart(3, '0') + '.png'),
        buffers[i % 3]
      );
    await seed();
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
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
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => report.errors.push(error.stack));
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.loadVersion > 0 && S.roots.length === 2
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const actual = await app.evaluate(({ app }) => ({
      userData: app.getPath('userData'),
      packaged: app.isPackaged,
      version: app.getVersion()
    }));
    assert.equal(path.resolve(actual.userData), path.join(profile, 'chromium-profile'));
    report.runtime = { executable, ...actual };
    await check(
      'live preview resizing replenishes two rows without recreating retained albums',
      async () => {
        await resize(1180, 900);
        await overview();
        const before = await assertPreview();
        await page.evaluate(() => {
          window.__layoutRetained = document.querySelector('.collection-preview .album-card');
        });
        await resize(3840, 2160);
        await waitPreview();
        const after = await assertPreview();
        assert.ok(after.count > before.count);
        assert.equal(
          await page.evaluate(
            () =>
              window.__layoutRetained === document.querySelector('.collection-preview .album-card')
          ),
          true
        );
        await resize(1180, 900);
        await waitPreview();
        await assertPreview();
      }
    );
    for (const [width, height] of [
      [1050, 900],
      [1920, 1080],
      [3840, 2160]
    ]) {
      await resize(width, height);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => saveSetting('theme', theme), theme);
        for (const density of [158, 186, 222]) {
          const label = `${width}-${theme}-${density}`;
          await check(label + ' overview/timeline fill and icon/button alignment', async () => {
            await overview();
            await page.evaluate((density) => changeDisplaySetting('density', density), density);
            await waitPreview();
            await assertPreview();
            if (density === 186 || width === 3840) await snapshot(label + '-overview');
            await assertTimeline();
            if (density === 186 || width === 3840) await snapshot(label + '-timeline');
          });
        }
      }
    }
    await check(
      'timeline refresh consumes the actual metadata update and remains navigable',
      async () => {
        await page.locator('#timeline-refresh').click();
        await expect(page.locator('#timeline-refresh')).toBeHidden();
        await page.waitForFunction(() => grid.active && grid.total === 80 && !mediaDirty);
        await page.evaluate(() => navigate({}));
        await overview();
        await assertPreview();
      }
    );
    assert.deepEqual(report.errors, []);
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
    console.error(error);
  } finally {
    await app?.close();
    if (run) {
      await fs.mkdir(run, { recursive: true });
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
