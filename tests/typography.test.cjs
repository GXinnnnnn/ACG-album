'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/typography.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../src/ui/typography.css'), 'utf8');
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
function harness({
  systemFonts = async () => ({ families: ['Local Alpha', '本地字体'] }),
  load = async () => [{}],
  save
} = {}) {
  const events = [],
    restored = [],
    requests = [];
  let body,
    document,
    view = 'library',
    captures = 0,
    saved = { fontFamily: '' };
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {
        setProperty(name, value) {
          this[name] = String(value);
        },
        getPropertyValue(name) {
          return this[name] || '';
        }
      };
      this.listeners = {};
      this.value = '';
      this.hidden = false;
      this.disabled = false;
      this.className = '';
    }
    get isConnected() {
      return this === body || !!this.parent?.isConnected;
    }
    setAttribute(key, value) {
      this.attributes[key] = String(value);
      if (key === 'id') this.id = String(value);
      if (key === 'class') this.className = String(value);
      if (key === 'hidden') this.hidden = true;
    }
    getAttribute(key) {
      return this.attributes[key] ?? null;
    }
    append(...nodes) {
      for (const node of nodes) {
        node.parent = this;
        this.children.push(node);
      }
    }
    replaceChildren(fragment) {
      this.children = [];
      this.append(...fragment.children);
    }
    set innerHTML(html) {
      this.children = [];
      for (const match of html.matchAll(/<(button|input|div|p|h2|label)\b([^>]*)>/g)) {
        const node = new Element(match[1]);
        for (const attribute of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g))
          node.setAttribute(attribute[1], attribute[2] || '');
        this.append(node);
      }
    }
    matches(selector) {
      if (selector === 'button:not(:disabled)') return this.tagName === 'BUTTON' && !this.disabled;
      if (selector[0] === '#') return this.id === selector.slice(1);
      if (selector[0] === '.') return this.className.split(' ').includes(selector.slice(1));
      if (selector[0] === '[') return Object.hasOwn(this.attributes, selector.slice(1, -1));
      return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
      return this.children.flatMap((node) => [
        ...(node.matches(selector) ? [node] : []),
        ...node.querySelectorAll(selector)
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }
    closest(selector) {
      return this.matches(selector) ? this : this.parent?.closest(selector) || null;
    }
    addEventListener(name, listener) {
      (this.listeners[name] ||= new Set()).add(listener);
    }
    removeEventListener(name, listener) {
      this.listeners[name]?.delete(listener);
    }
    emit(name, detail = {}) {
      const event = {
        target: this,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...detail
      };
      for (const listener of [...(this.listeners[name] || [])]) listener(event);
      return event;
    }
    focus() {
      document.activeElement = this;
    }
    scrollIntoView() {}
    showModal() {
      this.open = true;
    }
    close() {
      if (this.open) {
        this.open = false;
        this.emit('close');
      }
    }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
      this.parent = null;
    }
  }
  body = new Element('body');
  const root = new Element('html');
  document = {
    body,
    documentElement: root,
    activeElement: null,
    fonts: { load, ready: Promise.resolve() },
    createElement: (tag) => new Element(tag),
    createDocumentFragment: () => new Element('fragment'),
    querySelector: (selector) => body.querySelector(selector),
    getElementById: (id) => body.querySelector('#' + id)
  };
  const viewport = new Element();
  viewport.id = 'viewport';
  body.append(viewport);
  const host = new Element('dialog');
  host.open = true;
  body.append(host);
  const trigger = new Element('button');
  trigger.id = 'font-choose';
  host.append(trigger);
  const label = new Element();
  label.id = 'font-current';
  host.append(label);
  const window = {
    dispatchEvent(event) {
      events.push(event);
    },
    album: {
      call: async (method) => {
        requests.push(method);
        return systemFonts();
      }
    },
    albumDialogInteraction: {
      rememberFocus: (element) => ({ element }),
      restoreFocus: ({ element }) => element.focus()
    }
  };
  const context = {
    document,
    window,
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    requestAnimationFrame: (callback) => queueMicrotask(callback),
    captureDisplayAnchor: () => ({ id: ++captures }),
    restoreDisplayAnchor: (anchor) => restored.push(anchor),
    viewKey: () => view
  };
  vm.runInNewContext(source, context);
  const persist = async (key, family) => {
    if (save) await save(key, family);
    saved[key] = family;
    window.albumTypography.apply(saved);
  };
  window.albumTypography.mount(host, { settings: () => saved, save: persist });
  return {
    document,
    window,
    host,
    trigger,
    label,
    viewport,
    events,
    restored,
    requests,
    settings: saved,
    apply: window.albumTypography.apply,
    open() {
      trigger.onclick();
      return document.querySelector('#font-picker');
    },
    setView: (value) => {
      view = value;
    }
  };
}

