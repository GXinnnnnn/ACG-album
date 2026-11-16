'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const customId = 'custom-' + 'a'.repeat(64);
const source = (file) => fs.readFileSync(path.join(__dirname, '../', file), 'utf8');

// A small DOM fixture runs the public controller and delegated events without
// launching Electron, touching personal data, or introducing a DOM dependency.
function fixture(overrides = {}) {
  let active;
  const decodeText = (text) =>
    text.replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[key]
    );
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toLowerCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {
        setProperty(key, value) {
          this[key] = value;
        }
      };
      this.listeners = new Map();
      this.naturalWidth = 200;
      this.naturalHeight = 100;
      this.clientWidth = 640;
      this.clientHeight = 400;
      this.className = '';
      this.value = '';
      this.classList = {
        toggle: (name, force) => {
          const classes = new Set(this.className.split(/\s+/).filter(Boolean));
          if (force === true || (force === undefined && !classes.has(name))) classes.add(name);
          else classes.delete(name);
          this.className = [...classes].join(' ');
        },
        add: (name) => this.classList.toggle(name, true),
        remove: (name) => this.classList.toggle(name, false)
      };
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith('data-'))
        this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
      else if (name === 'class') this.className = value;
      else if (name === 'hidden') this.hidden = true;
      else if (name === 'disabled') this.disabled = true;
      else this[name === 'tabindex' ? 'tabIndex' : name] = value;
    }
    getAttribute(name) {
      return this.attributes[name] ?? null;
    }
    removeAttribute(name) {
      delete this.attributes[name];
      delete this[name];
    }
    get parentElement() {
      return this.parent;
    }
    get isConnected() {
      return this === body || !!this.parent?.isConnected;
    }
    append(...children) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    prepend(child) {
      child.parent = this;
      this.children.unshift(child);
    }
    replaceWith(child) {
      this.parent.children[this.parent.children.indexOf(this)] = child;
      child.parent = this.parent;
      this.parent = null;
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    contains(child) {
      return child === this || this.children.some((row) => row.contains(child));
    }
    matches(selector) {
      if (selector[0] === '#') return this.id === selector.slice(1);
      if (selector[0] === '.') return this.className.split(/\s+/).includes(selector.slice(1));
      if (selector[0] === '[') {
        const match = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(selector);
        return (
          !!match &&
          Object.hasOwn(this.attributes, match[1]) &&
          (match[2] === undefined || this.attributes[match[1]] === match[2])
        );
      }
      return this.tagName === selector;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector) || null;
    }
    addEventListener(type, handler) {
      const list = this.listeners.get(type) || [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    removeEventListener(type, handler) {
      this.listeners.set(
        type,
        (this.listeners.get(type) || []).filter((row) => row !== handler)
      );
    }
    dispatch(type, detail = {}) {
      const event = {
        type,
        target: this,
        button: 0,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {
          this.stopped = true;
        },
        ...detail
      };
      for (
        let node = this;
        node;
        node = ['close', 'cancel', 'load', 'error'].includes(type) ? null : node.parent
      ) {
        event.currentTarget = node;
        for (const handler of [...(node.listeners.get(type) || [])]) handler(event);
        if (event.stopped) break;
      }
      return event;
    }
    focus() {
      active = this;
    }
    setPointerCapture() {}
    getBoundingClientRect() {
      return { width: this.clientWidth, height: this.clientHeight };
    }
    decode() {
      return Promise.resolve();
    }
    showModal() {
      this.open = true;
    }
    close() {
      this.open = false;
      this.dispatch('close');
    }
    set innerHTML(html) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      const stack = [this];
      for (const token of html.match(/<[^>]*>|[^<]+/g) || []) {
        if (token.startsWith('</')) {
          stack.pop();
          continue;
        }
        if (!token.startsWith('<')) continue;
        const tag = /^<([\w-]+)/.exec(token)?.[1];
        if (!tag) continue;
        const child = new Element(tag);
        for (const match of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g))
          child.setAttribute(match[1], decodeText(match[2] || ''));
        stack.at(-1).append(child);
        if (!['input', 'img', 'br', 'hr', 'path'].includes(tag) && !token.endsWith('/>'))
          stack.push(child);
      }
    }
  }
  const body = new Element('body'),
    root = new Element('html');
  root.clientWidth = 1600;
  root.clientHeight = 1000;
  const observers = [];
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
    disconnect() {
      this.target = null;
    }
  }
  const window = { addEventListener() {}, albumLiquidGlass: { refresh() {} } };
  const context = vm.createContext({
    window,
    Image: class extends Element {
      constructor() {
        super('img');
      }
    },
    document: { documentElement: root, body, createElement: (tag) => new Element(tag) },
    ResizeObserver
  });
  vm.runInContext(source('src/wallpaper-settings.cjs'), context);
  vm.runInContext(source('src/ui/wallpaper.js'), context);
  const spec = window.albumWallpaperSpec,
    api = window.albumWallpaper;
  const current = vm.runInContext(
    `({theme:'light', ...window.albumWallpaperSpec.defaults, ...${JSON.stringify(overrides)}})`,
    context
  );
  current.wallpaperGallery = spec.normalize(current).wallpaperGallery;
  const rows = spec.builtinIds.map((id, index) => ({
    id,
    name: `壁纸0${index + 1}`,
    builtin: true,
    url: 'acg-image://wallpaper/' + id,
    thumbnailUrl: 'acg-image://wallpaper-thumb/' + id
  }));
  rows.push({
    id: customId,
    name: '自定义01',
    builtin: false,
    url: 'acg-image://wallpaper/' + customId,
    thumbnailUrl: 'acg-image://wallpaper-thumb/' + customId
  });
  const saves = [],
    calls = [],
    errors = [];
  const f = {
    api,
    spec,
    current,
    body,
    root,
    saves,
    calls,
    errors,
    rows,
    observers,
    get active() {
      return active;
    }
  };
  api.configure({
    getSettings: () => current,
    save: async (key, value) => {
      saves.push({ key, value: plain(value) });
      await f.saveHook?.(key, value);
      current[key] = value;
    },
    call: async (name) => {
      calls.push(name);
      return name === 'wallpaperList' ? rows : f.importHook?.();
    },
    notify: (message, error) => errors.push({ message, error })
  });
  api.apply(current);
  const owner = new Element('dialog');
  owner.open = true;
  owner.innerHTML = api.markup();
  body.append(owner);
  api.mount(owner);
  f.owner = owner;
  f.find = (selector) => body.querySelector(selector);
  f.click = (selector) => {
    const target = f.find(selector);
    assert.ok(target, selector);
    target.dispatch('click');
  };
  f.input = (selector, value) => {
    const target = f.find(selector);
    target.value = String(value);
    target.dispatch('input');
  };
  f.settle = async () => {
    await tick();
    await api.flush();
    await tick();
  };
  return f;
}

