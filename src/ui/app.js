'use strict';
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const icons = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  heart:
    '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  collapse: '<path d="m8 7 4 4 4-4m-8 10 4-4 4 4"/>',
  settings:
    '<path d="M12.22 2h-.44a2 2 0 0 0-2 1.72l-.12.91a2 2 0 0 1-1.18 1.52l-.24.11a2 2 0 0 1-1.9-.18l-.74-.54a2 2 0 0 0-2.64.67l-.22.38a2 2 0 0 0 .64 2.68l.73.55a2 2 0 0 1 .8 1.7v.27a2 2 0 0 1-.8 1.71l-.73.54a2 2 0 0 0-.64 2.68l.22.39a2 2 0 0 0 2.64.67l.74-.54a2 2 0 0 1 1.9-.18l.24.11a2 2 0 0 1 1.18 1.52l.12.91A2 2 0 0 0 11.78 22h.44a2 2 0 0 0 2-1.72l.12-.91a2 2 0 0 1 1.18-1.52l.24-.11a2 2 0 0 1 1.9.18l.74.54a2 2 0 0 0 2.64-.67l.22-.39a2 2 0 0 0-.64-2.68l-.73-.54a2 2 0 0 1-.8-1.71v-.27a2 2 0 0 1 .8-1.71l.73-.54a2 2 0 0 0 .64-2.68l-.22-.38a2 2 0 0 0-2.64-.67l-.74.54a2 2 0 0 1-1.9.18l-.24-.11a2 2 0 0 1-1.18-1.52l-.12-.91A2 2 0 0 0 12.22 2Z"/><circle cx="12" cy="12" r="3"/>',
  'arrow-left': '<path d="m12 5-7 7 7 7M5 12h14"/>',
  home: '<path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 2M5 16a8 8 0 0 0 13 2"/>',
  sort: '<path d="M4 6h16M4 12h11M4 18h6"/>',
  'arrow-down': '<path d="M12 4v16m-6-6 6 6 6-6"/>',
  sliders: '<path d="M5 3v5m0 4v9M12 3v10m0 4v4M19 3v2m0 4v12"/><path d="M2 8h6m1 9h6m1-12h6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  'chevron-left': '<path d="m15 5-7 7 7 7"/>',
  'chevron-right': '<path d="m9 5 7 7-7 7"/>',
  'chevron-down': '<path d="m5 9 7 7 7-7"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m21 16-6-6L3 21"/>',
  crop: '<path d="M6 3v15h15M3 6h15v15"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  link: '<path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M13 17a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1" transform="translate(1 -1) scale(.9)"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  sparkles:
    '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/><path d="m20 2 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>'
};
icons.clock = '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>';
icons.video = '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 6 4-6 4V8Z"/>';
const svg = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.folder}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = svg(el.dataset.icon);
    el.removeAttribute('data-icon');
  });
}
hydrateIcons();
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const api = (method, args = {}) => window.album.call(method, args);
const fmt = (n) => new Intl.NumberFormat('zh-CN').format(n || 0);
const bytes = (n) => {
  if (!n) return '0 B';
  const unit = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
  return (n / 1024 ** unit).toFixed(unit ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][unit];
};
const date = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');
const S = {
  view: 'library',
  parent: null,
  current: null,
  roots: [],
  settings: { density: 222, ratio: 'poster', theme: 'light', autoMatch: true },
  filter: 'all',
  sort: 'name',
  direction: 'asc',
  search: '',
  history: [],
  rev: Date.now(),
  scrolls: new Map(),
  overviewExpanded: new Set(),
  loadVersion: 0
};
let toastTimer,
  searchTimer,
  changedTimer,
  progressHideTimer,
  onlineToast = 0,
  modalReturnFocus = null,
  modalGeneration = 0;
