'use strict';

// Classic-script extension. A separate native dialog preserves settings drafts and scroll.
(() => {
  const kinds = { subject: '作品', person: '人物', character: '角色' };
  const types = { 1: '书籍', 2: '动画', 3: '音乐', 4: '游戏', 6: '影视 / 三次元' };
  let cachedStatus = null;
  let activeDialog = null;

  const errorText = (error) => error?.message || String(error || '未知错误');
  function statusText(status) {
    if (!status) return '正在读取随安装包附带的索引状态…';
    const source =
      status.variant === 'full' ? '完整检索' : status.variant === 'lite' ? '精简检索' : '本地索引';
    const version = status.dataVersion ? ` · 数据版本 ${status.dataVersion}` : ' · 数据版本未知';
    if (status.error) return `${source}${version} · 索引暂不可用：${errorText(status.error)}`;
    if (!status.available)
      return `未安装本地检索索引${status.dataVersion ? version : ''}。请使用附带精简检索或完整检索索引的安装包。`;
    return `已随安装包附带 · ${source}${version}`;
  }

  function rememberStatus(status) {
    cachedStatus = status || { available: false };
    document.querySelectorAll('[data-local-index-status]').forEach((element) => {
      element.textContent = statusText(cachedStatus);
    });
    return cachedStatus;
  }

  async function refreshStatus() {
    try {
      return rememberStatus(await api('localIndexStatus'));
    } catch (error) {
      return rememberStatus({ ...cachedStatus, available: false, error: errorText(error) });
    }
  }

  function mountSettings(root) {
    const status = root.querySelector('[data-local-index-status]');
    if (status) status.textContent = statusText(cachedStatus);
    const button = root.querySelector('#settings-local-search');
    if (button) button.onclick = () => show();
    return refreshStatus();
  }

  function show(options = {}) {
    if (activeDialog?.open) {
      activeDialog.querySelector('#local-search-query').focus();
      return activeDialog;
    }
    const returnFocus = document.activeElement;
    const parentDialog = returnFocus?.closest('dialog');
    const dialog = document.createElement('dialog');
    dialog.id = 'local-search-dialog';
    dialog.className = 'modal local-search-dialog';
    dialog.setAttribute('aria-labelledby', 'local-search-title');
    dialog.innerHTML = `<div class="modal-top"><div><span class="eyebrow">Bangumi · 本地索引</span><h2 id="local-search-title">本地资料检索</h2></div><button type="button" id="local-search-close" class="icon-button" aria-label="关闭本地资料检索">${svg('x')}</button></div><div class="local-search-scroll"><section class="local-search-source" aria-label="索引来源"><p id="local-search-source" data-local-index-status role="status" aria-live="polite">${esc(statusText(cachedStatus))}</p><p>精简与完整的名称检索覆盖相同；完整检索附带更多摘要等资料。名称可离线查询，打开官方条目需要联网。</p></section><form id="local-search-form"><div class="local-search-fields"><div><label for="local-search-kind">条目类别</label><select id="local-search-kind" class="field-input"><option value="subject">作品</option><option value="person">人物</option><option value="character">角色</option></select></div><div id="local-search-type-field"><label for="local-search-type">作品类型</label><select id="local-search-type" class="field-input"><option value="0">全部类型</option>${Object.entries(
      types
    )
      .map(([id, name]) => `<option value="${id}">${name}</option>`)
      .join(
        ''
      )}</select></div><div id="local-search-subject-field" hidden><label for="local-search-subject">所属作品 ID（可选）</label><input id="local-search-subject" class="field-input" type="text" inputmode="numeric" pattern="[1-9][0-9]*" placeholder="例如 123" aria-describedby="local-search-subject-help"><p id="local-search-subject-help">限定所属作品，帮助区分同名人物或角色。</p></div></div><label for="local-search-query">名称关键词</label><div class="local-search-query-row"><input id="local-search-query" class="field-input" type="search" required maxlength="200" placeholder="输入中文名、原名或别名" autocomplete="off"><button id="local-search-submit" class="primary" type="submit">${svg('search')}检索</button></div></form><p id="local-search-status" role="status" aria-live="polite" aria-atomic="true">输入名称，检索作品、人物或角色。</p><p id="local-search-error" class="inline-error" role="alert" hidden></p><div id="local-search-results" aria-label="本地检索结果" aria-busy="false"></div></div><div class="local-search-footer"><span>在线详情与封面仍受 Bangumi API 权限影响。</span><button id="local-search-refresh" type="button" class="text-button">${svg('refresh')}重新读取索引</button></div>`;
    document.body.append(dialog);
    activeDialog = dialog;
    const find = (selector) => dialog.querySelector(selector);
    const query = find('#local-search-query');
    const kind = find('#local-search-kind');
    const type = find('#local-search-type');
    const subject = find('#local-search-subject');
    const submit = find('#local-search-submit');
    const results = find('#local-search-results');
    const status = find('#local-search-status');
    const errorArea = find('#local-search-error');
    let serial = 0;
    let statusSerial = 0;
    const alive = () => activeDialog === dialog && dialog.open && dialog.isConnected;
    function clearError() {
      errorArea.hidden = true;
      errorArea.textContent = '';
    }
    function updateFields() {
      const isSubject = kind.value === 'subject';
      find('#local-search-type-field').hidden = !isSubject;
      type.disabled = !isSubject;
      find('#local-search-subject-field').hidden = isSubject;
      subject.disabled = isSubject;
    }
    function invalidate() {
      serial++;
      submit.disabled = false;
      submit.innerHTML = svg('search') + '检索';
      results.setAttribute('aria-busy', 'false');
      results.replaceChildren();
      clearError();
      status.textContent = '检索条件已改变，点击「检索」查看结果。';
    }
    [query, subject].forEach((input) => input.addEventListener('input', invalidate));
    [kind, type].forEach((select) =>
      select.addEventListener('change', () => {
        updateFields();
        invalidate();
      })
    );
    async function readStatus() {
      const request = ++statusSerial;
      const button = find('#local-search-refresh');
      button.disabled = true;
      find('#local-search-source').textContent = '正在读取随安装包附带的索引状态…';
      const value = await refreshStatus();
      if (!alive() || request !== statusSerial) return;
      button.disabled = false;
      find('#local-search-source').textContent = statusText(value);
    }
    find('#local-search-refresh').onclick = readStatus;
    find('#local-search-close').onclick = () => dialog.close();
    dialog.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dialog.close();
    });
    const parentClosed = () => dialog.close();
    parentDialog?.addEventListener('close', parentClosed);
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (
        event.clientX < rect.left ||
        event.clientX > rect.right ||
        event.clientY < rect.top ||
        event.clientY > rect.bottom
      )
        dialog.close();
    });
    dialog.addEventListener(
      'close',
      () => {
        serial++;
        statusSerial++;
        parentDialog?.removeEventListener('close', parentClosed);
        if (activeDialog === dialog) activeDialog = null;
        dialog.remove();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      },
      { once: true }
    );
    find('#local-search-form').onsubmit = async (event) => {
      event.preventDefault();
      const keyword = query.value.trim();
      if (!keyword) {
        query.setCustomValidity('请输入名称关键词。');
        query.reportValidity();
        query.setCustomValidity('');
        return;
      }
      const selectedKind = kind.value;
      const request = ++serial;
      statusSerial++;
      clearError();
      results.replaceChildren();
      results.setAttribute('aria-busy', 'true');
      submit.disabled = true;
      submit.textContent = '正在检索…';
      status.textContent = `正在本地检索${kinds[selectedKind]}「${keyword}」…`;
      const args = { query: keyword, kind: selectedKind };
      if (selectedKind === 'subject' && Number(type.value)) args.types = [Number(type.value)];
      if (selectedKind !== 'subject' && subject.value.trim())
        args.subjectId = Number(subject.value.trim());
      try {
        const result = await api('searchLocalIndex', args);
        if (!alive() || request !== serial) return;
        rememberStatus(result);
        if (result.error) throw new Error(errorText(result.error));
        if (!result.available) {
          status.textContent = '本地检索索引未安装。安装附带精简检索或完整检索索引的软件包后再试。';
          return;
        }
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        status.textContent = `${candidates.length ? `找到 ${fmt(candidates.length)} 个${kinds[selectedKind]}结果。` : '没有找到结果。可换用原名或别名，或调整筛选条件。'}${result.truncated ? '结果已截断，请补充关键词或限定条件缩小范围。' : result.complete === false ? '本次结果未完整返回，可缩小范围后重试。' : ''}`;
        results.innerHTML = candidates
          .map((candidate) => {
            const name = candidate.name_cn || candidate.name || '未命名条目';
            const match = candidate.match ?? candidate.score;
            const rating = candidate.rating?.score;
            const badges = [
              kinds[selectedKind],
              ...(selectedKind === 'subject' && types[candidate.type]
                ? [types[candidate.type]]
                : [])
            ];
            if (typeof match === 'number' && Number.isFinite(match))
              badges.push(`名称匹配 ${Math.round(match * 100)}%`);
            if (typeof rating === 'number' && Number.isFinite(rating))
              badges.push(`评分 ${rating.toFixed(1)}`);
            if (
              !(typeof match === 'number' && Number.isFinite(match)) &&
              !(typeof rating === 'number' && Number.isFinite(rating))
            )
              badges.push('分数未提供');
            const validId = /^[1-9]\d*$/.test(String(candidate.id));
            return `<article class="local-search-result" data-local-result-id="${esc(candidate.id)}"><div class="local-search-result-heading"><div><h3>${esc(name)}</h3>${candidate.name && candidate.name !== name ? `<p class="local-search-original">${esc(candidate.name)}</p>` : ''}</div>${validId ? `<button type="button" class="text-button" data-local-open="${esc(candidate.id)}" aria-label="打开${esc(name)}的 Bangumi 官方条目">${svg('external')}官方条目</button>` : ''}</div><div class="local-search-badges"><span class="chip">ID ${esc(candidate.id)}</span>${badges.map((badge) => `<span class="chip">${esc(badge)}</span>`).join('')}</div>${candidate.summary ? `<details class="local-search-summary"><summary>查看摘要</summary><p>${esc(candidate.summary)}</p></details>` : ''}</article>`;
          })
          .join('');
        results.querySelectorAll('[data-local-open]').forEach((button) => {
          button.onclick = async () => {
            button.disabled = true;
            clearError();
            try {
              await api('external', {
                url: `https://bgm.tv/${selectedKind}/${button.dataset.localOpen}`
              });
            } catch (error) {
              if (alive()) {
                errorArea.hidden = false;
                errorArea.textContent = `无法打开官方条目：${errorText(error)}。请重试。`;
              }
            } finally {
              if (button.isConnected) button.disabled = false;
            }
          };
        });
      } catch (error) {
        if (!alive() || request !== serial) return;
        errorArea.hidden = false;
        errorArea.textContent = `本地检索失败：${errorText(error)}。请重试，或重新读取索引状态。`;
        status.textContent = '本次检索未完成。';
      } finally {
        if (alive() && request === serial) {
          submit.disabled = false;
          submit.innerHTML = svg('search') + '检索';
          results.setAttribute('aria-busy', 'false');
          find('#local-search-refresh').disabled = false;
        }
      }
    };
    kind.value = kinds[options.kind] ? options.kind : 'subject';
    query.value = options.query || '';
    updateFields();
    dialog.showModal();
    query.focus();
    readStatus();
    return dialog;
  }

  window.albumLocalSearch = { show, refreshStatus, setStatus: rememberStatus, mountSettings };
  document.querySelector('#local-search-button').onclick = () => show();
})();