test('gallery keeps three columns, upload first, thumbnail cards and management while OFF', async () => {
  const f = fixture();
  await f.settle();
  const grid = f.find('.wallpaper-grid');
  assert.equal(grid.children[0].id, 'wallpaper-import');
  assert.equal(grid.children.length, 9);
  assert.equal(f.find('#wallpaper-import').disabled, false);
  assert.equal(
    f.find('[data-wallpaper-preview]').src.startsWith('acg-image://wallpaper-thumb/'),
    true
  );
  const css = source('src/ui/wallpaper.css');
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.wallpaper-card:focus-within \.wallpaper-card-actions/);
  assert.equal(f.find('#wallpaperBlurAmount').min, '0');
  assert.equal(f.find('#wallpaperBlurAmount').max, '40');
  assert.equal(f.find('#wallpaperBlurAmount').value, '14');
  assert.ok(f.observers.some((observer) => observer.target === grid));
});

test('gallery tabs and selection are independent of the app theme and remember each side', async () => {
  const f = fixture();
  await f.settle();
  const light = f.current.wallpaperLight;
  f.click('#wallpaper-tab-dark');
  f.click(`[data-wallpaper-select="${f.spec.builtinIds[1]}"]`);
  await f.settle();
  assert.equal(f.current.theme, 'light');
  assert.equal(f.current.wallpaperLight, light);
  assert.equal(f.current.wallpaperDark, f.spec.builtinIds[1]);
  assert.equal(f.find('#wallpaper-tab-dark').getAttribute('aria-selected'), 'true');
  f.click('#wallpaper-tab-light');
  assert.equal(f.find(`[data-wallpaper-select="${light}"]`).getAttribute('aria-pressed'), 'true');
  const key = f.find('#wallpaper-tab-light').dispatch('keydown', { key: 'End' });
  assert.equal(key.defaultPrevented, true);
  assert.equal(f.active.id, 'wallpaper-tab-dark');
  assert.ok(f.saves.every((entry) => entry.key !== 'theme'));
});

