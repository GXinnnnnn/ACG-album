'use strict';
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const metadata = require('../package.json');
const currentVersion = metadata.version;
const versionParts = currentVersion.split('.').map(Number);
assert.ok(
  versionParts.length === 3 &&
    versionParts.every((part) => Number.isSafeInteger(part) && part >= 0),
  'The update fixture requires a stable three-part application version.'
);
const latestVersion = `${versionParts[0]}.${versionParts[1]}.${versionParts[2] + 1}`;
assert.equal(metadata.build.productName, 'ACG-album');
const root = path.resolve(__dirname, '..'),
  packaged = process.argv.includes('--packaged'),
  focused = process.argv.includes('--focus-metadata');
const run = path.join(
  root,
  'artifacts/release-ui',
  (packaged ? 'packaged-' : 'source-') + new Date().toISOString().replace(/[:.]/g, '-')
);
const creditCount = Object.values(require('../src/assets/credits.json')).flat().length;
let fixtureRun;
(async () => {
  fixtureRun = path.dirname(await require('./fixture-profile.cjs').latestMediaProfile(root));
  await fs.mkdir(run, { recursive: true });
  await fs.cp(path.join(fixtureRun, 'profile'), path.join(run, 'profile'), { recursive: true });
  const env = { ...process.env, ACG_DATA_DIR: path.join(run, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: packaged
      ? path.join(
          require('./distribution-paths.cjs').runtimeDirectory(),
          `${metadata.build.productName}.exe`
        )
      : require('electron'),
    args: packaged ? [] : ['.'],
    cwd: root,
    env
  });
  const report = { packaged, focused, run, checks: [], errors: [] };
  let clipboardBefore;
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname);
    clipboardBefore = await app.evaluate(({ clipboard }) => ({
      image: clipboard.readImage().toPNG().toString('base64'),
      text: clipboard.readText()
    }));
    await app.evaluate(
      ({ shell, net, BrowserWindow }, versions) => {
        global.__releaseLinks = [];
        shell.openExternal = async (url) => {
          global.__releaseLinks.push(url);
        };
        global.__releaseFetches = 0;
        global.__releaseUpdateMode = 'available';
        const originalFetch = net.fetch.bind(net);
        net.fetch = async (url, options) => {
          if (url !== 'https://api.github.com/repos/fixture-owner/fixture-repo/releases/latest')
            return originalFetch(url, options);
          global.__releaseFetches++;
          const mode = global.__releaseUpdateMode;
          return {
            status: mode === 'rate' ? 429 : 200,
            ok: mode !== 'rate',
            json: async () => ({
              tag_name: `v${mode === 'current' ? versions.current : versions.latest}`,
              html_url: `https://github.com/fixture-owner/fixture-repo/releases/tag/v${versions.latest}`
            })
          };
        };
        const w = BrowserWindow.getAllWindows()[0];
        if (w.isMaximized()) w.unmaximize();
        w.setContentSize(1920, 1032);
        w.webContents.setBackgroundThrottling(false);
      },
      { current: currentVersion, latest: latestVersion }
    );
    await page.evaluate(() => changeTheme('light'));
    report.environment = await app.evaluate(async ({ app, screen }) => ({
      gpu: await app.getGPUInfo('complete'),
      features: app.getGPUFeatureStatus(),
      displays: screen.getAllDisplays().map((d) => ({ size: d.size, scaleFactor: d.scaleFactor }))
    }));
    const folder = await page.evaluate(() => S.roots[0]);
    assert.ok(folder?.id);
    await page.evaluate(
      (id) => navigate({ parent: id, view: 'library', filter: 'images' }),
      folder.id
    );
    const check = async (name, fn) => {
      if (focused && !/metadata settings|renderer completes/.test(name)) return;
      try {
        const details = await fn();
        report.checks.push({ name, status: 'passed', details });
        console.log('PASS ' + name);
      } catch (error) {
        report.checks.push({ name, status: 'failed', error: error.stack });
        console.error('FAIL ' + name + ' ' + error.message);
        await page.screenshot({ path: path.join(run, 'failure-' + report.checks.length + '.png') });
        await page
          .evaluate(() => {
            if ($('#modal').open) closeModal();
          })
          .catch(() => {});
      }
    };
    const expectLinks = async (count) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        if (await app.evaluate((_, count) => global.__releaseLinks.length >= count, count)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.fail(`Expected ${count} captured external links.`);
    };
    const shot = (name) => page.screenshot({ path: path.join(run, name + '.png') });
    const applicationAction = async (selector) => {
      while (await page.locator('dialog[data-info-child][open]').count())
        await page.locator('dialog[data-info-child][open] .info-dialog-close').last().click();
      if (await page.locator('#modal').evaluate((modal) => modal.open))
        await page.locator('#modal-close').click();
      await page.locator('#settings-button').click();
      await page.locator("[data-tab='application']").click();
      await page.waitForFunction(
        (version) => document.querySelector('#settings-app-version')?.textContent.includes(version),
        currentVersion
      );
      assert.equal(await page.locator('[data-app-menu]').count(), 0);
      for (const id of ['#settings-about', '#settings-updates', '#settings-quit']) {
        assert.equal(await page.locator(id).isVisible(), true);
        assert.equal(await page.locator(id).isEnabled(), true);
      }
      await page.locator(selector).click();
    };
    await check(
      'application settings exposes About updates and quit without top menus',
      async () => {
        await applicationAction('#settings-about');
        await page.waitForFunction(
          (version) =>
            document.querySelector('#modal').open &&
            document.querySelector('.about-version')?.textContent.includes(version),
          currentVersion
        );
        assert.match(await page.locator('.album-about').textContent(), /ACG-album/);
        return {
          brand: 'ACG-album',
          currentVersion,
          actions: ['about', 'updates', 'quit'],
          topMenus: 0
        };
      }
    );
    await check('About introduction sponsor ordering and local author identity', async () => {
      const result = await page.evaluate(() => ({
        sponsorAfterIntro:
          $('.about-description').nextElementSibling.classList.contains('about-sponsor'),
        sponsorOpen: $('.about-sponsor').open,
        creditsOpen: $('.about-credits').open,
        authors: $$('.about-author-card').map((a) => ({
          text: a.textContent,
          src: a.querySelector('img').getAttribute('src'),
          loaded: a.querySelector('img').naturalWidth
        })),
        copyright: $('.about-copyright').textContent
      }));
      assert.equal(result.sponsorAfterIntro, true);
      assert.equal(result.sponsorOpen, false);
      assert.equal(result.creditsOpen, false);
      assert.equal(result.authors.length, 2);
      assert.ok(result.authors.every((a) => a.loaded === 128 && !/^https?:/.test(a.src)));
      assert.match(result.copyright, /2026.*GXinnnnnn.*MIT/);
      await shot('about-desktop-light');
      return result;
    });
    await check(
      'both payment cards keep a white background and proportional intact image',
      async () => {
        await page.locator('.about-sponsor > summary').click();
        await page.waitForFunction(() =>
          $$('.about-qr-card img').every((i) => i.complete && i.naturalWidth > 0)
        );
        const result = await page.locator('.about-qr-card').evaluateAll((cards) =>
          cards.map((card) => {
            const img = card.querySelector('img'),
              r = img.getBoundingClientRect();
            return {
              white: getComputedStyle(card).backgroundColor,
              natural: [img.naturalWidth, img.naturalHeight],
              display: [r.width, r.height]
            };
          })
        );
        assert.deepEqual(
          result.map((r) => r.natural),
          [
            [808, 808],
            [594, 594]
          ]
        );
        for (const r of result) {
          assert.equal(r.white, 'rgb(255, 255, 255)');
          assert.ok(Math.abs(r.display[0] - r.display[1]) < 0.5);
        }
        await page.locator('.about-qr-grid').scrollIntoViewIfNeeded();
        await shot('sponsor-desktop-light');
        return result;
      }
    );
    await check('all OSS entries use the same expandable details control', async () => {
      await page.locator('.about-sponsor > summary').click();
      await page.locator('.about-credits > summary').click();
      assert.equal(await page.locator('.about-credit').count(), creditCount);
      assert.equal(await page.locator('.about-credit[open]').count(), 0);
      await page.locator('.about-credit > summary').first().focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.about-credit[open]').count(), 1);
      await page.locator('.about-credit-detail a').first().click();
      assert.equal(
        (await app.evaluate(() => global.__releaseLinks)).at(-1),
        'https://github.com/electron/electron'
      );
      await shot('credits-expanded');
      await page.locator('.about-credits > summary').click();
      return { entries: creditCount, nativeKeyboardToggle: true };
    });
    await check(
      'author cards dispatch their real GitHub and Bilibili browser addresses',
      async () => {
        for (const card of await page.locator('.about-author-card').all()) await card.click();
        const links = await app.evaluate(() => global.__releaseLinks.slice(-2));
        assert.deepEqual(links, [
          'https://github.com/GXinnnnnn',
          'https://space.bilibili.com/396517775'
        ]);
        return links;
      }
    );
    await check('About stays in bounds in dark theme at 980 by 680', async () => {
      await page.evaluate(() => changeTheme('dark'));
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].setContentSize(980, 680)
      );
      await page.waitForFunction(() => innerWidth === 980);
      await page.locator('.about-sponsor > summary').click();
      await page.locator('.about-qr-grid').scrollIntoViewIfNeeded();
      const r = await page.locator('.album-info-dialog').boundingBox();
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 981 && r.y + r.height <= 681);
      await shot('sponsor-narrow-dark');
      await page.locator('.about-sponsor > summary').click();
      return r;
    });
    await check('bottom-left Bangumi action binds the actual current album', async () => {
      const binding = page.locator('[data-about-bind]');
      assert.equal(await binding.count(), 1);
      await binding.click();
      await page.waitForSelector('#subject-url');
      assert.match(await page.locator('#modal').textContent(), /关联|绑定/);
      await page.locator('#modal-close').click();
      return { folderId: folder.id };
    });
    await check(
      'expanded sidebar copyright opens About and compact tools stay near the header',
      async () => {
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1920, 1032)
        );
        await page.evaluate(async () => {
          await changeTheme('light');
          await saveSetting('sidebarMode', 'expanded');
          applyNavigationSettings();
        });
        await page.waitForFunction(() => $('#sidebar-shell').classList.contains('is-open'));
        const geometry = await page.evaluate(() => ({
          sidebar: $('#sidebar-shell').getBoundingClientRect().width,
          topbar: $('.topbar').getBoundingClientRect().toJSON(),
          left: $('.toolbar-left').getBoundingClientRect().toJSON(),
          right: $('.toolbar-right').getBoundingClientRect().toJSON(),
          filter: $('.filter-tabs button').getBoundingClientRect().height,
          copyright: $('#sidebar-copyright').textContent,
          inert: $('#sidebar-copyright').inert,
          overflow: document.documentElement.scrollWidth > innerWidth
        }));
        assert.equal(geometry.sidebar, 240);
        assert.equal(geometry.filter, 26);
        assert.ok(geometry.left.top < 113 && geometry.left.top >= 98);
        assert.ok(Math.abs(geometry.left.top - geometry.right.top) < 1);
        assert.ok(geometry.left.top - geometry.topbar.bottom <= 31);
        assert.equal(geometry.inert, false);
        assert.equal(geometry.overflow, false);
        assert.match(geometry.copyright, /2026.*GXinnnnnn/s);
        await shot('expanded-sidebar-compact-toolbar');
        await page.locator('#sidebar-about').click();
        await page.waitForSelector('.album-about');
        await page.locator('#modal-close').click();
        await page.evaluate(() => {
          $('#viewport').scrollTop = 1000;
        });
        await page.waitForFunction(() => $('.toolbar-left').getBoundingClientRect().top < 113);
        return geometry;
      }
    );
    await check('Ctrl+C preserves selected search text without an edit menu', async () => {
      await page.locator('#search').fill('abcdef');
      await page.locator('#search').evaluate((input) => {
        input.focus();
        input.setSelectionRange(1, 4);
      });
      await page.keyboard.press('Control+C');
      let copied = '';
      for (let i = 0; i < 10; i++) {
        copied = await app.evaluate(({ clipboard }) => clipboard.readText());
        if (copied === 'bcd') break;
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(copied, 'bcd');
      assert.equal(await page.locator('[data-app-menu]').count(), 0);
      await page.locator('#search').fill('');
      await page.evaluate(() => {
        S.search = '';
      });
      return { copied, shortcut: 'Control+C' };
    });
    await check(
      'metadata settings retains encrypted Token controls and the external Token link',
      async () => {
        await page.locator('#settings-button').click();
        await page.locator("[data-tab='metadata']").click();
        await page.locator('#token-input').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#token-input').getAttribute('type'), 'password');
        const before = await page.evaluate(() => api('tokenStatus'));
        assert.equal(before.saved, false, 'The synthetic fixture must not contain a real Token.');
        const linksBefore = await app.evaluate(() => global.__releaseLinks.length);
        await page.locator('#token-link').click();
        await expectLinks(linksBefore + 1);
        const links = await app.evaluate(() => global.__releaseLinks);
        assert.deepEqual(links.slice(linksBefore), ['https://next.bgm.tv/demo/access-token']);
        if (before.encrypted) {
          const fixtureToken = 'synthetic-controls-token-not-a-real-credential';
          await page.locator('#token-input').fill(fixtureToken);
          await page.locator('#token-save').click();
          await page.waitForFunction(() =>
            document.querySelector('#settings-content h3')?.textContent.includes('已加密保存')
          );
          assert.equal(await page.locator('#token-input').inputValue(), '');
          const encrypted = await fs.readFile(path.join(run, 'profile/bangumi-token.enc'));
          assert.equal(encrypted.includes(Buffer.from(fixtureToken)), false);
          await page.locator('#token-save').click();
          await page.waitForFunction(() =>
            document.querySelector('#settings-content h3')?.textContent.includes('未设置')
          );
          assert.equal((await page.evaluate(() => api('tokenStatus'))).saved, false);
        } else {
          await assert.rejects(
            () => page.evaluate(() => api('saveToken', { value: 'synthetic-controls-token' })),
            /加密服务不可用/
          );
          assert.equal((await page.evaluate(() => api('tokenStatus'))).saved, false);
        }
        await shot('metadata-token-settings');
        await page.locator('#modal-close').click();
        return {
          encryptionAvailable: before.encrypted,
          passwordInput: true,
          tokenLink: links.at(-1),
          plaintextNotStored: true
        };
      }
    );
    await check(
      'manual updates are unconfigured by default and validate before networking',
      async () => {
        await applicationAction('#settings-updates');
        await page.waitForFunction(() => !$('#album-update-repository').disabled);
        assert.equal(await page.locator('#album-update-repository').inputValue(), '');
        await page.locator('[data-update-check]').click();
        await page.waitForSelector('[data-update-status="unconfigured"]');
        assert.equal(await app.evaluate(() => global.__releaseFetches), 0);
        await page.locator('#album-update-repository').fill('https://example.invalid/owner/repo');
        await page.locator('[data-update-check]').click();
        await page.waitForFunction(
          () => $('#album-update-repository').getAttribute('aria-invalid') === 'true'
        );
        assert.equal(await app.evaluate(() => global.__releaseFetches), 0);
        return { networkCalls: 0 };
      }
    );
    await check(
      'manual update normalizes repo URL and presents available current and rate-limit states',
      async () => {
        await page
          .locator('#album-update-repository')
          .fill('https://github.com/fixture-owner/fixture-repo');
        await page.locator('[data-update-check]').click();
        await page.waitForSelector('[data-update-status="available"]');
        const availableText = await page.locator('[data-update-status="available"]').textContent();
        assert.ok(availableText.includes(currentVersion));
        assert.ok(availableText.includes(latestVersion));
        assert.equal(
          await page.locator('.about-release-link').getAttribute('data-about-external'),
          `https://github.com/fixture-owner/fixture-repo/releases/tag/v${latestVersion}`
        );
        assert.equal(
          await page.locator('#album-update-repository').inputValue(),
          'fixture-owner/fixture-repo'
        );
        await page.locator('.about-release-link').click();
        assert.match(
          (await app.evaluate(() => global.__releaseLinks)).at(-1),
          /^https:\/\/github.com\/fixture-owner\/fixture-repo\/releases\/tag\//
        );
        await app.evaluate(() => {
          global.__releaseUpdateMode = 'current';
        });
        await page.locator('[data-update-check]').click();
        await page.waitForSelector('[data-update-status="current"]');
        await app.evaluate(() => {
          global.__releaseUpdateMode = 'rate';
        });
        await page.locator('[data-update-check]').click();
        await page.waitForFunction(() => $('#album-update-error').textContent.includes('频率受限'));
        assert.equal(await page.locator('[data-update-check]').isEnabled(), true);
        await shot('update-rate-limit-readable');
        await page.locator('#album-update-repository').fill('');
        await page.locator('[data-update-check]').click();
        await page.waitForSelector('[data-update-status="unconfigured"]');
        return { networkCalls: await app.evaluate(() => global.__releaseFetches) };
      }
    );
    await check('renderer completes without uncaught errors', async () => {
      assert.deepEqual(report.errors, []);
      return { errors: report.errors };
    });
  } catch (error) {
    report.fatal = error.stack;
  } finally {
    if (clipboardBefore)
      await app
        .evaluate(({ clipboard, nativeImage }, value) => {
          if (value.image)
            clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(value.image, 'base64')));
          else clipboard.writeText(value.text);
        }, clipboardBefore)
        .catch(() => {});
    await app.close();
    report.summary = {
      passed: report.checks.filter((c) => c.status === 'passed').length,
      failed: report.checks.filter((c) => c.status === 'failed').length
    };
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ run, summary: report.summary, fatal: report.fatal || null }));
    if (report.summary.failed || report.fatal) process.exitCode = 1;
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
