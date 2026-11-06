'use strict';
// Floating navigation is independent of the virtual image grid: hover never relays it out.
const folderTree = {
  open: new Set(),
  openNodes: new Map(),
  pages: new Map(),
  loading: new Set(),
  rootOffset: 0,
  generation: 0,
  positions: new Map(),
  requests: new Map(),
  errors: new Map(),
  viewport: null
};
const treeModel = globalThis.albumSidebarTree;
let treeLayout = null,
  treeFrame = 0,
  treeContent = null,
  treeRecovery = null,
  treeFocusIntent = 0;
const treeElements = new Map(),
  treeRetained = new Map();
const treePageOffset = (ordinal) => Math.floor(ordinal / treeModel.PAGE_SIZE) * treeModel.PAGE_SIZE;
const treePageKey = (id, offset) => id + ':' + offset;
function scheduleTreeRender() {
  if (treeFrame) return;
  treeFrame = requestAnimationFrame(() => {
    treeFrame = 0;
    renderFolderTree();
  });
}
function treeProtectedPages() {
  const keys = new Set();
  for (const group of treeElements.values()) {
    const row = group.treeDescriptor;
    if (row?.parent) keys.add(treePageKey(row.parent.id, treePageOffset(row.ordinal)));
  }
  return keys;
}
let sidebarTimer,
  sidebarOpen = false,
  sidebarUnpinnedMode = 'auto';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const sidebarHasKeyboardFocus = () =>
  $('#sidebar-shell').contains(document.activeElement) &&
  document.activeElement.matches(':focus-visible');