test('removal and restore touch only one theme; originals and per-image crops are retained', async () => {
  const f = fixture();
  await f.settle();
  const id = f.spec.builtinIds[0];
  f.click(`[data-wallpaper-edit="${id}"]`);
  f.input('#wallpaper-crop-x', 22);
  f.click('#wallpaper-crop-save');
  await f.settle();
  f.click(`[data-wallpaper-remove="${id}"]`);
  await f.settle();
  assert.deepEqual(plain(f.current.wallpaperGallery.light.hidden), [id]);
  assert.deepEqual(plain(f.current.wallpaperGallery.dark.hidden), []);
  assert.equal(f.current.wallpaperGallery.light.crops[id].x, 22);
  assert.equal(f.find(`[data-wallpaper-select="${id}"]`), null);
  f.click('#wallpaper-tab-dark');
  assert.ok(f.find(`[data-wallpaper-select="${id}"]`));
  f.click('#wallpaper-tab-light');
  f.click('#wallpaper-restore');
  await f.settle();
  assert.ok(f.find(`[data-wallpaper-select="${id}"]`));
  assert.equal(f.current.wallpaperGallery.light.crops[id].x, 22);
  assert.ok(f.calls.every((call) => call === 'wallpaperList'));
});

test('crop editor cancels drafts and saves only its captured theme and image; owner stays open', async () => {
  const f = fixture({ wallpaperPositionX: 34, wallpaperScale: 120 });
  await f.settle();
  const id = f.spec.builtinIds[0];
  f.click('#wallpaper-tab-dark');
  f.click(`[data-wallpaper-edit="${id}"]`);
  assert.equal(f.find('#wallpaper-crop-x').value, '34');
  assert.equal(f.find('#wallpaper-crop-scale').value, '120');
  f.input('#wallpaper-crop-x', 88);
  f.click('#wallpaper-crop-cancel');
  await f.settle();
  assert.equal(f.saves.length, 0);
  assert.equal(f.find('#wallpaper-editor'), null);
  assert.equal(f.owner.open, true);
  f.click(`[data-wallpaper-edit="${id}"]`);
  f.input('#wallpaper-crop-scale', 170);
  f.find('#wallpaper-crop-preview').dispatch('keydown', { key: 'ArrowRight', shiftKey: true });
  f.click('#wallpaper-crop-save');
  await f.settle();
  assert.deepEqual(plain(f.current.wallpaperGallery.dark.crops[id]), { x: 44, y: 50, scale: 170 });
  assert.deepEqual(plain(f.current.wallpaperGallery.light.crops), {});
  assert.equal(f.current.wallpaperPositionX, 34);
  assert.equal(f.current.wallpaperScale, 120);
  assert.equal(f.owner.open, true);
  assert.equal(f.active.dataset.wallpaperEdit, id);
  f.click(`[data-wallpaper-edit="${id}"]`);
  f.owner.close();
  assert.equal(f.find('#wallpaper-editor'), null);
});

test('crop preview drag and keyboard paths clamp, reset, and Escape discards without closing preferences', async () => {
  const f = fixture();
  await f.settle();
  f.click(`[data-wallpaper-edit="${f.spec.builtinIds[0]}"]`);
  f.input('#wallpaper-crop-scale', 200);
  const preview = f.find('#wallpaper-crop-preview');
  preview.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  preview.dispatch('pointermove', { pointerId: 1, clientX: 10000, clientY: -10000 });
  preview.dispatch('pointerup', { pointerId: 1 });
  assert.equal(f.find('#wallpaper-crop-x').value, '0');
  assert.equal(f.find('#wallpaper-crop-y').value, '100');
  f.click('[data-wallpaper-crop-reset="x"]');
  assert.equal(f.find('#wallpaper-crop-x').value, '50');
  const event = f.find('#wallpaper-editor').dispatch('cancel');
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.find('#wallpaper-editor'), null);
  assert.equal(f.owner.open, true);
  assert.equal(f.saves.length, 0);
});

