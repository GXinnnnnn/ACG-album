'use strict';
// Lead runs this serially. Source/payload app, generated profile/PNG fixture only.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
// Opt in only for public payloads; local acceptance still requires all five private faces.
const publicBuild = process.env.ACG_PUBLIC_BUILD === '1';
const families = [
  '方正兰亭圆_GBK',
  '方正兰亭圆_GBK_准',
  '方正兰亭圆_GBK_中',
  '方正兰亭圆_GBK_中粗',
  '方正兰亭圆_GBK_特'
];
const variants = ['regular', 'medium', 'semibold', 'bold', 'heavy'];
const provenance = require('../src/assets/fonts/founder-lanting-yuan/PROVENANCE.json');
const report = {
  checks: [],
  screenshots: [],
  errors: [],
  sessions: [],
  publicBuild,
  scope:
    'Generated source/profile only; offline preset fonts or explicit public fallback and real installed-font enumeration; no personal-library access'
};
let app,
  page,
  localFontsSession,
  run,
  profile,
  source,
  stage = 'setup';
async function check(name, action) {
  stage = name;
  try {
    const details = await action();
    report.checks.push({ name, passed: true, details });
    console.log('PASS ' + name);
  } catch (error) {
    report.checks.push({ name, passed: false, error: error.stack });
    throw error;
  }
}
async function shot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function settled() {
  await page.waitForFunction((allowFallback) => {
    const state = document.documentElement.dataset.fontState;
    return state === 'ready' || (allowFallback && state === 'fallback');
  }, publicBuild);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const executable = process.env.ACG_EXECUTABLE;
  app = await _electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await app.context().route(/^https?:\/\//, (route) => {
    report.errors.push('Unexpected renderer HTTP: ' + route.request().url());
    return route.abort();
  });
  const runtime = await app.evaluate(
    ({ app, BrowserWindow, dialog, net, session }, generated) => {
      const p = process.mainModule.require('node:path');
      if (p.resolve(app.getPath('userData')) !== p.resolve(generated.profile, 'chromium-profile'))
        throw Error('Profile isolation failed');
      const win = BrowserWindow.getAllWindows()[0];
      win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(1600, 1050);
      win.webContents.setBackgroundThrottling(false);
      win.show();
      win.focus();
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [generated.source] });
      const fetch = net.fetch.bind(net);
      net.fetch = async (value, options) => {
        const url = new URL(String(value));
        if (url.protocol === 'file:') return fetch(value, options);
        throw Error('Unexpected public fetch: ' + url.href);
      };
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, done) => done({ cancel: true })
      );
      return {
        packaged: app.isPackaged,
        version: app.getVersion(),
        appPath: app.getAppPath(),
        executable: process.execPath,
        userData: app.getPath('userData')
      };
    },
    { profile, source }
  );
  report.runtime = runtime;
  report.sessions.push({ runtime, closed: false });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (publicBuild) {
    // Keep this session attached until the app closes, including across reload.
    localFontsSession = await page.context().newCDPSession(page);
    await localFontsSession.send('DOM.enable');
    await localFontsSession.send('CSS.enable');
    await localFontsSession.send('CSS.setLocalFontsEnabled', { enabled: false });
    await page.reload();
    await localFontsSession.send('CSS.setLocalFontsEnabled', { enabled: false });
  }
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumTypography
  );
  await settled();
}
async function close() {
  if (!app) return;
  const owned = app;
  app = null;
  let timer;
  try {
    await Promise.race([
      owned.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Owned Electron close timeout')), 15000);
      })
    ]);
    report.sessions.at(-1).closed = true;
  } catch (error) {
    const child = owned.process();
    if (child && child.exitCode === null && child.signalCode === null) {
      let exitTimer;
      try {
        await new Promise((resolve, reject) => {
          child.once('exit', resolve);
          exitTimer = setTimeout(
            () => reject(Error('Owned Electron did not exit after kill')),
            5000
          );
          child.kill();
        });
      } finally {
        clearTimeout(exitTimer);
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function appearance() {
  await page.evaluate(() => settingsModal('appearance'));
  await expect(page.locator('#font-choose')).toBeVisible();
}
async function picker() {
  await page.locator('#font-choose').click();
  await expect(page.locator('#font-picker')).toBeVisible();
  await expect(page.locator('#font-options')).toHaveAttribute('aria-label', '预设字体');
  await expect(page.locator('[data-font-help]')).toHaveText(
    '预设字体在本机可用时使用，缺失时自动使用系统后备字体。也可选择这台电脑已安装的字体。'
  );
}
(async () => {
  try {
    const base = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      base,
      'typography',
      new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
        '_' +
        crypto.randomUUID().replaceAll('-', '_')
    );
    await fs.mkdir(run, { recursive: true });
    run = await fs.realpath(run);
    const relative = path.relative(base, run);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    profile = path.join(run, 'generated_profile');
    source = path.join(run, 'generated_collection');
    for (let i = 0; i < 60; i++) {
      const directory = path.join(source, '字体锚点_' + String(i).padStart(3, '0'));
      await fs.mkdir(directory, { recursive: true });
      await sharp({
        create: { width: 80, height: 120, channels: 3, background: { r: 100 + i, g: 140, b: 190 } }
      })
        .png()
        .toFile(path.join(directory, 'cover.png'));
    }
    report.run = run;
    report.profile = profile;
    await launch();
    if (publicBuild)
      await check(
        'public payload without TTF uses system fallback with local fonts disabled',
        async () => {
          const files = await app.evaluate(({ app }) => {
            const fs = process.mainModule.require('node:fs');
            const p = process.mainModule.require('node:path');
            return fs.readdirSync(
              p.join(app.getAppPath(), 'src/assets/fonts/founder-lanting-yuan'),
              {
                recursive: true
              }
            );
          });
          assert.deepEqual(
            files.filter((file) => /\.ttf$/i.test(file)),
            []
          );
          const result = await page.evaluate(async () => {
            const loads = await Promise.allSettled(
              [400, 500, 600, 700, 900].map((weight) =>
                document.fonts.load(`${weight} 28px "ACG Lanting Yuan"`, '相册收藏 文件夹')
              )
            );
            return {
              family: getComputedStyle(document.documentElement).fontFamily,
              setting: S.settings.fontFamily || '',
              state: document.documentElement.dataset.fontState,
              loads: loads.map((load) => ({
                status: load.status,
                count: load.status === 'fulfilled' ? load.value.length : 0
              })),
              loadedFaces: [...document.fonts]
                .filter((face) => face.status === 'loaded')
                .map((face) => face.family)
            };
          });
          assert.equal(result.setting, '');
          assert.match(result.family, /^"?方正兰亭圆_GBK_中"?,/);
          assert.equal(result.state, 'fallback');
          // FontFaceSet.load can report CSS face records even when Chromium has
          // disabled local sources. Inspect the fonts that actually draw glyphs.
          const originalStyle = await page.locator('#page-title').getAttribute('style');
          const rendered = [];
          try {
            for (const weight of [null, 400, 500, 600, 700, 900]) {
              if (weight)
                await page.locator('#page-title').evaluate((title, value) => {
                  title.style.fontFamily =
                    '"ACG Lanting Yuan", "Segoe UI", "Microsoft YaHei UI", sans-serif';
                  title.style.fontWeight = String(value);
                }, weight);
              await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
              const { root: document } = await localFontsSession.send('DOM.getDocument');
              const { nodeId } = await localFontsSession.send('DOM.querySelector', {
                nodeId: document.nodeId,
                selector: '#page-title .home-copy-text'
              });
              const { fonts } = await localFontsSession.send('CSS.getPlatformFontsForNode', {
                nodeId
              });
              assert.ok(
                fonts.some((font) => font.glyphCount > 0),
                JSON.stringify(fonts)
              );
              assert.ok(
                fonts.every(
                  (font) =>
                    !font.isCustomFont &&
                    (!weight ||
                      !/方正|lanting|FZLT|FZLan/i.test(font.familyName + ' ' + font.postScriptName))
                ),
                JSON.stringify(fonts)
              );
              rendered.push({ weight: weight || 'default', fonts });
            }
          } finally {
            await page.locator('#page-title').evaluate((title, style) => {
              if (style === null) title.removeAttribute('style');
              else title.setAttribute('style', style);
            }, originalStyle);
          }
          await shot('public_default_fallback');
          return { ...result, rendered, files, localFontsEnabled: false };
        }
      );
    else
      await check(
        'five bundled weights load from application files with local fonts disabled',
        async () => {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
          await cdp.send('CSS.setLocalFontsEnabled', { enabled: false });
          await page.reload();
          await cdp.send('CSS.setLocalFontsEnabled', { enabled: false });
          await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
          await settled();
          try {
            const result = await page.evaluate(async () => {
              const weights = [400, 500, 600, 700, 900];
              await Promise.all(
                weights.map((weight) =>
                  document.fonts.load(`${weight} 28px "ACG Lanting Yuan"`, '相册收藏 文件夹')
                )
              );
              const defaultFaces = await document.fonts.load(
                '400 16px "方正兰亭圆_GBK_中"',
                '我的相册'
              );
              const faces = [...document.fonts]
                .filter((face) => face.family.replaceAll(/['"]/g, '') === 'ACG Lanting Yuan')
                .map((face) => ({ family: face.family, weight: face.weight, status: face.status }));
              const canvases = weights.map((weight) => {
                const canvas = document.createElement('canvas');
                canvas.width = 600;
                canvas.height = 80;
                const ctx = canvas.getContext('2d');
                ctx.font = `${weight} 28px "ACG Lanting Yuan"`;
                ctx.fillText('相册收藏 文件夹 Aa0123', 8, 48);
                return canvas.toDataURL();
              });
              return {
                family: getComputedStyle(document.documentElement).fontFamily,
                setting: S.settings.fontFamily || '',
                state: document.documentElement.dataset.fontState,
                defaultFaces: defaultFaces.map((face) => ({
                  family: face.family,
                  status: face.status
                })),
                faces,
                canvases
              };
            });
            assert.match(result.family, /^"?方正兰亭圆_GBK_中"?,/);
            assert.equal(result.setting, '');
            assert.equal(result.state, 'ready');
            assert.ok(
              result.defaultFaces.length > 0 &&
                result.defaultFaces.every((face) => face.status === 'loaded'),
              'Default medium preset must load locally'
            );
            assert.equal(result.faces.length, 5);
            assert.ok(result.faces.every((face) => face.status === 'loaded'));
            const hashes = result.canvases.map((value) =>
              crypto.createHash('sha256').update(value).digest('hex')
            );
            assert.equal(
              new Set(hashes).size,
              5,
              'Five real faces must render distinct Chinese glyph strokes: ' +
                JSON.stringify({ hashes, faces: result.faces })
            );
            const fonts = await app.evaluate(({ app }, files) => {
              const fs = process.mainModule.require('node:fs'),
                p = process.mainModule.require('node:path'),
                crypto = process.mainModule.require('node:crypto');
              return files.map((file) => {
                const absolute = p.join(
                  app.getAppPath(),
                  'src/assets/fonts/founder-lanting-yuan',
                  file + '.ttf'
                );
                const bytes = fs.readFileSync(absolute);
                return {
                  file: file + '.ttf',
                  bytes: bytes.length,
                  sha256: crypto.createHash('sha256').update(bytes).digest('hex')
                };
              });
            }, variants);
            // Source and app.asar must contain the same unchanged user-supplied files.
            for (const font of fonts) {
              const bytes = await fs.readFile(
                path.join(root, 'src/assets/fonts/founder-lanting-yuan', font.file)
              );
              assert.equal(font.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
            }
            await shot('default_bundled_weights');
            return {
              defaultFaces: result.defaultFaces,
              faces: result.faces,
              glyphHashes: hashes,
              fonts,
              provenance
            };
          } finally {
            await cdp.send('CSS.setLocalFontsEnabled', { enabled: true });
            await cdp.detach();
          }
        }
      );
    await check(
      'real generated cards keep their scroll anchor through builtin-face selection',
      async () => {
        assert.equal((await page.evaluate(() => api('init'))).roots.length, 0);
        await page.evaluate(async () => {
          await saveSetting('watchChanges', false);
          await saveSetting('autoMatch', false);
        });
        await page.locator('#import-sidebar').click();
        await expect(page.locator('#import-options')).toBeVisible();
        await page.locator('#import-online-match').uncheck();
        await page.locator('#import-options-confirm').click();
        await page.waitForFunction(
          () => !scanActive && pendingImport === null && S.current?.files >= 0,
          {},
          { timeout: 60000 }
        );
        await page.waitForFunction(() => document.querySelectorAll('.album-card').length > 0);
        await page.evaluate(() => {
          const viewport = document.getElementById('viewport');
          viewport.scrollTop = 600;
          viewport.dispatchEvent(new Event('scroll'));
        });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const before = await page.evaluate(() => {
          const a = captureDisplayAnchor();
          return { kind: a.kind, index: a.index, offset: a.offset, scroll: a.scroll };
        });
        await appearance();
        await picker();
        assert.equal(await page.locator('#font-options [role="option"]').count(), 5);
        await expect(page.locator('[data-font-local]')).toHaveText('选择本地字体');
        await expect(page.locator('#font-search')).toBeHidden();
        await page.getByRole('option', { name: families[3], exact: true }).click();
        await expect(page.locator('#font-picker')).toHaveCount(0);
        await settled();
        await page.locator('#modal-close').click();
        const after = await page.evaluate(() => {
          const a = captureDisplayAnchor();
          return { kind: a.kind, index: a.index, offset: a.offset, scroll: a.scroll };
        });
        assert.equal(after.kind, before.kind);
        if (before.kind === 'grid') {
          assert.equal(after.index, before.index);
          assert.ok(Math.abs(after.offset - before.offset) < 3);
        } else if (before.kind === 'scroll') assert.ok(Math.abs(after.scroll - before.scroll) < 3);
        await shot('builtin_face_anchor');
        return { before, after, selected: families[3] };
      }
    );
    await check(
      'each builtin face persists while local-font search stays a separate second layer',
      async () => {
        await appearance();
        const selections = [];
        for (const family of families) {
          await picker();
          await page.getByRole('option', { name: family, exact: true }).click();
          await expect(page.locator('#font-picker')).toHaveCount(0);
          await settled();
          assert.equal(await page.evaluate(() => S.settings.fontFamily), family);
          const state = await page.evaluate(() => document.documentElement.dataset.fontState);
          // Public presets can resolve to a real installed face on this machine;
          // the explicit missing-source scenario is checked separately above.
          if (publicBuild) assert.ok(['ready', 'fallback'].includes(state), state);
          else assert.equal(state, 'ready');
          selections.push({ family, state });
        }
        await picker();
        await page.locator('[data-font-local]').click();
        await expect(page.locator('#font-search')).toBeVisible();
        await expect(page.locator('#font-options')).toHaveAttribute('aria-busy', 'false');
        const available = await page
          .locator('#font-options [data-font-family]')
          .evaluateAll((nodes) => nodes.map((node) => node.dataset.fontFamily).filter(Boolean));
        await page.locator('#font-search').fill('__missing_font_fixture__');
        await expect(page.locator('#font-options [role="option"]')).toHaveCount(1);
        await expect(page.locator('#font-options')).toHaveAttribute('aria-label', '已安装字体');
        await expect(page.locator('[data-font-back]')).toHaveText('返回预设字体');
        await page.locator('[data-font-back]').click();
        await expect(page.locator('#font-search')).toBeHidden();
        assert.equal(await page.locator('#font-options [role="option"]').count(), 5);
        await page.keyboard.press('Escape');
        await expect(page.locator('#font-picker')).toHaveCount(0);
        await expect(page.locator('#font-choose')).toBeFocused();
        await page.locator('#modal-close').click();
        await close();
        await launch();
        assert.equal(await page.evaluate(() => S.settings.fontFamily), families[4]);
        const external = available.find(
          (family) => !families.includes(family) && family !== 'ACG Lanting Yuan'
        );
        if (external) {
          await appearance();
          await picker();
          await page.locator('[data-font-local]').click();
          await expect(page.locator('#font-options')).toHaveAttribute('aria-busy', 'false');
          await page.locator('#font-search').fill(external);
          await page.getByRole('option', { name: external, exact: true }).click();
          await settled();
          await close();
          await launch();
          assert.equal(await page.evaluate(() => S.settings.fontFamily), external);
          const applied = await page.evaluate((family) => {
            const expected = document.createElement('span');
            expected.style.fontFamily = JSON.stringify(family);
            return {
              actual: document.documentElement.style.fontFamily,
              expected: expected.style.fontFamily
            };
          }, external);
          assert.ok(
            applied.actual.startsWith(applied.expected + ','),
            'Persisted local face leads the CSSOM font stack: ' + JSON.stringify(applied)
          );
        }
        return { selections, builtinRestart: families[4], localRestart: external || null };
      }
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = { stage, message: error.message, stack: error.stack };
    process.exitCode = 1;
    if (page) await shot('failure').catch(() => {});
  } finally {
    try {
      await close();
    } catch (error) {
      report.errors.push(error.stack);
      report.passed = false;
      process.exitCode = 1;
    }
    if (run) {
      report.finishedAt = new Date().toISOString();
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log(file);
    }
  }
})();
