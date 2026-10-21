'use strict';
// Source-only, serial Electron verification. Generates every profile and collection in this run.
// External directory-picker/open-folder effects are stubbed; normal IPC uses the real backend.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
// Some workspaces archive artifacts through a junction. Use its physical path so the
// generated profile obeys the application's deliberate no-links cache policy.
const artifactAlias = path.join(root, 'artifacts/cache-settings');
require('node:fs').mkdirSync(artifactAlias, { recursive: true });
const artifactRoot = require('node:fs').realpathSync(artifactAlias);
const run = path.join(
  artifactRoot,
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')
);
const profile = path.join(run, 'generated-profile');
const collection = path.join(run, 'generated-collection');
const selected = path.join(run, 'generated-cache-parent');
const custom = path.join(selected, 'ACG-album-cache');
const report = {
  run,
  profile,
  collection,
  checks: [],
  screenshots: [],
  errors: [],
  notes: [
    'Only chooser/open-folder effects are stubbed in normal flows.',
    'Held/failing IPC and cleanup-warning injection are explicitly named in their checks.'
  ]
};
let app,
  page,
  stage = 'setup',
  albumId,
  thumbnailURL,
  snapshot;
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
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
    return true;
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: error.stack });
    console.error('FAIL ' + name + ': ' + error.message);
    if (page && !page.isClosed()) {
      await screenshot('failure-' + report.checks.length).catch(() => {});
      await page
        .evaluate(() => document.querySelector('.cache-confirm-dialog')?.close())
        .catch(() => {});
    }
    if (app)
      await app
        .evaluate(() => {
          const gate = global.__cacheSettingsCheck;
          if (gate) {
            gate.states = {};
            gate.choices = [];
            gate.pending.splice(0).forEach((item) => item.resolve({ fail: true }));
          }
        })
        .catch(() => {});
    return false;
  }
}
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function size(width, height = 850) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setMinimumSize(320, 280);
      win.setContentSize(width, height);
      win.webContents.setBackgroundThrottling(false);
    },
    { width, height }
  );
  await page.waitForFunction(
    ({ width, height }) => innerWidth === width && innerHeight === height,
    { width, height }
  );
}
async function launch() {
  assert.ok(profile.startsWith(artifactRoot + path.sep));
  const env = { ...process.env, ACG_DATA_DIR: profile, ACG_TEST: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: require('electron'),
    args: ['.'],
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
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await size(1180, 900);
  const runtime = await app.evaluate(({ app }) => ({
    userData: app.getPath('userData'),
    packaged: app.isPackaged
  }));
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  assert.equal(runtime.packaged, false);
  await app.evaluate(
    ({ ipcMain, dialog, shell }, { base, separator }) => {
      const gate = (global.__cacheSettingsCheck = {
        base,
        states: {},
        pending: [],
        calls: {},
        choices: [],
        opened: [],
        chooserCalls: []
      });
      dialog.showOpenDialog = async (_window, options) => {
        gate.chooserCalls.push(options);
        if (!gate.choices.length) throw new Error('No isolated chooser response queued');
        const response = gate.choices.shift();
        if (response.filePaths?.some((file) => !file.startsWith(base + separator)))
          throw new Error('Chooser escaped isolated artifact directory');
        return response;
      };
      shell.openPath = async (file) => {
        gate.opened.push(file);
        return '';
      };
      for (const method of [
        'cacheInfo',
        'openCache',
        'changeCacheDirectory',
        'resetCacheDirectory',
        'cleanCache'
      ]) {
        const channel = 'library:' + method,
          original = ipcMain._invokeHandlers.get(channel);
        if (!original) throw new Error('Missing IPC handler ' + channel);
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (...args) => {
          gate.calls[method] = (gate.calls[method] || 0) + 1;
          const state = { ...gate.states[method] };
          async function wait() {
            if (!state.hold) return {};
            return new Promise((resolve) => gate.pending.push({ method, resolve }));
          }
          let control = {};
          if (state.phase !== 'after') control = await wait();
          if (state.fail || control.fail)
            throw new Error(
              control.message || state.message || 'Isolated cache-settings injected failure'
            );
          let result = await original(...args);
          if (state.phase === 'after') control = await wait();
          if (control.fail)
            throw new Error(control.message || 'Isolated cache-settings injected failure');
          if (state.warning) result = { ...result, warning: state.warning };
          return result;
        });
      }
    },
    { base: run, separator: path.sep }
  );
}
async function closeApp() {
  if (app) await app.close();
  app = null;
  page = null;
}
async function configure(method, state) {
  await app.evaluate(
    (_, { method, state }) => {
      global.__cacheSettingsCheck.states[method] = state;
    },
    { method, state }
  );
}
async function choice(directory) {
  await app.evaluate((_, directory) => {
    global.__cacheSettingsCheck.choices.push(
      directory ? { canceled: false, filePaths: [directory] } : { canceled: true, filePaths: [] }
    );
  }, directory || null);
}
async function count(method) {
  return app.evaluate((_, method) => global.__cacheSettingsCheck.calls[method] || 0, method);
}
async function held(method) {
  for (let i = 0; i < 120; i++) {
    if (
      await app.evaluate(
        (_, method) => global.__cacheSettingsCheck.pending.some((item) => item.method === method),
        method
      )
    )
      return;
    await page.evaluate(() => new Promise(requestAnimationFrame));
  }
  throw new Error('IPC did not enter isolated gate: ' + method);
}
async function release(method, fail = false, message = '') {
  await app.evaluate(
    (_, { method, fail, message }) => {
      const gate = global.__cacheSettingsCheck;
      gate.states[method] = {};
      const pending = gate.pending.filter((item) => item.method === method);
      gate.pending = gate.pending.filter((item) => item.method !== method);
      pending.forEach((item) => item.resolve({ fail, message }));
    },
    { method, fail, message }
  );
}
async function ready(tab) {
  await page.waitForFunction((tab) => {
    const panel = document.querySelector('#settings-panel-' + tab);
    return (
      document.querySelector('#modal').open &&
      panel &&
      !panel.hidden &&
      !panel.inert &&
      document.querySelector('#settings-content').getAttribute('aria-busy') === 'false'
    );
  }, tab);
}
async function select(tab) {
  await page.locator('#settings-tab-' + tab).click();
  await ready(tab);
}
async function open(tab = 'cache') {
  if (await page.locator('#modal').evaluate((modal) => modal.open)) await close();
  await page.locator('#settings-button').click();
  await ready('appearance');
  await select(tab);
}
async function close() {
  await page.locator('#modal-close').click();
  await page.waitForFunction(
    () => !document.querySelector('#modal').open && !document.querySelector('#settings-shell')
  );
}
async function idle() {
  await page.waitForFunction(
    () => document.querySelector('#settings-panel-cache')?.getAttribute('aria-busy') === 'false'
  );
}
async function shownPath(expected) {
  await page.waitForFunction(
    (expected) => document.querySelector('#cache-current-path')?.textContent === expected,
    expected
  );
  assert.equal((await rpc('cacheInfo')).path, expected);
}
async function remember() {
  await select('profile');
  await page.locator('#profile-name').fill('Cache audit draft');
  await select('cache');
  await page.evaluate(() => {
    window.__cacheNodes = {
      shell: document.querySelector('#settings-shell'),
      content: document.querySelector('#modal-content'),
      generation: modalGeneration
    };
  });
}
async function persistent() {
  assert.equal(
    await page.evaluate(
      () =>
        window.__cacheNodes.shell === document.querySelector('#settings-shell') &&
        window.__cacheNodes.content === document.querySelector('#modal-content') &&
        window.__cacheNodes.generation === modalGeneration &&
        document.querySelector('#profile-name').value === 'Cache audit draft'
    ),
    true
  );
}
async function waitChild() {
  await page.waitForFunction(() => document.querySelector('.cache-confirm-dialog')?.open);
}
async function childCancel(button) {
  const before = await count('cleanCache');
  await page.locator(button).click();
  await waitChild();
  assert.equal(
    await page.evaluate(() => document.activeElement?.hasAttribute('data-cache-cancel')),
    true
  );
  await screenshot('confirmation-' + button.slice(1));
  await page.locator('[data-cache-cancel]').click();
  await page.waitForFunction(() => !document.querySelector('.cache-confirm-dialog'));
  assert.equal(await count('cleanCache'), before);
  await persistent();
  assert.equal(
    await page.evaluate(
      (button) => document.activeElement === document.querySelector(button),
      button
    ),
    true,
    'Cancel must return focus to its originating control'
  );
}
async function fingerprints(directory) {
  const entries = {};
  for (const kind of ['thumbnails', 'covers', 'metadata']) {
    for (const name of await fs.readdir(path.join(directory, kind))) {
      const file = path.join(directory, kind, name),
        stat = await fs.stat(file);
      if (stat.isFile()) entries[path.join(kind, name)] = hash(await fs.readFile(file));
    }
  }
  return entries;
}
async function verifyFiles(directory, entries) {
  for (const [relative, value] of Object.entries(entries))
    assert.equal(
      hash(await fs.readFile(path.join(directory, relative))),
      value,
      relative + ' bytes must be reused'
    );
}
async function warmThumb() {
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
  }, thumbnailURL);
  assert.equal(result.ok, true);
  assert.ok(result.bytes > 0);
}
(async () => {
  await fs.mkdir(profile, { recursive: true });
  await fs.mkdir(collection, { recursive: true });
  await fs.mkdir(selected, { recursive: true });
  const image = path.join(collection, 'isolated-original.png');
  await sharp({ create: { width: 420, height: 620, channels: 3, background: '#b24b77' } })
    .png()
    .toFile(image);
  const originalHash = hash(await fs.readFile(image));
  try {
    await launch();
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('watchChanges', false);
    });
    await choice(collection);
    await rpc('import', { onlineMatch: false, directoryKind: 'photo' });
    albumId = (await rpc('init')).roots[0].id;
    thumbnailURL = 'acg-image://thumb/' + albumId + '?size=512';
    await warmThumb();
    await sharp({ create: { width: 30, height: 40, channels: 3, background: '#3e5e9a' } })
      .webp()
      .toFile(path.join(profile, 'covers', 'isolated-fixture.webp'));
    await fs.writeFile(
      path.join(profile, 'metadata', 'isolated-fixture.json'),
      JSON.stringify({ generated: true })
    );
    snapshot = await fingerprints(profile);
    assert.ok(Object.keys(snapshot).some((file) => file.startsWith('thumbnails')));
    await open();
    await check('real cacheInfo path and cards reflect generated cached bytes', async () => {
      await shownPath(profile);
      const info = await rpc('cacheInfo');
      for (const kind of ['thumbnails', 'covers', 'metadata']) {
        const card = page.locator('[data-cache-kind="' + kind + '"]');
        assert.equal(
          await card.locator('span').textContent(),
          info[kind].count.toLocaleString('en-US') + ' 个文件'
        );
        assert.equal(
          await card.locator('strong').textContent(),
          await page.evaluate((value) => bytes(value), info[kind].bytes)
        );
      }
      await screenshot('default-cache');
      return info;
    });
    await check('openCache opens the actual profile cache root through real IPC', async () => {
      await page.locator('#open-cache').click();
      await app.evaluate(async () => {
        for (let i = 0; i < 100 && !global.__cacheSettingsCheck.opened.length; i++)
          await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const opened = await app.evaluate(() => global.__cacheSettingsCheck.opened);
      assert.equal(opened.at(-1), profile);
    });
    await check(
      'chooser cancellation preserves cache path, files and usable controls',
      async () => {
        await choice(null);
        await page.locator('#change-cache').click();
        await page.waitForFunction(() =>
          document.querySelector('#cache-operation-status').textContent.includes('已取消')
        );
        await idle();
        await shownPath(profile);
        await verifyFiles(profile, snapshot);
      }
    );
    await check(
      'migration uses real backend, gates double clicks and completes during another tab',
      async () => {
        await choice(selected);
        await configure('changeCacheDirectory', { hold: true });
        const before = await count('changeCacheDirectory');
        await page.locator('#change-cache').evaluate((button) => {
          button.click();
          button.click();
        });
        await held('changeCacheDirectory');
        assert.equal(await count('changeCacheDirectory'), before + 1);
        assert.equal(await page.locator('#settings-panel-cache button:not(:disabled)').count(), 0);
        await select('appearance');
        await release('changeCacheDirectory');
        await page.waitForFunction(
          () =>
            document.querySelector('#settings-panel-cache').getAttribute('aria-busy') === 'false'
        );
        await ready('appearance');
        assert.equal(await page.locator('#modal-title').textContent(), '偏好设置');
        await select('cache');
        await shownPath(custom);
        await verifyFiles(custom, snapshot);
        assert.ok((await fs.stat(path.join(profile, 'library.sqlite'))).size > 0);
        assert.equal(await fs.stat(path.join(custom, 'library.sqlite')).catch(() => null), null);
        const info = await rpc('cacheInfo');
        assert.equal(info.isDefault, false);
        await screenshot('migrated-cache');
      }
    );
    await check(
      'custom cache location and cached thumbnail bytes survive a real Electron restart',
      async () => {
        await closeApp();
        await launch();
        await open();
        await shownPath(custom);
        await verifyFiles(custom, snapshot);
        const before = await fingerprints(custom);
        await warmThumb();
        const after = await fingerprints(custom);
        for (const [file, value] of Object.entries(before)) assert.equal(after[file], value);
        assert.equal(Object.keys(after).length, Object.keys(before).length);
      }
    );
    await remember();
    await check(
      'restore-default confirmation cancels without replacing settings or losing drafts/focus',
      async () => {
        const before = await count('resetCacheDirectory');
        await childCancel('#reset-cache-directory');
        assert.equal(await count('resetCacheDirectory'), before);
        await shownPath(custom);
      }
    );
    await check(
      'restore-default confirmation executes real migration and preserves live settings',
      async () => {
        await configure('resetCacheDirectory', { hold: true });
        await page.locator('#reset-cache-directory').click();
        await waitChild();
        await page.locator('[data-cache-confirm]').click();
        await held('resetCacheDirectory');
        await persistent();
        await release('resetCacheDirectory');
        await idle();
        await shownPath(profile);
        await persistent();
        await verifyFiles(profile, snapshot);
      }
    );
    await check(
      'clear-cache child cancellation leaves all cached bytes and live drafts intact',
      async () => {
        await childCancel('#cache-reset');
        await verifyFiles(profile, snapshot);
      }
    );
    await check(
      'clear-cache confirmation clears real cache and keeps settings DOM/generation/draft',
      async () => {
        const before = await count('cleanCache');
        await configure('cleanCache', { hold: true });
        await page.locator('#cache-reset').click();
        await waitChild();
        await page.locator('[data-cache-confirm]').click();
        await held('cleanCache');
        assert.equal(await count('cleanCache'), before + 1);
        await persistent();
        await release('cleanCache');
        await idle();
        await persistent();
        const info = await rpc('cacheInfo');
        assert.equal(info.covers.count, 0);
        assert.equal(info.metadata.count, 0);
        assert.ok((await page.locator('#cache-operation-status').textContent()).includes('已清理'));
        assert.equal(hash(await fs.readFile(image)), originalHash);
        await warmThumb();
        assert.ok((await rpc('cacheInfo')).thumbnails.count > 0);
        await screenshot('cleared-and-regenerated');
      }
    );
    await check(
      'completed destructive action restores keyboard focus to its initiating control',
      async () => {
        assert.equal(
          await page.evaluate(
            () => document.activeElement === document.querySelector('#cache-reset')
          ),
          true,
          'Execution must return focus after the initiating control is re-enabled'
        );
      }
    );
    await check('injected IPC failure shows actionable feedback and unlocks controls', async () => {
      await configure('cleanCache', { fail: true });
      await page.locator('#cache-unused').click();
      await page.waitForFunction(() =>
        document.querySelector('#cache-operation-status').textContent.includes('injected failure')
      );
      await idle();
      assert.equal(await page.locator('#cache-unused').isEnabled(), true);
      await configure('cleanCache', {});
    });
    await check(
      'successful migration displays an explicitly injected cleanup warning',
      async () => {
        await choice(selected);
        await configure('changeCacheDirectory', {
          warning: '缓存已迁移，旧缓存未完全移除：isolated warning fixture'
        });
        const statsBefore = await count('cacheInfo');
        await page.locator('#change-cache').click();
        await idle();
        assert.equal(
          await count('cacheInfo'),
          statsBefore,
          'Migration must render its returned statistics without a second renderer stats request'
        );
        await shownPath(custom);
        assert.ok(
          (await page.locator('#cache-operation-status').textContent()).includes(
            'isolated warning fixture'
          )
        );
        await configure('changeCacheDirectory', {});
        await screenshot('migration-cleanup-warning');
      }
    );
    await check('late successful cleanup cannot replace a newly opened modal', async () => {
      await configure('cleanCache', { hold: true });
      await page.locator('#cache-unused').click();
      await held('cleanCache');
      await close();
      await page.evaluate(() =>
        openModal('Isolated newer modal', '<p id="newer-cache-audit">Keep newer content</p>')
      );
      await release('cleanCache');
      await page.waitForFunction(() => typeof S !== 'undefined');
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
      assert.equal(await page.locator('#modal-title').textContent(), 'Isolated newer modal');
      assert.equal(await page.locator('#newer-cache-audit').textContent(), 'Keep newer content');
      assert.equal(await page.locator('#settings-shell').count(), 0);
    });
    await open();
    await check(
      'late rejected cleanup cannot show an obsolete error in a newer modal',
      async () => {
        await configure('cleanCache', { hold: true });
        await page.locator('#cache-unused').click();
        await held('cleanCache');
        await close();
        await page.evaluate(() =>
          openModal(
            'Newer modal after cache request',
            '<p id="stale-cache-audit">Keep newer error state</p>'
          )
        );
        const beforeToast = await page.locator('#toast-region').textContent();
        const marker = 'Late stale cache rejection marker';
        assert.equal(beforeToast.includes(marker), false);
        await release('cleanCache', true, marker);
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
        assert.equal(
          await page.locator('#modal-title').textContent(),
          'Newer modal after cache request'
        );
        assert.equal(
          (await page.locator('#modal').textContent()).includes(marker),
          false,
          'Obsolete error must not be toasted into a newer modal'
        );
        const afterToast = await page.locator('#toast-region').textContent();
        assert.ok(
          afterToast === beforeToast || afterToast === '',
          'Late rejection must not replace an existing toast'
        );
        await screenshot('stale-rejection-keeps-newer-modal');
        return { beforeToast, afterToast, rejectedMarkerAbsent: true };
      }
    );
    await check(
      'late initial cacheInfo keeps the selected tab and cannot repaint a newer modal',
      async () => {
        await open('appearance');
        await configure('cacheInfo', { hold: true, phase: 'after' });
        await page.locator('#settings-tab-cache').click();
        await held('cacheInfo');
        await select('appearance');
        await release('cacheInfo');
        await ready('appearance');
        await page.waitForFunction(() => !!document.querySelector('#cache-current-path'));
        assert.equal(
          await page.locator('#settings-tab-appearance').getAttribute('aria-selected'),
          'true'
        );
        await close();
        await page.locator('#settings-button').click();
        await ready('appearance');
        await configure('cacheInfo', { hold: true, phase: 'after' });
        await page.locator('#settings-tab-cache').click();
        await held('cacheInfo');
        await close();
        await page.evaluate(() =>
          openModal(
            'Newer modal after initial stats',
            '<p id="stale-initial-cache">Newer initial state</p>'
          )
        );
        await release('cacheInfo');
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)));
        assert.equal(
          await page.locator('#modal-title').textContent(),
          'Newer modal after initial stats'
        );
        assert.equal(
          await page.locator('#stale-initial-cache').textContent(),
          'Newer initial state'
        );
        assert.equal(await page.locator('#cache-current-path').count(), 0);
      }
    );
    await open();
    await page.evaluate(async () => {
      await changeTheme('dark');
    });
    for (const width of [980, 320]) {
      await check(
        'dark cache panel and child dialog have no horizontal overflow at ' + width + 'px',
        async () => {
          await size(width);
          await select('cache');
          const geometry = await page.locator('#settings-panel-cache').evaluate((panel) => {
            const modal = document.querySelector('#modal'),
              r = modal.getBoundingClientRect();
            return {
              viewport: innerWidth,
              modalLeft: r.left,
              modalRight: r.right,
              modalWidth: modal.clientWidth,
              modalScroll: modal.scrollWidth,
              panelWidth: panel.clientWidth,
              panelScroll: panel.scrollWidth
            };
          });
          await screenshot('dark-cache-' + width);
          assert.ok(
            geometry.modalLeft >= -1 && geometry.modalRight <= width + 1,
            JSON.stringify(geometry)
          );
          assert.ok(
            geometry.modalScroll <= geometry.modalWidth + 1 &&
              geometry.panelScroll <= geometry.panelWidth + 1,
            JSON.stringify(geometry)
          );
          await page.locator('#cache-reset').click();
          await waitChild();
          const child = await page.locator('.cache-confirm-dialog').evaluate((dialog) => {
            const r = dialog.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              scroll: dialog.scrollWidth,
              width: dialog.clientWidth
            };
          });
          await screenshot('dark-confirmation-' + width);
          await page.locator('[data-cache-cancel]').click();
          await page.waitForFunction(() => !document.querySelector('.cache-confirm-dialog'));
          assert.ok(
            child.left >= -1 && child.right <= width + 1 && child.scroll <= child.width + 1,
            JSON.stringify(child)
          );
          await page.locator('#reset-cache-directory').click();
          await waitChild();
          const restore = await page.locator('.cache-confirm-dialog').evaluate((dialog) => {
            const rect = dialog.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              scroll: dialog.scrollWidth,
              width: dialog.clientWidth
            };
          });
          await screenshot('dark-restore-confirmation-' + width);
          await page.locator('[data-cache-cancel]').click();
          await page.waitForFunction(() => !document.querySelector('.cache-confirm-dialog'));
          assert.ok(
            restore.left >= -1 && restore.right <= width + 1 && restore.scroll <= restore.width + 1,
            JSON.stringify(restore)
          );
          return { geometry, child, restore };
        }
      );
    }
    for (const width of [980, 320]) {
      await check(
        'injected IPC error feedback remains readable within ' + width + 'px viewport',
        async () => {
          await size(width);
          await select('cache');
          const message =
            'Isolated narrow cache feedback fixture: ' +
            'GeneratedUnbrokenCacheDirectory'.repeat(6);
          await configure('cleanCache', { fail: true, message });
          await page.locator('#cache-unused').click();
          await idle();
          await page.waitForFunction(
            (message) => document.querySelector('#toast-region')?.textContent.includes(message),
            message
          );
          await configure('cleanCache', {});
          const feedback = await page.locator('#toast-region').evaluate((region) => {
            const geometry = (element) => {
              const rect = element.getBoundingClientRect();
              return {
                left: rect.left,
                right: rect.right,
                width: element.clientWidth,
                scroll: element.scrollWidth
              };
            };
            return {
              region: geometry(region),
              bubble: geometry(region.querySelector('.toast')),
              message: geometry(region.querySelector('.toast span')),
              text: region.textContent
            };
          });
          await screenshot('dark-error-feedback-' + width);
          for (const [name, rect] of Object.entries(feedback)) {
            if (name === 'text') continue;
            assert.ok(
              rect.left >= -1 && rect.right <= width + 1 && rect.scroll <= rect.width + 1,
              JSON.stringify({ name, ...rect })
            );
          }
          return feedback;
        }
      );
    }
    await check('no renderer exceptions and original fixture remains byte-identical', async () => {
      assert.deepEqual(report.errors, []);
      assert.equal(hash(await fs.readFile(image)), originalHash);
    });
  } catch (error) {
    report.fatal = { stage, error: error.stack };
    console.error(error.stack);
    if (page && !page.isClosed()) await screenshot('fatal').catch(() => {});
  } finally {
    if (app) {
      await app
        .evaluate(() => {
          const gate = global.__cacheSettingsCheck;
          if (gate) {
            gate.states = {};
            gate.pending.splice(0).forEach((item) => item.resolve({ fail: true }));
          }
        })
        .catch(() => {});
      await closeApp().catch((error) => {
        report.closeError = error.message;
      });
    }
    report.passed = !report.fatal && report.checks.every((item) => item.status === 'passed');
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify(
        {
          passed: report.passed,
          checks: report.checks.length,
          failures: report.checks
            .filter((item) => item.status !== 'passed')
            .map((item) => item.name),
          report: path.join(run, 'report.json')
        },
        null,
        2
      )
    );
    if (!report.passed) process.exitCode = 1;
  }
})();
