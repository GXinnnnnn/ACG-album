/* Homepage text stays local; edits use the same validated SQLite settings as the UI. */
(() => {
  'use strict';
  const defaults = {
    eyebrow: 'YOUR PERSONAL COLLECTION',
    title: '我的相册',
    description: '把散落的画面，整理成喜欢的世界。'
  };
  const fields = {
    eyebrow: { id: 'eyebrow', label: '首页眉题', limit: 120 },
    title: { id: 'page-title', label: '首页标题', limit: 80 },
    description: { id: 'page-description', label: '首页说明', limit: 240 }
  };
  const entries = new Map(),
    pending = new Map();
  let settings = () => ({}),
    save,
    notify,
    queue = Promise.resolve(),
    serial = 0;
  const values = () => ({ ...defaults, ...settings().homeCopy });
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const singleLine = (value) => value.replace(/[\u0000-\u0020\u007f]+/gu, ' ');
  function widthLimit(entry) {
    const viewport = document.getElementById('viewport'),
      heading = document.getElementById('page-heading'),
      viewportStyle = getComputedStyle(viewport),
      headingStyle = getComputedStyle(heading),
      style = getComputedStyle(entry.field);
    const content =
      viewport.clientWidth -
      parseFloat(viewportStyle.paddingLeft) -
      parseFloat(viewportStyle.paddingRight);
    const available =
      heading.clientWidth -
      parseFloat(headingStyle.paddingLeft) -
      parseFloat(headingStyle.paddingRight) -
      (entry.key === 'title' ? parseFloat(style.fontSize) * 0.8 : 0);
    entry.widthLimit = Math.max(16, Math.floor(Math.min(content / 2, available)));
    entry.field.style.setProperty('--home-copy-width', entry.widthLimit + 'px');
    return entry.widthLimit;
  }
  function fit(entry, constrain = true) {
    const input = entry.input,
      style = getComputedStyle(input),
      context = document.createElement('canvas').getContext('2d');
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.letterSpacing = style.letterSpacing;
    const limit = entry.field.isConnected ? widthLimit(entry) : entry.widthLimit;
    const measure = (text) => context.measureText(text || ' ').width;
    if (constrain) {
      const value = singleLine(input.value),
        segments = [...segmenter.segment(value)].map((part) => part.segment);
      let low = 0,
        high = segments.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2),
          candidate = segments.slice(0, middle).join('');
        if (candidate.length <= entry.limit && measure(candidate) + 12 <= limit) low = middle;
        else high = middle - 1;
      }
      const result = segments.slice(0, low).join('');
      if (input.value !== result) {
        const start = input.selectionStart,
          end = input.selectionEnd;
        input.value = result;
        input.setSelectionRange(Math.min(start, result.length), Math.min(end, result.length));
      }
    }
    entry.field.style.width =
      Math.min(limit, Math.ceil(Math.max(32, measure(input.value) + 12))) + 'px';
  }
  function refreshWidths() {
    for (const entry of entries.values()) {
      widthLimit(entry);
      // A resize only changes presentation; never silently alter existing saved text or a draft.
      if (entry.editing) fit(entry, false);
    }
  }
  const resizeObserver = new ResizeObserver(refreshWidths);
  function display(entry, value) {
    entry.field.replaceChildren();
    const text = document.createElement('span');
    text.className = 'home-copy-text';
    text.textContent = value;
    entry.field.append(text);
    entry.field.style.width = '';
    entry.field.dataset.editing = 'false';
    entry.field.setAttribute('role', 'button');
    entry.field.setAttribute('aria-label', `${entry.label}：${value}，单击编辑`);
    entry.field.tabIndex = 0;
  }
  function finish(entry, cancel = false) {
    if (!entry.editing) return;
    entry.editing = false;
    if (!cancel) fit(entry);
    const text = singleLine(entry.input.value).trim();
    const value = text || defaults[entry.key];
    if (cancel || text.length > entry.limit) {
      display(entry, entry.before);
      if (!cancel) notify(`文字最多 ${entry.limit} 个字符，请缩短后再保存。`, true);
      return;
    }
    display(entry, value);
    entry.field.removeAttribute('aria-invalid');
    if (value === values()[entry.key] && !pending.has(entry.key)) return;
    const operation = { value, serial: ++serial };
    pending.set(entry.key, operation);
    entry.field.dataset.saving = 'true';
    queue = queue
      .catch(() => {})
      .then(async () => {
        try {
          // Merge inside the serialized queue so editing two fields cannot lose either edit.
          await save('homeCopy', { ...values(), [entry.key]: value });
          if (pending.get(entry.key) !== operation) return;
          pending.delete(entry.key);
          const live = entries.get(entry.key);
          if (live?.field.isConnected && !live.editing) {
            display(live, values()[entry.key]);
            live.field.removeAttribute('aria-invalid');
            delete live.field.dataset.saving;
          }
        } catch (error) {
          if (pending.get(entry.key) !== operation) return;
          pending.delete(entry.key);
          const live = entries.get(entry.key);
          if (live?.field.isConnected && !live.editing) {
            delete live.field.dataset.saving;
            live.field.setAttribute('aria-invalid', 'true');
            live.field.title = '保存失败，单击后按回车重试';
          }
          notify(`文案保存失败：${error.message || String(error)}`, true);
        }
      });
  }
  function begin(entry) {
    if (entry.editing) return;
    entry.editing = true;
    entry.before = entry.field.textContent;
    entry.field.removeAttribute('title');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'home-copy-editor';
    input.value = entry.before;
    input.maxLength = entry.limit;
    input.setAttribute('aria-label', `${entry.label}，回车保存，Esc 取消`);
    input.autocomplete = 'off';
    input.spellcheck = false;
    entry.input = input;
    let composing = false;
    entry.field.replaceChildren(input);
    entry.field.dataset.editing = 'true';
    entry.field.removeAttribute('role');
    entry.field.tabIndex = -1;
    fit(entry, false);
    input.addEventListener('compositionstart', () => {
      composing = true;
    });
    input.addEventListener('compositionend', () => {
      composing = false;
      fit(entry);
    });
    input.addEventListener('input', (event) => fit(entry, !composing && !event.isComposing));
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish(entry, event.key === 'Escape');
        if (entry.field.isConnected) entry.field.focus({ preventScroll: true });
      }
    });
    input.addEventListener('blur', () => finish(entry));
    // Keep native text-selection and paste menus instead of the page browse menu.
    input.addEventListener('contextmenu', (event) => event.stopPropagation());
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }
  function render(enabled) {
    // Detached entries may have blurred after navigation; finish before discarding them.
    for (const entry of entries.values()) if (entry.editing) finish(entry);
    entries.clear();
    if (!enabled) return;
    for (const [key, config] of Object.entries(fields)) {
      const host = document.getElementById(config.id);
      const field = document.createElement('span');
      field.className = 'home-copy-field';
      field.dataset.homeCopy = key;
      const entry = { ...config, key, field, editing: false };
      entries.set(key, entry);
      display(entry, pending.get(key)?.value ?? values()[key]);
      field.addEventListener('click', () => begin(entry));
      field.addEventListener('keydown', (event) => {
        if (entry.editing || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        begin(entry);
      });
      host.replaceChildren(field);
      if (key === 'title') {
        const dot = document.createElement('span');
        dot.className = 'heading-dot';
        dot.textContent = '.';
        dot.setAttribute('aria-hidden', 'true');
        host.append(dot);
      }
    }
    refreshWidths();
  }
  window.albumHomeCopy = {
    mount(options) {
      settings = options.settings;
      save = options.save;
      notify = options.notify;
      resizeObserver.observe(document.getElementById('viewport'));
      resizeObserver.observe(document.getElementById('page-heading'));
      document.fonts.addEventListener('loadingdone', refreshWidths);
    },
    render,
    settled: () => queue
  };
})();
