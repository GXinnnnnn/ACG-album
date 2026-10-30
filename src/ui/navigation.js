'use strict';
// Floating navigation is independent of the virtual image grid: hover never relays it out.
const folderTree = {
  open: new Set(),
  openNodes: new Map(),
  pages: new Map(),
  loading: new Set(),
  rootOffset: 0,
  generation: 0
};
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
  const base = folderTree.openNodes.get(id)?.path?.toLowerCase();
  for (const [child, n] of folderTree.openNodes)
    if (child === id || (base && n.path.toLowerCase().startsWith(base + '\\'))) {
      folderTree.open.delete(child);
      folderTree.openNodes.delete(child);
    }
  folderTree.open.delete(id);
}
function invalidateFolderTree() {
  folderTree.generation++;
  folderTree.pages.clear();
  folderTree.loading.clear();
  const roots = new Set(S.roots.map((n) => n.id));
  for (const [id, n] of folderTree.openNodes) if (!n.parent && !roots.has(id)) collapseBranch(id);
  renderFolderTree();
}
async function fetchTreePage(n, offset = 0) {
  if (folderTree.loading.has(n.id)) return;
  const generation = folderTree.generation;
  folderTree.loading.add(n.id);
  renderFolderTree();
  try {
    const result = await api('list', {
      parent: n.id,
      filter: 'folders',
      sort: 'name',
      limit: 12,
      offset
    });
    if (generation !== folderTree.generation) return;
    folderTree.pages.set(n.id, { ...result, offset });
    // Retain open branches and their visible pages, rather than an unbounded directory cache.
    if (folderTree.pages.size > 32)
      for (const id of folderTree.pages.keys()) {
        if (!folderTree.open.has(id)) folderTree.pages.delete(id);
        if (folderTree.pages.size <= 24) break;
      }
  } finally {
    if (generation === folderTree.generation) {
      folderTree.loading.delete(n.id);
      renderFolderTree();
    }
  }
}
async function toggleTree(n) {
  if (folderTree.open.has(n.id)) {
    collapseBranch(n.id);
    renderFolderTree();
    return;
  }
  const siblings = n.parent ? folderTree.pages.get(n.parent)?.items || [] : S.roots;
  for (const sibling of siblings) if (sibling.id !== n.id) collapseBranch(sibling.id);
  folderTree.open.add(n.id);
  folderTree.openNodes.set(n.id, n);
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
  const visible = S.roots.slice(folderTree.rootOffset, folderTree.rootOffset + 12);
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
  setSidebarOpen(true);
  const n = folderTreeEntryRoot();
  if (!n) {
    renderFolderTree();
    return;
  }
  folderTree.rootOffset = Math.floor(S.roots.indexOf(n) / 12) * 12;
  // Opening the shell is separate from expanding a real directory branch.
  // The action is idempotent after hover and while an existing page is loading.
  if (n.folders > 0 && !folderTree.open.has(n.id)) await toggleTree(n);
  else if (n.folders > 0 && !folderTree.pages.has(n.id) && !folderTree.loading.has(n.id))
    await fetchTreePage(n);
  else renderFolderTree();
}
function treePager(parent, n, offset, total, pageSize, root = false) {
  if (total <= pageSize) return;
  const pager = document.createElement('div');
  pager.className = 'tree-pager';
  pager.setAttribute('role', 'group');
  pager.setAttribute('aria-label', '文件夹分页');
  for (const [label, target] of [
    ['上一页', offset - pageSize],
    ['下一页', offset + pageSize]
  ]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.disabled = target < 0 || target >= total;
    b.onclick = () =>
      attempt(async () => {
        if (root) {
          folderTree.rootOffset = target;
          renderFolderTree();
        } else {
          for (const child of folderTree.pages.get(n.id)?.items || []) collapseBranch(child.id);
          await fetchTreePage(n, target);
        }
      });
    pager.append(b);
  }
  const span = document.createElement('span');
  span.textContent = `${offset + 1}–${Math.min(offset + pageSize, total)} / ${fmt(total)}`;
  pager.append(span);
  parent.append(pager);
}
let renderedTreeHost = null,
  renderedTreeSignature = '';