function setSidebarOpen(open) {
  clearTimeout(sidebarTimer);
  if (S.settings.sidebarMode === 'expanded') open = true;
  sidebarOpen = open;
  if (!open) folderTree.viewport = null;
  $('#sidebar-shell').classList.toggle('is-open', open);
  $('#sidebar-details').inert = !open;
  // Pinning remains available in the collapsed rail at the same screen position.
  $('#sidebar-pin').inert = false;
  $('#sidebar-copyright').inert = !open;
  $('#rail-tree').setAttribute('aria-expanded', String(open));
  $('#rail-tree').title = '展开文件夹树';
  $('#rail-tree').setAttribute('aria-label', $('#rail-tree').title);
  if (
    !open &&
    ($('#sidebar-details').contains(document.activeElement) ||
      $('#sidebar-copyright').contains(document.activeElement))
  )
    $('#rail-tree').focus({ preventScroll: true });
}
function scheduleSidebar(open, delay) {
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(
    () => {
      if (
        open ||
        (!$('#sidebar-shell').matches(':hover') &&
          !sidebarHasKeyboardFocus() &&
          $('#context-menu').hidden)
      )
        setSidebarOpen(open);
    },
    reducedMotion() ? 0 : delay
  );
}
function applyNavigationSettings() {
  const mode = S.settings.sidebarMode || 'auto';
  if (mode !== 'expanded') sidebarUnpinnedMode = mode;
  $('.app-shell').dataset.sidebar = mode;
  $$('.user-name').forEach((el) => (el.textContent = S.settings.nickname || '新朋友'));
  $$('.user-avatar').forEach(
    (el) => (el.src = S.settings.avatar || '../assets/default-avatar.jpg')
  );
  $('#profile-button').setAttribute(
    'aria-label',
    `${S.settings.nickname || '新朋友'}，个人资料与设置`
  );
  $('#sidebar-pin').setAttribute('aria-pressed', String(mode === 'expanded'));
  $('#sidebar-pin').title = mode === 'expanded' ? '取消固定侧栏' : '固定侧栏';
  $('#sidebar-pin').setAttribute('aria-label', $('#sidebar-pin').title);
  if (mode === 'expanded') setSidebarOpen(true);
  else if (!$('#sidebar-shell').matches(':hover') && !sidebarHasKeyboardFocus())
    setSidebarOpen(false);
}
function collapseBranch(id) {
  const base = folderTree.openNodes.get(id)?.path?.replaceAll('/', '\\').toLowerCase();
  for (const [child, n] of folderTree.openNodes)
    if (
      child === id ||
      (base &&
        n.path
          ?.replaceAll('/', '\\')
          .toLowerCase()
          .startsWith(base + '\\'))
    ) {
      folderTree.open.delete(child);
      folderTree.openNodes.delete(child);
      folderTree.positions.delete(child);
      folderTree.pages.delete(child);
      folderTree.requests.delete(child);
      folderTree.loading.delete(child);
      for (const key of folderTree.errors.keys())
        if (key.startsWith(child + ':')) folderTree.errors.delete(key);
    }
  folderTree.open.delete(id);
}
function captureTreeRow(descriptor) {
  return descriptor?.node
    ? {
        node: { ...descriptor.node },
        ordinal: descriptor.ordinal,
        index: descriptor.index,
        depth: descriptor.depth
      }
    : null;
}
function treeOpenStateChanged(recovery) {
  return (
    recovery.opened.size !== folderTree.open.size ||
    [...recovery.opened].some((id) => !folderTree.open.has(id))
  );
}
function pruneTreeRecovery(recovery, id) {
  const base = recovery.nodes.get(id)?.path?.replaceAll('/', '\\').toLowerCase();
  for (const [child, node] of recovery.nodes)
    if (
      child === id ||
      (base &&
        node.path
          ?.replaceAll('/', '\\')
          .toLowerCase()
          .startsWith(base + '\\'))
    ) {
      recovery.open.delete(child);
      recovery.nodes.delete(child);
      recovery.positions.delete(child);
      recovery.pages.delete(child);
    }
}
function treeViewportRange(total, top, height, opened = folderTree.open) {
  const first = Math.max(0, Math.floor(top / treeModel.ROW_HEIGHT) - 8),
    limit = Math.min(total, first + treeModel.MAX_ROWS - 1),
    structure = JSON.stringify([S.roots.map((node) => node.id), [...opened]]);
  let end = Math.min(limit, first + Math.ceil(height / treeModel.ROW_HEIGHT) + 16);
  // Task status can resize the viewport without changing its scroll anchor.
  // Keep only the already committed overscan tail, never a speculative stage.
  if (
    folderTree.viewport?.first === first &&
    folderTree.viewport.top === top &&
    folderTree.viewport.total === total &&
    folderTree.viewport.structure === structure
  )
    end = Math.min(limit, Math.max(end, folderTree.viewport.end));
  return { first, end, top, total, structure };
}
async function prepareTreeViewport(recovery) {
  const host = $('#category-nav');
  while (recovery.generation === folderTree.generation && treeRecovery === recovery) {
    if (treeOpenStateChanged(recovery)) return false;
    const active = host.contains(document.activeElement) ? document.activeElement : null,
      activeGroup = active?.closest('.tree-node');
    if (activeGroup?.treeNode && activeGroup.treeNode.id !== recovery.focus?.node.id) {
      const saved = captureTreeRow(activeGroup.treeDescriptor),
        found = await findTreeNode(saved.node, recovery.generation, saved.ordinal, recovery);
      if (recovery.generation !== folderTree.generation || treeRecovery !== recovery) return false;
      if (document.activeElement !== active) continue;
      if (recovery.focus?.node.id !== recovery.anchor?.node.id)
        recovery.retained.delete(recovery.focus?.node.id);
      saved.found = found || null;
      if (found) {
        saved.node = found.node;
        saved.ordinal = found.ordinal;
        if (saved.node.parent) recovery.retained.set(saved.node.id, saved);
      }
      recovery.focus = saved;
      recovery.focusElement = active;
    }
    const layout = treeModel.layout(
      S.roots,
      recovery.open,
      recovery.nodes,
      recovery.pages,
      recovery.positions,
      recovery.retained
    );
    let top = host.scrollTop || 0;
    if (recovery.intent === treeFocusIntent && recovery.anchor?.found) {
      const index = layout.indexOf(recovery.anchor.node.id);
      if (index >= 0) top = index * treeModel.ROW_HEIGHT + recovery.remainder;
    }
    const height = host.clientHeight || 390;
    top = Math.max(0, Math.min(top, layout.total * treeModel.ROW_HEIGHT - height));
    const viewport = treeViewportRange(layout.total, top, height, recovery.open),
      { first, end } = viewport,
      needed = new Map();
    recovery.protected.clear();
    const protect = (row) => {
      if (!row?.parent) return;
      const offset = treePageOffset(row.ordinal),
        key = treePageKey(row.parent.id, offset);
      recovery.protected.add(key);
      if (!recovery.pages.get(row.parent.id)?.chunks.has(offset))
        needed.set(key, { node: row.parent, offset });
    };
    for (let index = first; index < end; index++) protect(layout.at(index));
    const focused = recovery.focus?.found && layout.indexOf(recovery.focus.node.id);
    if (Number.isInteger(focused) && focused >= 0) protect(layout.at(focused));
    if (!needed.size) return true;
    for (const { node, offset } of needed.values()) {
      await fetchTreePage(node, offset, recovery);
      if (recovery.generation !== folderTree.generation || treeRecovery !== recovery) return false;
    }
  }
  return false;
}
function invalidateFolderTree() {
  const host = $('#category-nav'),
    active = host.contains(document.activeElement) ? document.activeElement : null,
    focused = active?.closest('.tree-node'),
    top = host.scrollTop || 0,
    anchor = captureTreeRow(treeLayout?.at(Math.floor(top / treeModel.ROW_HEIGHT))),
    focus = captureTreeRow(focused?.treeDescriptor),
    recovery = {
      generation: ++folderTree.generation,
      anchor,
      focus,
      focusElement: active,
      intent: treeFocusIntent,
      remainder: top % treeModel.ROW_HEIGHT,
      opened: new Set(folderTree.open),
      open: new Set(folderTree.open),
      nodes: new Map(folderTree.openNodes),
      positions: new Map(folderTree.positions),
      pages: new Map(),
      retained: new Map(),
      protected: new Set()
    };
  // Keep the committed viewport and exact direct-folder totals while validating
  // a separate bounded cache. Background index revisions never expose empty pages.
  for (const [id, page] of folderTree.pages)
    recovery.pages.set(id, { items: [], chunks: new Map(), total: page.total, offset: 0 });
  treeRecovery = recovery;
  treeRetained.clear();
  folderTree.loading.clear();
  folderTree.requests.clear();
  folderTree.errors.clear();
  if (!recovery.opened.size) {
    treeRecovery = null;
    renderFolderTree();
    return;
  }
  const roots = new Map(S.roots.map((node) => [node.id, node]));
  for (const [id, node] of recovery.nodes)
    if (!node.parent) {
      if (!roots.has(id)) pruneTreeRecovery(recovery, id);
      else recovery.nodes.set(id, roots.get(id));
    }
  attempt(async () => {
    const generation = recovery.generation;
    for (const node of recovery.nodes.values()) {
      if (generation !== folderTree.generation) return;
      if (node.parent && recovery.open.has(node.parent)) {
        const found = await findTreeNode(
          node,
          generation,
          recovery.positions.get(node.id),
          recovery
        );
        if (generation !== folderTree.generation) return;
        if (found) {
          recovery.positions.set(node.id, found.ordinal);
          recovery.nodes.set(node.id, found.node);
        } else pruneTreeRecovery(recovery, node.id);
      }
    }
    for (const saved of new Set([anchor, focus].filter(Boolean))) {
      if (generation !== folderTree.generation) return;
      const found = await findTreeNode(saved.node, generation, saved.ordinal, recovery);
      if (generation !== folderTree.generation || treeRecovery !== recovery) return;
      saved.found = found || null;
      if (found) {
        saved.node = found.node;
        saved.ordinal = found.ordinal;
        if (saved.node.parent) recovery.retained.set(saved.node.id, saved);
      }
    }
    const prepared = await prepareTreeViewport(recovery);
    if (generation !== folderTree.generation || treeRecovery !== recovery) return;
    if (treeOpenStateChanged(recovery)) {
      invalidateFolderTree();
      return;
    }
    if (!prepared) return;
    if (generation !== folderTree.generation || treeRecovery !== recovery) return;
    // Commit only after every visible destination row and the focused page exist.
    // The previous layout still owns its old cache for anchor reconciliation.
    const finalFocus = recovery.focus,
      restoreFocus =
        recovery.intent === treeFocusIntent ||
        (recovery.focusElement && document.activeElement === recovery.focusElement);
    folderTree.pages = recovery.pages;
    folderTree.open = recovery.open;
    folderTree.openNodes = recovery.nodes;
    folderTree.positions = recovery.positions;
    treeRetained.clear();
    for (const [id, saved] of recovery.retained) treeRetained.set(id, saved);
    renderFolderTree();
    if (recovery.intent === treeFocusIntent && anchor?.found) {
      const index = treeLayout.indexOf(anchor.node.id);
      if (index >= 0) host.scrollTop = index * treeModel.ROW_HEIGHT + recovery.remainder;
    }
    treeRetained.clear();
    renderFolderTree();
    treeRecovery = null;
    if (!restoreFocus || !finalFocus) return;
    if (finalFocus.found) {
      const group = treeElements.get(finalFocus.node.id),
        key = recovery.focusElement?.dataset.treeKey?.endsWith(':toggle')
          ? '.tree-toggle'
          : '.category-link';
      group?.querySelector(key)?.focus({ preventScroll: true });
    } else {
      // Prefer the next surviving sibling, then the previous sibling or visible ancestor.
      const total = folderTree.pages.get(finalFocus.node.parent)?.total ?? 0,
        ordinal = Math.min(finalFocus.ordinal, total - 1),
        neighbor = ordinal >= 0 ? treeLayout.indexAt(finalFocus.node.parent, ordinal) : -1,
        parent = treeLayout.indexOf(finalFocus.node.parent),
        fallback =
          neighbor >= 0
            ? neighbor
            : parent >= 0
              ? parent
              : Math.min(finalFocus.index, treeLayout.total - 1);
      if (fallback >= 0) await focusTreeIndex(fallback);
      else $('#rail-tree').focus({ preventScroll: true });
    }
  }).finally(() => {
    if (treeRecovery === recovery) treeRecovery = null;
  });
}
async function fetchTreePage(n, offset = 0, recovery = null) {
  offset = treePageOffset(offset);
  if (!folderTree.open.has(n.id)) return;
  const pages = recovery?.pages || folderTree.pages,
    loaded = pages.get(n.id)?.chunks.get(offset);
  if (loaded) return loaded;
  const prior = folderTree.requests.get(n.id),
    entryGeneration = folderTree.generation;
  if (prior) {
    await prior.promise;
    if (entryGeneration !== folderTree.generation || !folderTree.open.has(n.id)) return;
    return fetchTreePage(n, offset, recovery);
  }
  const generation = folderTree.generation,
    token = {};
  folderTree.requests.set(n.id, token);
  folderTree.loading.add(n.id);
  folderTree.errors.delete(treePageKey(n.id, offset));
  token.promise = (async () => {
    try {
      const result = await api('list', {
        parent: n.id,
        filter: 'folders',
        sort: 'name',
        direction: 'asc',
        limit: treeModel.PAGE_SIZE,
        offset
      });
      if (
        generation !== folderTree.generation ||
        folderTree.requests.get(n.id) !== token ||
        !folderTree.open.has(n.id)
      )
        return;
      treeModel.storePage(pages, n.id, result, offset);
      for (let i = 0; !recovery && i < (result.items || []).length; i++) {
        const node = result.items[i],
          saved = treeRetained.get(node?.id);
        if (saved && treeModel.folder(node)) {
          saved.node = node;
          saved.ordinal = offset + i;
        }
        if (treeModel.folder(node) && folderTree.open.has(node.id)) {
          folderTree.positions.set(node.id, offset + i);
          folderTree.openNodes.set(node.id, node);
        }
      }
      const protectedPages = new Set(recovery?.protected || treeProtectedPages());
      protectedPages.add(treePageKey(n.id, offset));
      treeModel.trimCache(pages, protectedPages);
      return pages.get(n.id)?.chunks.get(offset);
    } catch (error) {
      if (generation === folderTree.generation && folderTree.requests.get(n.id) === token) {
        folderTree.errors.set(treePageKey(n.id, offset), error);
        while (folderTree.errors.size > treeModel.CACHE_PAGES)
          folderTree.errors.delete(folderTree.errors.keys().next().value);
      }
      throw error;
    } finally {
      if (generation === folderTree.generation && folderTree.requests.get(n.id) === token) {
        folderTree.requests.delete(n.id);
        folderTree.loading.delete(n.id);
        if (!recovery) renderFolderTree();
      }
    }
  })();
  if (!recovery) renderFolderTree();
  return token.promise;
}
function compareTreeNode(a, b) {
  // SQLite's BINARY UTF-8 order follows Unicode scalar values, including astral names.
  const compare = (left, right) => {
    const x = Array.from(String(left || '')),
      y = Array.from(String(right || ''));
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const delta = x[i].codePointAt(0) - y[i].codePointAt(0);
      if (delta) return delta;
    }
    return x.length - y.length;
  };
  return compare(a.sortkey, b.sortkey) || compare(a.id, b.id);
}
async function findTreeNode(node, generation, hint, recovery = null) {
  if (!node.parent) {
    const ordinal = S.roots.findIndex((n) => n.id === node.id);
    return ordinal >= 0 ? { node: S.roots[ordinal], ordinal } : null;
  }
  const parent = (recovery?.nodes || folderTree.openNodes).get(node.parent),
    pages = recovery?.pages || folderTree.pages;
  if (!parent || !(recovery?.open || folderTree.open).has(parent.id)) return null;
  let low = 0,
    high = Math.max(
      0,
      Math.ceil((pages.get(parent.id)?.total ?? parent.folders) / treeModel.PAGE_SIZE) - 1
    );
  let probe = Number.isInteger(hint) ? Math.min(high, Math.floor(hint / treeModel.PAGE_SIZE)) : 0,
    firstProbe = true;
  while (low <= high) {
    const offset = probe * treeModel.PAGE_SIZE;
    const items = await fetchTreePage(parent, offset, recovery);
    if (generation !== folderTree.generation || !folderTree.open.has(parent.id)) return;
    if (!items) return null;
    const found = items.findIndex((n) => n?.id === node.id);
    if (found >= 0) return { node: items[found], ordinal: offset + found };
    const lastPage = Math.max(
      0,
      Math.ceil((pages.get(parent.id)?.total || 0) / treeModel.PAGE_SIZE) - 1
    );
    high = firstProbe ? lastPage : Math.min(high, lastPage);
    firstProbe = false;
    const first = items.find(Boolean),
      last = items.findLast(Boolean);
    if (!first || !last || node.sortkey == null) break;
    if (compareTreeNode(node, first) < 0) high = probe - 1;
    else if (compareTreeNode(node, last) > 0) low = probe + 1;
    else break;
    probe = (low + high) >>> 1;
  }
  return null;
}
async function locateOpenTreeNode(node, generation) {
  const found = await findTreeNode(node, generation, folderTree.positions.get(node.id));
  if (generation !== folderTree.generation || !folderTree.open.has(node.id)) return;
  if (found) {
    folderTree.positions.set(node.id, found.ordinal);
    folderTree.openNodes.set(node.id, found.node);
    renderFolderTree();
  } else collapseBranch(node.id);
}
async function toggleTree(n) {
  if (folderTree.open.has(n.id)) {
    collapseBranch(n.id);
    renderFolderTree();
    return;
  }
  const index = treeLayout?.indexOf(n.id) ?? -1,
    descriptor = index >= 0 ? treeLayout.at(index) : null;
  for (const sibling of [...folderTree.openNodes.values()])
    if ((sibling.parent || null) === (n.parent || null) && sibling.id !== n.id)
      collapseBranch(sibling.id);
  folderTree.open.add(n.id);
  folderTree.openNodes.set(n.id, n);
  if (n.parent && descriptor) folderTree.positions.set(n.id, descriptor.ordinal);
  if (!folderTree.pages.has(n.id)) await fetchTreePage(n);
  else renderFolderTree();
}
function folderTreeEntryRoot() {
  const normalize = (path) =>
      String(path || '')
        .replaceAll('/', '\\')
        .replace(/\\+$/, '')
        .toLowerCase(),
    current = S.current,
    currentPath = normalize(current?.path);
  let contextual = S.roots.find((n) => n.id === current?.id);
  if (!contextual && currentPath)
    for (const n of S.roots) {
      const path = normalize(n.path);
      if (
        path &&
        (currentPath === path || currentPath.startsWith(path + '\\')) &&
        (!contextual || path.length > normalize(contextual.path).length)
      )
        contextual = n;
    }
  const rootRow = treeLayout?.at(
    Math.floor(($('#category-nav').scrollTop || 0) / treeModel.ROW_HEIGHT)
  );
  const visible = rootRow?.node && !rootRow.parent ? [rootRow.node] : [];
  return (
    contextual ||
    visible.find((n) => n.folders > 0 && folderTree.open.has(n.id)) ||
    visible.find((n) => n.folders > 0) ||
    S.roots.find((n) => n.folders > 0) ||
    visible[0] ||
    S.roots[0]
  );
}
async function openFolderTree() {
  const intent = treeFocusIntent,
    generation = folderTree.generation;
  setSidebarOpen(true);
  const n = folderTreeEntryRoot();
  if (!n) {
    renderFolderTree();
    return;
  }
  folderTree.rootOffset = S.roots.indexOf(n);
  // Opening the shell is separate from expanding a real directory branch.
  // The action is idempotent after hover and while an existing page is loading.
  if (n.folders > 0 && !folderTree.open.has(n.id)) await toggleTree(n);
  else if (n.folders > 0 && !folderTree.pages.has(n.id) && !folderTree.loading.has(n.id))
    await fetchTreePage(n);
  else renderFolderTree();
  // A slow first page must not undo a newer wheel, focus, or structural action.
  if (
    intent !== treeFocusIntent ||
    generation !== folderTree.generation ||
    !sidebarOpen ||
    !S.roots.some((root) => root.id === n.id) ||
    (n.folders > 0 && !folderTree.open.has(n.id))
  )
    return;
  const index = treeLayout?.indexOf(n.id) ?? -1;
  if (index >= 0) revealTreeIndex(index);
}
function revealTreeIndex(index) {
  const host = $('#category-nav'),
    top = index * treeModel.ROW_HEIGHT,
    height = host.clientHeight || 390;
  if (top < host.scrollTop) host.scrollTop = top;
  else if (top + treeModel.ROW_HEIGHT > host.scrollTop + height)
    host.scrollTop = top + treeModel.ROW_HEIGHT - height;
  renderFolderTree();
}
async function focusTreeIndex(index, intent = ++treeFocusIntent, origin = document.activeElement) {
  if (intent !== treeFocusIntent || document.activeElement !== origin || !treeLayout?.total) return;
  index = Math.max(0, Math.min(treeLayout.total - 1, index));
  revealTreeIndex(index);
  let row = treeLayout.at(index);
  const generation = folderTree.generation;
  if (!row?.node && row?.parent) {
    await fetchTreePage(row.parent, treePageOffset(row.ordinal));
    if (
      generation !== folderTree.generation ||
      intent !== treeFocusIntent ||
      document.activeElement !== origin
    )
      return;
    row = treeLayout.at(index);
  }
  if (row?.node)
    treeElements.get(row.node.id)?.querySelector('.category-link')?.focus({ preventScroll: true });
}
function createTreeElement(key) {
  const group = document.createElement('div');
  group.className = 'tree-node';
  const row = document.createElement('div'),
    toggle = document.createElement('button'),
    link = document.createElement('button');
  toggle.className = 'tree-toggle';
  toggle.tabIndex = -1;
  toggle.innerHTML = svg('chevron-right');
  toggle.onclick = () => attempt(() => toggleTree(group.treeNode));
  link.className = 'category-link';
  link.onclick = () => attempt(() => navigate({ parent: group.treeNode.id }));
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    return attempt(async () => {
      const current = await api('get', { id: group.treeNode.id });
      if (!current || !$('#category-nav').contains(group)) return;
      group.treeNode = current;
      showContext(e, current);
    });
  };
  row.append(toggle, link);
  group.append(row);
  treeElements.set(key, group);
  treeContent.append(group);
  return group;
}
function updateTreeElement(group, descriptor, firstIndex) {
  const n = descriptor.node,
    row = group.children[0],
    toggle = row.children[0],
    link = row.children[1],
    open = folderTree.open.has(n.id),
    selected = S.current?.id === n.id;
  group.treeNode = n;
  group.treeDescriptor = descriptor;
  if (group.dataset.nodeId !== n.id) group.dataset.nodeId = n.id;
  const top = descriptor.index * treeModel.ROW_HEIGHT + 'px';
  if (group.style.top !== top) group.style.top = top;
  const signature = JSON.stringify([
    n.id,
    n.name,
    n.path,
    n.folders,
    descriptor.depth,
    open,
    selected
  ]);
  if (group.treeSignature !== signature) {
    group.treeSignature = signature;
    row.className =
      'tree-row' + (selected ? ' selected' : '') + (!descriptor.depth ? ' tree-root' : '');
    row.style.setProperty('--depth', Math.min(descriptor.depth, 8));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(descriptor.depth + 1));
    row.setAttribute('aria-selected', String(selected));
    if (n.folders > 0) row.setAttribute('aria-expanded', String(open));
    else row.removeAttribute('aria-expanded');
    toggle.className = 'tree-toggle' + (open ? ' expanded' : '');
    toggle.disabled = !(n.folders > 0);
    toggle.dataset.treeKey = n.id + ':toggle';
    toggle.setAttribute('aria-label', (open ? '收起' : '展开') + n.name);
    link.dataset.treeKey = n.id + ':link';
    link.innerHTML =
      svg('folder') +
      `<span class="category-name">${esc(n.name)}</span>` +
      (!descriptor.depth ? `<span class="category-total">${fmt(n.folders)}</span>` : '');
    link.title = n.path;
  }
  const active = $('#category-nav').contains(document.activeElement)
    ? document.activeElement.closest('.tree-node')
    : null;
  const tabIndex = active ? (active === group ? 0 : -1) : descriptor.index === firstIndex ? 0 : -1,
    position = String(descriptor.ordinal + 1),
    size = String(
      descriptor.parent
        ? (folderTree.pages.get(descriptor.parent.id)?.total ?? descriptor.parent.folders)
        : S.roots.length
    );
  if (link.tabIndex !== tabIndex) link.tabIndex = tabIndex;
  if (row.getAttribute('aria-posinset') !== position) row.setAttribute('aria-posinset', position);
  if (row.getAttribute('aria-setsize') !== size) row.setAttribute('aria-setsize', size);
}
function renderFolderTree() {
  const host = $('#category-nav');
  if (!host) return;
  const height = host.clientHeight || 390,
    oldTop = host.scrollTop || 0,
    oldIndex = Math.floor(oldTop / treeModel.ROW_HEIGHT),
    anchor = treeLayout?.at(oldIndex),
    active = host.contains(document.activeElement) ? document.activeElement : null,
    focusedGroup = active?.closest('.tree-node');
  const nextLayout = treeModel.layout(
    S.roots,
    folderTree.open,
    folderTree.openNodes,
    folderTree.pages,
    folderTree.positions,
    treeRetained
  );
  if (anchor) {
    let nextIndex = anchor.node ? nextLayout.indexOf(anchor.node.id) : -1;
    if (nextIndex < 0) nextIndex = nextLayout.indexAt(anchor.parent?.id || null, anchor.ordinal);
    if (nextIndex >= 0)
      host.scrollTop = Math.max(
        0,
        nextIndex * treeModel.ROW_HEIGHT + (oldTop % treeModel.ROW_HEIGHT)
      );
  }
  treeLayout = nextLayout;
  if (!treeLayout.total) {
    if (treeContent || !host.querySelector('.sidebar-empty'))
      host.innerHTML = '<p class="sidebar-empty">导入文件夹后<br>在这里逐层浏览相册</p>';
    treeContent = null;
    folderTree.viewport = null;
    treeElements.clear();
    return;
  }
  if (!treeContent || treeContent.parentElement !== host) {
    host.replaceChildren();
    folderTree.viewport = null;
    treeElements.clear();
    treeContent = document.createElement('div');
    treeContent.className = 'tree-virtual-content';
    treeContent.setAttribute('role', 'none');
    host.append(treeContent);
  }
  const contentHeight = treeLayout.total * treeModel.ROW_HEIGHT + 'px';
  if (treeContent.style.height !== contentHeight) treeContent.style.height = contentHeight;
  const maxScroll = Math.max(0, treeLayout.total * treeModel.ROW_HEIGHT - height);
  host.scrollTop = Math.min(host.scrollTop || 0, maxScroll);
  const viewport = treeViewportRange(treeLayout.total, host.scrollTop, height),
    { first, end } = viewport,
    wanted = new Map(),
    needed = new Map();
  for (let index = first; index < end; index++) {
    const descriptor = treeLayout.at(index);
    if (!descriptor) continue;
    const key =
      descriptor.node?.id || treePageKey(descriptor.parent?.id || 'roots', descriptor.ordinal);
    wanted.set(key, descriptor);
    if (!descriptor.node && descriptor.parent) {
      const offset = treePageOffset(descriptor.ordinal),
        pageKey = treePageKey(descriptor.parent.id, offset);
      if (
        !folderTree.errors.has(pageKey) &&
        !folderTree.pages.get(descriptor.parent.id)?.chunks.has(offset)
      )
        needed.set(pageKey, { node: descriptor.parent, offset });
    }
  }
  // Keep one offscreen focused row alive; wheel scrolling must not discard focus.
  const focusIndex = focusedGroup?.treeNode ? treeLayout.indexOf(focusedGroup.treeNode.id) : -1;
  if (focusIndex >= 0) wanted.set(focusedGroup.treeNode.id, treeLayout.at(focusIndex));
  for (const [key, group] of treeElements) {
    if (wanted.has(key)) continue;
    group.remove();
    treeElements.delete(key);
  }
  for (const [key, descriptor] of wanted) {
    if (descriptor.node) {
      const group = treeElements.get(key) || createTreeElement(key);
      updateTreeElement(group, descriptor, Math.floor(host.scrollTop / treeModel.ROW_HEIGHT));
    } else {
      let pending = treeElements.get(key);
      if (!pending) {
        pending = document.createElement('div');
        pending.className = 'tree-slot';
        treeElements.set(key, pending);
        treeContent.append(pending);
      }
      pending.treeDescriptor = descriptor;
      const top = descriptor.index * treeModel.ROW_HEIGHT + 'px';
      if (pending.style.top !== top) pending.style.top = top;
      const error = folderTree.errors.get(
        treePageKey(descriptor.parent.id, treePageOffset(descriptor.ordinal))
      );
      const status = error ? '读取失败，点击重试' : '正在读取…';
      if (pending.treeStatus !== status) {
        pending.treeStatus = status;
        pending.replaceChildren();
        const message = document.createElement(error ? 'button' : 'span');
        message.className = 'tree-pending';
        message.textContent = status;
        if (error)
          message.onclick = () =>
            attempt(() => fetchTreePage(descriptor.parent, treePageOffset(descriptor.ordinal)));
        pending.append(message);
      }
    }
  }
  if (active && !host.contains(active) && !treeRecovery) {
    const parentIndex = focusedGroup?.treeNode?.parent
      ? treeLayout.indexOf(focusedGroup.treeNode.parent)
      : -1;
    const fallback = treeLayout.at(
      parentIndex >= 0 ? parentIndex : Math.floor(host.scrollTop / treeModel.ROW_HEIGHT)
    );
    treeElements
      .get(fallback?.node?.id)
      ?.querySelector('.category-link')
      ?.focus({ preventScroll: true });
  }
  folderTree.viewport = viewport;
  treeModel.trimCache(folderTree.pages, treeProtectedPages());
  // One flight per parent; the next missing viewport page follows its completion.
  for (const { node, offset } of needed.values())
    if (!folderTree.requests.has(node.id)) {
      queueMicrotask(() => {
        if (
          folderTree.open.has(node.id) &&
          !folderTree.requests.has(node.id) &&
          !folderTree.pages.get(node.id)?.chunks.has(offset)
        )
          attempt(() => fetchTreePage(node, offset));
      });
      break;
    }
}
function updateCoverNode(n) {
  if (!n) return;
  grid.invalidateNavigationCache?.();
  for (const page of folderTree.pages.values())
    for (const item of page.items) if (item.id === n.id) Object.assign(item, n);
  const opened = folderTree.openNodes.get(n.id);
  if (opened) Object.assign(opened, n);
  const root = S.roots.find((x) => x.id === n.id);
  if (root) Object.assign(root, n);
  for (const item of grid.items.values()) if (item.id === n.id) Object.assign(item, n);
  if (S.current?.id === n.id) {
    Object.assign(S.current, n);
    const img = $('#intro-area .intro-cover');
    if (img) {
      img.style.display = '';
      applyCoverCrop(img, n);
      const src = thumb(n);
      if (img.getAttribute('src')?.replace(/&p=1(?=&|$)/g, '') !== src.replace(/&p=1(?=&|$)/g, ''))
        img.src = src;
    }
  }
  for (const el of $$(`.album-card[data-id="${n.id}"]`)) {
    if (n.kind === 'folder') {
      updateFolderCard(el, n);
      continue;
    }
    const img = el.querySelector('img'),
      src = thumb(n);
    img.style.display = '';
    img.classList.toggle(
      'icon-cover',
      n.cover_source === 'folder-icon' || n.cover_source === 'local-icon' || !n.cover
    );
    applyCoverCrop(img, n);
    if (img.getAttribute('src')?.replace(/&p=1(?=&|$)/g, '') !== src.replace(/&p=1(?=&|$)/g, '')) {
      img.fetchPriority = 'high';
      img.src = src;
    }
    el.querySelector('.card-review')?.remove();
    el.querySelector('.cover-shell').insertAdjacentHTML('beforeend', cardReviewBadge(n));
    el.setAttribute(
      'aria-label',
      '打开相册：' + n.name + (cardReviewMessage(n) ? '，' + cardReviewMessage(n) : '')
    );
    el.querySelector('.card-subtitle span:last-child').textContent = n.manual_cover
      ? '自选封面'
      : n.cover_source === 'bangumi'
        ? 'Bangumi'
        : '本地';
    el.oncontextmenu = (e) => showContext(e, n);
  }
  for (const tile of $$('.collection-tile'))
    if (tile.dataset.id === n.id) {
      const img = tile.querySelector('img');
      img.style.opacity = '';
      applyCoverCrop(img, n);
      img.classList.toggle('folder-icon', n.cover_source === 'folder-icon' || !n.cover);
      const src = thumb(n);
      if (img.getAttribute('src')?.replace(/&p=1(?=&|$)/g, '') !== src.replace(/&p=1(?=&|$)/g, ''))
        img.src = src;
      tile.querySelector('.card-review')?.remove();
      tile.querySelector('.collection-image').insertAdjacentHTML('beforeend', cardReviewBadge(n));
      tile
        .querySelector('.collection-open')
        .setAttribute(
          'aria-label',
          '打开分类 ' + n.name + (cardReviewMessage(n) ? '，' + cardReviewMessage(n) : '')
        );
      tile.oncontextmenu = (e) => showContext(e, n);
    }
  // Pending-only collections need to drop newly confirmed items, but ordinary libraries stay intact.
  if ((S.view === 'pending' || S.filter === 'pending') && !cardReviewMessage(n))
    attempt(refreshGrowingView);
}
function renderIdentitySettings(content) {
  const $ = (selector) => content.querySelector(selector);
  content.innerHTML = `<div class="identity-preview"><img id="identity-avatar" class="user-avatar" src="${esc(S.settings.avatar || '../assets/default-avatar.jpg')}" alt="个人头像"><div><strong class="user-name">${esc(S.settings.nickname || '新朋友')}</strong><p>你的相册，你的名字。</p></div></div><label for="profile-name">显示名称</label><input id="profile-name" class="field-input" maxlength="24" value="${esc(S.settings.nickname || '新朋友')}" autocomplete="nickname"><p class="field-hint">在右上角显示，最多 24 个字符。</p><div class="setting-row"><div><strong>个人头像</strong><p>选择图片后自动裁成方形头像。</p></div><div class="identity-actions"><button id="avatar-choose" class="subtle-button">选择图片</button><button id="avatar-reset" class="text-button">恢复默认</button></div></div><div class="modal-actions"><button id="profile-save" class="primary">保存名称</button></div>`;
  $('#profile-save').onclick = () =>
    attempt(async () => {
      const input = $('#profile-name'),
        value = input.value.trim();
      if (!value || value.length > 24) {
        input.focus();
        throw new Error('请输入 1–24 个字符的名称。');
      }
      await saveSetting('nickname', value);
      toast('显示名称已保存');
    });
  $('#profile-name').onkeydown = (e) => {
    if (e.key === 'Enter') $('#profile-save').click();
  };
  $('#avatar-choose').onclick = () =>
    attempt(async () => {
      const button = $('#avatar-choose'),
        generation = modalGeneration;
      button.disabled = true;
      try {
        const avatar = await api('chooseAvatar');
        if (avatar !== null) {
          S.settings.avatar = avatar;
          applySettings();
          if (generation === modalGeneration && content.isConnected && $('#identity-avatar'))
            $('#identity-avatar').src = avatar;
          toast('头像已保存');
        }
      } finally {
        if (button.isConnected) button.disabled = false;
      }
    });
  $('#avatar-reset').onclick = () =>
    attempt(async () => {
      await saveSetting('avatar', '');
      if (content.isConnected && $('#identity-avatar'))
        $('#identity-avatar').src = '../assets/default-avatar.jpg';
      toast('已恢复默认头像');
    });
}
const sidebarShell = $('#sidebar-shell');
// Input anywhere in the window supersedes a pending keyboard/refresh focus intent.
for (const event of ['pointerdown', 'keydown', 'focusin', 'wheel'])
  window.addEventListener(
    event,
    () => {
      treeFocusIntent++;
    },
    { capture: true, passive: true }
  );
