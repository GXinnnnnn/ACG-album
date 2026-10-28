'use strict';
// Lead runs serially after explicitly scheduling GUI/GPU measurements.
// node scripts/check-liquid-glass.cjs -- isolated generated profile and images.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { Worker } = require('node:worker_threads');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const executable = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const report = {
  scope: `${executable ? 'Packaged' : 'Source'} Electron; 30 generated, decodable local covers. Measures this fixture and optical renderer only, not arbitrary-library throughput or a full regression.`,
  samplePolicy:
    'CSS samples actual DOM. GPU samples a <=640px theme/image proxy excluding DOM text/controls. No page capture or full-frame readback.',
  checks: [],
  errors: [],
  samples: []
};
let app, page, worker, run;
async function check(name, action) {
  const details = await action();
  report.checks.push({ name, details, passed: true });
  console.log('PASS ' + name);
}
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null,
    max: sorted.at(-1) ?? null
  };
};
async function settle() {
  await page.waitForFunction(() => window.albumLiquidGlass?.stats().pending === 0);
  await page.waitForTimeout(180);
}
const stats = () => page.evaluate(() => window.albumLiquidGlass.stats());
async function opticalSamples(selector = '.liquid-glass-canvas') {
  return page.evaluate((selector) => {
    return {
      contexts: window.__glassContexts.length,
      canvases: [...document.querySelectorAll(selector)].map((canvas) => {
        const ctx = canvas.getContext('2d'),
          host = canvas.parentElement,
          style = getComputedStyle(host);
        const pixel = (x, y) => [
          ...ctx.getImageData(
            Math.min(canvas.width - 1, Math.max(0, Math.floor(x))),
            Math.min(canvas.height - 1, Math.max(0, Math.floor(y))),
            1,
            1
          ).data
        ];
        const background = style.backgroundColor;
        const backgroundAlpha =
          background.startsWith('rgba') || background.includes('/')
            ? Number(background.match(/(?:,|\/)\s*([\d.]+)\s*\)$/)?.[1])
            : 1;
        return {
          aria: canvas.getAttribute('aria-hidden'),
          inert: canvas.inert,
          pointer: getComputedStyle(canvas).pointerEvents,
          parent: host.className,
          background,
          backgroundAlpha,
          backdrop: style.backdropFilter,
          contentFilter: style.filter,
          hostOpacity: style.opacity,
          edgeAlpha: pixel(1, canvas.height / 2)[3],
          center: pixel(canvas.width / 2, canvas.height / 2),
          leftQuarter: pixel(canvas.width / 4, canvas.height / 2),
          upperQuarter: pixel(canvas.width / 2, canvas.height / 4)
        };
      })
    };
  }, selector);
}
function wholeSurface(sample) {
  assert.ok(sample.canvases.length > 0, 'Expected a rendered optical surface');
  for (const canvas of sample.canvases) {
    for (const point of ['center', 'leftQuarter', 'upperQuarter']) {
      assert.ok(
        canvas[point][3] >= 25 && canvas[point][3] < 180,
        'Frosted ' +
          point +
          ' must have nonzero translucent GPU coverage: ' +
          JSON.stringify(canvas)
      );
    }
    assert.ok(
      canvas.backgroundAlpha > 0 && canvas.backgroundAlpha < 0.65,
      'Full-face CSS material remains translucent'
    );
    assert.match(canvas.backdrop, /blur\(18px\)/, 'Real DOM blur remains active');
    assert.equal(canvas.contentFilter, 'none', 'The host and its text are not filtered');
    assert.equal(canvas.hostOpacity, '1', 'Do not fade foreground text with material opacity');
  }
}
async function windowDiagnostics() {
  const diagnostics = {};
  try {
    diagnostics.native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window && !window.isDestroyed()
        ? {
            focused: window.isFocused(),
            visible: window.isVisible(),
            minimized: window.isMinimized()
          }
        : { destroyed: true };
    });
  } catch (error) {
    diagnostics.native = { error: error.message };
  }
  try {
    diagnostics.renderer = await page.evaluate(() => ({
      hasFocus: document.hasFocus(),
      hidden: document.hidden,
      visibility: document.visibilityState,
      inactive: window.albumLiquidGlass?.stats().inactive
    }));
  } catch (error) {
    diagnostics.renderer = { error: error.message };
  }
  return diagnostics;
}
(async () => {
  try {
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'liquid_glass',
      new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') + '_' + crypto.randomUUID()
    );
    await fs.mkdir(run, { recursive: true });
    const profile = path.join(run, 'isolated_profile'),
      collection = path.join(run, 'generated_collection');
    await fs.mkdir(collection);
    await fs.mkdir(profile);
    for (let i = 0; i < 30; i++) {
      const folder = path.join(collection, 'Glass_' + String(i).padStart(3, '0'));
      await fs.mkdir(folder);
      await sharp({
        create: {
          width: 260,
          height: 380,
          channels: 3,
          background: { r: 50 + i * 5, g: 60 + (i % 7) * 24, b: 200 - i * 3 }
        }
      })
        .png()
        .toFile(path.join(folder, '01.png'));
    }
    worker = new Worker(path.join(root, 'src', 'library-worker.cjs'), {
      workerData: {
        dataDir: profile,
        watch: false,
        token: '',
        localIndexPath: path.join(run, 'absent_index.sqlite')
      }
    });
    let serial = 0;
    const waiting = new Map();
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Fixture worker ready timeout')), 30000);
      worker.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
        for (const request of waiting.values()) {
          clearTimeout(request.timeout);
          request.reject(error);
        }
        waiting.clear();
      });
      worker.on('message', (message) => {
        if (message.event === 'ready') {
          clearTimeout(timeout);
          resolve();
        }
        const request = waiting.get(message.request);
        if (!request) return;
        clearTimeout(request.timeout);
        waiting.delete(message.request);
        if (message.error) request.reject(new Error(String(message.error)));
        else request.resolve(message.result);
      });
    });
    const call = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++serial;
        const timeout = setTimeout(() => {
          waiting.delete(request);
          reject(new Error('Fixture RPC timeout: ' + method));
        }, 30000);
        waiting.set(request, { resolve, reject, timeout });
        worker.postMessage({ request, method, args });
      });
    await ready;
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['liquidGlass', true],
      ['motionLevel', 'high']
    ])
      await call('settings', { key, value });
    const scanned = await call('scan', { path: collection, onlineMatch: false });
    await call('shutdown');
    await worker.terminate();
    worker = null;
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
    };
    delete env.ELECTRON_RUN_AS_NODE;
    app = await _electron.launch({
      executablePath: executable || require('electron'),
      args: executable ? [] : [root],
      cwd: root,
      env,
      timeout: 30000
    });
    page = await app.firstWindow();
    report.runtime = await app.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      version: app.getVersion(),
      userData: app.getPath('userData')
    }));
    assert.equal(report.runtime.isPackaged, !!executable);
    assert.equal(path.resolve(report.runtime.userData), path.resolve(profile, 'chromium-profile'));
    page.on('pageerror', (error) => report.errors.push(error.message));
    // Observe native contexts before reload; do not replace the renderer, shader,
    // timers, or draw calls. WEBGL_lose_context emits real browser loss events.
    await page.addInitScript(() => {
      window.__glassContexts = [];
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        const context = original.call(this, kind, ...args);
        if (kind === 'webgl2' && context && !window.__glassContexts.includes(context))
          window.__glassContexts.push(context);
        return context;
      };
    });
    await page.reload();
    await page.waitForFunction(
      () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumLiquidGlass
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(async (id) => {
      await navigate({ view: 'library', parent: id });
    }, idFor(collection));
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.cover-shell img')].some(
        (img) => img.complete && img.naturalWidth > 0
      )
    );
    await check(
      'compiled WebGL2 produces real edge pixels and exposes inert decorative canvases',
      async () => {
        await expect.poll(async () => (await stats()).gpu.status).toBe('webgl2');
        await expect.poll(async () => (await stats()).sampledImages).toBeGreaterThan(0);
        await settle();
        const sample = await opticalSamples();
        wholeSurface(sample);
        assert.equal(sample.contexts, 1);
        assert.ok(sample.canvases.length > 0);
        for (const canvas of sample.canvases) {
          assert.equal(canvas.aria, 'true');
          assert.equal(canvas.inert, true);
          assert.equal(canvas.pointer, 'none');
        }
        assert.ok(
          sample.canvases.some((canvas) => canvas.edgeAlpha > 0),
          'Actual shader pixels copied into visible surfaces'
        );
        const actual = await stats();
        assert.ok(actual.gpu.draws > 0 && actual.gpu.uploads > 0);
        report.renderer = actual.gpu.renderer;
        report.hardwareClassification = /swiftshader|llvmpipe|software/i.test(actual.gpu.renderer)
          ? 'software driver; not a hardware GPU claim'
          : 'driver string reported below; no hardware throughput inference';
        return { sample, actual };
      }
    );
    await check(
      'light/dark header, collapsed rail and preference modal have frosted middle pixels with independent text',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.mouse.move(900, 80);
          await page.evaluate(async (theme) => {
            await saveSetting('theme', theme);
            await saveSetting('sidebarMode', 'auto');
            setSidebarOpen(false);
          }, theme);
          await expect(page.locator('#sidebar-shell')).not.toHaveClass(/is-open/);
          await settle();
          const rail = await opticalSamples('#sidebar-shell > .liquid-glass-canvas');
          const header = await opticalSamples(
            '.topbar > [data-liquid-glass-host] > .liquid-glass-canvas'
          );
          wholeSurface(rail);
          wholeSurface(header);
          await page.locator('#settings-button').click();
          await expect(page.locator('#modal')).toBeVisible();
          await expect
            .poll(async () => page.locator('#modal > .liquid-glass-canvas').count())
            .toBe(1);
          await settle();
          const modal = await opticalSamples('#modal > .liquid-glass-canvas');
          wholeSurface(modal);
          await page.screenshot({ path: path.join(run, 'frosted_modal_' + theme + '.png') });
          samples.push({ theme, rail, header, modal });
          await page.evaluate(() => document.querySelector('#modal').close());
          await settle();
        }
        return {
          samples,
          policy:
            'GPU points prove full-face optical coverage, not complete DOM sampling; CSS blur still samples actual DOM behind the text layer.'
        };
      }
    );
    await check(
      'stationary UI stops rendering and pointer updates reuse the dirty-only scene texture',
      async () => {
        // The previous real settings click can leave hover/focus in the auto
        // rail. Establish a manual, closed rail before measuring pointer-only
        // changes so leaving the rail cannot legitimately rebuild geometry.
        await page.mouse.move(900, 80);
        await page.evaluate(async () => {
          await saveSetting('sidebarMode', 'compact');
          if (document.querySelector('#sidebar-shell').contains(document.activeElement))
            document.querySelector('#viewport').focus({ preventScroll: true });
          setSidebarOpen(false);
        });
        await expect(page.locator('#sidebar-shell')).not.toHaveClass(/is-open/);
        await settle();
        const before = await stats();
        await page.waitForTimeout(500);
        const idle = await stats();
        assert.equal(idle.frames, before.frames);
        assert.equal(idle.pending, 0);
        const host = page.locator('.topbar > .brand');
        const box = await host.boundingBox();
        for (let i = 0; i < 12; i++)
          await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * 0.4);
        await settle();
        const pointer = await stats();
        assert.ok(pointer.frames > idle.frames);
        assert.equal(pointer.sceneBuilds, idle.sceneBuilds, 'Pointer changes shader uniforms only');
        assert.ok(
          pointer.gpu.draws - idle.gpu.draws <= (pointer.frames - idle.frames) * 2,
          'Pointer draws only the current and previous hovered surface, not every floating panel'
        );
        return { before, idle, pointer };
      }
    );
    await check(
      'light/dark and normal/4K report bounded CPU submission and optional real GPU timer queries',
      async () => {
        for (const width of [1600, 3840]) {
          await app.evaluate(({ BrowserWindow }, width) => {
            const window = BrowserWindow.getAllWindows()[0];
            if (window.isMaximized()) window.unmaximize();
            window.setContentSize(width, 960);
          }, width);
          for (const theme of ['light', 'dark']) {
            await page.evaluate(async (theme) => {
              await saveSetting('theme', theme);
              window.albumLiquidGlass.refresh();
            }, theme);
            await page.waitForTimeout(200);
            await settle();
            await page.evaluate(() => {
              document.querySelector('#viewport').scrollTop += 120;
            });
            await settle();
            const actual = await stats();
            assert.ok(actual.visibleSurfaces <= 16);
            assert.ok(actual.sceneWidth <= 640 && actual.sceneHeight <= 640);
            const sample = {
              width,
              theme,
              actual,
              cpuFrame: summary(actual.frameCpuMs),
              cpuSubmit: summary(actual.gpu.cpuSubmitMs),
              gpu: summary(actual.gpu.gpuMs),
              gpuTimingAvailable: actual.gpu.gpuMs.length > 0
            };
            report.samples.push(sample);
            await page.screenshot({ path: path.join(run, theme + '_' + width + '.png') });
          }
        }
        return {
          samples: report.samples.length,
          note: 'CPU submission is not GPU time. GPU timer is reported only when the browser exposes non-disjoint query results. No invented FPS or throughput thresholds.'
        };
      }
    );
    await check(
      'native context loss falls back without a recreate loop and restores once',
      async () => {
        const supported = await page.evaluate(() => {
          const extension = __glassContexts[0].getExtension('WEBGL_lose_context');
          if (!extension) return false;
          window.__glassLoss = extension;
          extension.loseContext();
          return true;
        });
        if (!supported)
          return {
            skipped: true,
            reason: 'Browser does not expose WEBGL_lose_context; unit loss/restore coverage only.'
          };
        await expect.poll(async () => (await stats()).gpu.status).toBe('context-lost');
        const lost = await stats();
        await page.waitForTimeout(350);
        assert.equal((await stats()).frames, lost.frames);
        assert.equal(await page.evaluate(() => __glassContexts.length), 1);
        await page.evaluate(() => __glassLoss.restoreContext());
        await expect.poll(async () => (await stats()).gpu.status).toBe('webgl2');
        await expect.poll(async () => (await stats()).sampledImages).toBeGreaterThan(0);
        await settle();
        const restored = await stats();
        assert.equal(restored.gpu.contextLosses, 1);
        assert.equal(restored.gpu.restores, 1);
        return { lost, restored };
      }
    );
    await check(
      'off and hidden window stop work; low/reduced avoid pointer rendering; circular transitions remain',
      async () => {
        await page.evaluate(async () => saveSetting('motionLevel', 'low'));
        await page.waitForTimeout(250);
        await settle();
        const before = await stats();
        const box = await page.locator('.topbar > .brand').boundingBox();
        await page.mouse.move(box.x + 10, box.y + 10);
        await page.mouse.move(box.x + 25, box.y + 15);
        await settle();
        assert.equal((await stats()).frames, before.frames);
        await page.evaluate(async () => saveSetting('motionLevel', 'high'));
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.waitForTimeout(250);
        await settle();
        const reduced = await stats();
        await page.mouse.move(box.x + 30, box.y + 20);
        await settle();
        assert.equal((await stats()).frames, reduced.frames);
        await page.evaluate(async () => saveSetting('liquidGlass', false));
        await settle();
        const off = await stats();
        await page.waitForTimeout(350);
        assert.equal((await stats()).frames, off.frames);
        assert.equal(await page.locator('.liquid-glass-canvas').count(), 0);
        await page.evaluate(async () => saveSetting('liquidGlass', true));
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await page.waitForTimeout(250);
        await settle();
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
        await page.waitForTimeout(300);
        const hidden = await stats();
        await page.waitForTimeout(400);
        assert.equal((await stats()).frames, hidden.frames);
        report.windowDiagnostics = { hidden: await windowDiagnostics() };
        await app.evaluate(({ BrowserWindow }) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.show();
          window.focus();
          window.webContents.focus();
        });
        await page.bringToFront();
        report.windowDiagnostics.shown = await windowDiagnostics();
        await expect.poll(async () => (await stats()).hidden).toBe(false);
        await expect.poll(async () => (await stats()).inactive).toBe(false);
        await settle();
        const transitions = await page.evaluate(async () => {
          const original = document.documentElement.animate;
          const clips = [];
          document.documentElement.animate = function (keyframes, options) {
            if (options?.pseudoElement === '::view-transition-new(root)')
              clips.push(keyframes.clipPath);
            return original.call(this, keyframes, options);
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
        assert.equal(transitions.length, 2);
        for (const clip of transitions) assert.ok(clip[0].startsWith('circle(0px'));
        return { off, hidden, transitions };
      }
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
    report.generatedScan = scanned;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    process.exitCode = 1;
    console.error(error);
  } finally {
    if (app) {
      report.windowDiagnostics ||= {};
      report.windowDiagnostics.final = await windowDiagnostics();
    }
    if (worker) await worker.terminate();
    if (app) await app.close();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
