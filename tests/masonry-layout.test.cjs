'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/masonry.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
const thumbSource = appSource.slice(
  appSource.indexOf('function thumb('),
  appSource.indexOf('function applySettings()')
);

function element(id, document) {
  const shell = { style: {} },
    info = { style: {} },
    image = {
      style: {},
      writes: [],
      getAttribute: (name) => (name === 'src' ? image.src : null),
      get src() {
        return this.writes.at(-1) || '';
      },
      set src(value) {
        this.writes.push(value);
      }
    };
  const node = {
    dataset: id ? { id: String(id) } : {},
    style: {},
    removals: 0,
    focusCalls: [],
    focus(options) {
      this.focusCalls.push(options);
      document.activeElement = node;
    },
    contains: (child) => child === node,
    get nextElementSibling() {
      return this.parent?.children[this.parent.children.indexOf(node) + 1] || null;
    },
    remove() {
      this.removals++;
      if (document.activeElement === node) document.activeElement = null;
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(node), 1);
      this.parent = null;
    },
    setAttribute() {},
    querySelector: (selector) =>
      selector === '.cover-shell'
        ? shell
        : selector === '.card-info'
          ? info
          : selector === 'img' && id
            ? image
            : null
  };
  return node;
}
async function fixture(folders, media, width = 1180, density = 222, dpr = 1) {
  const viewport = { scrollTop: 0, clientHeight: 800, getBoundingClientRect: () => ({ top: 0 }) };
  const document = { activeElement: null, createElement: () => element(null, document) };
  const wall = {
    clientWidth: width,
    style: {},
    children: [],
    moves: [],
    replaceChildren() {
      for (const b of [...this.children]) b.remove();
    },
    append(b) {
      place(b, null, false, 'append');
    },
    moveBefore(b, before) {
      place(b, before, true, 'moveBefore');
    },
    insertBefore(b, before) {
      place(b, before, false, 'insertBefore');
    },
    getBoundingClientRect: () => ({ top: -viewport.scrollTop })
  };
  function place(b, before, preserveFocus, method) {
    assert.ok(before === null || wall.children.includes(before));
    if (b.parent) {
      b.parent.children.splice(b.parent.children.indexOf(b), 1);
      if (!preserveFocus && b.contains(document.activeElement)) document.activeElement = null;
    }
    const index = before === null ? wall.children.length : wall.children.indexOf(before);
    wall.children.splice(index, 0, b);
    b.parent = wall;
    wall.moves.push({ b, method });
  }
  const settings = { density, ratio: 'poster', details: true };
  const calls = [],
    errors = [],
    created = [],
    opened = [],
    nodes = new Map();
  const make = (index) => ({
    ...(nodes.get(index) ||
      (index < folders
        ? { id: 'folder-' + index, kind: 'folder' }
        : {
            id: 'image-' + index,
            kind: 'image',
            width: 300,
            height: (index - folders) % 3 === 0 ? 1800 : (index - folders) % 3 === 1 ? 150 : 650
          }))
  });
  const context = vm.createContext({
    S: { settings, loadVersion: 1, rev: 1 },
    window: { devicePixelRatio: dpr },
    AbortController,
    console,
    $: (selector) => (selector === '#virtual-grid' ? wall : viewport),
    card: (node, index, inline, columnWidth, priority) => {
      const b = element(node.id, document);
      b.dataset.index = String(index);
      b.querySelector('img').src = context.thumb(node, columnWidth, priority);
      b.onclick = () => context.openViewer(node, index);
      created.push(b);
      return b;
    },
    document,
    attempt: (action) => action(),
    openViewer: (node, index) => opened.push({ id: node.id, index }),
    navigate: (args) => opened.push(args),
    toast: (message) => errors.push(message),
    api: async (_, args) => {
      calls.push(args.offset);
      return {
        total: folders + media,
        folders,
        items: Array.from({ length: Math.min(180, folders + media - args.offset) }, (_, i) =>
          make(args.offset + i)
        )
      };
    }
  });
  vm.runInContext(thumbSource, context);
  vm.runInContext(source, context);
  const grid = context.createVirtualGrid();
  await grid.load({}, 1);
  async function settle() {
    for (let i = 0; i < 12 && grid.loading.size; i++)
      await Promise.all([...grid.loading.values()].map((request) => request.promise));
    assert.equal(grid.loading.size, 0);
    assert.deepEqual(errors, []);
  }
  await settle();
  return {
    grid,
    viewport,
    wall,
    settings,
    calls,
    errors,
    settle,
    make,
    nodes,
    document,
    created,
    opened,
    context
  };
}
function disjoint(a, b) {
  return (
    a.left + a.width <= b.left + 0.001 ||
    b.left + b.width <= a.left + 0.001 ||
    a.top + a.height <= b.top + 0.001 ||
    b.top + b.height <= a.top + 0.001
  );
}

