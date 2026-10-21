'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/masonry.js'), 'utf8');

function element(id) {
  const shell = { style: {} },
    info = { style: {} };
  return {
    dataset: id ? { id } : {},
    style: {},
    remove() {},
    setAttribute() {},
    querySelector: (selector) => (selector === '.cover-shell' ? shell : info)
  };
}
async function fixture(folders, media, width = 1180, density = 222) {
  const viewport = { scrollTop: 0, clientHeight: 800, getBoundingClientRect: () => ({ top: 0 }) };
  const wall = {
    clientWidth: width,
    style: {},
    replaceChildren() {},
    append() {},
    getBoundingClientRect: () => ({ top: -viewport.scrollTop })
  };
  const settings = { density, ratio: 'poster', details: true };
  const calls = [],
    errors = [];
  const make = (index) =>
    index < folders
      ? { id: 'folder-' + index, kind: 'folder' }
      : {
          id: 'image-' + index,
          kind: 'image',
          width: 300,
          height: (index - folders) % 3 === 0 ? 1800 : (index - folders) % 3 === 1 ? 150 : 650
        };
  const context = vm.createContext({
    S: { settings, loadVersion: 1 },
    AbortController,
    console,
    $: (selector) => (selector === '#virtual-grid' ? wall : viewport),
    card: (node) => element(node.id),
    document: { createElement: () => element() },
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
  return { grid, viewport, wall, settings, calls, settle, make };
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

test('unloaded boundary placeholders remain beside folders and natural media survives ratio/detail changes', async () => {
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
  assert.equal(tall.height - 48, tall.width * 6);
  assert.ok(tall.height > originalFolder.height);
  settings.ratio = 'square';
  grid.layout(false);
  assert.equal(grid.getPosition(181).height, tall.height);
  assert.notEqual(grid.getPosition(180).height, originalFolder.height);
  settings.details = false;
  grid.layout(false);
  assert.equal(grid.getPosition(181).height, tall.height - 48);
  assert.equal(grid.getPosition(180).height, grid.width + 70);
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
