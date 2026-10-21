'use strict';
// A separate panel keeps path and maintenance state together while settings tabs stay mounted.
async function prepareCacheSettings(content, { alive, dialog }) {
  const initial = await api('cacheInfo');
  if (!alive() || !content.isConnected) return;
  content.innerHTML = `<section class="cache-location"><div class="cache-section-heading"><div><h3>封面与缩略图</h3><p class="muted">下载的封面、浏览缩略图与简介，统一保存在下面的缓存目录。</p></div><span id="cache-location-kind" class="chip"></span></div><div id="cache-current-path" class="cache-path" aria-label="当前缓存目录"></div><div class="cache-location-actions"><button id="open-cache" class="subtle-button">${svg('folder')}打开缓存目录</button><button id="change-cache" class="subtle-button">更换存储位置</button><button id="reset-cache-directory" class="text-button">恢复默认位置</button></div><p id="cache-location-note" class="cache-note"></p><p id="cache-operation-status" class="cache-operation-status" role="status" aria-live="polite" aria-atomic="true"></p></section><div class="cache-cards">${[
    ['thumbnails', '缩略图'],
    ['covers', '在线封面'],
    ['metadata', '简介缓存']
  ]
    .map(
      ([key, label]) =>
        `<div class="cache-card" data-cache-kind="${key}"><small>${label}</small><strong>—</strong><span>正在统计</span></div>`
    )
    .join(
      ''
    )}</div><div class="setting-row"><div><strong>清理未使用缓存</strong><p>清除已失效的缩略图与未关联封面，保留仍在使用的缓存。</p></div><button id="cache-unused" class="subtle-button">清理</button></div><div class="setting-row"><div><strong>清空并重建缓存</strong><p>清空下载封面、缩略图和简介。缩略图在下次浏览时生成；在线封面与简介可在相册中重新同步。</p></div><button id="cache-reset" class="text-button danger">清空缓存</button></div><details class="cache-advanced"><summary>单独清理与资料库设置</summary><div class="setting-row"><div><strong>重建全部缩略图</strong><p>只清空浏览缩略图，保留下载封面与简介。</p></div><button id="cache-all" class="text-button danger">清空缩略图</button></div><div class="setting-row"><div><strong>清空简介缓存</strong><p>保留条目关联与封面，可在相册中重新同步。</p></div><button id="cache-meta" class="text-button danger">清空简介</button></div><div class="setting-row"><div><strong>自动更新索引</strong><p>文件夹变化后在后台更新对应相册；大型网络目录也可关闭，改为手动更新。</p></div><input id="watch-toggle" class="switch" type="checkbox" aria-label="自动更新索引"></div><p class="muted">资料库、收藏、手动封面与裁切位置另行保存在资料目录。更换缓存位置或清理缓存会保留这些内容与原始文件。</p><button id="open-data" class="subtle-button">${svg('folder')}打开资料目录</button></details>`;
  const find = (selector) => content.querySelector(selector),
    status = find('#cache-operation-status');
  let info = initial,
    busy = false;
  const connected = () => alive() && content.isConnected;
  const attemptHere = (action) =>
    attempt(async () => {
      try {
        return await action();
      } catch (error) {
        if (connected()) throw error;
      }
    });
  function render(next) {
    info = next;
    find('#cache-current-path').textContent = info.path;
    find('#cache-location-kind').textContent = info.isDefault === false ? '自选目录' : '默认目录';
    find('#cache-location-note').textContent =
      info.isDefault === false
        ? `默认位置：${info.defaultPath}。更换位置会迁移已有缓存；资料库继续保存在原处。`
        : '更换位置会把已有缓存迁移到所选目录下的 ACG-album-cache 文件夹。';
    for (const key of ['thumbnails', 'covers', 'metadata']) {
      const card = find(`[data-cache-kind="${key}"]`),
        stats = info[key];
      card.querySelector('strong').textContent = bytes(stats.bytes);
      card.querySelector('span').textContent = `${fmt(stats.count)} 个文件`;
    }
    setBusy(busy);
  }
  function setBusy(value) {
    busy = value;
    content.setAttribute('aria-busy', String(value));
    content.querySelectorAll('button, input').forEach((button) => (button.disabled = value));
    find('#reset-cache-directory').disabled = value || info.isDefault !== false;
  }
  async function run(message, action) {
    if (busy || !connected()) return;
    setBusy(true);
    status.textContent = message;
    try {
      const result = await action();
      if (!connected()) return;
      if (result?.cancelled) {
        status.textContent = '已取消，缓存位置保持不变。';
        return;
      }
      const next =
        result?.path && result?.thumbnails && result?.covers && result?.metadata
          ? result
          : await api('cacheInfo');
      if (!connected()) return;
      render(next);
      status.textContent =
        result?.removed != null
          ? `已清理 ${fmt(result.removed)} 个缓存文件，释放 ${bytes(result.bytes)}。`
          : '缓存位置已更新，已有缓存可继续使用。';
      if (result?.warning) status.textContent += ` ${result.warning}`;
    } catch (error) {
      if (!connected()) return;
      status.textContent = error.message || String(error);
      throw error;
    } finally {
      if (connected()) setBusy(false);
    }
  }
  // A child dialog leaves settings drafts, scroll and keyboard focus intact.
  function confirmAction(title, message, action, label = '清空') {
    if (busy || !connected()) return;
    const focus = document.activeElement,
      child = document.createElement('dialog');
    child.className = 'modal cache-confirm-dialog';
    child.setAttribute('aria-labelledby', 'cache-confirm-title');
    child.innerHTML = `<div class="modal-top"><h2 id="cache-confirm-title">${esc(title)}</h2></div><p>${esc(message)}</p><p class="muted">原始图片、资料库、收藏、条目关联、手动封面与裁切位置会保留。</p><div class="modal-actions"><button class="subtle-button" data-cache-cancel autofocus>取消</button><button class="primary" data-cache-confirm>${esc(label)}</button></div>`;
    document.body.append(child);
    const dismiss = () => child.close();
    dialog.addEventListener('close', dismiss, { once: true });
    child.addEventListener(
      'close',
      () => {
        dialog.removeEventListener('close', dismiss);
        child.remove();
        if (connected() && focus?.isConnected) focus.focus({ preventScroll: true });
      },
      { once: true }
    );
    child.querySelector('[data-cache-cancel]').onclick = dismiss;
    child.querySelector('[data-cache-confirm]').onclick = () => {
      child.close();
      void attemptHere(async () => {
        try {
          await action();
        } finally {
          if (
            connected() &&
            !content.hidden &&
            !content.inert &&
            focus?.isConnected &&
            !focus.disabled
          )
            focus.focus({ preventScroll: true });
        }
      });
    };
    child.showModal();
  }
  const clean = (mode) =>
    run('正在清理缓存…', async () => {
      const key = viewKey(),
        result = await api('cleanCache', { mode });
      S.rev = Date.now();
      if (key === viewKey()) await loadPage(true);
      return result;
    });
  find('#watch-toggle').checked = S.settings.watchChanges !== false;
  find('#watch-toggle').onchange = (event) =>
    attemptHere(async () => {
      const input = event.target,
        next = input.checked;
      input.disabled = true;
      try {
        await saveSetting('watchChanges', next);
      } catch (error) {
        input.checked = !next;
        throw error;
      } finally {
        input.disabled = busy;
      }
    });
  find('#open-data').onclick = () => attemptHere(() => api('openData'));
  find('#open-cache').onclick = () => attemptHere(() => api('openCache'));
  find('#change-cache').onclick = () =>
    attemptHere(() =>
      run('请选择缓存存储位置；已有缓存将随之迁移…', () => api('changeCacheDirectory'))
    );
  find('#reset-cache-directory').onclick = () =>
    confirmAction(
      '恢复默认缓存位置',
      `将缓存迁回 ${info.defaultPath}。`,
      () => run('正在迁回默认缓存位置…', () => api('resetCacheDirectory')),
      '迁回默认位置'
    );
  find('#cache-unused').onclick = () => attemptHere(() => clean('unused'));
  find('#cache-reset').onclick = () =>
    confirmAction(
      '清空并重建缓存',
      '下载封面、缩略图和简介将被清空。之后浏览时会按需生成缩略图，在线资料可重新同步。',
      () => clean('reset-cache')
    );
  find('#cache-all').onclick = () =>
    confirmAction('清空缩略图缓存', '浏览时会按需重建缩略图。下载封面与简介继续保留。', () =>
      clean('all-thumbnails')
    );
  find('#cache-meta').onclick = () =>
    confirmAction('清空简介缓存', '清空缓存的简介与本地条目详情，之后可重新同步。', () =>
      clean('metadata')
    );
  const unsubscribe = window.album.onEvent((event) => {
    if (event.type !== 'cache-progress' || !busy || !connected()) return;
    const progress = event.data;
    status.textContent =
      progress.phase === 'copy'
        ? `正在迁移缓存…已处理 ${fmt(progress.files)} 个文件 · ${bytes(progress.bytes)}`
        : progress.phase === 'stats'
          ? '正在统计缓存…'
          : '正在完成缓存操作…';
  });
  const observer = new MutationObserver(() => {
    if (!connected()) {
      unsubscribe();
      observer.disconnect();
    }
  });
  observer.observe($('#modal-content'), { childList: true, subtree: true });
  render(initial);
}
