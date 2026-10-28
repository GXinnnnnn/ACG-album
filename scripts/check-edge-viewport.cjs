'use strict';
// Lead-only serial GUI run. Every source image and profile is generated under physical artifacts.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = { checks: [], geometry: [], pixels: [], screenshots: [], errors: [] };
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
      localIndexPath: path.join(run, 'absent_index.sqlite')
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
        const request = ++serial,
          timer = setTimeout(() => reject(new Error('Fixture RPC timeout: ' + method)), 30000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    await call('scan', { path: collection, directoryKind: 'photo', onlineMatch: false });
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
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent_index.sqlite')
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
  page.setDefaultTimeout(20000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await app.context().route(/^https?:\/\//, async (route) => {
    report.errors.push('Unexpected renderer HTTP: ' + route.request().url());
    await route.abort();
  });
  const runtime = await app.evaluate(({ app, BrowserWindow, net, session }) => {
    globalThis.__edgeBlockedHttp = [];
    const original = net.fetch.bind(net);
    net.fetch = (input, ...options) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https?:\/\//i.test(url)) {
        globalThis.__edgeBlockedHttp.push(url);
        return Promise.reject(new Error('Public HTTP blocked'));
      }
      return original(input, ...options);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        globalThis.__edgeBlockedHttp.push(details.url);
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.show();
    return {
      userData: app.getPath('userData'),
      version: app.getVersion(),
      isPackaged: app.isPackaged
    };
  });
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: executable || require('electron'), ...runtime };
  await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate((parent) => navigate({ parent }), idFor(collection));
  await settle();
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
    return {
      viewport: rect($('#viewport')),
      heading: rect($('#page-heading')),
      first: rect(grid.cards.get(0)),
      controls: rect($('#toolbar .toolbar-right')),
      titlebar: rect($('.titlebar')),
      footer: rect($('.statusbar')),
      scrollMax: $('#viewport').scrollHeight - $('#viewport').clientHeight,
      overflow: getComputedStyle($('#viewport')).overflowY,
      mask: getComputedStyle($('#viewport')).maskImage,
      columns: grid.cols,
      width: grid.width,
      height: innerHeight
    };
  });
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  const buffer = await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
  return buffer;
}
async function pixelProof(edge, name) {
  const sample = await page.evaluate((edge) => {
    const viewport = $('#viewport'),
      origin =
        $('#virtual-grid').getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop;
    const index = edge === 'top' ? grid.cols * 2 : grid.total - grid.cols;
    const y = edge === 'top' ? 1 : innerHeight - 2;
    viewport.scrollTop = Math.max(0, origin + grid.getPosition(index).top - y + 20);
    grid.render();
    return { index, y };
  }, edge);
  await settle();
  // Loading an unseen page replaces estimated row heights and retains the old
  // visible anchor. Re-align the chosen row as geometry settles, rather than
  // waiting for an image whose card may have moved outside the virtual window.
  await page.waitForFunction(({ index, y }) => {
    const viewport = $('#viewport'),
      origin =
        $('#virtual-grid').getBoundingClientRect().top -
        viewport.getBoundingClientRect().top +
        viewport.scrollTop,
      image = grid.cards.get(index)?.querySelector('img'),
      top = image
        ? image.getBoundingClientRect().top
        : viewport.getBoundingClientRect().top +
          origin +
          grid.getPosition(index).top -
          viewport.scrollTop,
      correction = top - (y - 20);
    if (Math.abs(correction) > 0.75) {
      viewport.scrollTop += correction;
      grid.render();
      return false;
    }
    return grid.items.has(index) && image?.complete && image.naturalWidth > 0;
  }, sample);
  await page.evaluate(({ index, y }) => {
    const viewport = $('#viewport');
    viewport.scrollTop +=
      grid.cards.get(index).querySelector('img').getBoundingClientRect().top - (y - 20);
    grid.render();
  }, sample);
  await settle();
  const point = await page.evaluate(({ index, y }) => {
    const card = grid.cards.get(index),
      image = card.querySelector('img'),
      r = image.getBoundingClientRect(),
      x = Math.floor(r.left + r.width / 2),
      viewport = $('#viewport').getBoundingClientRect();
    return {
      x,
      y,
      imageTop: r.top,
      imageBottom: r.bottom,
      inside: y - r.top,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
      underChrome: document
        .elementsFromPoint(x, y)
        .some((element) => element.closest('.album-card')?.dataset.id === card.dataset.id),
      chrome: document.elementFromPoint(x, y)?.className
    };
  }, sample);
  assert.ok(point.inside >= 12 && point.y < point.imageBottom, JSON.stringify(point));
  assert.equal(point.viewportTop, 0);
  assert.equal(point.viewportBottom, await page.evaluate(() => innerHeight));
  assert.equal(point.underChrome, true, JSON.stringify(point));
  const visible = await screenshot(name + '_' + edge);
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
  const difference = Math.hypot(...foreground.map((value, index) => value - background[index]));
  assert.ok(difference > 20, JSON.stringify({ point, foreground, background, difference }));
  report.pixels.push({ name, edge, ...point, foreground, background, difference });
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const base = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      base,
      'edge_viewport',
      new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
        '_' +
        crypto.randomUUID().replace(/-/g, '_')
    );
    profile = path.join(run, 'generated_profile');
    collection = path.join(run, 'generated_collection');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(collection, { recursive: true });
    const image = await sharp({
      create: { width: 64, height: 96, channels: 3, background: '#165ca3' }
    })
      .png()
      .toBuffer();
    for (let index = 0; index < 280; index++)
      await fs.writeFile(
        path.join(collection, `image_${String(index).padStart(3, '0')}.png`),
        image,
        { flag: 'wx' }
      );
    await seed();
    await launch();
    await check(
      'full-window viewport preserves first-screen positions and old scroll range at narrow and 4K widths',
      async () => {
        for (const width of [980, 1600, 3840])
          for (const mode of ['compact', 'expanded']) {
            const height = width === 3840 ? 2160 : 1000;
            await app.evaluate(
              ({ BrowserWindow }, size) =>
                BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height),
              { width, height }
            );
            await page.waitForFunction(
              (size) => innerWidth === size.width && innerHeight === size.height,
              { width, height }
            );
            await page.mouse.move(width - 200, 80);
            await page.evaluate(async (mode) => {
              await saveSetting('sidebarMode', mode);
              setSidebarOpen(mode === 'expanded');
              await changeDisplaySetting('density', 186);
              $('#viewport').scrollTop = 0;
              grid.render();
            }, mode);
            await settle();
            await page.evaluate(() => {
              const style = document.createElement('style');
              style.id = 'generated_previous_viewport';
              style.textContent =
                '.titlebar{position:static!important}.app-shell{height:calc(100vh - 28px)!important}main{position:static!important}#viewport{padding-top:76px!important;padding-bottom:0!important}main>.statusbar{position:static!important}';
              document.head.append(style);
              $('#viewport').scrollTop = 0;
              grid.render();
            });
            await settle();
            const previous = await geometry();
            await page.evaluate(() => {
              $('#generated_previous_viewport').remove();
              $('#viewport').scrollTop = 0;
              grid.render();
            });
            await settle();
            const current = await geometry();
            for (const name of ['heading', 'first', 'controls']) {
              assert.ok(
                Math.abs(current[name].top - previous[name].top) <= 1,
                name + ' first-screen top'
              );
              assert.ok(
                Math.abs(current[name].left - previous[name].left) <= 1,
                name + ' first-screen left'
              );
            }
            assert.equal(current.viewport.top, 0);
            assert.equal(current.viewport.bottom, height);
            assert.equal(previous.viewport.top, 28);
            assert.equal(previous.viewport.bottom, height - 28);
            assert.ok(
              Math.abs(current.scrollMax - previous.scrollMax) <= 2,
              JSON.stringify({ current, previous })
            );
            assert.equal(current.overflow, 'auto');
            assert.equal(current.mask, 'none');
            assert.equal(current.columns, previous.columns);
            assert.ok(Math.abs(current.width - previous.width) < 0.1);
            report.geometry.push({ width, mode, previous, current });
            await screenshot(`${width}_${mode}_initial`);
            await pixelProof('top', `${width}_${mode}`);
            await pixelProof('bottom', `${width}_${mode}`);
          }
      }
    );
    await check(
      'transparent titlebar preserves drag and live window controls; footer never captures content clicks',
      async () => {
        const chrome = await page.evaluate(() => {
          const bar = $('.titlebar'),
            style = getComputedStyle(bar),
            button = document.querySelector('[data-window="minimize"]'),
            r = button.getBoundingClientRect();
          return {
            background: style.backgroundColor,
            drag: style.getPropertyValue('-webkit-app-region'),
            height: bar.getBoundingClientRect().height,
            controlHit: document
              .elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
              ?.closest('[data-window]')?.dataset.window,
            footerPointer: getComputedStyle($('.statusbar')).pointerEvents
          };
        });
        assert.equal(chrome.background, 'rgba(0, 0, 0, 0)');
        assert.equal(chrome.drag, 'drag');
        assert.equal(chrome.height, 28);
        assert.equal(chrome.controlHit, 'minimize');
        assert.equal(chrome.footerPointer, 'none');
        await page.locator('[data-window="minimize"]').click();
        await expect
          .poll(() =>
            app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())
          )
          .toBe(true);
        await app.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.restore();
          win.show();
          win.focus();
        });
        await page.locator('.filter-tabs button[data-filter="images"]').click();
        await page.waitForFunction(() => S.filter === 'images' && grid.total === 280);
        await settle();
        report.chrome = chrome;
      }
    );
    await check(
      'edge viewport retains virtual anchors and correct fitted thumbnail tiers at two DPRs',
      async () => {
        for (const dpr of [1, 2]) {
          await page.evaluate(async (dpr) => {
            Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr });
            await changeDisplaySetting('density', 158);
            $('#viewport').scrollTop = 1800;
            grid.render();
          }, dpr);
          await settle();
          const anchor = await page.evaluate(() => captureDisplayAnchor());
          assert.equal(anchor.kind, 'grid');
          await page.evaluate(() => changeDisplaySetting('density', 222));
          await settle();
          const value = await page.evaluate((anchor) => {
            const card = grid.cards.get(anchor.index),
              p = grid.getPosition(anchor.index),
              desired = p.width * devicePixelRatio * 1.3;
            return {
              offset: card.getBoundingClientRect().top - $('#viewport').getBoundingClientRect().top,
              src: card.querySelector('img').getAttribute('src'),
              tier: desired <= 512 ? 512 : desired <= 768 ? 768 : 1024,
              mounted: grid.cards.size,
              total: grid.total
            };
          }, anchor);
          assert.ok(Math.abs(value.offset - anchor.offset) <= 2, JSON.stringify({ value, anchor }));
          assert.ok(value.src.includes('size=' + value.tier));
          assert.ok(value.mounted < value.total);
        }
        await page.evaluate(() => {
          delete window.devicePixelRatio;
        });
      }
    );
    assert.deepEqual(report.errors, []);
    assert.deepEqual(await app.evaluate(() => globalThis.__edgeBlockedHttp), []);
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
