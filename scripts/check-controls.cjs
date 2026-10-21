'use strict';
// Run serially: node scripts/check-controls.cjs [--packaged]. No real library/profile is used.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const metadata = require('../package.json');
const { latestMediaProfile } = require('./fixture-profile.cjs');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const run = path.join(
  root,
  'artifacts/controls-integration',
  `${packaged ? 'packaged' : 'source'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
);
const profile = path.join(run, 'profile');
const freshProfile = path.join(run, 'fresh-profile');
const report = {
  packaged,
  version: metadata.version,
  run,
  checks: [],
  screenshots: [],
  errors: []
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
let app,
  page,
  stage = 'setup';

async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    if (page && !page.isClosed())
      await screenshot('failure-' + report.checks.length).catch(() => {});
    throw error;
  }
}
async function closeApp() {
  if (app) await app.close();
  app = null;
  page = null;
}
async function launch(data) {
  assert.ok(
    path.resolve(data).startsWith(run + path.sep),
    "Only this run's isolated profiles may launch."
  );
  const env = { ...process.env, ACG_DATA_DIR: data, ACG_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: packaged
      ? path.join(
          require('./distribution-paths.cjs').runtimeDirectory(),
          `${metadata.build.productName}.exe`
        )
      : require('electron'),
    args: packaged ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.settings.nickname !== undefined && window.albumControls
  );
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1440, 960);
    win.webContents.setBackgroundThrottling(false);
  });
  await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 960);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const runtime = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    version: app.getVersion(),
    packaged: app.isPackaged
  }));
  assert.equal(path.resolve(runtime.userData), path.join(data, 'chromium-profile'));
  assert.equal(runtime.version, metadata.version);
  assert.equal(runtime.packaged, packaged);
  assert.equal(await page.title(), 'ACG-album');
}
async function openSettings(tab = 'appearance') {
  if (await page.locator('#modal').evaluate((modal) => modal.open))
    await page.locator('#modal-close').click();
  await page.locator('#settings-button').click();
  if (tab !== 'appearance') await page.locator(`[data-tab='${tab}']`).click();
  await page.waitForSelector(`[data-tab='${tab}'][aria-selected='true']`);
}
async function control(id) {
  const source = page.locator('#' + id);
  const wrapper = source.locator('..');
  const button = wrapper.locator('.album-select-button');
  await button.waitFor({ state: 'visible' });
  assert.equal(
    await wrapper.getAttribute('class').then((v) => v.split(/\s+/).includes('album-select')),
    true
  );
  assert.equal(await source.isVisible(), false);
  assert.equal(await button.getAttribute('role'), 'combobox');
  const list = page.locator('#' + (await button.getAttribute('aria-controls')));
  return { source, wrapper, button, list };
}
async function pointerSelect(id, value, shot) {
  const c = await control(id);
  const option = await c.source.evaluate((select, value) => {
    const index = [...select.options].findIndex((option) => option.value === value);
    if (index < 0) throw new Error('Missing option ' + value);
    return { index, label: select.options[index].label };
  }, value);
  await c.button.click();
  assert.equal(await c.button.getAttribute('aria-expanded'), 'true');
  await c.list.waitFor({ state: 'visible' });
  assert.equal(await c.list.evaluate((list) => list.matches(':popover-open')), true);
  const bounds = await c.list.boundingBox();
  assert.ok(
    bounds.x >= 0 &&
      bounds.y >= 0 &&
      bounds.x + bounds.width <= 1441 &&
      bounds.y + bounds.height <= 961
  );
  if (shot) await screenshot(shot);
  await c.list.locator(`[data-index='${option.index}']`).click();
  assert.equal(await c.source.inputValue(), value);
  assert.equal(await c.button.getAttribute('aria-expanded'), 'false');
  assert.equal(await c.button.locator('.album-select-value').textContent(), option.label);
  return option;
}
async function escapeSelect(id) {
  const c = await control(id);
  const before = await c.source.inputValue();
  await c.button.focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await c.button.getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  assert.equal(await c.button.getAttribute('aria-expanded'), 'false');
  assert.equal(await c.source.inputValue(), before);
  assert.equal(await page.locator('#modal').evaluate((modal) => modal.open), true);
  assert.equal(await c.button.evaluate((button) => document.activeElement === button), true);
  return { value: before, dialogStillOpen: true, focusRetained: true };
}

(async () => {
  assert.equal(metadata.build.productName, 'ACG-album');
  const fixture = await latestMediaProfile(root);
  assert.ok(
    path.resolve(fixture).startsWith(path.join(root, 'artifacts/media-integration') + path.sep)
  );
  await fs.mkdir(run, { recursive: true });
  await fs.cp(fixture, profile, { recursive: true });
  await fs.mkdir(freshProfile);
  report.fixture = fixture;
  try {
    await launch(freshProfile);
    await check('fresh profile displays the local Bangumi default avatar', async () => {
      assert.equal(await page.evaluate(() => S.settings.avatar), '');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('.user-avatar')].every(
          (image) => image.complete && image.naturalWidth > 0
        )
      );
      const avatars = await page.locator('.user-avatar').evaluateAll((images) =>
        images.map((image) => ({
          src: image.getAttribute('src'),
          width: image.naturalWidth,
          height: image.naturalHeight
        }))
      );
      assert.ok(avatars.length > 0);
      assert.ok(
        avatars.every(
          (image) => /default-avatar\.jpg$/.test(image.src) && image.width > 0 && image.height > 0
        )
      );
      const bytes = await fs.readFile(path.join(root, 'src/assets/default-avatar.jpg'));
      const runtimeBytes = await app.evaluate(async ({ app, net }) => {
        const url =
          'file:///' + app.getAppPath().replaceAll('\\', '/') + '/src/assets/default-avatar.jpg';
        return Buffer.from(await (await net.fetch(url)).arrayBuffer()).toString('base64');
      });
      assert.equal(
        hash(Buffer.from(runtimeBytes, 'base64')),
        hash(bytes),
        'The launched application must carry the current Bangumi avatar asset.'
      );
      await screenshot('fresh-bangumi-avatar');
      return { avatars, assetSha256: hash(bytes) };
    });
    await closeApp();
    await launch(profile);
    report.clonedAvatar = await page.evaluate(() => S.settings.avatar);
    await check('top menus are absent and the settings gear stays square', async () => {
      assert.equal(await page.locator('[data-app-menu], .app-menus, [role="menubar"]').count(), 0);
      assert.equal(await app.evaluate(({ Menu }) => Menu.getApplicationMenu() === null), true);
      const gear = await page.locator('#settings-button svg').evaluate((svg) => {
        const rect = svg.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          viewBox: svg.getAttribute('viewBox'),
          paths: svg.querySelectorAll('path, circle').length
        };
      });
      assert.ok(gear.width > 0 && Math.abs(gear.width - gear.height) < 0.5);
      assert.equal(gear.viewBox, '0 0 24 24');
      assert.ok(gear.paths >= 2);
      return gear;
    });
    await check('expanded import control keeps its inner padding and icon text gap', async () => {
      await page.evaluate(async () => {
        await saveSetting('sidebarMode', 'expanded');
        applyNavigationSettings();
      });
      await page.waitForFunction(() =>
        document.querySelector('#sidebar-shell').classList.contains('is-open')
      );
      await page.evaluate(() =>
        Promise.all(
          document
            .querySelector('#sidebar-shell')
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {}))
        )
      );
      const geometry = await page.locator('#import-sidebar').evaluate((button) => {
        const style = getComputedStyle(button),
          rect = button.getBoundingClientRect();
        const icon = button.querySelector('span:first-child').getBoundingClientRect();
        const text = button.querySelector('.sidebar-label').getBoundingClientRect();
        return {
          paddingLeft: parseFloat(style.paddingLeft),
          paddingRight: parseFloat(style.paddingRight),
          gap: parseFloat(style.columnGap),
          iconInset: icon.left - rect.left,
          actualGap: text.left - icon.right,
          backgroundTextGap:
            text.left - (rect.left + parseFloat(getComputedStyle(button, '::before').width)),
          width: rect.width
        };
      });
      assert.ok(geometry.paddingLeft >= 8 && geometry.paddingRight >= 8);
      assert.ok(geometry.gap >= 8);
      assert.ok(Math.abs(geometry.paddingLeft - geometry.paddingRight) < 0.5);
      assert.ok(Math.abs(geometry.actualGap - geometry.gap) < 1);
      assert.ok(geometry.iconInset >= geometry.paddingLeft);
      assert.ok(geometry.backgroundTextGap >= 11.5);
      await screenshot('expanded-import-and-gear');
      return geometry;
    });
    await check(
      'settings tabs have complete pill shapes zero borders and symmetric padding',
      async () => {
        await openSettings();
        const tabs = await page.locator('.settings-tabs button').evaluateAll((buttons) =>
          buttons.map((button) => {
            const style = getComputedStyle(button),
              rect = button.getBoundingClientRect();
            return {
              tab: button.dataset.tab,
              height: rect.height,
              padding: [
                style.paddingTop,
                style.paddingRight,
                style.paddingBottom,
                style.paddingLeft
              ].map(parseFloat),
              border: [
                style.borderTopWidth,
                style.borderRightWidth,
                style.borderBottomWidth,
                style.borderLeftWidth
              ].map(parseFloat),
              radii: [
                style.borderTopLeftRadius,
                style.borderTopRightRadius,
                style.borderBottomRightRadius,
                style.borderBottomLeftRadius
              ].map(parseFloat)
            };
          })
        );
        assert.equal(tabs.length, 5);
        for (const tab of tabs) {
          assert.ok(
            tab.border.every((width) => width === 0),
            tab.tab
          );
          assert.ok(
            tab.radii.every((radius) => radius >= tab.height / 2),
            tab.tab
          );
          assert.equal(tab.padding[0], tab.padding[2]);
          assert.equal(tab.padding[1], tab.padding[3]);
        }
        await page.locator("[data-tab='appearance']").focus();
        await page.keyboard.press('End');
        await page.waitForSelector("[data-tab='application'][aria-selected='true']");
        assert.equal(await page.locator('#settings-about').isVisible(), true);
        assert.equal(await page.locator('#settings-updates').isVisible(), true);
        await page.keyboard.press('Home');
        await page.waitForSelector("[data-tab='profile'][aria-selected='true']");
        await page.locator("[data-tab='appearance']").click();
        await screenshot('settings-pill-tabs');
        return tabs;
      }
    );
    await check('custom settings select opens selects and cancels through real input', async () => {
      await pointerSelect('theme-select', 'dark', 'theme-select-open-dark');
      await page.waitForFunction(() => S.settings.theme === 'dark' && themeChangeTask === null);
      await escapeSelect('theme-select');
      const c = await control('theme-select');
      await c.button.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => S.settings.theme === 'light' && themeChangeTask === null);
      assert.equal(await c.source.inputValue(), 'light');
      await pointerSelect('theme-select', 'dark');
      await page.waitForFunction(() => S.settings.theme === 'dark' && themeChangeTask === null);
      return { pointer: 'dark', keyboard: 'light', persisted: 'dark', escape: 'unchanged' };
    });
    await check(
      'dynamically mounted display dialog enhances and persists ratio selection',
      async () => {
        await page.locator('#settings-density').click();
        const c = await control('ratio-select');
        await pointerSelect('ratio-select', 'square', 'dynamic-ratio-select-open');
        await page.waitForFunction(
          () => S.settings.ratio === 'square' && displayChangeTask === null
        );
        await escapeSelect('ratio-select');
        await c.button.focus();
        await page.keyboard.press('Space');
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => S.settings.ratio === 'tall' && displayChangeTask === null);
        assert.equal(await c.source.inputValue(), 'tall');
        await page.locator('#modal-close').click();
        assert.equal(await page.locator('.album-select-list:popover-open').count(), 0);
        await openSettings();
        await page.locator('#settings-density').click();
        const remounted = await control('ratio-select');
        assert.equal(await remounted.source.inputValue(), 'tall');
        assert.match(await remounted.button.textContent(), /9:16/);
        await screenshot('dynamic-display-tall-dark');
        return { pointer: 'square', keyboard: 'tall', remounted: 'tall' };
      }
    );
    let chosenAvatar;
    await check('chosen avatar updates through the profile button and remains local', async () => {
      await openSettings('profile');
      assert.equal(
        await page.evaluate(() => S.settings.avatar),
        report.clonedAvatar,
        'Cloning and changing controls must preserve an existing avatar.'
      );
      const image = path.join(run, 'chosen-avatar.png');
      await sharp({ create: { width: 96, height: 64, channels: 4, background: '#6f56cb' } })
        .png()
        .toFile(image);
      await app.evaluate(({ dialog }, image) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [image] });
      }, image);
      await page.locator('#avatar-choose').click();
      await page.waitForFunction(
        () =>
          /^data:image\/webp;base64,/.test(S.settings.avatar) &&
          document.querySelector('#identity-avatar')?.complete &&
          document.querySelector('#identity-avatar')?.naturalWidth === 256
      );
      chosenAvatar = await page.evaluate(() => S.settings.avatar);
      assert.equal(await page.locator('#identity-avatar').getAttribute('src'), chosenAvatar);
      assert.equal(
        await page.locator('#profile-button .user-avatar').getAttribute('src'),
        chosenAvatar
      );
      await screenshot('chosen-avatar-profile');
      return { sha256: hash(chosenAvatar), originalAvatarPreservedUntilUserChoice: true };
    });
    await closeApp();
    await launch(profile);
    await check('theme ratio and user chosen avatar survive restart', async () => {
      const persisted = await page.evaluate(() => ({
        theme: S.settings.theme,
        ratio: S.settings.ratio,
        avatar: S.settings.avatar
      }));
      assert.equal(persisted.theme, 'dark');
      assert.equal(persisted.ratio, 'tall');
      assert.equal(persisted.avatar, chosenAvatar);
      await openSettings();
      assert.equal(await (await control('theme-select')).source.inputValue(), 'dark');
      await page.locator('#settings-density').click();
      assert.equal(await (await control('ratio-select')).source.inputValue(), 'tall');
      await screenshot('restart-persisted-controls');
      return {
        theme: persisted.theme,
        ratio: persisted.ratio,
        avatarSha256: hash(persisted.avatar)
      };
    });
    await check('renderer completes without uncaught errors', async () => {
      assert.deepEqual(report.errors, []);
      return { errors: 0 };
    });
  } catch (error) {
    report.fatal = error.stack;
    process.exitCode = 1;
  } finally {
    await closeApp().catch((error) => {
      report.closeError = error.stack;
      process.exitCode = 1;
    });
    report.summary = {
      passed: report.checks.filter((check) => check.status === 'passed').length,
      failed: report.checks.filter((check) => check.status === 'failed').length
    };
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ run, summary: report.summary, fatal: report.fatal || null }));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
