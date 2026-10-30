'use strict';
(function () {
  const spec = window.albumAppearanceSpec,
    labels = {
      liquidTransparency: '液态透明度',
      frostTransparency: '磨砂透明度',
      cardRadius: '全局卡片圆角',
      density: '卡片尺寸'
    },
    ids = {
      liquidTransparency: 'liquid-transparency',
      frostTransparency: 'frost-transparency',
      cardRadius: 'card-radius',
      density: 'density'
    };
  let previous = {};
  function apply(settings) {
    const next = spec.normalize(settings),
      root = document.documentElement;
    for (const [key, token, value] of [
      ['liquidTransparency', '--liquid-opacity', 1 - next.liquidTransparency / 100],
      ['frostTransparency', '--frost-opacity', 1 - next.frostTransparency / 100],
      ['cardRadius', '--user-card-radius', next.cardRadius + 'px']
    ])
      if (previous[key] !== next[key]) root.style.setProperty(token, String(value));
    if (previous.textShadow !== next.textShadow)
      root.dataset.textShadow = next.textShadow ? 'on' : 'off';
    const materialChanged =
      previous.liquidTransparency !== next.liquidTransparency ||
      previous.frostTransparency !== next.frostTransparency;
    previous = next;
    if (materialChanged)
      window.dispatchEvent(
        new CustomEvent('album-appearance-change', {
          detail: {
            liquidTransparency: next.liquidTransparency,
            frostTransparency: next.frostTransparency
          }
        })
      );
  }
  function rangeMarkup(key, prefix = 'appearance') {
    const range = spec.ranges[key],
      id = `${prefix}-${ids[key]}`;
    return `<div class="setting-row appearance-range-row"><div><label for="${id}"><strong>${labels[key]}</strong></label><p id="${id}-help">${range.min}–${range.max}${key.includes('Transparency') ? '%' : ' px'} · 默认 ${range.default}${key.includes('Transparency') ? '%' : ' px'}${key.includes('Transparency') ? '；0% 不透明，90% 更通透' : ''}</p></div><div class="appearance-range-control"><input id="${id}" data-appearance-key="${key}" type="range" min="${range.min}" max="${range.max}" step="1" value="${range.default}" aria-describedby="${id}-help ${id}-value"><output id="${id}-value" for="${id}"></output><button type="button" class="subtle-button appearance-reset" data-appearance-reset="${key}" title="恢复默认值" aria-label="恢复默认值">恢复默认</button></div></div>`;
  }
  function markup() {
    return `<div class="setting-row"><div><label for="appearance-text-shadow"><strong>全局字体阴影</strong></label><p id="appearance-text-shadow-help">为文字添加柔和阴影，关闭时也移除重叠区域的旧阴影。</p></div><input id="appearance-text-shadow" data-appearance-key="textShadow" type="checkbox" class="switch" aria-describedby="appearance-text-shadow-help"></div>${Object.keys(
      spec.ranges
    )
      .map((key) => rangeMarkup(key))
      .join('')}`;
  }
  function createController({
    settings,
    save,
    previewDensity = () => {},
    finishDensity = () => {},
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
      for (const input of root.querySelectorAll('[data-appearance-key]')) {
        const key = input.dataset.appearanceKey,
          value = spec.normalize(settings())[key];
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
      if (!spec.valid(key, value) || settings()[key] === value) return;
      settings()[key] = value;
      revisions[key] = (revisions[key] || 0) + 1;
      dirty.set(key, value);
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
      return task;
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
      return merged;
    }
    return { set, flush, mount, sync, snapshot, mergeSummary };
  }
  window.albumAppearance = { apply, markup, rangeMarkup, createController };
})();