test('mixed folder/image cards share the final partial row across density and absolute-page boundaries', async () => {
  for (const width of [700, 1180])
    for (const density of [158, 222]) {
      const probe = await fixture(1, 1, width, density);
      const cols = probe.grid.cols;
      probe.grid.reset();
      for (const folders of new Set([0, 1, cols - 1, cols, cols + 1, 179, 180, 181, 360])) {
        const f = await fixture(folders, 220, width, density),
          { grid } = f;
        // This page is deliberately not assumed to be the page containing the
        // last folder: exactly 180 folders places it in the following API page.
        await grid.fetchPage(Math.floor(folders / 180));
        await grid.fetchPage(Math.floor((folders + 199) / 180));
        await f.settle();
        grid.layout(false);
        if (folders % grid.cols) {
          const folder = grid.getPosition(folders - 1),
            image = grid.getPosition(folders);
          assert.equal(
            image.top,
            folder.top,
            `No type break for F=${folders}, W=${width}, w=${density}`
          );
          assert.ok(image.left >= folder.left + folder.width + 7.99);
        }
        const indices = [];
        for (let i = Math.max(0, folders - grid.cols); i < folders + 200; i++) indices.push(i);
        const rectangles = indices.map((i) => grid.getPosition(i));
        for (let i = 0; i < rectangles.length; i++) {
          const r = rectangles[i];
          assert.ok(r.left >= 0 && r.left + r.width <= width + 0.001);
          for (let j = i + 1; j < rectangles.length; j++)
            assert.ok(
              disjoint(r, rectangles[j]),
              `Overlap F=${folders}: ${indices[i]} / ${indices[j]}`
            );
        }
        grid.reset();
      }
    }
});

test('boundary placeholders stay beside folders and media respects folder-height limits across settings', async () => {
  const f = await fixture(181, 500),
    { grid, settings } = f;
  // Page 1 is initially unloaded because the viewport is near folder 0.
  const before = grid.getPosition(181),
    folder = grid.getPosition(180);
  assert.equal(before.top, folder.top);
  assert.ok(disjoint(before, folder));
  await grid.fetchPage(1);
  grid.layout(false);
  const tall = grid.getPosition(181),
    originalFolder = grid.getPosition(180);
  assert.equal(tall.height, originalFolder.height * 2);
  const natural = grid.getPosition(182);
  assert.ok(Math.abs(natural.height - 48 - natural.width / 2) < 0.001);
  settings.ratio = 'square';
  grid.layout(false);
  assert.equal(grid.getPosition(181).height, grid.getPosition(180).height * 2);
  assert.notEqual(grid.getPosition(180).height, originalFolder.height);
  assert.equal(grid.getPosition(182).height, natural.height);
  settings.details = false;
  grid.layout(false);
  assert.equal(grid.getPosition(181).height, grid.getPosition(180).height * 2);
  assert.ok(Math.abs(grid.getPosition(182).height - (natural.height - 48)) < 0.001);
  assert.equal(grid.getPosition(180).height, grid.width + 40);
  grid.reset();
});

test('folder details reclaim each row while retaining titles, cards and scroll anchors', async () => {
  for (const width of [700, 3448])
    for (const density of [158, 222]) {
      const f = await fixture(500, 0, width, density),
        { grid, settings, viewport, wall } = f,
        index = grid.cols * 3;
      grid.restoreAnchor(index, 96);
      await f.settle();
      const anchor = grid.captureAnchor(88),
        before = grid.getPosition(anchor.index),
        b = grid.cards.get(anchor.index),
        info = b.querySelector('.card-info'),
        image = b.querySelector('img'),
        extent = Number.parseFloat(wall.style.height),
        rows = Math.ceil(grid.total / grid.cols);
      for (const details of [false, true, false, true]) {
        settings.details = details;
        grid.layout(false);
        grid.restoreAnchor(anchor.index, anchor.offset);
        await f.settle();
        const current = grid.getPosition(anchor.index);
        assert.equal(current.height, before.height - (details ? 0 : 30));
        assert.equal(grid.rowHeight, current.height + 19);
        assert.ok(
          Math.abs(current.top - viewport.scrollTop - anchor.offset) < 0.001,
          'The visible folder remains at the same viewport pixel'
        );
        assert.ok(
          Math.abs(Number.parseFloat(wall.style.height) - (extent - (details ? 0 : rows * 30))) <
            0.001,
          'Every folder row gives back its hidden subtitle space'
        );
        assert.equal(grid.cards.get(anchor.index), b);
        assert.equal(image.writes.length, 1, 'Details changes retain decoded covers');
        assert.equal(info.hidden, false, 'Folder titles remain visible');
        assert.equal(info.style.display, '');
        assert.equal(info.style.height, details ? '70px' : '40px');
      }
      grid.reset();
    }
});

