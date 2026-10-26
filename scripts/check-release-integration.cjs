'use strict';
// Isolated real Electron checks. Network responses and external navigation are intercepted.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const official = 'GXinnnnnn/ACG-album';
const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const online = process.env.ACG_RELEASE_ONLINE === '1';
const report = {
  checks: [],
  errors: [],
  screenshots: [],
  online,
  runtime: {
    mode: executable ? 'packaged' : 'source',
    executable: executable || require('electron')
  },
  scope:
    'Isolated generated profile; mock API and intercepted system browser links. Optional final online check is explicitly recorded.'
};
let app,
  page,
  run,
  stage = 'setup';
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function check(name, action) {
  stage = name;
  await action();
  report.checks.push({ name, status: 'passed' });
  console.log('PASS ' + name);
}
async function mode(value) {
  await app.evaluate((_, value) => {
    global.__releaseIntegration.mode = value;
    global.__releaseIntegration.requests = [];
    global.__releaseIntegration.external = [];
  }, value);
}
async function state() {
  return app.evaluate(() => ({
    requests: global.__releaseIntegration.requests,
    external: global.__releaseIntegration.external
  }));
}
async function closeDialogs() {
  await page.evaluate(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  });
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
(async () => {
  try {
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'release_integration',
      new Date().toISOString().replace(/[^a-z0-9]/gi, '_') +
        '_' +
        crypto.randomUUID().replace(/-/g, '_')
    );
    const profile = path.join(run, 'profile');
    await fs.mkdir(profile, { recursive: true });
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'missing-index.sqlite')
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: report.runtime.executable,
      args: executable ? [] : ['.'],
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
    Object.assign(
      report.runtime,
      await app.evaluate(({ app }) => ({ version: app.getVersion(), isPackaged: app.isPackaged }))
    );
    assert.equal(report.runtime.version, version);
    await app.evaluate(({ net, shell, BrowserWindow }) => {
      global.__releaseIntegration = {
        mode: 'available',
        requests: [],
        external: [],
        originalFetch: net.fetch
      };
      shell.openExternal = async (url) => {
        global.__releaseIntegration.external.push(url);
      };
      net.fetch = async (url, options = {}) => {
        const state = global.__releaseIntegration;
        state.requests.push({ url, method: options.method || 'GET', redirect: options.redirect });
        if (state.mode === 'failure') throw new Error('Injected offline connection');
        const parsed = new URL(url);
        const repository =
          parsed.hostname === 'api.github.com'
            ? parsed.pathname.split('/').slice(2, 4).join('/')
            : parsed.pathname.split('/').slice(1, 3).join('/');
        if (state.mode === 'limited' && parsed.hostname === 'api.github.com')
          return { status: 403, ok: false };
        if (parsed.hostname === 'github.com')
          return {
            status: 200,
            ok: true,
            url: 'https://github.com/' + repository + '/releases/tag/v1.1.2'
          };
        return {
          status: 200,
          ok: true,
          json: async () => ({
            tag_name: 'v1.1.2',
            draft: false,
            prerelease: false,
            html_url: 'https://github.com/' + repository + '/releases/tag/v1.1.2'
          })
        };
      };
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(980, 680);
    });
    await page.waitForFunction(() => innerWidth === 980);
    const expectedDownload = (edition) =>
      'https://github.com/' +
      official +
      '/releases/download/v' +
      version +
      '/ACG-album-Setup-' +
      version +
      '-' +
      edition +
      '.exe';
    await check(
      'new profile defaults to official updates and same-version library assets',
      async () => {
        const info = await rpc('appInfo');
        assert.equal(info.repository, official);
        assert.equal(info.officialRepository, official);
        assert.equal(
          info.releaseUrl,
          'https://github.com/' + official + '/releases/tag/v' + version
        );
        assert.equal(info.downloads.lite, expectedDownload('Lite'));
        assert.equal(info.downloads.full, expectedDownload('Full'));
        report.links = {
          repository: info.repository,
          releaseUrl: info.releaseUrl,
          downloads: info.downloads
        };
      }
    );
    await check('update UI is preconfigured and checks the official stable release', async () => {
      await page.evaluate(() => window.showUpdates());
      await expect(page.locator('#album-update-repository')).toHaveValue(official);
      await page.locator('[data-update-check]').click();
      await expect(page.locator('[data-update-status="available"]')).toBeVisible();
      const calls = await state();
      assert.equal(calls.requests.length, 1);
      assert.equal(
        calls.requests[0].url,
        'https://api.github.com/repos/' + official + '/releases/latest'
      );
      await page.locator('.updates-result-card .about-release-link').click();
      assert.deepEqual((await state()).external, [
        'https://github.com/' + official + '/releases/tag/v1.1.2'
      ]);
    });
    await check(
      'GitHub API rate limit uses a validated public latest release fallback',
      async () => {
        await mode('limited');
        await page.locator('[data-update-check]').click();
        await expect(page.locator('[data-update-status="available"]')).toBeVisible();
        await expect.poll(async () => (await state()).requests.length).toBe(2);
        const calls = await state();
        assert.equal(calls.requests[1].url, 'https://github.com/' + official + '/releases/latest');
        assert.equal(calls.requests[1].method, 'HEAD');
        assert.equal(calls.requests[1].redirect, 'follow');
      }
    );
    await check('connection failures remain errors with a repository release link', async () => {
      await mode('failure');
      await page.locator('[data-update-check]').click();
      await expect(page.locator('#album-update-error')).toContainText('检查未完成');
      await expect(
        page
          .locator('.album-updates a[href="https://github.com/' + official + '/releases"]')
          .first()
      ).toBeVisible();
      await expect(page.locator('[data-update-status="current"]')).toHaveCount(0);
    });
    await check('custom update repositories remain supported', async () => {
      await mode('available');
      await page.locator('#album-update-repository').fill('Example/AlbumFork');
      await page.locator('[data-update-check]').click();
      await expect(page.locator('[data-update-status="available"]')).toBeVisible();
      assert.equal(
        (await state()).requests[0].url,
        'https://api.github.com/repos/Example/AlbumFork/releases/latest'
      );
      assert.equal((await rpc('appInfo')).repository, 'Example/AlbumFork');
      await screenshot('official-and-custom-update-settings');
    });
    // Library selectors are intentionally accessible labels rather than coupling to layout.
    await check(
      'library supplement downloads use official same-version assets despite custom updates',
      async () => {
        await closeDialogs();
        await page.evaluate(() => window.albumLocalSearch.show());
        await expect(page.locator('#local-search-dialog')).toBeVisible();
        await expect(page.locator('#local-search-dialog')).toContainText('资料库补全');
        const lite = page.locator('#local-search-download-lite');
        const full = page.locator('#local-search-download-full');
        await expect(page.locator('#local-search-downloads')).toHaveAttribute(
          'data-download-state',
          'ready'
        );
        await expect(lite).toBeEnabled();
        await expect(full).toBeEnabled();
        await mode('available');
        await lite.click();
        await full.click();
        assert.deepEqual((await state()).external, [
          expectedDownload('Lite'),
          expectedDownload('Full')
        ]);
        await expect(page.locator('#local-search-dialog')).toContainText('覆盖安装');
        await expect(page.locator('#local-search-dialog')).toContainText('相同');
        await screenshot('library-supplement-downloads');
      }
    );
    await check('clearing legacy update configuration restores official defaults', async () => {
      await rpc('settings', { key: 'githubRepository', value: '' });
      assert.equal((await rpc('appInfo')).repository, official);
      assert.equal((await rpc('init')).settings.githubRepository, official);
    });
    if (online)
      await check(
        'published release is reachable through the actual in-app update check',
        async () => {
          await app.evaluate(({ net }) => {
            net.fetch = global.__releaseIntegration.originalFetch;
          });
          const result = await rpc('checkUpdate');
          assert.equal(result.repository, official);
          assert.equal(result.currentVersion, version);
          assert.equal(result.latestVersion, version);
          assert.equal(result.status, 'current');
          assert.equal(result.url, 'https://github.com/' + official + '/releases/tag/v' + version);
          report.onlineUpdate = result;
        }
      );
    if (online)
      await check(
        'published release fallback follows the real Electron public redirect after a forced API rate limit',
        async () => {
          await app.evaluate(({ net }, official) => {
            const original = global.__releaseIntegration.originalFetch;
            net.fetch = (url, options) =>
              String(url) === `https://api.github.com/repos/${official}/releases/latest`
                ? Promise.resolve(new Response('', { status: 403 }))
                : original(url, options);
          }, official);
          try {
            const result = await rpc('checkUpdate');
            assert.equal(result.repository, official);
            assert.equal(result.currentVersion, version);
            assert.equal(result.latestVersion, version);
            assert.equal(result.status, 'current');
            assert.equal(
              result.url,
              'https://github.com/' + official + '/releases/tag/v' + version
            );
            report.onlineFallback = result;
          } finally {
            await app.evaluate(({ net }) => {
              net.fetch = global.__releaseIntegration.originalFetch;
            });
          }
        }
      );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
