'use strict';

// Classic-script extension: app.js owns modal, settings and IPC primitives.
(() => {
  let activeContext = null;
  const authorLinks = {
    github: 'https://github.com/GXinnnnnn',
    bilibili: 'https://space.bilibili.com/396517775',
    bangumi: 'https://bgm.tv'
  };
  const platformIcons = {
    github:
      '<svg viewBox="0 0 24 24" aria-hidden="true" class="about-platform-icon about-github-icon"><path d="M12 .8a11.4 11.4 0 0 0-3.6 22.2c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.9 2.8 1.4 3.5 1.1.1-.8.4-1.4.8-1.7-2.7-.3-5.5-1.4-5.5-6a4.6 4.6 0 0 1 1.2-3.1 4.3 4.3 0 0 1 .1-3.1s1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.4 1 .5 2.1.1 3.1a4.6 4.6 0 0 1 1.2 3.1c0 4.6-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.4c0 .3.2.7.8.6A11.4 11.4 0 0 0 12 .8Z"/></svg>',
    bilibili:
      '<svg viewBox="0 0 24 24" aria-hidden="true" class="about-platform-icon about-bilibili-icon"><path d="m7 3 3 3m7-3-3 3M5 7h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M8 11v3m8-3v3m-7 3 3 1 3-1"/></svg>'
  };

  function errorText(error) {
    return error?.message || String(error || '操作未完成，请重试。');
  }

  function webUrl(value) {
    try {
      const url = new URL(String(value || ''));
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        ? url.href
        : '';
    } catch {
      return '';
    }
  }

  function externalLink(url, label, className = 'about-inline-link') {
    const safe = webUrl(url);
    return safe
      ? `<a class="${className}" href="${esc(safe)}" data-about-external="${esc(safe)}">${esc(label)}${svg('external')}</a>`
      : `<span>${esc(label)}</span>`;
  }

  let childSerial = 0;
  function mount(title, html, width = 760) {
    const parent = activeContext?.alive() ? activeContext : null;
    const parentDialog =
      parent?.dialog || ($('#modal').open && $('#settings-shell') ? $('#modal') : null);
    const returnFocus = document.activeElement;
    let dialog;
    if (parentDialog) {
      // Native child dialogs preserve the settings DOM, drafts, scroll and generation.
      dialog = document.createElement('dialog');
      dialog.className = 'modal';
      dialog.dataset.infoChild = 'true';
      const titleId = `info-child-title-${++childSerial}`;
      dialog.setAttribute('aria-labelledby', titleId);
      dialog.style.width = width + 'px';
      dialog.innerHTML = `<div class="modal-top"><div><span class="eyebrow">ACG-album</span><h2 id="${titleId}">${esc(title)}</h2></div><button class="icon-button info-dialog-close" aria-label="关闭并返回上一级" data-icon="x"></button></div><div>${html}</div>`;
      document.body.append(dialog);
      hydrateIcons(dialog);
      dialog.querySelector('.info-dialog-close').onclick = () => dialog.close();
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (
          event.clientX < r.left ||
          event.clientX > r.right ||
          event.clientY < r.top ||
          event.clientY > r.bottom
        )
          dialog.close();
      });
      dialog.showModal();
    } else {
      activeContext?.dispose();
      dialog = openModal(title, html, width);
    }
    const root = dialog.querySelector('[data-album-info]');
    const generation = modalGeneration;
    const controller = new AbortController();
    let disposed = false;
    dialog.classList.add('album-info-dialog');
    if (!parentDialog) dialog.setAttribute('aria-labelledby', 'modal-title');
    const context = {
      root,
      dialog,
      children: new Set(),
      signal: controller.signal,
      alive: () => !disposed && dialog.open && root.isConnected && generation === modalGeneration,
      find: (selector) => root.querySelector(selector),
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const child of context.children) child.dispose();
        controller.abort();
        observer.disconnect();
        parent?.children.delete(context);
        dialog.classList.remove('album-info-dialog');
        if (parentDialog) {
          dialog.close();
          dialog.remove();
          if (parentDialog.open && returnFocus?.isConnected)
            returnFocus.focus({ preventScroll: true });
        }
        if (activeContext === context) activeContext = parent?.alive() ? parent : null;
      }
    };
    parent?.children.add(context);
    const observer = new MutationObserver(() => {
      if (!context.alive()) context.dispose();
    });
    observer.observe(root.parentElement, { childList: true });
    if (parentDialog) {
      observer.observe($('#modal-content'), { childList: true });
      parentDialog.addEventListener('close', () => context.dispose(), {
        signal: controller.signal
      });
    }
    dialog.addEventListener(
      'close',
      () => {
        if (!dialog.open) context.dispose();
      },
      { signal: controller.signal }
    );
    root.addEventListener(
      'click',
      (event) => {
        const link = event.target.closest('[data-about-external]');
        if (!link || !root.contains(link)) return;
        event.preventDefault();
        const url = webUrl(link.dataset.aboutExternal);
        if (url) attempt(() => api('external', { url }));
      },
      { signal: controller.signal }
    );
    activeContext = context;
    return context;
  }

  function renderCredits(credits) {
    const labels = {
      runtime: '运行时依赖',
      development: '开发与构建',
      assets: '素材与服务',
      services: '资料服务'
    };
    const groups = Object.entries(credits || {}).filter(
      ([, entries]) => Array.isArray(entries) && entries.length
    );
    if (!groups.length) return '<p class="about-note">当前安装包未提供依赖清单。</p>';
    return groups
      .map(
        ([key, entries]) =>
          `<section class="about-credit-group"><h3>${esc(labels[key] || key)}</h3><ul class="about-credits-list">${entries
            .map((entry) => {
              const item = entry && typeof entry === 'object' ? entry : { name: String(entry) };
              return `<li><details class="about-credit"><summary class="about-credit-summary"><strong>${esc(item.name || '未命名项目')}</strong><span class="about-credit-version">${esc(item.version || '未标注版本')}</span></summary><div class="about-credit-detail"><span>许可证：${esc(item.license || '见随附声明')}</span><span>用途：${esc(item.purpose || '未提供用途说明')}</span>${externalLink(item.url, '访问项目主页')}</div></details></li>`;
            })
            .join('')}</ul></section>`
      )
      .join('');
  }

  window.showAbout = async function showAbout() {
    const parentId = S.parent;
    const context = mount(
      '关于ACG-album',
      `<div class="album-about" data-album-info>
      <div class="about-identity"><img class="about-app-icon" src="../assets/app.png" alt="" width="64" height="64"><div><span class="about-kicker">把喜欢的世界，留在身边</span><h3 class="about-app-name">ACG-album</h3><span class="about-version" data-about-version>正在读取版本…</span></div></div>
      <div class="about-description"><p>ACG-album是一款个性化本地相册，主要为收藏动画、游戏画面的你而做。用多层嵌套相册整理喜欢的作品，通过 Bangumi 搜索并关联作品简介，让收藏也有自己的故事。</p><p>图片与视频，连同拍摄时间和回忆，都能在这里慢慢整理。原始媒体留在本地，隐私由自己掌握；作品资料检索与更新检查会连接相应的在线服务。</p></div>
      <details class="about-disclosure about-sponsor"><summary><span>投喂一点快乐</span><span class="about-summary-hint">感谢每一份心意</span></summary><div class="about-disclosure-body"><p class="about-sponsor-message">如果喜欢这个小相册，欢迎投喂一杯快乐水～(｡･ω･｡)ﾉ♡<br>谢谢老板，祝你喜欢的作品永不散场！</p><div class="about-qr-grid"><figure class="about-qr-card"><figcaption>支付宝</figcaption><img src="../assets/sponsor/alipay-qr.png" alt="支付宝赞助收款二维码" loading="lazy"><span>谢谢你的快乐水</span></figure><figure class="about-qr-card"><figcaption>微信支付</figcaption><img src="../assets/sponsor/wechat-qr.png" alt="微信支付赞助收款二维码" loading="lazy"><span>每一份支持都很珍贵</span></figure></div></div></details>
      <div class="about-author-heading">遇见作者<span>愿热爱一直有回响</span></div><div class="about-author-grid"><a class="about-author-card" href="${authorLinks.github}" data-about-external="${authorLinks.github}"><img src="../assets/author/github.webp" alt="" width="42" height="42"><span class="about-author-text"><span class="about-platform">${platformIcons.github}GitHub <span class="about-account">GXinnnnnn</span></span><strong>友利奈绪的胖次</strong></span>${svg('external')}</a><a class="about-author-card" href="${authorLinks.bilibili}" data-about-external="${authorLinks.bilibili}"><img src="../assets/author/bilibili.webp" alt="" width="42" height="42"><span class="about-author-text"><span class="about-platform">${platformIcons.bilibili}Bilibili</span><strong>友利奈绪の胖次</strong></span>${svg('external')}</a></div>
      <details class="about-disclosure about-credits"><summary><span>开源致谢</span><span class="about-summary-hint">感谢让小相册成为可能的项目</span></summary><div class="about-disclosure-body"><div data-about-credits aria-live="polite"><p class="about-note">正在读取项目与许可证信息…</p></div><p class="about-license-note">完整许可证与第三方声明随安装包附带，请参阅随附的开源许可文档。</p></div></details>
      <div class="about-bottom"><div class="about-bangumi"><span class="about-bangumi-label">Bangumi · 作品资料</span>${parentId ? '<button type="button" class="about-inline-link" data-about-bind>为当前相册搜索 / 关联作品' + svg('chevron-right') + '</button>' : '<span class="about-note">先打开相册后可关联</span>'}${externalLink(authorLinks.bangumi, '浏览 Bangumi')}</div><button type="button" class="subtle-button" data-about-updates>${svg('refresh')}检查更新</button></div><p class="about-local-error inline-error" data-about-error role="alert"></p><footer class="about-copyright">© 2026 友利奈绪的胖次 (GXinnnnnn) · MIT License</footer>
    </div>`
    );
    context
      .find('[data-about-updates]')
      .addEventListener('click', () => window.showUpdates(), { signal: context.signal });
    const bindButton = context.find('[data-about-bind]');
    bindButton?.addEventListener(
      'click',
      async () => {
        bindButton.disabled = true;
        context.find('[data-about-error]').textContent = '';
        try {
          const folder = await api('get', { id: parentId });
          if (!context.alive()) return;
          if (!folder || folder.kind !== 'folder')
            throw new Error('当前相册已不可用，请先打开一个相册后重试。');
          closeModal();
          context.dispose();
          bindModal(folder);
        } catch (error) {
          if (context.alive()) context.find('[data-about-error]').textContent = errorText(error);
        } finally {
          if (context.alive()) bindButton.disabled = false;
        }
      },
      { signal: context.signal }
    );
    context.dialog.querySelector('.info-dialog-close, #modal-close').focus({ preventScroll: true });
    try {
      const info = await api('appInfo');
      if (!context.alive()) return;
      context.find('[data-about-version]').textContent = info?.version
        ? `版本 ${info.version}`
        : '未提供版本信息';
      context.find('[data-about-credits]').innerHTML = renderCredits(info?.credits);
    } catch (error) {
      if (!context.alive()) return;
      context.find('[data-about-version]').textContent = '版本信息暂不可用';
      context.find('[data-about-credits]').innerHTML =
        `<p class="inline-error">无法读取致谢信息：${esc(errorText(error))}</p>`;
    }
  };

  function normalizeRepository(value) {
    let repository = String(value || '').trim();
    if (!repository) return '';
    if (/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(repository)) {
      const url = new URL(/^https?:\/\//i.test(repository) ? repository : `https://${repository}`);
      if (
        !/^https?:$/.test(url.protocol) ||
        !/^(?:www\.)?github\.com$/i.test(url.hostname) ||
        url.username ||
        url.password ||
        url.port
      )
        throw new Error('请输入 GitHub 仓库网址，或「所有者/仓库名」。');
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) throw new Error('仓库地址需要包含所有者与仓库名。');
      repository = parts.slice(0, 2).join('/');
    }
    repository = repository.replace(/\/+$/, '').replace(/\.git$/i, '');
    const parts = repository.split('/');
    if (
      parts.length !== 2 ||
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(parts[0]) ||
      !/^[a-z\d._-]{1,100}$/i.test(parts[1]) ||
      /^\.{1,2}$/.test(parts[1])
    ) {
      throw new Error(
        '请填写有效的「所有者/仓库名」，例如 GXinnnnnn/仓库名；也可粘贴 GitHub 仓库网址。'
      );
    }
    return repository;
  }

  function renderUpdateResult(result, version, repository) {
    const current = result?.currentVersion || version || '未知';
    const latest = result?.latestVersion;
    const statuses = {
      unconfigured: [
        '尚未配置更新仓库',
        '填写本应用实际发布 Release 的公开 GitHub 仓库后，再检查更新。'
      ],
      current: [
        '当前已是最新版本',
        `当前版本 ${current}${latest ? `，最新发布版本 ${latest}` : ''}。`
      ],
      available: [
        '发现新版本',
        `当前版本 ${current}${latest ? `，可用版本 ${latest}` : ''}。下载后请自行确认并安装。`
      ],
      unknown: [
        '暂时无法判断更新',
        `当前版本 ${current}${latest ? `，最新发布版本 ${latest}` : ''}。可前往 Releases 查看发布说明。`
      ]
    };
    const [title, message] = statuses[result?.status] || statuses.unknown;
    const directUrl = webUrl(result?.url);
    const releasesUrl = repository ? `https://github.com/${repository}/releases` : '';
    const actionUrl = directUrl || (result?.status !== 'unconfigured' ? releasesUrl : '');
    return `<div class="updates-result-card" data-update-status="${esc(statuses[result?.status] ? result.status : 'unknown')}"><strong>${esc(title)}</strong><p>${esc(message)}</p>${actionUrl ? externalLink(actionUrl, result?.status === 'available' ? '打开 Release / 下载' : '查看 Releases', 'subtle-button about-release-link') : ''}</div>`;
  }

  window.showUpdates = async function showUpdates() {
    const context = mount(
      '检查更新',
      `<div class="album-updates" data-album-info><div class="updates-intro"><span class="updates-symbol">${svg('refresh')}</span><div><h3>让小相册，慢慢变得更好</h3><p data-update-version>正在读取当前版本…</p></div></div><p class="updates-description">从你指定的 GitHub 公开仓库检查正式 Release。公开发布无需登录；找到更新后，可在系统默认浏览器中查看发布说明并下载。</p><form data-update-form><label for="album-update-repository">GitHub 更新仓库</label><input id="album-update-repository" class="field-input" type="text" placeholder="GXinnnnnn/仓库名" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="album-update-help album-update-error" disabled><p id="album-update-help" class="field-help">填写「所有者/仓库名」或 GitHub 仓库网址。尚未配置时保持为空，请以作者实际发布地址为准。</p><p id="album-update-error" class="inline-error updates-error" role="alert"></p><div class="updates-form-actions"><a class="about-inline-link" href="https://github.com" data-about-external="https://github.com">GitHub 首页${svg('external')}</a><button class="primary" type="submit" data-update-check disabled>${svg('refresh')}保存并检查更新</button></div></form><div class="updates-result" data-update-result role="status" aria-live="polite" aria-atomic="true"><p class="about-note">正在读取更新配置…</p></div><p class="updates-footnote">更新由你决定，下载安装包后手动安装。</p></div>`,
      640
    );
    const input = context.find('#album-update-repository');
    const button = context.find('[data-update-check]');
    const resultHost = context.find('[data-update-result]');
    const errorHost = context.find('#album-update-error');
    let version = '';
    let checking = false;
    let ready = false;
    const idleText = (repository) =>
      repository
        ? '点击「保存并检查更新」，查询此仓库的最新正式发布。'
        : '尚未配置更新仓库，暂时无法检查更新。';
    input.addEventListener(
      'input',
      () => {
        errorHost.textContent = '';
        input.removeAttribute('aria-invalid');
        resultHost.replaceChildren();
      },
      { signal: context.signal }
    );
    context.find('[data-update-form]').addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();
        if (checking || !ready || !context.alive()) return;
        let repository;
        try {
          repository = normalizeRepository(input.value);
        } catch (error) {
          errorHost.textContent = errorText(error);
          input.setAttribute('aria-invalid', 'true');
          input.focus();
          return;
        }
        checking = true;
        input.value = repository;
        input.disabled = button.disabled = true;
        input.removeAttribute('aria-invalid');
        errorHost.textContent = '';
        button.textContent = '正在检查…';
        context.find('[data-update-form]').setAttribute('aria-busy', 'true');
        resultHost.textContent = '正在保存仓库设置并检查最新 Release…';
        try {
          await saveSetting('githubRepository', repository);
          if (!context.alive()) return;
          const result = await api('checkUpdate');
          if (!context.alive()) return;
          resultHost.innerHTML = renderUpdateResult(result, version, repository);
        } catch (error) {
          if (!context.alive()) return;
          resultHost.replaceChildren();
          errorHost.textContent = `检查未完成：${errorText(error)}`;
        } finally {
          checking = false;
          if (context.alive()) {
            input.disabled = button.disabled = false;
            button.innerHTML = svg('refresh') + '保存并检查更新';
            context.find('[data-update-form]').removeAttribute('aria-busy');
          }
        }
      },
      { signal: context.signal }
    );
    try {
      const info = await api('appInfo');
      if (!context.alive()) return;
      version = String(info?.version || '');
      context.find('[data-update-version]').textContent = `当前版本 ${version || '未知'}`;
      input.value = String(info?.repository || '');
      resultHost.innerHTML = `<p class="about-note">${esc(idleText(input.value.trim()))}</p>`;
    } catch (error) {
      if (!context.alive()) return;
      context.find('[data-update-version]').textContent = '当前版本暂不可用';
      errorHost.textContent = `无法读取应用信息：${errorText(error)}`;
      resultHost.innerHTML = `<p class="about-note">${esc(idleText(''))}</p>`;
    } finally {
      if (context.alive()) {
        ready = true;
        input.disabled = button.disabled = false;
        // Do not steal focus if the user has already moved elsewhere in the dialog.
        if (
          [
            context.dialog,
            context.dialog.querySelector('.info-dialog-close, #modal-close')
          ].includes(document.activeElement)
        )
          input.focus({ preventScroll: true });
      }
    }
  };

  const unsubscribe = window.album.onEvent((event) => {
    if (event?.type !== 'application') return;
    if (event.data?.action === 'about') attempt(() => window.showAbout());
    if (event.data?.action === 'updates') attempt(() => window.showUpdates());
  });
  window.addEventListener(
    'pagehide',
    () => {
      activeContext?.dispose();
      if (typeof unsubscribe === 'function') unsubscribe();
    },
    { once: true }
  );
})();
