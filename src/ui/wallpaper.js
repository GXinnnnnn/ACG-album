'use strict';
(() => {
  const spec = window.albumWallpaperSpec;
  let settings = { ...spec.defaults },
    getSettings,
    save,
    call,
    notify;
  let entries = [],
    listing,
    mounted,
    ownerDialog,
    layer,
    image,
    shade;
  let generation = 0,
    imageKey = '',
    displayed,
    ready = Promise.resolve();
  let saving = Promise.resolve(),
    galleryTheme = 'light',
    gallerySignature = '',
    importing = false;
  let editor, galleryObserver;
  const pending = new Map(),
    versions = new Map();
  const root = document.documentElement;
  const labels = {
    wallpaperMaskTransparency: '遮罩透明度',
    wallpaperBlurAmount: '磨砂模糊强度'
  };
  const cropLabels = { x: '横向位置', y: '纵向位置', scale: '壁纸大小' };
  const cropDefaults = { x: 50, y: 50, scale: 100 };
  const escape = (text) =>
    String(text).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  const themeKey = (theme) => (theme === 'dark' ? 'wallpaperDark' : 'wallpaperLight');
  const themeName = (theme) => (theme === 'dark' ? '月之暗面' : '月之亮面');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const icon = (name) => {
    const paths = {
      upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
      edit: '<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15Z"/>',
      remove: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>'
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  };
  function effective(value = getSettings?.() || settings) {
    const next = { ...value };
    for (const [key, row] of pending) next[key] = row.value;
    return { ...next, ...spec.normalize(next) };
  }
  function gallery(value, theme) {
    return value.wallpaperGallery[theme];
  }
  function mutateGallery(theme, mutate) {
    // Always compose with the latest optimistic object, including other queued edits.
    const next = effective().wallpaperGallery;
    const copy = {
      version: 1,
      ...Object.fromEntries(
        ['light', 'dark'].map((side) => [
          side,
          {
            hidden: [...next[side].hidden],
            order: [...next[side].order],
            crops: Object.fromEntries(
              Object.entries(next[side].crops).map(([id, crop]) => [id, { ...crop }])
            )
          }
        ])
      )
    };
    mutate(copy[theme]);
    return set('wallpaperGallery', copy);
  }
  function visibleEntries(value, theme) {
    const state = gallery(value, theme),
      hidden = new Set(state.hidden);
    const available = entries.filter((entry) => !hidden.has(entry.id));
    // Builtins stay first; custom entries retain the service's stable createdAt order.
    return [
      ...available.filter((entry) => entry.builtin),
      ...available.filter((entry) => !entry.builtin)
    ];
  }
  function resolved(theme, id, value = settings) {
    const rows = visibleEntries(value, theme);
    return (
      rows.find((entry) => entry.id === id) ||
      rows.find((entry) => entry.id === spec.defaults[themeKey(theme)]) ||
      rows[0]
    );
  }
  function createLayer() {
    if (layer) return;
    layer = document.createElement('div');
    layer.id = 'app-wallpaper';
    layer.setAttribute('aria-hidden', 'true');
    image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    shade = document.createElement('div');
    shade.className = 'wallpaper-shade';
    layer.append(image, shade);
    document.body.prepend(layer);
    layer.hidden = true;
  }
  function fitImage(target, width, height, crop) {
    if (!target?.naturalWidth || !width || !height) return;
    const ratio =
      (Math.max(width / target.naturalWidth, height / target.naturalHeight) * crop.scale) / 100;
    const w = target.naturalWidth * ratio,
      h = target.naturalHeight * ratio;
    Object.assign(target.style, {
      width: w + 'px',
      height: h + 'px',
      left: ((width - w) * crop.x) / 100 + 'px',
      top: ((height - h) * crop.y) / 100 + 'px'
    });
  }
  function layout() {
    if (image?.naturalWidth && !layer.hidden && displayed)
      fitImage(
        image,
        root.clientWidth || innerWidth,
        root.clientHeight || innerHeight,
        spec.cropFor(settings, displayed.theme, displayed.id)
      );
    layoutCards();
    if (editor) layoutEditor();
  }
  async function list() {
    if (!listing)
      listing = call('wallpaperList')
        .then((rows) => {
          entries = rows;
          return rows;
        })
        .catch((error) => {
          listing = null;
          throw error;
        });
    return listing;
  }
  function loadWallpaper(next) {
    const theme = next.theme === 'dark' ? 'dark' : 'light';
    const id = next[themeKey(theme)];
    const key = theme + ':' + id + ':' + gallery(next, theme).hidden.join(',');
    if (imageKey === key) return ready;
    const token = ++generation;
    imageKey = key;
    ready = (async () => {
      await list();
      if (token !== generation || !settings.wallpaperEnabled) return;
      let entry = resolved(theme, id);
      if (!entry) {
        layer.hidden = true;
        root.dataset.wallpaper = 'off';
        return;
      }
      let decoded = new Image();
      decoded.src = entry.url;
      try {
        await decoded.decode();
      } catch (error) {
        const fallback = resolved(theme, spec.defaults[themeKey(theme)]);
        if (!fallback || fallback.id === entry.id) throw error;
        entry = fallback;
        decoded = new Image();
        decoded.src = entry.url;
        await decoded.decode();
      }
      if (token !== generation || !settings.wallpaperEnabled) return;
      image.replaceWith(decoded);
      image = decoded;
      image.alt = '';
      image.draggable = false;
      displayed = { theme, id: entry.id };
      layer.hidden = false;
      root.dataset.wallpaper = 'on';
      layout();
      window.albumLiquidGlass?.refresh?.();
    })().catch((error) => {
      if (token !== generation) return;
      imageKey = '';
      layer.hidden = true;
      root.dataset.wallpaper = 'off';
      notify?.('壁纸暂不可用，已恢复纯色背景：' + (error.message || error), true);
    });
    return ready;
  }
  function apply(value) {
    const previous = settings;
    settings = effective(value);
    const sceneChanged = ['theme', ...Object.keys(spec.defaults)].some((key) =>
      key === 'wallpaperGallery'
        ? JSON.stringify(previous[key]) !== JSON.stringify(settings[key])
        : previous[key] !== settings[key]
    );
    createLayer();
    shade.hidden = !settings.wallpaperMask;
    shade.style.background = `color-mix(in srgb, var(--bg) ${100 - settings.wallpaperMaskTransparency}%, transparent)`;
    shade.style.backdropFilter =
      settings.wallpaperMask && settings.wallpaperBlur
        ? `blur(${settings.wallpaperBlurAmount}px)`
        : 'none';
    if (!settings.wallpaperEnabled) {
      ++generation;
      imageKey = '';
      image.removeAttribute('src');
      displayed = null;
      layer.hidden = true;
      root.dataset.wallpaper = 'off';
      ready = Promise.resolve();
    } else void loadWallpaper(settings);
    layout();
    if (sceneChanged) window.albumLiquidGlass?.refresh?.();
    sync();
    return ready;
  }
  function snapshot() {
    const result = new Map(versions);
    // A summary begun during an in-flight write can finish after pending is cleared.
    for (const [key, row] of pending) result.set(key, row.version - 0.5);
    return result;
  }
  function mergeSummary(value, atRead) {
    const next = { ...value };
    for (const [key, version] of versions)
      if (atRead?.get(key) !== version || pending.has(key))
        next[key] = pending.get(key)?.value ?? settings[key];
    return next;
  }
  function set(key, value) {
    if (!spec.valid(key, value)) return Promise.resolve(false);
    const version = (versions.get(key) || 0) + 1;
    versions.set(key, version);
    pending.set(key, { value, version });
    apply(getSettings?.() || settings);
    const work = saving.then(async () => {
      if (pending.get(key)?.version !== version) return true;
      let saved = false;
      try {
        await save(key, value);
        saved = true;
      } catch (error) {
        notify?.('壁纸设置未保存：' + (error.message || error), true);
      } finally {
        if (pending.get(key)?.version === version) pending.delete(key);
        apply(getSettings?.() || settings);
      }
      return saved;
    });
    saving = work.catch(() => {});
    return work;
  }
  function range(key, min, max) {
    const help = key === 'wallpaperBlurAmount' ? '调整背景柔化程度。' : '0% 不透明，100% 完全透明';
    return `<div class="setting-row appearance-range-row wallpaper-range-row"><div><label for="${key}"><strong>${labels[key]}</strong></label><p id="${key}-help">${help}</p></div><div class="appearance-range-control"><input id="${key}" type="range" min="${min}" max="${max}" step="1" data-wallpaper-key="${key}" aria-describedby="${key}-help ${key}-value"><output id="${key}-value" for="${key}" data-wallpaper-output="${key}"></output><button type="button" class="subtle-button appearance-reset" data-wallpaper-reset="${key}" aria-label="恢复${labels[key]}默认值">恢复默认</button></div></div>`;
  }
  function markup() {
    return `<section class="wallpaper-settings" aria-labelledby="wallpaper-heading"><h3 id="wallpaper-heading">软件壁纸</h3><div class="setting-row"><div><label for="wallpaperEnabled"><strong>开启全局壁纸</strong></label><p>开启后显示当前主题的壁纸，关闭时仍可管理图库。</p></div><input id="wallpaperEnabled" class="switch" type="checkbox" data-wallpaper-key="wallpaperEnabled"></div><div class="wallpaper-gallery-tabs" role="tablist" aria-label="管理壁纸主题"><button id="wallpaper-tab-light" type="button" role="tab" data-wallpaper-theme="light" aria-controls="wallpaper-gallery">月之亮面</button><button id="wallpaper-tab-dark" type="button" role="tab" data-wallpaper-theme="dark" aria-controls="wallpaper-gallery">月之暗面</button></div><div id="wallpaper-gallery" role="tabpanel" aria-labelledby="wallpaper-tab-light"><div class="wallpaper-gallery-toolbar"><p class="wallpaper-gallery-help">分别记住两种主题的壁纸与构图，浏览图库不会切换软件主题。</p><button id="wallpaper-restore" class="subtle-button" type="button" hidden>恢复已移除</button></div><div class="wallpaper-grid"></div></div><div class="wallpaper-options"><div class="setting-row"><div><label for="wallpaperMask"><strong>背景遮罩</strong></label><p>使用当前主题的柔和底色，帮助文字保持清晰。</p></div><input id="wallpaperMask" type="checkbox" class="switch" data-wallpaper-key="wallpaperMask"></div>${range('wallpaperMaskTransparency', 0, 100)}<div class="setting-row"><div><label for="wallpaperBlur"><strong>磨砂滤镜</strong></label><p class="wallpaper-performance">模糊背景遮罩；低配置设备可关闭。</p></div><input id="wallpaperBlur" type="checkbox" class="switch" data-wallpaper-key="wallpaperBlur"></div>${range('wallpaperBlurAmount', 0, 40)}</div><p class="wallpaper-status" role="status" aria-live="polite" aria-atomic="true"></p></section>`;
  }
  function layoutCards() {
    if (!mounted?.isConnected) return;
    const value = effective();
    for (const preview of mounted.querySelectorAll('[data-wallpaper-preview]')) {
      const art = preview.parentElement;
      fitImage(
        preview,
        art.clientWidth,
        art.clientHeight,
        spec.cropFor(value, galleryTheme, preview.dataset.wallpaperPreview)
      );
    }
  }
  function renderGallery(next) {
    const grid = mounted.querySelector('.wallpaper-grid');
    const rows = visibleEntries(next, galleryTheme);
    const signature = JSON.stringify([
      galleryTheme,
      rows.map((entry) => [entry.id, entry.name, entry.thumbnailUrl || entry.url])
    ]);
    if (signature !== gallerySignature) {
      gallerySignature = signature;
      grid.innerHTML =
        `<button id="wallpaper-import" type="button" class="wallpaper-upload" aria-label="为${themeName(galleryTheme)}上传壁纸">${icon('upload')}<strong>上传壁纸</strong><span>添加到${themeName(galleryTheme)}</span></button>` +
        rows
          .map((entry) => {
            const id = escape(entry.id),
              name = escape(entry.name);
            return `<article class="wallpaper-card" data-wallpaper-card="${id}"><button type="button" class="wallpaper-card-select" data-wallpaper-select="${id}" aria-label="选择${name}" aria-pressed="false"><span class="wallpaper-card-art"><img src="${escape(entry.thumbnailUrl || entry.url)}" alt="" loading="lazy" decoding="async" draggable="false" data-wallpaper-preview="${id}"><span class="wallpaper-selected-mark">${icon('check')}<span>已选择</span></span></span><span class="wallpaper-card-name" title="${name}">${name}</span></button><div class="wallpaper-card-actions"><button type="button" data-wallpaper-edit="${id}" aria-label="编辑${name}的构图" title="编辑构图">${icon('edit')}</button><button type="button" data-wallpaper-remove="${id}" aria-label="从${themeName(galleryTheme)}移除${name}" title="从此主题移除">${icon('remove')}</button></div></article>`;
          })
          .join('');
      for (const preview of grid.querySelectorAll('[data-wallpaper-preview]'))
        preview.addEventListener('load', layoutCards);
    }
    for (const button of mounted.querySelectorAll('[data-wallpaper-select]')) {
      const selected = button.dataset.wallpaperSelect === next[themeKey(galleryTheme)];
      button.setAttribute('aria-pressed', String(selected));
      button.parentElement.classList.toggle('is-selected', selected);
    }
    const upload = mounted.querySelector('#wallpaper-import');
    upload.disabled = importing;
    upload.setAttribute('aria-busy', String(importing));
    const restore = mounted.querySelector('#wallpaper-restore'),
      count = gallery(next, galleryTheme).hidden.length;
    restore.hidden = !count;
    restore.textContent = `恢复已移除（${count}）`;
    layoutCards();
  }
  function sync() {
    if (!mounted?.isConnected) return;
    const next = effective();
    for (const input of mounted.querySelectorAll('[data-wallpaper-key]')) {
      const key = input.dataset.wallpaperKey;
      if (input.type === 'checkbox') input.checked = next[key];
      else {
        input.value = String(next[key]);
        input.setAttribute(
          'aria-valuetext',
          next[key] + (key === 'wallpaperBlurAmount' ? ' 像素' : '%')
        );
      }
      input.disabled =
        (key === 'wallpaperMaskTransparency' && !next.wallpaperMask) ||
        (key === 'wallpaperBlurAmount' && (!next.wallpaperMask || !next.wallpaperBlur)) ||
        (key === 'wallpaperBlur' && !next.wallpaperMask);
    }
    for (const button of mounted.querySelectorAll('[data-wallpaper-reset]'))
      button.disabled = mounted.querySelector('#' + button.dataset.wallpaperReset).disabled;
    for (const output of mounted.querySelectorAll('[data-wallpaper-output]'))
      output.value =
        next[output.dataset.wallpaperOutput] +
        (output.dataset.wallpaperOutput === 'wallpaperBlurAmount' ? ' px' : '%');
    for (const tab of mounted.querySelectorAll('[data-wallpaper-theme]')) {
      const selected = tab.dataset.wallpaperTheme === galleryTheme;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    mounted
      .querySelector('#wallpaper-gallery')
      .setAttribute('aria-labelledby', 'wallpaper-tab-' + galleryTheme);
    renderGallery(next);
  }
  function status(message) {
    if (mounted?.isConnected) mounted.querySelector('.wallpaper-status').textContent = message;
  }
  async function refreshOptions() {
    const target = mounted;
    await list();
    if (target !== mounted || !mounted?.isConnected) return;
    sync();
  }
  function switchGallery(theme, focus = false) {
    galleryTheme = theme;
    sync();
    if (focus) mounted.querySelector('#wallpaper-tab-' + theme).focus();
  }
  async function importWallpaper() {
    if (importing) return;
    const theme = galleryTheme;
    importing = true;
    sync();
    status('正在选择或导入壁纸…');
    try {
      const entry = await call('wallpaperImport');
      if (!entry) {
        status('已取消上传');
        return;
      }
      listing = null;
      await refreshOptions();
      const gallerySaved = await mutateGallery(theme, (state) => {
        state.hidden = state.hidden.filter((id) => id !== entry.id);
        if (!entry.builtin && !state.order.includes(entry.id)) state.order.push(entry.id);
      });
      if (!gallerySaved) {
        status('壁纸已导入，图库设置未保存，请重试。');
        return;
      }
      const saved = await set(themeKey(theme), entry.id);
      if (saved) {
        status(`已添加到${themeName(theme)}`);
        notify?.('自定义壁纸已添加');
      }
    } catch (error) {
      status('上传失败，可重试');
      notify?.('壁纸未导入：' + (error.message || error), true);
    } finally {
      importing = false;
      sync();
    }
  }
  async function removeWallpaper(id) {
    const theme = galleryTheme;
    const work = mutateGallery(theme, (state) => {
      if (!state.hidden.includes(id)) state.hidden.push(id);
    });
    const next = effective(),
      fallback = resolved(theme, '', next);
    const saved = await work;
    if (!saved) {
      status('壁纸未移除，请重试。');
      return;
    }
    // Keep gallery+selection writes in order; do not overwrite a newer selection.
    if (next[themeKey(theme)] === id && fallback && effective()[themeKey(theme)] === id)
      await set(themeKey(theme), fallback.id);
    status(`已从${themeName(theme)}移除，可使用“恢复已移除”找回`);
    if (galleryTheme === theme) mounted?.querySelector('#wallpaper-restore')?.focus();
  }
  function cropRange(key) {
    const max = key === 'scale' ? 300 : 100,
      min = key === 'scale' ? 50 : 0;
    const id = 'wallpaper-crop-' + key;
    return `<div class="setting-row appearance-range-row wallpaper-range-row"><div><label for="${id}"><strong>${cropLabels[key]}</strong></label><p id="${id}-help">${key === 'scale' ? '放大或缩小画面。' : key === 'x' ? '左右移动画面。' : '上下移动画面。'}</p></div><div class="appearance-range-control"><input id="${id}" type="range" min="${min}" max="${max}" step="1" data-wallpaper-crop="${key}" aria-describedby="${id}-help ${id}-value"><output id="${id}-value" for="${id}"></output><button class="subtle-button appearance-reset" type="button" data-wallpaper-crop-reset="${key}" aria-label="恢复${cropLabels[key]}默认值">恢复默认</button></div></div>`;
  }
  function layoutEditor() {
    if (!editor) return;
    const { dialog, preview, img, crop } = editor;
    preview.style.setProperty(
      '--wallpaper-preview-ratio',
      String((root.clientWidth || 1600) / (root.clientHeight || 1000))
    );
    fitImage(img, preview.clientWidth, preview.clientHeight, crop);
    for (const input of dialog.querySelectorAll('[data-wallpaper-crop]')) {
      const key = input.dataset.wallpaperCrop;
      input.value = String(crop[key]);
      input.setAttribute('aria-valuetext', crop[key] + '%');
      dialog.querySelector('#' + input.id + '-value').value = crop[key] + '%';
    }
  }
  function closeEditor() {
    if (!editor) return;
    const { dialog, trigger } = editor;
    editor = null;
    if (dialog.open) dialog.close();
    dialog.remove();
    if (trigger?.isConnected && ownerDialog?.open) trigger.focus();
    window.albumLiquidGlass?.refresh?.();
  }
  function openEditor(id, trigger) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return;
    closeEditor();
    const theme = galleryTheme,
      dialog = document.createElement('dialog');
    dialog.id = 'wallpaper-editor';
    dialog.className = 'modal wallpaper-editor';
    dialog.dataset.wallpaperTheme = theme;
    dialog.setAttribute('aria-labelledby', 'wallpaper-editor-title');
    dialog.innerHTML = `<div class="modal-top"><div><p class="wallpaper-editor-theme">${themeName(theme)} · ${escape(entry.name)}</p><h2 id="wallpaper-editor-title">编辑壁纸构图</h2></div><button type="button" class="wallpaper-editor-close" id="wallpaper-crop-close" aria-label="取消编辑">${icon('close')}</button></div><div id="wallpaper-crop-preview" class="wallpaper-crop-preview" tabindex="0" role="group" aria-label="壁纸构图预览，方向键移动，Shift 加快移动" aria-describedby="wallpaper-crop-help"><img alt="" draggable="false"></div><p id="wallpaper-crop-help">拖动图片调整位置，或使用方向键与下方滑块。仅保存此主题、此张壁纸的构图。</p><div class="wallpaper-crop-ranges">${['x', 'y', 'scale'].map(cropRange).join('')}</div><p id="wallpaper-crop-status" role="status" aria-live="polite"></p><div class="modal-actions"><button id="wallpaper-crop-cancel" type="button" class="subtle-button">取消</button><button id="wallpaper-crop-save" type="button" class="wallpaper-save-button">保存构图</button></div>`;
    document.body.append(dialog);
    const preview = dialog.querySelector('#wallpaper-crop-preview'),
      img = preview.querySelector('img');
    editor = {
      dialog,
      preview,
      img,
      theme,
      id,
      trigger,
      crop: { ...spec.cropFor(effective(), theme, id) }
    };
    // Use the full source only for the active editor; gallery cards use thumbnails.
    img.src = entry.url;
    img.addEventListener('load', layoutEditor);
    img.addEventListener('error', () => {
      if (editor?.dialog === dialog)
        dialog.querySelector('#wallpaper-crop-status').textContent = '预览加载失败，请取消后重试。';
    });
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeEditor();
    });
    dialog.addEventListener('close', () => {
      if (editor?.dialog === dialog) closeEditor();
    });
    dialog.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') event.stopPropagation();
    });
    dialog.addEventListener('input', (event) => {
      const key = event.target.dataset.wallpaperCrop;
      if (!key || editor?.dialog !== dialog) return;
      editor.crop[key] = clamp(
        Number(event.target.value),
        key === 'scale' ? 50 : 0,
        key === 'scale' ? 300 : 100
      );
      layoutEditor();
    });
    dialog.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || editor?.dialog !== dialog) return;
      const key = button.dataset.wallpaperCropReset;
      if (key) {
        editor.crop[key] = cropDefaults[key];
        layoutEditor();
      } else if (['wallpaper-crop-cancel', 'wallpaper-crop-close'].includes(button.id))
        closeEditor();
      else if (button.id === 'wallpaper-crop-save') void saveCrop();
    });
    let drag;
    preview.addEventListener('pointerdown', (event) => {
      if (
        event.button !== 0 ||
        editor?.dialog !== dialog ||
        !img.naturalWidth ||
        !img.naturalHeight
      )
        return;
      preview.focus();
      const rect = preview.getBoundingClientRect();
      const ratio =
        (Math.max(rect.width / img.naturalWidth, rect.height / img.naturalHeight) *
          editor.crop.scale) /
        100;
      drag = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        crop: { ...editor.crop },
        dx: rect.width - img.naturalWidth * ratio,
        dy: rect.height - img.naturalHeight * ratio
      };
      preview.setPointerCapture(event.pointerId);
      preview.classList.add('is-dragging');
      event.preventDefault();
    });
    preview.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointer !== event.pointerId || editor?.dialog !== dialog) return;
      for (const [key, delta, span] of [
        ['x', event.clientX - drag.x, drag.dx],
        ['y', event.clientY - drag.y, drag.dy]
      ])
        if (Math.abs(span) > 0.1)
          editor.crop[key] = Math.round(clamp(drag.crop[key] + (delta / span) * 100, 0, 100));
      layoutEditor();
    });
    const endDrag = () => {
      drag = null;
      preview.classList.remove('is-dragging');
    };
    preview.addEventListener('pointerup', endDrag);
    preview.addEventListener('pointercancel', endDrag);
    preview.addEventListener('lostpointercapture', endDrag);
    preview.addEventListener('keydown', (event) => {
      if (editor?.dialog !== dialog) return;
      const key = ['ArrowLeft', 'ArrowRight'].includes(event.key)
        ? 'x'
        : ['ArrowUp', 'ArrowDown'].includes(event.key)
          ? 'y'
          : null;
      if (!key) return;
      event.preventDefault();
      const delta =
        (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) * (event.shiftKey ? 10 : 1);
      editor.crop[key] = clamp(editor.crop[key] + delta, 0, 100);
      layoutEditor();
    });
    dialog.showModal();
    layoutEditor();
    window.albumLiquidGlass?.refresh?.();
    preview.focus();
  }
  async function saveCrop() {
    const current = editor;
    if (!current || current.saving) return;
    current.saving = true;
    const button = current.dialog.querySelector('#wallpaper-crop-save');
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    const crop = { ...current.crop };
    const saved = await mutateGallery(current.theme, (state) => {
      state.crops[current.id] = crop;
    });
    if (editor !== current) return;
    if (saved) {
      closeEditor();
      status(`已保存${themeName(current.theme)}的壁纸构图`);
    } else {
      current.saving = false;
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      current.dialog.querySelector('#wallpaper-crop-status').textContent = '构图未保存，请重试。';
    }
  }
  function mount(container) {
    closeEditor();
    ownerDialog?.removeEventListener('close', closeEditor);
    galleryObserver?.disconnect();
    mounted = container.querySelector('.wallpaper-settings');
    if (!mounted) return;
    ownerDialog = mounted.closest('dialog');
    ownerDialog?.addEventListener('close', closeEditor);
    galleryTheme = effective().theme === 'dark' ? 'dark' : 'light';
    gallerySignature = '';
    sync();
    if (typeof ResizeObserver === 'function') {
      galleryObserver = new ResizeObserver(layoutCards);
      galleryObserver.observe(mounted.querySelector('.wallpaper-grid'));
    }
    const target = mounted;
    status('正在读取壁纸…');
    void refreshOptions()
      .then(() => {
        if (target === mounted) status('');
      })
      .catch((error) => {
        if (target !== mounted) return;
        status('壁纸列表读取失败，请重新打开壁纸设置重试。');
        notify?.('壁纸列表读取失败：' + error.message, true);
      });
    mounted.addEventListener('input', (event) => {
      const input = event.target,
        key = input.dataset.wallpaperKey;
      if (key && input.type === 'range') void set(key, Number(input.value));
    });
    mounted.addEventListener('change', (event) => {
      const input = event.target,
        key = input.dataset.wallpaperKey;
      if (key && input.type !== 'range')
        void set(key, input.type === 'checkbox' ? input.checked : input.value);
    });
    mounted.addEventListener('keydown', (event) => {
      if (
        !event.target.dataset.wallpaperTheme ||
        !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
      )
        return;
      event.preventDefault();
      switchGallery(
        event.key === 'Home'
          ? 'light'
          : event.key === 'End'
            ? 'dark'
            : galleryTheme === 'light'
              ? 'dark'
              : 'light',
        true
      );
    });
    mounted.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button || !mounted.contains(button)) return;
      const data = button.dataset;
      if (data.wallpaperTheme) switchGallery(data.wallpaperTheme);
      else if (data.wallpaperSelect) {
        const theme = galleryTheme;
        void set(themeKey(theme), data.wallpaperSelect).then((saved) => {
          if (saved) status(`已选择${themeName(theme)}壁纸`);
        });
      } else if (data.wallpaperEdit) openEditor(data.wallpaperEdit, button);
      else if (data.wallpaperRemove) void removeWallpaper(data.wallpaperRemove);
      else if (data.wallpaperReset)
        void set(data.wallpaperReset, spec.defaults[data.wallpaperReset]);
      else if (button.id === 'wallpaper-import') void importWallpaper();
      else if (button.id === 'wallpaper-restore') {
        const theme = galleryTheme;
        void mutateGallery(theme, (state) => {
          state.hidden = [];
        }).then((saved) => {
          if (saved) status(`已恢复${themeName(theme)}移除的壁纸`);
        });
      }
    });
  }
  function configure(options) {
    ({ getSettings, save, call, notify } = options);
  }
  window.addEventListener('resize', layout, { passive: true });
  window.albumWallpaper = {
    configure,
    apply,
    markup,
    mount,
    ready: () => ready,
    snapshot,
    mergeSummary,
    flush: () => saving
  };
})();
