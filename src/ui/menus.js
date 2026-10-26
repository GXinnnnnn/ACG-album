'use strict';

// Application actions live in Settings. Retain the native edit-menu copy bridge.
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
    action('刷新当前页面', 'refresh', async () => {
      await loadSummary();
      await loadPage(true);
    });
    action('增量更新文件夹', 'folder', refreshLibrary, { disabled: scanActive });
    actions.push({ rule: true });
    for (const [value, label] of [
      ['name', '按文件名称排序'],
      ['date', '按创建日期排序'],
      ['modified', '按修改日期排序'],
      ['size', '按大小排序']
    ])
      action(
        label,
        'sort',
        async () => {
          S.sort = value;
          await loadPage();
        },
        { checked: S.sort === value, disabled: S.view === 'timeline' }
      );
    action(
      S.direction === 'asc' ? '改为降序排列' : '改为升序排列',
      'arrow-down',
      async () => {
        S.direction = S.direction === 'asc' ? 'desc' : 'asc';
        await loadPage();
      },
      { disabled: S.view === 'timeline' }
    );
    actions.push({ rule: true });
    action('卡片尺寸与批量确认…', 'sliders', densityModal);
    action('导入文件夹…', 'plus', importFolder, { disabled: !!pendingImport || scanActive });
    if (S.parent)
      action('在资源管理器中定位当前文件夹', 'external', () => api('reveal', { id: S.parent }));
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
    if (
      event?.type === 'application' &&
      event.data?.action === 'copy' &&
      document.querySelector('#viewer').open
    )
      document.querySelector('#viewer-copy').click();
  });
})();
