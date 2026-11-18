'use strict';

// Keep native macOS menu actions connected to the existing controls and guards.
(() => {
  const viewport = document.querySelector('#viewport');
  const blankTarget = (target) =>
    target instanceof Element &&
    !target.closest(
      'button,a,input,textarea,select,[contenteditable="true"],.album-card,.category-card,.collection-card,.collection-preview,dialog,#context-menu'
    );
  function showBrowseContext(event) {
    if (
      event.defaultPrevented ||
      !blankTarget(event.target) ||
      document.querySelector('dialog[open]')
    )
      return;
    const actions = [],
      action = (label, icon, fn, extra = {}) => actions.push({ label, icon, fn, ...extra });
    action('刷新当前页面', 'refresh', refreshLibrary, {
      disabled: libraryRefreshBusy || isImportBusy() || !S.roots.length
    });
    action('增量更新文件夹', 'folder', refreshLibrary, {
      disabled: libraryRefreshBusy || isImportBusy() || !S.roots.length
    });
    actions.push({ rule: true });
    for (const [value, label] of [
      ['name', '按文件名称排序'],
      ['contentDate', '按日期排序'],
      ['date', '按创建日期排序'],
      ['modified', '按修改日期排序'],
      ['size', '按大小排序']
    ])
      action(label, 'sort', () => changeBrowseSort(value), { checked: S.sort === value });
    action(S.direction === 'asc' ? '改为降序排列' : '改为升序排列', 'arrow-down', () =>
      changeBrowseSort(S.sort, S.direction === 'asc' ? 'desc' : 'asc')
    );
    actions.push({ rule: true });
    action('卡片尺寸与批量确认…', 'sliders', densityModal);
    action('导入文件夹…', 'plus', importFolder, { disabled: isImportBusy() });
    if (S.parent)
      action(
        window.albumPlatform?.isMac ? '在 Finder 中显示当前文件夹' : '在资源管理器中定位当前文件夹',
        'external',
        () => api('reveal', { id: S.parent })
      );
    showActionMenu(event, actions, '页面操作');
  }
  viewport.setAttribute('tabindex', '0');
  viewport.addEventListener('contextmenu', showBrowseContext);
  viewport.addEventListener('keydown', (event) => {
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      if (!blankTarget(event.target)) return;
      const bounds = viewport.getBoundingClientRect();
      showBrowseContext({
        target: event.target,
        clientX: bounds.left + 24,
        clientY: bounds.top + 24,
        defaultPrevented: false,
        preventDefault: () => event.preventDefault()
      });
    }
  });
  viewport.addEventListener('scroll', hideContext, { passive: true });
  window.addEventListener('resize', hideContext);
  document
    .querySelector('#sidebar-about')
    ?.addEventListener('click', () => attempt(() => window.showAbout()));
  window.album.onEvent((event) => {
    if (event?.type !== 'application') return;
    const action = event.data?.action;
    if (action === 'copy') {
      const textFocus = document.activeElement?.closest?.(
        'input,textarea,[contenteditable]:not([contenteditable="false"])'
      );
      const selectedText = window.getSelection?.()?.toString();
      if (
        document.querySelector('#viewer').open &&
        V.node?.kind === 'image' &&
        !textFocus &&
        !selectedText &&
        !document.querySelector('dialog[open]:not(#viewer)')
      )
        document.querySelector('#viewer-copy').click();
      else window.album.window('copy');
      return;
    }
    // Do not replace a settings/editor dialog with an accelerator action.
    if (document.querySelector('dialog[open]')) return;
    if (action === 'settings') document.querySelector('#settings-button').click();
    else if (action === 'import') document.querySelector('#import-sidebar').click();
    else if (action === 'refresh') document.querySelector('#refresh-button').click();
    else if (action === 'search') document.querySelector('#search').focus();
    else if (action === 'back') document.querySelector('#back-button').click();
  });
})();
