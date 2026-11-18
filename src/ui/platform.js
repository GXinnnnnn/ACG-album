'use strict';

(() => {
  const isMac = window.album?.platform === 'darwin';
  const modifier = isMac ? '⌘' : 'Ctrl';
  const pathKey = (value) =>
    typeof value !== 'string'
      ? value
      : isMac
        ? value.replace(/\/+$/, '') || '/'
        : value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  const pathName = (value) =>
    String(value || '')
      .split(isMac ? /\// : /[\\/]/)
      .filter(Boolean)
      .at(-1) || String(value || '');
  const descendant = (child, parent) => {
    const a = pathKey(child),
      b = pathKey(parent);
    return Boolean(a && b && (a === b || a.startsWith(b.endsWith('/') ? b : b + '/')));
  };
  window.albumPlatform = Object.freeze({
    isMac,
    modifier,
    primaryModifier: (event) =>
      isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey,
    pathKey,
    pathName,
    descendant,
    revealLabel: isMac ? '在 Finder 中显示' : '在资源管理器中定位',
    viewerHint: `← → 切换 · 滚轮缩放 · ${modifier} C 复制 · Esc 关闭`
  });
  document.documentElement.dataset.platform = window.album?.platform || 'win32';
  if (isMac) {
    document.querySelector('.window-controls')?.setAttribute('hidden', '');
    document.querySelector('#back-button')?.setAttribute('title', '返回 · ⌘[');
    document
      .querySelector('#refresh-button')
      ?.setAttribute('title', '增量刷新当前目录或全部分类（⌘R）');
    const hint = document.querySelector('#viewer-hint');
    if (hint) hint.textContent = window.albumPlatform.viewerHint;
  }
})();
