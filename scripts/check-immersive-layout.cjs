'use strict';
// Serial GUI verification for the lead. Every image and profile is generated under physical artifacts.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = { checks: [], errors: [], screenshots: [], geometry: [], pixels: [] };
let app, page, run, profile, collection;
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
async function seed() {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite')
    }
  });
  const pending = new Map();
  let serial = 0;
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const entry = pending.get(message.request);
        if (!entry) return;
        pending.delete(message.request);
        clearTimeout(entry.timer);
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      });
    });
    const call = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++serial;
        const timer = setTimeout(() => reject(new Error('Fixture RPC timeout: ' + method)), 30000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    await call('scan', { path: collection, onlineMatch: false, directoryKind: 'photo' });
    await call('shutdown');
  } finally {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    await worker.terminate();
  }
}
async function launch() {
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
  await app.context().route(/^https?:\/\//, async (route) => {
    report.errors.push('Unexpected HTTP: ' + route.request().url());
    await route.abort();
  });
  await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const actual = await app.evaluate(({ app }) => ({
    data: app.getPath('userData'),
    version: app.getVersion(),
    isPackaged: app.isPackaged
  }));
  assert.equal(path.resolve(actual.data), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: executable || require('electron'), ...actual };
}
async function settle() {
  await page.waitForFunction(
    () => grid.loading.size === 0 && grid.cards.size > 0 && displayChangeTask === null
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function geometry() {
  return page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        width: r.width,
        height: r.height
      };
    };
    const viewport = $('#viewport');
    return {
      viewport: rect(viewport),
      header: rect($('.topbar')),
      toolbar: rect($('#toolbar')),
      controls: rect($('#toolbar .toolbar-right')),
      heading: rect($('#page-heading')),
      first: rect(grid.cards.get(0)),
      scrollMax: viewport.scrollHeight - viewport.clientHeight,
      overflow: getComputedStyle(viewport).overflowY,
      mask: getComputedStyle(viewport).maskImage,
      width: grid.width,
      cols: grid.cols
    };
  });
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
  return file;
}
async function pixelProof(name) {
  const sample = await page.evaluate(() => {
    const viewport = $('#viewport'),
      origin =
        $('#virtual-grid').getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
    // Put the second-row image well above the sample, beyond the antialiased top edge.
    const index = grid.cols,
      p = grid.getPosition(index);
    viewport.scrollTop = origin + p.top + 14;
    grid.render();
    return { index, y: Math.ceil(viewport.getBoundingClientRect().top + 4) };
  });
  await settle();
  await page.waitForFunction((index) => {
    const img = grid.cards.get(index)?.querySelector('img');
    return img?.complete && img.naturalWidth > 0;
  }, sample.index);
  await page.evaluate(({ index, y }) => {
    const viewport = $('#viewport'),
      image = grid.cards.get(index).querySelector('img');
    viewport.scrollTop += image.getBoundingClientRect().top - (y - 16);
    grid.render();
  }, sample);
  await settle();
  const point = await page.evaluate(({ index, y }) => {
    const card = grid.cards.get(index),
      image = card.querySelector('img'),
      r = image.getBoundingClientRect(),
      x = Math.floor(r.left + r.width / 2);
    return {
      x,
      y,
      imageTop: r.top,
      imageBottom: r.bottom,
      insideImage: y - r.top,
      viewportTop: $('#viewport').getBoundingClientRect().top,
      headerTop: $('.topbar').getBoundingClientRect().top,
      hit: document.elementFromPoint(x, y)?.closest('.album-card')?.dataset.id === card.dataset.id
    };
  }, sample);
  assert.ok(point.y < point.headerTop && point.y >= point.viewportTop, JSON.stringify(point));
  assert.ok(point.insideImage >= 12 && point.y < point.imageBottom, JSON.stringify(point));
  assert.equal(point.hit, true, 'real image/card is hit-testable above the floating header');
  const visible = await page.screenshot({ scale: 'css' });
  await page.evaluate((index) => (grid.cards.get(index).style.visibility = 'hidden'), sample.index);
  let hidden;
  try {
    hidden = await page.screenshot({ scale: 'css' });
  } finally {
    await page.evaluate((index) => (grid.cards.get(index).style.visibility = ''), sample.index);
  }
  const rgb = async (buffer) => [
    ...(await sharp(buffer)
      .extract({ left: point.x, top: point.y, width: 1, height: 1 })
      .removeAlpha()
      .raw()
      .toBuffer())
  ];
  const foreground = await rgb(visible),
    background = await rgb(hidden);
  assert.ok(
    Math.hypot(...foreground.map((value, index) => value - background[index])) > 20,
    JSON.stringify({ foreground, background, point })
  );
  report.pixels.push({ name, ...point, foreground, background });
  await fs.writeFile(path.join(run, name + '-scrolled.png'), visible);
  report.screenshots.push(path.join(run, name + '-scrolled.png'));
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'immersive-layout',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    collection = path.join(run, 'generated-collection');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(collection, { recursive: true });
    const image = await sharp({
      create: { width: 64, height: 96, channels: 3, background: '#165ca3' }
    })
      .png()
      .toBuffer();
    for (let index = 0; index < 280; index++)
      await fs.writeFile(
        path.join(collection, `Generated image ${String(index).padStart(3, '0')}.png`),
        image,
        { flag: 'wx' }
      );
    await seed();
    await launch();
    await page.evaluate((parent) => navigate({ parent }), idFor(collection));
    await settle();
    await check(
      'initial heading/cards stay in place while the scroll viewport reaches above floating components',
      async () => {
        for (const width of [980, 1600, 3840])
          for (const mode of ['compact', 'expanded']) {
            const height = width === 3840 ? 2160 : 1000;
            await app.evaluate(
              ({ BrowserWindow }, { width, height }) => {
                const win = BrowserWindow.getAllWindows()[0];
                if (win.isMaximized()) win.unmaximize();
                win.setContentSize(width, height);
              },
              { width, height }
            );
            await page.waitForFunction((width) => innerWidth === width, width);
            await page.evaluate(async (mode) => {
              await saveSetting('sidebarMode', mode);
              setSidebarOpen(mode === 'expanded');
              await changeDisplaySetting('density', 186);
              $('#viewport').scrollTop = 0;
              grid.render();
            }, mode);
            await settle();
            // Compare with the precise former external72/internal4 arrangement in this same fixture.
            await page.evaluate(() => {
              const style = document.createElement('style');
              style.id = 'generated-legacy-layout';
              style.textContent =
                'main{padding-top:72px!important}#viewport{padding-top:4px!important}#toolbar{top:0!important}';
              document.head.append(style);
              grid.render();
            });
            await settle();
            const legacy = await geometry();
            await page.evaluate(() => {
              $('#generated-legacy-layout').remove();
              $('#viewport').scrollTop = 0;
              grid.render();
            });
            await settle();
            const current = await geometry();
            for (const item of ['heading', 'first', 'toolbar', 'controls'])
              assert.ok(
                Math.abs(current[item].top - legacy[item].top) <= 1,
                `${width}/${mode} ${item} start drift`
              );
            assert.ok(Math.abs(current.viewport.top + 72 - legacy.viewport.top) <= 1);
            assert.ok(current.viewport.top < current.header.top);
            assert.equal(current.overflow, 'auto');
            assert.equal(current.mask, 'none');
            assert.ok(
              Math.abs(current.scrollMax - legacy.scrollMax) <= 2,
              'scroll extent is preserved'
            );
            report.geometry.push({ width, mode, legacy, current });
            await screenshot(`${width}-${mode}-initial`);
            await pixelProof(`${width}-${mode}`);
          }
      }
    );
    await check(
      'visible card anchors and actual-column thumbnail tiers survive size changes behind the header',
      async () => {
        await page.evaluate(async () => {
          Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
          await changeDisplaySetting('density', 158);
          $('#viewport').scrollTop = 1800;
          grid.render();
        });
        await settle();
        const anchor = await page.evaluate(() => captureDisplayAnchor());
        assert.equal(anchor.kind, 'grid');
        await page.evaluate(() => changeDisplaySetting('density', 222));
        await settle();
        const result = await page.evaluate((anchor) => {
          const card = grid.cards.get(anchor.index),
            image = card?.querySelector('img'),
            p = grid.getPosition(anchor.index),
            desired = p.width * devicePixelRatio * 1.3,
            tier = desired <= 512 ? 512 : desired <= 768 ? 768 : 1024;
          return {
            offset: card?.getBoundingClientRect().top - $('#viewport').getBoundingClientRect().top,
            src: image?.getAttribute('src'),
            tier,
            count: grid.cards.size,
            total: grid.total
          };
        }, anchor);
        assert.ok(Math.abs(result.offset - anchor.offset) <= 2, JSON.stringify({ anchor, result }));
        assert.ok(result.src.includes('size=' + result.tier));
        assert.ok(result.count < result.total);
        report.anchor = { index: anchor.index, before: anchor.offset, ...result };
        await page.evaluate(() => {
          delete window.devicePixelRatio;
        });
      }
    );
    await expect(page.locator('.topbar')).toBeVisible();
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    console.error(error.stack);
    process.exitCode = 1;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    if (app) await app.close().catch(() => {});
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    }
  }
})();
