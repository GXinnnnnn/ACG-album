'use strict';
// Run serially after the UI changes are integrated. Only generated fixtures/profiles are used.
// ACG_EXECUTABLE optionally selects a packaged build; otherwise this launches the source checkout.
const { _electron, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const root = path.resolve(__dirname, '..');
const packaged = process.env.ACG_EXECUTABLE ? path.resolve(process.env.ACG_EXECUTABLE) : null;
const report = { checks: [], errors: [], screenshots: [], geometry: [] };
let app, page, run, profile, parent;
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
async function seed(collection) {
  const worker = new Worker(path.join(root, 'src/library-worker.cjs'), {
    workerData: {
      dataDir: profile,
      token: '',
      watch: false,
      localIndexPath: path.join(run, 'absent-index.sqlite')
    }
  });
  const pending = new Map();
  let sequence = 0;
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const request = pending.get(message.request);
        if (!request) return;
        pending.delete(message.request);
        clearTimeout(request.timer);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
      });
    });
    const call = (method, args = {}) =>
      new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => reject(new Error('Fixture RPC timeout: ' + method)), 30000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    await call('settings', { key: 'watchChanges', value: false });
    await call('settings', { key: 'autoMatch', value: false });
    await call('scan', { path: collection, onlineMatch: false, subjectTypes: [4] });
    await call('shutdown');
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    await worker.terminate();
  }
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: packaged || require('electron'),
    args: packaged ? [] : ['.'],
    cwd: root,
    env,
    timeout: 30000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => report.errors.push(error.stack));
  await page.waitForFunction(() => typeof S !== 'undefined' && S.loadVersion > 0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const actual = await app.evaluate(({ app }) => ({
    data: app.getPath('userData'),
    version: app.getVersion(),
    packaged: app.isPackaged
  }));
  assert.equal(path.resolve(actual.data), path.join(profile, 'chromium-profile'));
  report.runtime = { executable: packaged || require('electron'), ...actual };
}
async function resize(width, height) {
  await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(width, height);
    },
    { width, height }
  );
  await page.waitForFunction((width) => innerWidth === width, width);
  await page.evaluate(() => grid.render());
}
async function go() {
  await page.evaluate((parent) => navigate({ parent }), parent);
  await page.waitForFunction(() => grid.active && grid.total === 256 && grid.cards.size > 0);
}
async function screenshot(name) {
  const target = path.join(run, name + '.png');
  await page.screenshot({ path: target, scale: 'css' });
  report.screenshots.push(target);
}
async function geometry() {
  return page.evaluate(() => {
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, right: r.right };
    };
    const shell = $('#sidebar-shell'),
      bounds = shell.getBoundingClientRect(),
      clip = getComputedStyle(shell).clipPath,
      rightClip = Number(/inset\([^ ]+ ([\d.]+)px/.exec(clip)?.[1] || 0),
      railCenter = bounds.left + (bounds.width - rightClip) / 2;
    const measurements = [];
    for (const button of $$('.sidebar .nav-item,.sidebar .import-button')) {
      const icon = button.querySelector(':scope > span:first-child > svg');
      if (!icon) continue;
      const b = rect(button),
        i = rect(icon);
      measurements.push({
        name: button.id || button.dataset.view,
        xError: i.x - railCenter,
        yError: i.y - b.y
      });
    }
    for (const selector of [
      '.navigation .icon-button',
      '.header-actions .icon-button',
      '.toolbar-right .small-icon',
      '#sidebar-pin',
      '#collapse-all',
      '.category-enter',
      '.category-expand',
      '.back-to-top'
    ]) {
      for (const button of $$(selector)) {
        if (!button.getClientRects().length || getComputedStyle(button).visibility === 'hidden')
          continue;
        const icon = button.querySelector('svg');
        if (!icon) continue;
        const b = rect(button),
          i = rect(icon);
        measurements.push({
          name: button.id || selector,
          xError: selector === '.back-to-top' ? 0 : i.x - b.x,
          yError: i.y - b.y
        });
      }
    }
    for (const [selector, capsule] of [
      ['.search-wrap > [data-icon] > svg', '.search-wrap'],
      ['.sort-label > [data-icon] > svg', '.toolbar-right'],
      ['.profile-button > [data-icon] > svg', '.profile-button'],
      ['.brand > img', '.brand']
    ]) {
      const icon = $(selector);
      if (icon?.getClientRects().length)
        measurements.push({ name: selector, yError: rect(icon).y - rect($(capsule)).y });
    }
    const toolbar = rect($('.toolbar-right')),
      leftIcon = rect($('.sort-label svg')),
      rightIcon = rect($('#density-button svg'));
    return {
      width: innerWidth,
      theme: document.documentElement.dataset.theme,
      clip,
      railCenter,
      measurements,
      leftInset: leftIcon.x - toolbar.left,
      rightInset: toolbar.right - rightIcon.x
    };
  });
}
async function assertGeometry() {
  const result = await geometry();
  report.geometry.push(result);
  for (const item of result.measurements) {
    if (item.xError !== undefined)
      assert.ok(Math.abs(item.xError) <= 0.75, `${item.name}: x error ${item.xError}`);
    assert.ok(Math.abs(item.yError) <= 0.75, `${item.name}: y error ${item.yError}`);
  }
  assert.ok(Math.abs(result.leftInset - result.rightInset) <= 0.75);
}
async function assertSubtitles(expected) {
  const actual = await page
    .locator('.album-card:not(.media-card) .card-subtitle')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        shown: getComputedStyle(element).display !== 'none',
        text: element.textContent,
        titleShown: element.previousElementSibling.getClientRects().length > 0
      }))
    );
  assert.ok(actual.length > 0, 'Generated folder cards are present');
  assert.ok(actual.every((item) => item.shown === expected && item.titleShown));
  return actual;
}
(async () => {
  try {
    await fs.mkdir(path.join(root, 'artifacts'), { recursive: true });
    run = path.join(
      await fs.realpath(path.join(root, 'artifacts')),
      'floating-refinement',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    profile = path.join(run, 'generated-profile');
    await fs.mkdir(profile, { recursive: true });
    const collection = path.join(run, 'Generated folders');
    const folders = Array.from({ length: 256 }, (_, i) =>
      path.join(collection, `Folder ${String(i).padStart(3, '0')}`)
    );
    const image = await sharp({
      create: { width: 48, height: 64, channels: 3, background: '#cbb7d8' }
    })
      .png()
      .toBuffer();
    for (const folder of folders) {
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'generated.png'), image, { flag: 'wx' });
    }
    await seed(collection);
    const db = new DatabaseSync(path.join(profile, 'library.sqlite'));
    try {
      const patch = db.prepare('UPDATE nodes SET cover_source=?,manual_cover=? WHERE id=?');
      for (let i = 0; i < folders.length; i++)
        patch.run(i % 3 === 1 ? 'bangumi' : 'local', i % 3 === 2 ? 1 : 0, idFor(folders[i]));
    } finally {
      db.close();
    }
    parent = idFor(collection);
    report.run = run;
    report.profile = profile;
    await launch();
    await go();
    for (const [width, height] of [
      [1180, 900],
      [1920, 1080],
      [3840, 2160]
    ]) {
      await resize(width, height);
      for (const theme of ['light', 'dark'])
        await check(`floating icon centers at ${width}px in ${theme}`, async () => {
          await page.evaluate(async (theme) => {
            await saveSetting('theme', theme);
            await saveSetting('sidebarMode', 'auto');
            setSidebarOpen(false);
          }, theme);
          await expect(page.locator('#sidebar-shell')).not.toHaveClass(/is-open/);
          // Keep the pointer away from the rail so hover cannot reopen it during measurements.
          await page.mouse.move(width - 60, height - 60);
          await assertGeometry();
          await screenshot(`floating-${width}-${theme}`);
        });
    }
    await resize(1180, 900);
    await check(
      'smallest folder cards retain count boundaries, full tooltips and unclipped ratings',
      async () => {
        const cases = [
          { count: 0, expected: '0 张' },
          { count: 999999, expected: '999,999 张' },
          { count: 1000000, expected: '1,000,000 张' },
          { count: 1000001, expected: '100.0万张' },
          { count: 1234567, expected: '123.5万张' },
          { count: 100000000, expected: '10000.0万张' },
          { count: 9999999999, expected: '1000000.0万张' },
          { count: 10000000000, expected: '1000000.0万张' },
          { count: 10000000001, expected: '100.0亿张' },
          { count: Number.MAX_SAFE_INTEGER, expected: '90071992.5亿张' }
        ];
        await page.evaluate(async (cases) => {
          await changeDisplaySetting('density', 158);
          const sample = [...grid.items.values()].find((node) => node.kind === 'folder');
          if (!sample) throw new Error('No generated folder is available for count fixtures');
          const host = document.createElement('div');
          host.id = 'count-boundary-fixtures';
          host.className = 'collection-preview';
          // Exercise the exact smallest preset instead of a wider fitted column.
          host.style.gridTemplateColumns = 'repeat(5, 158px)';
          host.style.marginBlock = '20px';
          for (const [index, item] of cases.entries()) {
            const element = card(
              {
                ...sample,
                files: item.count,
                name: `Count boundary ${item.count}`,
                metadata: { ...sample.metadata, rating: { score: 9.9 } }
              },
              index,
              true,
              158
            );
            element.dataset.fixtureCount = String(item.count);
            host.append(element);
          }
          $('#viewport').insertBefore(host, $('#virtual-grid'));
          host.scrollIntoView({ block: 'center', behavior: 'instant' });
        }, cases);
        try {
          const rows = await page
            .locator('#count-boundary-fixtures .album-card')
            .evaluateAll((cards) =>
              cards.map((element) => {
                const count = element.querySelector('.card-count'),
                  value = count.querySelector('.card-count-value'),
                  unit = count.querySelector('.card-count-unit'),
                  rating = element.querySelector('.card-rating'),
                  cover = element.querySelector('.cover-shell'),
                  textStyle = getComputedStyle(value),
                  box = (node) => {
                    const r = node.getBoundingClientRect();
                    return {
                      left: r.left,
                      top: r.top,
                      right: r.right,
                      bottom: r.bottom,
                      width: r.width
                    };
                  };
                return {
                  count: Number(element.dataset.fixtureCount),
                  text: count.textContent,
                  title: count.title,
                  ariaLabel: count.getAttribute('aria-label'),
                  width: element.getBoundingClientRect().width,
                  overflow: textStyle.overflow,
                  textOverflow: textStyle.textOverflow,
                  whiteSpace: textStyle.whiteSpace,
                  clipped: value.scrollWidth > value.clientWidth,
                  valueWidth: value.clientWidth,
                  valueScrollWidth: value.scrollWidth,
                  countClipped: count.scrollWidth > count.clientWidth,
                  unitText: unit.textContent,
                  unitClipped: unit.scrollWidth > unit.clientWidth,
                  ratingText: rating.textContent,
                  ratingClipped: rating.scrollWidth > rating.clientWidth,
                  cardHeight: element.getBoundingClientRect().height,
                  gap: Number.parseFloat(getComputedStyle(count.parentElement).columnGap),
                  countBox: box(count),
                  unitBox: box(unit),
                  ratingBox: box(rating),
                  coverBox: box(cover)
                };
              })
            );
          report.countBoundaries = rows;
          assert.equal(rows.length, cases.length);
          for (const [index, row] of rows.entries()) {
            const full = new Intl.NumberFormat('zh-CN').format(cases[index].count) + ' 张';
            assert.equal(row.count, cases[index].count);
            assert.equal(row.text, cases[index].expected);
            assert.equal(row.title, full, 'Native tooltip retains the complete count');
            assert.equal(row.ariaLabel, full, 'Accessible text retains the complete count');
            assert.ok(
              Math.abs(row.width - 158) < 0.5,
              'Count fixtures use the smallest card width'
            );
            assert.equal(row.overflow, 'hidden');
            assert.equal(row.textOverflow, 'ellipsis');
            assert.equal(row.whiteSpace, 'nowrap');
            const unit = cases[index].expected.endsWith('万张')
              ? '万张'
              : cases[index].expected.endsWith('亿张')
                ? '亿张'
                : ' 张';
            assert.equal(row.unitText, unit);
            assert.equal(row.unitClipped, false, 'The count unit is never truncated');
            assert.equal(row.countClipped, false, 'The unit remains inside the count container');
            assert.ok(row.unitBox.left >= row.countBox.left - 0.5);
            assert.ok(row.unitBox.right <= row.countBox.right + 0.5);
            if (cases[index].count <= 100000000 || cases[index].count === 10000000001) {
              assert.equal(
                row.clipped,
                false,
                `${row.text} is fully readable at the smallest width`
              );
              assert.ok(row.valueWidth >= row.valueScrollWidth);
            }
            assert.ok(Math.abs(row.cardHeight - rows[0].cardHeight) < 0.5);
            assert.ok(
              Math.abs(
                (row.countBox.top + row.countBox.bottom) / 2 -
                  (row.ratingBox.top + row.ratingBox.bottom) / 2
              ) <= 0.75,
              'Count and rating share the same vertical center'
            );
            assert.equal(row.ratingText, '★ 9.9');
            assert.equal(row.ratingClipped, false);
            assert.ok(
              row.countBox.right + row.gap - 0.5 <= row.ratingBox.left,
              'Count and rating preserve the declared gap'
            );
            for (const badge of [row.countBox, row.ratingBox]) {
              assert.ok(badge.left >= row.coverBox.left - 0.5);
              assert.ok(badge.right <= row.coverBox.right + 0.5);
              assert.ok(badge.top >= row.coverBox.top - 0.5);
              assert.ok(badge.bottom <= row.coverBox.bottom + 0.5);
            }
          }
          assert.equal(rows.at(-1).clipped, true, 'The widest count actually exercises ellipsis');
          await screenshot('count-boundaries-smallest-cards');
        } finally {
          await page.evaluate(() => {
            $('#count-boundary-fixtures')?.remove();
            $('#viewport').scrollTop = 0;
            grid.render();
          });
        }
      }
    );
    await check(
      'folder details disappear, shrink virtual rows and restore the same visible anchor',
      async () => {
        await page.evaluate(async () => {
          await changeDisplaySetting('details', true);
          grid.restoreAnchor(grid.cols * 6, 96);
        });
        await page.waitForFunction(() => grid.loading.size === 0);
        await page.evaluate(() => {
          const viewport = $('#viewport'),
            origin = viewport.getBoundingClientRect().top,
            clearance = Math.max(0, $('#toolbar').getBoundingClientRect().bottom - origin + 12),
            anchor = grid.captureAnchor(clearance),
            element = grid.cards.get(anchor.index);
          window.__floatingRefinementAnchor = {
            ...anchor,
            element,
            source: element.querySelector('img').getAttribute('src'),
            height: grid.getPosition(anchor.index).height,
            extent: Number.parseFloat($('#virtual-grid').style.height),
            rows: Math.ceil(grid.total / grid.cols)
          };
        });
        await assertSubtitles(true);
        await page.locator('#details-toggle').click();
        await page.waitForFunction(
          () => displayChangeTask === null && S.settings.details === false
        );
        await assertSubtitles(false);
        const hidden = await page.evaluate(() => {
          const a = window.__floatingRefinementAnchor,
            p = grid.getPosition(a.index),
            b = grid.cards.get(a.index),
            viewport = $('#viewport'),
            origin =
              $('#virtual-grid').getBoundingClientRect().top -
              viewport.getBoundingClientRect().top +
              viewport.scrollTop;
          return {
            anchorError: origin + p.top - viewport.scrollTop - a.offset,
            heightSaved: a.height - p.height,
            extentSaved: a.extent - Number.parseFloat($('#virtual-grid').style.height),
            expectedExtentSaved: a.rows * 30,
            sameCard: b === a.element,
            sameSource: b.querySelector('img').getAttribute('src') === a.source,
            infoHeight: b.querySelector('.card-info').style.height
          };
        });
        report.hiddenDetails = hidden;
        assert.ok(Math.abs(hidden.anchorError) < 1);
        assert.equal(hidden.heightSaved, 30);
        assert.ok(Math.abs(hidden.extentSaved - hidden.expectedExtentSaved) < 1);
        assert.equal(hidden.sameCard, true);
        assert.equal(hidden.sameSource, true);
        assert.equal(hidden.infoHeight, '40px');
        await screenshot('folder-details-off');
        await page.locator('#details-toggle').click();
        await page.waitForFunction(() => displayChangeTask === null && S.settings.details === true);
        await assertSubtitles(true);
        const restored = await page.evaluate(() => {
          const a = window.__floatingRefinementAnchor,
            b = grid.cards.get(a.index),
            viewport = $('#viewport'),
            origin =
              $('#virtual-grid').getBoundingClientRect().top -
              viewport.getBoundingClientRect().top +
              viewport.scrollTop;
          return {
            anchorError: origin + grid.getPosition(a.index).top - viewport.scrollTop - a.offset,
            height: grid.getPosition(a.index).height,
            expectedHeight: a.height,
            sameCard: b === a.element,
            infoHeight: b.querySelector('.card-info').style.height
          };
        });
        report.restoredDetails = restored;
        assert.ok(Math.abs(restored.anchorError) < 1);
        assert.equal(restored.height, restored.expectedHeight);
        assert.equal(restored.sameCard, true);
        assert.equal(restored.infoHeight, '70px');
        await screenshot('folder-details-on');
      }
    );
    await check('expanded overview previews obey the same details switch', async () => {
      await page.evaluate(() => navigate({}));
      const tile = page.locator(`#category-overview .collection-tile[data-id="${parent}"]`);
      await tile.locator('.category-expand').click();
      const expectedPreviewCount = await tile
        .locator('.collection-preview')
        .evaluate(
          (preview, total) =>
            Math.min(
              total,
              2 * getComputedStyle(preview).gridTemplateColumns.trim().split(/\s+/).length
            ),
          folders.length
        );
      await expect(tile.locator('.collection-preview .album-card')).toHaveCount(
        expectedPreviewCount
      );
      await assertGeometry();
      const shown = await assertSubtitles(true);
      assert.ok(shown.some((item) => item.text.includes('Bangumi')));
      assert.ok(shown.some((item) => item.text.includes('自选封面')));
      assert.ok(shown.some((item) => item.text.includes('本地相册')));
      await page.evaluate(() => changeDisplaySetting('details', false));
      await assertSubtitles(false);
      await screenshot('preview-details-off');
      await page.evaluate(() => changeDisplaySetting('details', true));
      await assertSubtitles(true);
      await screenshot('preview-details-on');
    });
    assert.deepEqual(report.errors, []);
  } catch (error) {
    report.failure = error.stack;
    process.exitCode = 1;
    console.error(error);
  } finally {
    await app?.close();
    if (run) {
      await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2));
      console.log('Report: ' + path.join(run, 'report.json'));
    }
  }
})();