test('mixed boundary rows reflow without overlap when folder and media details change together', async () => {
  const f = await fixture(181, 360),
    { grid, settings, viewport } = f;
  grid.restoreAnchor(180, 96);
  await f.settle();
  const anchor = grid.captureAnchor(88),
    before = grid.getPosition(180);
  for (const details of [false, true, false]) {
    settings.details = details;
    grid.layout(false);
    grid.restoreAnchor(anchor.index, anchor.offset);
    await f.settle();
    const folder = grid.getPosition(180),
      media = grid.getPosition(181);
    assert.equal(folder.height, before.height - (details ? 0 : 30));
    assert.equal(folder.top, media.top, 'The partial boundary row stays shared');
    assert.equal(
      media.height,
      folder.height * 2,
      'The media cap follows the visible folder height'
    );
    assert.ok(
      Math.abs(grid.getPosition(anchor.index).top - viewport.scrollTop - anchor.offset) < 0.001
    );
    const rectangles = Array.from({ length: 40 }, (_, i) => grid.getPosition(175 + i));
    for (let i = 0; i < rectangles.length; i++)
      for (let j = i + 1; j < rectangles.length; j++)
        assert.ok(disjoint(rectangles[i], rectangles[j]), `Details=${details}: overlap ${i}/${j}`);
  }
  grid.reset();
});

test('deep jumps keep bounded pages, tall visible cards and pixel anchors through resizing', async () => {
  const f = await fixture(1, 12000),
    { grid, viewport, wall, settings } = f;
  grid.restoreAnchor(1, 0);
  viewport.scrollTop = grid.getPosition(1).top + grid.getPosition(1).height / 2;
  grid.render();
  await f.settle();
  assert.ok(grid.cards.has(1), 'A tall image spanning the viewport remains rendered');
  grid.restoreAnchor(11000, 0);
  await f.settle();
  assert.ok(grid.items.has(11000));
  assert.ok(grid.items.size <= 180 * 9, 'Deep jump does not load predecessors');
  assert.ok(f.calls.length < 15);
  const anchor = grid.captureAnchor();
  settings.density = 158;
  wall.clientWidth = 980;
  grid.render();
  await f.settle();
  assert.ok(
    Math.abs(grid.getPosition(anchor.index).top - viewport.scrollTop - anchor.offset) < 0.001
  );
  assert.ok(grid.cards.size < 180);
  grid.reset();
});

test('folder-only and empty views keep fixed cards and valid extents', async () => {
  for (const folders of [0, 1, 17]) {
    const f = await fixture(folders, 0),
      { grid, wall } = f;
    grid.layout(false);
    assert.ok(Number.parseFloat(wall.style.height) >= 0);
    if (folders) {
      assert.equal(grid.gap, 19);
      assert.equal(grid.getPosition(0).height, grid.width / (3 / 4.12) + 70);
    }
    grid.reset();
  }
});

test('identical 180-row refreshes retain visible media/folder DOM, decoded sources and focus', async (t) => {
  for (const folders of [0, 2, 180]) {
    const f = await fixture(folders, 180 - folders),
      { grid, document, created, context, wall } = f;
    if (!folders) {
      for (let i = 0; i < 180; i++) f.nodes.set(i, { ...f.make(i), width: 300, height: 450 });
      await grid.refreshVisible();
      assert.equal(grid.cards.size, 15);
    }
    const previous = new Map(grid.cards),
      count = created.length,
      focused = previous.values().next().value;
    focused.focus();
    wall.moves.length = 0;
    for (let i = 0; i < 3; i++) {
      context.S.rev++;
      await grid.refreshVisible();
      await f.settle();
      assert.equal(grid.items.size, 180);
      assert.equal(created.length, count, 'No new card for an identical page');
      assert.equal(wall.moves.length, 0, 'Unchanged cards are never moved');
      assert.equal(grid.cards.size, previous.size);
      for (const [index, b] of previous) {
        assert.equal(grid.cards.get(index), b);
        assert.equal(b.removals, 0);
        assert.equal(b.querySelector('img').writes.length, 1, 'S.rev alone never reloads a cover');
      }
      assert.equal(document.activeElement, focused);
    }
    t.diagnostic(
      `folders=${folders}: ${previous.size} visible, ${previous.size} retained, ${created.length - count} new cards`
    );
    grid.reset();
  }
});

test('changed cards alone are replaced and dimensions rebuild non-overlapping geometry', async () => {
  const f = await fixture(0, 180),
    { grid, nodes, created, wall } = f,
    oldCards = new Map(grid.cards),
    unchanged = oldCards.get(1),
    original = grid.getPosition(0);
  nodes.set(0, { ...f.make(0), height: 150 });
  nodes.set(2, { ...f.make(2), favorite: true });
  await grid.refreshVisible();
  await f.settle();
  assert.notEqual(grid.cards.get(0), oldCards.get(0));
  assert.notEqual(grid.cards.get(2), oldCards.get(2));
  assert.equal(oldCards.get(0).removals, 1);
  assert.equal(oldCards.get(2).removals, 1);
  assert.equal(grid.cards.get(1), unchanged);
  const current = grid.getPosition(0);
  assert.equal(current.height, (grid.width * 150) / 300 + 48);
  assert.notEqual(current.height, original.height);
  assert.equal(Number.parseFloat(grid.cards.get(0).style.height), current.height);
  const rectangles = Array.from({ length: 180 }, (_, index) => grid.getPosition(index));
  for (let i = 0; i < rectangles.length; i++) {
    const a = rectangles[i];
    assert.ok(a.left >= 0 && a.left + a.width <= wall.clientWidth);
    for (let j = i + 1; j < rectangles.length; j++)
      assert.ok(disjoint(a, rectangles[j]), `Refreshed rectangles overlap: ${i}/${j}`);
  }
  assert.ok(
    Number.parseFloat(wall.style.height) >= Math.max(...rectangles.map((p) => p.top + p.height))
  );
  for (const [index, b] of oldCards)
    if (index !== 0 && index !== 2 && grid.cards.has(index)) assert.equal(grid.cards.get(index), b);
  assert.equal(
    created.filter((b) => ![...oldCards.values()].includes(b)).length,
    [...grid.cards.values()].filter((b) => ![...oldCards.values()].includes(b)).length,
    'Only changed/newly visible cards are created'
  );
  grid.reset();
});

