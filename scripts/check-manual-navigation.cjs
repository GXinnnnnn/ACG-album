'use strict';
// Serial UI contract verification: generated PNG/profile only; search/bind IPC fixtures, real worker indexing.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const metadata = require('../package.json');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const run = path.join(
  root,
  'artifacts/manual-navigation',
  `${packaged ? 'packaged' : 'source'}-${Date.now()}-${crypto.randomUUID()}`
);
const profile = path.join(run, 'profile');
const album = path.join(run, 'generated-images', '宝可梦');
const id = idFor(album);
const report = {
  version: metadata.version,
  packaged,
  run,
  checks: [],
  errors: [],
  screenshots: [],
  scope:
    'Generated fixtures only. Real indexing/settings/modal controllers; deterministic match/bind IPC fixtures. Backend and live tests verify worker behavior separately.'
};
let app, page;
const child = () => page.locator('dialog[data-info-child][open]').last();
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
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file });
  report.screenshots.push(file);
}
async function ready(tab) {
  await page.waitForFunction((tab) => {
    const p = document.querySelector('#settings-panel-' + tab);
    return (
      p &&
      !p.hidden &&
      !p.inert &&
      document.querySelector('#settings-content').getAttribute('aria-busy') === 'false'
    );
  }, tab);
}
async function select(tab) {
  await page.locator('#settings-tab-' + tab).click();
  await ready(tab);
}
async function configure(state) {
  await app.evaluate((_, state) => Object.assign(global.__manualNavigation, state), state);
}
async function binds() {
  return app.evaluate(() => global.__manualNavigation.binds);
}
async function openBinding() {
  await page.evaluate(async (id) => bindModal(await api('get', { id })), id);
  await page.waitForSelector('#candidate-access');
}
async function search() {
  await page.locator('#auto-match').click();
  await page.waitForFunction(() => !document.querySelector('#auto-match').disabled);
}
(async () => {
  await fs.mkdir(album, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  const image = path.join(album, 'fixture.png');
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#b8b3df' } })
    .png()
    .toFile(image);
  const original = await fs.readFile(image),
    originalStat = await fs.stat(image);
  const env = { ...process.env, ACG_DATA_DIR: profile, ACG_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    app = await _electron.launch({
      executablePath: packaged
        ? path.join(
            require('./distribution-paths.cjs').runtimeDirectory(),
            metadata.build.productName + '.exe'
          )
        : require('electron'),
      args: packaged ? [] : ['.'],
      cwd: root,
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(12000);
    page.on('pageerror', (e) => report.errors.push(e.message));
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname !== undefined);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      if (w.isMaximized()) w.unmaximize();
      w.setContentSize(1180, 820);
    });
    await check('isolated runtime and generated album only', async () => {
      const runtime = await app.evaluate(({ app }) => ({
        data: app.getPath('userData'),
        version: app.getVersion(),
        packaged: app.isPackaged
      }));
      assert.equal(runtime.data, path.join(profile, 'chromium-profile'));
      assert.equal(runtime.version, metadata.version);
      assert.equal(runtime.packaged, packaged);
      assert.deepEqual(await page.evaluate(() => S.roots), []);
      await app.evaluate(({ dialog }, album) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [album] });
      }, album);
      await page.evaluate(async () => {
        await saveSetting('autoMatch', false);
        await api('import', { onlineMatch: false, subjectTypes: [2] });
        await loadPage(true);
      });
      assert.equal((await page.evaluate((id) => api('get', { id }), id)).subject_id, null);
    });
    await app.evaluate(({ ipcMain }) => {
      const gate = (global.__manualNavigation = {
        binds: [],
        searches: [],
        tokenPresent: false,
        mode: 'normal',
        hold: false,
        pending: []
      });
      const get = ipcMain._invokeHandlers.get('library:get');
      ipcMain.removeHandler('library:match');
      ipcMain.handle('library:match', async (event, args) => {
        gate.searches.push(args);
        const state = { mode: gate.mode, tokenPresent: gate.tokenPresent };
        if (gate.hold) await new Promise((resolve) => gate.pending.push(resolve));
        if (state.mode === 'error')
          throw new Error('Access Token 无效、已过期或权限不足，请在作品简介设置中更新后重试');
        return {
          node: await get(event, { id: args.id }),
          needs_selection: true,
          searchAccess: { tokenPresent: state.tokenPresent },
          candidates:
            state.mode === 'empty'
              ? []
              : state.mode === 'long'
                ? Array.from({ length: 60 }, (_, i) => ({
                    id: 800000 + i,
                    type: 2,
                    name: 'Pokemon generated long-list fixture ' + (i + 1),
                    name_cn: '宝可梦 长候选列表测试 ' + (i + 1),
                    date: '1997-04-01',
                    match: 0.95
                  }))
                : [
                    {
                      id: 3019,
                      type: 2,
                      name: 'ポケットモンスター',
                      name_cn: '宝可梦',
                      date: '1997-04-01',
                      match: 1
                    },
                    {
                      id: 30589,
                      type: 2,
                      name: 'Pokemon alternative fixture',
                      name_cn: '宝可梦 候选测试',
                      date: '2013-10-17',
                      match: 0.91
                    }
                  ]
        };
      });
      ipcMain.removeHandler('library:bind');
      ipcMain.handle('library:bind', async (event, args) => {
        gate.binds.push(args);
        if (gate.holdBind) await new Promise((resolve) => gate.pending.push(resolve));
        if (gate.bindError) throw new Error('测试保存失败，请重试');
        return get(event, { id: args.id });
      });
    });
    await check(
      'preferences ignore backdrop and Escape, retain drafts, and close only with X',
      async () => {
        await page.locator('#settings-button').click();
        await ready('appearance');
        await select('metadata');
        await page.locator('#token-input').fill('synthetic-unsaved-backdrop-draft');
        await page.evaluate(() => {
          window.__backdropShell = $('#settings-shell');
          $('#settings-panel-metadata').scrollTop = 70;
          window.__backdropScroll = $('#settings-panel-metadata').scrollTop;
        });
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        for (const [x, y] of [
          [2, 2],
          [size.width - 2, 2],
          [2, size.height - 2],
          [size.width - 2, size.height - 2]
        ]) {
          await page.mouse.click(x, y);
          assert.equal(
            await page.evaluate(() => $('#modal').open && $('#settings-shell') === __backdropShell),
            true
          );
        }
        await page.keyboard.press('Escape');
        await ready('metadata');
        assert.equal(
          await page.locator('#token-input').inputValue(),
          'synthetic-unsaved-backdrop-draft'
        );
        assert.equal(
          await page.evaluate(() => $('#settings-panel-metadata').scrollTop === __backdropScroll),
          true
        );
        await shot('preferences-explicit-close');
        await page.locator('#modal-close').click();
        await page.waitForFunction(() => !$('#modal').open && !$('#settings-shell'));
        assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-button');
      }
    );
    await check(
      'About close preserves settings controller, tab, focus, scroll and drafts',
      async () => {
        await page.locator('#profile-button').click();
        await ready('profile');
        await page.locator('#profile-name').fill('unsaved profile draft');
        await select('metadata');
        await page.locator('#token-input').fill('unsaved synthetic token draft');
        await page.locator('#settings-panel-metadata').evaluate((p) => {
          p.scrollTop = 80;
        });
        await page.evaluate(() => {
          window.__navigationScroll = $('#settings-panel-metadata').scrollTop;
        });
        await select('application');
        await page.evaluate(() => {
          window.__navigationParent = { shell: $('#settings-shell'), generation: modalGeneration };
        });
        await page.locator('#settings-about').click();
        await child().locator('.about-version').filter({ hasText: metadata.version }).waitFor();
        assert.equal(await page.locator('#settings-shell').count(), 1);
        await child().locator('.info-dialog-close').click();
        await page.waitForFunction(() => !document.querySelector('[data-info-child]'));
        assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-about');
        assert.equal(
          await page.evaluate(
            () =>
              __navigationParent.shell === $('#settings-shell') &&
              __navigationParent.generation === modalGeneration &&
              $('#modal').open
          ),
          true
        );
        await ready('application');
        await select('metadata');
        assert.equal(
          await page.locator('#token-input').inputValue(),
          'unsaved synthetic token draft'
        );
        assert.equal(
          await page.evaluate(() => $('#settings-panel-metadata').scrollTop === __navigationScroll),
          true
        );
        await select('profile');
        assert.equal(await page.locator('#profile-name').inputValue(), 'unsaved profile draft');
        await select('application');
      }
    );
    await check(
      'Updates nested under About returns through About to original settings',
      async () => {
        await page.locator('#settings-about').click();
        await child().locator('.about-credits > summary').click();
        await page.evaluate(() => {
          window.__navigationAbout = document.querySelector('.album-about');
        });
        await child().locator('[data-about-updates]').click();
        await child().locator('#album-update-repository').waitFor();
        assert.equal(await page.locator('dialog[data-info-child][open]').count(), 2);
        await shot('settings-about-updates');
        await page.keyboard.press('Escape');
        await page.waitForFunction(
          () => document.querySelectorAll('dialog[data-info-child][open]').length === 1
        );
        assert.equal(
          await page.evaluate(
            () =>
              __navigationAbout === document.querySelector('.album-about') &&
              document.querySelector('.about-credits').open
          ),
          true
        );
        assert.equal(
          await page.evaluate(() => document.activeElement.hasAttribute('data-about-updates')),
          true
        );
        await page.keyboard.press('Escape');
        await ready('application');
        await page.waitForFunction(() => !document.querySelector('[data-info-child]'));
      }
    );
    await check('backdrop close returns to settings and direct Updates is a child', async () => {
      await page.locator('#settings-about').click();
      await page.mouse.click(2, 2);
      await page.waitForFunction(() => !document.querySelector('[data-info-child]'));
      await ready('application');
      await page.locator('#settings-updates').click();
      await child().locator('#album-update-repository').waitFor();
      await child().locator('.info-dialog-close').click();
      await page.waitForFunction(() => !document.querySelector('[data-info-child]'));
      await ready('application');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-updates');
      await page.locator('#modal-close').click();
    });
    await check('direct About retains normal standalone close behavior', async () => {
      await page.evaluate(() => window.showAbout());
      assert.equal(await page.locator('[data-info-child]').count(), 0);
      await page.locator('#modal-close').click();
      await page.waitForFunction(() => !document.querySelector('#modal').open);
    });
    await check(
      'right-click manual search shows alternatives even at 100 percent and never saves',
      async () => {
        await page.locator(`[data-id="${id}"]`).first().click({ button: 'right' });
        await page.locator('#context-menu button').filter({ hasText: '关联作品简介' }).click();
        await search();
        assert.equal(await page.locator('.candidate').count(), 2);
        assert.equal(await page.locator('#subject-url').inputValue(), '');
        assert.equal((await binds()).length, 0);
        assert.match(await page.locator('#candidate-status').textContent(), /尚未更改/);
        assert.match(
          await page.locator('#candidate-access').textContent(),
          /当前未使用 Access Token.*API 权限/
        );
        assert.equal((await page.evaluate((id) => api('get', { id }), id)).subject_id, null);
        await shot('manual-candidates-and-access');
      }
    );
    await check('candidate selection then cancel leaves saved association unchanged', async () => {
      await page.locator('.candidate').nth(1).click();
      assert.equal(await page.locator('#subject-url').inputValue(), 'https://bgm.tv/subject/30589');
      assert.equal(await page.locator('.candidate[aria-pressed="true"]').count(), 1);
      assert.equal((await binds()).length, 0);
      await page.locator('#modal-close').click();
      assert.equal((await page.evaluate((id) => api('get', { id }), id)).subject_id, null);
    });
    await check('only Save dispatches the chosen candidate to bind exactly once', async () => {
      await openBinding();
      await search();
      await page.locator('.candidate').nth(1).click();
      await page.locator('#bind-save').click();
      await page.waitForFunction(() => !document.querySelector('#modal').open);
      assert.deepEqual(await binds(), [{ id, url: 'https://bgm.tv/subject/30589' }]);
    });
    await check(
      'pending search blocks Enter save and ignores changed keyword results',
      async () => {
        await openBinding();
        await configure({ hold: true });
        await page.locator('#auto-match').click();
        await page.waitForFunction(() => document.querySelector('#auto-match').disabled);
        await page.locator('#subject-url').fill('3019');
        await page.locator('#subject-url').press('Enter');
        assert.equal((await binds()).length, 1);
        await page.locator('#subject-keyword').fill('changed query');
        await app.evaluate(() => {
          const g = global.__manualNavigation;
          g.hold = false;
          for (const release of g.pending.splice(0)) release();
        });
        await page.waitForFunction(() => !document.querySelector('#auto-match').disabled);
        assert.equal(await page.locator('.candidate').count(), 0);
        assert.equal(await page.locator('#subject-url').inputValue(), '');
        assert.match(await page.locator('#candidate-status').textContent(), /条件已改变/);
      }
    );
    await check(
      'empty candidates explain scope and configured Token does not claim authentication',
      async () => {
        await configure({ mode: 'empty', tokenPresent: true });
        await search();
        assert.equal(await page.locator('.candidate').count(), 0);
        assert.match(
          await page.locator('#candidate-access').textContent(),
          /已配置 Access Token；是否生效及可访问范围以 Bangumi 返回为准/
        );
        assert.match(await page.locator('#candidate-status').textContent(), /没有找到候选/);
        assert.doesNotMatch(
          await page.locator('#candidate-access').textContent(),
          /认证成功|全部可见/
        );
        await shot('restricted-scope-empty-candidates');
      }
    );
    await check(
      'authentication errors stay actionable and leave modal and association intact',
      async () => {
        await configure({ mode: 'error' });
        await search();
        assert.match(
          await page.locator('#bind-error').textContent(),
          /Access Token 无效、已过期或权限不足/
        );
        assert.equal((await binds()).length, 1);
        assert.equal((await page.evaluate((id) => api('get', { id }), id)).subject_id, null);
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'pending save freezes candidate choice and failed save restores every control',
      async () => {
        await configure({ mode: 'normal', holdBind: true, bindError: true });
        await openBinding();
        await search();
        await page.locator('.candidate').first().click();
        await page.locator('#bind-save').click();
        await page.waitForFunction(() => document.querySelector('#subject-url').disabled);
        assert.equal(await page.locator('.candidate:disabled').count(), 2);
        await page
          .locator('.candidate')
          .nth(1)
          .evaluate((el) => el.click());
        assert.equal(
          await page.locator('#subject-url').inputValue(),
          'https://bgm.tv/subject/3019'
        );
        assert.equal(
          await page.locator('.candidate[aria-pressed="true"]').getAttribute('data-subject'),
          '3019'
        );
        await app.evaluate(() => {
          const g = global.__manualNavigation;
          g.holdBind = false;
          for (const release of g.pending.splice(0)) release();
        });
        await page.waitForFunction(() => !document.querySelector('#bind-save').disabled);
        assert.match(await page.locator('#bind-error').textContent(), /测试保存失败/);
        assert.equal(await page.locator('.candidate:disabled').count(), 0);
        assert.equal(
          await page
            .locator('#subject-type:disabled, #subject-keyword:disabled, #subject-url:disabled')
            .count(),
          0
        );
        await page.locator('.candidate').nth(1).click();
        assert.equal(
          await page.locator('#subject-url').inputValue(),
          'https://bgm.tv/subject/30589'
        );
        assert.equal((await binds()).length, 2);
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'long candidate list keeps actions visible at the lower right across themes and sizes',
      async () => {
        await configure({ mode: 'long', holdBind: false, bindError: false });
        for (const [width, height, theme] of [
          [1180, 820, 'light'],
          [1180, 820, 'dark'],
          [420, 560, 'light'],
          [420, 560, 'dark']
        ]) {
          await app.evaluate(
            ({ BrowserWindow }, { width, height }) => {
              const window = BrowserWindow.getAllWindows()[0];
              window.setMinimumSize(360, 320);
              window.setContentSize(width, height);
            },
            { width, height }
          );
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          await openBinding();
          await search();
          assert.equal(await page.locator('.candidate').count(), 60);
          const before = await page.locator('.binding-actions').boundingBox();
          await page.locator('.binding-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
          const after = await page.locator('.binding-actions').boundingBox();
          assert.ok(Math.abs(before.y - after.y) <= 1, 'Scrolling must not move the action bar.');
          const layout = await page.evaluate(() => {
            const modal = $('#modal'),
              scroll = $('.binding-scroll'),
              footer = $('.binding-actions');
            const bounds = footer.getBoundingClientRect();
            return {
              scrollable: scroll.scrollHeight > scroll.clientHeight,
              scrolled: scroll.scrollTop > 0,
              outerScroll: modal.scrollTop,
              horizontalOverflow: modal.scrollWidth > modal.clientWidth,
              contentBottom: scroll.getBoundingClientRect().bottom,
              footerTop: bounds.top,
              footerBottom: bounds.bottom,
              viewport: innerHeight,
              buttonsVisible: ['auto-match', 'bind-save'].every((id) => {
                const el = document.getElementById(id),
                  r = el.getBoundingClientRect();
                return (
                  r.left >= 0 &&
                  r.right <= innerWidth &&
                  r.top >= bounds.top &&
                  r.bottom <= innerHeight
                );
              })
            };
          });
          assert.equal(layout.scrollable && layout.scrolled && layout.buttonsVisible, true);
          assert.equal(layout.outerScroll, 0);
          assert.equal(layout.horizontalOverflow, false);
          assert.ok(layout.contentBottom <= layout.footerTop + 1);
          assert.ok(layout.footerBottom <= layout.viewport);
          await page.locator('.candidate').last().click();
          assert.equal(
            await page.locator('#subject-url').inputValue(),
            'https://bgm.tv/subject/800059'
          );
          assert.equal(
            await page.evaluate(() => document.activeElement.classList.contains('candidate')),
            true
          );
          assert.ok(await page.locator('.binding-scroll').evaluate((el) => el.scrollTop > 0));
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'auto-match');
          await page.keyboard.press('Tab');
          assert.equal(await page.evaluate(() => document.activeElement.id), 'bind-save');
          await shot(`fixed-binding-actions-${width}-${theme}`);
          await page.locator('#modal-close').click();
        }
        await page.evaluate(() => openModal('普通窗口', '<p>布局复用检查</p>'));
        assert.equal(await page.locator('#modal.binding-modal').count(), 0);
        await page.locator('#modal-close').click();
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].setContentSize(1180, 820)
        );
        await openBinding();
        await search();
        await page.locator('.candidate').last().click();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !$('#modal').open);
        assert.deepEqual((await binds()).at(-1), { id, url: 'https://bgm.tv/subject/800059' });
      }
    );
    await check(
      'malformed credential is rejected before storage without plaintext in errors or log',
      async () => {
        const outcome = await page.evaluate(async () => {
          try {
            await api('saveToken', {
              value: 'synthetic' + String.fromCharCode(10) + 'invalid-header'
            });
            return { accepted: true };
          } catch (error) {
            return { message: error.message };
          }
        });
        assert.equal(outcome.accepted, undefined);
        assert.match(outcome.message, /格式无效/);
        assert.ok(!outcome.message.includes('synthetic'));
        assert.equal((await page.evaluate(() => api('tokenStatus'))).saved, false);
        const log = await fs.readFile(path.join(profile, 'app.log'), 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        assert.ok(!log.includes('synthetic'));
      }
    );
    await check(
      'generated original bytes and timestamps and renderer health unchanged',
      async () => {
        assert.deepEqual(await fs.readFile(image), original);
        assert.equal((await fs.stat(image)).mtimeMs, originalStat.mtimeMs);
        assert.deepEqual(report.errors, []);
        assert.equal(await page.locator('[data-info-child]').count(), 0);
      }
    );
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
    if (page && !page.isClosed()) await shot('failure').catch(() => {});
  } finally {
    if (app) await app.close();
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
