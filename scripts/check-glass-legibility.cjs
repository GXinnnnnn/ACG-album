'use strict';
// Lead-only serialized GUI acceptance. Does not open a personal library.
// Uses a decoded in-page checkerboard below real floating components. Its
// placement/resize invalidations are synthetic; styling and geometry are real.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
let app, page, run;
const report = {
  checks: [],
  errors: [],
  scope:
    'Fresh isolated profile; synthetic decoded checkerboard under actual header/sidebar/modal hosts. No user media, source patch, screenshot texture, timer replacement or performance claim.'
};
async function check(name, fn) {
  const details = await fn();
  report.checks.push({ name, passed: true, details });
  console.log('PASS ' + name);
}
const stats = () => page.evaluate(() => window.albumLiquidGlass.stats());
async function settled() {
  await page.waitForFunction(() => window.albumLiquidGlass?.stats().pending === 0);
  await page.waitForTimeout(200);
}
async function imageUnder(selector, on = true) {
  await page.evaluate(
    ({ selector, on }) => {
      const image = document.querySelector('#legibility-image'),
        shell = image.parentElement;
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
      // A real application resize uses this same event-driven invalidation path.
      window.dispatchEvent(new Event('resize'));
    },
    { selector, on }
  );
  report.lastPlacement = await page.evaluate((selector) => {
    const image = document.querySelector('#legibility-image'),
      host = document.querySelector(selector);
    const style = getComputedStyle(image);
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      selector,
      image: {
        className: image.className,
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        opacity: style.opacity,
        visibility: style.visibility,
        ownFloatingHost: !!image.closest(
          '.sidebar-shell,.topbar > .brand,.topbar > .navigation,.topbar > .search-wrap,.topbar > .header-actions,.toolbar-right,.back-to-top,.context-menu,.album-select-list,.progress-panel,.toast,.modal,.viewer-top,.viewer-bottom,.viewer-arrow'
        ),
        bounds: rect(image),
        clip: rect(image.parentElement)
      },
      host: { bounds: rect(host), active: host.hasAttribute('data-glass-image-under') },
      stats: window.albumLiquidGlass.stats()
    };
  }, selector);
  if (on) {
    await expect
      .poll(async () =>
        page.locator('#legibility-image').evaluate((image) => getComputedStyle(image).opacity)
      )
      .toBe('1');
    await expect(page.locator(selector)).toHaveAttribute('data-glass-image-under', 'true');
  } else await expect(page.locator(selector)).not.toHaveAttribute('data-glass-image-under', 'true');
  await settled();
}
async function ink(selector) {
  return page.locator(selector).evaluate((host) => {
    const nodes = [
      host,
      ...host.querySelectorAll(
        'strong,p,input:not([type="checkbox"]),button.primary,[role="tab"][aria-selected="true"],svg'
      )
    ].slice(0, 50);
    return {
      active: host.hasAttribute('data-glass-image-under'),
      items: nodes.map((node) => {
        const style = getComputedStyle(node);
        return {
          tag: node.tagName,
          id: node.id,
          cls: typeof node.className === 'string' ? node.className : node.className.baseVal,
          color: style.color,
          fill: style.fill,
          stroke: style.stroke,
          opacity: style.opacity,
          shadow: style.textShadow,
          filter: style.filter,
          placeholder: node.matches('input,textarea')
            ? getComputedStyle(node, '::placeholder').textShadow
            : null
        };
      })
    };
  });
}
function sameInk(before, after) {
  assert.equal(before.items.length, after.items.length);
  before.items.forEach((item, index) => {
    for (const key of ['tag', 'id', 'color', 'fill', 'stroke', 'opacity'])
      assert.equal(
        after.items[index][key],
        item[key],
        'Image-backed shadow must not replace foreground ' + key + ' on ' + item.id
      );
  });
}
function subtleShadow(value) {
  assert.match(
    value,
    /^rgba\([^)]*\) 0px 1px 2px$/,
    'One soft downward shadow replaces multi-directional luminous contours'
  );
  const color = value
    .match(/^rgba\(([^)]+)\)/)[1]
    .split(',')
    .map(Number);
  assert.ok(color[3] > 0 && color[3] <= 0.3, 'Text shadow remains faint');
  assert.ok(
    color.slice(0, 3).every((channel) => channel < 64),
    'No white luminous rim'
  );
}
function noIconRim(sample) {
  for (const item of sample.items.filter((item) => item.tag.toLowerCase() === 'svg'))
    assert.equal(
      item.filter,
      'none',
      'Icons keep their original strokes without glow or outlining filters'
    );
}
(async () => {
  try {
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'glass_legibility',
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
    await page.addInitScript(() => {
      window.__legibilityContexts = [];
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        const context = original.call(this, kind, ...args);
        if (kind === 'webgl2' && context && !__legibilityContexts.includes(context))
          __legibilityContexts.push(context);
        return context;
      };
    });
    await page.reload();
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumLiquidGlass
    );
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window.isMaximized()) window.unmaximize();
      window.setContentSize(1600, 1000);
      window.show();
      window.focus();
      window.webContents.focus();
    });
    await page.bringToFront();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => {
      await saveSetting('sidebarMode', 'compact');
      setSidebarOpen(false);
      await saveSetting('liquidGlass', true);
      await saveSetting('motionLevel', 'medium');
    });
    await page.evaluate(async () => {
      const sample = document.createElement('canvas');
      sample.width = sample.height = 64;
      const ctx = sample.getContext('2d');
      for (let y = 0; y < 64; y += 8)
        for (let x = 0; x < 64; x += 8) {
          ctx.fillStyle = (x / 8 + y / 8) % 2 ? '#102034' : '#f8efd7';
          ctx.fillRect(x, y, 8, 8);
        }
      const shell = document.createElement('div');
      shell.className = 'cover-shell';
      shell.hidden = true;
      shell.setAttribute('aria-hidden', 'true');
      shell.setAttribute('inert', '');
      Object.assign(shell.style, {
        position: 'fixed',
        zIndex: '2',
        pointerEvents: 'none',
        border: '0',
        margin: '0',
        padding: '0'
      });
      const image = document.createElement('img');
      image.id = 'legibility-image';
      // Match the production cover loader: .cover-shell img is opacity:0
      // until its successfully decoded image carries the loaded class.
      image.className = 'loaded';
      image.alt = '';
      image.src = sample.toDataURL('image/png');
      Object.assign(image.style, { width: '100%', height: '100%', objectFit: 'fill' });
      shell.append(image);
      document.body.append(shell);
      await image.decode();
    });
    await expect.poll(async () => (await stats()).gpu.status).toBe('webgl2');
    await settled();
    const runtime = await app.evaluate(({ app }) => ({
      exe: app.getPath('exe'),
      profile: app.getPath('userData'),
      packaged: app.isPackaged
    }));
    assert.equal(path.resolve(runtime.profile), path.join(profile, 'chromium-profile'));
    if (executable) {
      assert.equal(path.resolve(runtime.exe).toLowerCase(), executable.toLowerCase());
      assert.equal(runtime.packaged, true);
    }
    report.runtime = runtime;
    await check(
      'decoded image enters/leaves header with a faint downward shadow and unchanged accent/foreground',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async (theme) => saveSetting('theme', theme), theme);
          await settled();
          const selector = '.topbar > .brand';
          await imageUnder(selector, false);
          const plain = await ink(selector);
          await imageUnder(selector);
          const backed = await ink(selector);
          sameInk(plain, backed);
          subtleShadow(backed.items[0].shadow);
          noIconRim(backed);
          await page.screenshot({ path: path.join(run, 'header_' + theme + '.png') });
          await imageUnder(selector, false);
          const restored = await ink(selector);
          assert.equal(restored.items[0].shadow, plain.items[0].shadow);
          samples.push({ theme, plain, backed, restored });
        }
        return samples;
      }
    );
    await check(
      'sidebar and real profile preference fields/buttons/icons preserve color and release soft shadow',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.evaluate(async (theme) => saveSetting('theme', theme), theme);
          await settled();
          const rail = '#sidebar-shell';
          await imageUnder(rail);
          const railInk = await ink(rail);
          subtleShadow(railInk.items[0].shadow);
          noIconRim(railInk);
          await imageUnder(rail, false);
          await page.locator('#profile-button').click();
          await expect(page.locator('#modal')).toBeVisible();
          await settled();
          const plain = await ink('#modal');
          assert.ok(
            plain.items.some((item) => item.tag === 'INPUT'),
            'Use real profile input'
          );
          assert.ok(
            plain.items.some((item) => item.cls.includes('primary')),
            'Use real white-label action'
          );
          await imageUnder('#modal');
          const backed = await ink('#modal');
          sameInk(plain, backed);
          for (const item of backed.items.filter(
            (item) => item.tag === 'INPUT' || item.cls.includes('primary')
          ))
            subtleShadow(item.shadow);
          noIconRim(backed);
          await page.screenshot({ path: path.join(run, 'profile_' + theme + '.png') });
          await imageUnder('#modal', false);
          const restored = await ink('#modal');
          sameInk(plain, restored);
          assert.equal(restored.items[0].shadow, plain.items[0].shadow);
          samples.push({ theme, railInk, plain, backed, restored });
          await page.evaluate(() => document.querySelector('#modal').close());
          await settled();
        }
        return samples;
      }
    );
    await check(
      'off, low and reduced motion keep automatic text contrast without idle rendering',
      async () => {
        const samples = [];
        for (const mode of ['off', 'low', 'reduced']) {
          await page.emulateMedia({
            reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference'
          });
          await page.evaluate(async (mode) => {
            await saveSetting('liquidGlass', mode !== 'off');
            await saveSetting('motionLevel', mode === 'low' ? 'low' : 'high');
          }, mode);
          await settled();
          const before = await stats();
          await imageUnder('.topbar > .brand');
          const backed = await ink('.topbar > .brand');
          subtleShadow(backed.items[0].shadow);
          noIconRim(backed);
          await imageUnder('.topbar > .brand', false);
          const after = await stats();
          if (mode === 'off')
            assert.equal(after.frames, before.frames, 'Text-only off path must not draw GL');
          await page.waitForTimeout(450);
          const idle = await stats();
          assert.equal(idle.frames, after.frames);
          assert.equal(idle.legibilityPasses, after.legibilityPasses);
          assert.equal(idle.pending, 0);
          samples.push({ mode, before, backed, after, idle });
        }
        return samples;
      }
    );
    await check(
      'native WebGL context loss retains CSS text contrast without creating another context',
      async () => {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.evaluate(async () => saveSetting('liquidGlass', true));
        await settled();
        const available = await page.evaluate(() => {
          const extension = __legibilityContexts[0].getExtension('WEBGL_lose_context');
          if (!extension) return false;
          window.__legibilityLoss = extension;
          extension.loseContext();
          return true;
        });
        if (!available)
          return {
            skipped: true,
            reason: 'Native loss extension unavailable; unit fallback tests remain.'
          };
        await expect.poll(async () => (await stats()).gpu.status).toBe('context-lost');
        const before = await stats();
        await imageUnder('.topbar > .brand');
        subtleShadow((await ink('.topbar > .brand')).items[0].shadow);
        await imageUnder('.topbar > .brand', false);
        assert.equal((await stats()).frames, before.frames);
        assert.equal(await page.evaluate(() => __legibilityContexts.length), 1);
        await page.evaluate(() => __legibilityLoss.restoreContext());
        await expect.poll(async () => (await stats()).gpu.status).toBe('webgl2');
        await settled();
        return { before, restored: await stats() };
      }
    );
    await check(
      'medium/high preserve circular theme expansion and clear pending contrast work on hide',
      async () => {
        const clips = await page.evaluate(async () => {
          const original = document.documentElement.animate,
            clips = [];
          document.documentElement.animate = function (frames, options) {
            if (options?.pseudoElement === '::view-transition-new(root)')
              clips.push(frames.clipPath);
            return original.call(this, frames, options);
          };
          try {
            for (const motion of ['medium', 'high']) {
              await saveSetting('motionLevel', motion);
              await changeTheme(S.settings.theme === 'dark' ? 'light' : 'dark');
            }
          } finally {
            document.documentElement.animate = original;
          }
          return clips;
        });
        assert.equal(clips.length, 2);
        for (const clip of clips) assert.ok(clip[0].startsWith('circle(0px'));
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        await page.waitForTimeout(300);
        const hidden = await stats();
        await page.waitForTimeout(350);
        const stable = await stats();
        assert.equal(stable.frames, hidden.frames);
        assert.equal(stable.legibilityPasses, hidden.legibilityPasses);
        assert.equal(stable.pending, 0);
        return { clips, hidden, stable };
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
    if (page) {
      try {
        report.finalStats = await stats();
        report.finalImage = await page.locator('#legibility-image').evaluate((image) => ({
          className: image.className,
          complete: image.complete,
          naturalWidth: image.naturalWidth,
          opacity: getComputedStyle(image).opacity,
          visibleRects: image.getClientRects().length
        }));
      } catch (error) {
        report.diagnosticError = error.message;
      }
    }
    if (app) await app.close();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
