/* Bundled faces and installed fonts stay offline; no font is uploaded or installed. */
(() => {
  'use strict';
  const fallback = "'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
  const defaultFamily = '方正兰亭圆_GBK_中';
  const builtins = Object.freeze([
    '方正兰亭圆_GBK',
    '方正兰亭圆_GBK_准',
    '方正兰亭圆_GBK_中',
    '方正兰亭圆_GBK_中粗',
    '方正兰亭圆_GBK_特'
  ]);
  const valid = (value) =>
    typeof value === 'string' && value.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(value);
  const effective = (family) => family || defaultFamily;
  const fontStack = (family) => `${JSON.stringify(effective(family))}, ${fallback}`;
  let generation = 0,
    currentStack = '',
    pendingLoad = Promise.resolve(false);
  function capture() {
    try {
      const viewport = document.getElementById('viewport');
      if (!viewport || typeof captureDisplayAnchor !== 'function') return null;
      const snapshot = {
        viewport,
        anchor: captureDisplayAnchor(),
        view: typeof viewKey === 'function' ? viewKey() : null,
        moved: false
      };
      snapshot.onScroll = () => {
        snapshot.moved = true;
      };
      viewport.addEventListener('scroll', snapshot.onScroll, { passive: true });
      return snapshot;
    } catch {
      return null;
    }
  }
  function release(snapshot) {
    snapshot?.viewport.removeEventListener('scroll', snapshot.onScroll);
  }
  function apply(settings = {}) {
    const family = valid(settings.fontFamily) ? settings.fontFamily.trim() : '';
    const stack = fontStack(family);
    if (stack === currentStack) return pendingLoad;
    currentStack = stack;
    const version = ++generation,
      snapshot = capture();
    document.documentElement.style.fontFamily = stack;
    // The named presets are static font faces. Use the adjacent real weight for
    // secondary ink rather than requesting a weight their 100..900 alias cannot render.
    const preset = builtins.indexOf(effective(family));
    const inkFamily =
      preset >= 0 ? builtins[Math.min(preset + 1, builtins.length - 1)] : effective(family);
    document.documentElement.style.setProperty('--secondary-font-family', fontStack(inkFamily));
    document.documentElement.dataset.fontState = 'loading';
    if (!document.fonts?.load) {
      document.documentElement.dataset.fontState = 'fallback';
      release(snapshot);
      return (pendingLoad = Promise.resolve(false));
    }
    pendingLoad = (async () => {
      try {
        const weights =
          effective(family) === 'ACG Lanting Yuan' ? [400, 500, 600, 700, 900] : [400];
        const faces = await Promise.all(
          weights.map((weight) =>
            document.fonts.load(
              `${weight} 16px ${JSON.stringify(effective(family))}`,
              '相册 Aa0123'
            )
          )
        );
        if (version !== generation) return false;
        // A public checkout has no private font files. Empty face results must
        // not claim that a preset loaded, while ordinary installed fonts can
        // legitimately resolve without returning any CSS FontFace objects.
        if (
          (builtins.includes(effective(family)) || effective(family) === 'ACG Lanting Yuan') &&
          faces.some((result) => !result.length)
        ) {
          document.documentElement.dataset.fontState = 'fallback';
          return false;
        }
        await document.fonts.ready;
        if (version !== generation) return false;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (version !== generation) return false;
        let anchor;
        try {
          const sameView =
            snapshot &&
            (!snapshot.view || typeof viewKey !== 'function' || snapshot.view === viewKey());
          anchor =
            snapshot && !snapshot.moved && sameView
              ? snapshot.anchor
              : typeof captureDisplayAnchor === 'function'
                ? captureDisplayAnchor()
                : null;
        } catch {
          /* The page may still be mounting or have navigated. */
        }
        document.documentElement.dataset.fontState = 'ready';
        window.dispatchEvent(
          new CustomEvent('album:font-loaded', { detail: { family: effective(family) } })
        );
        window.dispatchEvent(new Event('resize'));
        if (anchor && typeof restoreDisplayAnchor === 'function') restoreDisplayAnchor(anchor);
        return true;
      } catch {
        if (version === generation) document.documentElement.dataset.fontState = 'fallback';
        return false;
      } finally {
        release(snapshot);
      }
    })();
    return pendingLoad;
  }
  function mount(host, { settings, save }) {
    const button = host.querySelector('#font-choose'),
      label = host.querySelector('#font-current');
    if (!button || !label) return;
    const describe = () => {
      label.textContent = settings().fontFamily || defaultFamily;
    };
    button.textContent = '选择字体';
    describe();
    button.onclick = () => openPicker({ settings, save, onSaved: describe, trigger: button });
  }
  function openPicker({ settings, save, onSaved, trigger }) {
    if (document.querySelector('#font-picker')) return;
    const dialog = document.createElement('dialog');
    dialog.id = 'font-picker';
    dialog.className = 'modal font-picker glass';
    dialog.dataset.fontLayer = 'builtin';
    dialog.setAttribute('aria-labelledby', 'font-picker-title');
    dialog.innerHTML =
      '<div class="modal-top"><div><h2 id="font-picker-title">选择全局字体</h2><p data-font-help>预设字体在本机可用时使用，缺失时自动使用系统后备字体。也可选择这台电脑已安装的字体。</p></div><button class="icon-button" data-font-close aria-label="关闭字体选择">×</button></div><button class="subtle-button" data-font-back hidden>返回预设字体</button><button class="font-option font-local-entry" data-font-local aria-controls="font-options">选择本地字体</button><div data-font-local-controls hidden><label for="font-search">搜索已安装字体</label><input class="field-input" id="font-search" type="search" placeholder="输入中文或英文字体名称" autocomplete="off"></div><div id="font-options" role="listbox" aria-label="预设字体"></div><button class="subtle-button" data-font-more hidden>显示更多字体</button><p class="font-status" role="status" aria-live="polite"></p><button class="subtle-button" data-font-retry hidden>重新读取字体</button>';
    document.body.append(dialog);
    const search = dialog.querySelector('#font-search'),
      options = dialog.querySelector('#font-options'),
      status = dialog.querySelector('.font-status'),
      retry = dialog.querySelector('[data-font-retry]'),
      more = dialog.querySelector('[data-font-more]'),
      back = dialog.querySelector('[data-font-back]'),
      local = dialog.querySelector('[data-font-local]'),
      localControls = dialog.querySelector('[data-font-local-controls]');
    const snapshot = window.albumDialogInteraction?.rememberFocus(trigger),
      parent = trigger.closest('dialog');
    let families = [],
      busy = false,
      loading = false,
      loaded = false,
      disposed = false,
      limit = 160,
      layer = 'builtin';
    function close() {
      dialog.close();
    }
    const parentClosed = () => close();
    parent?.addEventListener('close', parentClosed);
    dialog.querySelector('[data-font-close]').onclick = close;
    dialog.addEventListener('cancel', (event) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      close();
    });
    dialog.addEventListener(
      'close',
      () => {
        disposed = true;
        parent?.removeEventListener('close', parentClosed);
        dialog.remove();
        if (trigger.isConnected) {
          if (snapshot) window.albumDialogInteraction.restoreFocus(snapshot);
          else trigger.focus({ preventScroll: true });
        }
      },
      { once: true }
    );
    async function select(family) {
      if (busy) return;
      busy = true;
      render();
      status.textContent = '正在保存字体…';
      let failure = '';
      try {
        await save('fontFamily', family);
        apply(settings());
        onSaved();
        if (!disposed) close();
      } catch (error) {
        failure = `保存失败：${error.message || String(error)}。请重试。`;
      } finally {
        busy = false;
        if (!disposed) {
          render();
          if (failure) {
            status.textContent = failure;
            [...options.querySelectorAll('button')]
              .find((item) => item.dataset.fontFamily === family)
              ?.focus({ preventScroll: true });
          }
        }
      }
    }
    function keyboard(event, option) {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [
        ...(layer === 'builtin' && !local.disabled ? [local] : []),
        ...options.querySelectorAll('button:not(:disabled)')
      ];
      const index = items.indexOf(option);
      const target =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      items[target]?.focus({ preventScroll: true });
      items[target]?.scrollIntoView({ block: 'nearest' });
    }
    function render() {
      const term = search.value.trim().toLocaleLowerCase(),
        selected = settings().fontFamily || defaultFamily;
      const matches = families.filter((family) => family.toLocaleLowerCase().includes(term));
      const rows = layer === 'builtin' ? builtins : ['', ...matches.slice(0, limit)];
      dialog.dataset.fontLayer = layer;
      local.hidden = layer !== 'builtin';
      local.disabled = busy;
      back.hidden = layer !== 'local';
      back.disabled = busy;
      localControls.hidden = layer !== 'local';
      search.disabled = busy;
      more.hidden = layer !== 'local' || matches.length <= limit;
      more.disabled = busy;
      retry.hidden = true;
      retry.disabled = busy;
      options.setAttribute('aria-busy', String(busy || (layer === 'local' && loading)));
      options.setAttribute('aria-label', layer === 'builtin' ? '预设字体' : '已安装字体');
      const fragment = document.createDocumentFragment();
      for (const family of rows) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'font-option';
        option.disabled = busy;
        option.dataset.fontFamily = family;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String((family || defaultFamily) === selected));
        option.textContent = family || defaultFamily + '（默认）';
        option.title = family || '恢复默认字体；本机不可用时使用系统后备字体';
        option.style.fontFamily = family ? `${JSON.stringify(family)}, ${fallback}` : fontStack('');
        option.onclick = () => select(family);
        option.onkeydown = (event) => keyboard(event, option);
        fragment.append(option);
      }
      options.replaceChildren(fragment);
      if (!busy)
        status.textContent =
          layer === 'builtin'
            ? '五种预设字型需在本机可用，缺失时自动使用系统后备字体。'
            : loading
              ? '正在读取这台电脑已安装的字体…'
              : loaded
                ? term
                  ? `找到 ${matches.length} 种字体。`
                  : `已读取 ${families.length} 种本地字体${families.length > limit ? `，先显示 ${limit} 种，可搜索全部或继续加载` : ''}。`
                : '';
    }
    async function load() {
      if (loading) return;
      loading = true;
      render();
      try {
        const result = await window.album.call('systemFonts');
        if (disposed) return;
        families = [
          ...new Set((result?.families || []).filter((family) => valid(family) && family.trim()))
        ];
        loaded = true;
        loading = false;
        if (layer === 'local') {
          render();
          if (!families.length) status.textContent = '此系统暂不支持字体列表，仍可使用预设字体。';
        }
      } catch (error) {
        loading = false;
        if (!disposed && layer === 'local') {
          render();
          status.textContent = `读取失败：${error.message || String(error)}。`;
          retry.hidden = false;
        }
      } finally {
        loading = false;
        if (!disposed) options.setAttribute('aria-busy', String(busy));
      }
    }
    local.onclick = () => {
      if (busy) return;
      layer = 'local';
      render();
      search.focus({ preventScroll: true });
      if (!loaded) void load();
    };
    local.onkeydown = (event) => keyboard(event, local);
    back.onclick = () => {
      if (!busy) {
        layer = 'builtin';
        render();
        local.focus({ preventScroll: true });
      }
    };
    search.oninput = () => {
      limit = 160;
      render();
    };
    more.onclick = () => {
      limit += 160;
      render();
    };
    retry.onclick = load;
    dialog.showModal();
    render();
    local.focus({ preventScroll: true });
  }
  window.albumTypography = Object.freeze({ apply, mount });
})();
