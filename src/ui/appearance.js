'use strict';
(function () {
  const spec = window.albumAppearanceSpec,
    labels = {
      liquidFloatingTransparency: '悬浮组件透明度',
      liquidDialogTransparency: '弹窗透明度',
      frostFloatingTransparency: '悬浮组件透明度',
      frostDialogTransparency: '弹窗透明度',
      cardRadius: '全局卡片圆角',
      density: '卡片尺寸'
    },
    ids = {
      liquidFloatingTransparency: 'liquid-floating-transparency',
      liquidDialogTransparency: 'liquid-dialog-transparency',
      frostFloatingTransparency: 'frost-floating-transparency',
      frostDialogTransparency: 'frost-dialog-transparency',
      cardRadius: 'card-radius',
      density: 'density'
    };
  let previous = {};
  function apply(settings) {
    const next = { ...spec.normalize(settings), liquidGlass: settings?.liquidGlass !== false },
      root = document.documentElement,
      mode = next.liquidGlass ? 'liquid' : 'frost',
      tokens = {
        '--liquid-floating-opacity': 1 - next.liquidFloatingTransparency / 100,
        '--liquid-dialog-opacity': 1 - next.liquidDialogTransparency / 100,
        '--frost-floating-opacity': 1 - next.frostFloatingTransparency / 100,
        '--frost-dialog-opacity': 1 - next.frostDialogTransparency / 100,
        '--floating-opacity': 1 - next[mode + 'FloatingTransparency'] / 100,
        '--dialog-opacity': 1 - next[mode + 'DialogTransparency'] / 100,
        '--user-card-radius': next.cardRadius + 'px'
      };
    let materialChanged = previous.liquidGlass !== next.liquidGlass;
    for (const [token, value] of Object.entries(tokens)) {
      if (previous[token] === value) continue;
      root.style.setProperty(token, String(value));
      if (token !== '--user-card-radius') materialChanged = true;
    }
    for (const group of ['Floating', 'Dialog'])
      root.dataset[group.toLowerCase() + 'Transparent'] =
        next[mode + group + 'Transparency'] === 100 ? 'on' : 'off';
    if (previous.textShadow !== next.textShadow)
      root.dataset.textShadow = next.textShadow ? 'on' : 'off';
    previous = { ...next, ...tokens };
    if (materialChanged)
      window.dispatchEvent(
        new CustomEvent('album-appearance-change', {
          detail: {
            mode,
            floatingTransparency: next[mode + 'FloatingTransparency'],
            dialogTransparency: next[mode + 'DialogTransparency']
          }
        })
      );
  }
  function rangeMarkup(key, prefix = 'appearance') {
    const range = spec.ranges[key],
      id = `${prefix}-${ids[key]}`,
      mode = key.startsWith('liquid') ? 'liquid' : key.startsWith('frost') ? 'frost' : '';
    return `<div class="setting-row appearance-range-row"${mode ? ` data-appearance-mode="${mode}"${mode === 'frost' ? ' hidden' : ''}` : ''}><div><label for="${id}"><strong>${labels[key]}</strong></label><p id="${id}-help">${key.includes('Transparency') ? '0% 不透明，100% 完全透明' : key === 'cardRadius' ? '调整卡片边角的圆润程度。' : '拖动调整卡片大小。'}</p></div><div class="appearance-range-control"><input id="${id}" data-appearance-key="${key}" type="range" min="${range.min}" max="${range.max}" step="1" value="${range.default}" aria-describedby="${id}-help ${id}-value"><output id="${id}-value" for="${id}"></output><button type="button" class="subtle-button appearance-reset" data-appearance-reset="${key}" title="恢复默认值" aria-label="恢复默认值">恢复默认</button></div></div>`;
  }
  function markup(group = 'all') {
    return `${group === 'glass' ? '' : `<div class="setting-row"><div><label for="appearance-text-shadow"><strong>全局字体阴影</strong></label><p id="appearance-text-shadow-help">为文字添加柔和阴影，关闭时也移除重叠区域的旧阴影。</p></div><input id="appearance-text-shadow" data-appearance-key="textShadow" type="checkbox" class="switch" aria-describedby="appearance-text-shadow-help"></div>`}${Object.keys(
      labels
    )
      .filter(
        (key) =>
          group === 'all' ||
          (group === 'glass' ? key.includes('Transparency') : !key.includes('Transparency'))
      )
      .map((key) => rangeMarkup(key))
      .join('')}`;
  }
  function createController({
    settings,
    save,
    onDensity = null,
    previewDensity = () => {},
    finishDensity = () => {},
    flushDensity = () => Promise.resolve(),
    notify = () => {},
    delay = 160
  }) {
    const dirty = new Map(),
      pending = new Map(),
      revisions = {};
    let timer = 0,
      frame = 0,
      task = null,
      inFlight = null,
      densityPreview = false,
      densityFinished = true;
    function sync(root = document) {
      const values = spec.normalize(settings()),
        mode = settings().liquidGlass !== false ? 'liquid' : 'frost';
      for (const row of root.querySelectorAll('[data-appearance-mode]'))
        row.hidden = row.dataset.appearanceMode !== mode;
      for (const input of root.querySelectorAll('[data-appearance-key]')) {
        const key = input.dataset.appearanceKey,
          value = values[key];
        if (key === 'textShadow') input.checked = value;
        else {
          input.value = String(value);
          const text = value + (key.includes('Transparency') ? '%' : ' px');
          input.setAttribute('aria-valuetext', text);
          const output = root.querySelector(`#${input.id}-value`);
          if (output && output.textContent !== text) output.textContent = text;
        }
      }
    }
    function preview() {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      apply(settings());
      if (densityPreview) {
        densityPreview = false;
        previewDensity(settings().density);
      }
      sync();
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(preview);
    }
    function set(key, value) {
      if (
        !spec.valid(key, value) ||
        (settings()[key] === value &&
          !(key === 'density' && settings().densityConfigured === false))
      )
        return;
      settings()[key] = value;
      // Selecting the current medium is still an explicit numeric preference.
      // Record that intent before an asynchronous save or window resize can run.
      if (key === 'density') settings().densityConfigured = true;
      revisions[key] = (revisions[key] || 0) + 1;
      // Scoped density is recorded at the input event, before navigation or debounce.
      if (key === 'density' && onDensity) onDensity(value);
      else dirty.set(key, value);
      if (key === 'density') {
        densityPreview = true;
        densityFinished = false;
      }
      schedule();
      clearTimeout(timer);
      timer = setTimeout(() => {
        void flush(false);
      }, delay);
    }
    function flush(finish = true) {
      clearTimeout(timer);
      timer = 0;
      preview();
      if (finish && !densityFinished) {
        densityFinished = true;
        finishDensity();
      }
      for (const [key, value] of dirty) {
        if (inFlight?.key === key && inFlight.value === value) pending.delete(key);
        else pending.set(key, value);
      }
      if (task) return task;
      task = Promise.resolve()
        .then(async () => {
          while (pending.size) {
            const [key, value] = pending.entries().next().value;
            pending.delete(key);
            inFlight = { key, value };
            try {
              await save(key, value);
              if (dirty.get(key) === value) dirty.delete(key);
            } catch (error) {
              notify(
                `外观设置保存失败：${error.message || String(error)}。请重新调整或点击恢复默认重试。`,
                true
              );
            } finally {
              inFlight = null;
            }
          }
        })
        .finally(() => {
          task = null;
        });
      return Promise.all([task, flushDensity().catch((error) => {
        notify(`卡片尺寸保存失败：${error.message || error}`, true);
      })]);
    }
    function mount(root) {
      sync(root);
      for (const input of root.querySelectorAll('[data-appearance-key]')) {
        const update = () =>
          set(
            input.dataset.appearanceKey,
            input.type === 'checkbox' ? input.checked : Number(input.value)
          );
        input.addEventListener('input', update);
        input.addEventListener('change', () => {
          update();
          void flush();
        });
        input.addEventListener('blur', () => {
          void flush();
        });
      }
      for (const button of root.querySelectorAll('[data-appearance-reset]'))
        button.addEventListener('click', () => {
          const key = button.dataset.appearanceReset;
          set(key, spec.defaults[key]);
          void flush();
        });
    }
    function snapshot() {
      return { ...revisions };
    }
    function mergeSummary(incoming, started = {}) {
      const merged = { ...incoming };
      for (const key of Object.keys(spec.defaults))
        if (dirty.has(key) || (revisions[key] || 0) !== (started[key] || 0)) delete merged[key];
      // A read started during a save can finish after dirty has been cleared.
      // Keep the explicit width authoritative for the remainder of this session.
      if (onDensity || revisions.density) {
        delete merged.density;
        delete merged.densityConfigured;
      }
      return merged;
    }
    function resetDensityPreview() {
      densityPreview = false;
      densityFinished = true;
      finishDensity();
    }
    return { set, flush, mount, sync, snapshot, mergeSummary, resetDensityPreview };
  }
  window.albumAppearance = { apply, markup, rangeMarkup, createController };
})();
