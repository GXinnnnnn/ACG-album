'use strict';
// Lead runs this serially; writing/checking this file does not launch a GUI.
// ACG_APP_PATH accepts a source directory or packaged .exe; ACG_CHECK_STAGE owns all evidence.
const { _electron, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');
const project = path.resolve(__dirname, '..');
const requested = path.resolve(process.env.ACG_APP_PATH || process.env.ACG_EXECUTABLE || project);
const packaged = /\.exe$/i.test(requested);
const executable = packaged ? requested : require('electron');
const stage = path.resolve(process.env.ACG_CHECK_STAGE || 'C:\\ACG\\资料归档\\responsive-layout');
const report = {
  passed: false,
  requested,
  packaged,
  scope:
    'Real Electron responsive layout, isolated generated profile and PNGs. 420 direct mixed PNGs and 13 two-image subfolders; the closed generated DB seeds folder display counts of 99,999 and ratings of 10.0 without generating 100,000 files. Offline settings, actual CSS viewport/DPR, left-edge/footer/toolbar DOM geometry and reading anchors. No original-image viewer, refresh/pressure loop, personal data or deployment.',
  started: new Date().toISOString(),
  samples: [],
  anchorProbes: [],
  screenshots: [],
  errors: [],
  remote: [],
  originals: []
};
let run, profile, collection, app, page;
const inside = (base, target) => {
  const relative = path.relative(base, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const rpc = (method, args = {}) =>
  page.evaluate(({ method, args }) => window.album.call(method, args), { method, args });
async function frames() {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}
async function settle() {
  await page.waitForFunction(
    () =>
      !libraryRefreshBusy &&
      !scanActive &&
      !growingTask &&
      growingTimer === null &&
      !growingDirty &&
      grid.loading.size === 0 &&
      !mediaDirty
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#virtual-grid img')].every(
      (image) => image.complete && image.naturalWidth > 0
    )
  );
  await frames();
}
async function prepare() {
  const personal = path.resolve('C:\\ACG\\.review-data');
  assert.ok(
    !samePath(personal, stage) && !inside(personal, stage),
    'Evidence must stay outside the personal profile'
  );
  await fs.mkdir(stage, { recursive: true });
  const base = await fs.realpath(stage);
  run = path.join(
    base,
    (packaged ? 'packaged-' : 'source-') +
      new Date().toISOString().replaceAll(':', '-') +
      '-' +
      randomUUID()
  );
  assert.ok(inside(base, run));
  await fs.mkdir(run);
  profile = path.join(run, 'generated-profile');
  collection = path.join(run, 'generated-collection');
  Object.assign(report, { run, profile, collection });
  await fs.mkdir(collection);
  const shapes = [
    [240, 90],
    [240, 180],
    [240, 320],
    [120, 900],
    [360, 120],
    [180, 480],
    [240, 240]
  ];
  const buffers = await Promise.all(
    shapes.map(([width, height], i) =>
      sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 80 + i * 20, g: 110 + i * 9, b: 160 + i * 7 }
        }
      })
        .png()
        .toBuffer()
    )
  );
  const files = [];
  for (let i = 0; i < 420; i++) {
    const file = path.join(collection, 'image-' + String(i).padStart(3, '0') + '.png');
    await fs.writeFile(file, buffers[i % buffers.length]);
    files.push(file);
  }
  for (let i = 0; i < 13; i++) {
    const folder = path.join(collection, '分组-' + String(i).padStart(2, '0'));
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'short.png'), buffers[0]);
    await fs.writeFile(path.join(folder, 'long.png'), buffers[3]);
  }
  // Prepare only generated data with the real source worker; fetch rejects before reaching the network.
  const worker = new Worker(
    `globalThis.fetch = async () => { throw new Error('HTTP disabled by responsive fixture'); }; require(${JSON.stringify(path.join(project, 'src/library-worker.cjs'))});`,
    {
      eval: true,
      workerData: {
        dataDir: profile,
        watch: false,
        localIndexPath: path.join(run, 'absent-index.sqlite')
      }
    }
  );
  let sequence = 0;
  const pending = new Map();
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('Fixture worker timed out: ' + method));
      }, 30000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await new Promise((resolve, reject) => {
      worker.once('error', reject);
      worker.on('message', (message) => {
        if (message.event === 'ready') resolve();
        const task = pending.get(message.request);
        if (!task) return;
        clearTimeout(task.timer);
        pending.delete(message.request);
        message.error ? task.reject(new Error(message.error)) : task.resolve(message.result);
      });
    });
    for (const [key, value] of [
      ['autoMatch', false],
      ['watchChanges', false],
      ['metadataOnboardingSeen', true],
      ['motionLevel', 'low'],
      ['sidebarMode', 'compact']
    ])
      await call('settings', { key, value });
    const scan = await call('scan', { path: collection, offline: true, onlineMatch: false });
    assert.equal(scan.errors, 0);
    for (let start = 0; start < files.length; start += 4)
      await Promise.all(
        files.slice(start, start + 4).map((file) => call('mediaInfo', { id: idFor(file) }))
      );
    await call('shutdown');
  } finally {
    for (const task of pending.values()) clearTimeout(task.timer);
    await worker.terminate();
  }
  const database = path.join(profile, 'library.sqlite');
  assert.ok(inside(run, database));
  const db = new DatabaseSync(database);
  try {
    const subject = {
      id: 940002,
      type: 4,
      name: 'Generated responsive fixture',
      name_cn: '隔离响应式样本',
      rating: { score: 10 },
      images: {},
      infobox: []
    };
    db.prepare('INSERT OR REPLACE INTO metadata(id,json,updated) VALUES(?,?,?)').run(
      subject.id,
      JSON.stringify(subject),
      Date.now()
    );
    const updated = db
      .prepare(
        "UPDATE nodes SET files=99999,subject_id=?,manual_subject=1,confirmed=1,match_review=0 WHERE parent=? AND kind='folder'"
      )
      .run(subject.id, idFor(collection));
    assert.equal(Number(updated.changes), 13);
  } finally {
    db.close();
  }
  report.fixture = {
    directMedia: 420,
    folders: 13,
    nestedMedia: 26,
    ratingSeededWhileClosed: 10,
    displayCountSeededWhileClosed: 99999,
    seededFolderCards: 13,
    sourceWorkerPreparation: true
  };
  console.log('ISOLATED ' + run);
}
async function launch() {
  const env = {
    ...process.env,
    ACG_TEST: '1',
    ACG_DATA_DIR: profile,
    ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile'),
    ACG_LOCAL_INDEX_PATH: path.join(run, 'absent-index.sqlite')
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  app = await _electron.launch({
    executablePath: executable,
    args: packaged ? [] : [requested],
    cwd: packaged ? path.dirname(executable) : requested,
    env,
    timeout: 60000
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  page.on('pageerror', (error) => report.errors.push(error.stack || error.message));
  page.on('request', (request) => {
    if (/^acg-image:\/\/(original|preview|frame)\//i.test(request.url()))
      report.originals.push(request.url());
  });
  await app.context().route(/^https?:\/\//, async (route) => {
    report.remote.push(route.request().url());
    await route.abort();
  });
  report.runtime = await app.evaluate(({ app, BrowserWindow, net, session }) => {
    const blocked = (globalThis.__responsiveBlocked = []);
    const deny = (input) => {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      blocked.push(url);
      return Promise.reject(new Error('HTTP disabled by responsive checker'));
    };
    const localFetch = net.fetch.bind(net);
    net.fetch = (input, ...args) =>
      /^https?:/i.test(typeof input === 'string' ? input : input?.url || String(input))
        ? deny(input)
        : localFetch(input, ...args);
    globalThis.fetch = deny;
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        blocked.push(details.url);
        callback({ cancel: true });
      }
    );
    const win = BrowserWindow.getAllWindows()[0];
    if (win.isMaximized()) win.unmaximize();
    win.webContents.setZoomFactor(1);
    win.webContents.setBackgroundThrottling(false);
    win.show();
    win.focus();
    return {
      appPath: app.getAppPath(),
      executable: process.execPath,
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      version: app.getVersion()
    };
  });
  assert.equal(report.runtime.packaged, packaged);
  assert.ok(samePath(report.runtime.executable, executable));
  assert.ok(samePath(report.runtime.userData, path.join(profile, 'chromium-profile')));
  if (!packaged) assert.ok(samePath(report.runtime.appPath, requested));
  await page.waitForFunction(
    () => typeof S !== 'undefined' && S.loadVersion > 0 && !!window.albumAppearanceControls
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => {
    window.__responsiveRejections = [];
    addEventListener('unhandledrejection', (event) =>
      window.__responsiveRejections.push(String(event.reason))
    );
  });
  assert.equal((await rpc('init', { lightweight: true })).settings.autoMatch, false);
  await page.keyboard.press('Escape');
  await page.evaluate((id) => navigate({ parent: id }), idFor(collection));
  await settle();
  assert.equal(await page.evaluate(() => grid.total), 433);
  await page.evaluate(async () => {
    await grid.fetchPage(1);
    grid.render();
  });
  await settle();
  report.absolutePages = await page.evaluate(() => ({
    cached: grid.items.size,
    boundary179: grid.items.has(179),
    boundary180: grid.items.has(180)
  }));
  assert.equal(report.absolutePages.boundary179 && report.absolutePages.boundary180, true);
}
async function resize(width, height = Math.round((width * 9) / 16)) {
  const bounds = await app.evaluate(
    ({ BrowserWindow }, { width, height }) => {
      const win = BrowserWindow.getAllWindows()[0],
        outer = win.getBounds(),
        content = win.getContentBounds();
      win.setBounds({
        x: 0,
        y: 0,
        width: width + outer.width - content.width,
        height: height + outer.height - content.height
      });
      return { outer: win.getBounds(), content: win.getContentBounds() };
    },
    { width, height }
  );
  try {
    await page.waitForFunction(
      ({ width, height }) =>
        innerWidth === width &&
        innerHeight === height &&
        document.documentElement.clientWidth === width,
      { width, height }
    );
  } catch (error) {
    report.failedResize = {
      requestedCSS: { width, height },
      bounds,
      actual: await page.evaluate(() => ({
        innerWidth,
        rootWidth: document.documentElement.clientWidth,
        dpr: devicePixelRatio
      }))
    };
    throw error;
  }
  await settle();
  const viewport = await page.evaluate(() => ({
    innerWidth,
    rootWidth: document.documentElement.clientWidth,
    innerHeight,
    dpr: devicePixelRatio,
    presets: cardPresets()
  }));
  assert.equal(
    viewport.innerWidth,
    width,
    'Use actual renderer CSS viewport, not physical screen pixels'
  );
  assert.equal(viewport.innerHeight, height, 'Use the requested renderer CSS height');
  report.samples.push({ type: 'resize', requestedCSS: { width, height }, bounds, ...viewport });
  return viewport.presets;
}
async function sample(label) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames();
  const result = await page.evaluate((label) => {
    const box = (element) => {
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        cy: (r.top + r.bottom) / 2
      };
    };
    const visible = (element) => {
      const r = element?.getBoundingClientRect();
      const s = element && getComputedStyle(element);
      return (
        !!r && r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      );
    };
    const textRuns = (element) => {
      if (!element) return [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT),
        runs = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent.trim() || node.parentElement.closest('svg')) continue;
        const range = document.createRange();
        range.setStart(node, node.textContent.search(/\S/));
        range.setEnd(node, node.textContent.trimEnd().length);
        runs.push({
          text: range.toString(),
          box: box(range),
          lines: range.getClientRects().length
        });
      }
      return runs;
    };
    const wall = box($('#virtual-grid')),
      main = box(document.querySelector('main')),
      vp = $('#viewport'),
      railElement = $('#sidebar-shell'),
      rail = box(railElement),
      railClip = getComputedStyle(railElement).clipPath,
      insetMatch = railClip.match(/^inset\((.*?)\)$/),
      insetTokens = insetMatch?.[1]
        .split(/\s+round\s+/)[0]
        .trim()
        .split(/\s+/),
      clipSupported =
        railClip === 'none' || !!insetTokens?.every((token) => /^-?[\d.]+(?:px|%)$/.test(token));
    const expandedInsets = !insetTokens
      ? ['0px', '0px', '0px', '0px']
      : insetTokens.length === 1
        ? Array(4).fill(insetTokens[0])
        : insetTokens.length === 2
          ? [...insetTokens, ...insetTokens]
          : insetTokens.length === 3
            ? [...insetTokens, insetTokens[1]]
            : insetTokens;
    const clipPixels = expandedInsets.map(
      (token, index) =>
        parseFloat(token) * (token.endsWith('%') ? (index % 2 ? rail.width : rail.height) / 100 : 1)
    );
    const visibleRail = {
      left: rail.left + clipPixels[3],
      right: rail.right - clipPixels[1],
      clipPath: railClip,
      clipSupported
    };
    const cards = [...grid.cards].map(([index, element]) => ({
      index,
      id: element.dataset.id,
      ...box(element),
      expected: grid.getPosition(index)
    }));
    const left = Math.min(...cards.map((card) => card.left)),
      right = Math.max(...cards.map((card) => card.right));
    const folder = document
      .querySelector('#virtual-grid .album-card:not(.media-card) .card-rating')
      ?.closest('.album-card');
    const footer = folder?.querySelector('.card-bottom-overlay'),
      icon = footer?.querySelector('svg'),
      count = footer?.querySelector('.card-count'),
      value = count?.querySelector('.card-count-value'),
      unit = count?.querySelector('.card-count-unit'),
      rating = footer?.querySelector('.card-rating');
    const controls = ['#details-toggle', '#density-button', '#refresh-button'].map((selector) => ({
      selector,
      ...box($(selector))
    }));
    const toolbarElement = $('#toolbar .toolbar-right');
    const toolbar = box(toolbarElement);
    const alignmentTargets = [
      ['.sort-label', 'control'],
      ['.sort-label .album-select', 'control'],
      ['.sort-label .album-select-button', 'control'],
      ['#sort-direction', 'control'],
      ['.card-size-label', 'control'],
      ['#card-size-controls', 'control'],
      ['#card-size-controls [data-card-preset="compact"]', 'control'],
      ['#card-size-controls [data-card-preset="standard"]', 'control'],
      ['#card-size-controls [data-card-preset="large"]', 'control'],
      ['#details-toggle', 'control'],
      ['#density-button', 'control'],
      ['#refresh-button', 'control'],
      ['.toolbar-divider', 'control'],
      ['.sort-label > span > svg', 'icon'],
      ['.sort-label .album-select-button > svg', 'icon'],
      ['#sort-direction svg', 'icon'],
      ['#density-button svg', 'icon'],
      ['#refresh-button svg', 'icon'],
      ['.sort-label .album-select-value', 'text'],
      ['.card-size-label', 'text'],
      ['#card-size-controls [data-card-preset="compact"]', 'text'],
      ['#card-size-controls [data-card-preset="standard"]', 'text'],
      ['#card-size-controls [data-card-preset="large"]', 'text'],
      ['#details-toggle', 'text']
    ];
    const alignment = alignmentTargets.map(([selector, type]) => {
      const element = toolbarElement.querySelector(selector);
      if (!element) return { selector, type, present: false };
      const style = getComputedStyle(element);
      const visible = element.getClientRects().length > 0 && style.visibility !== 'hidden';
      const row = {
        selector,
        type,
        present: true,
        visible,
        box: box(element),
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        fontLoaded: document.fonts.check(style.fontSize + ' ' + style.fontFamily),
        transform: style.transform,
        translate: style.translate,
        paddingTop: style.paddingTop,
        paddingBottom: style.paddingBottom,
        marginTop: style.marginTop,
        marginBottom: style.marginBottom
      };
      if (type === 'text' && visible) {
        // A DOM Range measures the font-run box, rather than merely its parent
        // control. It is not a measurement of painted glyph ink.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const runs = [];
        let node;
        while ((node = walker.nextNode())) {
          const value = node.textContent;
          if (!value.trim() || node.parentElement.closest('svg, select')) continue;
          const range = document.createRange();
          range.setStart(node, value.search(/\S/));
          range.setEnd(node, value.trimEnd().length);
          runs.push({
            text: range.toString(),
            box: box(range),
            lines: range.getClientRects().length
          });
        }
        row.runs = runs;
      }
      return row;
    });
    const root = getComputedStyle(document.documentElement);
    return {
      label,
      cssWidth: innerWidth,
      dpr: devicePixelRatio,
      sidebar: document.querySelector('.app-shell').dataset.sidebar,
      density: S.settings.density,
      cols: grid.cols,
      width: grid.width,
      offsetX: grid.offsetX,
      base: parseFloat(root.getPropertyValue('--card-base-size')),
      scale: Number(root.getPropertyValue('--card-scale')),
      cards,
      wall,
      main,
      viewport: box(vp),
      rail: { box: rail, visible: visibleRail },
      gap: grid.gap,
      gutter: {
        railGap: left - visibleRail.right,
        windowGap: visibleRail.left,
        gridLeft: left - wall.left,
        gridRight: wall.right - right,
        mainLeft: left - main.left,
        mainRight: main.right - right
      },
      overflow: vp.scrollWidth > vp.clientWidth + 1,
      cached: grid.items.size,
      footer: {
        present: !!folder,
        box: box(footer),
        text: count?.textContent,
        ratingText: rating?.textContent,
        countRuns: textRuns(count),
        ratingRuns: textRuns(rating),
        value: box(value),
        unit: box(unit),
        font: footer && parseFloat(getComputedStyle(footer).fontSize),
        countFont: count && parseFloat(getComputedStyle(count).fontSize),
        fontLoaded:
          count &&
          document.fonts.check(
            getComputedStyle(count).fontSize + ' ' + getComputedStyle(count).fontFamily
          ),
        countOverflow: count && {
          overflow: getComputedStyle(count).overflow,
          textOverflow: getComputedStyle(count).textOverflow,
          transform: getComputedStyle(count).transform,
          whiteSpace: getComputedStyle(count).whiteSpace,
          flexShrink: getComputedStyle(count).flexShrink
        },
        contentOverflow: !!footer && footer.scrollWidth > footer.clientWidth + 1,
        icon: box(icon),
        count: box(count),
        countVisible: visible(count) && visible(value) && visible(unit),
        countUnclipped:
          !!value &&
          value.scrollWidth <= value.clientWidth + 1 &&
          unit.scrollWidth <= unit.clientWidth + 1,
        rating: box(rating),
        ratingFont: rating && parseFloat(getComputedStyle(rating).fontSize),
        ratingVisible: visible(rating),
        cover: box(folder?.querySelector('.cover-shell')),
        fontFamily: count && getComputedStyle(count).fontFamily
      },
      toolbar,
      controls,
      alignment,
      sort: $('#sort').value,
      fontFamily: S.settings.fontFamily,
      actionGaps: [controls[1].left - controls[0].right, controls[2].left - controls[1].right],
      buttons: [...document.querySelectorAll('#card-size-controls [data-density]')].map(
        (button) => ({
          density: Number(button.dataset.density),
          pressed: button.getAttribute('aria-pressed')
        })
      )
    };
  }, label);
  // Retain failed geometry in the report before the first assertion can throw.
  report.samples.push(result);
  assert.ok(
    result.cards.length >= result.cols,
    label + ': enough actual cards to reach both wall edges'
  );
  assert.equal(result.overflow, false, label + ': no horizontal scroll');
  assert.equal(result.offsetX, 0, label + ': no internal centering offset');
  assert.equal(result.rail.visible.clipSupported, true, label + ': measured sidebar clipping');
  assert.ok(Math.abs(result.gutter.gridLeft) <= 1, label + ': cards start at the actual wall left');
  assert.ok(
    Math.abs(result.gutter.railGap - result.gutter.windowGap) <= 1,
    label +
      ': visible sidebar-to-card gap equals window-to-sidebar inset ' +
      JSON.stringify(result.gutter)
  );
  assert.ok(Math.abs(result.gutter.windowGap - 16) <= 1, label + ': actual 16px window-edge inset');
  assert.ok(result.gutter.gridRight >= -0.75);
  assert.ok(
    result.gutter.gridRight < result.width + result.gap + 1,
    label + ': only an incomplete column remains on the right'
  );
  assert.ok(Math.abs(result.width - result.density) <= 0.01, label + ': preserve chosen width');
  assert.ok(result.cached <= 180 * 9, label + ': bounded item window');
  for (const card of result.cards)
    assert.ok(
      Math.abs(card.width - card.expected.width) <= 0.75 &&
        Math.abs(card.left - result.wall.left - card.expected.left) <= 0.75,
      label + ': DOM matches the left-aligned absolute model'
    );
  const footer = result.footer;
  assert.equal(
    footer.present && footer.countVisible && footer.countUnclipped && footer.ratingVisible,
    true,
    label + ': actual count, unit and seeded rating are visible'
  );
  for (const [actual, base] of [
    [footer.font, 14],
    [footer.countFont, 14],
    [footer.icon.width, 20],
    [footer.icon.height, 20],
    [footer.ratingFont, 11]
  ])
    assert.ok(
      Math.abs(actual - base * result.scale) <= 0.1,
      label + ': footer scales from medium=' + base
    );
  assert.equal(footer.text, '99,999 张', label + ': actual maximum-width count markup');
  assert.equal(
    footer.ratingText.replace(/\s+/g, ' ').trim(),
    '★ 10.0',
    label + ': actual rating markup'
  );
  assert.equal(footer.fontLoaded, true, label + ': footer font loaded before measurement');
  assert.equal(
    footer.contentOverflow,
    false,
    label + ': footer has no horizontal content overflow'
  );
  assert.equal(footer.countOverflow.transform, 'none', label + ': no footer count translation');
  assert.equal(footer.countOverflow.overflow, 'visible', label + ': full count without clipping');
  assert.equal(footer.countOverflow.flexShrink, '0', label + ': count cannot shrink');
  assert.equal(footer.countOverflow.whiteSpace, 'nowrap', label + ': count cannot wrap');
  const contains = (outer, inner, name, vertical = true) => {
    assert.ok(
      outer && inner && inner.width > 0 && inner.height > 0,
      label + ': actual bounds ' + name
    );
    assert.ok(
      inner.left >= outer.left - 0.75 &&
        inner.right <= outer.right + 0.75 &&
        (!vertical || (inner.top >= outer.top - 0.75 && inner.bottom <= outer.bottom + 0.75)),
      label + ': uncut ' + name + ' ' + JSON.stringify({ outer, inner })
    );
  };
  contains(footer.cover, footer.box, 'footer inside cover');
  for (const [name, bounds] of [
    ['icon', footer.icon],
    ['count', footer.count],
    ['rating', footer.rating],
    ['value', footer.value],
    ['unit', footer.unit]
  ]) {
    contains(footer.box, bounds, name + ' inside footer');
    assert.ok(Math.abs(bounds.cy - footer.box.cy) <= 1, label + ': shared footer center ' + name);
  }
  for (const [name, runs, parent] of [
    ['count', footer.countRuns, footer.count],
    ['rating', footer.ratingRuns, footer.rating]
  ]) {
    assert.ok(runs.length > 0, label + ': actual footer text ranges ' + name);
    for (const run of runs) {
      assert.equal(run.lines, 1, label + ': single-line footer text ' + run.text);
      contains(parent, run.box, name + ' complete text width', false);
      contains(footer.cover, run.box, name + ' text range inside cover');
    }
  }
  assert.ok(
    footer.icon.right <= footer.count.left + 0.75 &&
      footer.count.right <= footer.rating.left + 0.75,
    label + ': icon, complete count and rating do not overlap'
  );
  assert.ok(
    Math.abs(result.actionGaps[0] - result.actionGaps[1]) <= 0.75,
    label + ': equal action gaps'
  );
  const centered = (bounds, item) => {
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0, label + ': visible ' + item);
    assert.ok(
      Math.abs(bounds.cy - result.toolbar.cy) <= 1,
      label + ': shared toolbar center line ' + item + ' ' + JSON.stringify(bounds)
    );
  };
  for (const item of result.alignment) {
    assert.equal(item.present, true, label + ': required toolbar element ' + item.selector);
    // The card-size caption is deliberately hidden at compact breakpoints.
    if (!item.visible && item.selector === '.card-size-label' && result.cssWidth <= 1200) continue;
    assert.equal(item.visible, true, label + ': visible toolbar item ' + item.selector);
    centered(item.box, item.type + ' ' + item.selector);
    if (item.type !== 'icon') {
      assert.equal(item.transform, 'none', label + ': no per-item transform ' + item.selector);
      assert.equal(item.translate, 'none', label + ': no per-item translate ' + item.selector);
      assert.equal(
        item.paddingTop,
        item.paddingBottom,
        label + ': symmetric padding ' + item.selector
      );
      assert.equal(
        item.marginTop,
        item.marginBottom,
        label + ': symmetric margin ' + item.selector
      );
    }
    if (item.type === 'text') {
      assert.equal(item.fontLoaded, true, label + ': font faces finished loading ' + item.selector);
      assert.equal(item.lineHeight, '20px', label + ': shared text line box ' + item.selector);
      assert.ok(item.runs.length > 0, label + ': actual text range ' + item.selector);
      for (const text of item.runs) {
        assert.equal(text.lines, 1, label + ': no wrapped toolbar text ' + item.selector);
        centered(text.box, 'text range ' + item.selector + ' ' + text.text);
      }
    }
  }
  assert.equal(
    result.buttons.filter((button) => button.pressed === 'true').length,
    result.buttons.some((button) => button.density === result.density) ? 1 : 0
  );
  console.log('PASS ' + label);
  return result;
}
async function choose(index, { resetScroll = true } = {}) {
  const button = page.locator('#card-size-controls [data-density]').nth(index);
  await expect(button).toBeVisible();
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(async (resetScroll) => {
    await window.albumAppearanceControls.flush();
    if (resetScroll) $('#viewport').scrollTop = 0;
    grid.render();
  }, resetScroll);
  await settle();
}
async function probeReadingAnchor(label, anchorKind, action) {
  await page.evaluate(() => {
    const vp = $('#viewport');
    vp.scrollTop = Math.min(640, vp.scrollHeight - vp.clientHeight);
    grid.render();
  });
  await settle();
  const before = await page.evaluate((anchorKind) => {
    const vp = $('#viewport'),
      anchor = anchorKind === 'display' ? captureDisplayAnchor() : grid.captureAnchor(),
      element = anchor && grid.cards.get(anchor.index);
    if (!element) throw new Error('Reading anchor must have a mounted card');
    const bounds = element.getBoundingClientRect(),
      origin = vp.getBoundingClientRect();
    return {
      index: anchor.index,
      id: element.dataset.id,
      offset: bounds.top - origin.top,
      scrollTop: vp.scrollTop,
      density: S.settings.density
    };
  }, anchorKind);
  assert.ok(before.scrollTop > 100, label + ': anchor probe actually starts scrolled');
  const evidence = { label, anchorKind, before };
  report.anchorProbes.push(evidence);
  await action();
  await settle();
  const after = await page.evaluate(({ index }) => {
    const vp = $('#viewport'),
      element = grid.cards.get(index);
    if (!element) throw new Error('Original reading anchor was not retained after layout change');
    const bounds = element.getBoundingClientRect(),
      origin = vp.getBoundingClientRect();
    return {
      id: element.dataset.id,
      index,
      offset: bounds.top - origin.top,
      scrollTop: vp.scrollTop,
      density: S.settings.density,
      cached: grid.items.size,
      overflow: vp.scrollWidth > vp.clientWidth + 1,
      offsetX: grid.offsetX
    };
  }, before);
  evidence.after = after;
  evidence.drift = after.offset - before.offset;
  assert.equal(after.id, before.id, label + ': same actual reading card');
  assert.ok(
    Math.abs(evidence.drift) <= 1,
    label + ': reading pixel anchor drift ' + evidence.drift
  );
  assert.equal(after.offsetX, 0, label + ': reading layout remains left aligned');
  assert.equal(after.overflow, false, label + ': reading layout has no horizontal overflow');
  assert.ok(after.cached <= 180 * 9, label + ': reading cache remains bounded');
  if (anchorKind !== 'display')
    assert.equal(
      after.density,
      before.density,
      label + ': explicit numeric width survives layout change'
    );
  evidence.passed = true;
}
async function sampleSortLabels(fontLabel) {
  const values = await page
    .locator('#sort')
    .evaluate((select) =>
      [...select.options].filter((option) => !option.disabled).map((option) => option.value)
    );
  for (const [index, value] of values.entries()) {
    const button = page.locator('#toolbar .sort-label .album-select-button');
    await button.focus();
    await page.keyboard.press('Home');
    for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#sort')).toHaveValue(value);
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await settle();
    const evidence = await sample('1920/expanded/small/' + fontLabel + '/sort-' + value);
    assert.equal(evidence.sort, value);
  }
}
async function screenshot(width) {
  if (report.screenshots.length >= 3) return;
  const clip = await page.evaluate(() => {
    const r = document.querySelector('main').getBoundingClientRect();
    return {
      x: Math.max(0, r.left),
      y: 0,
      width: Math.min(1100, innerWidth - Math.max(0, r.left)),
      height: Math.min(560, innerHeight)
    };
  });
  const file = path.join(run, 'responsive-' + width + '.png');
  await page.screenshot({ path: file, clip, scale: 'css' });
  report.screenshots.push(file);
}
(async () => {
  await prepare();
  await launch();
  for (const [width, expected] of [
    [1920, [120, 155, 191]],
    [2560, [124, 150, 188]],
    [3840, [135, 165, 192]]
  ]) {
    assert.deepEqual(await resize(width), expected);
    for (const sidebar of ['compact', 'expanded']) {
      await page.evaluate(async (sidebar) => {
        await saveSetting('sidebarMode', sidebar);
        $('#viewport').scrollTop = 0;
        grid.render();
      }, sidebar);
      await settle();
      for (const index of [1, 0, 2]) {
        await choose(index);
        const evidence = await sample(
          width + '/' + sidebar + '/' + ['small', 'medium', 'large'][index]
        );
        assert.equal(evidence.density, expected[index]);
        assert.equal(evidence.sidebar, sidebar);
        if (index === 1 && sidebar === 'compact') await screenshot(width);
      }
    }
  }
  for (const index of [0, 1, 2])
    await probeReadingAnchor('3840/preset-' + index, 'display', () =>
      choose(index, { resetScroll: false })
    );
  await probeReadingAnchor('resize-3840-to-2560', 'grid', () => resize(2560));
  await probeReadingAnchor('sidebar-expanded-to-compact', 'grid', () =>
    page.evaluate(() => saveSetting('sidebarMode', 'compact'))
  );
  await probeReadingAnchor('sidebar-compact-to-expanded', 'grid', () =>
    page.evaluate(() => saveSetting('sidebarMode', 'expanded'))
  );
  await probeReadingAnchor('resize-2560-to-3840', 'grid', () => resize(3840));
  await resize(2560);
  await page.evaluate(async () => {
    await changeDisplaySetting('density', 120);
    $('#viewport').scrollTop = 0;
    grid.render();
  });
  await settle();
  const minimum = await sample('2560/expanded/manual-120/base-150');
  assert.equal(minimum.density, 120);
  assert.equal(minimum.base, 150);
  await page.evaluate(async () => changeDisplaySetting('density', 222));
  await resize(2560);
  const custom = await sample('2560/expanded/custom-222');
  assert.equal(custom.density, 222, 'Resize preserves an explicit continuous numeric width');
  assert.equal((await rpc('init', { lightweight: true })).settings.density, 222);
  await resize(1920);
  await choose(0);
  await sampleSortLabels('configured-font');
  await page.evaluate(async () => {
    await saveSetting('fontFamily', 'Microsoft YaHei UI');
    await document.fonts.ready;
  });
  await settle();
  await sampleSortLabels('Microsoft-YaHei-UI');
  const state = await rpc('init', { lightweight: true });
  assert.equal(state.settings.autoMatch, false);
  assert.equal(!!state.online.active, false);
  assert.equal(Number(state.online.remaining ?? state.online.pending ?? 0), 0);
  report.unhandled = await page.evaluate(() => window.__responsiveRejections);
  assert.deepEqual(report.unhandled, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.remote, []);
  assert.deepEqual(
    report.originals,
    [],
    'Thumbnail-only renderer: no original/preview/frame loading'
  );
  report.passed = true;
})()
  .catch((error) => {
    report.error = error.stack || String(error);
    console.error(report.error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (app) {
      try {
        report.blocked = await app.evaluate(() => globalThis.__responsiveBlocked || []);
        assert.deepEqual(
          report.blocked,
          [],
          'No external network attempt during offline geometry checks'
        );
      } catch (error) {
        report.passed = false;
        report.closeError = error.stack || String(error);
        process.exitCode = 1;
      }
      const owned = app;
      let timer;
      try {
        await Promise.race([
          owned.close(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Owned Electron close timed out')), 15000);
          })
        ]);
      } catch (error) {
        report.passed = false;
        report.closeError = error.stack || String(error);
        process.exitCode = 1;
        if (owned.process().exitCode === null) owned.process().kill();
      } finally {
        clearTimeout(timer);
      }
    }
    report.finished = new Date().toISOString();
    if (run) {
      const file = path.join(run, 'report.json');
      await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
      console.log('REPORT ' + file);
    }
  });
