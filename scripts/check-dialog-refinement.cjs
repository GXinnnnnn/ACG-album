'use strict';
// Lead runs this GUI check serially. It uses only a fresh generated profile.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const report = {
  checks: [],
  errors: [],
  scope:
    'Isolated source/packaged Electron. Actual search, preferences, profile and font-picker controls; generated decoded checkerboard behind dialogs. No personal library or font setting changes; no performance claim.'
};
let app, page, run;
const stats = () => page.evaluate(() => window.albumLiquidGlass.stats());
async function settle() {
  await page.waitForFunction(() => window.albumLiquidGlass.stats().pending === 0);
  await page.waitForTimeout(220);
}
async function check(name, action) {
  const details = await action();
  report.checks.push({ name, passed: true, details });
  console.log('PASS ' + name);
}
async function nonModal() {
  return page.evaluate(() =>
    [
      '.topbar > .brand',
      '.topbar > .navigation',
      '.topbar > .search-wrap',
      '.topbar > .header-actions',
      '.sidebar-shell',
      '.toolbar-right'
    ].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector));
      return {
        selector,
        background: style.backgroundColor,
        image: style.backgroundImage,
        backdrop: style.backdropFilter
      };
    })
  );
}
async function focusShape(selector, offset = 0) {
  const node = page.locator(selector).first();
  await expect(node).toBeVisible();
  const before = await node.boundingBox();
  // Establish native keyboard modality before moving focus to the real control.
  await page.keyboard.press('Tab');
  await node.focus();
  await expect.poll(() => node.evaluate((element) => element.matches(':focus-visible'))).toBe(true);
  const actual = await node.evaluate((element) => {
    const style = getComputedStyle(element),
      r = element.getBoundingClientRect();
    return {
      outline: style.outlineStyle,
      width: parseFloat(style.outlineWidth),
      offset: parseFloat(style.outlineOffset),
      color: style.outlineColor,
      radius: style.borderRadius,
      shadow: style.boxShadow,
      textShadow: style.textShadow,
      opacity: style.opacity,
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height }
    };
  });
  assert.equal(actual.outline, 'solid');
  assert.equal(actual.width, 2);
  assert.equal(actual.offset, offset);
  assert.notEqual(actual.color, 'rgba(0, 0, 0, 0)');
  // Scroll-into-view can change x/y; focus must never resize the control.
  for (const key of ['width', 'height'])
    assert.ok(
      Math.abs(actual.bounds[key] - before[key]) < 0.5,
      'Focus does not resize ' + selector + ' ' + key
    );
  return actual;
}
async function openFontSearch() {
  await page.locator('#font-choose').click();
  await expect(page.locator('#font-picker')).toBeVisible();
  // The first layer contains built-in families. Its local-font entry switches
  // the same dialog to the real system-font search without replacing the host.
  await page
    .locator('#font-picker')
    .getByRole('button', { name: '选择本地字体', exact: true })
    .click();
  await expect(page.locator('#font-search')).toBeVisible();
  await expect(page.locator('#font-options')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30000
  });
  await settle();
  const id = await page.locator('#font-search').evaluate((input) => input.closest('dialog').id);
  assert.match(id, /^[a-z][a-z0-9_-]*$/i, 'The real local-font dialog has a stable ID');
  return '#' + id;
}
async function closeFontSearch(selector) {
  await page.evaluate((selector) => document.querySelector(selector).close(), selector);
  await expect(page.locator('#font-search')).toHaveCount(0);
  await expect(page.locator('#font-picker')).toHaveCount(0);
}
async function dialogMaterial(selector) {
  return page.locator(selector).evaluate((host) => {
    const style = getComputedStyle(host),
      canvas = host.querySelector(':scope > .liquid-glass-canvas');
    let pixels = null;
    if (canvas) {
      const context = canvas.getContext('2d'),
        y = Math.floor(canvas.height / 2);
      pixels = {
        center: [...context.getImageData(Math.floor(canvas.width / 2), y, 1, 1).data],
        edge: [...context.getImageData(1, y, 1, 1).data]
      };
    }
    const paragraph = host.querySelector('.setting-row p,p');
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      centerScrim: style.getPropertyValue('--modal-frost-center').trim(),
      shoulderScrim: style.getPropertyValue('--modal-frost-shoulder').trim(),
      backdrop: style.backdropFilter,
      opacity: style.opacity,
      filter: style.filter,
      textShadow: style.textShadow,
      paragraph: paragraph
        ? { color: getComputedStyle(paragraph).color, opacity: getComputedStyle(paragraph).opacity }
        : null,
      pixels
    };
  });
}
function frosted(actual) {
  assert.match(actual.image, /radial-gradient/, 'Dialog center has a continuous radial scrim');
  assert.match(actual.image, /24%/);
  assert.match(actual.image, /55%/);
  assert.match(actual.image, /80%/);
  assert.match(actual.backdrop, /blur\(18px\)/);
  assert.equal(actual.opacity, '1');
  assert.equal(actual.filter, 'none', 'Content is not blurred as a whole');
  assert.ok(
    actual.pixels && actual.pixels.center[3] >= 25 && actual.pixels.center[3] < 180,
    'Full-face shader remains translucent and nonzero'
  );
  assert.ok(actual.pixels.edge[3] > 0, 'Liquid edge remains rendered');
}
async function under(selector, on = true) {
  // A native window blur intentionally pauses glass work. Restore the actual
  // test window before measuring a freshly positioned image, rather than
  // requiring a background application to keep rendering.
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
    window.webContents.focus();
  });
  await page.bringToFront();
  await expect.poll(async () => (await stats()).inactive).toBe(false);
  await page.evaluate(
    ({ selector, on }) => {
      const shell = document.querySelector('#dialog-pattern-shell');
      shell.hidden = !on;
      if (on) {
        const rect = document.querySelector(selector).getBoundingClientRect();
        Object.assign(shell.style, {
          left: rect.left + 'px',
          top: rect.top + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px'
        });
      }
      window.dispatchEvent(new Event('resize'));
    },
    { selector, on }
  );
  if (on) await expect(page.locator(selector)).toHaveAttribute('data-glass-image-under', 'true');
  else await expect(page.locator(selector)).not.toHaveAttribute('data-glass-image-under', 'true');
  await settle();
}
(async () => {
  try {
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'dialog_refinement',
      new Date().toISOString().replace(/[^a-z0-9]/gi, '_') + '_' + crypto.randomUUID()
    );
    const profile = path.join(run, 'isolated_profile');
    await fs.mkdir(profile, { recursive: true });
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: executable || require('electron'),
      args: executable ? [] : [root],
      cwd: executable ? path.dirname(executable) : root,
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.route(/^https?:\/\//, (route) => route.abort());
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumLiquidGlass
    );
    assert.equal(
      await page.evaluate(() =>
        [...document.styleSheets].some((sheet) => sheet.href?.endsWith('/dialog-refinement.css'))
      ),
      true,
      'Lead must integrate dialog-refinement.css after existing control/typography styles'
    );
    const runtime = await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) window.unmaximize();
      window.setContentSize(1600, 1000);
      window.show();
      window.focus();
      window.webContents.focus();
      return {
        exe: app.getPath('exe'),
        profile: app.getPath('userData'),
        packaged: app.isPackaged
      };
    });
    assert.equal(path.resolve(runtime.profile), path.join(profile, 'chromium-profile'));
    if (executable) {
      assert.equal(runtime.packaged, true);
      assert.equal(path.resolve(runtime.exe).toLowerCase(), executable.toLowerCase());
    }
    report.runtime = runtime;
    await page.bringToFront();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => {
      await saveSetting('liquidGlass', true);
      await saveSetting('motionLevel', 'medium');
      await saveSetting('sidebarMode', 'compact');
      setSidebarOpen(false);
    });
    await expect.poll(async () => (await stats()).gpu.status).toBe('webgl2');
    await page.evaluate(async () => {
      const image = document.createElement('img'),
        sample = document.createElement('canvas');
      sample.width = sample.height = 64;
      const context = sample.getContext('2d');
      for (let y = 0; y < 64; y += 8)
        for (let x = 0; x < 64; x += 8) {
          context.fillStyle = (x / 8 + y / 8) % 2 ? '#193657' : '#f6dfb9';
          context.fillRect(x, y, 8, 8);
        }
      const shell = document.createElement('div');
      shell.id = 'dialog-pattern-shell';
      shell.className = 'cover-shell';
      shell.hidden = true;
      shell.setAttribute('aria-hidden', 'true');
      shell.setAttribute('inert', '');
      Object.assign(shell.style, {
        position: 'fixed',
        zIndex: '2',
        pointerEvents: 'none',
        border: '0',
        padding: '0',
        margin: '0'
      });
      image.className = 'loaded';
      image.alt = '';
      image.src = sample.toDataURL('image/png');
      Object.assign(image.style, { width: '100%', height: '100%', objectFit: 'fill' });
      shell.append(image);
      document.body.append(shell);
      await image.decode();
    });
    await check(
      'light and dark search focus fits the wrapper boundary with one visible keyboard ring',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async (theme) => saveSetting('theme', theme), theme);
          await settle();
          const input = page.locator('.search-wrap input');
          await page.keyboard.press('Tab');
          await input.focus();
          const actual = await page.locator('.search-wrap').evaluate((host) => {
            const style = getComputedStyle(host),
              input = host.querySelector('input');
            return {
              outline: style.outlineStyle,
              width: parseFloat(style.outlineWidth),
              offset: parseFloat(style.outlineOffset),
              color: style.outlineColor,
              shadow: style.boxShadow,
              radius: style.borderRadius,
              innerOutline: getComputedStyle(input).outlineStyle
            };
          });
          assert.equal(actual.outline, 'solid');
          assert.equal(actual.width, 2);
          assert.equal(actual.offset, 0);
          assert.equal(actual.innerOutline, 'none');
          assert.doesNotMatch(actual.shadow, /0px 0px 0px 3px/);
          samples.push({ theme, actual });
          await page.screenshot({ path: path.join(run, 'search_' + theme + '.png') });
        }
        return samples;
      }
    );
    await check(
      'preferences, profile fields and nested font search keep compact focus and denser modal-only frost',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async (theme) => saveSetting('theme', theme), theme);
          await settle();
          const base = await nonModal();
          await page.locator('#settings-button').click();
          await expect(page.locator('#font-choose')).toBeVisible();
          await settle();
          const button = await focusShape('#font-choose', -1);
          const select = await focusShape('#modal .album-select-button', -1);
          await under('#modal');
          const settings = await dialogMaterial('#modal');
          frosted(settings);
          assert.notEqual(settings.textShadow, 'none', 'Existing image-under text halo remains');
          await page.screenshot({ path: path.join(run, 'settings_' + theme + '.png') });
          const searchDialog = await openFontSearch();
          const font = await focusShape('#font-search', 0);
          await under(searchDialog);
          const picker = await dialogMaterial(searchDialog);
          frosted(picker);
          assert.notEqual(picker.textShadow, 'none');
          await page.screenshot({ path: path.join(run, 'font_focus_' + theme + '.png') });
          await closeFontSearch(searchDialog);
          await under('#modal', false);
          await page.locator('#settings-tab-profile').click();
          const field = '#settings-panel-profile input.field-input';
          await expect(page.locator(field).first()).toBeVisible();
          const profile = await focusShape(field, 0);
          await page.screenshot({ path: path.join(run, 'profile_focus_' + theme + '.png') });
          await page.evaluate(() => document.querySelector('#modal').close());
          await settle();
          assert.deepEqual(
            await nonModal(),
            base,
            'Non-modal material is unchanged by dialog refinement'
          );
          samples.push({ theme, button, select, font, profile, settings, picker });
        }
        return samples;
      }
    );
    await check(
      'reduced motion/off retain focus and halo; modal scrim opts out with saved glass off',
      async () => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.evaluate(async () => {
          await saveSetting('motionLevel', 'low');
          await saveSetting('liquidGlass', false);
        });
        await settle();
        await page.locator('#settings-button').click();
        await expect(page.locator('#font-choose')).toBeVisible();
        const searchDialog = await openFontSearch();
        const focus = await focusShape('#font-search', 0);
        await under(searchDialog);
        const actual = await dialogMaterial(searchDialog);
        assert.doesNotMatch(actual.image, /radial-gradient/);
        assert.equal(actual.pixels, null);
        assert.notEqual(actual.textShadow, 'none', 'Off/reduced mode retains automatic text halo');
        const before = await stats();
        await page.waitForTimeout(450);
        const idle = await stats();
        assert.equal(idle.frames, before.frames);
        assert.equal(idle.legibilityPasses, before.legibilityPasses);
        assert.equal(idle.pending, 0);
        await page.screenshot({ path: path.join(run, 'font_focus_reduced_off.png') });
        return { focus, actual, before, idle };
      }
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (page)
      try {
        report.finalStats = await stats();
        report.finalGeometry = await page.evaluate(() => {
          const geometry = (selector) => {
            const node = document.querySelector(selector);
            if (!node) return null;
            const style = getComputedStyle(node);
            return {
              bounds: node.getBoundingClientRect().toJSON(),
              opacity: style.opacity,
              visibility: style.visibility,
              hidden: node.hidden,
              imageUnder: node.getAttribute('data-glass-image-under')
            };
          };
          return {
            focused: document.hasFocus(),
            shell: geometry('#dialog-pattern-shell'),
            image: geometry('#dialog-pattern-shell img'),
            picker: geometry('#font-picker'),
            preferences: geometry('#modal')
          };
        });
      } catch (error) {
        report.diagnosticError = error.message;
      }
    if (app) await app.close();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
