'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tree = require('../src/ui/sidebar-tree-model.js');
const node = (id, parent = null, folders = 0) => ({
  id,
  parent,
  folders,
  kind: 'folder',
  name: id
});
function resident(pages) {
  return [...pages.values()].reduce((sum, page) => sum + page.chunks.size, 0);
}
test('one huge child list stays a compact range and resolves a viewport page beyond folder 500', () => {
  const root = node('root', null, 100000000),
    pages = new Map(),
    opened = new Set([root.id]),
    nodes = new Map([[root.id, root]]),
    positions = new Map();
  const items = Array.from({ length: 128 }, (_, i) => node('folder-' + (512 + i), root.id));
  tree.storePage(pages, root.id, { items, total: root.folders }, 512);
  const model = tree.layout([root], opened, nodes, pages, positions);
  assert.equal(model.total, 100000001);
  assert.equal(model.segments.length, 2, 'logical size does not allocate a row per directory');
  assert.equal(model.at(601).node.id, 'folder-600');
  assert.equal(model.at(601).ordinal, 600);
  assert.equal(model.at(99999999).node, null, 'distant pages remain unloaded');
  assert.equal(model.indexOf('folder-600'), 601);
  assert.equal(model.indexAt(root.id, 99999999), 100000000);
  assert.equal(pages.get(root.id).items.length, 128);
});
test('folder-only storage rejects media but preserves server ordinals for subsequent folders', () => {
  const pages = new Map(),
    first = node('first', 'root'),
    last = node('last', 'root');
  tree.storePage(
    pages,
    'root',
    { total: 3, items: [first, { id: 'photo', kind: 'image' }, last] },
    0
  );
  assert.deepEqual(
    pages.get('root').items.map((n) => n.id),
    ['first', 'last']
  );
  assert.equal(tree.childAt(pages.get('root'), 1), null);
  assert.equal(tree.childAt(pages.get('root'), 2), last);
  assert.ok(pages.get('root').items.every(tree.folder));
});
test('paging reuses the same page.items contract and evicts old chunks after thousands of siblings', () => {
  const pages = new Map();
  for (let page = 0; page < 80; page++) {
    const offset = page * 128;
    tree.storePage(
      pages,
      'root',
      {
        total: 10240,
        items: Array.from({ length: 128 }, (_, i) => node('folder-' + (offset + i), 'root'))
      },
      offset
    );
    tree.trimCache(pages, new Set(['root:' + offset]));
    assert.ok(resident(pages) <= tree.CACHE_PAGES);
    assert.ok(pages.get('root').items.length <= tree.CACHE_PAGES * tree.PAGE_SIZE);
  }
  assert.equal(pages.get('root').total, 10240);
  assert.equal(tree.childAt(pages.get('root'), 0), undefined);
  assert.equal(tree.childAt(pages.get('root'), 10239).id, 'folder-10239');
});
test('cache protection has a viewport-sized exception rather than growth with total tree size', () => {
  const pages = new Map(),
    visible = new Set();
  for (let i = 0; i < tree.MAX_ROWS + 40; i++) {
    const id = 'branch-' + i;
    tree.storePage(
      pages,
      id,
      { total: 128, items: Array.from({ length: 128 }, (_, j) => node(id + '-' + j, id)) },
      0
    );
    if (i < tree.MAX_ROWS) visible.add(id + ':0');
  }
  tree.trimCache(pages, visible);
  assert.equal(resident(pages), tree.MAX_ROWS);
  tree.trimCache(pages);
  assert.equal(resident(pages), tree.CACHE_PAGES);
});
test('deep open paths have no five-level or recursive stack limit', () => {
  const depth = 10000,
    root = node('level-0', null, 1),
    opened = new Set(),
    nodes = new Map(),
    positions = new Map();
  for (let i = 0; i < depth; i++) {
    const n = i ? node('level-' + i, 'level-' + (i - 1), i < depth - 1 ? 1 : 0) : root;
    nodes.set(n.id, n);
    opened.add(n.id);
    if (i) positions.set(n.id, 0);
  }
  const model = tree.layout([root], opened, nodes, new Map(), positions);
  assert.equal(model.total, depth);
  assert.equal(model.at(depth - 1).depth, depth - 1);
  assert.equal(model.at(depth - 1).node.id, 'level-9999');
  assert.equal(model.indexOf('level-9999'), depth - 1);
  assert.ok(model.segments.length <= depth * 2);
});
test('root metadata, renamed IDs, removals and multiple roots preserve ordinal geometry', () => {
  const root = node('root', null, 640),
    other = node('other'),
    renamed = node('renamed', 'root', 1),
    leaf = node('leaf', renamed.id),
    nodes = new Map([
      [root.id, root],
      [renamed.id, renamed]
    ]),
    positions = new Map([[renamed.id, 639]]),
    pages = new Map();
  tree.storePage(
    pages,
    root.id,
    {
      total: 640,
      items: [
        ...Array.from({ length: 127 }, (_, i) => node('folder-' + (512 + i), root.id)),
        renamed
      ]
    },
    512
  );
  tree.storePage(pages, renamed.id, { total: 1, items: [leaf] }, 0);
  const freshRoot = { ...root, name: 'Fresh root' },
    model = tree.layout([freshRoot, other], new Set(nodes.keys()), nodes, pages, positions);
  assert.equal(model.at(0).node.name, 'Fresh root');
  assert.equal(model.indexOf(renamed.id), 640);
  assert.equal(model.indexOf(leaf.id), 641);
  assert.equal(model.indexOf(other.id), 642);
  assert.equal(model.at(642).node, other);
  assert.equal(model.indexOf('removed-old-id'), -1);
  const collapsed = tree.layout([freshRoot, other], new Set(), new Map(), pages, new Map());
  assert.equal(collapsed.total, 2);
  assert.equal(collapsed.indexOf(leaf.id), -1);
});
