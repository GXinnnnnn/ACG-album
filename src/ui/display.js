'use strict';
// One set of display controls for the toolbar, preferences and category previews.
const cardDisplayPresets = [
  { width: 158, name: '小', kind: 'compact', count: 4 },
  { width: 186, name: '中', kind: 'standard', count: 3 },
  { width: 222, name: '大', kind: 'large', count: 2 }
];
let displayChangeTask = null,
  pendingDisplay = {};
function applyDisplaySettings() {
  const preset = cardDisplayPresets.find((p) => p.width === Number(S.settings.density));
  document.documentElement.dataset.cardSize = preset?.kind || 'standard';
  document.documentElement.dataset.mediaDetails = S.settings.details === false ? 'off' : 'on';
  const details = $('#details-toggle');
  if (details) {
    details.classList.toggle('active', S.settings.details !== false);
    details.setAttribute('aria-pressed', String(S.settings.details !== false));
  }
  $$('[data-density]').forEach((button) => {
    const selected = Number(button.dataset.density) === Number(S.settings.density);
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if ($('#ratio-select')) $('#ratio-select').value = S.settings.ratio;
}
function captureDisplayAnchor() {
  const viewport = $('#viewport'),
    origin = viewport.getBoundingClientRect().top;
  const toolbar = $('#toolbar').getBoundingClientRect(),
    clearance = Math.max(0, toolbar.bottom - origin + 12);
  if (grid.active && grid.total) {
    const anchor = grid.captureAnchor(clearance);
    if (anchor) return { kind: 'grid', ...anchor };
  }
  const candidates = $$(
    '#category-overview .collection-preview .album-card,#category-overview .collection-tile:not(.expanded)'
  );
  const element = candidates.find((el) => el.getBoundingClientRect().bottom > origin + clearance);
  if (element && element.getBoundingClientRect().top < origin + viewport.clientHeight)
    return { kind: 'element', element, offset: element.getBoundingClientRect().top - origin };
  return { kind: 'scroll', scroll: viewport.scrollTop };
}
function restoreDisplayAnchor(anchor) {
  const viewport = $('#viewport'),
    origin = viewport.getBoundingClientRect().top;
  if (anchor.kind === 'grid' && grid.active) grid.restoreAnchor(anchor.index, anchor.offset);
  else if (anchor.kind === 'element' && anchor.element.isConnected)
    viewport.scrollTop += anchor.element.getBoundingClientRect().top - origin - anchor.offset;
  else if (anchor.kind === 'scroll') viewport.scrollTop = anchor.scroll;
  grid.render();
  updateScrollActions();
}
function changeDisplaySetting(key, value) {
  if (
    (key === 'density' && !cardDisplayPresets.some((p) => p.width === value)) ||
    (key === 'ratio' && !['poster', 'tall', 'square'].includes(value)) ||
    (key === 'details' && typeof value !== 'boolean') ||
    !['density', 'ratio', 'details'].includes(key)
  )
    return Promise.reject(new Error('不支持的显示设置'));
  pendingDisplay[key] = value;
  if (!displayChangeTask)
    displayChangeTask = Promise.resolve()
      .then(async () => {
        while (Object.keys(pendingDisplay).length) {
          const [key, value] = Object.entries(pendingDisplay)[0];
          delete pendingDisplay[key];
          if (S.settings[key] === value) continue;
          await api('settings', { key, value });
          // Capture after persistence, so scrolling or navigating during the write stays authoritative.
          const anchor = captureDisplayAnchor();
          S.settings[key] = value;
          applySettings();
          grid.layout(false);
          restoreDisplayAnchor(anchor);
        }
      })
      .finally(() => {
        displayChangeTask = null;
        pendingDisplay = {};
      });
  return displayChangeTask;
}
function updateScrollActions() {
  const viewport = $('#viewport');
  $('#back-to-top').hidden = viewport.scrollTop < Math.max(500, viewport.clientHeight);
}
function initializeDisplayControls() {
  $('#details-toggle').onclick = () =>
    attempt(() => changeDisplaySetting('details', S.settings.details === false));
  $('#card-size-controls').addEventListener('click', (event) => {
    const button = event.target.closest('[data-density]');
    if (button) attempt(() => changeDisplaySetting('density', Number(button.dataset.density)));
  });
  $('#back-to-top').onclick = () => {
    const viewport = $('#viewport');
    viewport.focus({ preventScroll: true });
    viewport.scrollTo({
      top: 0,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'
    });
  };
  $('#viewport').addEventListener('scroll', updateScrollActions, { passive: true });
  window.addEventListener('resize', updateScrollActions, { passive: true });
}
