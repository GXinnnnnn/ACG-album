'use strict';
// Source-only live import. Originals are read-only; all outputs/profile stay in artifacts.
const { _electron } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { idFor, IMAGE_EXT } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const run = path.join(
  root,
  'artifacts/live-import',
  new Date().toISOString().replace(/[:.]/g, '-')
);
const synthetic = process.argv.includes('--synthetic');
const source = synthetic
  ? path.join(run, 'synthetic-source')
  : path.join(require('./distribution-paths.cjs').workspaceRoot, '游戏图片');
const profile = path.join(run, 'profile');
const report = {
  source: synthetic
    ? 'generated isolated 12000-image scale fixture'
    : 'existing read-only game-image library',
  run,
  checks: [],
  errors: [],
  screenshots: []
};
let app,
  page,
  stage = 'setup';
const rounded = (n) => +n.toFixed(1);
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] ||
  0;
async function manifest() {
  const rows = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        rows.push([path.relative(source, file), stat.size, stat.mtimeMs]);
      }
    }
  }
  await visit(source);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    files: rows.length,
    bytes: rows.reduce((n, row) => n + row[1], 0),
    stamp: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
  };
}
async function check(name, action) {
  stage = name;
  const start = performance.now();
  const details = await action();
  report.checks.push({
    name,
    status: 'passed',
    ms: rounded(performance.now() - start),
    ...(details ? { details } : {})
  });
  console.log('PASS ' + name);
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  const selectors = [
    '#sidebar-shell',
    '.card-info',
    '#breadcrumbs',
    '#page-title',
    '#page-description',
    '#footer-location',
    '#progress-title',
    '#progress-path',
    '#viewer-name',
    '#viewer-path',
    '#toast-region',
    '.card-title'
  ];
  const bounds = await page.evaluate(
    (selectors) =>
      selectors
        .flatMap((selector) =>
          [...document.querySelectorAll(selector)].map((element) => {
            const viewerOpen = document.querySelector('#viewer')?.open;
            if (viewerOpen && !element.closest('#viewer') && selector !== '#toast-region')
              return { visible: false };
            const r = element.getBoundingClientRect();
            return {
              x: Math.max(0, Math.floor(r.x) - 3),
              y: Math.max(0, Math.floor(r.y) - 3),
              width: Math.ceil(r.width) + 6,
              height: Math.ceil(r.height) + 6,
              visible: r.width > 0 && r.height > 0
            };
          })
        )
        .filter((r) => r.visible),
    selectors
  );
  const buffer = await page.screenshot({ scale: 'css' });
  const sharp = require('sharp');
  const size = await sharp(buffer).metadata();
  const overlay = Buffer.from(
    `<svg width="${size.width}" height="${size.height}">${bounds.map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="#32343b"/>`).join('')}</svg>`
  );
  await sharp(buffer)
    .composite([{ input: overlay }])
    .png()
    .toFile(file);
  report.screenshots.push(file);
}
(async () => {
  assert.equal(path.dirname(path.dirname(run)), path.join(root, 'artifacts'));
  assert.equal(path.dirname(profile), run);
  await fs.mkdir(profile, { recursive: true });
  if (synthetic) {
    assert.equal(path.dirname(source), run);
    const png = await require('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#d36ca6' }
    })
      .png()
      .toBuffer();
    for (let folder = 0; folder < 120; folder++) {
      const directory = path.join(source, 'album-' + String(folder).padStart(3, '0'));
      await fs.mkdir(directory, { recursive: true });
      await Promise.all(
        Array.from({ length: 100 }, (_, image) =>
          fs.writeFile(
            path.join(directory, 'image-' + String(image).padStart(3, '0') + '.png'),
            png
          )
        )
      );
    }
  }
  const before = await manifest();
  assert.ok(before.files > 0, 'The existing read-only source must contain files.');
  try {
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
    page.setDefaultTimeout(20000);
    page.on('pageerror', (error) => report.errors.push({ stage, message: error.message }));
    await page.waitForFunction(() => typeof S !== 'undefined' && S.settings.nickname !== undefined);
    await app.evaluate(
      ({ app, BrowserWindow, dialog }, { source, profile }) => {
        if (app.getPath('userData') !== profile + '\\chromium-profile')
          throw new Error('Profile isolation failed');
        const win = BrowserWindow.getAllWindows()[0];
        if (win.isMaximized()) win.unmaximize();
        win.setContentSize(1440, 960);
        win.webContents.setBackgroundThrottling(false);
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] });
      },
      { source, profile }
    );
    await page.evaluate(async () => {
      await saveSetting('autoMatch', false);
      await saveSetting('watchChanges', false);
      await saveSetting('sidebarMode', 'compact');
    });
    // Exercise the real import button and options before sampling. The measured interval
    // starts at confirmation, excluding time spent opening or reviewing this dialog.
    await page.locator('#import-sidebar').click();
    await page.locator('#import-options').waitFor({ state: 'visible' });
    await page.locator('#import-online-match').uncheck();
    assert.equal(await page.locator('#import-online-match').isChecked(), false);
    await page.evaluate(() => {
      window.__live = {
        started: performance.now(),
        events: [],
        samples: [],
        gaps: [],
        errors: [],
        ticks: 0,
        stop: false,
        chosen: null,
        violations: 0
      };
      let last = performance.now();
      window.__live.timer = setInterval(() => {
        const now = performance.now();
        __live.gaps.push(now - last);
        __live.ticks++;
        last = now;
      }, 50);
      window.addEventListener('unhandledrejection', (event) =>
        __live.errors.push(String(event.reason?.message || event.reason))
      );
      window.__live.unsubscribe = window.album.onEvent((event) => {
        if (event.type !== 'progress') return;
        const p = event.data;
        __live.events.push({
          ms: performance.now() - __live.started,
          active: p.active,
          images: p.images || 0,
          folders: p.folders || 0,
          viewer: $('#viewer').open,
          rootOpen: S.parent === p.root
        });
        if (
          __live.chosen &&
          ($('#viewer').open !== true ||
            V.node?.id !== __live.chosen.id ||
            S.parent !== __live.chosen.parent ||
            S.filter !== 'images')
        )
          __live.violations++;
      });
      window.__live.queryTask = (async () => {
        while (!__live.stop) {
          for (const method of ['init', 'list', 'get', 'ancestors']) {
            const start = performance.now();
            const active = scanActive;
            const args =
              method === 'list'
                ? { parent: S.parent, limit: 5, filter: 'images' }
                : { id: S.parent };
            await api(method, args);
            __live.samples.push({ method, ms: performance.now() - start, active });
          }
          // Four RPCs per cycle, with a bounded pause short enough to observe small real imports.
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      })();
    });
    const rootId = idFor(source);
    await check(
      'actual import click shows active progress and enters root before completion',
      async () => {
        await page.evaluate(() => {
          __live.started = performance.now();
          __live.gaps.length = 0;
          __live.ticks = 0;
        });
        await page.locator('#import-options-confirm').click();
        await page.waitForFunction(
          (id) => scanActive && S.parent === id && !$('#progress-panel').hidden,
          rootId,
          { timeout: 120000 }
        );
        const state = await page.evaluate(() => ({
          active: scanActive,
          indeterminate: !$('#progress-bar').parentElement.hasAttribute('aria-valuenow'),
          loaded: grid.total,
          elapsed: performance.now() - __live.started
        }));
        assert.equal(state.indeterminate, true);
        if (synthetic) await screenshot('root-during-scan');
        return { ...state, elapsed: rounded(state.elapsed) };
      }
    );
    await check(
      'loaded content opens and viewer choice survives later progress and completion',
      async () => {
        const deadline = Date.now() + 180000;
        let selected;
        while (Date.now() < deadline) {
          const result = await page.evaluate(() =>
            api('list', { filter: 'images', sort: 'size', direction: 'asc', limit: 60 })
          );
          for (const node of result.items) {
            if (
              !IMAGE_EXT.has(path.extname(node.name).toLowerCase()) ||
              node.bytes < 100 ||
              node.bytes > 2 * 1024 * 1024
            )
              continue;
            try {
              const dimensions = await require('sharp')(node.path).metadata();
              if (
                dimensions.width &&
                dimensions.height &&
                dimensions.width * dimensions.height <= 12_000_000
              ) {
                selected = node;
                break;
              }
            } catch {}
          }
          if (selected) break;
          assert.equal(
            await page.evaluate(() => scanActive),
            true,
            'Scan finished before a usable image could be selected'
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        assert.ok(selected, 'A small valid image must be indexed while scanning');
        const sampleHash = crypto
          .createHash('sha256')
          .update(await fs.readFile(selected.path))
          .digest('hex');
        await page.evaluate(async (node) => {
          if (!scanActive) throw new Error('Scan must still be active for navigation evidence');
          await navigate({ parent: node.parent, filter: 'images' });
          await openViewer(node);
        }, selected);
        await page.waitForFunction(
          () =>
            scanActive &&
            $('#viewer').open &&
            $('#viewer-image').naturalWidth > 0 &&
            !$('#viewer-image').hidden
        );
        const chosenAt = await page.evaluate(() => {
          __live.chosen = {
            id: V.node.id,
            parent: S.parent,
            eventCount: __live.events.filter((p) => p.active).length
          };
          return {
            eventCount: __live.chosen.eventCount,
            dimensions: {
              width: $('#viewer-image').naturalWidth,
              height: $('#viewer-image').naturalHeight
            },
            elapsed: performance.now() - __live.started
          };
        });
        await screenshot('viewer-during-scan');
        await page.waitForFunction(
          (minimum) =>
            __live.events.filter((p) => p.active).length >= __live.chosen.eventCount + minimum,
          synthetic ? 2 : 0,
          { timeout: 120000 }
        );
        await page.waitForFunction(
          () => !scanActive && pendingImport === null && __live.events.some((p) => !p.active),
          null,
          { timeout: 600000 }
        );
        const preserved = await page.evaluate(() => ({
          open: $('#viewer').open,
          sameImage: V.node.id === __live.chosen.id,
          sameParent: S.parent === __live.chosen.parent,
          sameFilter: S.filter === 'images',
          violations: __live.violations,
          activeEventsAfterChoice:
            __live.events.filter((p) => p.active).length - __live.chosen.eventCount
        }));
        assert.deepEqual(
          {
            open: preserved.open,
            sameImage: preserved.sameImage,
            sameParent: preserved.sameParent,
            sameFilter: preserved.sameFilter,
            violations: preserved.violations
          },
          { open: true, sameImage: true, sameParent: true, sameFilter: true, violations: 0 }
        );
        assert.equal(
          crypto
            .createHash('sha256')
            .update(await fs.readFile(selected.path))
            .digest('hex'),
          sampleHash
        );
        await screenshot('viewer-after-completion');
        return {
          chosenAt: { ...chosenAt, elapsed: rounded(chosenAt.elapsed) },
          ...preserved,
          sampleOriginalSha256Unchanged: true
        };
      }
    );
    await check(
      'renderer heartbeat and all four query types stay responsive during the scan',
      async () => {
        const data = await page.evaluate(async () => {
          __live.stop = true;
          await __live.queryTask;
          clearInterval(__live.timer);
          __live.unsubscribe();
          return {
            events: __live.events,
            samples: __live.samples,
            gaps: __live.gaps,
            ticks: __live.ticks,
            errors: __live.errors,
            completeMs: __live.events.find((p) => !p.active)?.ms
          };
        });
        report.progress = data.events;
        report.importMs = rounded(data.completeMs);
        report.heartbeat = {
          ticks: data.ticks,
          intervalMs: 50,
          p95Ms: rounded(percentile(data.gaps, 0.95)),
          maxMs: rounded(Math.max(...data.gaps))
        };
        report.queries = Object.fromEntries(
          ['init', 'list', 'get', 'ancestors'].map((method) => {
            const samples = data.samples
              .filter((s) => s.method === method && s.active)
              .map((s) => s.ms);
            assert.ok(samples.length >= 2, method + ' requires live samples');
            assert.ok(Math.max(...samples) < 5000, method + ' stalled');
            return [
              method,
              {
                count: samples.length,
                p95Ms: rounded(percentile(samples, 0.95)),
                maxMs: rounded(Math.max(...samples))
              }
            ];
          })
        );
        assert.ok(report.heartbeat.maxMs < 2000, 'Renderer heartbeat stalled for two seconds');
        assert.deepEqual(data.errors, []);
        assert.deepEqual(report.errors, []);
        const init = await page.evaluate(() => api('init'));
        report.indexed = {
          images: init.stats.images,
          folders: init.stats.folders,
          roots: init.roots.length
        };
        return { heartbeat: report.heartbeat, queries: report.queries, indexed: report.indexed };
      }
    );
    await check(
      'read-only original tree sizes and modification times remain unchanged',
      async () => {
        const after = await manifest();
        assert.deepEqual(after, before);
        report.sourceSafety = {
          files: after.files,
          bytes: after.bytes,
          treeSizeAndMtimeStampUnchanged: true,
          sampledImageHashUnchanged: true
        };
        return report.sourceSafety;
      }
    );
  } catch (error) {
    report.failure = { stage, message: error.message, stack: error.stack };
    report.checks.push({ name: stage, status: 'failed' });
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (!report.sourceSafety) {
      const after = await manifest();
      report.sourceSafety = {
        files: after.files,
        bytes: after.bytes,
        treeSizeAndMtimeStampUnchanged: JSON.stringify(after) === JSON.stringify(before)
      };
      if (!report.sourceSafety.treeSizeAndMtimeStampUnchanged) process.exitCode = 1;
    }
    if (page && !page.isClosed())
      await page
        .evaluate(() => {
          if (window.__live) {
            __live.stop = true;
            clearInterval(__live.timer);
            __live.unsubscribe?.();
          }
          if (typeof scanActive !== 'undefined' && scanActive) return api('cancel');
        })
        .catch(() => {});
    if (app) {
      const start = performance.now();
      await app.close();
      report.shutdownMs = rounded(performance.now() - start);
    }
    report.passed = report.checks.filter((c) => c.status === 'passed').length;
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      'RESULT ' +
        JSON.stringify({
          run,
          passed: report.passed,
          failure: report.failure,
          importMs: report.importMs,
          indexed: report.indexed,
          heartbeat: report.heartbeat,
          queries: report.queries
        })
    );
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