test('reordered IDs keep DOM reading order, focus and anchors with moveBefore and insertBefore fallback', async () => {
  for (const nativeMove of [true, false]) {
    const f = await fixture(0, 180),
      { grid, nodes, document, viewport, opened, wall } = f;
    if (!nativeMove) wall.moveBefore = undefined;
    for (let i = 0; i < 180; i++) nodes.set(i, { ...f.make(i), width: 300, height: 300 });
    await grid.refreshVisible();
    const anchor = grid.captureAnchor(),
      first = f.make(0),
      shifted = f.make(5),
      focused = grid.cards.get(0);
    assert.equal(anchor.index, 0);
    focused.focus();
    wall.moves.length = 0;
    nodes.set(0, shifted);
    nodes.set(5, first);
    await grid.refreshVisible();
    assert.equal(grid.cards.get(5), focused);
    assert.equal(document.activeElement, focused);
    assert.equal(focused.removals, 0);
    assert.equal(focused.dataset.index, '5');
    assert.equal(focused.dataset.gridIndex, '5');
    focused.onclick();
    assert.deepEqual(opened, [{ id: first.id, index: 5 }]);
    assert.equal(grid.getPosition(5).top - viewport.scrollTop, anchor.offset);
    assert.equal(grid.items.get(0).id, shifted.id);
    assert.deepEqual(
      wall.children.map((b) => Number(b.dataset.gridIndex)),
      [...grid.cards.keys()].sort((a, b) => a - b),
      'Tab/reading order follows the visual item order'
    );
    const moves = wall.moves.filter(({ method }) => method !== 'append');
    assert.deepEqual(
      moves.map(({ b }) => Number(b.dataset.gridIndex)).sort((a, b) => a - b),
      [0, 5]
    );
    assert.ok(moves.every(({ method }) => method === (nativeMove ? 'moveBefore' : 'insertBefore')));
    assert.equal(focused.focusCalls.length, nativeMove ? 1 : 2);
    if (!nativeMove) assert.equal(focused.focusCalls.at(-1).preventScroll, true);
    grid.reset();
  }
});

test('IDs moving across the 180-row refresh boundary preserve their cards and focus', async () => {
  const f = await fixture(0, 360),
    { grid, nodes, document, opened } = f;
  for (let i = 0; i < 360; i++) nodes.set(i, { ...f.make(i), width: 300, height: 300 });
  await grid.refreshVisible();
  grid.restoreAnchor(178, 0);
  await f.settle();
  const before = grid.cards.get(179),
    after = grid.cards.get(180),
    first = f.make(179),
    second = f.make(180);
  assert.ok(before && after);
  before.focus();
  nodes.set(179, second);
  nodes.set(180, first);
  await grid.refreshVisible();
  assert.equal(grid.cards.get(180), before);
  assert.equal(grid.cards.get(179), after);
  assert.equal(before.removals, 0);
  assert.equal(after.removals, 0);
  assert.equal(document.activeElement, before);
  before.onclick();
  assert.deepEqual(opened, [{ id: first.id, index: 180 }]);
  grid.reset();
});