function visibleTreeState() {
  if (folderTree.rootOffset >= S.roots.length) folderTree.rootOffset = 0;
  const rows = [],
    nodes = new Map();
  function visit(n, depth) {
    if (rows.length >= 96) return;
    nodes.set(n.id, n);
    const open = folderTree.open.has(n.id),
      page = folderTree.pages.get(n.id);
    rows.push([
      n.id,
      n.name,
      n.path,
      n.folders,
      depth,
      open,
      open && folderTree.loading.has(n.id),
      open && page ? [page.offset, page.total] : null
    ]);
    if (open && depth < 5 && !folderTree.loading.has(n.id))
      for (const child of page?.items || []) visit(child, depth + 1);
  }
  for (const n of S.roots.slice(folderTree.rootOffset, folderTree.rootOffset + 12)) visit(n, 0);
  return {
    nodes,
    signature: JSON.stringify([S.roots.length, folderTree.rootOffset, S.current?.id, rows])
  };
}
function renderFolderTree() {
  const host = $('#category-nav');
  if (!host) return;
  const state = visibleTreeState();
  if (renderedTreeHost === host && renderedTreeSignature === state.signature) {
    // Event handlers read the current record even when metadata did not change
    // the visible tree. Keep keyboard focus and existing DOM/canvas intact.
    for (const group of host.querySelectorAll('.tree-node'))
      group.treeNode = state.nodes.get(group.dataset.nodeId) || group.treeNode;
    return;
  }
  renderedTreeHost = host;
  renderedTreeSignature = state.signature;
  const scroll = host.scrollTop,
    focusId = host.contains(document.activeElement) ? document.activeElement.dataset.treeKey : null;
  host.replaceChildren();
  if (!S.roots.length) {
    host.innerHTML = '<p class="sidebar-empty">导入文件夹后<br>在这里逐层浏览相册</p>';
    return;
  }
  let rendered = 0;
  function append(n, parent, depth) {
    if (rendered++ >= 96) return;
    const group = document.createElement('div');
    group.className = 'tree-node';
    group.dataset.nodeId = n.id;
    group.treeNode = n;
    const row = document.createElement('div');
    row.className =
      'tree-row' + (S.current?.id === n.id ? ' selected' : '') + (!depth ? ' tree-root' : '');
    row.style.setProperty('--depth', Math.min(depth, 4));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(S.current?.id === n.id));
    const expandable = n.folders > 0;
    const open = folderTree.open.has(n.id);
    if (expandable) row.setAttribute('aria-expanded', String(open));
    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle' + (open ? ' expanded' : '');
    toggle.innerHTML = svg('chevron-right');
    toggle.disabled = !expandable;
    toggle.dataset.treeKey = n.id + ':toggle';
    toggle.setAttribute('aria-label', (open ? '收起' : '展开') + n.name);
    toggle.onclick = () => attempt(() => toggleTree(group.treeNode));
    const link = document.createElement('button');
    link.className = 'category-link';
    link.dataset.treeKey = n.id + ':link';
    link.innerHTML =
      svg('folder') +
      `<span class="category-name">${esc(n.name)}</span>${!depth ? `<span class="category-total">${fmt(n.folders)}</span>` : ''}`;
    link.title = n.path;
    link.onclick = () => attempt(() => navigate({ parent: n.id }));
    row.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Paged structure is retained across matches; actions need current metadata.
      return attempt(async () => {
        const current = await api('get', { id: n.id });
        if (!current || !host.contains(group)) return;
        group.treeNode = current;
        showContext(e, current);
      });
    };
    row.append(toggle, link);
    group.append(row);
    parent.append(group);
    if (open) {
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.setAttribute('role', 'group');
      group.append(children);
      if (depth >= 5) {
        const more = document.createElement('button');
        more.className = 'tree-more';
        more.textContent = '在相册中继续浏览 →';
        more.onclick = () => attempt(() => navigate({ parent: n.id }));
        children.append(more);
        return;
      }
      const page = folderTree.pages.get(n.id);
      if (!page && !folderTree.loading.has(n.id))
        queueMicrotask(() => attempt(() => fetchTreePage(n)));
      if (folderTree.loading.has(n.id)) {
        const pending = document.createElement('p');
        pending.className = 'tree-pending';
        pending.textContent = '正在读取…';
        pending.setAttribute('role', 'status');
        children.append(pending);
      } else if (page) {
        for (const child of page.items) append(child, children, depth + 1);
        if (!page.items.length) {
          const empty = document.createElement('p');
          empty.className = 'tree-pending';
          empty.textContent = '没有子文件夹';
          children.append(empty);
        }
        treePager(children, n, page.offset, page.total, 12);
      }
    }
  }
  if (folderTree.rootOffset >= S.roots.length) folderTree.rootOffset = 0;
  for (const n of S.roots.slice(folderTree.rootOffset, folderTree.rootOffset + 12))
    append(n, host, 0);
  treePager(host, null, folderTree.rootOffset, S.roots.length, 12, true);
  host.scrollTop = scroll;
  if (focusId)
    host.querySelector(`[data-tree-key="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
}
function updateCoverNode(n) {
  if (!n) return;
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
      if (img.getAttribute('src') !== src) img.src = src;
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
    if (img.getAttribute('src') !== src) {
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
      if (img.getAttribute('src') !== src) img.src = src;
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
    attempt(() => loadPage(true));
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
  folderTree.generation++;
  folderTree.open.clear();
  folderTree.openNodes.clear();
  folderTree.pages.clear();
  folderTree.loading.clear();
  renderFolderTree();
  S.overviewExpanded.clear();
  if (isOverview()) attempt(() => loadPage(true));
};
$('#category-nav').addEventListener('keydown', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  const rows = [...$('#category-nav').querySelectorAll('.tree-row')],
    index = rows.indexOf(row);
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
    e.preventDefault();
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? rows.length - 1
          : Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)));
    rows[next].querySelector('.category-link').focus();
  }
  if (e.key === 'ArrowRight' && row.getAttribute('aria-expanded') === 'false') {
    e.preventDefault();
    row.querySelector('.tree-toggle').click();
  }
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (row.getAttribute('aria-expanded') === 'true') row.querySelector('.tree-toggle').click();
    else
      row.parentElement.parentElement
        .closest('.tree-node')
        ?.querySelector('.category-link')
        ?.focus();
  }
});
window.applyNavigationSettings = applyNavigationSettings;
window.renderFolderTree = renderFolderTree;
window.invalidateFolderTree = invalidateFolderTree;
applyNavigationSettings();
renderFolderTree();
