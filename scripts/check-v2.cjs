'use strict';
const { _electron } = require('@playwright/test');
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto');
const { idFor, IMAGE_EXT } = require('../src/model.cjs');
async function manifest(root) {
  const rows = [];
  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const b = await fs.readFile(p);
        rows.push({
          path: path.relative(root, p),
          bytes: b.length,
          mtimeMs: (await fs.stat(p)).mtimeMs,
          sha256: crypto.createHash('sha256').update(b).digest('hex')
        });
      }
    }
  }
  await walk(root);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
(async () => {
  await fs.mkdir('artifacts', { recursive: true });
  const games = path.resolve('游戏图片'),
    before = { games: await manifest(games), animation: await manifest(path.resolve('ACG图片')) },
    env = { ...process.env, ACG_TEST: '1', ACG_DATA_DIR: path.resolve('.review-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const errors = [],
    report = { sourceManifestFiles: before.games.length + before.animation.length },
    start = performance.now();
  let app, page, originalSettings, treeFixture;
  async function launch() {
    app = await _electron.launch({
      executablePath: require('electron'),
      args: [path.resolve('.')],
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.waitForSelector('#profile-button');
    await page.waitForFunction(() => S.roots.length > 0 && window.renderFolderTree);
  }
  async function resize(width, height) {
    await app.evaluate(
      async ({ BrowserWindow }, { width, height }) => {
        const w = BrowserWindow.getAllWindows()[0];
        if (w.isMaximized())
          await new Promise((resolve) => {
            w.once('unmaximize', resolve);
            w.unmaximize();
          });
        w.setContentSize(width, height);
      },
      { width, height }
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height }
    );
  }
  async function decoded() {
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.album-card img').length > 0 &&
        [...document.querySelectorAll('.album-card img')].every(
          (i) => i.complete && i.naturalWidth > 0
        )
    );
  }
  async function goto(id) {
    await page.evaluate((id) => {
      if ($('#viewer').open) $('#viewer-close').click();
      return navigate({ parent: id });
    }, id);
    await page.waitForFunction((id) => S.parent === id && grid.active && grid.total > 0, id);
  }
  try {
    await launch();
    report.launchMs = +(performance.now() - start).toFixed(2);
    originalSettings = await page.evaluate(() => ({ ...S.settings }));
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('sidebarMode', 'auto');
      await saveSetting('theme', 'light');
    });
    await resize(1280, 800);
    const normalBounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    );
    await page.locator('[data-window="maximize"]').click();
    await app.evaluate(
      ({ BrowserWindow }) =>
        new Promise((resolve) => {
          const w = BrowserWindow.getAllWindows()[0];
          if (w.isMaximized()) resolve();
          else w.once('maximize', resolve);
        })
    );
    report.maximize = await app.evaluate(({ BrowserWindow, screen }) => {
      const w = BrowserWindow.getAllWindows()[0],
        display = screen.getDisplayMatching(w.getBounds());
      return {
        maximized: w.isMaximized(),
        fullscreen: w.isFullScreen(),
        content: w.getContentBounds(),
        workArea: display.workArea,
        display: display.bounds
      };
    });
    assert.equal(report.maximize.maximized, true);
    assert.equal(report.maximize.fullscreen, false);
    const mb = report.maximize.content,
      wa = report.maximize.workArea;
    assert.ok(
      mb.x >= wa.x &&
        mb.y >= wa.y &&
        mb.x + mb.width <= wa.x + wa.width &&
        mb.y + mb.height <= wa.y + wa.height
    );
    await page.locator('[data-window="maximize"]').click();
    await page.waitForFunction(() => innerWidth === 1280 && innerHeight === 800);
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds()),
      normalBounds
    );
    report.maximize.restoreBoundsMatch = true;
    await resize(1920, 1080);
    const brand = page.locator('#brand-home');
    await brand.hover();
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector('.brand-text small')).opacity) === 1
    );
    report.brandSubtitle = await page.locator('.brand-text small').textContent();
    assert.equal(report.brandSubtitle, '本地相册');
    await page.mouse.move(1100, 700);
    await brand.focus();
    await page.waitForFunction(
      () => Number(getComputedStyle(document.querySelector('.brand-text small')).opacity) === 1
    );
    report.brandKeyboardReveal = true;
    await page.locator('#viewport').focus();
    const collapsedX = (await page.locator('main').boundingBox()).x;
    await page.locator('#rail-tree').hover({ force: true });
    await page.waitForFunction(() => sidebarOpen);
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('#sidebar-panel')).opacity === '1'
    );
    assert.equal((await page.locator('main').boundingBox()).x, collapsedX);
    report.hoverOverlay = {
      collapsedX,
      expandedPanelWidth: (await page.locator('#sidebar-panel').boundingBox()).width
    };
    await page.mouse.move(1100, 700);
    await page.waitForFunction(() => !sidebarOpen);
    report.autoCollapse = true;
    await page.locator('#rail-tree').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => sidebarOpen && !document.querySelector('#sidebar-panel').inert
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !sidebarOpen);
    report.keyboardSidebar = true;
    await page.locator('#rail-tree').hover({ force: true });
    await page.waitForFunction(() => sidebarOpen);
    await page.locator('#sidebar-pin').click();
    await page.waitForFunction(
      () => document.querySelector('main').getBoundingClientRect().x > 290
    );
    report.pinnedX = (await page.locator('main').boundingBox()).x;
    await page.evaluate(async () => {
      await saveSetting('sidebarMode', 'auto');
      document.activeElement.blur();
    });
    await page.mouse.move(1200, 700);
    await page.waitForFunction(() => !sidebarOpen);
    await page.evaluate(() => saveSetting('categoryType', 4));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, games);
    const scan = performance.now();
    const imported = await page.evaluate(() => window.album.call('import'));
    report.gameImportMs = +(performance.now() - scan).toFixed(2);
    const gameId = idFor(games);
    await page.evaluate(
      (id) => window.album.call('patch', { id, changes: { search_type: 4 } }),
      gameId
    );
    await page.waitForFunction((id) => S.roots.some((n) => n.id === id), gameId);
    const init = await page.evaluate(() => window.album.call('init'));
    const gameRoot = await page.evaluate((id) => window.album.call('get', { id }), gameId);
    report.gameLibrary = {
      files: gameRoot.files,
      folders: gameRoot.folders,
      type: gameRoot.effective_search_type
    };
    assert.equal(gameRoot.effective_search_type, 4);
    assert.ok(gameRoot.files > 150);
    const animations = idFor(path.resolve('ACG图片'));
    const animation = await page.evaluate((id) => window.album.call('get', { id }), animations);
    assert.equal(animation.effective_search_type, 2);
    const rider = init.roots.find((n) => /假面骑士/.test(n.name));
    if (rider) assert.equal(rider.search_type, 6);
    report.animationType = animation.effective_search_type;
    report.riderType = rider?.search_type;
    await page.locator('#rail-tree').hover({ force: true });
    await page.waitForFunction(() => sidebarOpen);
    await page.locator('#collapse-all').click();
    const gameRow = page.locator(`.tree-node[data-node-id="${gameId}"] > .tree-row`);
    await gameRow.locator('.tree-toggle').click();
    await page.waitForFunction(
      (id) => folderTree.pages.has(id) && !folderTree.loading.has(id),
      gameId
    );
    const firstTree = await page.evaluate(
      (id) => ({
        count: folderTree.pages.get(id).items.length,
        total: folderTree.pages.get(id).total,
        dom: document.querySelectorAll('.tree-row').length
      }),
      gameId
    );
    assert.equal(firstTree.count, Math.min(12, firstTree.total));
    assert.ok(firstTree.total > 0);
    if (firstTree.total > 12) {
      const childGroup = page.locator(`.tree-node[data-node-id="${gameId}"] > .tree-children`);
      await childGroup.locator(':scope > .tree-pager button').filter({ hasText: '下一页' }).click();
      await page.waitForFunction(
        (id) => folderTree.pages.get(id)?.offset === 12 && !folderTree.loading.has(id),
        gameId
      );
    }
    report.tree = {
      ...firstTree,
      page2: await page.evaluate((id) => folderTree.pages.get(id).items.length, gameId)
    };
    assert.ok((await page.locator('.tree-row').count()) < 96);
    await page.screenshot({ path: 'artifacts/v2-tree-1080p.png', scale: 'css' });
    treeFixture = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-tree-v2-'));
    for (let i = 1; i <= 18; i++)
      await fs.mkdir(path.join(treeFixture, `子目录${String(i).padStart(2, '0')}`));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, treeFixture);
    await page.evaluate(() => window.album.call('import'));
    const fixtureId = idFor(treeFixture);
    await page.waitForFunction((id) => S.roots.some((n) => n.id === id), fixtureId);
    await page.locator('#rail-tree').hover({ force: true });
    await page.waitForFunction(() => sidebarOpen);
    await page.locator(`.tree-node[data-node-id="${fixtureId}"] > .tree-row .tree-toggle`).click();
    await page.waitForFunction(
      (id) => folderTree.pages.get(id)?.items.length === 12 && !folderTree.loading.has(id),
      fixtureId
    );
    await page
      .locator(`.tree-node[data-node-id="${fixtureId}"] > .tree-children > .tree-pager button`)
      .filter({ hasText: '下一页' })
      .click();
    await page.waitForFunction(
      (id) =>
        folderTree.pages.get(id)?.offset === 12 &&
        folderTree.pages.get(id)?.items.length === 6 &&
        !folderTree.loading.has(id),
      fixtureId
    );
    report.tree.pagination = {
      total: 18,
      firstPage: 12,
      secondPage: 6,
      dom: await page.locator('.tree-row').count()
    };
    await page.evaluate((id) => window.album.call('removeRoot', { id }), fixtureId);
    await page.waitForFunction((id) => !S.roots.some((n) => n.id === id), fixtureId);
    await page.evaluate(() => {
      setSidebarOpen(false);
      document.activeElement.blur();
    });
    await page.mouse.move(1100, 700);
    await goto(animations);
    await decoded();
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: 'artifacts/v2-library-1080p.png', scale: 'css' });
    const bit = idFor(path.resolve('ACG图片/16bit的感动')),
      original = await page.evaluate((id) => window.album.call('get', { id }), bit),
      images = (
        await page.evaluate(
          (id) => window.album.call('list', { parent: id, filter: 'images', limit: 10 }),
          bit
        )
      ).items;
    const picks = [images.find((n) => n.name === '2.jpg'), images.find((n) => n.name === '3.jpg')];
    assert.ok(picks.every(Boolean));
    report.coverSwitch = [];
    for (const selected of picks) {
      await app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      }, selected.path);
      await page.evaluate((id) => {
        window.__coverSnapshot = {
          version: S.loadVersion,
          gridVersion: grid.version,
          target: document.querySelector(`.album-card[data-id="${id}"]`),
          siblings: [...document.querySelectorAll('.album-card')].filter(
            (e) => e.dataset.id !== id
          ),
          scroll: document.querySelector('#viewport').scrollTop
        };
      }, bit);
      const card = page.locator(`.album-card[data-id="${bit}"]`);
      await card.click({ button: 'right' });
      const begin = performance.now();
      await page.getByRole('menuitem', { name: '更换封面…', exact: true }).click();
      await page.waitForFunction(
        ({ id, cover }) => {
          const img = document.querySelector(`.album-card[data-id="${id}"] img`);
          return img?.getAttribute('src').includes(cover) && img.complete && img.naturalWidth > 0;
        },
        { id: bit, cover: selected.id }
      );
      const status = await page.evaluate(
        (id) => ({
          elapsed: performance.now(),
          sameTarget:
            window.__coverSnapshot.target ===
            document.querySelector(`.album-card[data-id="${id}"]`),
          sameSiblings: window.__coverSnapshot.siblings.every((el) => el.isConnected),
          sameLoadVersion: S.loadVersion === window.__coverSnapshot.version,
          sameGridVersion: grid.version === window.__coverSnapshot.gridVersion,
          sameScroll:
            window.__coverSnapshot.scroll === document.querySelector('#viewport').scrollTop
        }),
        bit
      );
      const ms = +(performance.now() - begin).toFixed(2);
      assert.equal(status.sameTarget, true);
      assert.equal(status.sameSiblings, true);
      assert.equal(status.sameLoadVersion, true);
      assert.equal(status.sameGridVersion, true);
      assert.equal(status.sameScroll, true);
      report.coverSwitch.push({
        file: selected.name,
        pickerMocked: true,
        pickerCommitToDecodedMs: ms,
        ...status
      });
    }
    const cropCard = page.locator(`.album-card[data-id="${bit}"]`);
    await cropCard.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '调整封面位置…', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#crop-image')?.naturalWidth > 0);
    await page.evaluate(() => {
      window.__nativeCropDrags = 0;
      document
        .querySelector('#crop-preview')
        .addEventListener('dragstart', () => window.__nativeCropDrags++);
    });
    const cropBox = await page.locator('#crop-preview').boundingBox();
    await page.mouse.move(cropBox.x + cropBox.width / 2, cropBox.y + cropBox.height / 2);
    await page.mouse.wheel(0, -480);
    await page.waitForFunction(() => Number(document.querySelector('#crop-zoom').value) > 180);
    const beforeDrag = await page.locator('#crop-x').inputValue();
    await page.mouse.down();
    await page.mouse.move(cropBox.x + cropBox.width / 2 + 48, cropBox.y + cropBox.height / 2 + 24, {
      steps: 8
    });
    await page.mouse.up();
    assert.notEqual(await page.locator('#crop-x').inputValue(), beforeDrag);
    assert.equal(await page.evaluate(() => window.__nativeCropDrags), 0);
    assert.equal(await page.evaluate(() => getSelection().toString()), '');
    assert.equal(await page.locator('#crop-image').evaluate((el) => el.draggable), false);
    await page.locator('#crop-x').fill('35');
    await page.locator('#crop-y').fill('65');
    await page.locator('#crop-zoom').fill('175');
    await page.screenshot({ path: 'artifacts/v2-crop-1080p.png', scale: 'css' });
    await page.locator('#crop-save').click();
    await page.waitForFunction(() => !document.querySelector('#modal').open);
    const savedCrop = await page.evaluate((id) => window.album.call('get', { id }), bit);
    assert.equal(savedCrop.crop_x, 35);
    assert.equal(savedCrop.crop_y, 65);
    assert.equal(savedCrop.crop_zoom, 1.75);
    await cropCard.click({ button: 'right' });
    await page.getByRole('menuitem', { name: '调整封面位置…', exact: true }).click();
    assert.equal(await page.locator('#crop-zoom').inputValue(), '175');
    await page.locator('#crop-center').click();
    await page.locator('#crop-cancel').click();
    assert.equal(
      (await page.evaluate((id) => window.album.call('get', { id }), bit)).crop_zoom,
      1.75
    );
    report.cropInteraction = {
      wheelZoom: true,
      heldMouseDrag: true,
      nativeDragStarts: 0,
      textSelection: '',
      sliders: true,
      persistedZoom: savedCrop.crop_zoom,
      cancelKeepsSavedState: true
    };
    // Restore the real library's manual cover and crop.
    await page.evaluate(async (n) => {
      if (n.manual_cover) await window.album.call('setCover', { id: n.id, imageId: n.cover });
      else await window.album.call('resetCover', { id: n.id });
      await window.album.call('patch', {
        id: n.id,
        changes: {
          crop_x: n.crop_x,
          crop_y: n.crop_y,
          crop_zoom: n.crop_zoom ?? 1,
          confirmed: n.confirmed
        }
      });
    }, original);
    await page.locator('#theme-button').click();
    await page.waitForFunction(() => S.settings.theme === 'dark');
    await page.screenshot({ path: 'artifacts/v2-library-dark-1080p.png', scale: 'css' });
    await page.locator('#theme-button').click();
    await page.locator('#profile-button').click();
    await page.waitForSelector('#profile-name');
    await page.locator('#profile-name').fill('测试朋友 · 测试');
    await page.locator('#profile-save').click();
    await page.waitForFunction(() => S.settings.nickname === '测试朋友 · 测试');
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, path.resolve('新建文件夹/996-1.jpg'));
    await page.locator('#avatar-choose').click();
    await page.waitForFunction(() => S.settings.avatar.startsWith('data:image/webp;base64,'));
    const identity = await page.evaluate(() => ({
      nickname: S.settings.nickname,
      avatar: S.settings.avatar
    }));
    await page.screenshot({ path: 'artifacts/v2-profile-1080p.png', scale: 'css' });
    await page.locator('#modal-close').click();
    await app.close();
    app = null;
    await launch();
    report.profilePersistence = await page.evaluate(
      (expected) => ({
        nickname: S.settings.nickname === expected.nickname,
        avatar: S.settings.avatar === expected.avatar,
        avatarDecoded: document.querySelector('#profile-button img').naturalWidth > 0
      }),
      identity
    );
    assert.equal(report.profilePersistence.nickname, true);
    assert.equal(report.profilePersistence.avatar, true);
    await page.evaluate(async (old) => {
      await saveSetting('nickname', old.nickname || '新朋友');
      await saveSetting('avatar', old.avatar || '');
      await saveSetting('sidebarMode', 'auto');
    }, originalSettings);
    await resize(3840, 2160);
    const pokemon = idFor(path.resolve('ACG图片/宝可梦'));
    const large = (
      await page.evaluate(
        (id) => window.album.call('list', { parent: id, filter: 'folders' }),
        pokemon
      )
    ).items.find((n) => n.files > 1000);
    assert.ok(large);
    await goto(large.id);
    await decoded();
    await page.screenshot({ path: 'artifacts/v2-gallery-4k.png', scale: 'css' });
    report.virtualization4k = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      total: grid.total,
      domCards: grid.cards.size,
      overflow: document.documentElement.scrollWidth > innerWidth
    }));
    assert.ok(report.virtualization4k.domCards < 250);
    assert.equal(report.virtualization4k.overflow, false);
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForFunction(
      () =>
        grid.cards.size > 0 &&
        Math.min(...grid.cards.keys()) > 900 &&
        !document.querySelector('.card-skeleton')
    );
    report.virtualization4k.bottom = await page.evaluate(() => ({
      first: Math.min(...grid.cards.keys()),
      domCards: grid.cards.size,
      cachedItems: grid.items.size
    }));
    assert.ok(report.virtualization4k.bottom.domCards < 250);
    await resize(1920, 1080);
    await goto(gameId);
    await decoded();
    await page.locator('#viewport').evaluate((el) => (el.scrollTop = 0));
    await page.screenshot({ path: 'artifacts/v2-games-1080p.png', scale: 'css' });
    report.layout1080 = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      toolbarWidths: [
        document.querySelector('.toolbar-left').offsetWidth,
        document.querySelector('.toolbar-right').offsetWidth
      ]
    }));
    assert.equal(report.layout1080.overflow, false);
    await resize(980, 680);
    report.minimumWindow = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      topbar: document.querySelector('.topbar').getBoundingClientRect().right <= innerWidth,
      mainWidth: document.querySelector('main').clientWidth
    }));
    assert.equal(report.minimumWindow.overflow, false);
    assert.equal(report.minimumWindow.topbar, true);
    await resize(1920, 1080);
    await page.evaluate(() => navigate({}));
    await page.waitForSelector('.collection-tile');
    await page.screenshot({ path: 'artifacts/v2-home-1080p.png', scale: 'css' });
    assert.deepEqual(
      { games: await manifest(games), animation: await manifest(path.resolve('ACG图片')) },
      before
    );
    await fs.writeFile('artifacts/v2-source-manifest.json', JSON.stringify(before, null, 2));
    report.sourceSafety = {
      checkedFiles: before.games.length + before.animation.length,
      allHashesAndModificationTimesUnchanged: true
    };
    report.errors = [...new Set(errors)];
    assert.deepEqual(report.errors, []);
    await page.evaluate(async (old) => {
      await saveSetting('categoryType', old.categoryType);
      await saveSetting('autoMatch', old.autoMatch);
    }, originalSettings);
    await fs.writeFile('artifacts/v2-ui-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    if (page)
      await page.screenshot({ path: 'artifacts/v2-error.png', scale: 'css' }).catch(() => {});
    console.error('UI ERRORS', errors);
    throw e;
  } finally {
    if (app) {
      if (treeFixture)
        await page
          .evaluate(
            (id) => window.album.call('removeRoot', { id }).catch(() => {}),
            idFor(treeFixture)
          )
          .catch(() => {});
      await app.close().catch(() => {});
    }
    if (treeFixture) {
      assert.ok(path.resolve(treeFixture).startsWith(path.join(os.tmpdir(), 'acg-tree-v2-')));
      await fs.rm(treeFixture, { recursive: true, force: true });
    }
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
