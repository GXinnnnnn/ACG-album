'use strict';
// Logical folder rows are ranges, not an array containing every directory.
// CommonJS export keeps this geometry/cache contract testable without a browser.
(function (scope) {
  const PAGE_SIZE = 128;
  const CACHE_PAGES = 12;
  const ROW_HEIGHT = 39;
  const MAX_ROWS = 160;
  const folder = (n) => n && (!n.kind || n.kind === 'folder');
  const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
  function childAt(page, index) {
    return page?.chunks?.get(Math.floor(index / PAGE_SIZE) * PAGE_SIZE)?.[index % PAGE_SIZE];
  }
  function storePage(pages, id, result, offset) {
    let page = pages.get(id);
    if (!page) {
      page = { items: [], chunks: new Map(), total: 0, offset: 0 };
      pages.set(id, page);
    }
    page.total = count(result.total);
    // Keep server ordinals even if a malformed response contains media records.
    const items = (result.items || []).slice(0, PAGE_SIZE).map((n) => (folder(n) ? n : null));
    page.chunks.delete(offset);
    page.chunks.set(offset, items);
    for (const key of page.chunks.keys()) if (key >= page.total) page.chunks.delete(key);
    page.items = [...page.chunks.values()].flat().filter(Boolean);
    return page;
  }
  function trimCache(pages, protectedPages = new Set()) {
    let size = 0;
    for (const page of pages.values()) size += page.chunks.size;
    for (const [id, page] of pages) {
      for (const offset of page.chunks.keys()) {
        if (size <= CACHE_PAGES) break;
        if (protectedPages.has(id + ':' + offset)) continue;
        page.chunks.delete(offset);
        size--;
      }
      page.items = [...page.chunks.values()].flat().filter(Boolean);
    }
  }
  function layout(roots, opened, openNodes, pages, positions, retained = new Map()) {
    // At most two refresh snapshots keep the native focused row and top anchor alive.
    const retainedAt = (parent, ordinal) => {
      for (const saved of retained.values())
        if (saved.node.parent === parent && saved.ordinal === ordinal) return saved.node;
      return null;
    };
    const branches = new Map();
    for (const [id, node] of openNodes) {
      if (!opened.has(id) || !folder(node)) continue;
      const parent = node.parent || null;
      const ordinal = parent ? positions.get(id) : roots.findIndex((n) => n.id === id);
      if (!Number.isInteger(ordinal) || ordinal < 0) continue;
      if (!branches.has(parent)) branches.set(parent, []);
      branches.get(parent).push({ ordinal, node: parent ? node : roots[ordinal] });
    }
    for (const entries of branches.values()) entries.sort((a, b) => a.ordinal - b.ordinal);
    const segments = [];
    let total = 0;
    // Expand lists iteratively so a deeply nested path never consumes the JS call stack.
    const visited = new Set();
    const tasks = [{ parent: null, depth: 0, count: roots.length, expand: true }];
    while (tasks.length) {
      const task = tasks.pop();
      if (task.node || !task.expand) {
        if (!task.count) continue;
        segments.push({ ...task, start: total });
        total += task.count;
        continue;
      }
      const entries = (branches.get(task.parent?.id || null) || []).filter(
        ({ ordinal, node }) => ordinal < task.count && !visited.has(node.id)
      );
      const pieces = [];
      let offset = 0;
      for (const { ordinal, node } of entries) {
        if (ordinal < offset) continue;
        if (ordinal > offset)
          pieces.push({ parent: task.parent, depth: task.depth, offset, count: ordinal - offset });
        pieces.push({ node, parent: task.parent, depth: task.depth, offset: ordinal, count: 1 });
        visited.add(node.id);
        pieces.push({
          parent: node,
          depth: task.depth + 1,
          count: pages.get(node.id)?.total ?? count(node.folders),
          expand: true
        });
        offset = ordinal + 1;
      }
      if (offset < task.count)
        pieces.push({ parent: task.parent, depth: task.depth, offset, count: task.count - offset });
      for (let i = pieces.length - 1; i >= 0; i--) tasks.push(pieces[i]);
    }
    function at(index) {
      if (index < 0 || index >= total) return null;
      let low = 0,
        high = segments.length - 1;
      while (low <= high) {
        const mid = (low + high) >>> 1,
          segment = segments[mid];
        if (index < segment.start) high = mid - 1;
        else if (index >= segment.start + segment.count) low = mid + 1;
        else {
          const ordinal = segment.offset + index - segment.start;
          const node =
            (segment.parent ? retainedAt(segment.parent.id, ordinal) : null) ||
            segment.node ||
            (segment.parent ? childAt(pages.get(segment.parent.id), ordinal) : roots[ordinal]);
          return {
            node: folder(node) ? node : null,
            parent: segment.parent,
            depth: segment.depth,
            ordinal,
            index
          };
        }
      }
      return null;
    }
    function indexAt(parentId, ordinal) {
      for (const segment of segments)
        if (
          (segment.parent?.id || null) === parentId &&
          ordinal >= segment.offset &&
          ordinal < segment.offset + segment.count
        )
          return segment.start + ordinal - segment.offset;
      return -1;
    }
    function indexOf(id) {
      const rootIndex = roots.findIndex((n) => n.id === id);
      if (rootIndex >= 0) return indexAt(null, rootIndex);
      const node = openNodes.get(id);
      if (node && positions.has(id)) return indexAt(node.parent, positions.get(id));
      const saved = retained.get(id);
      if (saved) return indexAt(saved.node.parent, saved.ordinal);
      for (const [parentId, page] of pages)
        for (const [offset, nodes] of page.chunks) {
          const found = nodes.findIndex((n) => n?.id === id);
          if (found >= 0) return indexAt(parentId, offset + found);
        }
      return -1;
    }
    return { total, at, indexAt, indexOf, segments };
  }
  const model = {
    PAGE_SIZE,
    CACHE_PAGES,
    ROW_HEIGHT,
    MAX_ROWS,
    folder,
    childAt,
    storePage,
    trimCache,
    layout
  };
  if (typeof module === 'object' && module.exports) module.exports = model;
  else scope.albumSidebarTree = model;
})(globalThis);