function toast(text, error = false) {
  clearTimeout(toastTimer);
  const host = $('#modal').open ? $('#modal') : $('#viewer').open ? $('#viewer') : document.body;
  host.append($('#toast-region'));
  $('#toast-region').innerHTML =
    `<div class="toast ${error ? 'error' : ''}">${svg(error ? 'alert' : 'check-circle')}<span>${esc(text)}</span></div>`;
  toastTimer = setTimeout(() => $('#toast-region').replaceChildren(), error ? 6500 : 3500);
}
async function attempt(action) {
  try {
    return await action();
  } catch (e) {
    toast(e.message || String(e), true);
    return null;
  }
}
function thumb(n) {
  const desired = Number(S.settings.density || 222) * (window.devicePixelRatio || 1) * 1.3;
  const size = desired <= 512 ? 512 : desired <= 768 ? 768 : 1024;
  const source = n.kind === 'folder' && /^[a-f0-9]{24}$/.test(n.cover) ? n.cover : n.id;
  return `acg-image://thumb/${source}?v=${S.rev}&size=${size}${n.manual_cover ? '&p=1' : ''}${n.cover_revision ? '&r=' + encodeURIComponent(n.cover_revision) : ''}`;
}
function applySettings() {
  document.documentElement.dataset.theme = S.settings.theme;
  document.documentElement.style.setProperty('--card-width', S.settings.density + 'px');
  document.documentElement.style.setProperty(
    '--poster-ratio',
    S.settings.ratio === 'tall' ? 9 / 16 : S.settings.ratio === 'square' ? 1 : 3 / 4.12
  );
  $('#theme-button').innerHTML = svg(S.settings.theme === 'dark' ? 'sun' : 'moon');
  $('#theme-button').title = S.settings.theme === 'dark' ? '切换到明亮主题' : '切换到深色主题';
  $('#theme-button').setAttribute('aria-label', $('#theme-button').title);
  if ($('#theme-select')) $('#theme-select').value = S.settings.theme;
  window.applyNavigationSettings?.();
  applyDisplaySettings();
}
async function saveSetting(key, value) {
  await api('settings', { key, value });
  S.settings[key] = value;
  applySettings();
}
function queryArgs() {
  return {
    parent: S.parent,
    search: S.search,
    sort: S.sort,
    direction: S.direction,
    filter: S.filter,
    ...(S.view === 'timeline'
      ? {
          timeline: true,
          month: S.timelineMonth || '',
          place: S.timelinePlace || '',
          direction: 'desc'
        }
      : {}),
    ...(S.view === 'favorites' ? { favorites: true } : {}),
    ...(S.view === 'pending' ? { filter: 'pending' } : {})
  };
}
function isOverview() {
  return !S.parent && !S.search && S.view === 'library' && S.filter !== 'images';
}
function viewKey() {
  return JSON.stringify([S.view, S.parent, S.search, S.filter, S.sort, S.direction]);
}
function snapshot() {
  return {
    view: S.view,
    parent: S.parent,
    search: S.search,
    filter: S.filter,
    sort: S.sort,
    direction: S.direction,
    scroll: $('#viewport').scrollTop
  };
}
async function navigate(
  { view = 'library', parent = null, search = '', filter = 'all' } = {},
  push = true
) {
  if (push) {
    S.history.push(snapshot());
    S.scrolls.set(viewKey(), $('#viewport').scrollTop);
  }
  Object.assign(S, { view, parent, search, filter });
  $('#search').value = search;
  await loadPage();
  $('#viewport').scrollTop = S.scrolls.get(viewKey()) || 0;
  $('#viewport').focus({ preventScroll: true });
}
async function back() {
  const previous = S.history.pop();
  if (!previous) {
    if (S.current?.parent) return navigate({ parent: S.current.parent }, false);
    if (S.parent) return navigate({}, false);
    return;
  }
  Object.assign(S, previous);
  $('#search').value = S.search;
  await loadPage();
  $('#viewport').scrollTop = previous.scroll || 0;
}
function updateSidebar() {
  $('#root-count').textContent = S.roots.length;
  window.renderFolderTree?.();
}
async function loadSummary() {
  const init = await api('init');
  if (init.localIndex) window.albumLocalSearch?.setStatus(init.localIndex);
  S.roots = init.roots;
  S.settings = { ...S.settings, ...init.settings };
  applySettings();
  $('#index-count').textContent = init.stats.images
    ? fmt(init.stats.images) + ' 个媒体项目已索引'
    : '本地资料库';
  $('#index-status').textContent = init.stats.images
    ? `${fmt(init.stats.folders)} 个文件夹 · 索引已保存`
    : '原图留在原处，热爱随时可见';
  updateSidebar();
  return init;
}
async function loadPage(keepScroll = false) {
  const version = ++S.loadVersion,
    scroll = $('#viewport').scrollTop;
  grid.reset();
  $('#category-overview').replaceChildren();
  $('#empty-state').replaceChildren();
  $('#intro-area').replaceChildren();
  $('#back-button').disabled = !S.history.length && !S.parent;
  S.current = S.parent ? await api('get', { id: S.parent }) : null;
  if (version !== S.loadVersion) return;
  if (S.parent && !S.current) S.parent = null;
  $$('.main-nav .nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === S.view && !S.parent)
  );
  updateSidebar();
  const title = S.search
    ? `搜索“${S.search}”`
    : S.current?.name ||
      { library: '我的相册', favorites: '特别收藏', pending: '待确认项目' }[S.view];
  $('#page-title').textContent = title;
  $('#page-title').insertAdjacentHTML('beforeend', '<span class="heading-dot">.</span>');
  $('#eyebrow').textContent = S.search
    ? 'FIND YOUR FAVORITES'
    : S.current
      ? 'A WORLD WORTH KEEPING'
      : {
          library: 'YOUR PERSONAL COLLECTION',
          favorites: 'CLOSE TO YOUR HEART',
          pending: 'A LITTLE ATTENTION NEEDED'
        }[S.view];
  $('#page-description').textContent = S.search
    ? '搜索本地索引中的文件夹与媒体名称。'
    : S.current
      ? `${fmt(S.current.folders)} 个子相册 · ${fmt(S.current.files)} 个媒体项目 · ${bytes(S.current.total_bytes)}`
      : {
          library: '把散落的画面，整理成喜欢的世界。',
          favorites: '为喜欢的相册与画面，留一个特别的位置。',
          pending: '在这里核对未满分的作品匹配和自动生成的封面，右键可更改关联或确认。'
        }[S.view];
  $('#footer-location').textContent = S.current?.path || 'ACG-album · 本地相册';
  $('#footer-location').title = S.current?.path || '';
  $('#refresh-button').hidden = !S.roots.length;
  $('#refresh-button').disabled = false;
  $$('.filter-tabs button').forEach((b) =>
    b.classList.toggle('active', b.dataset.filter === S.filter)
  );
  $('#sort').value = S.sort;
  $('#sort-direction').style.transform = S.direction === 'desc' ? 'rotate(180deg)' : '';
  updateMediaView();
  const crumbs = $('#breadcrumbs');
  crumbs.innerHTML = '<button data-home>资料库</button>';
  crumbs.querySelector('button').onclick = () => attempt(() => navigate({}));
  if (S.current) {
    const ancestors = await api('ancestors', { id: S.current.id });
    if (version !== S.loadVersion) return;
    for (const n of ancestors) {
      crumbs.insertAdjacentHTML('beforeend', svg('chevron-right'));
      const b = document.createElement('button');
      b.textContent = n.name;
      b.title = n.path;
      b.onclick = () => attempt(() => navigate({ parent: n.id }));
      crumbs.append(b);
    }
  }
  if (S.current && !S.search) renderIntro(S.current);
  if (isOverview()) {
    grid.hide();
    $('#result-count').textContent = `${fmt(S.roots.length)} 个分类`;
    if (!S.roots.length) renderEmpty();
    else await renderOverview(version);
  } else {
    const total = await grid.load(queryArgs(), version);
    if (version !== S.loadVersion) return;
    $('#result-count').textContent = `${fmt(total)} 项`;
    if (!total) renderEmpty(false);
  }
  if (keepScroll) $('#viewport').scrollTop = scroll;
  else $('#viewport').scrollTop = 0;
  updateScrollActions();
}
function renderEmpty(first = true) {
  const firstRun = first && !S.roots.length;
  $('#empty-state').innerHTML = firstRun
    ? `<div class="empty-panel"><div class="empty-art" aria-hidden="true"><span class="art-spark">✧</span><div class="art-photo one"></div><div class="art-photo two"></div></div><h2>你的热爱，值得好好收藏</h2><p>选择一个文件夹，把游戏、动画与漫画的画面收入相册。<br>目录会成为分类，子文件夹会成为一张张封面卡片。</p><div class="empty-actions"><button class="primary" id="empty-import">${svg('plus')}导入第一个文件夹</button><button class="subtle-button" id="demo-import">${svg('sparkles')}体验示例图库</button></div><p class="empty-helper">原图留在原处 · 本地索引与缩略图 · 支持多层目录</p></div>`
    : `<div class="empty-panel empty-search">${svg(S.view === 'favorites' ? 'heart' : S.view === 'pending' ? 'check-circle' : 'search')}<h2>${S.view === 'favorites' ? '特别的画面，留给特别收藏' : S.view === 'pending' ? '需要核对的项目都已确认' : '这里暂时没有内容'}</h2><p>${S.view === 'favorites' ? '右键相册或图片，选择「加入特别收藏」。' : S.view === 'pending' ? '之后需要核对的作品匹配和封面，会在这里显示。' : '换个搜索词或筛选条件，或更新文件夹索引。'}</p></div>`;
  $('#empty-import')?.addEventListener('click', importFolder);
  $('#demo-import')?.addEventListener('click', () =>
    attempt(async () => {
      const b = $('#demo-import');
      b.disabled = true;
      try {
        const result = await api('demo');
        if (result) {
          await loadSummary();
          await navigate({ parent: result.root });
          toast('示例图库已导入，其中图片为程序生成的演示素材。');
        }
      } finally {
        if (b.isConnected) b.disabled = false;
      }
    })
  );
}
function cardReviewMessage(n) {
  // Persisted manual confirmation wins over legacy review flags. A Bangumi
  // association is a successful match at any confidence; only local fallback
  // covers without an associated entry need review.
  if (n.kind !== 'folder' || n.confirmed || n.subject_id > 0 || n.character_id > 0) return '';
  return n.cover_source === 'fallback' ? '本地封面待确认；右键可更改封面或关联条目' : '';
}
function cardReviewBadge(n) {
  const message = cardReviewMessage(n);
  if (!message) return '';
  return `<span class="card-review" title="${esc(message)}"></span>`;
}
function card(n, index = 0, inline = false) {
  const b = document.createElement('button');
  b.className = 'album-card' + (n.kind !== 'folder' ? ' image-card media-card' : '');
  b.dataset.index = index;
  b.dataset.id = n.id;
  b.title = n.name;
  b.setAttribute(
    'aria-label',
    (n.kind === 'folder' ? '打开相册：' : '查看图片：') +
      n.name +
      (cardReviewMessage(n) ? '，' + cardReviewMessage(n) : '')
  );
  const icon =
    n.cover_source === 'folder-icon' ||
    n.cover_source === 'local-icon' ||
    (n.kind === 'folder' && !n.cover);
  b.innerHTML = `<div class="cover-shell"><span class="cover-placeholder">${svg(n.kind === 'folder' ? 'folder' : 'image')}</span><img alt="" draggable="false" class="${icon ? 'icon-cover' : ''}" style="object-position:${n.crop_x ?? 50}% ${n.crop_y ?? 50}%"><span class="cover-gradient"></span>${cardReviewBadge(n)}${n.favorite ? `<span class="card-favorite">${svg('heart')}</span>` : ''}<div class="card-bottom-overlay">${svg(n.kind === 'folder' ? 'folder' : 'image')}<span>${n.kind === 'folder' ? fmt(n.files) + ' 张' : pathExt(n.name)}</span>${n.metadata?.rating?.score ? `<span class="card-rating">★ ${Number(n.metadata.rating.score).toFixed(1)}</span>` : ''}</div></div><div class="card-info"><span class="card-title">${esc(n.name)}</span><span class="card-subtitle"><span>${n.kind === 'folder' ? (n.folders ? fmt(n.folders) + ' 个子相册' : '本地相册') : bytes(n.bytes)}</span><span>${n.kind === 'folder' ? (n.manual_cover ? '自选封面' : n.cover_source === 'bangumi' ? 'Bangumi' : '本地') : new Date(n.mtime).toLocaleDateString('zh-CN')}</span></span></div>`;
  const img = b.querySelector('img');
  applyCoverCrop(img, n);
  img.onload = () => {
    img.classList.add('loaded');
    b.querySelector('.cover-placeholder')?.remove();
  };
  img.onerror = () => {
    img.style.display = 'none';
    if (n.kind === 'video') window.queueVideoThumbnail?.(n, img);
  };
  img.src = thumb(n);
  if (n.kind !== 'folder') window.decorateMediaCard?.(b, n);
  b.onclick = () =>
    attempt(() =>
      n.kind === 'folder' ? navigate({ parent: n.id }) : openViewer(n, index, inline)
    );
  b.oncontextmenu = (e) => showContext(e, n);
  return b;
}
// Import checkpoints update folder data without replacing the loaded cover or keyboard focus.
function updateFolderCard(b, n, index = Number(b.dataset.index) || 0) {
  b.dataset.index = index;
  b.title = n.name;
  b.setAttribute(
    'aria-label',
    '打开相册：' + n.name + (cardReviewMessage(n) ? '，' + cardReviewMessage(n) : '')
  );
  const img = b.querySelector('img');
  img.style.display = '';
  img.classList.toggle(
    'icon-cover',
    ['folder-icon', 'local-icon'].includes(n.cover_source) || !n.cover
  );
  applyCoverCrop(img, n);
  const src = thumb(n);
  if (img.getAttribute('src') !== src) img.src = src;
  b.querySelector('.card-title').textContent = n.name;
  const subtitle = b.querySelector('.card-subtitle');
  subtitle.firstElementChild.textContent = n.folders ? fmt(n.folders) + ' 个子相册' : '本地相册';
  subtitle.lastElementChild.textContent = n.manual_cover
    ? '自选封面'
    : n.cover_source === 'bangumi'
      ? 'Bangumi'
      : '本地';
  b.querySelector('.card-bottom-overlay').innerHTML =
    `${svg('folder')}<span>${fmt(n.files)} 张</span>${n.metadata?.rating?.score ? `<span class="card-rating">★ ${Number(n.metadata.rating.score).toFixed(1)}</span>` : ''}`;
  b.querySelector('.card-review')?.remove();
  b.querySelector('.cover-shell').insertAdjacentHTML('beforeend', cardReviewBadge(n));
  if (!n.favorite) b.querySelector('.card-favorite')?.remove();
  else if (!b.querySelector('.card-favorite'))
    b.querySelector('.cover-shell').insertAdjacentHTML(
      'beforeend',
      `<span class="card-favorite">${svg('heart')}</span>`
    );
  b.onclick = () => attempt(() => navigate({ parent: n.id }));
  b.oncontextmenu = (e) => showContext(e, n);
  return b;
}
function pathExt(name) {
  return name.split('.').pop().toUpperCase();
}
async function renderOverview(version) {
  const target = $('#category-overview');
  target.className = 'category-overview';
  let roots = [...S.roots];
  const k = { name: 'name', date: 'birth', modified: 'mtime', size: 'total_bytes' }[S.sort];
  roots.sort(
    (a, b) =>
      (k === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        : (a[k] || 0) - (b[k] || 0)) * (S.direction === 'desc' ? -1 : 1)
  );
  const existing = new Map([...target.children].map((tile) => [tile.dataset.id, tile]));
  let cursor = target.firstElementChild;
  for (const n of roots) {
    if (version !== S.loadVersion) return;
    const retained = existing.get(String(n.id));
    const tile = retained || document.createElement('section'),
      expanded = S.overviewExpanded.has(n.id);
    tile.dataset.id = n.id;
    tile.className = 'collection-tile' + (expanded ? ' expanded' : '');
    if (!retained)
      tile.innerHTML = `<div class="collection-image"><img alt="" class="${n.cover_source === 'folder-icon' || !n.cover ? 'folder-icon' : ''}"><button class="collection-open" aria-label="打开分类 ${esc(n.name)}${cardReviewMessage(n) ? '，' + esc(cardReviewMessage(n)) : ''}"></button>${cardReviewBadge(n)}<span class="collection-path">本地分类</span></div><div class="collection-details"><div><h3>${esc(n.name)}</h3><p>${fmt(n.folders)} 个相册 · ${fmt(n.files)} 个媒体项目</p></div><button class="category-enter" title="打开分类" aria-label="打开 ${esc(n.name)}">${svg('arrow-left').replace('<svg ', '<svg style="transform:rotate(180deg)" ')}</button><button class="category-expand" aria-label="${expanded ? '收起' : '展开'}分类" title="${expanded ? '收起' : '展开'}分类" aria-expanded="${expanded}">${svg(expanded ? 'collapse' : 'chevron-down')}</button></div>`;
    tile.querySelector('h3').textContent = n.name;
    tile.querySelector('.collection-details p').textContent =
      `${fmt(n.folders)} 个相册 · ${fmt(n.files)} 个媒体项目`;
    tile
      .querySelector('.collection-open')
      .setAttribute(
        'aria-label',
        `打开分类 ${n.name}${cardReviewMessage(n) ? '，' + cardReviewMessage(n) : ''}`
      );
    tile.querySelector('.card-review')?.remove();
    tile.querySelector('.collection-image').insertAdjacentHTML('beforeend', cardReviewBadge(n));
    const cover = tile.querySelector('img');
    applyCoverCrop(cover, n);
    cover.classList.toggle('folder-icon', n.cover_source === 'folder-icon' || !n.cover);
    const src = thumb(n);
    if (cover.getAttribute('src') !== src) {
      cover.style.opacity = '';
      cover.src = src;
    }
    tile.querySelector('img').onerror = (e) => (e.target.style.opacity = '0');
    for (const el of tile.querySelectorAll('.collection-open,.category-enter'))
      el.onclick = () => attempt(() => navigate({ parent: n.id }));
    tile.querySelector('.category-expand').onclick = () => {
      if (expanded) S.overviewExpanded.delete(n.id);
      else S.overviewExpanded.add(n.id);
      attempt(() => loadPage(true));
    };
    tile.oncontextmenu = (e) => showContext(e, n);
    if (tile !== cursor) target.insertBefore(tile, cursor);
    cursor = tile.nextElementSibling;
    existing.delete(String(n.id));
    if (expanded) {
      const preview = tile.querySelector('.collection-preview') || document.createElement('div');
      preview.className = 'collection-preview';
      if (!preview.isConnected) tile.append(preview);
      const result = await api('list', {
        parent: n.id,
        filter: 'folders',
        limit: 12,
        sort: S.sort,
        direction: S.direction
      });
      if (version !== S.loadVersion) return;
      const cards = new Map(
        [...preview.querySelectorAll('.album-card')].map((el) => [el.dataset.id, el])
      );
      let next = preview.firstElementChild;
      for (const child of result.items) {
        const previous = cards.get(String(child.id));
        const el = previous ? updateFolderCard(previous, child) : card(child, 0, true);
        if (el !== next) preview.insertBefore(el, next);
        next = el.nextElementSibling;
        cards.delete(String(child.id));
      }
      for (const el of cards.values()) el.remove();
      const more = preview.querySelector('.collection-more') || document.createElement('button');
      more.className = 'collection-more';
      more.innerHTML = `打开分类，查看全部内容 ${svg('chevron-right')}`;
      more.onclick = () => attempt(() => navigate({ parent: n.id }));
      if (preview.lastElementChild !== more) preview.append(more);
    } else tile.querySelector('.collection-preview')?.remove();
  }
  for (const tile of existing.values()) tile.remove();
}
const grid = createVirtualGrid();
let renderFrame = 0;
$('#viewport').addEventListener(
  'scroll',
  () => {
    if (!renderFrame)
      renderFrame = requestAnimationFrame(() => {
        renderFrame = 0;
        grid.render();
      });
  },
  { passive: true }
);
let observedGridWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === observedGridWidth) return;
  observedGridWidth = entry.contentRect.width;
  requestAnimationFrame(() => grid.layout());
}).observe($('#virtual-grid'));
function shouldIntro(n) {
  if (S.view === 'timeline' || n.effective_album_kind === 'photo') return false;
  return (
    n.intro === 1 ||
    (n.intro !== 0 && n.depth >= 1 && n.depth <= Number(S.settings.subjectDepth || 1))
  );
}
function renderIntro(n) {
  if (n.effective_album_kind === 'character') return renderCharacterIntro(n);
  const area = $('#intro-area');
  area.replaceChildren();
  if (!shouldIntro(n)) return;
  const m = n.metadata;
  if (!m) {
    area.innerHTML = `<div class="intro-unbound"><span>${svg('sparkles')}</span><div><strong>为这个相册，补上作品的故事</strong><p>${n.subject_id ? '作品关联已保留，简介缓存已清除，可重新同步。' : '可自动匹配 Bangumi，也可以直接粘贴作品条目网址。'}</p></div><button class="subtle-button" id="intro-bind">${svg('link')}关联作品</button></div>`;
    $('#intro-bind').onclick = () => bindModal(n);
    return;
  }
  const staff = (m.staff || [])
    .slice(0, 4)
    .map((p) => p.name + (p.relation ? ' · ' + p.relation : ''))
    .join(' / ');
  area.innerHTML = `<section class="intro-panel"><div class="intro-art"><img class="intro-cover" alt="${esc(m.name_cn || m.name)}"></div><div class="intro-content"><div class="intro-labels"><span class="chip accent">${{ 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '影视' }[m.type] || '作品'}</span>${m.date ? `<span class="chip">${esc(m.date)}</span>` : ''}<span class="chip">${n.manual_subject ? '手动关联' : '自动匹配'} · 本地缓存</span></div><h2>${esc(m.name_cn || m.name)}</h2><div class="intro-original">${esc(m.name || '')}</div><p class="intro-summary">${esc(m.summary || '暂无简介')}</p>${staff ? `<div class="intro-staff">${esc(staff)}</div>` : ''}<div class="intro-actions"><button id="intro-details" class="text-button">查看完整简介 ${svg('chevron-right')}</button><button id="intro-edit" class="text-button">${svg('link')}更改关联</button><button id="intro-refresh" class="text-button">${svg('refresh')}更新评分与简介</button></div></div><div class="intro-score"><strong>${m.rating?.score ? Number(m.rating.score).toFixed(1) : '—'}</strong><small>Bangumi 评分</small><small>${fmt(m.rating?.total)} 人评价</small></div></section>`;
  if (n.association_type_mismatch) {
    const types = (n.effective_subject_types || [])
      .map((t) => ({ 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' })[t])
      .join(' / ');
    area.insertAdjacentHTML(
      'afterbegin',
      `<p class="inline-error" role="status">当前关联不符合本相册的${esc(types)}筛选。${n.manual_subject ? '这是之前手动保存的关联，已保留供你核对。' : '重新检索会按当前类型更新关联。'} <button id="intro-type-recheck" class="text-button">重新选择作品</button></p>`
    );
    $('#intro-type-recheck').onclick = () => bindModal(n);
  }
  const img = area.querySelector('img');
  applyCoverCrop(img, n);
  img.src = thumb(n);
  img.onerror = () => (img.style.display = 'none');
  $('#intro-details').onclick = () => detailModal(n);
  $('#intro-edit').onclick = () => bindModal(n);
  $('#intro-refresh').onclick = (e) =>
    attempt(async () => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const updated = await api('refreshMetadata', { id: n.id });
        S.current = updated;
        renderIntro(updated);
        toast('简介、Staff 与评分已更新');
      } catch (err) {
        if (button.isConnected) button.disabled = false;
        throw err;
      }
    });
}
function renderCharacterIntro(n) {
  const area = $('#intro-area');
  area.replaceChildren();
  if (!shouldIntro(n)) return;
  const m = n.metadata;
  if (!m) {
    area.innerHTML = `<div class="intro-unbound"><span>${svg('sparkles')}</span><div><strong>为这个相册，补上角色的故事</strong><p>${n.character_id ? '角色关联已保留，可重新同步简介。' : '仅唯一精确名称会自动关联；可手动选角色或填写自定义简介。'}</p></div><button class="subtle-button" id="intro-bind">${svg('link')}关联角色</button></div>`;
    $('#intro-bind').onclick = () => characterBindModal(n);
    return;
  }
  area.innerHTML = `<section class="intro-panel"><div class="intro-art"><img class="intro-cover" alt="${esc(m.name_cn || m.name)}"></div><div class="intro-content"><div class="intro-labels"><span class="chip accent">角色</span><span class="chip">${m.source === 'custom' ? '自定义资料' : n.manual_character ? '手动关联' : '精确匹配'} · 本地保存</span></div><h2>${esc(m.name_cn || m.name)}</h2><div class="intro-original">${esc(m.name || '')}</div><p class="intro-summary">${esc(m.summary || '暂无简介')}</p><div class="intro-actions"><button id="intro-details" class="text-button">查看完整简介 ${svg('chevron-right')}</button><button id="intro-edit" class="text-button">${svg('link')}更改角色资料</button>${m.source !== 'custom' ? `<button id="intro-refresh" class="text-button">${svg('refresh')}更新角色简介</button>` : ''}</div></div></section>`;
  const image = area.querySelector('img');
  applyCoverCrop(image, n);
  image.src = thumb(n);
  image.onerror = () => (image.style.display = 'none');
  $('#intro-details').onclick = () => detailModal(n);
  $('#intro-edit').onclick = () => characterBindModal(n);
  if ($('#intro-refresh'))
    $('#intro-refresh').onclick = (event) =>
      attempt(async () => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          S.current = await api('refreshMetadata', { id: n.id });
          renderIntro(S.current);
          toast('角色简介已更新');
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
}
function characterBindModal(n) {
  const custom = n.metadata?.source === 'custom';
  openModal(
    '关联角色简介',
    `<div class="binding-scroll"><p>为「${esc(n.name)}」选择角色资料。手动保存后，自动检索与重扫会保留你的选择。</p><label for="character-mode">资料来源</label><select id="character-mode" class="field-input"><option value="bangumi">Bangumi 角色条目</option><option value="custom">自定义名称与简介</option></select><div id="character-online-fields"><label for="character-keyword">角色名称</label><input id="character-keyword" class="field-input" maxlength="240" value="${esc(n.name)}"><p class="field-help">自动匹配仅接受唯一精确名称；同名角色、模糊与不完整结果需手动核对。联网检索受 API 权限与 Access Token 影响。</p><label for="character-url">角色网址或 ID</label><input id="character-url" class="field-input" placeholder="https://bgm.tv/character/123" value="${n.character_id ? 'https://bgm.tv/character/' + n.character_id : ''}"><p class="field-help">支持 bgm.tv、bangumi.tv、chii.in 的角色网址。本地封面优先与角色简介关联可独立使用。</p><p id="character-status" class="field-help" role="status" aria-live="polite"></p><div id="character-candidates" class="candidate-list" aria-label="角色候选"></div></div><div id="character-custom-fields" hidden><label for="character-name">角色名称</label><input id="character-name" class="field-input" maxlength="240" value="${esc(custom ? n.metadata.name : n.name)}"><label for="character-summary">角色简介</label><textarea id="character-summary" class="field-input" rows="8" maxlength="30000">${esc(custom ? n.metadata.summary : '')}</textarea><p class="field-help">自定义资料保存在资料库，封面可继续使用本地首图或手动指定。</p></div><p id="character-error" class="inline-error" role="alert"></p></div><div class="modal-actions binding-actions"><button id="character-search" class="subtle-button">${svg('sparkles')}检索角色候选</button><button id="character-save" class="primary">保存角色资料</button></div>`
  ).classList.add('binding-modal');
  const generation = modalGeneration,
    mode = $('#character-mode'),
    search = $('#character-search'),
    save = $('#character-save');
  const keyword = $('#character-keyword'),
    url = $('#character-url'),
    list = $('#character-candidates'),
    status = $('#character-status'),
    error = $('#character-error');
  let request = 0;
  const connected = () => generation === modalGeneration && save.isConnected;
  const updateMode = () => {
    request++;
    $('#character-online-fields').hidden = mode.value !== 'bangumi';
    $('#character-custom-fields').hidden = mode.value !== 'custom';
    search.hidden = mode.value !== 'bangumi';
    error.textContent = '';
  };
  mode.value = custom ? 'custom' : 'bangumi';
  mode.onchange = updateMode;
  updateMode();
  keyword.oninput = () => {
    request++;
    list.replaceChildren();
    url.value = '';
    status.textContent = '名称已改变，请重新检索。';
  };
  search.onclick = async () => {
    const ticket = ++request;
    search.disabled = save.disabled = true;
    error.textContent = '';
    list.replaceChildren();
    status.textContent = '正在检索角色名称，选择候选并保存后才会更改关联…';
    try {
      const result = await api('match', { id: n.id, kind: 'character', keyword: keyword.value });
      if (!connected() || ticket !== request) return;
      list.innerHTML = (result?.candidates || [])
        .map(
          (candidate) =>
            `<button class="candidate" data-character="${candidate.id}" aria-pressed="false"><span><strong>${esc(candidate.name_cn || candidate.name)}</strong><small>${esc(candidate.name)} · 角色 #${candidate.id}</small></span><span class="chip">${candidate.exact ? '名称精确' : '需核对'}</span></button>`
        )
        .join('');
      status.textContent = result?.candidates?.length
        ? '请核对同名角色，选中后点击「保存角色资料」。'
        : '没有找到角色，可换用原名、粘贴角色链接或填写自定义资料。';
      list.querySelectorAll('.candidate').forEach(
        (button) =>
          (button.onclick = () => {
            list
              .querySelectorAll('.candidate')
              .forEach((item) => item.setAttribute('aria-pressed', String(item === button)));
            url.value = 'https://bgm.tv/character/' + button.dataset.character;
            status.textContent = '角色已选中，点击「保存角色资料」确认。';
          })
      );
    } catch (exception) {
      if (connected() && ticket === request) error.textContent = exception.message;
    } finally {
      if (connected()) search.disabled = save.disabled = false;
    }
  };
  save.onclick = async () => {
    if (save.disabled) return;
    request++;
    save.disabled = search.disabled = mode.disabled = true;
    error.textContent = '';
    try {
      const args = { id: n.id, kind: 'character' };
      if (mode.value === 'custom')
        args.custom = { name: $('#character-name').value, summary: $('#character-summary').value };
      else args.url = url.value;
      await api('bind', args);
      if (!connected()) return;
      closeModal();
      await loadPage(true);
      toast('角色资料已保存');
    } catch (exception) {
      if (connected()) error.textContent = exception.message;
    } finally {
      if (connected()) save.disabled = search.disabled = mode.disabled = false;
    }
  };
  (custom ? $('#character-name') : keyword).focus();
}
function openModal(title, html, width = 610) {
  modalGeneration++;
  if (!$('#modal').open) modalReturnFocus = document.activeElement;
  const d = $('#modal');
  d.classList.remove('binding-modal', 'display-dialog');
  $('#modal-title').textContent = title;
  $('#modal-content').innerHTML = html;
  d.style.width = width + 'px';
  if (!d.open) d.showModal();
  hydrateIcons(d);
  return d;
}
function closeModal() {
  $('#modal').close();
  modalReturnFocus?.focus?.({ preventScroll: true });
}
$('#modal-close').onclick = closeModal;
$('#modal').addEventListener('click', (e) => {
  if (e.target === $('#modal') && !$('#settings-shell')) {
    const r = e.target.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
      closeModal();
  }
});
function detailModal(n) {
  const m = n.metadata;
  if (!m) return bindModal(n);
  if (n.effective_album_kind === 'character') {
    openModal(
      m.name_cn || m.name,
      `<p class="muted">${m.source === 'custom' ? '自定义角色资料' : 'https://bgm.tv/character/' + m.id}</p><div class="long-summary">${esc(m.summary || '暂无简介')}</div><h3>角色信息</h3><dl class="property-grid">${(
        m.infobox || []
      )
        .slice(0, 40)
        .map(
          (item) =>
            `<dt>${esc(item.key)}</dt><dd>${esc(typeof item.value === 'string' ? item.value : JSON.stringify(item.value))}</dd>`
        )
        .join(
          ''
        )}</dl>${m.source !== 'custom' ? `<div class="modal-actions"><button id="detail-character-external" class="subtle-button">${svg('external')}打开 Bangumi 角色</button></div>` : ''}`
    );
    if ($('#detail-character-external'))
      $('#detail-character-external').onclick = () =>
        attempt(() => api('external', { url: 'https://bgm.tv/character/' + m.id }));
    return;
  }
  openModal(
    m.name_cn || m.name,
    `<p class="muted">${esc(m.name)} · https://bgm.tv/subject/${m.id}</p><div class="long-summary">${esc(m.summary || '暂无简介')}</div><h3>Staff</h3><div class="long-summary">${esc((m.staff || []).map((p) => p.name + ' · ' + (p.relation || '')).join('\n') || '暂无 Staff 信息')}</div><h3>作品信息</h3><dl class="property-grid">${(
      m.infobox || []
    )
      .slice(0, 25)
      .map(
        (i) =>
          `<dt>${esc(i.key)}</dt><dd>${esc(typeof i.value === 'string' ? i.value : JSON.stringify(i.value))}</dd>`
      )
      .join(
        ''
      )}</dl><div class="modal-actions"><button id="detail-external" class="subtle-button">${svg('external')}打开 Bangumi 条目</button></div>`
  );
  $('#detail-external').onclick = () =>
    attempt(() => api('external', { url: 'https://bgm.tv/subject/' + m.id }));
}
function bindModal(n) {
  if (n.effective_album_kind === 'character') return characterBindModal(n);
  openModal(
    '关联作品简介',
    `<div class="binding-scroll"><p>为「${esc(n.name)}」指定 Bangumi 作品条目。手动关联后，自动匹配会保留你的选择。</p><label for="subject-type">检索类型</label><select class="field-input" id="subject-type"><option value="-1">继承上级分类与全局偏好</option><option value="0">全部类型</option><option value="2">动画</option><option value="1">书籍</option><option value="4">游戏</option><option value="3">音乐</option><option value="6">三次元 / 特摄</option></select><label for="subject-keyword">作品名称</label><input class="field-input" id="subject-keyword" value="${esc(n.name)}" placeholder="可输入具体番剧标题，例如黄金庭院"><p class="field-help">检索类型会保存到本相册，下级相册默认继承；不确定的候选需要你核对。</p><label for="subject-url">条目网址或 ID</label><input class="field-input" id="subject-url" placeholder="https://bgm.tv/subject/123" value="${n.subject_id ? 'https://bgm.tv/subject/' + n.subject_id : ''}"><p class="field-help">支持 bgm.tv、bangumi.tv、chii.in 的条目网址。简介、封面、评分和 Staff 会缓存在本地。</p><p id="bind-error" class="inline-error" role="alert"></p><p id="candidate-access" class="field-help" role="status" aria-live="polite">正在读取检索权限设置…</p><p id="candidate-status" class="field-help" role="status" aria-live="polite"></p><div id="candidate-list" class="candidate-list" aria-label="作品候选"></div></div><div class="modal-actions binding-actions"><button id="auto-match" class="subtle-button">${svg('sparkles')}检索候选作品</button><button id="bind-save" class="primary">保存关联</button></div>`
  ).classList.add('binding-modal');
  const typeSelect = $('#subject-type');
  const typeNames = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '三次元' };
  const inherited = (n.effective_subject_types || [])
    .map((t) => typeNames[t])
    .filter(Boolean)
    .join(' / ');
  if (n.search_type < 0 && inherited) typeSelect.options[0].textContent = `继承：${inherited}`;
  const errorArea = $('#bind-error');
  const accessArea = $('#candidate-access');
  const candidateStatus = $('#candidate-status');
  const candidateList = $('#candidate-list');
  const keywordInput = $('#subject-keyword');
  const urlInput = $('#subject-url');
  const bindGeneration = modalGeneration;
  let candidateRequest = 0;
  let searchAccessKnown = false;
  const showSearchAccess = (tokenPresent) => {
    accessArea.textContent = `${tokenPresent ? '已配置 Access Token；是否生效及可访问范围以 Bangumi 返回为准。' : '当前未使用 Access Token。'}本地索引可离线查名称；在线候选、详情和封面仍受 Bangumi API 权限影响。部分条目（如 R18）的在线内容可能不可用。可在偏好设置「作品简介」配置有相应权限的 Access Token 后重试；网页登录状态不会自动用于 API 请求，无需粘贴 Cookie。`;
  };
  api('tokenStatus')
    .then((status) => {
      if (bindGeneration === modalGeneration && accessArea.isConnected && !searchAccessKnown)
        showSearchAccess(status.saved && status.encrypted);
    })
    .catch(() => {
      if (accessArea.isConnected && !searchAccessKnown)
        accessArea.textContent =
          '本地索引可离线查名称；在线候选、详情和封面仍受 Bangumi API 权限影响。可在偏好设置「作品简介」配置 Access Token 后重试；网页登录状态不会自动用于 API 请求。';
    });
  const invalidateCandidates = () => {
    candidateRequest++;
    candidateList.replaceChildren();
    urlInput.value = '';
    candidateStatus.textContent = '检索条件已改变，请重新检索候选作品。';
  };
  keywordInput.oninput = invalidateCandidates;
  if (n.association_type_mismatch)
    errorArea.textContent = '当前关联不符合本相册的类型筛选，请重新检索并选择对应类型的作品。';
  let typeChange = Promise.resolve();
  typeSelect.value = n.search_type ?? -1;
  typeSelect.onchange = (e) => {
    invalidateCandidates();
    urlInput.value = '';
    const value = Number(e.target.value);
    typeChange = typeChange
      .catch(() => {})
      .then(async () => {
        await api('patch', { id: n.id, changes: { search_type: value } });
        n.search_type = value;
      });
    typeChange.catch((error) => {
      if (errorArea.isConnected) errorArea.textContent = error.message;
    });
  };
  async function waitForTypeChange() {
    while (true) {
      const pending = typeChange;
      try {
        await pending;
      } catch (error) {
        if (pending === typeChange) throw error;
      }
      if (pending === typeChange) return;
    }
  }
  async function bind(url) {
    const b = $('#bind-save'),
      a = $('#auto-match');
    if (b.disabled) return;
    const generation = modalGeneration;
    b.disabled =
      a.disabled =
      typeSelect.disabled =
      keywordInput.disabled =
      urlInput.disabled =
        true;
    b.textContent = '正在获取…';
    candidateList.querySelectorAll('.candidate').forEach((el) => (el.disabled = true));
    $('#bind-error').textContent = '';
    try {
      await waitForTypeChange();
      if (generation !== modalGeneration || !b.isConnected) return;
      await api('bind', { id: n.id, url });
      if (generation !== modalGeneration || !b.isConnected) return;
      closeModal();
      await loadPage(true);
      toast('作品关联已保存，简介已写入本地 Markdown');
    } catch (e) {
      if (errorArea.isConnected) errorArea.textContent = e.message;
    } finally {
      if (b.isConnected) {
        b.disabled =
          a.disabled =
          typeSelect.disabled =
          keywordInput.disabled =
          urlInput.disabled =
            false;
        b.textContent = '保存关联';
        candidateList.querySelectorAll('.candidate').forEach((el) => (el.disabled = false));
      }
    }
  }
  $('#bind-save').onclick = () => bind($('#subject-url').value);
  $('#subject-url').onkeydown = (e) => {
    if (e.key === 'Enter') bind(e.target.value);
  };
  $('#auto-match').onclick = async () => {
    const b = $('#auto-match');
    const save = $('#bind-save');
    const request = ++candidateRequest;
    b.disabled = save.disabled = true;
    b.textContent = '正在检索多个名称…';
    errorArea.textContent = '';
    candidateStatus.textContent =
      '正在检索候选；当前关联会保留，选择作品后点击「保存关联」才会更改。';
    candidateList.replaceChildren();
    urlInput.value = '';
    try {
      const generation = modalGeneration;
      const keyword = keywordInput.value;
      await waitForTypeChange();
      if (generation !== modalGeneration || !b.isConnected || request !== candidateRequest) return;
      const requestType = typeSelect.value;
      const result = await api('match', { id: n.id, keyword });
      if (
        generation !== modalGeneration ||
        !candidateList.isConnected ||
        request !== candidateRequest ||
        typeSelect.value !== requestType
      )
        return;
      if (result?.needs_selection) {
        if (result.searchAccess) {
          searchAccessKnown = true;
          showSearchAccess(result.searchAccess.tokenPresent);
        }
        candidateList.innerHTML = (result.candidates || [])
          .map(
            (c) =>
              `<button class="candidate" data-subject="${c.id}" aria-pressed="false"><span><strong>${esc(c.name_cn || c.name)}</strong><small>${esc(c.name)} · ${esc(typeNames[c.type] || '作品')} · ${esc(c.date || '日期未知')}</small></span><span class="chip">${Math.round(c.match * 100)}% 相关</span></button>`
          )
          .join('');
        candidateStatus.textContent = result.candidates?.length
          ? '请核对名称、类型和年份，选择候选后点击「保存关联」。本次检索尚未更改当前关联。'
          : '没有找到候选。请核对类型或换用原名检索，也可粘贴条目网址；受限条目请参阅上方权限提示。';
        candidateList.querySelectorAll('.candidate').forEach((el) => {
          el.onclick = () => {
            candidateList
              .querySelectorAll('.candidate')
              .forEach((button) => button.setAttribute('aria-pressed', String(button === el)));
            urlInput.value = 'https://bgm.tv/subject/' + el.dataset.subject;
            candidateStatus.textContent = `已选择「${el.querySelector('strong').textContent}」，点击「保存关联」确认。`;
          };
        });
      } else {
        candidateStatus.textContent = '检索条件已改变或任务已取消，请重新检索。';
      }
    } catch (e) {
      if (errorArea.isConnected && request === candidateRequest) {
        errorArea.textContent = e.message;
        candidateStatus.textContent = '本次检索未完成，当前关联保持不变。';
      }
    } finally {
      if (b.isConnected) {
        b.disabled = save.disabled = false;
        b.innerHTML = svg('sparkles') + '检索候选作品';
      }
    }
  };
}
async function properties(n) {
  if (n.kind !== 'folder') return mediaProperties(n);
  n = await api('get', { id: n.id });
  const dims = n.kind === 'image' ? await api('dimensions', { id: n.id }) : null;
  openModal(
    '属性',
    `<dl class="property-grid"><dt>名称</dt><dd>${esc(n.name)}</dd><dt>类型</dt><dd>${n.kind === 'folder' ? '相册文件夹' : esc(pathExt(n.name)) + ' 图片'}</dd><dt>文件地址</dt><dd>${esc(n.path)}</dd><div class="wide-rule"></div><dt>大小</dt><dd>${bytes(n.kind === 'folder' ? n.total_bytes : n.bytes)}${n.kind === 'folder' ? '（已索引媒体合计）' : ''}</dd>${n.kind === 'folder' ? `<dt>包含</dt><dd>${fmt(n.folders)} 个子文件夹，${fmt(n.files)} 个媒体项目</dd>` : `<dt>分辨率</dt><dd>${dims.width ? dims.width + ' × ' + dims.height : '暂不支持读取'}</dd>`}<dt>创建时间</dt><dd>${date(n.birth)}</dd><dt>修改时间</dt><dd>${date(n.mtime)}</dd><dt>索引时间</dt><dd>${date(n.indexed)}</dd>${n.kind === 'folder' ? `<div class="wide-rule"></div><dt>封面来源</dt><dd>${{ manual: '手动指定', 'local-icon': '本地 ICO 图标', 'local-name': '与文件夹同名的图片', fallback: '自动选择相册内图片', bangumi: 'Bangumi 作品封面', 'bangumi-character': 'Bangumi 角色立绘', 'folder-icon': 'Windows 自定义文件夹图标' }[n.cover_source] || 'Windows 文件夹图标'}${n.confirmed ? ' · 已确认' : ' · 待确认'}</dd><dt>${n.effective_album_kind === 'character' ? '角色条目' : '作品条目'}</dt><dd>${n.effective_album_kind === 'character' ? (n.character_id ? 'https://bgm.tv/character/' + n.character_id : n.custom_character ? '自定义角色资料' : '未关联') : n.subject_id ? 'https://bgm.tv/subject/' + n.subject_id : '未关联'}</dd><dt>简介缓存</dt><dd>${n.metadata_updated ? date(n.metadata_updated) : '未缓存'}</dd>` : ''}${n.scan_error ? `<dt>扫描提示</dt><dd>${esc(n.scan_error)}</dd>` : ''}</dl><div class="modal-actions"><button id="prop-copy" class="subtle-button">${svg('copy')}复制地址</button><button id="prop-reveal" class="primary">${svg('folder')}在资源管理器中定位</button></div>`
  );
  $('#prop-copy').onclick = () =>
    attempt(async () => {
      await api('copyPath', { id: n.id });
      toast('文件地址已复制');
    });
  $('#prop-reveal').onclick = () => attempt(() => api('reveal', { id: n.id }));
}
function confirmModal(title, message, onConfirm, label = '确认') {
  openModal(
    title,
    `<p>${esc(message)}</p><div class="modal-actions"><button id="confirm-cancel" class="subtle-button">取消</button><button id="confirm-ok" class="primary">${esc(label)}</button></div>`
  );
  const generation = modalGeneration;
  $('#confirm-cancel').onclick = closeModal;
  $('#confirm-ok').onclick = () =>
    attempt(async () => {
      const b = $('#confirm-ok');
      b.disabled = true;
      try {
        await onConfirm();
        if (generation === modalGeneration) closeModal();
      } catch (e) {
        b.disabled = false;
        throw e;
      }
    });
}
function showContext(e, n) {
  e.preventDefault();
  const menu = $('#context-menu');
  const host = $('#modal').open ? $('#modal') : $('#viewer').open ? $('#viewer') : document.body;
  host.append(menu);
  menu.replaceChildren();
  const actions = [];
  const action = (label, icon, fn, extra = {}) => actions.push({ label, icon, fn, ...extra });
  if (n.kind === 'folder') {
    action('相册类型…', 'folder', () => albumKindModal(n));
    action('按时间浏览此相册', 'clock', () =>
      navigate({ view: 'timeline', parent: n.id, filter: 'images' })
    );
    action('打开相册', 'folder', () => navigate({ parent: n.id }));
    action('更换封面…', 'image', async () => {
      const result = await api('chooseCover', { id: n.id });
      if (result) {
        updateCoverNode(result);
        toast('封面已保存，手动选择将始终优先。');
      }
    });
    action('调整封面位置…', 'crop', () => cropModal(n));
    if (n.match_review)
      action('确认当前作品匹配', 'check-circle', async () => {
        updateCoverNode(
          await api('patch', { id: n.id, changes: { match_review: 0, confirmed: 1 } })
        );
        toast('当前作品匹配已确认');
      });
    else if (!n.confirmed)
      action('确认当前封面', 'check-circle', async () => {
        updateCoverNode(await api('patch', { id: n.id, changes: { confirmed: 1 } }));
        toast('当前封面已确认');
      });
    action('恢复自动封面', 'refresh', async () => {
      updateCoverNode(await api('resetCover', { id: n.id }));
      toast('已恢复自动封面规则');
    });
    actions.push({ rule: true });
    action(
      n.effective_album_kind === 'character'
        ? n.character_id || n.custom_character
          ? '更改角色资料…'
          : '关联角色简介…'
        : n.subject_id
          ? '更改作品关联…'
          : '关联作品简介…',
      'link',
      () => bindModal(n)
    );
    action(shouldIntro(n) ? '隐藏顶部简介' : '显示顶部简介', 'info', async () => {
      await api('patch', { id: n.id, changes: { intro: shouldIntro(n) ? 0 : 1 } });
      await loadPage(true);
    });
  } else {
    action(
      n.kind === 'video' ? '播放视频' : '打开图片',
      n.kind === 'video' ? 'video' : 'image',
      () => openViewer(n, [...grid.items.entries()].find(([, v]) => v.id === n.id)?.[0] || 0)
    );
    action('拍摄信息与地点…', 'info', () => mediaProperties(n));
    if (n.kind === 'image') {
      action('编辑副本…', 'crop', () => openEditor(n));
      action('复制图片', 'copy', async () => {
        await api('copyImage', { id: n.id });
        toast('图片已复制，可以粘贴到 QQ 等聊天窗口。');
      });
    } else action('用系统播放器打开', 'external', () => api('openMedia', { id: n.id }));
  }
  actions.push({ rule: true });
  action(n.favorite ? '移出特别收藏' : '加入特别收藏', 'heart', async () => {
    await api('patch', { id: n.id, changes: { favorite: n.favorite ? 0 : 1 } });
    await loadPage(true);
    toast(n.favorite ? '已移出特别收藏' : '已加入特别收藏');
  });
  action('在资源管理器中定位', 'external', () => api('reveal', { id: n.id }));
  action('复制文件地址', 'copy', async () => {
    await api('copyPath', { id: n.id });
    toast('文件地址已复制');
  });
  action('属性…', 'info', () => properties(n));
  if (n.kind === 'folder' && !n.parent) {
    actions.push({ rule: true });
    action(
      '从资料库移除分类…',
      'trash',
      () =>
        confirmModal(
          '移除分类',
          `将「${n.name}」从相册索引移除。该目录中的原始文件会保留。`,
          async () => {
            await api('removeRoot', { id: n.id });
            await loadSummary();
            await navigate({}, false);
            toast('分类已从资料库移除');
          },
          '移除分类'
        ),
      { danger: true }
    );
  }
  for (const a of actions) {
    if (a.rule) {
      const hr = document.createElement('div');
      hr.className = 'menu-rule';
      menu.append(hr);
      continue;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (a.danger) b.className = 'danger';
    b.innerHTML = svg(a.icon) + '<span>' + esc(a.label) + '</span>';
    b.onclick = () => {
      hideContext();
      attempt(a.fn);
    };
    menu.append(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(e.clientX, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(e.clientY, innerHeight - r.height - 8)) + 'px';
  menu.querySelector('button')?.focus({ preventScroll: true });
}
function hideContext() {
  $('#context-menu').hidden = true;
}
document.addEventListener('pointerdown', (e) => {
  if (!$('#context-menu').contains(e.target)) hideContext();
});
document.addEventListener('keydown', (e) => {
  if (!$('#context-menu').hidden) {
    const bs = [...$('#context-menu').querySelectorAll('button')],
      i = bs.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      hideContext();
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
    }
  }
});
let pendingImport = null,
  scanActive = false,
  growingTimer = null,
  growingTask = null,
  growingDirty = false,
  growingLast = 0,
  overviewLast = 0;
function updateImportBusy() {
  for (const b of $$('#import-sidebar,#empty-import,#demo-import')) {
    b.disabled = !!pendingImport || scanActive;
    b.setAttribute('aria-busy', String(b.disabled));
  }
}
async function enterPendingImport(p) {
  const token = pendingImport;
  if (!token || !p.active || !p.root || token.entered || token.entering) return;
  token.sawProgress = true;
  if (token.version !== S.loadVersion || token.key !== viewKey() || $('#viewer').open) {
    token.entered = true;
    return;
  }
  token.entering = true;
  try {
    // The first checkpoint may precede the root upsert; retry at the next one.
    const root = await api('get', { id: p.root });
    if (!root || pendingImport !== token) return;
    if (token.version !== S.loadVersion || token.key !== viewKey() || $('#viewer').open) {
      token.entered = true;
      return;
    }
    token.entered = true;
    await navigate({ parent: root.id });
  } finally {
    token.entering = false;
  }
}
async function refreshGrowingView() {
  const version = S.loadVersion,
    key = viewKey();
  await loadSummary();
  updateImportBusy();
  if (version !== S.loadVersion || key !== viewKey()) return;
  if (isOverview()) {
    if ($('#viewer').open) return;
    if (Date.now() - overviewLast < 1500) {
      growingDirty = true;
      return;
    }
    overviewLast = Date.now();
    const scroll = $('#viewport').scrollTop;
    if (S.roots.length) $('#empty-state').replaceChildren();
    $('#result-count').textContent = `${fmt(S.roots.length)} 个分类`;
    await renderOverview(version);
    if (version === S.loadVersion) $('#viewport').scrollTop = scroll;
  } else if (grid.active) {
    const total = await grid.refreshGrowing();
    if (version !== S.loadVersion || key !== viewKey()) return;
    $('#result-count').textContent = `${fmt(total)} 项`;
    if (total) $('#empty-state').replaceChildren();
    if (S.parent) {
      const current = await api('get', { id: S.parent });
      if (version !== S.loadVersion || key !== viewKey()) return;
      if (current) {
        if (JSON.stringify(S.current?.metadata) !== JSON.stringify(current.metadata))
          renderIntro(current);
        S.current = current;
        $('#page-description').textContent =
          `${fmt(current.folders)} 个子相册 · ${fmt(current.files)} 个媒体项目 · ${bytes(current.total_bytes)}`;
      }
    }
  }
  updateScrollActions();
}
function scheduleGrowingRefresh() {
  growingDirty = true;
  if (growingTimer !== null || growingTask) return;
  growingTimer = setTimeout(
    () => {
      growingTimer = null;
      growingDirty = false;
      growingLast = Date.now();
      growingTask = attempt(refreshGrowingView).finally(() => {
        growingTask = null;
        if (growingDirty) scheduleGrowingRefresh();
      });
    },
    Math.max(0, 1200 - (Date.now() - growingLast))
  );
}
const importChoices = {
  onlineMatch: false,
  subjectTypes: [1, 2, 4, 6],
  directoryKind: 'work',
  characterCover: 'local-first'
};
function importFolder() {
  if (pendingImport || scanActive) return;
  const existing = $('#import-options');
  if (existing?.isConnected && $('#modal').open) {
    $('#import-directory-kind').focus({ preventScroll: true });
    return;
  }
  const categories = [
    { label: '动画', type: 2 },
    { label: '漫画', type: 1 },
    { label: '游戏', type: 4 },
    { label: '三次元', type: 6 }
  ];
  const dialog = openModal(
    '导入文件夹',
    `<div id="import-options" class="import-options"><p class="import-options-intro">保留文件夹层级，原始文件留在原处。本次选择应用到整个导入目录，重扫时继续使用。</p><div class="import-select-row"><label for="import-directory-kind">文件夹按什么命名</label><select id="import-directory-kind"><option value="work">作品名称</option><option value="character">角色名称</option><option value="photo">普通图片 / 相册</option></select></div><div id="import-character-options" class="import-select-row" hidden><label for="import-character-cover">角色封面来源</label><select id="import-character-cover" aria-describedby="import-character-help"><option value="local-first">本地图片 · 自然名称顺序第一张</option><option value="bangumi">Bangumi 角色立绘 · 找不到用本地首图</option></select><p id="import-character-help">仅唯一精确名称自动关联；同名角色请右键手动绑定。封面选择不影响角色简介；立绘下载需要开启联网匹配。</p></div><label class="import-match-row" for="import-online-match"><span><strong id="import-match-label">联网匹配 Bangumi 作品</strong><span id="import-match-help">按文件夹的中、英、日文名称查找作品封面与简介。</span></span><input id="import-online-match" class="switch" type="checkbox" aria-expanded="false" aria-controls="import-subject-types" aria-describedby="import-match-help"></label><fieldset id="import-subject-types" class="import-subject-types" aria-describedby="import-category-help import-options-error" hidden disabled><legend>检索哪些作品</legend><div class="import-category-chips">${categories.map(({ label, type }) => `<button type="button" class="import-category-chip" data-import-subject-type="${type}" aria-pressed="true"><span class="import-category-check" aria-hidden="true">${svg('check-circle')}</span>${label}</button>`).join('')}</div><p id="import-category-help">可多选。匹配度超过 85% 时自动关联；分数接近时优先热门作品，人数接近时优先较早发行的作品。</p></fieldset><p id="import-options-error" class="inline-error" role="alert" hidden></p><p id="import-options-note" class="import-options-note">手动关联、封面和裁切会保留。</p><div class="modal-actions"><button id="import-options-cancel" type="button" class="subtle-button">取消</button><button id="import-options-confirm" type="button" class="primary">${svg('folder')}选择文件夹</button></div></div>`,
    560
  );
  dialog.setAttribute('aria-labelledby', 'modal-title');
  const root = $('#import-options'),
    toggle = $('#import-online-match'),
    fieldset = $('#import-subject-types'),
    error = $('#import-options-error'),
    chips = [...root.querySelectorAll('[data-import-subject-type]')];
  let submitted = false;
  const kindSelect = $('#import-directory-kind'),
    coverSelect = $('#import-character-cover');
  kindSelect.onchange = () => {
    importChoices.directoryKind = kindSelect.value;
    updateChoices();
  };
  coverSelect.onchange = () => {
    importChoices.characterCover = coverSelect.value;
    updateChoices();
  };
  function updateChoices() {
    const kind = importChoices.directoryKind;
    kindSelect.value = kind;
    coverSelect.value = importChoices.characterCover;
    $('#import-character-options').hidden = kind !== 'character';
    toggle.closest('label').hidden = kind === 'photo';
    $('#import-match-label').textContent =
      kind === 'character' ? '联网匹配 Bangumi 角色简介与立绘' : '联网匹配 Bangumi 作品';
    $('#import-match-help').textContent =
      kind === 'character'
        ? '先查本地角色索引；开启后可联网补全角色简介和所选立绘。'
        : '按文件夹的中、英、日文名称查找作品封面与简介。';
    $('#import-options-note').textContent =
      kind === 'character'
        ? '角色只按唯一精确名称自动关联，同名或未找到时保留本地首图，可右键手动绑定。自然顺序如 1、2、10；手动关联、封面和裁切会保留。'
        : kind === 'photo'
          ? '不匹配 Bangumi 条目，使用本地图片封面。手动封面和裁切会保留。'
          : '满分匹配不显示提示；未满分会标记匹配度，可右键更改作品关联或确认匹配。未开启或没有合适匹配时，使用最新本地图片。手动关联、封面和裁切会保留。';
    const enabled = kind === 'work' && importChoices.onlineMatch;
    toggle.checked = importChoices.onlineMatch;
    toggle.setAttribute('aria-expanded', String(enabled));
    fieldset.hidden = !enabled;
    fieldset.disabled = !enabled;
    for (const chip of chips) {
      chip.disabled = !enabled;
      chip.setAttribute(
        'aria-pressed',
        String(importChoices.subjectTypes.includes(Number(chip.dataset.importSubjectType)))
      );
    }
    if (!enabled || importChoices.subjectTypes.length) {
      error.hidden = true;
      error.textContent = '';
      fieldset.removeAttribute('aria-invalid');
    }
  }
  toggle.onchange = () => {
    importChoices.onlineMatch = toggle.checked;
    updateChoices();
  };
  for (const chip of chips) {
    chip.onclick = () => {
      const type = Number(chip.dataset.importSubjectType);
      importChoices.subjectTypes = importChoices.subjectTypes.includes(type)
        ? importChoices.subjectTypes.filter((value) => value !== type)
        : [...importChoices.subjectTypes, type].sort((a, b) => a - b);
      updateChoices();
    };
  }
  root.addEventListener('keydown', (event) => {
    if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault();
  });
  $('#import-options-cancel').onclick = closeModal;
  $('#import-options-confirm').onclick = () => {
    if (submitted || pendingImport || scanActive || !root.isConnected || !dialog.open) return;
    if (
      importChoices.directoryKind === 'work' &&
      importChoices.onlineMatch &&
      !importChoices.subjectTypes.length
    ) {
      error.textContent = '请至少选择一种作品类型，或关闭联网匹配。';
      error.hidden = false;
      fieldset.setAttribute('aria-invalid', 'true');
      chips[0].focus({ preventScroll: true });
      return;
    }
    submitted = true;
    const options = {
      onlineMatch: importChoices.directoryKind === 'photo' ? false : importChoices.onlineMatch,
      subjectTypes: [...importChoices.subjectTypes],
      directoryKind: importChoices.directoryKind,
      ...(importChoices.directoryKind === 'character'
        ? { characterCover: importChoices.characterCover }
        : {})
    };
    closeModal();
    void startFolderImport(options);
  };
  updateChoices();
  kindSelect.focus({ preventScroll: true });
}
async function startFolderImport(options) {
  if (pendingImport || scanActive) return;
  const token = { key: viewKey(), version: S.loadVersion, sawProgress: false, entered: false };
  pendingImport = token;
  updateImportBusy();
  await attempt(async () => {
    try {
      const result = await api('import', options);
      if (result) {
        await loadSummary();
        if (!token.sawProgress) await navigate({ parent: result.root });
        else scheduleGrowingRefresh();
        toast(
          result.cancelled
            ? '导入已取消，已索引内容保留'
            : `${options.onlineMatch ? `文件导入完成，${options.directoryKind === 'character' ? '角色' : '作品'}资料在后台检索` : '导入完成'}${result.errors ? '，有 ' + result.errors + ' 个资源无法访问，请查看属性或日志' : ''}`
        );
      }
    } finally {
      if (pendingImport === token) pendingImport = null;
      updateImportBusy();
    }
  });
}
async function refreshLibrary() {
  const b = $('#refresh-button');
  b.disabled = true;
  try {
    if (S.parent) await api('refresh', { id: S.parent });
    else for (const n of S.roots) await api('refresh', { id: n.id });
    await loadSummary();
    await loadPage(true);
    toast('索引已更新，未改变的缩略图已复用');
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false;
  }
}
function densityModal() {
  const help = S.parent
    ? `确认当前目录“${esc(S.current?.name || '已打开目录')}”下全部文件夹封面，清除当前页面红点；包含尚未滚动加载的项目，不受搜索或显示筛选限制。`
    : '确认当前页面全部文件夹封面，清除当前页面红点；包含尚未滚动加载的项目，首页同时包含已展开的相册预览。';
  const dialog = openModal(
    '查看设置',
    `<div class="density-popup" role="group" aria-label="卡片尺寸">${cardDisplayPresets.map(({ width, name, count }) => `<button class="density-choice" data-density="${width}" aria-pressed="false"><span class="density-icon" aria-hidden="true">${'<i></i>'.repeat(count)}</span>${name}卡片</button>`).join('')}</div><section class="page-review-setting" aria-labelledby="page-review-title"><div><strong id="page-review-title">批量确认封面</strong><p id="page-review-help">${help}</p></div><button id="clear-page-review" class="subtle-button" aria-describedby="page-review-help">${svg('check-circle')}批量确认封面</button><p id="page-review-status" class="display-help page-review-status" role="status" aria-live="polite" aria-atomic="true"></p></section><div class="setting-row"><div><strong>封面比例</strong><p>相册与图片共用；支持右键调整封面位置和缩放</p></div><select id="ratio-select" aria-label="封面比例"><option value="poster">海报 · 3:4.12</option><option value="tall">竖卡 · 9:16</option><option value="square">方形 · 1:1</option></select></div><p class="display-help">工具栏或 Ctrl + 鼠标滚轮可调整卡片大小，重启后保留选择。分类封面保留横向概览，切换尺寸时保留正在浏览的卡片。</p>`
  );
  dialog.classList.add('display-dialog');
  applyDisplaySettings();
  $$('#modal [data-density]').forEach(
    (b) =>
      (b.onclick = () => attempt(() => changeDisplaySetting('density', Number(b.dataset.density))))
  );
  $('#ratio-select').onchange = (e) => attempt(() => changeDisplaySetting('ratio', e.target.value));
  $('#clear-page-review').onclick = () => attempt(clearPageReview);
}
async function clearPageReview() {
  const button = $('#clear-page-review'),
    status = $('#page-review-status'),
    generation = modalGeneration,
    key = viewKey(),
    version = S.loadVersion,
    query = { ...queryArgs() },
    queryKey = JSON.stringify(query),
    scope = S.parent ? '当前目录' : '当前页面',
    previewIds = isOverview()
      ? $$('#category-overview .collection-preview .album-card').map((card) => card.dataset.id)
      : [];
  const sameBrowse = () => key === viewKey() && queryKey === JSON.stringify(queryArgs());
  if (!button || button.disabled) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `${svg('refresh')}正在批量确认…`;
  status.dataset.state = 'busy';
  status.textContent = `正在确认${scope}全部文件夹封面，包含未加载项目…`;
  let completionVersion = version,
    confirmed = false;
  try {
    const result = await api('confirmReview', {
      query,
      ...(previewIds.length ? { previewIds } : {})
    });
    confirmed = true;
    if (sameBrowse() && version === S.loadVersion) {
      clearTimeout(changedTimer);
      await loadSummary();
      if (sameBrowse() && version === S.loadVersion) {
        const refresh = loadPage(true);
        completionVersion = S.loadVersion;
        await refresh;
      }
    }
    if (generation === modalGeneration && status.isConnected) {
      status.dataset.state = 'success';
      status.textContent =
        sameBrowse() && completionVersion === S.loadVersion
          ? result.updated
            ? `已确认 ${fmt(result.updated)} 个文件夹封面，已清除当前页面红点。`
            : `${scope}全部文件夹封面均已确认，没有需要清除的红点。`
          : '';
    }
  } catch (error) {
    if (generation === modalGeneration && status.isConnected) {
      status.dataset.state = 'error';
      status.textContent =
        sameBrowse() && completionVersion === S.loadVersion
          ? `${confirmed ? '封面已确认，但页面刷新失败' : '批量确认失败'}：${error.message || String(error)}。请再次点击“批量确认封面”重试。`
          : '';
    }
  } finally {
    if (generation === modalGeneration && button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.innerHTML = `${svg('check-circle')}批量确认封面`;
    }
  }
}
async function settingsModal(tab = 'appearance') {
  const names = ['profile', 'appearance', 'metadata', 'cache', 'application'];
  if (!names.includes(tab)) tab = 'appearance';
  // One shell per opening. Panels stay connected so drafts and enhanced controls survive tabs.
  const existing = $('#modal').open && $('#settings-shell');
  if (existing?.switchTab) return existing.switchTab(tab);
  const dialog = openModal(
    '偏好设置',
    `<div id="settings-shell"><div class="settings-tabs" role="tablist" aria-label="偏好设置分类"><span class="settings-tab-indicator" aria-hidden="true"></span>${names.map((name, i) => `<button id="settings-tab-${name}" role="tab" aria-controls="settings-panel-${name}" aria-selected="false" tabindex="-1" data-tab="${name}">${['个人资料', '外观', '作品简介', '缓存与资料库', '应用'][i]}</button>`).join('')}</div><div id="settings-content" class="settings-viewport"><p class="settings-initial">正在准备设置…</p></div><p class="settings-status" role="status" aria-live="polite" aria-atomic="true"></p></div>`,
    680
  );
  dialog.classList.add('settings-dialog');
  const shell = $('#settings-shell'),
    viewport = shell.querySelector('#settings-content'),
    status = shell.querySelector('.settings-status'),
    tabs = [...shell.querySelectorAll('[data-tab]')],
    indicator = shell.querySelector('.settings-tab-indicator'),
    generation = modalGeneration,
    panels = new Map(),
    motion = matchMedia('(prefers-reduced-motion: reduce)');
  let serial = 0,
    current = null,
    requested = tab,
    disposed = false;
  const alive = () =>
    !disposed && dialog.open && shell.isConnected && generation === modalGeneration;
  const animate = (element, frames, duration) => {
    if (motion.matches) return null;
    return element.animate(frames, { duration, easing: 'cubic-bezier(.2,.7,.2,1)' });
  };
  const settle = () => {
    for (const panel of viewport.querySelectorAll('.settings-panel')) {
      panel.getAnimations().forEach((animation) => animation.cancel());
      panel.hidden = panel !== current;
      panel.inert = panel !== current;
      panel.setAttribute('aria-hidden', String(panel !== current));
    }
  };
  const placeIndicator = () => {
    const button = tabs.find((button) => button.dataset.tab === requested);
    const before = getComputedStyle(indicator).transform;
    indicator.getAnimations().forEach((animation) => animation.cancel());
    indicator.style.width = button.offsetWidth + 'px';
    indicator.style.height = button.offsetHeight + 'px';
    const transform = `translate(${button.offsetLeft}px, ${button.offsetTop}px)`;
    indicator.style.transform = transform;
    if (indicator.dataset.ready) animate(indicator, [{ transform: before }, { transform }], 210);
    indicator.dataset.ready = 'true';
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    serial++;
    observer.disconnect();
    resize.disconnect();
    motion.removeEventListener('change', reduceMotion);
    dialog.removeEventListener('close', closed);
    dialog.removeEventListener('cancel', cancel);
    shell.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
    if (
      !dialog.querySelector('#settings-shell') ||
      dialog.querySelector('#settings-shell') === shell
    )
      dialog.classList.remove('settings-dialog');
    shell.remove();
    panels.clear();
  };
  const closed = () => {
    if (!dialog.open) dispose();
  };
  const cancel = (event) => {
    // Preferences close explicitly with X. A control popover or info child
    // handles its own Escape without disposing the retained settings shell.
    event.preventDefault();
  };
  const reduceMotion = () => {
    if (motion.matches) {
      shell.getAnimations({ subtree: true }).forEach((animation) => animation.cancel());
      settle();
    }
  };
  const observer = new MutationObserver(() => {
    if (!alive()) dispose();
  });
  observer.observe($('#modal-content'), { childList: true });
  const resize = new ResizeObserver(placeIndicator);
  resize.observe(shell.querySelector('.settings-tabs'));
  motion.addEventListener('change', reduceMotion);
  dialog.addEventListener('close', closed);
  dialog.addEventListener('cancel', cancel);
  async function prepare(name) {
    const content = document.createElement('section');
    content.id = `settings-panel-${name}`;
    content.className = 'settings-panel';
    content.setAttribute('role', 'tabpanel');
    content.setAttribute('aria-labelledby', `settings-tab-${name}`);
    content.setAttribute('aria-hidden', 'true');
    content.tabIndex = 0;
    content.hidden = true;
    content.inert = true;
    viewport.append(content);
    // Existing handlers deliberately scope their selectors to their persistent panel.
    const $ = (selector) => content.querySelector(selector);
    const tab = name;
    try {
      await render();
      if (!alive()) return null;
      hydrateIcons(content);
      window.albumControls?.refresh();
      return content;
    } catch (error) {
      if (!alive()) return null;
      content.innerHTML = `<div class="settings-error" role="alert"><h3>暂时无法读取设置</h3><p>${esc(error.message || '请稍后重试。')}</p><button class="subtle-button" data-settings-retry>重试</button></div>`;
      content.querySelector('[data-settings-retry]').onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '正在重试…';
        try {
          await render();
          if (alive()) {
            hydrateIcons(content);
            window.albumControls?.refresh();
          }
        } catch (retryError) {
          if (alive())
            content.querySelector('.settings-error p').textContent =
              retryError.message || '请稍后重试。';
        } finally {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = '重试';
          }
        }
      };
      return content;
    }
    async function render() {
      if (tab === 'application') {
        content.innerHTML = `<div class="application-summary"><img src="../assets/app.png" alt=""><div><h3>ACG-album</h3><p id="settings-app-version">正在读取版本…</p></div></div><div class="setting-row"><div><strong>关于 ACG-album</strong><p>认识作者，查看开源致谢与项目信息。</p></div><button id="settings-about" class="subtle-button">${svg('info')}关于</button></div><div class="setting-row"><div><strong>应用更新</strong><p>检查新版本并管理更新来源。</p></div><button id="settings-updates" class="subtle-button">${svg('refresh')}检查更新</button></div><div class="setting-row"><div><strong>退出应用</strong><p>结束 ACG-album 的运行。</p></div><button id="settings-quit" class="text-button danger">退出应用</button></div><p class="field-help">资料库使用 SQLite 保存；原始文件保留在导入目录。</p>`;
        $('#settings-about').onclick = () => attempt(() => window.showAbout());
        $('#settings-updates').onclick = () => attempt(() => window.showUpdates());
        $('#settings-quit').onclick = () => attempt(() => api('quit'));
        try {
          const info = await api('appInfo');
          if (content.isConnected)
            content.querySelector('#settings-app-version').textContent = info?.version
              ? `版本 ${info.version}`
              : '未提供版本信息';
        } catch {
          if (content.isConnected)
            content.querySelector('#settings-app-version').textContent = '版本信息暂不可用';
        }
      }
      if (tab === 'profile') renderIdentitySettings(content);
      if (tab === 'appearance') {
        content.innerHTML = `<div class="setting-row"><div><strong>侧栏</strong><p>自动模式在悬停时展开，固定后为主内容留出空间。</p></div><select id="sidebar-mode"><option value="auto">悬停自动展开</option><option value="expanded">始终展开</option><option value="compact">点击展开</option></select></div><div class="setting-row"><div><strong>主题</strong><p>樱粉强调色与柔和的玻璃面板</p></div><select id="theme-select"><option value="light">浅色 · 雾樱</option><option value="dark">深色 · 夜藏</option></select></div><div class="setting-row"><div><strong>卡片尺寸与比例</strong><p>可在相册工具栏中随时调整</p></div><button id="settings-density" class="subtle-button">调整显示</button></div><div class="setting-row"><div><strong>轻量动效</strong><p>轻微的卡片悬浮反馈，并遵循 Windows 的「减少动态效果」偏好。</p></div>${svg('sparkles')}</div><p class="muted"><span id="settings-appearance-version">ACG-album · 正在读取版本…</span><br>资料库使用 SQLite 保存；你的原始文件始终留在导入目录。</p>`;
        $('#sidebar-mode').value = S.settings.sidebarMode || 'auto';
        $('#sidebar-mode').onchange = (e) =>
          attempt(() => saveSetting('sidebarMode', e.target.value));
        $('#theme-select').value = S.settings.theme;
        $('#theme-select').onchange = (e) => attempt(() => changeTheme(e.target.value));
        $('#settings-density').onclick = densityModal;
        try {
          const info = await api('appInfo');
          if (content.isConnected)
            content.querySelector('#settings-appearance-version').textContent = info?.version
              ? `ACG-album · 版本 ${info.version}`
              : 'ACG-album · 未提供版本信息';
        } catch {
          if (content.isConnected)
            content.querySelector('#settings-appearance-version').textContent =
              'ACG-album · 版本信息暂不可用';
        }
      }
      if (tab === 'metadata') {
        const status = await api('tokenStatus');
        if (!content.isConnected) return;
        content.innerHTML = `<div class="setting-row local-index-setting"><div><strong>本地资料检索</strong><p id="settings-local-index-status" data-local-index-status role="status" aria-live="polite">正在读取随安装包附带的索引状态…</p><p>精简与完整名称检索覆盖相同，完整检索附带更多资料。</p></div><button id="settings-local-search" class="subtle-button">${svg('search')}打开检索</button></div><div class="setting-row"><div><strong>默认自动检索作品</strong><p>仅用于未单独选择匹配方式的文件夹。导入时的选择优先；公共条目通常无需 Token，受限条目取决于 API 权限。</p></div><input id="auto-match-toggle" class="switch" type="checkbox" aria-label="默认自动检索作品"></div><div class="setting-row"><div><strong>默认显示简介的深度</strong><p>可右键任意相册，单独开启或关闭简介</p></div><select id="intro-depth"><option value="1">一级作品目录</option><option value="2">包含二级作品目录</option></select></div><div class="setting-row"><div><strong>检索的作品类型</strong><p>混合图库可选择全部类型</p></div><select id="category-type"><option value="0">全部类型</option><option value="4">游戏</option><option value="2">动画</option><option value="1">书籍 / 漫画</option><option value="6">影视 / 三次元</option></select></div><h3>Bangumi Access Token <span class="chip">${status.saved ? '已加密保存' : '未设置'}</span></h3><label for="token-input">替换 Token</label><input class="field-input" id="token-input" type="password" autocomplete="off" placeholder="留空并保存可移除已有 Token"><p class="field-help">Token 通过 Windows 加密服务保存，只发送给 api.bgm.tv。部分条目（如 R18）需要具有相应访问权限的 Access Token 才可能出现在候选或允许读取详情；是否生效以 Bangumi 返回为准。网页登录状态不会自动用于 API 请求，无需粘贴 Cookie。</p><div class="modal-actions"><button id="token-link" class="text-button">获取个人 Token ${svg('external')}</button><button id="token-save" class="subtle-button">保存 Token</button><button id="sync-all" class="primary">${svg('refresh')}补全未关联简介</button></div>`;
        window.albumLocalSearch?.mountSettings(content);
        $('#auto-match-toggle').checked = !!S.settings.autoMatch;
        $('#auto-match-toggle').onchange = (e) =>
          attempt(() => saveSetting('autoMatch', e.target.checked));
        $('#intro-depth').value = S.settings.subjectDepth || 1;
        $('#intro-depth').onchange = (e) =>
          attempt(async () => {
            await saveSetting('subjectDepth', Number(e.target.value));
            window.updateMediaView?.();
            if (S.current) renderIntro(S.current);
          });
        $('#category-type').value = S.settings.categoryType || 0;
        $('#category-type').onchange = (e) =>
          attempt(() => saveSetting('categoryType', Number(e.target.value)));
        $('#token-link').onclick = () =>
          attempt(() => api('external', { url: 'https://next.bgm.tv/demo/access-token' }));
        $('#token-save').onclick = () =>
          attempt(async () => {
            const button = $('#token-save'),
              input = $('#token-input'),
              value = input.value;
            button.disabled = true;
            try {
              await api('saveToken', { value });
              // Do not erase a newer draft typed while encryption was in progress.
              if (alive()) {
                if (input.value === value) input.value = '';
                content.querySelector('h3 .chip').textContent = value.trim()
                  ? '已加密保存'
                  : '未设置';
              }
              toast('Token 设置已保存');
            } finally {
              if (button.isConnected) button.disabled = false;
            }
          });
        $('#sync-all').onclick = () =>
          attempt(async () => {
            await saveSetting('autoMatch', true);
            const r = await api('sync');
            toast(`已加入后台检索队列，共 ${r.queued} 个相册`);
            if (alive() && current === content) closeModal();
          });
      }
      if (tab === 'cache') await prepareCacheSettings(content, { alive, dialog });
    }
  }
  async function switchTab(name) {
    if (!alive()) return;
    const ticket = ++serial;
    requested = name;
    settle();
    tabs.forEach((button) => {
      const selected = button.dataset.tab === name;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    placeIndicator();
    viewport.setAttribute('aria-busy', 'true');
    status.textContent =
      '正在准备' + tabs.find((button) => button.dataset.tab === name).textContent + '…';
    if (!panels.has(name)) panels.set(name, prepare(name));
    const incoming = await panels.get(name);
    if (!alive() || ticket !== serial || !incoming) return;
    const outgoing = current;
    current = incoming;
    viewport.querySelector('.settings-initial')?.remove();
    incoming.hidden = false;
    incoming.inert = false;
    incoming.setAttribute('aria-hidden', 'false');
    viewport.setAttribute('aria-busy', 'false');
    status.textContent = '';
    if (outgoing && outgoing !== incoming) {
      const direction =
        names.indexOf(name) > names.indexOf(outgoing.id.replace('settings-panel-', '')) ? 1 : -1;
      outgoing.inert = true;
      outgoing.setAttribute('aria-hidden', 'true');
      // Keep focus out of an outgoing panel, including switches requested by async actions.
      if (outgoing.contains(document.activeElement))
        tabs.find((button) => button.dataset.tab === name).focus({ preventScroll: true });
      const exit = animate(
        outgoing,
        [
          { opacity: 1, transform: 'translateX(0)' },
          { opacity: 0, transform: `translateX(${-direction * 8}px)` }
        ],
        140
      );
      animate(
        incoming,
        [
          { opacity: 0, transform: `translateX(${direction * 10}px)` },
          { opacity: 1, transform: 'translateX(0)' }
        ],
        200
      );
      if (exit)
        exit.finished
          .then(() => {
            if (current !== outgoing) outgoing.hidden = true;
          })
          .catch(() => {});
      else outgoing.hidden = true;
    }
  }
  shell.switchTab = switchTab;
  tabs.forEach((button, index) => {
    button.onclick = () => {
      void switchTab(button.dataset.tab);
    };
    button.onkeydown = (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus({ preventScroll: true });
      void switchTab(tabs[next].dataset.tab);
    };
  });
  animate(
    shell,
    [
      { opacity: 0, transform: 'translateY(6px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ],
    180
  );
  return switchTab(tab);
}
const V = { args: null, index: 0, total: 0, node: null, serial: 0, scale: 1, native: false };
async function openViewer(n, index = 0, inline = false) {
  V.args = { ...queryArgs(), filter: 'images' };
  if (inline || isOverview()) {
    V.args = { parent: n.parent, filter: 'images', sort: S.sort, direction: S.direction };
    V.index = 0;
  } else V.index = Math.max(0, index - grid.folders);
  const result = await api('list', { ...V.args, offset: V.index, limit: 1 });
  V.total = result.total;
  if (result.items[0]?.id !== n.id) {
    let found = -1;
    for (let offset = 0; offset < result.total; offset += 500) {
      const batch = await api('list', { ...V.args, offset, limit: 500 });
      const i = batch.items.findIndex((x) => x.id === n.id);
      if (i >= 0) {
        found = offset + i;
        break;
      }
    }
    V.index = Math.max(0, found);
  }
  if (!$('#viewer').open) $('#viewer').showModal();
  await displayImage(n);
}
async function displayOriginalImage(n) {
  V.node = n;
  V.scale = 1;
  V.native = false;
  const serial = ++V.serial;
  const image = $('#viewer-image');
  image.style.width = '';
  image.style.height = '';
  image.style.transform = '';
  $('#viewer-stage').classList.remove('zoomed');
  image.hidden = true;
  $('#viewer-loading').hidden = false;
  $('#viewer-loading').textContent = '正在打开原图…';
  $('#viewer-name').textContent = n.name;
  $('#viewer-position').textContent = `${fmt(V.index + 1)} / ${fmt(V.total)}`;
  $('#viewer-path').textContent = n.path;
  $('#viewer-zoom').textContent = '适应';
  $('#viewer-prev').disabled = V.index <= 0;
  $('#viewer-next').disabled = V.index >= V.total - 1;
  image.alt = n.name;
  image.onload = () => {
    if (serial !== V.serial) return;
    image.hidden = false;
    $('#viewer-loading').hidden = true;
  };
  image.onerror = () => {
    if (serial !== V.serial) return;
    $('#viewer-loading').textContent = '无法解码原图，可右键查看属性或在资源管理器中定位。';
  };
  image.src = `acg-image://original/${n.id}`;
  image.oncontextmenu = (e) => showContext(e, n);
}
async function viewerStep(delta) {
  const index = V.index + delta;
  if (index < 0 || index >= V.total) return;
  const serial = ++V.serial;
  const result = await api('list', { ...V.args, offset: index, limit: 1 });
  if (serial !== V.serial || !$('#viewer').open) return;
  if (result.items.length) {
    V.index = index;
    await displayImage(result.items[0]);
  }
}
function viewerZoom(scale, native = false) {
  if (V.node?.kind === 'video') return;
  const stage = $('#viewer-stage'),
    image = $('#viewer-image');
  V.scale = Math.max(0.1, Math.min(8, scale));
  V.native = native || V.scale > 1.01;
  if (V.native) {
    stage.classList.add('zoomed');
    const available = Math.min(
      stage.clientWidth / image.naturalWidth,
      stage.clientHeight / image.naturalHeight,
      1
    );
    const ratio = native ? V.scale : available * V.scale;
    image.style.width = image.naturalWidth * ratio + 'px';
    image.style.height = image.naturalHeight * ratio + 'px';
    $('#viewer-zoom').textContent = Math.round(ratio * 100) + '%';
  } else {
    stage.classList.remove('zoomed');
    image.style.width = image.style.height = '';
    $('#viewer-zoom').textContent = '适应';
  }
}
$('#viewer-close').onclick = () => {
  $('#viewer').close();
  hideContext();
  V.serial++;
};
$('#viewer-prev').onclick = () => attempt(() => viewerStep(-1));
$('#viewer-next').onclick = () => attempt(() => viewerStep(1));
$('#viewer-copy').onclick = () =>
  attempt(async () => {
    await api('copyImage', { id: V.node.id });
    toast('图片已复制，可以粘贴到聊天窗口');
  });
$('#viewer-fit').onclick = () => viewerZoom(V.native ? 1 : 1, !V.native);
$('#viewer-image').ondblclick = () => viewerZoom(1, !V.native);
$('#viewer-stage').addEventListener(
  'wheel',
  (e) => {
    if (V.node?.kind === 'video') return;
    e.preventDefault();
    viewerZoom(V.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), V.native);
  },
  { passive: false }
);
let pan = null;
$('#viewer-stage').onpointerdown = (e) => {
  if (!V.native || e.button !== 0) return;
  pan = {
    x: e.clientX,
    y: e.clientY,
    left: $('#viewer-stage').scrollLeft,
    top: $('#viewer-stage').scrollTop
  };
  $('#viewer-stage').setPointerCapture(e.pointerId);
};
$('#viewer-stage').onpointermove = (e) => {
  if (pan) {
    $('#viewer-stage').scrollLeft = pan.left - e.clientX + pan.x;
    $('#viewer-stage').scrollTop = pan.top - e.clientY + pan.y;
  }
};
$('#viewer-stage').onpointerup = $('#viewer-stage').onpointercancel = () => (pan = null);
let latestOnlineProgress = null;
function hasOnlineWork(data) {
  return !!(data && (data.active || data.remaining > 0 || data.discovering || data.paused));
}
function paintProgress({
  title,
  detail,
  current = '',
  active,
  paused = false,
  percent = null,
  label,
  scan = false
}) {
  clearTimeout(progressHideTimer);
  const panel = $('#progress-panel'),
    bar = $('#progress-bar'),
    track = bar.parentElement;
  panel.hidden = false;
  panel.dataset.state = paused ? 'paused' : active ? 'active' : 'complete';
  panel.setAttribute('aria-busy', String(active && !paused));
  $('#progress-title').textContent = title;
  $('#progress-detail').textContent = detail;
  $('#progress-path').textContent = current;
  $('#progress-path').title = current;
  $('#progress-percent').textContent = label;
  $('#cancel-import').hidden = !scan || !active;
  $('.progress-spinner').hidden = !active || paused;
  bar.style.width = percent == null ? '35%' : `${percent}%`;
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', title);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuetext', `${label}，${detail}`);
  if (percent == null) track.removeAttribute('aria-valuenow');
  else track.setAttribute('aria-valuenow', String(percent));
  const moving =
    active && !paused && percent == null && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (moving && !bar.scanMotion && bar.animate)
    bar.scanMotion = bar.animate(
      [{ transform: 'translateX(-100%)' }, { transform: 'translateX(290%)' }],
      { duration: 1600, iterations: Infinity }
    );
  if (bar.scanMotion) {
    if (moving) bar.scanMotion.play();
    else bar.scanMotion.cancel();
  }
  if (!active && !paused) progressHideTimer = setTimeout(() => (panel.hidden = true), 6000);
}
function showProgress(p) {
  clearTimeout(progressHideTimer);
  scanActive = !!p.active;
  updateImportBusy();
  if (p.active && pendingImport) pendingImport.sawProgress = true;
  if (!scanActive && hasOnlineWork(latestOnlineProgress)) {
    renderOnlineProgress(latestOnlineProgress);
    return;
  }
  const phase = p.phase || (p.active ? '扫描文件夹' : '索引完成');
  paintProgress({
    title: `${phase} · ${p.name || '本地相册'}`,
    detail: `${fmt(p.images)} 个媒体项目 · ${fmt(p.folders)} 个目录${p.errors ? ' · ' + p.errors + ' 项跳过' : ''}`,
    current: p.current || p.name || '',
    active: !!p.active,
    scan: true,
    percent: p.active ? null : 100,
    label: p.active ? '扫描中…' : phase.startsWith('已取消') ? '已取消' : '完成'
  });
  $('#footer-status').textContent = p.active ? `${phase} · 已载入的内容可继续浏览` : '就绪';
}
function renderOnlineProgress(data) {
  const remaining = Math.max(0, Number(data.remaining ?? data.pending) || 0),
    completed = Math.max(0, Number(data.completed) || 0),
    total = Math.max(completed + remaining, Number(data.total) || 0),
    active = hasOnlineWork(data),
    paused = !!data.paused;
  const title =
    data.paused === 'access'
      ? '作品检索已暂停'
      : paused
        ? '作品检索等待重试'
        : active
          ? '正在检索作品简介'
          : '作品检索完成';
  const detail = data.discovering
    ? `正在整理待检索目录 · 已处理 ${fmt(completed)} 项 · 待处理 ${fmt(remaining)} 项以上`
    : `本次已处理 ${fmt(completed)} / ${fmt(total)} 个文件夹 · 待处理 ${fmt(remaining)} 项`;
  const percent = data.discovering
    ? null
    : total
      ? Math.min(100, Math.floor((completed / total) * 100))
      : active
        ? null
        : 100;
  const current =
    data.paused === 'access'
      ? '请在偏好设置更新 Access Token，任务进度已保留'
      : paused
        ? `任务进度已保留，将于 ${new Date(data.retryAt).toLocaleTimeString([], { hour12: false })} 后重试`
        : active
          ? '作品简介在后台检索，可继续浏览相册'
          : '可在「待确认项目」中核对未满分匹配';
  paintProgress({
    title,
    detail,
    current,
    active,
    paused,
    percent,
    label: paused ? '已暂停' : percent == null ? '整理中…' : `${percent}%`
  });
  $('#footer-status').textContent = active
    ? `${title} · 待处理 ${fmt(remaining)} 项${data.discovering ? '以上' : ''}`
    : '就绪';
}
function showOnlineStatus(data) {
  const wasWorking = hasOnlineWork(latestOnlineProgress);
  latestOnlineProgress = data;
  if (scanActive) return;
  const { paused, retryAt, active, discovering, remaining = data.pending } = data;
  const status = $('#footer-status');
  status.textContent =
    paused === 'access'
      ? '简介同步已暂停 · 请在偏好设置更新 Token'
      : paused
        ? `简介同步等待重试 · ${new Date(retryAt).toLocaleTimeString([], { hour12: false })}`
        : active
          ? `正在补全简介 · 待处理 ${remaining} 项${discovering ? '以上' : ''}`
          : '就绪';
  status.title =
    paused === 'access'
      ? '任务进度已保存。请在偏好设置「作品简介」更新有相应访问权限的 Access Token，保存后继续。'
      : paused
        ? '任务进度已保存，等待网络恢复或服务端限流结束后自动重试。重启软件也会继续未完成的任务。'
        : '';
  status.setAttribute('aria-live', paused ? 'polite' : 'off');
  if (hasOnlineWork(data) || wasWorking) renderOnlineProgress(data);
}
window.album.onEvent((event) => {
  if (event.type === 'progress') {
    const wasActive = scanActive;
    showProgress(event.data);
    attempt(() => enterPendingImport(event.data));
    if (event.data.active || wasActive) {
      clearTimeout(changedTimer);
      scheduleGrowingRefresh();
    }
  }
  if (event.type === 'changed' && event.data.cover) {
    attempt(async () => updateCoverNode(await api('get', { id: event.data.id })));
  } else if (event.type === 'changed') {
    window.invalidateFolderTree?.();
    if (
      scanActive ||
      hasOnlineWork(latestOnlineProgress) ||
      pendingImport?.sawProgress ||
      (event.data.root && event.data.revision != null)
    ) {
      clearTimeout(changedTimer);
      scheduleGrowingRefresh();
    } else {
      clearTimeout(changedTimer);
      changedTimer = setTimeout(
        () =>
          attempt(async () => {
            S.rev = Date.now();
            await loadSummary();
            if (!$('#viewer').open) await loadPage(true);
          }),
        380
      );
    }
  }
  if (event.type === 'online') {
    showOnlineStatus(event.data);
    if (event.data.error && Date.now() - onlineToast > 30000) {
      onlineToast = Date.now();
      toast('简介检索暂未完成：' + event.data.error, true);
    }
  }
});
initializeDisplayControls();
// Coalesce a wheel burst before using the same persisted, anchor-preserving preset controls.
let densityWheelTimer = null,
  densityWheelTarget = null;
const densityWheelEditing = (element) =>
  element instanceof Element &&
  !!element.closest(
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="slider"],[role="spinbutton"]'
  );
function densityWheelBlocked() {
  return (
    !!document.querySelector('dialog[open]') ||
    !$('#context-menu').hidden ||
    densityWheelEditing(document.activeElement)
  );
}
$('#viewport').addEventListener(
  'wheel',
  (event) => {
    if (
      !event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      !event.deltaY ||
      event.defaultPrevented ||
      densityWheelBlocked() ||
      densityWheelEditing(event.target)
    )
      return;
    event.preventDefault();
    const current = Number(densityWheelTarget ?? pendingDisplay.density ?? S.settings.density),
      widths = cardDisplayPresets.map((preset) => preset.width),
      candidates = widths.filter((width) => (event.deltaY < 0 ? width > current : width < current)),
      next = event.deltaY < 0 ? candidates[0] : candidates.at(-1);
    if (next === undefined) return;
    densityWheelTarget = next;
    clearTimeout(densityWheelTimer);
    const key = viewKey();
    densityWheelTimer = setTimeout(() => {
      densityWheelTimer = null;
      const value = densityWheelTarget;
      if (key !== viewKey() || densityWheelBlocked()) {
        densityWheelTarget = null;
        return;
      }
      void attempt(async () => {
        try {
          await changeDisplaySetting('density', value);
        } finally {
          if (densityWheelTimer === null && densityWheelTarget === value) densityWheelTarget = null;
        }
      });
    }, 90);
  },
  { passive: false }
);
$$('[data-window]').forEach((b) => (b.onclick = () => window.album.window(b.dataset.window)));
$('#brand-home').onclick = $('#home-button').onclick = () => attempt(() => navigate({}));
$('#back-button').onclick = () => attempt(back);
$('#import-sidebar').onclick = importFolder;
$('#refresh-button').onclick = refreshLibrary;
$('#settings-button').onclick = () => attempt(() => settingsModal());
$('#density-button').title = '查看设置：卡片尺寸、封面比例与批量确认封面';
$('#density-button').setAttribute('aria-label', $('#density-button').title);
$('#density-button').setAttribute('aria-haspopup', 'dialog');
$('#density-button').onclick = densityModal;
$('#theme-button').onclick = () => attempt(toggleTheme);
$('#cancel-import').onclick = () => attempt(() => api('cancel'));
$('#collapse-all').onclick = () => {
  S.overviewExpanded.clear();
  attempt(() => navigate({}));
};
$$('[data-view]').forEach(
  (b) => (b.onclick = () => attempt(() => navigate({ view: b.dataset.view })))
);
$$('[data-filter]').forEach(
  (b) =>
    (b.onclick = () => {
      S.filter = b.dataset.filter;
      attempt(() => loadPage());
    })
);
$('#sort').onchange = (e) => {
  S.sort = e.target.value;
  attempt(() => loadPage());
};
$('#sort-direction').onclick = () => {
  S.direction = S.direction === 'asc' ? 'desc' : 'asc';
  attempt(() => loadPage());
};
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const search = e.target.value.trim();
  searchTimer = setTimeout(() => {
    S.search = search;
    attempt(() => loadPage());
  }, 220);
});
document.addEventListener('keydown', (e) => {
  const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if ($('#modal').open || $('#media-editor')?.open || $('#local-search-dialog')?.open) return;
  if ($('#viewer').open) {
    if (e.key === 'Escape') {
      hideContext();
      V.serial++;
    }
    if (!editing && e.key === 'ArrowRight') {
      e.preventDefault();
      attempt(() => viewerStep(1));
    }
    if (!editing && e.key === 'ArrowLeft') {
      e.preventDefault();
      attempt(() => viewerStep(-1));
    }
    if (V.node?.kind === 'image' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      attempt(async () => {
        await api('copyImage', { id: V.node.id });
        toast('图片已复制');
      });
    }
    return;
  }
  if ($('#modal').open) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    $('#search').focus();
    $('#search').select();
  }
  if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    attempt(back);
  }
  if (e.key === 'Escape' && S.search) {
    $('#search').value = '';
    S.search = '';
    attempt(() => loadPage());
  }
});
window.addEventListener('error', (e) => toast(e.message, true));
window.addEventListener('unhandledrejection', (e) => {
  toast(e.reason?.message || String(e.reason), true);
  e.preventDefault();
});
document.addEventListener(
  'DOMContentLoaded',
  () =>
    attempt(async () => {
      const init = await loadSummary();
      if (init.progress.active) showProgress(init.progress);
      if (init.online) showOnlineStatus(init.online);
      await loadPage();
    }),
  { once: true }
);
