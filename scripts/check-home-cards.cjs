'use strict';
// Prepared for the lead's serial GUI queue. Sources, SQLite and Chromium data are generated fixtures.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = { checks: [], samples: [], screenshots: [], errors: [] };
let app, page, run, profile, collections;
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
      localIndexPath: path.join(run, 'absent_index.sqlite')
    }
  });
  const pending = new Map();
  let sequence = 0;
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const entry = pending.get(message.request);
        if (!entry) return;
        pending.delete(message.request);
        clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      });
    });
    const call = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++sequence,
          timer = setTimeout(() => reject(new Error('Fixture RPC timeout: ' + method)), 30000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    for (const collection of collections)
      await call('scan', {
        path: collection,
        directoryKind: 'work',
        subjectTypes: [4],
        onlineMatch: false
      });
    await call('shutdown');
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    await worker.terminate();
  }
}
async function launch() {
  const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.errors.push('Unexpected renderer HTTP: ' + route.request().url());
    await route.abort();
  });
  const runtime = await app.evaluate(({ app, BrowserWindow, net, session }) => {
    globalThis.__homeBlockedHttp = [];
    const original = net.fetch.bind(net);
    net.fetch = (input, ...options) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https?:\/\//i.test(url)) {
        globalThis.__homeBlockedHttp.push(url);
        return Promise.reject(new Error('Public HTTP blocked'));
      }
      return original(input, ...options);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        globalThis.__homeBlockedHttp.push(details.url);
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1600, 1100);
    win.show();
    win.focus();
    return {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      userData: app.getPath('userData')
    };
  });
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: executable || require('electron'), ...runtime };
  await page.waitForFunction(() => typeof S !== 'undefined' && S.roots.length === 4);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(async () => {
    await saveSetting('sidebarMode', 'compact');
    setSidebarOpen(false);
    await saveSetting('motionLevel', 'high');
  });
  await home();
}
async function raf() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function home() {
  await page.evaluate(() => navigate({}));
  await expect(page.locator('#category-overview .collection-tile')).toHaveCount(4);
  await raf();
}
function tile() {
  return page.locator(`#category-overview .collection-tile[data-id="${idFor(collections[0])}"]`);
}
async function offCard() {
  await page.mouse.move(10, 85);
  await raf();
}
async function finishMotion(locator) {
  await raf();
  await locator.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {})))
  );
  await raf();
}
async function hoverCard(locator) {
  const box = await locator.boundingBox();
  await locator.hover({ position: { x: box.width * 0.72, y: box.height * 0.77 } });
  await finishMotion(locator);
}
async function sample(locator) {
  return locator.evaluate((element) => {
    const rect = (selector) => {
      const r = element.querySelector(selector).getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    return {
      parent: getComputedStyle(element).transform,
      image: getComputedStyle(element.querySelector('.collection-image')).transform,
      details: getComputedStyle(element.querySelector('.collection-details')).transform,
      rx: element.style.getPropertyValue('--effect-rx'),
      ry: element.style.getPropertyValue('--effect-ry'),
      imageRx: element.querySelector('.collection-image').style.getPropertyValue('--effect-rx'),
      willChange: getComputedStyle(element).willChange,
      title: rect('h3'),
      cover: rect('.collection-image')
    };
  });
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const base = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      base,
      'home_cards',
      new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
        '_' +
        crypto.randomUUID().replace(/-/g, '_')
    );
    profile = path.join(run, 'generated_profile');
    collections = Array.from({ length: 4 }, (_, index) =>
      path.join(run, `collection_${index}_Long_generated_collection_title`)
    );
    await fs.mkdir(profile, { recursive: true });
    const image = await sharp({
      create: { width: 120, height: 72, channels: 3, background: '#326a9b' }
    })
      .png()
      .toBuffer();
    for (const collection of collections)
      for (let index = 0; index < 2; index++) {
        const folder = path.join(collection, 'album_' + index);
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(path.join(folder, 'generated.png'), image, { flag: 'wx' });
      }
    await seed();
    await launch();
    await check(
      'home cards have one expand control and recover the old arrow width for their title',
      async () => {
        await expect(page.locator('#category-overview .category-enter')).toHaveCount(0);
        await expect(page.locator('#category-overview .category-expand')).toHaveCount(4);
        await expect(tile().locator('.collection-summary')).toHaveAttribute('role', 'button');
        const width = await tile().evaluate((element) => {
          const details = element.querySelector('.collection-details'),
            summary = element.querySelector('.collection-summary'),
            expand = element.querySelector('.category-expand');
          const after = summary.clientWidth,
            arrow = document.createElement('button');
          arrow.className = 'category-enter';
          details.insertBefore(arrow, expand);
          try {
            return {
              after,
              before: summary.clientWidth,
              expandWidth: expand.getBoundingClientRect().width
            };
          } finally {
            arrow.remove();
          }
        });
        assert.ok(width.after - width.before >= 44, JSON.stringify(width));
        assert.ok(Math.abs(width.expandWidth - 33) < 1);
        report.titleWidth = width;
      }
    );
    await check(
      'high motion moves the entire home card including its title, at narrow/wide and light/dark',
      async () => {
        for (const width of [980, 1600])
          for (const theme of ['light', 'dark']) {
            await offCard();
            await app.evaluate(
              ({ BrowserWindow }, width) =>
                BrowserWindow.getAllWindows()[0].setContentSize(width, 1100),
              width
            );
            await page.waitForFunction((width) => innerWidth === width, width);
            await page.evaluate(async (theme) => {
              await saveSetting('theme', theme);
              await saveSetting('motionLevel', 'high');
            }, theme);
            await finishMotion(tile());
            const before = await sample(tile());
            await hoverCard(tile());
            await expect(tile()).toHaveClass(/effects-active/);
            const after = await sample(tile());
            assert.equal(before.parent, 'none');
            assert.ok(after.parent.startsWith('matrix3d('), JSON.stringify(after));
            assert.equal(after.image, 'none');
            assert.equal(after.details, 'none');
            assert.equal(after.imageRx, '');
            assert.ok(after.rx || after.ry);
            assert.equal(after.willChange, 'transform');
            assert.ok(
              Math.abs(after.title.top - before.title.top) +
                Math.abs(after.title.left - before.title.left) >
                0.5,
              'text follows the parent transform'
            );
            report.samples.push({ width, theme, before, after });
            await screenshot(`home_high_${width}_${theme}`);
          }
      }
    );
    await check(
      'low/medium, reduced motion and glass-off settings keep their established meanings',
      async () => {
        for (const [level, scale] of [
          ['low', 1.008],
          ['medium', 1.018]
        ]) {
          await offCard();
          await page.evaluate((level) => saveSetting('motionLevel', level), level);
          await hoverCard(tile());
          const state = await sample(tile());
          assert.equal(state.rx, '');
          assert.equal(state.ry, '');
          assert.ok(state.parent.startsWith('matrix('), JSON.stringify(state));
          assert.ok(Math.abs(Number(state.parent.slice(7).split(',')[0]) - scale) < 0.002);
          assert.equal(state.image, 'none');
        }
        await page.evaluate(async () => {
          await saveSetting('motionLevel', 'high');
          await saveSetting('liquidGlass', false);
        });
        await offCard();
        await hoverCard(tile());
        assert.ok((await sample(tile())).parent.startsWith('matrix3d('));
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.liquidGlass),
          'off'
        );
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await finishMotion(tile());
        const reduced = await sample(tile());
        assert.equal(reduced.parent, 'none');
        assert.equal(reduced.image, 'none');
        assert.equal(reduced.rx, '');
        assert.equal(reduced.willChange, 'auto');
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(() => saveSetting('liquidGlass', true));
        await offCard();
      }
    );
    await check(
      'image and title clicks, Enter/Space and context menus remain independent of expansion',
      async () => {
        const parent = idFor(collections[0]);
        for (const selector of ['.collection-open', '.collection-summary']) {
          await offCard();
          const history = await page.evaluate(() => S.history.length);
          await tile().locator(selector).click();
          await page.waitForFunction((parent) => S.parent === parent && grid.active, parent);
          assert.equal(await page.evaluate(() => S.history.length), history + 1);
          await home();
        }
        for (const key of ['Enter', 'Space']) {
          await offCard();
          await tile().locator('.collection-open').focus();
          await page.keyboard.press('Tab');
          await expect(tile().locator('.collection-summary')).toBeFocused();
          await finishMotion(tile());
          const keyboard = await sample(tile());
          assert.equal(keyboard.rx, '');
          assert.equal(keyboard.ry, '');
          assert.ok(keyboard.parent.startsWith('matrix('));
          await page.keyboard.press(key);
          await page.waitForFunction((parent) => S.parent === parent && grid.active, parent);
          await home();
        }
        await tile().locator('h3').click({ button: 'right' });
        await expect(page.locator('#context-menu')).toBeVisible();
        await expect(
          page.locator('#context-menu').getByRole('menuitem', { name: '属性…', exact: true })
        ).toBeVisible();
        await expect(
          page
            .locator('#context-menu')
            .getByRole('menuitem', { name: '分类绑定设置…', exact: true })
        ).toBeVisible();
        assert.equal(await page.evaluate(() => S.parent), null);
        await page.keyboard.press('Escape');
        await expect(page.locator('#context-menu')).not.toBeVisible();
      }
    );
    await check(
      'expanded collections stay still and their folder previews retain cover-only tilt and navigation',
      async () => {
        await offCard();
        await tile().locator('.category-expand').focus();
        await page.keyboard.press('Enter');
        await expect(tile()).toHaveClass(/expanded/);
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-expanded', 'true');
        assert.equal(await page.evaluate(() => S.parent), null);
        await expect(tile().locator('.collection-preview .album-card')).toHaveCount(2);
        const folder = tile().locator('.collection-preview .album-card').first();
        await offCard();
        const before = await folder.locator('.card-title').boundingBox();
        await hoverCard(folder);
        const state = await folder.evaluate((element) => ({
          parent: getComputedStyle(element).transform,
          cover: getComputedStyle(element.querySelector('.cover-shell')).transform,
          rx: element.style.getPropertyValue('--effect-rx'),
          coverRx: element.querySelector('.cover-shell').style.getPropertyValue('--effect-rx')
        }));
        assert.equal(state.parent, 'none');
        assert.ok(state.cover.startsWith('matrix3d('));
        assert.equal(state.rx, '');
        assert.ok(state.coverRx);
        assert.equal(
          await tile().evaluate((element) => getComputedStyle(element).transform),
          'none'
        );
        const after = await folder.locator('.card-title').boundingBox();
        report.samples.push({ folderPreview: true, before, after, state });
        assert.ok(
          Math.abs(before.y - after.y) < 0.5 && Math.abs(before.x - after.x) < 0.5,
          'Folder titles stay anchored: ' + JSON.stringify({ before, after })
        );
        await screenshot('expanded_folder_cover_only');
        for (const refreshCover of [false, true]) {
          if (refreshCover)
            await page.evaluate(
              async (id) => updateCoverNode(await api('resetCover', { id })),
              idFor(collections[0])
            );
          await folder.locator('.card-title').click({ button: 'right' });
          await expect(page.locator('#context-menu')).toBeVisible();
          await expect(
            page.locator('#context-menu').getByRole('menuitem', { name: '打开相册', exact: true })
          ).toBeVisible();
          await expect(
            page
              .locator('#context-menu')
              .getByRole('menuitem', { name: '分类绑定设置…', exact: true })
          ).toHaveCount(0);
          await expect(
            page
              .locator('#context-menu')
              .getByRole('menuitem', { name: '从资料库移除分类…', exact: true })
          ).toHaveCount(0);
          await page.keyboard.press('Escape');
        }
        await tile().locator('.category-expand').click();
        await expect(tile()).not.toHaveClass(/expanded/);
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-expanded', 'false');
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-label', '展开分类');
        await expect(tile().locator('.category-expand')).toHaveAttribute('title', '展开分类');
        await tile().locator('.category-expand').click();
        await expect(tile()).toHaveClass(/expanded/);
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-expanded', 'true');
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-label', '收起分类');
        await expect(tile().locator('.category-expand')).toHaveAttribute('title', '收起分类');
        await tile().locator('.collection-summary').focus();
        await page.keyboard.press('Enter');
        await page.waitForFunction((parent) => S.parent === parent, idFor(collections[0]));
        await home();
        await tile().locator('.category-expand').click();
        await expect(tile()).not.toHaveClass(/expanded/);
        await expect(tile().locator('.category-expand')).toHaveAttribute('aria-expanded', 'false');
      }
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(await app.evaluate(() => globalThis.__homeBlockedHttp), []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    console.error(error.stack);
    process.exitCode = 1;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    if (app) await app.close().catch(() => {});
    if (run) {
      const output = path.join(run, 'report.json');
      await fs.writeFile(output, JSON.stringify(report, null, 2));
      console.log('Report: ' + output);
    }
  }
})();
