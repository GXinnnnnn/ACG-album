'use strict';
const { _electron: electron } = require('@playwright/test');
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path');
const { idFor } = require('../src/model.cjs');
(async () => {
  await fs.mkdir('artifacts', { recursive: true });
  const issues = [],
    report = {};
  const started = performance.now();
  const launchEnv = { ...process.env, ACG_TEST: '1', ACG_DATA_DIR: path.resolve('.review-data') };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.resolve('.')],
    env: launchEnv
  });
  let page;
  try {
    page = await app.firstWindow();
    page.on('pageerror', (e) => issues.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      window.__validationErrors = [];
      window.addEventListener('error', (e) => window.__validationErrors.push(e.message));
      window.addEventListener('unhandledrejection', (e) =>
        window.__validationErrors.push(e.reason?.message || String(e.reason))
      );
    });
    await page.waitForSelector('.collection-tile', { timeout: 20000 });
    report.launchMs = performance.now() - started;
    const resize = async (width, height) => {
      await app.evaluate(
        ({ BrowserWindow }, { width, height }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(width, height),
        { width, height }
      );
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width, height }
      );
    };
    await resize(1920, 1080);
    await page.locator('.category-link').filter({ hasText: 'ACG图片' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.album-card').length === 6);
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.album-card img')].every(
        (i) => i.complete && i.naturalWidth > 0
      )
    );
    await page.screenshot({ path: 'artifacts/library-1080p.png', scale: 'css' });
    report.libraryViewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      cards: document.querySelectorAll('.album-card').length
    }));
    assert.equal(report.libraryViewport.horizontalOverflow, false);
    const bit = idFor(path.resolve('ACG图片/16bit的感动'));
    await page.evaluate(
      (id) => window.album.call('patch', { id, changes: { search_type: -1 } }),
      bit
    );
    await page.locator(`[data-id="${bit}"]`).click();
    await page.waitForSelector('.image-card');
    const names = await page.locator('.image-card .card-title').allTextContents();
    assert.deepEqual(names.slice(0, 3), ['1.jpg', '2.jpg', '3.jpg']);
    await page.locator('.image-card').first().click();
    await page.waitForFunction(
      () =>
        document.querySelector('#viewer').open &&
        document.querySelector('#viewer-image').naturalWidth > 0
    );
    await page.locator('#viewer-copy').click();
    report.clipboard = await app.evaluate(({ clipboard }) => ({
      empty: clipboard.readImage().isEmpty(),
      size: clipboard.readImage().getSize(),
      formats: clipboard.availableFormats()
    }));
    assert.equal(report.clipboard.empty, false);
    await page.locator('#viewer-image').click({ button: 'right' });
    await page.waitForSelector('#context-menu:not([hidden])');
    assert.equal(
      await page.evaluate(() => {
        const m = document.querySelector('#context-menu'),
          r = m.getBoundingClientRect();
        return m.contains(document.elementFromPoint(r.left + 30, r.top + 20));
      }),
      true
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#viewer').evaluate((el) => el.open), true);
    await page.locator('#viewer-fit').click();
    assert.equal(
      await page.locator('#viewer-stage').evaluate((el) => el.classList.contains('zoomed')),
      true
    );
    await page.locator('#viewer-fit').click();
    await page.screenshot({ path: 'artifacts/viewer-1080p.png', scale: 'css' });
    await page.locator('#viewer-close').click();
    await page.evaluate(
      async ({ id }) => {
        await window.album.call('bind', { id, url: '413741' });
      },
      { id: bit }
    );
    await page.waitForSelector('.intro-panel');
    assert.match(await page.locator('.intro-panel h2').innerText(), /16bit/);
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = 0));
    assert.equal(await page.locator('.intro-panel h2').isVisible(), true);
    await page.screenshot({ path: 'artifacts/intro-1080p.png', scale: 'css' });
    await page.locator('#intro-edit').click();
    assert.equal(await page.locator('#subject-type').inputValue(), '-1');
    const subjectType = page.locator('#subject-type');
    const subjectTypeWrapper = subjectType.locator('..');
    const subjectTypeIndex = await subjectType.evaluate((select) =>
      [...select.options].findIndex((option) => option.value === '2')
    );
    assert.ok(subjectTypeIndex >= 0);
    await subjectTypeWrapper.locator('.album-select-button').click();
    await subjectTypeWrapper
      .locator(`.album-select-option[data-index='${subjectTypeIndex}']`)
      .click();
    assert.equal(await subjectType.inputValue(), '2');
    assert.equal(
      await page.evaluate(
        async (id) => (await window.album.call('get', { id })).effective_search_type,
        bit
      ),
      2
    );
    await page.locator('#modal-close').click();
    const images = await page.evaluate(
      async (id) => (await window.album.call('list', { parent: id, filter: 'images' })).items,
      bit
    );
    const selected = images.find((n) => n.name === '3.jpg');
    await app.evaluate(({ dialog }, file) => {
      globalThis.__originalDialog = dialog.showOpenDialog;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, selected.path);
    await page.evaluate((id) => window.album.call('chooseCover', { id }), bit);
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = globalThis.__originalDialog;
    });
    const manual = await page.evaluate((id) => window.album.call('get', { id }), bit);
    assert.equal(manual.manual_cover, 1);
    assert.equal(manual.cover, selected.id);
    await page.evaluate(async (id) => {
      await window.album.call('patch', { id, changes: { crop_x: 35, crop_y: 65, favorite: 1 } });
    }, bit);
    await page.locator('#intro-refresh').click();
    await page.waitForFunction(() =>
      document.querySelector('#toast-region').textContent.includes('评分已更新')
    );
    assert.equal(
      await page.evaluate(async (id) => (await window.album.call('get', { id })).cover, bit),
      selected.id
    );
    const markdown = await fs.readFile('.review-data/metadata/413741.md', 'utf8');
    assert.match(markdown, /## Staff/);
    assert.match(markdown, /16bit/);
    report.metadataMarkdown = true;
    const tokenState = await page.evaluate(() => window.album.call('tokenStatus'));
    if (!tokenState.saved) {
      assert.equal(tokenState.encrypted, true);
      const value = 'acg-local-encryption-validation';
      await page.evaluate((value) => window.album.call('saveToken', { value }), value);
      const cipher = await fs.readFile('.review-data/bangumi-token.enc');
      assert.equal(cipher.includes(Buffer.from(value)), false);
      assert.equal(
        await app.evaluate(
          ({ safeStorage }, bytes) => safeStorage.decryptString(Buffer.from(bytes)),
          [...cipher]
        ),
        value
      );
      await page.evaluate(() => window.album.call('saveToken', { value: '' }));
      report.tokenEncryptionVerified = true;
    }
    await page.locator('#settings-button').click();
    await page.locator('[data-tab="cache"]').click();
    await page.waitForSelector('#watch-toggle');
    assert.equal(await page.locator('#watch-toggle').isChecked(), true);
    await page.waitForTimeout(2000);
    await page.locator('#cache-all').click();
    await page.locator('#confirm-ok').click();
    await page.waitForSelector('#cache-unused');
    assert.equal(await page.locator('#modal').evaluate((el) => el.open), true);
    assert.match(await page.locator('.cache-path').innerText(), /review-data/);
    await page.locator('#modal-close').click();
    await page.locator('.category-link').filter({ hasText: 'ACG图片' }).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('.album-card img')].length === 6 &&
        [...document.querySelectorAll('.album-card img')].every(
          (i) => i.complete && i.naturalWidth > 0
        )
    );
    report.rebuiltVisibleCovers = await page.locator('.album-card img').count();
    await page.locator('#theme-button').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.screenshot({ path: 'artifacts/library-dark-1080p.png', scale: 'css' });
    await page.locator('#theme-button').click();
    await resize(3840, 2160);
    const pokemon = idFor(path.resolve('ACG图片/宝可梦'));
    await page.locator(`[data-id="${pokemon}"]`).click();
    const largeAlbum = await page.evaluate(
      async (id) =>
        (await window.album.call('list', { parent: id })).items.find(
          (n) => n.kind === 'folder' && n.files > 1000
        ),
      pokemon
    );
    assert.ok(largeAlbum);
    await page.locator(`[data-id="${largeAlbum.id}"]`).click();
    await page.waitForSelector('.image-card');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.album-card img')].every(
        (i) => i.complete && i.naturalWidth > 0
      )
    );
    await page.screenshot({ path: 'artifacts/gallery-4k.png', scale: 'css' });
    report.virtualGrid = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      domCards: grid.cards.size,
      total: grid.total,
      scrollHeight: document.querySelector('#virtual-grid').scrollHeight
    }));
    assert.ok(report.virtualGrid.total > 1000);
    assert.ok(report.virtualGrid.domCards < 250);
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForFunction(
      () =>
        grid.cards.size > 0 &&
        Math.min(...grid.cards.keys()) > 900 &&
        !document.querySelector('.card-skeleton')
    );
    report.virtualGrid.afterScroll = await page.evaluate(() => ({
      domCards: grid.cards.size,
      firstIndex: Math.min(...grid.cards.keys()),
      cachedItems: grid.items.size
    }));
    assert.ok(report.virtualGrid.afterScroll.domCards < 250);
    assert.ok(report.virtualGrid.afterScroll.cachedItems < 1440);
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = 0));
    await page.waitForFunction(
      () => grid.cards.has(0) && !document.querySelector('.card-skeleton')
    );
    report.virtualGrid.scrollBackLoaded = true;
    report.memory4k = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((m) => ({ type: m.type, workingSetMB: m.memory.workingSetSize / 1024 }))
    );
    await page.locator('#home-button').click();
    await page.waitForSelector('.collection-tile');
    const before = await page.locator('.collection-tile').count();
    await page.locator('#collapse-all').click();
    assert.equal(await page.locator('.collection-tile').count(), before);
    assert.equal(await page.locator('.collection-open').isEnabled(), true);
    report.categoryCollapseKeepsCard = true;
    await resize(1920, 1080);
    await page.waitForTimeout(1500);
    report.memory1080 = await app.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((m) => ({ type: m.type, workingSetMB: m.memory.workingSetSize / 1024 }))
    );
    issues.push(...(await page.evaluate(() => window.__validationErrors)));
    report.errors = [...new Set(issues)];
    assert.deepEqual(report.errors, []);
    console.log('UI VALIDATION', JSON.stringify(report, null, 2));
    await fs.writeFile('artifacts/ui-report.json', JSON.stringify(report, null, 2));
  } catch (e) {
    if (page)
      await page.screenshot({ path: 'artifacts/ui-error.png', scale: 'css' }).catch(() => {});
    console.error('UI ERRORS', issues);
    throw e;
  } finally {
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
