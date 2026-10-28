'use strict';
// Lead runs this serially. Uses real installed-font enumeration and generated offline source/profile only.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const report = { checks: [], errors: [], screenshots: [], fonts: {}, navigation: [], panels: [] };
let app, page, run, profile, collection, selectedFamily;
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
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
    globalThis.__typographyBlockedHttp = [];
    const original = net.fetch.bind(net);
    net.fetch = (input, ...options) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (/^https?:\/\//i.test(url)) {
        globalThis.__typographyBlockedHttp.push(url);
        return Promise.reject(new Error('Public HTTP blocked'));
      }
      return original(input, ...options);
    };
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        globalThis.__typographyBlockedHttp.push(details.url);
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.setContentSize(1600, 1100);
    return {
      userData: app.getPath('userData'),
      version: app.getVersion(),
      isPackaged: app.isPackaged
    };
  });
  assert.equal(path.resolve(runtime.userData), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: executable || require('electron'), ...runtime };
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumTypography
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => innerWidth === 1600);
}
async function closeApp() {
  if (!app) return;
  const blocked = await app.evaluate(() => globalThis.__typographyBlockedHttp).catch(() => []);
  assert.deepEqual(blocked, [], 'No public main/session HTTP was attempted');
  await app.close();
  app = null;
}
async function settle() {
  await page.waitForFunction(() => grid.loading.size === 0 && displayChangeTask === null);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function appearance() {
  await page.evaluate(() => settingsModal('appearance'));
  await expect(page.locator('#font-choose')).toBeVisible();
  await expect(page.locator('#settings-tab-appearance')).toHaveAttribute('aria-selected', 'true');
}
async function picker() {
  await page.locator('#font-choose').click();
  await expect(page.locator('#font-picker')).toBeVisible();
  await expect(page.locator('#font-options')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#font-options [role="option"]')).not.toHaveCount(0);
}
async function computedFont() {
  return page.evaluate(() =>
    Object.fromEntries(
      ['html', 'body', '#search', '#settings-tab-appearance', '#font-choose'].map((selector) => [
        selector,
        getComputedStyle(document.querySelector(selector)).fontFamily
      ])
    )
  );
}
function assertChosenFonts(samples, family) {
  for (const [selector, stack] of Object.entries(samples)) {
    const first = stack
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    assert.equal(
      first.toLocaleLowerCase(),
      family.toLocaleLowerCase(),
      selector + ' global selected family must be first'
    );
  }
}
async function screenshot(name) {
  const file = path.join(run, name + '.png');
  await page.screenshot({ path: file, scale: 'css' });
  report.screenshots.push(file);
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    const artifacts = await fs.realpath(path.join(root, 'artifacts'));
    run = path.join(
      artifacts,
      'typography_navigation',
      new Date().toISOString().replace(/[^a-zA-Z0-9]/g, '_') +
        '_' +
        crypto.randomUUID().replace(/-/g, '_')
    );
    profile = path.join(run, 'generated_profile');
    collection = path.join(run, 'generated_collection');
    await fs.mkdir(profile, { recursive: true });
    await fs.mkdir(collection, { recursive: true });
    const image = await sharp({
      create: { width: 48, height: 64, channels: 3, background: '#775a99' }
    })
      .png()
      .toBuffer();
    for (let index = 0; index < 9; index++)
      await fs.writeFile(path.join(collection, `image_${index}.png`), image, { flag: 'wx' });
    for (let index = 0; index < 2; index++) {
      const folder = path.join(collection, `album_${index}`);
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder, 'generated.png'), image, { flag: 'wx' });
    }
    await seed();
    await launch();
    await check(
      'fresh profile defaults to high motion and enumerates real installed families without network',
      async () => {
        assert.equal(await page.evaluate(() => S.settings.motionLevel), 'high');
        const fonts = await rpc('systemFonts');
        assert.ok(
          Array.isArray(fonts.families) && fonts.families.length > 0,
          'systemFonts returns installed families'
        );
        const preferences = [
          'Microsoft YaHei UI',
          'Microsoft YaHei',
          '微软雅黑',
          'Noto Sans CJK SC',
          'Source Han Sans SC',
          'SimHei',
          '黑体',
          'SimSun',
          '宋体'
        ];
        selectedFamily = preferences
          .map((wanted) =>
            fonts.families.find(
              (family) => family.toLocaleLowerCase() === wanted.toLocaleLowerCase()
            )
          )
          .find(Boolean);
        assert.ok(
          selectedFamily,
          'This local fixture needs an installed family supporting both Chinese and Latin'
        );
        report.fonts = {
          count: fonts.families.length,
          selected: selectedFamily,
          source: fonts.source || null
        };
        await appearance();
        await picker();
        await page.locator('#font-search').fill(selectedFamily);
        await expect(
          page.locator('#font-options').getByRole('option', { name: selectedFamily, exact: true })
        ).toBeVisible();
        await page
          .locator('#font-options')
          .getByRole('option', { name: selectedFamily, exact: true })
          .click();
        await expect(page.locator('#font-picker')).toHaveCount(0);
        await expect(page.locator('#modal')).toBeVisible();
        await expect(page.locator('#font-current')).toHaveText(selectedFamily);
        assert.equal((await rpc('init')).settings.fontFamily, selectedFamily);
        const fontsApplied = await computedFont();
        assertChosenFonts(fontsApplied, selectedFamily);
        report.fonts.applied = fontsApplied;
      }
    );
    await check(
      'font picker respects both themes and explicit child close preserves preferences and saved font',
      async () => {
        const samples = [];
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => saveSetting('theme', theme), theme);
          await picker();
          const sample = await page.locator('#font-picker').evaluate((dialog) => ({
            theme: document.documentElement.dataset.theme,
            background: getComputedStyle(dialog).backgroundColor,
            color: getComputedStyle(dialog).color
          }));
          assert.equal(sample.theme, theme);
          samples.push(sample);
          await screenshot('font_picker_' + theme);
          await page.locator('#font-picker [data-font-close]').click();
          await expect(page.locator('#font-picker')).toHaveCount(0);
          await expect(page.locator('#settings-panel-appearance')).toBeVisible();
          assert.equal((await rpc('init')).settings.fontFamily, selectedFamily);
        }
        assert.notEqual(samples[0].color, samples[1].color);
        report.fonts.themes = samples;
        await page.locator('#modal-close').click();
      }
    );
    await check(
      'selected font survives restart and system default can be restored through the picker',
      async () => {
        await closeApp();
        await launch();
        assert.equal((await rpc('init')).settings.fontFamily, selectedFamily);
        await appearance();
        assertChosenFonts(await computedFont(), selectedFamily);
        await picker();
        await page
          .locator('#font-options')
          .getByRole('option', { name: '系统默认', exact: true })
          .click();
        await expect(page.locator('#font-picker')).toHaveCount(0);
        await expect(page.locator('#font-current')).toHaveText('系统默认');
        assert.equal((await rpc('init')).settings.fontFamily, '');
        assert.match((await computedFont()).html, /^['"]?Segoe UI Variable/);
        await page.locator('#modal-close').click();
        await closeApp();
        await launch();
        assert.equal((await rpc('init')).settings.fontFamily, '');
        assert.match(
          await page.evaluate(() => getComputedStyle(document.body).fontFamily),
          /^['"]?Segoe UI Variable/
        );
      }
    );
    await check(
      'directory filter changes retain breadcrumbs and navigation while moving only the indicator',
      async () => {
        await page.evaluate((parent) => navigate({ parent }), idFor(collection));
        await settle();
        await expect(page.locator('.topbar .search-wrap kbd')).toHaveCount(0);
        const searchIcon = await page.locator('.topbar .search-wrap > span').evaluate((span) => ({
          display: getComputedStyle(span).display,
          align: getComputedStyle(span).alignItems,
          justify: getComputedStyle(span).justifyItems,
          transform: getComputedStyle(span.querySelector('svg')).transform
        }));
        // A flex item blockifies inline-grid to grid in computed style.
        assert.ok(['inline-grid', 'grid'].includes(searchIcon.display));
        assert.equal(searchIcon.align, 'center');
        assert.equal(searchIcon.justify, 'center');
        assert.ok(
          Math.abs(Number(searchIcon.transform.split(',').at(-1).replace(')', '')) + 1) < 0.001,
          JSON.stringify(searchIcon)
        );
        report.searchIcon = searchIcon;
        await page.evaluate(() => {
          window.__navigationProbe = {
            crumbs: $('#breadcrumbs'),
            children: [...$('#breadcrumbs').childNodes],
            nav: $('.navigation'),
            filters: $('.filter-tabs'),
            routeKey: $('#breadcrumbs').dataset.routeKey,
            mutations: 0,
            navReplacement: 0
          };
          window.__navigationProbe.observer = new MutationObserver((records) => {
            window.__navigationProbe.mutations += records.length;
          });
          window.__navigationProbe.observer.observe($('#breadcrumbs'), {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true
          });
          window.__navigationProbe.parentObserver = new MutationObserver((records) => {
            for (const record of records)
              if (
                [...record.removedNodes, ...record.addedNodes].includes(
                  window.__navigationProbe.nav
                )
              )
                window.__navigationProbe.navReplacement++;
          });
          window.__navigationProbe.parentObserver.observe($('.topbar'), { childList: true });
        });
        const transforms = new Set();
        for (const [filter, count] of [
          ['folders', 2],
          ['images', 9],
          ['all', 11],
          ['images', 9],
          ['all', 11]
        ]) {
          await page.locator(`.filter-tabs button[data-filter="${filter}"]`).click();
          await page.waitForFunction(
            ({ filter, count }) =>
              S.filter === filter && grid.total === count && grid.loading.size === 0,
            { filter, count }
          );
          await settle();
          // Wait for this specific indicator target, not a generic time delay.
          await page.waitForFunction(() => {
            const tabs = $('.filter-tabs'),
              style = getComputedStyle(tabs, '::before'),
              matrix = new DOMMatrixReadOnly(style.transform),
              target = parseFloat(tabs.style.getPropertyValue('--filter-x'));
            return Math.abs(matrix.m41 - target) < 0.5;
          });
          const state = await page.evaluate(() => {
            const probe = window.__navigationProbe,
              crumbs = $('#breadcrumbs');
            return {
              sameCrumbs: probe.crumbs === crumbs,
              sameChildren:
                probe.children.length === crumbs.childNodes.length &&
                probe.children.every((child, index) => child === crumbs.childNodes[index]),
              sameNavigation: probe.nav === $('.navigation'),
              sameFilters: probe.filters === $('.filter-tabs'),
              sameRoute: probe.routeKey === crumbs.dataset.routeKey,
              routeKey: crumbs.dataset.routeKey,
              mutations: probe.mutations,
              navReplacement: probe.navReplacement,
              count: $('#result-count').textContent,
              transform: getComputedStyle($('.filter-tabs'), '::before').transform
            };
          });
          for (const key of [
            'sameCrumbs',
            'sameChildren',
            'sameNavigation',
            'sameFilters',
            'sameRoute'
          ])
            assert.equal(state[key], true, key);
          assert.equal(state.mutations, 0);
          assert.equal(state.navReplacement, 0);
          assert.equal(state.count, `${count} 项`);
          transforms.add(state.transform);
          report.navigation.push({ filter, ...state });
        }
        assert.ok(
          transforms.size >= 3,
          'three filter positions animate through distinct transforms'
        );
        await page.evaluate(() => {
          window.__navigationProbe.observer.disconnect();
          window.__navigationProbe.parentObserver.disconnect();
        });
        await screenshot('navigation_stable_filters');
      }
    );
    await check(
      'rapid preference tabs hide outgoing panels immediately and incoming motion never fades below 0.94',
      async () => {
        await appearance();
        for (const name of ['profile', 'metadata', 'cache', 'application', 'appearance']) {
          await page.locator(`#settings-tab-${name}`).click();
          await expect(page.locator(`#settings-panel-${name}`)).toBeVisible();
        }
        await page.evaluate(() => {
          window.__panelFrames = [];
          window.__originalPanelAnimate = Element.prototype.animate;
          Element.prototype.animate = function (keyframes, options) {
            if (this.classList.contains('settings-panel'))
              window.__panelFrames.push({ id: this.id, keyframes });
            return window.__originalPanelAnimate.call(this, keyframes, options);
          };
        });
        try {
          const samples = await page.evaluate(async () => {
            const samples = [],
              shell = $('#settings-shell');
            for (const name of [
              'profile',
              'metadata',
              'appearance',
              'application',
              'profile',
              'appearance'
            ]) {
              const before = [...document.querySelectorAll('.settings-panel')].find(
                (panel) => !panel.hidden
              );
              await shell.switchTab(name);
              const incoming = document.getElementById('settings-panel-' + name);
              samples.push({
                name,
                outgoing: before?.id,
                outgoingHidden: before === incoming || before?.hidden,
                outgoingInert: before === incoming || before?.inert,
                visiblePanels: [...document.querySelectorAll('.settings-panel')].filter(
                  (panel) => !panel.hidden
                ).length,
                opacity: Number(getComputedStyle(incoming).opacity)
              });
            }
            return samples;
          });
          for (const sample of samples) {
            assert.equal(sample.outgoingHidden, true);
            assert.equal(sample.outgoingInert, true);
            assert.equal(sample.visiblePanels, 1);
            assert.ok(sample.opacity >= 0.939, JSON.stringify(sample));
          }
          const frames = await page.evaluate(() => window.__panelFrames);
          assert.ok(frames.length >= 5);
          for (const animation of frames)
            for (const frame of animation.keyframes)
              if (frame.opacity !== undefined) assert.ok(Number(frame.opacity) >= 0.94);
          report.panels = { samples, frames };
        } finally {
          await page.evaluate(() => {
            Element.prototype.animate = window.__originalPanelAnimate;
          });
        }
        await page.locator('#settings-tab-profile').hover();
        const hover = await page
          .locator('#settings-tab-profile')
          .evaluate((button) => getComputedStyle(button).backgroundColor);
        assert.ok(hover === 'rgba(0, 0, 0, 0)' || hover === 'transparent', hover);
        await screenshot('preferences_stable_panels');
        await page.locator('#modal-close').click();
      }
    );
    assert.deepEqual(report.errors, []);
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.stack;
    console.error(error.stack);
    process.exitCode = 1;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    if (app) {
      try {
        await closeApp();
      } catch (error) {
        report.errors.push(error.stack);
        report.passed = false;
        process.exitCode = 1;
        await app?.close().catch(() => {});
      }
    }
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2));
      console.log('Report: ' + file);
    }
  }
})();
