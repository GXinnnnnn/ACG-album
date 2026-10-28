'use strict';
// Isolated runtime measurements; this script is excluded from the shipped application.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises'),
  path = require('node:path'),
  os = require('node:os'),
  assert = require('node:assert/strict');
const { idFor } = require('../src/model.cjs');
const baseline = process.argv.includes('--baseline'),
  packaged = process.argv.includes('--packaged');
const label = baseline ? 'baseline' : packaged ? 'packaged' : 'source',
  report = { label, errors: [], cases: [] };
const percentile = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] || 0;
(async () => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-sidebar-'));
  let app, page, cdp;
  async function resize(width, height) {
    await app.evaluate(
      ({ BrowserWindow }, { width, height }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win.isMaximized()) win.unmaximize();
        win.setContentSize(width, height);
      },
      { width, height }
    );
    await page.waitForFunction(
      ({ width, height }) => innerWidth === width && innerHeight === height,
      { width, height }
    );
  }
  async function settled() {
    await page.evaluate(() =>
      Promise.all(
        $('#sidebar-shell')
          .getAnimations({ subtree: true })
          .map((a) => a.finished.catch(() => {}))
      )
    );
  }
  async function metrics() {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
  }
  try {
    const env = { ...process.env, ACG_DATA_DIR: data, ACG_TEST: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: packaged
        ? path.resolve(
            require('./distribution-paths.cjs').runtimeDirectory(),
            `${require('../package.json').build.productName}.exe`
          )
        : require('electron'),
      args: packaged ? [] : ['.'],
      env
    });
    page = await app.firstWindow();
    page.on('pageerror', (e) => report.errors.push(e.message));
    await page.waitForFunction(
      () =>
        typeof S !== 'undefined' &&
        S.settings.nickname !== undefined &&
        window.applyNavigationSettings
    );
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await resize(1920, 1032);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('watchChanges', false);
      await saveSetting('sidebarMode', 'auto');
    });
    const source = path.join(require('./distribution-paths.cjs').workspaceRoot, 'ACG图片');
    await app.evaluate(({ dialog }, source) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
    }, source);
    await page.evaluate(() => window.album.call('import'));
    await page.waitForFunction(() => $('#progress-panel').hidden);
    await page.waitForFunction(() => S.roots.length === 1);
    let parent = idFor(source);
    for (let depth = 0; depth < 9; depth++) {
      const result = await page.evaluate(
        (parent) => api('list', { parent, filter: 'images', limit: 1 }),
        parent
      );
      if (result.total > 1000) {
        report.images = result.total;
        break;
      }
      const children = await page.evaluate(
        (parent) => api('list', { parent, filter: 'folders', limit: 180 }),
        parent
      );
      parent = children.items.sort((a, b) => b.files - a.files)[0].id;
    }
    assert.ok(report.images > 1000);
    await page.evaluate((parent) => navigate({ parent }), parent);
    await page.waitForFunction(() => grid.active && grid.cards.size > 0);
    for (const [width, height] of [
      [1920, 1032],
      [3840, 2160]
    ])
      for (const theme of ['light', 'dark']) {
        await resize(width, height);
        await page.evaluate((theme) => changeTheme(theme), theme);
        await page.mouse.move(width - 40, 80);
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.image-card img')]
            .filter((i) => {
              const r = i.getBoundingClientRect();
              return r.bottom > 220 && r.top < innerHeight;
            })
            .every((i) => i.complete && i.naturalWidth > 0)
        );
        await page.evaluate(() => {
          document.activeElement?.blur();
          setSidebarOpen(false);
          window.__sidebarBefore = {
            x: $('main').getBoundingClientRect().x,
            version: S.loadVersion,
            items: grid.items,
            cards: grid.cards
          };
        });
        await settled();
        const before = await metrics();
        const sample = await page.evaluate(
          () =>
            new Promise((resolve) => {
              const frames = [],
                longTasks = [];
              let start,
                last,
                phase = -1;
              const observer = new PerformanceObserver((list) =>
                longTasks.push(...list.getEntries().map((e) => e.duration))
              );
              observer.observe({ type: 'longtask' });
              function tick(t) {
                if (start === undefined) {
                  start = t;
                  last = t;
                } else frames.push(t - last);
                last = t;
                const step = Math.floor((t - start) / 350);
                if (step !== phase) {
                  phase = step;
                  setSidebarOpen(step % 2 === 0);
                }
                if (t - start < 2800) requestAnimationFrame(tick);
                else {
                  observer.disconnect();
                  setSidebarOpen(false);
                  resolve({ frames, longTasks });
                }
              }
              requestAnimationFrame(tick);
            })
        );
        await settled();
        const after = await metrics();
        const stable = await page.evaluate(() => ({
          mainX: $('main').getBoundingClientRect().x,
          versionStable: S.loadVersion === window.__sidebarBefore.version,
          itemsStable: grid.items === window.__sidebarBefore.items,
          cardsStable: grid.cards === window.__sidebarBefore.cards,
          xStable: $('main').getBoundingClientRect().x === window.__sidebarBefore.x,
          dom: grid.cards.size
        }));
        assert.ok(
          stable.versionStable && stable.itemsStable && stable.cardsStable && stable.xStable
        );
        const effects = await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter(
              (el) =>
                el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
                getComputedStyle(el).backdropFilter !== 'none'
            )
            .map((el) => ({
              element: el.id || el.className,
              area: Math.round(
                el.getBoundingClientRect().width * el.getBoundingClientRect().height
              ),
              filter: getComputedStyle(el).backdropFilter
            }))
        );
        report.cases.push({
          width,
          height,
          theme,
          frames: {
            samples: sample.frames.length,
            medianMs: percentile(sample.frames, 0.5),
            p95Ms: percentile(sample.frames, 0.95),
            maxMs: Math.max(...sample.frames),
            over25Ms: sample.frames.filter((t) => t > 25).length,
            longTasks: sample.longTasks
          },
          cpu: {
            taskMs: 1000 * (after.TaskDuration - before.TaskDuration),
            scriptMs: 1000 * (after.ScriptDuration - before.ScriptDuration),
            layoutMs: 1000 * (after.LayoutDuration - before.LayoutDuration),
            layoutCount: after.LayoutCount - before.LayoutCount,
            styleMs: 1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration)
          },
          heapMiB: after.JSHeapUsedSize / 1048576,
          closedBackdropSurfaces: effects,
          ...stable
        });
      }
    await resize(1920, 1032);
    await page.mouse.move(1800, 80);
    await page.evaluate(() => {
      window.__layoutCalls = 0;
      const original = grid.layout;
      grid.layout = function (...args) {
        window.__layoutCalls++;
        return original.apply(this, args);
      };
    });
    for (const mode of ['expanded', 'auto']) {
      await page.evaluate((mode) => saveSetting('sidebarMode', mode), mode);
      await page.evaluate(() =>
        Promise.all(
          $('main')
            .getAnimations()
            .map((a) => a.finished.catch(() => {}))
        )
      );
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      );
    }
    report.pinGridLayouts = await page.evaluate(() => window.__layoutCalls);
    if (!baseline) {
      // A single fixed-content panel grows from the icon rail; shared icon positions stay put.
      await page.evaluate(() => {
        document.activeElement.blur();
        setSidebarOpen(false);
      });
      await settled();
      const iconBefore = await page.locator('#import-sidebar svg').boundingBox();
      await page.mouse.move(50, 180);
      await page.waitForFunction(() => sidebarOpen);
      await settled();
      const iconAfter = await page.locator('#import-sidebar svg').boundingBox();
      assert.ok(
        Math.abs(iconBefore.x - iconAfter.x) < 0.1 && Math.abs(iconBefore.y - iconAfter.y) < 0.1
      );
      report.iconPositionStable = true;
      await page.mouse.move(245, 350);
      assert.equal(await page.evaluate(() => sidebarOpen), true);
      await page.mouse.move(1000, 80);
      await page.waitForFunction(() => !sidebarOpen);
      await settled();
      // Reversing before open/close timers expire must not reopen later.
      await page.mouse.move(50, 180);
      await page.mouse.move(1000, 80);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 240)));
      assert.equal(await page.evaluate(() => sidebarOpen), false);
      await page.locator('#rail-tree').focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => sidebarOpen);
      await settled();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !sidebarOpen);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'rail-tree');
      await settled();
      report.keyboardAndHover = true;
      await page.evaluate(() => saveSetting('sidebarMode', 'compact'));
      await page.mouse.move(50, 180);
      await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
      assert.equal(await page.evaluate(() => sidebarOpen), false);
      await page.locator('#rail-tree').click();
      await page.waitForFunction(() => sidebarOpen);
      await settled();
      await page.locator('#rail-tree').click();
      await page.waitForFunction(() => sidebarOpen);
      assert.equal(await page.evaluate(() => sidebarOpen), true);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !sidebarOpen);
      assert.equal(await page.evaluate(() => sidebarOpen), false);
      report.clickMode = true;
      await page.evaluate(() => saveSetting('sidebarMode', 'expanded'));
      await settled();
      await page.mouse.move(1000, 80);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => sidebarOpen), true);
      assert.ok(Math.abs((await page.locator('main').boundingBox()).x - 274) < 1);
      report.pinMode = true;
      await page.evaluate(() => saveSetting('sidebarMode', 'auto'));
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => {
        document.activeElement.blur();
        setSidebarOpen(false);
        setSidebarOpen(true);
      });
      report.reducedMotion = await page.evaluate(
        () => $('#sidebar-shell').getAnimations({ subtree: true }).length === 0
      );
      assert.equal(report.reducedMotion, true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      for (const [width, height] of [
        [980, 680],
        [1920, 1032],
        [3840, 2160]
      ]) {
        await resize(width, height);
        await page.evaluate(() => setSidebarOpen(true));
        await settled();
        const bounds = await page.locator('#sidebar-shell').boundingBox();
        assert.ok(
          bounds.x >= 0 &&
            bounds.y >= 36 &&
            bounds.x + bounds.width <= width &&
            bounds.y + bounds.height <= height
        );
        assert.equal(
          await page.evaluate(() => $('#viewport').scrollWidth <= $('#viewport').clientWidth + 1),
          true
        );
      }
      await resize(1920, 1032);
      await page.evaluate(async () => {
        await changeTheme('light');
        setSidebarOpen(true);
      });
      await settled();
      await page.screenshot({ path: `artifacts/sidebar-${label}-light.png` });
      await page.evaluate(() => changeTheme('dark'));
      await settled();
      await page.screenshot({ path: `artifacts/sidebar-${label}-dark.png` });
      await page.evaluate(() => {
        document.activeElement.blur();
        setSidebarOpen(false);
      });
      await settled();
      await page.screenshot({ path: `artifacts/sidebar-${label}-rail.png` });
      assert.ok(
        report.pinGridLayouts <= 3,
        `Pinning relaid out the grid ${report.pinGridLayouts} times`
      );
    }
    report.memory = await app.evaluate(({ app }) =>
      app.getAppMetrics().map((p) => ({
        type: p.type,
        workingSetMiB: p.memory.workingSetSize / 1024,
        privateMiB: p.memory.privateBytes / 1024
      }))
    );
    assert.deepEqual(report.errors, []);
    await fs.writeFile(`artifacts/sidebar-${label}-report.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    if (page)
      await page.screenshot({ path: `artifacts/sidebar-${label}-failure.png` }).catch(() => {});
    console.error(error);
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    const resolved = path.resolve(data);
    assert.ok(resolved.startsWith(path.join(path.resolve(os.tmpdir()), 'acg-sidebar-')));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