test('queued whole-object edits compose both themes and protect summaries begun in flight', async () => {
  const f = fixture();
  await f.settle();
  let release;
  f.saveHook = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  f.click(`[data-wallpaper-remove="${f.spec.builtinIds[0]}"]`);
  await tick();
  const reading = f.api.snapshot(),
    stale = plain(f.current);
  f.click('#wallpaper-tab-dark');
  f.click(`[data-wallpaper-remove="${f.spec.builtinIds[1]}"]`);
  f.saveHook = undefined;
  release();
  await f.settle();
  assert.deepEqual(plain(f.current.wallpaperGallery.light.hidden), [f.spec.builtinIds[0]]);
  assert.deepEqual(plain(f.current.wallpaperGallery.dark.hidden), [f.spec.builtinIds[1]]);
  assert.deepEqual(
    plain(f.api.mergeSummary(stale, reading).wallpaperGallery),
    plain(f.current.wallpaperGallery)
  );
  assert.ok(f.saves.every((row) => f.spec.valid(row.key, f.current[row.key])));
});

test('import keeps click-time theme after tab changes and restores duplicate hidden entries', async () => {
  const f = fixture();
  await f.settle();
  f.click(`[data-wallpaper-remove="${customId}"]`);
  await f.settle();
  let finish;
  f.importHook = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  f.click('#wallpaper-import');
  f.click('#wallpaper-tab-dark');
  finish(f.rows.at(-1));
  await f.settle();
  assert.equal(f.current.wallpaperLight, customId);
  assert.equal(f.current.wallpaperDark, f.spec.defaults.wallpaperDark);
  assert.equal(f.current.theme, 'light');
  assert.deepEqual(plain(f.current.wallpaperGallery.light.hidden), []);
  assert.deepEqual(plain(f.current.wallpaperGallery.light.order), [customId]);
  assert.equal(f.find('#wallpaper-import').disabled, false);
});

test('failed crop saves roll back persisted state and keep a retryable draft', async () => {
  const f = fixture();
  await f.settle();
  const id = f.spec.builtinIds[0];
  f.click(`[data-wallpaper-edit="${id}"]`);
  f.input('#wallpaper-crop-x', 80);
  f.saveHook = async () => {
    throw new Error('disk busy');
  };
  f.click('#wallpaper-crop-save');
  await f.settle();
  assert.deepEqual(plain(f.current.wallpaperGallery.light.crops), {});
  assert.equal(f.find('#wallpaper-crop-x').value, '80');
  assert.equal(f.find('#wallpaper-crop-save').disabled, false);
  assert.ok(f.errors.some((row) => row.error && row.message.includes('disk busy')));
  f.saveHook = undefined;
  f.click('#wallpaper-crop-save');
  await f.settle();
  assert.equal(f.current.wallpaperGallery.light.crops[id].x, 80);
  assert.equal(f.find('#wallpaper-editor'), null);
});

test('hiding every current-theme image yields a plain background and restoration preserves the other side', async () => {
  const f = fixture({ wallpaperEnabled: true });
  await f.settle();
  for (const entry of f.rows) {
    f.click(`[data-wallpaper-remove="${entry.id}"]`);
    await f.settle();
  }
  await f.api.ready();
  assert.equal(f.root.dataset.wallpaper, 'off');
  assert.equal(f.find('#app-wallpaper').hidden, true);
  assert.deepEqual(plain(f.current.wallpaperGallery.dark.hidden), []);
  assert.equal(f.find('.wallpaper-grid').children.length, 1);
  f.click('#wallpaper-restore');
  await f.settle();
  await f.api.ready();
  assert.equal(f.root.dataset.wallpaper, 'on');
});

test('actual background uses per-theme per-image crop and numeric blur amount', async () => {
  const f = fixture({ wallpaperEnabled: true });
  await f.settle();
  await f.api.ready();
  f.click(`[data-wallpaper-edit="${f.current.wallpaperLight}"]`);
  f.input('#wallpaper-crop-x', 25);
  f.input('#wallpaper-crop-y', 75);
  f.input('#wallpaper-crop-scale', 200);
  f.click('#wallpaper-crop-save');
  f.input('#wallpaperBlurAmount', 23);
  await f.settle();
  const image = f.find('#app-wallpaper').children[0];
  assert.equal(image.style.width, '4000px');
  assert.equal(image.style.left, '-600px');
  assert.equal(image.style.top, '-750px');
  assert.equal(f.find('.wallpaper-shade').style.backdropFilter, 'blur(23px)');
  f.click('[data-wallpaper-reset="wallpaperBlurAmount"]');
  await f.settle();
  assert.equal(f.find('.wallpaper-shade').style.backdropFilter, 'blur(14px)');
});
