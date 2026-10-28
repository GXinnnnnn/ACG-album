'use strict';
// Lead runs the GUI serially; --static checks the generated eight-tooth icon without launching Electron.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const report = { checks: [], errors: [], geometry: [], transitions: [], screenshots: [] };
let app, page, run, profile, collection, project, chapter;
async function check(name, action) {
  await action();
  report.checks.push({ name, passed: true });
  console.log('PASS ' + name);
}
async function checkIcon() {
  const sandbox = { window: {} };
  vm.runInNewContext(
    await fs.readFile(path.join(root, 'src/ui/sidebar-icons.js'), 'utf8'),
    sandbox
  );
  assert.match(
    sandbox.window.albumSidebarIcons.pin,
    /<path d="M12 15v6"\/>/,
    'pin includes its centered stem'
  );
  const markup = sandbox.window.albumSidebarIcons.settings;
  const pathData = /<path d="([^"]+)"/.exec(markup)?.[1];
  assert.ok(pathData, 'icon exposes an SVG outline path');
  assert.match(markup, /<circle cx="12" cy="12" r="3"\/>/);
  const numbers = pathData.match(/-?\d+(?:\.\d+)?/g).map(Number);
  const points = [];
  for (let i = 0; i < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  assert.equal(points.length, 40, 'eight identical five-point teeth');
  for (const [x, y] of points) {
    const dx = x - 12,
      dy = y - 12;
    const rotated = [12 + (dx - dy) / Math.SQRT2, 12 + (dx + dy) / Math.SQRT2];
    assert.ok(
      points.some(([px, py]) => Math.hypot(px - rotated[0], py - rotated[1]) < 0.0002),
      'each outline point has a 45-degree rotational counterpart'
    );
  }
  for (const axis of [0, 1]) {
    const values = points.map((point) => point[axis]);
    assert.ok(Math.abs((Math.min(...values) + Math.max(...values)) / 2 - 12) < 0.0001);
  }
}
async function launch() {
  const { _electron } = require('@playwright/test');
  const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: executable || require('electron'),
    args: executable ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  report.defaults = await page.evaluate(() => ({
    motionLevel: S.settings.motionLevel,
    motion: document.documentElement.dataset.motion
  }));
  assert.equal(report.defaults.motionLevel, 'high');
  assert.equal(report.defaults.motion, 'high');
  const actual = await app.evaluate(({ app }) => ({
    profile: app.getPath('userData'),
    version: app.getVersion(),
    isPackaged: app.isPackaged
  }));
  assert.equal(path.resolve(actual.profile), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: executable || require('electron'), ...actual };
  await page.evaluate(async () => {
    await saveSetting('watchChanges', false);
    await saveSetting('autoMatch', false);
  });
}
async function resize(width) {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(width, 900);
  }, width);
  await page.waitForFunction((width) => innerWidth === width, width);
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
async function sidebarGeometry() {
  return page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height
      };
    };
    const shell = rect($('#sidebar-shell'));
    const settings = rect($('#settings-button'));
    const pin = rect($('#sidebar-pin'));
    const pinStyle = getComputedStyle($('#sidebar-pin'));
    const footer = rect($('.sidebar-bottom'));
    const divider = getComputedStyle($('.sidebar-bottom'), '::before');
    const copyright = getComputedStyle($('#sidebar-copyright'));
    const svg = $('#settings-button svg');
    const bounds = svg.getBBox();
    return {
      open: sidebarOpen,
      shell,
      settings,
      pin,
      pinInert: $('#sidebar-pin').inert,
      pinVisibility: pinStyle.visibility,
      pinIcon: rect($('#sidebar-pin svg')),
      footer,
      dividerLeft: parseFloat(divider.left),
      dividerWidth: parseFloat(divider.width),
      copyright: copyright.display,
      copyrightVisibility: copyright.visibility,
      icon: rect(svg),
      iconBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    };
  });
}
async function prepareGeneratedTree() {
  collection = path.join(run, 'generated-collection');
  project = path.join(collection, 'Project');
  chapter = path.join(project, 'Chapter');
  const other = path.join(collection, 'Other');
  await fs.mkdir(chapter, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  const image = await require('sharp')({
    create: { width: 24, height: 32, channels: 3, background: '#c5adc9' }
  })
    .png()
    .toBuffer();
  await fs.writeFile(path.join(chapter, 'generated.png'), image);
  await fs.writeFile(path.join(other, 'generated.png'), image);
}
(async () => {
  try {
    await check('settings gear is centered with exact eight-fold rotational symmetry', checkIcon);
    if (process.argv.includes('--static')) {
      report.passed = true;
      return;
    }
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'sidebar-refinement',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    await fs.mkdir(profile, { recursive: true });
    await prepareGeneratedTree();
    await launch();
    const { expect } = require('@playwright/test');
    await check(
      'settings and pin keep shared footer coordinates while the shell expands',
      async () => {
        for (const width of [980, 1600, 3840])
          for (const theme of ['light', 'dark']) {
            await resize(width);
            await page.mouse.move(width - 70, 100);
            await page.evaluate(async (theme) => {
              await saveSetting('theme', theme);
              await saveSetting('sidebarMode', 'compact');
              setSidebarOpen(false);
            }, theme);
            const geometry = await sidebarGeometry();
            assert.equal(geometry.copyrightVisibility, 'hidden');
            assert.equal(geometry.pinVisibility, 'visible');
            assert.equal(geometry.pinInert, false);
            assert.equal(geometry.settings.height, 44);
            assert.equal(geometry.pin.height, 44);
            assert.ok(Math.abs(geometry.pin.top - geometry.settings.bottom) <= 0.75);
            assert.ok(
              geometry.shell.bottom - geometry.pin.bottom >= 8 &&
                geometry.shell.bottom - geometry.pin.bottom <= 14
            );
            assert.ok(
              Math.abs(
                geometry.pinIcon.left +
                  geometry.pinIcon.width / 2 -
                  geometry.pin.left -
                  geometry.pin.width / 2
              ) <= 0.75
            );
            assert.ok(
              Math.abs(
                geometry.pinIcon.top +
                  geometry.pinIcon.height / 2 -
                  geometry.pin.top -
                  geometry.pin.height / 2
              ) <= 0.75
            );
            assert.equal(geometry.dividerWidth, geometry.settings.width);
            assert.ok(
              Math.abs(geometry.footer.left + geometry.dividerLeft - geometry.settings.left) < 1
            );
            // Existing shell clips the closed rail to 72px. The 40px line has 16px on both sides.
            const leftInset = geometry.footer.left + geometry.dividerLeft - geometry.shell.left;
            const rightInset = 72 - leftInset - geometry.dividerWidth;
            assert.ok(
              Math.abs(leftInset - rightInset) <= 2,
              JSON.stringify({ leftInset, rightInset })
            );
            assert.ok(Math.abs(geometry.iconBounds.x + geometry.iconBounds.width / 2 - 12) < 0.01);
            assert.ok(Math.abs(geometry.iconBounds.y + geometry.iconBounds.height / 2 - 12) < 0.01);
            report.geometry.push({ width, theme, ...geometry });
            await screenshot(`sidebar-${width}-${theme}-collapsed`);
            await page.evaluate(() => setSidebarOpen(true));
            const expanded = await sidebarGeometry();
            assert.equal(expanded.copyrightVisibility, 'visible');
            assert.equal(expanded.pinInert, false);
            assert.ok(Math.abs(expanded.dividerWidth - expanded.settings.width) <= 1);
            for (const control of ['settings', 'pin']) {
              assert.ok(
                Math.abs(expanded[control].top - geometry[control].top) <= 0.75,
                control + ' keeps its Y coordinate'
              );
              assert.ok(
                Math.abs(expanded[control].left - geometry[control].left) <= 0.75,
                control + ' keeps its left coordinate'
              );
            }
            report.geometry.push({ width, theme, ...expanded });
            assert.ok(expanded.settings.bottom <= expanded.shell.bottom);
            await screenshot(`sidebar-${width}-${theme}-expanded`);
          }
      }
    );
    await check('interrupted shell transitions keep both footer controls anchored', async () => {
      await resize(1600);
      await page.mouse.move(1500, 100);
      await page.evaluate(async () => {
        await saveSetting('sidebarMode', 'compact');
        setSidebarOpen(false);
      });
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const samples = await page.evaluate(async () => {
        const out = [];
        setSidebarOpen(true);
        for (let i = 0; i < 8; i++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          out.push({
            settingsY: $('#settings-button').getBoundingClientRect().top,
            pinY: $('#sidebar-pin').getBoundingClientRect().top,
            clip: getComputedStyle($('#sidebar-shell')).clipPath
          });
          if (i === 3) setSidebarOpen(false);
        }
        return out;
      });
      for (const sample of samples) {
        assert.ok(Math.abs(sample.settingsY - samples[0].settingsY) <= 0.75);
        assert.ok(Math.abs(sample.pinY - samples[0].pinY) <= 0.75);
      }
      assert.ok(
        new Set(samples.map((sample) => sample.clip)).size > 1,
        'normal-motion clip has intermediate frames'
      );
      report.transitions.push(...samples);
      await page.emulateMedia({ reducedMotion: 'reduce' });
    });
    await check(
      'folder control exposes the empty-library state after hover and click',
      async () => {
        await page.mouse.move(1500, 100);
        await page.evaluate(async () => {
          await saveSetting('sidebarMode', 'auto');
          setSidebarOpen(false);
        });
        await page.locator('#rail-tree').hover();
        await expect(page.locator('#rail-tree')).toHaveAttribute('aria-expanded', 'true');
        await page.locator('#rail-tree').click();
        await expect(page.locator('#category-nav .sidebar-empty')).toBeVisible();
        assert.equal(await page.evaluate(() => S.roots.length), 0);
      }
    );
    await check(
      'hover then folder click loads real child rows and preserves an expanded descendant',
      async () => {
        const { idFor } = require('../src/model.cjs');
        const rootId = idFor(collection),
          projectId = idFor(project),
          chapterId = idFor(chapter);
        await app.evaluate(({ dialog }, collection) => {
          globalThis.__sidebarFixtureChooser = dialog.showOpenDialog;
          dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [collection] });
        }, collection);
        try {
          await page.locator('#import-sidebar').click();
          await expect(page.locator('#import-options')).toBeVisible();
          const online = page.locator('#import-online-match');
          if (await online.isEnabled()) await online.uncheck();
          await expect(online).not.toBeChecked();
          await page.locator('#import-options-confirm').click();
          await page.waitForFunction(() => !scanActive && pendingImport === null, null, {
            timeout: 60000
          });
        } finally {
          await app.evaluate(({ dialog }) => {
            dialog.showOpenDialog = globalThis.__sidebarFixtureChooser;
            delete globalThis.__sidebarFixtureChooser;
          });
        }
        await page.evaluate(async () => {
          await loadSummary();
          await navigate({});
        });
        await page.waitForFunction((id) => S.roots.some((n) => n.id === id), rootId);
        await page.mouse.move(1500, 100);
        await page.evaluate(() => setSidebarOpen(false));
        const rootRow = page.locator(
          `#category-nav .tree-node[data-node-id="${rootId}"] > .tree-row`
        );
        await expect(rootRow).toHaveAttribute('aria-expanded', 'false');
        await page.locator('#rail-tree').hover();
        await expect(page.locator('#sidebar-shell')).toHaveClass(/is-open/);
        await expect(rootRow).toHaveAttribute('aria-expanded', 'false');
        await page.locator('#rail-tree').click();
        await expect(rootRow).toHaveAttribute('aria-expanded', 'true');
        const projectRow = page.locator(
          `#category-nav .tree-node[data-node-id="${projectId}"] > .tree-row`
        );
        await expect(projectRow.locator('.category-name')).toHaveText('Project');
        const listed = await page.evaluate(
          (id) => folderTree.pages.get(id).items.map((n) => n.id),
          rootId
        );
        assert.ok(listed.includes(projectId));
        await projectRow.locator('.tree-toggle').click();
        const chapterLink = page.locator(
          `#category-nav .tree-node[data-node-id="${chapterId}"] > .tree-row > .category-link`
        );
        await expect(chapterLink).toContainText('Chapter');
        await chapterLink.scrollIntoViewIfNeeded();
        await expect(chapterLink).toBeInViewport();
        await page.locator('#rail-tree').click();
        await expect(projectRow).toHaveAttribute('aria-expanded', 'true');
        await expect(chapterLink).toBeVisible();
        await screenshot('real-folder-tree-expanded');
      }
    );
    await check(
      'collapsed bottom pin supports keyboard use, persistent pinning and Escape without moving focus',
      async () => {
        await page.mouse.move(1500, 100);
        await page.evaluate(async () => {
          await saveSetting('sidebarMode', 'compact');
          setSidebarOpen(false);
        });
        await expect(page.locator('#sidebar-pin')).toBeVisible();
        await page.locator('#settings-button').focus();
        await page.keyboard.press('Tab');
        await expect(page.locator('#sidebar-pin')).toBeFocused();
        assert.equal(await page.evaluate(() => sidebarOpen), false);
        await page.keyboard.press('Enter');
        await expect(page.locator('#sidebar-pin')).toHaveAttribute('aria-pressed', 'true');
        assert.equal(await page.evaluate(() => S.settings.sidebarMode), 'expanded');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => sidebarOpen), true);
        await page.keyboard.press('Enter');
        await expect(page.locator('#sidebar-pin')).toHaveAttribute('aria-pressed', 'false');
        assert.equal(await page.evaluate(() => S.settings.sidebarMode), 'compact');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => sidebarOpen), false);
        await expect(page.locator('#sidebar-pin')).toBeFocused();
        await screenshot('collapsed-pin-keyboard');
      }
    );
    await check(
      'pointer-origin search restores focus after Escape without acquiring a keyboard outline',
      async () => {
        await page.locator('#local-search-button').click();
        await expect(page.locator('#local-search-dialog')).toBeVisible();
        await page.mouse.move(1000, 100);
        await page.keyboard.press('Escape');
        await expect(page.locator('#local-search-dialog')).toHaveCount(0);
        await expect(page.locator('#local-search-button')).toBeFocused();
        const pointerFocus = await page.locator('#local-search-button').evaluate((button) => ({
          visible: button.matches(':focus-visible'),
          marker: button.dataset.dialogFocusReturn,
          outline: getComputedStyle(button).outlineStyle
        }));
        assert.ok(
          !pointerFocus.visible ||
            (pointerFocus.marker === 'pointer' && pointerFocus.outline === 'none'),
          JSON.stringify(pointerFocus)
        );
        await screenshot('search-pointer-return');
      }
    );
    await check(
      'keyboard-origin search retains a visible inset focus ring after Escape',
      async () => {
        await page.locator('#import-sidebar').focus();
        for (let index = 0; index < 5; index++) await page.keyboard.press('Tab');
        await expect(page.locator('#local-search-button')).toBeFocused();
        assert.equal(
          await page
            .locator('#local-search-button')
            .evaluate((button) => button.matches(':focus-visible')),
          true
        );
        await page.keyboard.press('Enter');
        await expect(page.locator('#local-search-dialog')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#local-search-dialog')).toHaveCount(0);
        await expect(page.locator('#local-search-button')).toBeFocused();
        const focus = await page.locator('#local-search-button').evaluate((button) => ({
          visible: button.matches(':focus-visible'),
          marker: button.dataset.dialogFocusReturn,
          width: getComputedStyle(button).outlineWidth,
          offset: getComputedStyle(button).outlineOffset
        }));
        assert.equal(focus.visible, true);
        assert.equal(focus.marker, undefined);
        assert.equal(focus.width, '2px');
        assert.equal(focus.offset, '-3px');
        await screenshot('search-keyboard-return');
      }
    );
    assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) await app.close().catch(() => {});
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
