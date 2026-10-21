const { _electron: electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const packaged = process.argv.includes('--packaged');
const report = { packaged, errors: [] };
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-theme-'));
  let app, page;
  async function launch() {
    const env = { ...process.env, ACG_DATA_DIR: data, ACG_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath: packaged
        ? path.resolve(
            require('./distribution-paths.cjs').runtimeDirectory(),
            `${require('../package.json').build.productName}.exe`
          )
        : require('electron'),
      args: packaged ? [] : ['.'],
      env
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => report.errors.push(e.message));
    await page.waitForFunction(
      () => document.querySelector('#index-count')?.textContent !== '正在准备资料库'
    );
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname !== undefined);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1920, 1032)
    );
  }
  async function settled() {
    await page.waitForFunction(
      () =>
        themeChangeTask === null && !document.documentElement.classList.contains('theme-revealing')
    );
  }
  async function freezeRipple() {
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .some((a) => a.effect?.pseudoElement === '::view-transition-new(root)')
    );
    return page.evaluate(() => {
      const a = document
        .getAnimations()
        .find((a) => a.effect?.pseudoElement === '::view-transition-new(root)');
      a.pause();
      a.currentTime = 60;
      const rect = document.querySelector('#theme-button').getBoundingClientRect();
      return {
        theme: S.settings.theme,
        duration: a.effect.getTiming().duration,
        frames: a.effect.getKeyframes().map((k) => k.clipPath),
        origin: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
        width: innerWidth,
        height: innerHeight
      };
    });
  }
  async function resume() {
    await page.evaluate(() =>
      document
        .getAnimations()
        .find((a) => a.effect?.pseudoElement === '::view-transition-new(root)')
        .play()
    );
    await settled();
  }
  try {
    await launch();
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('watchChanges', false);
    });
    await app.evaluate(
      ({ dialog }, source) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      },
      path.join(require('./distribution-paths.cjs').workspaceRoot, 'ACG图片')
    );
    await page.evaluate(() => window.album.call('import'));
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.collection-tile img').length > 0 &&
        [...document.querySelectorAll('.collection-tile img')].every(
          (i) => i.complete && i.naturalWidth > 0
        )
    );
    await page.evaluate(async () => {
      await changeTheme('light');
      window.__themeTest = { starts: 0, active: 0, maxActive: 0 };
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = function (update) {
        const t = start(update);
        const s = window.__themeTest;
        s.starts++;
        s.active++;
        s.maxActive = Math.max(s.maxActive, s.active);
        t.finished.catch(() => {}).finally(() => s.active--);
        return t;
      };
      window.__themeGrid = {
        node: document.querySelector('.collection-tile'),
        version: S.loadVersion,
        scroll: document.querySelector('#viewport').scrollTop
      };
    });
    await page.locator('#theme-button').click();
    report.toDark = await freezeRipple();
    assert.equal(report.toDark.theme, 'dark');
    assert.equal(report.toDark.duration, 300);
    await page.screenshot({
      path: `artifacts/theme-${packaged ? 'packaged' : 'source'}-to-dark.png`
    });
    await resume();
    await page.locator('#theme-button').focus();
    await page.keyboard.press('Enter');
    report.toLight = await freezeRipple();
    assert.equal(report.toLight.theme, 'light');
    await page.screenshot({
      path: `artifacts/theme-${packaged ? 'packaged' : 'source'}-to-light.png`
    });
    await resume();
    assert.deepEqual(report.toDark.origin, report.toLight.origin);
    for (const step of [report.toDark, report.toLight])
      assert.ok(step.frames[0].includes(`at ${step.origin.x}px ${step.origin.y}px`));
    report.stableGallery = await page.evaluate(() => ({
      node: window.__themeGrid.node === document.querySelector('.collection-tile'),
      version: window.__themeGrid.version === S.loadVersion,
      scroll: window.__themeGrid.scroll === document.querySelector('#viewport').scrollTop
    }));
    assert.deepEqual(report.stableGallery, { node: true, version: true, scroll: true });
    await page.locator('#theme-button').click({ clickCount: 3, delay: 20 });
    await settled();
    report.rapidClicks = await page.evaluate(() => ({
      theme: S.settings.theme,
      ...window.__themeTest
    }));
    assert.equal(report.rapidClicks.theme, 'dark');
    assert.equal(report.rapidClicks.maxActive, 1);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const starts = report.rapidClicks.starts;
    await page.locator('#theme-button').click();
    await settled();
    report.reducedMotion = await page.evaluate(() => ({
      theme: S.settings.theme,
      starts: window.__themeTest.starts
    }));
    assert.equal(report.reducedMotion.theme, 'light');
    assert.equal(report.reducedMotion.starts, starts);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      window.__originalStart = document.startViewTransition;
      document.startViewTransition = undefined;
    });
    await page.locator('#theme-button').click();
    await settled();
    report.fallback = await page.evaluate(() => S.settings.theme);
    assert.equal(report.fallback, 'dark');
    await page.evaluate(() => {
      document.startViewTransition = (update) => {
        const t = window.__originalStart(update);
        t.skipTransition();
        return t;
      };
    });
    await page.locator('#theme-button').click();
    await settled();
    report.skippedSnapshot = await page.evaluate(() => S.settings.theme);
    assert.equal(report.skippedSnapshot, 'light');
    await page.evaluate(() => {
      document.startViewTransition = window.__originalStart;
    });
    await page.evaluate(() => settingsModal());
    const themeSelect = page.locator('#theme-select').locator('..');
    await themeSelect.locator('.album-select-button').click();
    await themeSelect.locator('.album-select-option[data-index="1"]').click();
    await settled();
    report.settingsTheme = await page.evaluate(() => ({
      theme: S.settings.theme,
      value: document.querySelector('#theme-select').value
    }));
    assert.deepEqual(report.settingsTheme, { theme: 'dark', value: 'dark' });
    await app.close();
    app = null;
    await launch();
    report.restartTheme = await page.evaluate(() => S.settings.theme);
    assert.equal(report.restartTheme, 'dark');
    assert.deepEqual(report.errors, []);
    await fs.writeFile(
      `artifacts/theme-${packaged ? 'packaged' : 'source'}-report.json`,
      JSON.stringify(report, null, 2)
    );
    console.log(JSON.stringify(report, null, 2));
  } catch (e) {
    if (page) await page.screenshot({ path: 'artifacts/theme-error.png' }).catch(() => {});
    throw e;
  } finally {
    if (app) await app.close().catch(() => {});
    assert.ok(data.startsWith(path.join(os.tmpdir(), 'acg-theme-')));
    await fs.rm(data, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