sidebarShell.addEventListener('pointerenter', () => {
  clearTimeout(sidebarTimer);
  if ((S.settings.sidebarMode || 'auto') === 'auto') scheduleSidebar(true, 40);
});
sidebarShell.addEventListener('pointerleave', () => scheduleSidebar(false, 160));
sidebarShell.addEventListener('focusin', (e) => {
  if (e.target.closest('#sidebar-details')) setSidebarOpen(true);
});
sidebarShell.addEventListener('focusout', () => scheduleSidebar(false, 160));
sidebarShell.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    setSidebarOpen(false);
  }
});
// Hover can reveal the shell first; a click still expands a directory's children.
$('#rail-tree').onclick = () => attempt(openFolderTree);
$('#sidebar-pin').onclick = () =>
  attempt(() =>
    saveSetting(
      'sidebarMode',
      S.settings.sidebarMode === 'expanded' ? sidebarUnpinnedMode : 'expanded'
    )
  );
$('#profile-button').onclick = () => attempt(() => settingsModal('profile'));
$('#collapse-all').onclick = () => {
  treeFocusIntent++;
  treeRecovery = null;
  treeRetained.clear();
  folderTree.generation++;
  folderTree.open.clear();
  folderTree.openNodes.clear();
  folderTree.pages.clear();
  folderTree.loading.clear();
  folderTree.positions.clear();
  folderTree.requests.clear();
  folderTree.errors.clear();
  renderFolderTree();
  S.overviewExpanded.clear();
  if (isOverview()) attempt(() => loadPage(true));
};
$('#category-nav').addEventListener('keydown', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  const group = row.closest('.tree-node'),
    index = group.treeDescriptor.index,
    intent = ++treeFocusIntent,
    origin = document.activeElement;
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? treeLayout.total - 1
          : index + (e.key === 'ArrowDown' ? 1 : -1);
    attempt(() => focusTreeIndex(next, intent, origin));
  }
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (row.getAttribute('aria-expanded') === 'false') row.querySelector('.tree-toggle').click();
    else if (row.getAttribute('aria-expanded') === 'true')
      attempt(() => focusTreeIndex(index + 1, intent, origin));
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (row.getAttribute('aria-expanded') === 'true') row.querySelector('.tree-toggle').click();
    else {
      const parentIndex = treeLayout.indexOf(group.treeNode.parent);
      if (parentIndex >= 0) attempt(() => focusTreeIndex(parentIndex, intent, origin));
    }
  }
});
const treeViewport = $('#category-nav');
treeViewport.addEventListener('scroll', scheduleTreeRender, { passive: true });
treeViewport.addEventListener('focusin', scheduleTreeRender);
if (typeof ResizeObserver === 'function')
  new ResizeObserver(scheduleTreeRender).observe(treeViewport);
else window.addEventListener('resize', scheduleTreeRender);
window.applyNavigationSettings = applyNavigationSettings;
window.renderFolderTree = renderFolderTree;
window.invalidateFolderTree = invalidateFolderTree;
applyNavigationSettings();
renderFolderTree();