test('a failed page keeps the entire two-page refresh unchanged and a retry commits unique IDs', async () => {
  const f = await fixture(0, 360),
    { grid, context, nodes, document, wall, errors } = f;
  for (let i = 0; i < 360; i++) nodes.set(i, { ...f.make(i), width: 300, height: 300 });
  await grid.refreshVisible();
  grid.restoreAnchor(178, 0);
  await f.settle();
  assert.equal(grid.items.size, 360);
  const oldItems = new Map(grid.items),
    oldCards = new Map(grid.cards),
    oldOrder = [...wall.children],
    before = grid.cards.get(179),
    after = grid.cards.get(180),
    first = f.make(179),
    second = f.make(180),
    api = context.api;
  before.focus();
  nodes.set(179, second);
  nodes.set(180, first);
  context.api = async (method, args) => {
    if (args.offset === 180) throw new Error('page 1 failed');
    return api(method, args);
  };
  wall.moves.length = 0;
  await grid.refreshVisible();
  assert.deepEqual(errors.splice(0), ['page 1 failed']);
  assert.equal(grid.items.size, 360);
  assert.equal(new Set([...grid.items.values()].map((n) => n.id)).size, 360);
  for (const [index, n] of oldItems) assert.equal(grid.items.get(index), n);
  for (const [index, b] of oldCards) {
    assert.equal(grid.cards.get(index), b);
    assert.equal(b.removals, 0);
  }
  assert.deepEqual(wall.children, oldOrder);
  assert.equal(wall.moves.length, 0);
  assert.equal(document.activeElement, before);
  context.api = api;
  await grid.refreshVisible();
  await f.settle();
  assert.equal(grid.items.get(179).id, second.id);
  assert.equal(grid.items.get(180).id, first.id);
  assert.equal(grid.items.size, 360);
  assert.equal(new Set([...grid.items.values()].map((n) => n.id)).size, 360);
  assert.equal(grid.cards.get(179), after);
  assert.equal(grid.cards.get(180), before);
  assert.equal(document.activeElement, before);
  assert.deepEqual(
    wall.children.map((b) => Number(b.dataset.gridIndex)),
    [...grid.cards.keys()].sort((a, b) => a - b)
  );
  grid.reset();
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('a newer refresh supersedes partially received pages without applying stale data', async () => {
  const f = await fixture(0, 360),
    { grid, context, nodes } = f;
  for (let i = 0; i < 360; i++) nodes.set(i, { ...f.make(i), width: 300, height: 300 });
  await grid.refreshVisible();
  grid.restoreAnchor(178, 0);
  await f.settle();
  const requests = [],
    original = grid.cards.get(179),
    page = (offset, name) => ({
      total: 360,
      folders: 0,
      items: Array.from({ length: 180 }, (_, i) => ({ ...f.make(offset + i), name }))
    });
  context.api = (_, args) => {
    const request = { ...deferred(), offset: args.offset };
    requests.push(request);
    return request.promise;
  };
  const older = grid.refreshVisible(),
    firstPage = grid.loading.get(0).promise;
  assert.equal(requests.length, 2);
  requests[0].resolve(page(0, 'stale'));
  await firstPage;
  assert.equal(grid.cards.get(179), original, 'A partial batch does not touch the DOM');
  const newer = grid.refreshVisible();
  await older;
  assert.equal(
    grid.cards.get(179),
    original,
    'The superseded batch cannot apply its completed page'
  );
  assert.equal(requests.length, 4);
  requests[2].resolve(page(0, 'fresh'));
  requests[3].resolve(page(180, 'fresh'));
  await newer;
  requests[1].resolve(page(180, 'stale'));
  await requests[1].promise;
  await f.settle();
  assert.equal(grid.items.get(179).name, 'fresh');
  assert.equal(grid.items.get(180).name, 'fresh');
  grid.reset();
});

test('refresh responses after navigation cannot mutate the new page or clear its pending request', async () => {
  const f = await fixture(0, 180),
    { grid, context } = f,
    old = deferred(),
    fresh = deferred();
  context.api = (_, args) => (args.parent === 'new' ? fresh.promise : old.promise);
  const refresh = grid.refreshVisible();
  context.S.loadVersion = 2;
  const navigation = grid.load({ parent: 'new' }, 2),
    newRequest = grid.loading.get(0);
  await refresh;
  assert.equal(grid.loading.get(0), newRequest);
  fresh.resolve({
    total: 1,
    folders: 0,
    items: [{ id: 'new-page', kind: 'image', width: 400, height: 200 }]
  });
  await navigation;
  const current = grid.cards.get(0);
  old.resolve({
    total: 180,
    folders: 0,
    items: [{ id: 'old-page', kind: 'image', width: 1, height: 999 }]
  });
  await old.promise;
  await f.settle();
  assert.equal(grid.items.get(0).id, 'new-page');
  assert.equal(grid.cards.get(0), current);
  assert.equal(grid.total, 1);
  assert.equal(grid.items.size, 1);
  assert.equal(grid.cards.size, 1);
  grid.reset();
});

test('existing thumbnails change size tiers at DPR 1/2 thresholds without replacing DOM or losing anchors', async () => {
  for (const [folders, dpr] of [
    [0, 1],
    [0, 2],
    [180, 1],
    [180, 2]
  ]) {
    const f = await fixture(folders, 180 - folders, 1400, 158, dpr),
      { grid, settings, context, viewport, wall } = f,
      b = grid.cards.get(0),
      img = b.querySelector('img'),
      anchor = grid.captureAnchor();
    let writes = 1,
      tier = 512;
    for (const [density, expected] of [
      [222, dpr === 2 ? 768 : 512],
      [512 / (dpr * 1.3), 512],
      [512 / (dpr * 1.3) + 0.01, 768],
      [768 / (dpr * 1.3), 768],
      [768 / (dpr * 1.3) + 0.01, 1024],
      [158, 512]
    ]) {
      settings.density = density;
      // Exact fitted widths isolate the tier thresholds from remainder sharing.
      const gap = folders ? 19 : 8;
      wall.clientWidth = density * 5 + gap * 4;
      context.S.rev++;
      grid.render();
      if (expected !== tier) writes++;
      tier = expected;
      assert.equal(grid.cards.get(0), b);
      assert.equal(img.writes.length, writes);
      assert.match(img.src, new RegExp('[?&]size=' + expected + '(?:&|$)'));
      assert.equal(grid.getPosition(anchor.index).top - viewport.scrollTop, anchor.offset);
      context.S.rev++;
      settings.ratio = settings.ratio === 'poster' ? 'square' : 'poster';
      settings.details = !settings.details;
      grid.render();
      assert.equal(grid.cards.get(0), b);
      assert.equal(
        img.writes.length,
        writes,
        'Details, ratio and revision do not restart requests'
      );
      assert.equal(grid.getPosition(anchor.index).top - viewport.scrollTop, anchor.offset);
    }
    grid.reset();
  }
});

test('initial image requests use the fitted DPR tier once and prioritize the viewport over overscan', async () => {
  const f = await fixture(0, 180, 1400, 222, 2);
  for (const [index, card] of f.grid.cards) {
    const image = card.querySelector('img'),
      position = f.grid.getPosition(index),
      inViewport = position.top + position.height > 0 && position.top < f.viewport.clientHeight;
    assert.equal(image.writes.length, 1, 'No initial default-tier request before fitted tier');
    assert.equal(new URL(image.src).searchParams.get('size'), '768');
    assert.equal(new URL(image.src).searchParams.get('p') === '1', inViewport);
  }
  f.grid.reset();
});

test('an empty resize before an asynchronous list response selects the final layout gap', async (t) => {
  for (const [folders, media] of [
    [0, 80],
    [80, 0],
    [1, 80]
  ]) {
    const f = await fixture(folders, media, 1752, 186),
      { grid, context, wall } = f,
      originalApi = context.api;
    let release;
    const responseReady = new Promise((resolve) => {
      release = resolve;
    });
    context.api = async (...args) => {
      await responseReady;
      return originalApi(...args);
    };
    const loading = grid.load({}, 1);
    // The host ResizeObserver can run after active=true but before list() returns.
    grid.layout();
    assert.equal(grid.total, 0);
    assert.equal(grid.gap, 19);
    assert.equal(grid.cols, 8);
    release();
    await loading;
    await f.settle();
    const gap = media ? 8 : 19,
      expectedColumns = Math.floor((wall.clientWidth + gap) / (186 + gap)),
      modelRight = Math.max(
        ...Array.from({ length: grid.total }, (_, i) => {
          const p = grid.getPosition(i);
          return p.left + p.width;
        })
      ),
      domRight = Math.max(
        ...[...grid.cards.values()].map(
          (card) => parseFloat(card.style.left) + parseFloat(card.style.width)
        )
      );
    t.diagnostic(
      JSON.stringify({
        folders,
        media,
        columns: grid.cols,
        gap: grid.gap,
        rightError: wall.clientWidth - domRight
      })
    );
    assert.equal(grid.gap, gap);
    assert.equal(grid.cols, expectedColumns);
    const expectedRight = expectedColumns * 186 + (expectedColumns - 1) * gap;
    assert.ok(Math.abs(modelRight - expectedRight) < 0.001);
    assert.ok(Math.abs(domRight - expectedRight) < 0.001);
    assert.ok(expectedRight <= wall.clientWidth);
    grid.reset();
  }
});

test('continuous card width stays fixed and left aligned at 4K and clamps to narrow widths', async () => {
  for (const width of [96, 120, 700, 1180, 3448, 3840])
    for (const density of [120, 158, 186, 222, 297, 360])
      for (const [folders, media] of [
        [90, 0],
        [0, 90],
        [1, 90]
      ]) {
        const f = await fixture(folders, media, width, density),
          { grid } = f,
          gap = media ? 8 : 19,
          columns = Math.max(1, Math.floor((width + gap) / (density + gap)));
        assert.equal(grid.cols, columns);
        assert.equal(grid.gap, gap);
        for (let column = 0; column < columns; column++) {
          const p = grid.getPosition(column);
          assert.ok(Math.abs(p.width - Math.min(width, density)) < 0.001);
          assert.ok(Math.abs(p.left - column * (grid.width + gap)) < 0.001);
          assert.ok(p.left + p.width <= width + 0.001);
          if (column === columns - 1)
            assert.ok(
              width - p.left - p.width < density + gap,
              'Trailing space cannot fit another requested card'
            );
        }
        grid.reset();
      }
});

test('extreme images and videos cap total height at twice a same-width folder for every ratio and detail mode', async () => {
  const mediaStyles = fs.readFileSync(path.join(__dirname, '../src/ui/media.css'), 'utf8');
  assert.match(
    mediaStyles,
    /\.media-card\[data-media-clamped='true'\] \.cover-shell img:not\(\.icon-cover\)\s*\{\s*object-fit: cover;\s*object-position: top !important;/,
    'Clamped media must override the inline centered position written by applyCoverCrop'
  );
  for (const width of [700, 3448])
    for (const density of [158, 222]) {
      const f = await fixture(1, 360, width, density),
        { grid, nodes, settings, wall } = f;
      nodes.set(1, { ...f.make(1), width: 1, height: 100000000 });
      nodes.set(2, { ...f.make(2), kind: 'video', width: 200, height: 1000000 });
      nodes.set(3, { ...f.make(3), width: 0, height: 0 });
      await grid.refreshVisible();
      for (const ratio of ['poster', 'tall', 'square'])
        for (const details of [true, false]) {
          settings.ratio = ratio;
          settings.details = details;
          grid.render();
          await f.settle();
          const folder = grid.getPosition(0);
          for (const index of [1, 2]) {
            const p = grid.getPosition(index);
            assert.equal(p.width, folder.width);
            assert.equal(p.height, folder.height * 2);
            const b = grid.cards.get(index);
            assert.equal(b.dataset.mediaClamped, 'true');
            assert.equal(Number.parseFloat(b.style.height), p.height);
            assert.equal(
              Number.parseFloat(b.querySelector('.cover-shell').style.height) + (details ? 48 : 0),
              p.height
            );
          }
          assert.equal(grid.cards.get(0).dataset.mediaClamped, 'false');
          assert.equal(grid.cards.get(3).dataset.mediaClamped, 'false');
          assert.equal(grid.cards.get(5).dataset.mediaClamped, 'false');
          const missing = grid.getPosition(3);
          assert.ok(Number.isFinite(missing.height) && missing.height <= folder.height * 2);
          assert.ok(Number.parseFloat(wall.style.height) >= grid.getPosition(1).height);
        }
      grid.reset();
    }
});

test('window resize keeps requested card width, DOM and thumbnail tier stable', async () => {
  const f = await fixture(0, 180, 1180, 158, 2),
    { grid, wall, viewport } = f,
    b = grid.cards.get(0),
    image = b.querySelector('img'),
    anchor = grid.captureAnchor();
  assert.match(image.src, /size=512/);
  wall.clientWidth = 820;
  grid.render();
  await f.settle();
  assert.equal(grid.width, 158);
  assert.equal(grid.cards.get(0), b);
  assert.match(image.src, /size=512/);
  assert.equal(image.writes.length, 1);
  assert.equal(grid.getPosition(anchor.index).top - viewport.scrollTop, anchor.offset);
  grid.render();
  assert.equal(image.writes.length, 1);
  grid.reset();
});

test('a DPR change alone upgrades the retained thumbnail and video fallback URLs do not restart repeatedly', async () => {
  const f = await fixture(0, 180, 1180, 222, 1),
    { grid, context } = f,
    b = grid.cards.get(0),
    img = b.querySelector('img');
  assert.match(img.src, /size=512/);
  context.window.devicePixelRatio = 2;
  grid.render();
  assert.equal(grid.cards.get(0), b);
  assert.match(img.src, /size=768/);
  assert.equal(img.writes.length, 2);
  img.src = 'blob:generated-video-thumbnail';
  context.S.rev++;
  grid.render();
  grid.render();
  assert.equal(img.writes.length, 3);
  context.window.devicePixelRatio = 1;
  grid.render();
  assert.equal(img.writes.length, 4);
  assert.match(img.src, /size=512/);
  grid.reset();
});

test('an immersive scroll viewport renders above the floating header without changing first-screen card coordinates', async () => {
  for (const width of [760, 3400]) {
    const old = await fixture(180, 0, width, 222, 2);
    const immersive = await fixture(180, 0, width, 222, 2);
    const oldOrigin = 180,
      newOrigin = oldOrigin + 72;
    old.viewport.getBoundingClientRect = () => ({ top: 100 });
    old.wall.getBoundingClientRect = () => ({ top: 100 + oldOrigin - old.viewport.scrollTop });
    immersive.viewport.getBoundingClientRect = () => ({ top: 28 });
    immersive.viewport.clientHeight = old.viewport.clientHeight + 72;
    immersive.wall.getBoundingClientRect = () => ({
      top: 28 + newOrigin - immersive.viewport.scrollTop
    });
    old.grid.render();
    immersive.grid.render();
    assert.equal(
      100 + oldOrigin + old.grid.getPosition(0).top,
      28 + newOrigin + immersive.grid.getPosition(0).top
    );
    assert.equal(old.grid.width, immersive.grid.width);
    assert.equal(old.wall.style.height, immersive.wall.style.height);
    const index = immersive.grid.cols;
    const position = immersive.grid.getPosition(index);
    immersive.viewport.scrollTop = newOrigin + position.top - 10;
    immersive.grid.render();
    await immersive.settle();
    assert.ok(immersive.grid.cards.has(index));
    assert.equal(
      28 + newOrigin + position.top - immersive.viewport.scrollTop,
      38,
      'card reaches the header top instead of clipping at y100'
    );
    const anchor = immersive.grid.captureAnchor(84);
    const before = immersive.grid.cards.get(anchor.index);
    const srcWrites = before.querySelector('img').writes.length;
    immersive.grid.render();
    assert.equal(immersive.grid.cards.get(anchor.index), before);
    assert.equal(before.querySelector('img').writes.length, srcWrites);
    immersive.settings.density = 158;
    immersive.grid.layout(false);
    immersive.grid.restoreAnchor(anchor.index, anchor.offset);
    assert.equal(
      newOrigin + immersive.grid.getPosition(anchor.index).top - immersive.viewport.scrollTop,
      anchor.offset
    );
    old.grid.reset();
    immersive.grid.reset();
  }
});

test('a bottom-edge probe re-aligns its unloaded target after real page dimensions replace estimates', async () => {
  const f = await fixture(0, 280, 824, 186, 1);
  const { grid, viewport, wall } = f;
  const origin = 218,
    index = grid.total - grid.cols,
    sampleY = 998;
  viewport.clientHeight = 1000;
  wall.getBoundingClientRect = () => ({ top: origin - viewport.scrollTop });
  assert.equal(grid.items.has(index), false);
  const estimate = grid.getPosition(index).top;
  viewport.scrollTop = origin + estimate - sampleY + 20;
  grid.render();
  await f.settle();
  assert.equal(grid.items.has(index), true);
  assert.notEqual(
    grid.getPosition(index).top,
    estimate,
    'real dimensions change the unseen-page estimate'
  );
  // The GUI probe must follow the target instead of waiting at the obsolete jump.
  for (let attempt = 0; attempt < 4; attempt++) {
    viewport.scrollTop = origin + grid.getPosition(index).top - sampleY + 20;
    grid.render();
    await f.settle();
    if (grid.cards.has(index)) break;
  }
  assert.ok(grid.cards.has(index));
  assert.equal(origin + grid.getPosition(index).top - viewport.scrollTop, sampleY - 20);
  assert.ok(grid.cards.size < grid.total);
  assert.deepEqual(f.errors, []);
  grid.reset();
});

test('window-edge viewport keeps absolute first-screen positions and virtualizes both physical edges', async () => {
  for (const width of [760, 3400])
    for (const dpr of [1, 2]) {
      const old = await fixture(180, 0, width, 186, dpr);
      const edge = await fixture(180, 0, width, 186, dpr);
      const oldOrigin = 252,
        edgeOrigin = oldOrigin + 28;
      old.viewport.getBoundingClientRect = () => ({ top: 28 });
      old.wall.getBoundingClientRect = () => ({ top: 28 + oldOrigin - old.viewport.scrollTop });
      edge.viewport.getBoundingClientRect = () => ({ top: 0 });
      edge.viewport.clientHeight = old.viewport.clientHeight + 56;
      edge.wall.getBoundingClientRect = () => ({ top: edgeOrigin - edge.viewport.scrollTop });
      old.grid.render();
      edge.grid.render();
      assert.equal(
        28 + oldOrigin + old.grid.getPosition(0).top,
        edgeOrigin + edge.grid.getPosition(0).top
      );
      assert.equal(edge.grid.width, old.grid.width);
      assert.equal(edge.wall.style.height, old.wall.style.height);
      assert.equal(
        oldOrigin + parseFloat(old.wall.style.height) - old.viewport.clientHeight,
        edgeOrigin + parseFloat(edge.wall.style.height) + 28 - edge.viewport.clientHeight,
        'new internal bottom padding preserves the previous maximum scroll'
      );
      const topIndex = edge.grid.cols * 2;
      const top = edge.grid.getPosition(topIndex);
      edge.viewport.scrollTop = edgeOrigin + top.top + 16;
      edge.grid.render();
      await edge.settle();
      assert.ok(edge.grid.cards.has(topIndex));
      assert.equal(edgeOrigin + top.top - edge.viewport.scrollTop, -16);
      assert.ok(edgeOrigin + top.top + top.height - edge.viewport.scrollTop > 1);
      const bottomIndex = edge.grid.cols * 8;
      const bottom = edge.grid.getPosition(bottomIndex);
      edge.viewport.scrollTop = edgeOrigin + bottom.top - edge.viewport.clientHeight + 16;
      edge.grid.render();
      await edge.settle();
      assert.ok(edge.grid.cards.has(bottomIndex));
      assert.equal(
        edgeOrigin + bottom.top - edge.viewport.scrollTop,
        edge.viewport.clientHeight - 16
      );
      assert.ok(
        edgeOrigin + bottom.top + bottom.height - edge.viewport.scrollTop >
          edge.viewport.clientHeight
      );
      const anchor = edge.grid.captureAnchor(112);
      const retained = edge.grid.cards.get(anchor.index),
        writes = retained.querySelector('img').writes.length;
      edge.grid.render();
      assert.equal(edge.grid.cards.get(anchor.index), retained);
      assert.equal(retained.querySelector('img').writes.length, writes);
      edge.settings.density = 222;
      edge.grid.layout(false);
      edge.grid.restoreAnchor(anchor.index, anchor.offset);
      assert.equal(
        edgeOrigin + edge.grid.getPosition(anchor.index).top - edge.viewport.scrollTop,
        anchor.offset
      );
      assert.ok(edge.grid.cards.size < edge.grid.total);
      assert.deepEqual(edge.errors, []);
      old.grid.reset();
      edge.grid.reset();
    }
});
