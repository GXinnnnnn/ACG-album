'use strict';
// Run serially. All imported media, SQLite state and Chromium data are generated under artifacts.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const packagedExecutable = process.env.ACG_EXECUTABLE
  ? path.resolve(process.env.ACG_EXECUTABLE)
  : null;
const report = {
  checks: [],
  errors: [],
  screenshots: [],
  scope: 'Generated media and offline review fixtures; no real profiles or online matching.',
  runtime: {
    mode: packagedExecutable ? 'packaged' : 'source',
    executable: packagedExecutable || require('electron')
  }
};
let app,
  page,
  run,
  profile,
  stage = 'setup';
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
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
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: report.runtime.executable,
    args: packagedExecutable ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.settings.nickname !== undefined && S.loadVersion > 0
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1180, 900);
  });
  await page.waitForFunction(() => innerWidth === 1180);
  const actual = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    version: app.getVersion(),
    isPackaged: app.isPackaged
  }));
  Object.assign(report.runtime, { version: actual.version, isPackaged: actual.isPackaged });
  assert.equal(path.resolve(actual.userData), path.join(profile, 'chromium-profile'));
}
async function go(parent, options = {}) {
  await page.evaluate(({ parent, options }) => navigate({ parent, ...options }), {
    parent,
    options
  });
  await page.waitForFunction(
    (parent) => S.parent === parent && grid.active && grid.cards.size > 0,
    parent
  );
}
async function size(value) {
  await page.evaluate((value) => changeDisplaySetting('density', value), value);
  await settle(value);
}
async function settle(value) {
  await page.waitForFunction(
    (value) =>
      displayChangeTask === null &&
      densityWheelTimer === null &&
      Number(S.settings.density) === value,
    value
  );
}
async function wheel(selector, deltaY, options = {}) {
  return page.evaluate(
    ({ selector, deltaY, options }) => {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY,
        ...options
      });
      document.querySelector(selector).dispatchEvent(event);
      return event.defaultPrevented;
    },
    { selector, deltaY, options }
  );
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function seed(collections) {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite')
    }
  });
  let sequence = 0;
  const pending = new Map();
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
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => reject(new Error('Fixture RPC timeout: ' + method)), 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    for (const collection of collections)
      await call('scan', { path: collection, onlineMatch: false, subjectTypes: [4] });
    await call('shutdown');
  } finally {
    await worker.terminate();
  }
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'card-controls',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    await fs.mkdir(profile, { recursive: true });
    report.run = run;
    report.profile = profile;
    const collection = path.join(run, 'generated-page');
    const other = path.join(run, 'generated-other');
    const overview = path.join(run, 'generated-overview');
    const previewFolders = Array.from({ length: 14 }, (_, i) =>
      path.join(overview, `Preview item ${String(i).padStart(2, '0')}`)
    );
    const names = [
      '000 Exact automatic subject',
      '001 Exact automatic character',
      '002 Uncertain matched subject',
      '003 Manual matched subject',
      '004 Manual cover with matched subject',
      '005 Already confirmed',
      '006 Uncertain matched character',
      '007 Confirmed with stale review',
      '008 Unmatched fallback with stale review',
      '009 Manual local cover with stale review',
      ...Array.from({ length: 225 }, (_, i) => `Page item ${String(i).padStart(3, '0')}`)
    ];
    const folders = names.map((name) => path.join(collection, name));
    const nested = path.join(folders[6], 'Nested unrelated review');
    const unrelated = path.join(other, 'Outside current page');
    const filteredSibling = path.join(other, 'Hidden outside search');
    const image = await sharp({
      create: { width: 48, height: 64, channels: 3, background: '#cbb7d8' }
    })
      .png()
      .toBuffer();
    for (const folder of [...folders, ...previewFolders, nested, unrelated, filteredSibling]) {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'generated.png'), image, { flag: 'wx' });
    }
    await seed([collection, other, overview]);
    // Seed legacy review evidence while the worker is closed; launch tests the actual persisted repair.
    const db = new DatabaseSync(path.join(profile, 'library.sqlite'));
    db.exec(
      "UPDATE nodes SET confirmed=0,match_review=0 WHERE kind='folder'; DELETE FROM settings WHERE key='matchReviewVersion'"
    );
    db.prepare('UPDATE nodes SET match_review=1 WHERE id=?').run(idFor(overview));
    const patch = db.prepare(
      'UPDATE nodes SET subject_id=?,character_id=?,match_confidence=?,match_review=?,manual_subject=?,manual_cover=?,confirmed=?,cover_source=?,album_kind=? WHERE id=?'
    );
    const update = (
      index,
      subject,
      character,
      confidence,
      review,
      manualSubject,
      manualCover,
      confirmed,
      source,
      kind = 'auto'
    ) =>
      patch.run(
        subject,
        character,
        confidence,
        review,
        manualSubject,
        manualCover,
        confirmed,
        source,
        kind,
        idFor(folders[index])
      );
    update(0, 901, null, 1, 1, 0, 0, 0, 'bangumi');
    update(1, null, 902, 1, 1, 0, 0, 0, 'bangumi-character', 'character');
    update(2, 903, null, 0.87, 1, 0, 0, 0, 'bangumi');
    update(3, 904, null, 1, 1, 1, 0, 0, 'bangumi');
    update(4, 905, null, 1, 0, 0, 1, 0, 'manual');
    update(5, null, null, null, 0, 0, 0, 1, 'fallback');
    update(6, null, 906, 0.64, 1, 0, 0, 0, 'bangumi-character', 'character');
    update(7, null, null, null, 1, 0, 0, 1, 'fallback');
    update(8, null, null, 0.2, 1, 0, 0, 0, 'fallback');
    update(9, null, null, null, 1, 0, 1, 0, 'manual');
    // Legacy match_review must not override successful matches, local manual
    // covers, or persisted manual confirmation.
    db.prepare('UPDATE nodes SET match_review=1 WHERE id=?').run(idFor(folders[4]));
    db.close();
    await launch();
    const parent = idFor(collection);
    await check(
      'opening a real imported directory carries its ID into the bulk query',
      async () => {
        const tile = page.locator(`#category-overview .collection-tile[data-id="${parent}"]`);
        await tile.locator('.category-enter').click();
        await page.waitForFunction(
          (parent) => S.parent === parent && grid.active && grid.cards.size > 0,
          parent
        );
        const navigation = await page.evaluate(() => ({
          parent: S.parent,
          path: S.current.path,
          query: queryArgs()
        }));
        assert.equal(navigation.parent, parent);
        assert.equal(navigation.query.parent, parent);
        assert.equal(path.resolve(navigation.path), collection);
        report.directoryNavigation = navigation;
      }
    );
    await check(
      'matched subjects and characters at any confidence have no dot; only unmatched local fallback stays pending',
      async () => {
        for (const index of [0, 1, 2, 3, 4, 6]) {
          const node = await rpc('get', { id: idFor(folders[index]) });
          if (index !== 4) assert.equal(node.confirmed, 1);
          assert.equal(node.match_review, 0);
          assert.equal(
            await page.evaluate(
              (node) => cardReviewMessage({ ...node, confirmed: 0, match_review: 1 }),
              node
            ),
            ''
          );
          await expect(page.locator(`[data-id="${node.id}"] .card-review`)).toHaveCount(0);
        }
        for (const index of [5, 7, 9]) {
          const node = await rpc('get', { id: idFor(folders[index]) });
          assert.equal(await page.evaluate((node) => cardReviewMessage(node), node), '');
          await expect(page.locator(`[data-id="${node.id}"] .card-review`)).toHaveCount(0);
        }
        assert.equal((await rpc('get', { id: idFor(folders[7]) })).confirmed, 1);
        for (const index of [8, 10]) {
          const node = await rpc('get', { id: idFor(folders[index]) });
          assert.equal(node.confirmed, 0);
          await expect(page.locator(`[data-id="${node.id}"] .card-review`)).toHaveCount(1);
        }
        const pending = (await rpc('list', { filter: 'pending', limit: 500 })).items;
        const matchedIds = [0, 1, 2, 3, 4, 5, 6, 7, 9].map((index) => idFor(folders[index]));
        assert.equal(
          pending.some((n) => matchedIds.includes(n.id)),
          false
        );
        assert.equal(
          pending.some((n) => n.id === idFor(folders[8])),
          true
        );
      }
    );
    await check(
      'home clear includes the 12 expanded preview cards and preserves unshown child albums',
      async () => {
        await page.evaluate(() => navigate({}));
        const tile = page.locator(
          `#category-overview .collection-tile[data-id="${idFor(overview)}"]`
        );
        await tile.locator('.category-expand').click();
        await expect(tile.locator('.collection-preview .album-card')).toHaveCount(12);
        const previewIds = await tile
          .locator('.collection-preview .album-card')
          .evaluateAll((cards) => cards.map((card) => card.dataset.id));
        await expect(tile.locator('.card-review')).toHaveCount(13);
        await page.locator('#density-button').click();
        await shot('home-preview-before');
        await page.locator('#clear-page-review').click();
        await expect(page.locator('#page-review-status')).toContainText('15 个文件夹封面');
        await expect(page.locator('#category-overview .card-review')).toHaveCount(0);
        for (const id of previewIds) assert.equal((await rpc('get', { id })).confirmed, 1);
        const hidden = previewFolders.filter((folder) => !previewIds.includes(idFor(folder)));
        assert.equal(hidden.length, 2);
        for (const folder of hidden)
          assert.equal((await rpc('get', { id: idFor(folder) })).confirmed, 0);
        assert.equal((await rpc('get', { id: idFor(unrelated) })).confirmed, 0);
        assert.equal((await rpc('get', { id: idFor(folders[8]) })).confirmed, 0);
        assert.equal((await rpc('get', { id: idFor(nested) })).confirmed, 0);
        report.homePreview = { displayed: previewIds.length, hiddenPreserved: hidden.length };
        await shot('home-preview-cleared');
        await page.locator('#modal-close').click();
        await go(parent);
      }
    );
    await check(
      'one click clears all current query results including unloaded virtual pages, preserving other directories',
      async () => {
        const before = await page.evaluate(() => ({
          total: grid.total,
          loaded: grid.items.size,
          cards: grid.cards.size
        }));
        assert.ok(
          before.total > 180 && before.loaded < before.total && before.cards < before.total
        );
        const unloadedId = idFor(folders[folders.length - 1]);
        assert.equal(
          await page.evaluate(
            (id) => [...grid.items.values()].some((node) => node.id === id),
            unloadedId
          ),
          false,
          'the last real folder has never loaded into the virtual grid'
        );
        assert.equal((await rpc('get', { id: unloadedId })).confirmed, 0);
        report.virtualPage = { ...before, unloadedId };
        await page.locator('#density-button').click();
        await expect(page.locator('#density-button')).toHaveAttribute('title', /批量确认封面/);
        await expect(page.locator('#clear-page-review')).toHaveAccessibleName('批量确认封面');
        await expect(page.locator('#page-review-help')).toContainText('当前目录');
        await expect(page.locator('#page-review-help')).toContainText('全部文件夹封面');
        await expect(page.locator('#page-review-help')).toContainText('尚未滚动加载');
        await expect(page.locator('#modal .density-popup')).toHaveCount(1);
        await expect(page.locator('#modal #clear-page-review')).toHaveCount(1);
        await expect(page.locator('dialog[open]')).toHaveCount(1);
        const layout = await page.locator('#clear-page-review').evaluate((button) => {
          const modal = document.querySelector('#modal').getBoundingClientRect();
          const rect = button.getBoundingClientRect();
          return {
            visible: rect.top >= modal.top && rect.bottom <= modal.bottom,
            beforeRatio: Boolean(
              button.compareDocumentPosition(document.querySelector('#ratio-select')) &
                Node.DOCUMENT_POSITION_FOLLOWING
            )
          };
        });
        assert.equal(layout.visible, true, 'bulk button fits the same card-size dialog');
        assert.equal(layout.beforeRatio, true, 'bulk action precedes secondary ratio settings');
        await shot('page-review-before');
        await page.locator('#clear-page-review').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#page-review-status')).toContainText('已清除当前页面红点');
        const rows = await rpc('list', { parent, limit: 500 });
        assert.equal(rows.total, folders.length);
        assert.equal(
          rows.items.some((n) => n.match_review || !n.confirmed),
          false
        );
        for (const folder of [nested, unrelated])
          assert.equal((await rpc('get', { id: idFor(folder) })).confirmed, 0);
        assert.equal(await page.locator('#virtual-grid .card-review').count(), 0);
        await shot('page-review-cleared');
        await page.locator('#clear-page-review').click();
        await expect(page.locator('#page-review-status')).toHaveText(
          '当前目录全部文件夹封面均已确认，没有需要清除的红点。'
        );
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'an opened directory confirms all direct folders despite media filters or search, preserving nested folders',
      async () => {
        await go(idFor(other));
        await page.evaluate(async () => {
          S.filter = 'images';
          await loadPage();
        });
        await page.locator('#density-button').click();
        await page.locator('#clear-page-review').click();
        await expect(page.locator('#page-review-status')).toContainText('2 个文件夹封面');
        for (const folder of [unrelated, filteredSibling])
          assert.equal((await rpc('get', { id: idFor(folder) })).confirmed, 1);
        assert.equal((await rpc('get', { id: idFor(nested) })).confirmed, 0);
        await page.locator('#modal-close').click();
        await go(idFor(overview), { search: 'Preview item 00' });
        assert.equal(await page.evaluate(() => queryArgs().parent), idFor(overview));
        const before = await rpc('list', { parent: idFor(overview), limit: 100 });
        assert.equal(before.items.filter((node) => !node.confirmed).length, 2);
        await page.locator('#density-button').click();
        await page.locator('#clear-page-review').click();
        await expect(page.locator('#page-review-status')).toContainText('2 个文件夹封面');
        for (const folder of previewFolders)
          assert.equal((await rpc('get', { id: idFor(folder) })).confirmed, 1);
        assert.equal((await rpc('get', { id: idFor(nested) })).confirmed, 0);
        await page.locator('#modal-close').click();
        await go(parent, { search: '' });
      }
    );
    await check(
      'navigation discards an obsolete clear completion even when returning to the same query',
      async () => {
        await page.locator('#density-button').click();
        await page.evaluate(() => {
          window.__originalSummary = loadSummary;
          window.__summaryEntered = false;
          const barrier = new Promise((resolve) => {
            window.__releaseSummary = resolve;
          });
          loadSummary = async () => {
            window.__summaryEntered = true;
            await barrier;
            return window.__originalSummary();
          };
          window.__clearCompletion = clearPageReview();
        });
        await page.waitForFunction(() => window.__summaryEntered);
        await expect(page.locator('#clear-page-review')).toBeDisabled();
        await expect(page.locator('#clear-page-review')).toHaveAttribute('aria-busy', 'true');
        await expect(page.locator('#clear-page-review')).toContainText('正在批量确认');
        await expect(page.locator('#page-review-status')).toContainText('包含未加载项目');
        await expect(page.locator('dialog[open]')).toHaveCount(1);
        await go(idFor(other));
        await go(parent);
        const version = await page.evaluate(() => S.loadVersion);
        await page.evaluate(async () => {
          loadSummary = window.__originalSummary;
          window.__releaseSummary();
          await window.__clearCompletion;
        });
        assert.equal(await page.evaluate(() => S.loadVersion), version);
        await expect(page.locator('#page-review-status')).toHaveText('');
        await expect(page.locator('#clear-page-review')).toBeEnabled();
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'bulk refresh failures explain retry and the same button recovers without another dialog',
      async () => {
        await page.locator('#density-button').click();
        await page.evaluate(() => {
          window.__originalSummary = loadSummary;
          loadSummary = async () => {
            throw new Error('Generated refresh failure');
          };
        });
        try {
          await page.locator('#clear-page-review').click();
          await expect(page.locator('#page-review-status')).toContainText(
            '封面已确认，但页面刷新失败'
          );
          await expect(page.locator('#page-review-status')).toContainText(
            '请再次点击“批量确认封面”重试'
          );
          await expect(page.locator('#clear-page-review')).toBeEnabled();
          await expect(page.locator('dialog[open]')).toHaveCount(1);
        } finally {
          await page.evaluate(() => {
            loadSummary = window.__originalSummary;
          });
        }
        await page.locator('#clear-page-review').click();
        await expect(page.locator('#page-review-status')).toContainText('全部文件夹封面均已确认');
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'the minimum desktop window keeps the bulk entry reachable in the card-size dialog',
      async () => {
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(980, 680)
        );
        await page.waitForFunction(() => innerWidth === 980 && innerHeight === 680);
        await page.locator('#density-button').click();
        await expect(page.locator('#clear-page-review')).toBeVisible();
        await page.locator('#clear-page-review').scrollIntoViewIfNeeded();
        const bounds = await page.locator('#clear-page-review').evaluate((button) => {
          const modal = document.querySelector('#modal');
          const outer = modal.getBoundingClientRect();
          const inner = button.getBoundingClientRect();
          return {
            inside:
              inner.top >= outer.top &&
              inner.bottom <= outer.bottom &&
              inner.left >= outer.left &&
              inner.right <= outer.right,
            noHorizontalClip: modal.scrollWidth <= modal.clientWidth + 1
          };
        });
        assert.equal(bounds.inside, true);
        assert.equal(bounds.noHorizontalClip, true);
        await shot('minimum-window-card-settings');
        await page.locator('#modal-close').click();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1180, 900)
        );
        await page.waitForFunction(() => innerWidth === 1180 && innerHeight === 900);
      }
    );
    await check(
      'Ctrl wheel uses existing preset bounds, prevents zoom only in browsing area and coalesces saves',
      async () => {
        await size(186);
        await page.evaluate(() => {
          $('#viewport').focus();
          window.__densityCalls = [];
          window.__originalDensityChange = changeDisplaySetting;
          changeDisplaySetting = (...args) => {
            window.__densityCalls.push(args);
            return window.__originalDensityChange(...args);
          };
        });
        assert.equal(await wheel('#virtual-grid', -120), true);
        await settle(222);
        assert.equal(await wheel('#virtual-grid', -120), true);
        assert.equal(await wheel('#virtual-grid', -120), true);
        assert.equal(await page.evaluate(() => S.settings.density), 222);
        assert.equal(await wheel('#virtual-grid', 120), true);
        await settle(186);
        await page.evaluate(() => {
          window.__densityCalls = [];
          for (let i = 0; i < 40; i++)
            $('#virtual-grid').dispatchEvent(
              new WheelEvent('wheel', {
                ctrlKey: true,
                deltaY: 120,
                bubbles: true,
                cancelable: true
              })
            );
        });
        await settle(158);
        assert.equal(await page.evaluate(() => window.__densityCalls.length), 1);
        assert.equal(await wheel('#virtual-grid', 120), true);
        assert.equal(await page.evaluate(() => S.settings.density), 158);
        assert.equal(await wheel('#virtual-grid', -120, { ctrlKey: false }), false);
        assert.equal(await wheel('#virtual-grid', -120, { altKey: true }), false);
        assert.equal(await wheel('#virtual-grid', -120, { shiftKey: true }), false);
        assert.equal(await wheel('.sidebar', -120), false);
        await page.evaluate(() => {
          changeDisplaySetting = window.__originalDensityChange;
        });
        const zoom = await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()
        );
        const box = await page.locator('#virtual-grid').boundingBox();
        await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 150, 700));
        await page.keyboard.down('Control');
        try {
          await page.mouse.wheel(0, -120);
        } finally {
          await page.keyboard.up('Control');
        }
        await settle(186);
        assert.equal(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()
          ),
          zoom
        );
        assert.equal((await rpc('init')).settings.density, 186);
      }
    );
    await check(
      'focused inputs, editable targets, all dialogs and context menus retain their wheel behavior',
      async () => {
        await size(186);
        await page.locator('#search').focus();
        assert.equal(await wheel('#virtual-grid', -120), false);
        await page.evaluate(() => {
          $('#viewport').focus();
          const editor = document.createElement('div');
          editor.id = 'generated-editable';
          editor.contentEditable = 'true';
          $('#viewport').append(editor);
        });
        assert.equal(await wheel('#generated-editable', -120), false);
        await page.evaluate(() => $('#generated-editable').remove());
        await page.locator('#density-button').click();
        assert.equal(await wheel('#virtual-grid', -120), false);
        assert.equal(await wheel('#ratio-select', -120), false);
        await page.locator('#modal-close').click();
        await page.evaluate(() => $('#viewer').showModal());
        assert.equal(await wheel('#virtual-grid', -120), false);
        await page.evaluate(() => $('#viewer').close());
        await page.evaluate(
          async (id) => openEditor(await api('get', { id })),
          idFor(path.join(folders[0], 'generated.png'))
        );
        await expect(page.locator('#media-editor')).toBeVisible();
        assert.equal(await wheel('#virtual-grid', -120), false);
        await page.locator('#me-close').click();
        await page.evaluate(() => window.albumLocalSearch.show());
        await expect(page.locator('#local-search-dialog')).toBeVisible();
        assert.equal(await wheel('#virtual-grid', -120), false);
        await page.locator('#local-search-close').click();
        await page.evaluate(() => {
          $('#viewport').focus();
          $('#context-menu').hidden = false;
        });
        assert.equal(await wheel('#virtual-grid', -120), false);
        await page.evaluate(() => ($('#context-menu').hidden = true));
        assert.equal(await page.evaluate(() => S.settings.density), 186);
        assert.equal(await page.evaluate(() => densityWheelTimer), null);
      }
    );
    await check(
      'card-size changes preserve the current card anchor and refresh high-DPI thumbnail tiers',
      async () => {
        await page.evaluate(() => {
          Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
          $('#viewport').focus();
          $('#viewport').scrollTop = 3500;
          grid.render();
        });
        await size(158);
        await page.waitForFunction(() =>
          [...grid.cards.values()].some((card) =>
            card.querySelector('img')?.getAttribute('src')?.includes('size=512')
          )
        );
        const anchor = await page.evaluate(() => captureDisplayAnchor());
        assert.equal(anchor.kind, 'grid');
        assert.equal(await wheel('#virtual-grid', -120), true);
        await settle(186);
        assert.equal(await wheel('#virtual-grid', -120), true);
        await settle(222);
        const after = await page.evaluate(
          (anchor) => ({
            before: anchor,
            offset:
              grid.getPosition(anchor.index).top -
              ($('#viewport').scrollTop - ($('#virtual-grid').offsetTop || 0)),
            card: grid.cards.get(anchor.index)?.dataset.id,
            image: grid.cards.get(anchor.index)?.querySelector('img')?.getAttribute('src'),
            current: captureDisplayAnchor()
          }),
          anchor
        );
        assert.ok(after.card, 'previously anchored card remains rendered');
        assert.ok(
          after.image?.includes('size=768'),
          'DPR2 large card refreshes the thumbnail tier'
        );
        const offset = await page.evaluate(
          (anchor) =>
            grid.cards.get(anchor.index).getBoundingClientRect().top -
            $('#viewport').getBoundingClientRect().top,
          anchor
        );
        assert.ok(Math.abs(offset - anchor.offset) < 3, `anchor moved ${offset - anchor.offset}px`);
        assert.equal(await wheel('#virtual-grid', 120), true);
        await settle(186);
        await page.waitForFunction(
          (anchor) =>
            grid.cards
              .get(anchor.index)
              ?.querySelector('img')
              ?.getAttribute('src')
              ?.includes('size=512'),
          anchor
        );
        report.anchor = { index: anchor.index, before: anchor.offset, after: offset };
        await shot('ctrl-wheel-high-dpi');
        await page.evaluate(() => {
          delete window.devicePixelRatio;
        });
      }
    );
    await check('wheel preset and cleared review states persist after restart', async () => {
      await app.close();
      app = null;
      await launch();
      assert.equal(await page.evaluate(() => S.settings.density), 186);
      await go(parent);
      for (const index of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, folders.length - 1]) {
        const node = await rpc('get', { id: idFor(folders[index]) });
        assert.equal(node.confirmed, 1);
        assert.equal(node.match_review, 0);
        assert.equal(await page.evaluate((node) => cardReviewMessage(node), node), '');
      }
      await expect(page.locator('#virtual-grid .card-review')).toHaveCount(0);
      assert.equal((await rpc('get', { id: report.virtualPage.unloadedId })).confirmed, 1);
      for (const folder of [unrelated, filteredSibling, ...previewFolders])
        assert.equal((await rpc('get', { id: idFor(folder) })).confirmed, 1);
      assert.equal((await rpc('get', { id: idFor(nested) })).confirmed, 0);
      assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    });
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