test('optional local faces map five weights and Chinese aliases without requiring private files', () => {
  const rules = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
  assert.equal(rules.length, 10);
  const defaults = rules.filter((rule) => /font-family:\s*'ACG Lanting Yuan'/.test(rule));
  assert.deepEqual(
    defaults.map((rule) => /font-weight:\s*([^;]+)/.exec(rule)[1].trim()),
    ['400', '500', '600', '700 800', '900']
  );
  for (const [i, file] of ['regular', 'medium', 'semibold', 'bold', 'heavy'].entries()) {
    assert.match(defaults[i], new RegExp('/' + file + '\\.ttf'));
    assert.match(defaults[i], /src:\s*local\('[^']+'\),\s*url\(/);
    const alias = rules[i + 5];
    const family = /font-family:\s*'([^']+)'/.exec(alias)[1];
    assert.ok(defaults[i].includes(`local('${family}')`));
    assert.ok(alias.includes(`local('${family}')`));
    assert.match(alias, new RegExp('/' + file + '\\.ttf'));
  }
  assert.match(css, /:root\s*\{\s*font-family:\s*'方正兰亭圆_GBK_中'/);
  const middle = rules.find((rule) => /font-family:\s*'方正兰亭圆_GBK_中'/.test(rule));
  assert.match(middle, /\/semibold\.ttf/);
  for (const rule of rules) {
    assert.match(rule, /font-display:\s*swap/);
    assert.match(rule, /local\s*\(/i);
  }
});

test('empty default loads the bundled middle face while explicit regular and local families retain priority', async () => {
  const loads = [],
    h = harness({
      load: async (font, sample) => {
        loads.push({ font, sample });
        return [{}];
      }
    });
  assert.equal(await h.apply({ fontFamily: '' }), true);
  assert.match(h.document.documentElement.style.fontFamily, /^"方正兰亭圆_GBK_中"/);
  assert.match(
    h.document.documentElement.style.getPropertyValue('--secondary-font-family'),
    /^"方正兰亭圆_GBK_中粗"/
  );
  assert.equal(loads.length, 1);
  assert.match(loads[0].font, /"方正兰亭圆_GBK_中"/);
  assert.ok(loads.every((entry) => /相册/.test(entry.sample)));
  assert.equal(await h.apply({ fontFamily: '' }), true);
  assert.equal(loads.length, 1, 'Unchanged application does not repeatedly load or relayout');
  await h.apply({ fontFamily: '方正兰亭圆_GBK' });
  assert.match(h.document.documentElement.style.fontFamily, /^"方正兰亭圆_GBK",/);
  assert.match(loads.at(-1).font, /"方正兰亭圆_GBK"/);
  await h.apply({ fontFamily: '本地手动选择' });
  assert.match(h.document.documentElement.style.fontFamily, /^"本地手动选择"/);
  assert.match(
    h.document.documentElement.style.getPropertyValue('--secondary-font-family'),
    /^"本地手动选择"/
  );
  assert.equal(h.events.filter((event) => event.type === 'album:font-loaded').length, 3);
});

test('missing private fonts resolve to system fallback without false ready events or changing the choice', async () => {
  for (const load of [
    async () => [],
    async () => {
      throw Error('optional file absent');
    }
  ]) {
    const h = harness({ load });
    assert.equal(await h.apply({}), false);
    assert.equal(h.document.documentElement.dataset.fontState, 'fallback');
    assert.match(
      h.document.documentElement.style.fontFamily,
      /^"方正兰亭圆_GBK_中",.*Segoe UI.*Microsoft YaHei/
    );
    assert.equal(h.settings.fontFamily, '');
    assert.equal(h.events.length, 0);
    assert.equal(h.viewport.listeners.scroll.size, 0);
    const dialog = h.open();
    assert.equal(dialog.querySelector('#font-options').getAttribute('aria-label'), '预设字体');
    assert.match(dialog.querySelector('.font-status').textContent, /缺失时自动使用系统后备字体/);
    assert.doesNotMatch(source, /内置/);
    assert.equal(dialog.querySelector('#font-options').children.length, 5);
    assert.equal(await h.apply({ fontFamily: '方正兰亭圆_GBK' }), false);
    assert.match(h.document.documentElement.style.fontFamily, /^"方正兰亭圆_GBK",/);
    assert.equal(h.document.documentElement.dataset.fontState, 'fallback');
  }
});

test('installed families with no CSS face records retain explicit user priority', async () => {
  const h = harness({ load: async () => [] });
  assert.equal(await h.apply({ fontFamily: 'Local Alpha' }), true);
  assert.match(h.document.documentElement.style.fontFamily, /^"Local Alpha",/);
  assert.equal(h.document.documentElement.dataset.fontState, 'ready');
});

test('late old font completion cannot restore its family or old scroll anchor', async () => {
  const old = deferred(),
    fresh = deferred(),
    h = harness({ load: (font) => (font.includes('Old') ? old.promise : fresh.promise) });
  const first = h.apply({ fontFamily: 'Old' }),
    second = h.apply({ fontFamily: 'New' });
  fresh.resolve([{}]);
  assert.equal(await second, true);
  old.resolve([{}]);
  assert.equal(await first, false);
  assert.match(h.document.documentElement.style.fontFamily, /^"New"/);
  assert.equal(h.events.filter((event) => event.type === 'album:font-loaded').length, 1);
  assert.equal(h.restored.length, 1);
  assert.equal(h.restored[0].id, 2);
  assert.equal(h.viewport.listeners.scroll.size, 0);
});

test('navigation or scrolling during font swap uses the current anchor and errors leave usable fallback', async () => {
  const gate = deferred(),
    h = harness({ load: () => gate.promise });
  const pending = h.apply({ fontFamily: 'Manual' });
  h.setView('other');
  h.viewport.emit('scroll');
  gate.resolve([{}]);
  await pending;
  assert.equal(h.restored[0].id, 2);
  const failed = harness({
    load: async () => {
      throw new Error('font unavailable');
    }
  });
  assert.equal(await failed.apply({}), false);
  assert.equal(failed.document.documentElement.dataset.fontState, 'fallback');
  assert.match(failed.document.documentElement.style.fontFamily, /Segoe UI/);
});

test('first layer has five builtin faces and no installed-font RPC until the first action opens local search', async () => {
  const h = harness(),
    dialog = h.open(),
    options = dialog.querySelector('#font-options');
  assert.equal(dialog.dataset.fontLayer, 'builtin');
  assert.equal(options.children.length, 5);
  assert.equal(h.requests.length, 0);
  assert.equal(h.label.textContent, '方正兰亭圆_GBK_中');
  assert.equal(options.children[2].getAttribute('aria-selected'), 'true');
  assert.equal(options.children[0].getAttribute('aria-selected'), 'false');
  dialog.querySelector('[data-font-local]').onclick();
  await flush();
  assert.equal(dialog.dataset.fontLayer, 'local');
  assert.deepEqual(h.requests, ['systemFonts']);
  assert.equal(options.getAttribute('aria-busy'), 'false');
  assert.equal(options.children.length, 3);
  dialog.querySelector('[data-font-back]').onclick();
  assert.equal(dialog.dataset.fontLayer, 'builtin');
  assert.equal(options.children.length, 5);
  dialog.querySelector('[data-font-local]').onclick();
  await flush();
  assert.equal(h.requests.length, 1);
  options.children[1].onclick();
  await flush();
  assert.equal(h.settings.fontFamily, 'Local Alpha');
  assert.equal(h.document.querySelector('#font-picker'), null);
  assert.equal(h.document.activeElement, h.trigger);
});

test('restoring the empty setting selects middle without rewriting an explicit regular choice', async () => {
  const h = harness();
  await h.open().querySelector('#font-options').children[0].onclick();
  assert.equal(h.settings.fontFamily, '方正兰亭圆_GBK');
  assert.equal(h.label.textContent, '方正兰亭圆_GBK');
  assert.match(h.document.documentElement.style.fontFamily, /^"方正兰亭圆_GBK",/);
  const dialog = h.open();
  dialog.querySelector('[data-font-local]').onclick();
  await flush();
  const reset = dialog.querySelector('#font-options').children[0];
  assert.equal(reset.textContent, '方正兰亭圆_GBK_中（默认）');
  assert.equal(reset.getAttribute('aria-selected'), 'false');
  await reset.onclick();
  assert.equal(h.settings.fontFamily, '');
  assert.equal(h.label.textContent, '方正兰亭圆_GBK_中');
  assert.match(h.document.documentElement.style.fontFamily, /^"方正兰亭圆_GBK_中"/);
});

test('local search pagination and keyboard navigation retain all installed results', async () => {
  const h = harness({
    systemFonts: async () => ({ families: Array.from({ length: 330 }, (_, i) => 'Local ' + i) })
  });
  const dialog = h.open(),
    options = dialog.querySelector('#font-options'),
    local = dialog.querySelector('[data-font-local]');
  local.onkeydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(h.document.activeElement, options.children[0]);
  dialog.querySelector('[data-font-local]').onclick();
  await flush();
  assert.equal(options.children.length, 161);
  dialog.querySelector('[data-font-more]').onclick();
  assert.equal(options.children.length, 321);
  const search = dialog.querySelector('#font-search');
  search.value = 'Local 329';
  search.oninput();
  assert.equal(options.children.length, 2);
  options.children[0].onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(h.document.activeElement, options.children[1]);
});

test('installed-font retry, save failure, Escape and post-close async responses remain safe', async () => {
  let attempts = 0,
    saves = 0;
  const h = harness({
    systemFonts: async () => {
      if (!attempts++) throw Error('enumeration');
      return { families: ['Local'] };
    },
    save: async () => {
      if (!saves++) throw Error('disk');
    }
  });
  const dialog = h.open(),
    options = dialog.querySelector('#font-options');
  dialog.querySelector('[data-font-local]').onclick();
  await flush();
  assert.equal(dialog.querySelector('[data-font-retry]').hidden, false);
  await dialog.querySelector('[data-font-retry]').onclick();
  await flush();
  await options.children[1].onclick();
  assert.equal(dialog.open, true);
  assert.match(dialog.querySelector('.font-status').textContent, /保存失败/);
  assert.equal(options.children[1].disabled, false);
  await options.children[1].onclick();
  assert.equal(h.settings.fontFamily, 'Local');
  assert.equal(h.document.querySelector('#font-picker'), null);
  const gate = deferred(),
    late = harness({ systemFonts: () => gate.promise }),
    child = late.open();
  child.querySelector('[data-font-local]').onclick();
  child.emit('cancel');
  gate.resolve({ families: ['Late'] });
  await flush();
  assert.equal(late.document.querySelector('#font-picker'), null);
  assert.equal(late.document.activeElement, late.trigger);
});

test('each builtin selection persists its Chinese family, keeps parent settings and reports the current choice', async () => {
  const h = harness();
  const dialog = h.open();
  const choice = dialog.querySelector('#font-options').children[3];
  assert.equal(choice.dataset.fontFamily, '方正兰亭圆_GBK_中粗');
  await choice.onclick();
  assert.equal(h.settings.fontFamily, '方正兰亭圆_GBK_中粗');
  assert.equal(h.label.textContent, h.settings.fontFamily);
  assert.equal(h.host.open, true);
  const child = h.open();
  h.host.close();
  assert.equal(child.isConnected, false);
});
