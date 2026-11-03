'use strict';
// One set of display controls for the toolbar, preferences and category previews.
const cardDisplayPresets = [
  { width: 135, name: '小', kind: 'compact', count: 4 },
  { width: 165, name: '中', kind: 'standard', count: 3 },
  { width: 192, name: '大', kind: 'large', count: 2 }
];
function displayViewportWidth() {
  return document.documentElement.clientWidth || window.innerWidth || 3840;
}
function cardPresets(viewportWidth = displayViewportWidth()) {
  return window.albumAppearanceSpec.cardPresets(viewportWidth);
}
function refreshDisplayPresets() {
  const widths = cardPresets();
  cardDisplayPresets.forEach((preset, index) => {
    preset.width = widths[index];
  });
  // Existing toolbar markup uses numeric data-density. Give each control a
  // stable role once, so resizing can update its value without guessing from
  // the previously selected or manually entered width.
  $$('[data-density]').forEach((button, index) => {
    const preset =
      cardDisplayPresets.find((p) => p.kind === button.dataset.cardPreset) ||
      cardDisplayPresets[index % cardDisplayPresets.length];
    button.dataset.cardPreset = preset.kind;
    button.dataset.density = String(preset.width);
  });
  const style = document.documentElement.style;
  // A fresh profile follows the medium preset until the user explicitly chooses
  // a numeric width, including while the native window restores its size.
  if (S.settings.densityConfigured === false) {
    const changed = S.settings.density !== widths[1];
    S.settings.density = widths[1];
    style.setProperty('--card-width', widths[1] + 'px');
    if (changed) window.albumAppearanceControls?.sync();
  }
  const width = Number(S.settings.density) || 166;
  style.setProperty('--card-base-size', widths[1] + 'px');
  style.setProperty('--card-scale', String(width / widths[1]));
  return cardDisplayPresets;
}
let displayChangeTask = null,
  pendingDisplay = {};
function applyDisplaySettings() {
  refreshDisplayPresets();
  const preset = cardDisplayPresets.find((p) => p.width === Number(S.settings.density));
  document.documentElement.dataset.cardSize = preset?.kind || 'standard';
  document.documentElement.dataset.mediaDetails = S.settings.details === false ? 'off' : 'on';
  const details = $('#details-toggle');
  if (details) {
    details.classList.toggle('active', S.settings.details !== false);
    details.setAttribute('aria-pressed', String(S.settings.details !== false));
    details.setAttribute('aria-label', '显示卡片详情');
    details.title = '切换相册附加信息、文件名、大小与日期';
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
let displayPreviewAnchor = null,
  displayPreviewKey = null,
  displayFinishGeneration = 0,
  displayRestoreCleanup = null;
function previewDisplayDensity(value) {
  displayFinishGeneration++;
  displayRestoreCleanup?.();
  displayRestoreCleanup = null;
  const key = viewKey();
  if (!displayPreviewAnchor || displayPreviewKey !== key) {
    displayPreviewAnchor = captureDisplayAnchor();
    displayPreviewKey = key;
    grid.previewThumbWidth = grid.width;
  }
  document.documentElement.dataset.densityPreview = 'on';
  document.documentElement.style.setProperty('--card-width', value + 'px');
  applyDisplaySettings();
  overviewPreviewController?.preview();
  grid.layout(false);
  restoreDisplayAnchor(displayPreviewAnchor);
}
function finishDisplayDensity() {
  if (!displayPreviewAnchor) return;
  const anchor = displayPreviewAnchor,
    key = displayPreviewKey,
    generation = ++displayFinishGeneration;
  displayPreviewAnchor = displayPreviewKey = null;
  document.documentElement.dataset.densityPreview = 'off';
  grid.previewThumbWidth = 0;
  grid.render();
  if (!overviewPreviewController) return;
  const viewport = $('#viewport'),
    scrollTop = viewport.scrollTop;
  let scrolled = false;
  const onScroll = () => {
    if (viewport.scrollTop !== scrollTop) scrolled = true;
  };
  const cleanup = () => {
    viewport.removeEventListener('scroll', onScroll);
    if (displayRestoreCleanup === cleanup) displayRestoreCleanup = null;
  };
  displayRestoreCleanup = cleanup;
  viewport.addEventListener('scroll', onScroll, { passive: true });
  void overviewPreviewController
    .refresh()
    .then(() => {
      if (
        generation === displayFinishGeneration &&
        key === viewKey() &&
        !scrolled &&
        viewport.scrollTop === scrollTop
      )
        restoreDisplayAnchor(anchor);
    })
    .catch((error) => toast(error.message || String(error), true))
    .finally(cleanup);
}
function changeDisplaySetting(key, value) {
  if (key === 'density' && window.albumAppearanceControls) {
    if (!window.albumAppearanceSpec.valid(key, value))
      return Promise.reject(new Error('不支持的显示设置'));
    window.albumAppearanceControls.set(key, value);
    return window.albumAppearanceControls.flush();
  }
  if (
    (key === 'density' &&
      !(typeof value === 'number' && Number.isFinite(value) && value >= 120 && value <= 360)) ||
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
  window.addEventListener(
    'resize',
    () => {
      applyDisplaySettings();
      updateScrollActions();
    },
    { passive: true }
  );
}
