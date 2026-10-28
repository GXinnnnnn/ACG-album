'use strict';
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const report = {
  scope:
    'Source Electron, isolated empty profile; no personal library or public HTTP; no import confirmation or destructive action.',
  checks: [],
  screenshots: [],
  errors: []
};
let app, page, run;
async function check(name, action) {
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
}
async function backdrop(dialog) {
  const r = await dialog.boundingBox();
  assert.ok(r && r.x > 5, 'Generated viewport leaves a backdrop target');
  await page.mouse.click(2, r.y + Math.min(r.height / 2, 100));
  await expect(dialog).toBeVisible();
}
async function focusSample() {
  return page.locator('#local-search-button').evaluate((button) => ({
    focused: document.activeElement === button,
    visible: button.matches(':focus-visible'),
    marker: button.getAttribute('data-dialog-focus-return'),
    outline: getComputedStyle(button).outlineStyle,
    width: getComputedStyle(button).outlineWidth
  }));
}
(async () => {
  await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
  const base = await fs.realpath(path.join(root, 'artifacts'));
  run = path.join(
    base,
    'dialog_interaction',
    new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
      '_' +
      crypto.randomUUID().replace(/-/g, '_')
  );
  await fs.mkdir(run, { recursive: true });
  run = await fs.realpath(run);
  const relative = path.relative(base, run);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const profile = path.join(run, 'generated_profile');
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.errors.push('Unexpected renderer HTTP: ' + route.request().url());
    await route.abort();
  });
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumDialogInteraction
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const actualProfile = await app.evaluate(({ app, BrowserWindow, net, session }) => {
    globalThis.__dialogBlockedHttp = [];
    const originalFetch = net.fetch.bind(net);
    net.fetch = (input, ...options) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https?:\/\//i.test(url)) {
        globalThis.__dialogBlockedHttp.push({ source: 'main-fetch', url });
        return Promise.reject(new Error('Unexpected main HTTP: ' + url));
      }
      return originalFetch(input, ...options);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        globalThis.__dialogBlockedHttp.push({ source: 'session', url: details.url });
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    win.setFullScreen(false);
    win.unmaximize();
    win.setContentSize(1600, 1000);
    win.show();
    win.focus();
    return app.getPath('userData');
  });
  assert.equal(path.resolve(actualProfile), path.resolve(profile, 'chromium-profile'));
  const trigger = page.locator('#local-search-button');
  await check(
    'pointer local search keeps backdrop open and Escape restores pointer-origin focus',
    async () => {
      await trigger.click();
      const dialog = page.locator('#local-search-dialog');
      await expect(dialog).toBeVisible();
      await page.locator('#local-search-query').fill('生成测试关键词');
      await backdrop(dialog);
      await expect(page.locator('#local-search-query')).toHaveValue('生成测试关键词');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const sample = await focusSample();
      assert.equal(sample.focused, true);
      assert.ok(!sample.visible || (sample.marker === 'pointer' && sample.outline === 'none'));
      return sample;
    }
  );
  await check('keyboard local search preserves an accessible return ring', async () => {
    await trigger.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(trigger).toBeFocused();
    assert.equal((await focusSample()).visible, true);
    await page.keyboard.press('Enter');
    await expect(page.locator('#local-search-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#local-search-dialog')).toHaveCount(0);
    const sample = await focusSample();
    assert.equal(sample.focused, true);
    assert.equal(sample.visible, true);
    assert.equal(sample.marker, null);
    assert.equal(sample.width, '2px');
    return sample;
  });
  await check('keyword focus ring stays inside its field at both themes and widths', async () => {
    const samples = [];
    for (const width of [980, 1600])
      for (const theme of ['light', 'dark']) {
        await app.evaluate(
          ({ BrowserWindow }, width) =>
            BrowserWindow.getAllWindows()[0].setContentSize(width, 1000),
          width
        );
        await page.waitForFunction((width) => innerWidth === width, width);
        await page.evaluate((theme) => saveSetting('theme', theme), theme);
        await trigger.click();
        const query = page.locator('#local-search-query');
        await query.fill('焦点边框验证');
        await query.focus();
        const sample = await query.evaluate((input) => {
          const style = getComputedStyle(input),
            rect = input.getBoundingClientRect(),
            clip = input.closest('.local-search-scroll').getBoundingClientRect();
          return {
            outlineWidth: style.outlineWidth,
            outlineOffset: style.outlineOffset,
            outlineStyle: style.outlineStyle,
            left: rect.left,
            right: rect.right,
            clipLeft: clip.left,
            clipRight: clip.right
          };
        });
        assert.equal(sample.outlineWidth, '2px');
        assert.equal(sample.outlineStyle, 'solid');
        assert.ok(Number.parseFloat(sample.outlineOffset) <= -2);
        assert.ok(sample.left >= sample.clipLeft && sample.right <= sample.clipRight);
        const screenshot = path.join(run, `${theme}_${width}_keyword.png`);
        await page.screenshot({ path: screenshot, scale: 'css' });
        report.screenshots.push(screenshot);
        samples.push({ width, theme, ...sample });
        await page.locator('#local-search-close').click();
        await expect(page.locator('#local-search-dialog')).toHaveCount(0);
      }
    return samples;
  });
  await check(
    'settings and nested About ignore backdrops while child Escape preserves its parent',
    async () => {
      await page.evaluate(() => settingsModal());
      const parent = page.locator('#modal');
      await expect(parent).toBeVisible();
      await backdrop(parent);
      await page.evaluate(() => window.showAbout());
      const child = page.locator('dialog[data-info-child="true"]');
      await expect(child).toBeVisible();
      await backdrop(child);
      await page.keyboard.press('Escape');
      await expect(child).toHaveCount(0);
      await expect(parent).toBeVisible();
      await page.locator('#modal-close').click();
      await expect(parent).not.toBeVisible();
    }
  );
  await check(
    'import custom select and explicit cancel remain operable without background dismissal',
    async () => {
      await page.locator('#import-sidebar').click();
      const dialog = page.locator('#modal');
      await expect(page.locator('#import-options')).toBeVisible();
      await backdrop(dialog);
      const picker = page.locator('#import-directory-kind').locator('..').getByRole('combobox');
      await picker.click();
      await expect(picker).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(picker).toHaveAttribute('aria-expanded', 'false');
      await expect(dialog).toBeVisible();
      await page.locator('#import-options-cancel').click();
      await expect(dialog).not.toBeVisible();
    }
  );
  await check('confirmation backdrop does not execute or cancel the explicit action', async () => {
    await page.evaluate(() => {
      window.__dialogConfirmExecuted = false;
      confirmModal('交互验证', '此确认不涉及个人资料或文件。', () => {
        window.__dialogConfirmExecuted = true;
      });
    });
    const dialog = page.locator('#modal');
    await expect(dialog).toBeVisible();
    await backdrop(dialog);
    await page.locator('#confirm-cancel').click();
    await expect(dialog).not.toBeVisible();
    assert.equal(await page.evaluate(() => window.__dialogConfirmExecuted), false);
  });
  report.blockedHttp = await app.evaluate(() => globalThis.__dialogBlockedHttp);
  assert.deepEqual(report.blockedHttp, [], 'No public main/session HTTP was attempted');
  assert.deepEqual(report.errors, []);
  report.passed = true;
})()
  .catch(async (error) => {
    report.passed = false;
    report.failure = error.stack;
    process.exitCode = 1;
    if (page && run)
      await page.screenshot({ path: path.join(run, 'failure.png'), scale: 'css' }).catch(() => {});
  })
  .finally(async () => {
    if (app) {
      let timer;
      try {
        await Promise.race([
          app.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Electron close timeout')), 15000);
          })
        ]);
        report.closed = true;
      } catch (error) {
        report.errors.push(error.stack);
        const child = app.process();
        if (child && child.exitCode === null && child.signalCode === null) {
          let exitTimer;
          try {
            await new Promise((resolve, reject) => {
              child.once('exit', resolve);
              exitTimer = setTimeout(
                () => reject(new Error('Owned Electron did not exit after kill')),
                5000
              );
              child.kill();
            });
          } catch (failure) {
            report.errors.push(failure.stack);
          } finally {
            clearTimeout(exitTimer);
          }
        }
        report.passed = false;
        process.exitCode = 1;
      } finally {
        clearTimeout(timer);
      }
    }
    report.finishedAt = new Date().toISOString();
    if (run) {
      const output = path.join(run, 'report.json');
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(output);
    }
  });
