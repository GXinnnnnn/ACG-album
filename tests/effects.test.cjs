'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const effectsSource = fs.readFileSync(path.join(__dirname, '../src/ui/effects.js'), 'utf8');
const themeSource = fs.readFileSync(path.join(__dirname, '../src/ui/theme.js'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '../src/ui/effects.css'), 'utf8');

function events(extra = {}) {
  const listeners = new Map();
  return Object.assign(extra, {
    listeners,
    addEventListener(type, fn, options) {
      const list = listeners.get(type) || [];
      list.push({ fn, options });
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((entry) => entry.fn !== fn)
      );
    },
    dispatchEvent(event) {
      for (const { fn } of [...(listeners.get(event.type) || [])]) fn(event);
      return true;
    },
    emit(type, data = {}) {
      this.dispatchEvent({ type, ...data });
    }
  });
}
function classes() {
  const values = new Set();
  return {
    add: (name) => values.add(name),
    remove: (name) => values.delete(name),
    contains: (name) => values.has(name),
    has: (name) => values.has(name)
  };
}
function card(kind = 'album') {
  const properties = new Map(),
    parentProperties = new Map();
  const node = {
    classList: classes(),
    isConnected: true,
    reads: 0,
    properties,
    parentProperties,
    style: {
      setProperty: (name, value) => parentProperties.set(name, value),
      removeProperty: (name) => parentProperties.delete(name)
    },
    closest() {
      return kind === 'collection' && this.classList.contains('expanded') ? null : this;
    },
    contains(child) {
      return child === this || child?.parent === this;
    },
    querySelector() {
      return this.cover;
    },
    getBoundingClientRect() {
      if (kind !== 'collection')
        throw new Error('Album geometry must come from the cover, not the title/card');
      node.reads++;
      return { left: 10, top: 20, width: 320, height: 260 };
    }
  };
  if (kind === 'collection') node.classList.add('collection-tile');
  node.cover = {
    parent: node,
    isConnected: true,
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name)
    },
    getBoundingClientRect() {
      node.reads++;
      return { left: 10, top: 20, width: 200, height: 300 };
    }
  };
  return node;
}
function fixture(dataset = {}) {
  const root = { dataset: { ...dataset }, classList: classes() },
    document = events({ documentElement: root, hidden: false }),
    reduced = events({ matches: false }),
    fine = events({ matches: true }),
    frames = new Map();
  let serial = 0;
  const nativeEvents = [];
  const window = events({
    album: { onEvent: (handler) => nativeEvents.push(handler) },
    matchMedia: (query) => (query.includes('reduced-motion') ? reduced : fine),
    requestAnimationFrame(fn) {
      const id = ++serial;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    }
  });
  const context = vm.createContext({ document, window, Event });
  vm.runInContext(effectsSource, context);
  return {
    root,
    document,
    window,
    reduced,
    fine,
    frames,
    nativeEvent(event) {
      for (const handler of nativeEvents) handler(event);
    },
    apply: window.albumEffects.apply,
    point(type, target, extra = {}) {
      document.emit(type, { target, pointerType: 'mouse', clientX: 210, clientY: 20, ...extra });
    },
    tick() {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn();
    }
  };
}
function clean(node, f) {
  assert.equal(f.frames.size, 0);
  assert.equal(node.classList.has('effects-active'), false);
  assert.equal(node.properties.size, 0);
  assert.equal(node.parentProperties.size, 0, 'Parent/title never receive tilt styles');
}

test('effects normalize settings and low/medium never schedule pointer work', () => {
  const f = fixture(),
    node = card();
  assert.equal(f.root.dataset.liquidGlass, 'on');
  assert.equal(f.root.dataset.motion, 'high');
  for (const motionLevel of ['low', 'medium']) {
    f.apply({ motionLevel, liquidGlass: false });
    f.point('pointerover', node);
    f.point('pointermove', node);
    clean(node, f);
    assert.equal(node.reads, 0);
    assert.equal(f.root.dataset.liquidGlass, 'off');
  }
  for (const motionLevel of ['unsupported', undefined, 'high']) {
    f.apply({ liquidGlass: true, motionLevel });
    assert.equal(f.root.dataset.liquidGlass, 'on');
    assert.equal(f.root.dataset.motion, 'high');
  }
});

test('native hide and minimize release effects even when renderer visibility stays visible', () => {
  const f = fixture(),
    node = card();
  f.apply({ motionLevel: 'high' });
  f.point('pointermove', node);
  assert.equal(f.document.hidden, false);
  assert.equal(f.frames.size, 1);
  f.nativeEvent({ type: 'window', data: { inactive: true } });
  clean(node, f);
  f.point('pointermove', node);
  f.tick();
  assert.equal(node.classList.has('effects-active'), true);
  f.nativeEvent({ type: 'window', data: { inactive: true } });
  clean(node, f);
});

test('glass defaults on while explicit saved and boot-time off values are honored', () => {
  const f = fixture({ liquidGlass: 'off' });
  assert.equal(f.root.dataset.liquidGlass, 'off');
  f.apply({ liquidGlass: false });
  assert.equal(f.root.dataset.liquidGlass, 'off');
  f.apply({});
  assert.equal(f.root.dataset.liquidGlass, 'on');
});

test('high motion owns one card and one event-driven RAF, with one geometry read per entry', () => {
  const f = fixture(),
    a = card(),
    b = card();
  f.apply({ motionLevel: 'high' });
  f.point('pointerover', a);
  for (let i = 0; i < 100; i++) f.point('pointermove', a, { clientX: 5000, clientY: -5000 });
  assert.equal(f.frames.size, 1);
  assert.equal(a.reads, 1);
  f.tick();
  assert.equal(f.frames.size, 0, 'No idle or continuous animation loop');
  assert.equal(a.properties.get('--effect-rx'), '9.00deg');
  assert.equal(a.properties.get('--effect-ry'), '9.00deg');
  assert.equal(a.parentProperties.size, 0, 'Only the cover receives the 3D rotation');
  f.point('pointerover', b);
  assert.equal(a.classList.has('effects-active'), false);
  assert.equal(a.properties.size, 0);
  assert.equal(b.classList.has('effects-active'), true);
  assert.equal(f.frames.size, 1);
  const child = { parent: b, closest: () => b };
  f.point('pointerout', b, { relatedTarget: child });
  assert.equal(b.classList.has('effects-active'), true);
  f.point('pointermove', child);
  assert.equal(b.reads, 1);
  f.point('pointerout', child, { relatedTarget: null });
  clean(b, f);
  assert.equal(f.document.listeners.get('pointermove').length, 1);
  assert.equal(f.document.listeners.get('scroll')[0].options.capture, true);
  assert.equal(f.document.listeners.get('scroll')[0].options.passive, true);
});

test('leaving, scrolling, resizing, focus, visibility and settings changes cancel pending work and remove styles', () => {
  const cases = [
    (f) => f.document.emit('scroll'),
    (f) => f.window.emit('resize'),
    (f) => f.window.emit('blur'),
    (f) => f.window.emit('pagehide'),
    (f) => f.document.emit('pointercancel'),
    (f) => f.document.emit('pointerdown'),
    (f) => f.document.emit('keydown', { key: 'Tab' }),
    (f) => {
      f.document.hidden = true;
      f.document.emit('visibilitychange');
    },
    (f) => {
      f.reduced.matches = true;
      f.reduced.emit('change');
    },
    (f) => {
      f.fine.matches = false;
      f.fine.emit('change');
    },
    (f) => f.apply({ motionLevel: 'low' }),
    (f) => f.apply({ motionLevel: 'high', liquidGlass: true })
  ];
  for (const cancel of cases)
    for (const painted of [false, true]) {
      const f = fixture(),
        node = card();
      f.apply({ motionLevel: 'high' });
      f.point('pointerover', node);
      if (painted) f.tick();
      cancel(f);
      clean(node, f);
      f.tick();
      clean(node, f);
    }
});

test('touch, dragging, reduced motion and removed virtual cards cannot retain tilt', () => {
  for (const extra of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { buttons: 1 }]) {
    const f = fixture(),
      node = card();
    f.apply({ motionLevel: 'high' });
    f.point('pointermove', node, extra);
    clean(node, f);
    assert.equal(node.reads, 0);
  }
  const f = fixture(),
    node = card();
  f.apply({ motionLevel: 'high' });
  f.reduced.matches = true;
  f.point('pointerover', node);
  clean(node, f);
  f.reduced.matches = false;
  f.point('pointerover', node);
  node.isConnected = false;
  f.tick();
  clean(node, f);
  node.isConnected = true;
  f.point('pointerover', node);
  node.cover.isConnected = false;
  f.tick();
  clean(node, f);
  node.cover = null;
  f.point('pointerover', node);
  clean(node, f);
});

test('glass covers bounded floating surfaces and only active card surfaces are promoted', () => {
  assert.match(styles, /@supports \(backdrop-filter: blur\(1px\)\)/);
  const glass = styles.match(
    /:root\[data-liquid-glass='on'\][\s\S]*?backdrop-filter: blur\(18px\)/
  )?.[0];
  assert.ok(glass);
  for (const selector of [
    '.sidebar-shell',
    '.context-menu',
    '.album-select-list',
    '.progress-panel',
    '.toast',
    '.modal'
  ])
    assert.ok(glass.includes(selector), selector);
  assert.doesNotMatch(glass, /\.album-card|\.cover-shell|\.collection-tile/);
  assert.equal((styles.match(/backdrop-filter:\s*blur\(18px\)/g) || []).length, 1);
  assert.match(
    styles,
    /:root\[data-liquid-glass='off'\] \.context-menu\s*\{\s*backdrop-filter: none/
  );
  assert.doesNotMatch(styles, /(?:url\(|feTurbulence|feDisplacementMap|WebGL)/i);
  assert.match(
    styles,
    /\.collection-tile:not\(\.expanded\)\.effects-active\s*\{[^}]*will-change: transform;/
  );
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*transform: none !important/
  );
  assert.match(styles, /\.album-card:focus-visible/);
  assert.match(styles, /@media \(hover: hover\) and \(pointer: fine\)/);
});

test('low mode disables only decorative surface motion and keeps scale/loading feedback', () => {
  const block = styles.match(
    /:root\[data-motion='low'\]\s*:is\([\s\S]*?animation: none;\s*transition: none;\s*\}/
  )?.[0];
  assert.ok(block, 'Low mode has a scoped decorative-motion override');
  for (const selector of ['.sidebar-shell', '.modal', '.settings-panel', '.settings-tab-indicator'])
    assert.ok(block.includes(selector), selector + ' does not animate in low mode');
  assert.doesNotMatch(
    block,
    /\*|\.progress-spinner|\.progress-track|\.card-skeleton|\.album-card\b/
  );
  assert.match(styles, /--effect-duration: 120ms/);
  assert.match(styles, /transform: scale\(1\.008\)/);
  assert.match(
    styles,
    /\.collection-tile:not\(\.expanded\)\.effects-active\s*\{[^}]*scale\(1\.065\)/
  );
});

function themeFixture(level = 'medium', reduce = false) {
  const root = { dataset: { motion: level }, classList: classes() },
    reduced = events({ matches: reduce }),
    window = events(),
    animations = [],
    saves = [],
    transitions = [],
    S = { settings: { theme: 'light' } };
  root.animate = (keyframes, options) => {
    let finish;
    const finished = new Promise((resolve) => {
      finish = resolve;
    });
    const animation = {
      keyframes,
      options,
      finished,
      finish,
      cancel() {
        finish();
      }
    };
    animations.push(animation);
    return animation;
  };
  const document = events({
    documentElement: root,
    hidden: false,
    querySelector: () => ({
      getBoundingClientRect: () => ({ left: 20, top: 30, width: 30, height: 30 })
    }),
    startViewTransition(update) {
      const transition = {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(update()),
        finished: Promise.resolve(),
        skips: 0,
        skipTransition() {
          this.skips++;
        }
      };
      transitions.push(transition);
      return transition;
    }
  });
  const context = vm.createContext({
    document,
    window,
    S,
    innerWidth: 1180,
    innerHeight: 800,
    matchMedia: () => reduced,
    async saveSetting(key, value) {
      saves.push(value);
      S.settings[key] = value;
    }
  });
  vm.runInContext(themeSource, context);
  return { root, document, window, reduced, animations, saves, transitions, context };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('low motion and reduced motion save themes without a full-window view transition', async () => {
  for (const [level, reduce] of [
    ['low', false],
    ['medium', true],
    ['high', true]
  ]) {
    const f = themeFixture(level, reduce);
    await f.context.changeTheme('dark');
    assert.deepEqual(f.saves, ['dark']);
    assert.equal(f.transitions.length, 0);
    assert.equal(f.animations.length, 0);
  }
});

test('medium/high theme transitions finish cleanly and changing motion cancels an active reveal', async () => {
  for (const [level, duration] of [
    ['medium', 280],
    ['high', 340]
  ]) {
    const f = themeFixture(level);
    const task = f.context.changeTheme('dark');
    await settle();
    assert.equal(f.animations.length, 1);
    assert.equal(f.animations[0].options.duration, duration);
    assert.equal(f.root.classList.has('theme-revealing'), true);
    f.animations[0].finish();
    await task;
    assert.equal(f.root.classList.has('theme-revealing'), false);
    assert.equal(f.window.listeners.get('album-effects-change').length, 0);
    assert.equal(f.document.listeners.get('visibilitychange').length, 0);
  }
  for (const cancel of [
    (f) => {
      f.root.dataset.motion = 'low';
      f.window.emit('album-effects-change');
    },
    (f) => {
      f.reduced.matches = true;
      f.reduced.emit('change');
    },
    (f) => {
      f.document.hidden = true;
      f.document.emit('visibilitychange');
    },
    (f) => f.window.emit('resize')
  ]) {
    const f = themeFixture('high');
    const task = f.context.changeTheme('dark');
    await settle();
    cancel(f);
    await task;
    assert.equal(f.root.classList.has('theme-revealing'), false);
    assert.ok(f.transitions[0].skips > 0);
    assert.deepEqual(f.saves, ['dark']);
  }
});

test('home collections tilt their whole surface while ordinary album titles remain anchored', () => {
  const f = fixture(),
    collection = card('collection'),
    album = card();
  f.apply({ motionLevel: 'high', liquidGlass: false });
  f.point('pointerover', collection, { clientX: 330, clientY: 20 });
  f.tick();
  assert.equal(collection.parentProperties.get('--effect-rx'), '9.00deg');
  assert.equal(collection.parentProperties.get('--effect-ry'), '9.00deg');
  assert.equal(collection.properties.size, 0, 'collection image has no independent rotation');
  assert.equal(collection.reads, 1);
  const details = { parent: collection, closest: () => collection };
  f.point('pointermove', details, { clientX: 10, clientY: 280 });
  f.tick();
  assert.equal(collection.reads, 1, 'moving into text reuses the same whole-card bounds');
  assert.equal(collection.parentProperties.get('--effect-rx'), '-9.00deg');
  assert.equal(collection.parentProperties.get('--effect-ry'), '-9.00deg');
  f.point('pointerover', album);
  f.tick();
  assert.equal(collection.parentProperties.size, 0);
  assert.equal(collection.classList.has('effects-active'), false);
  assert.equal(album.parentProperties.size, 0, 'album titles still never rotate');
  assert.ok(album.properties.size > 0, 'album cover alone rotates');
  assert.equal(f.root.dataset.liquidGlass, 'off', 'glass off remains independent of motion');
  f.document.emit('keydown', { key: 'Tab' });
  clean(album, f);
});

test('expanded, low/medium and reduced-motion collections never acquire pointer rotation', () => {
  for (const level of ['low', 'medium']) {
    const f = fixture(),
      collection = card('collection');
    f.apply({ motionLevel: level });
    f.point('pointerover', collection);
    clean(collection, f);
    assert.equal(collection.parentProperties.size, 0);
  }
  const f = fixture(),
    collection = card('collection');
  f.apply({ motionLevel: 'high' });
  collection.classList.add('expanded');
  f.point('pointerover', collection);
  clean(collection, f);
  collection.classList.remove('expanded');
  f.reduced.matches = true;
  f.point('pointerover', collection);
  clean(collection, f);
  f.reduced.matches = false;
  f.point('pointerover', collection);
  f.tick();
  f.document.emit('scroll');
  clean(collection, f);
  assert.equal(collection.parentProperties.size, 0);
  f.point('pointerover', collection);
  collection.classList.add('expanded');
  f.tick();
  clean(collection, f);
  assert.equal(
    collection.parentProperties.size,
    0,
    'expanding before the pending frame cancels whole-card rotation'
  );
  assert.match(styles, /\.collection-tile:not\(\.expanded\):focus-within\s*\{[^}]*scale\(1\.018\)/);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*:is\(\.album-card > \.cover-shell, \.collection-tile\)/
  );
});

test('collection summary replaces the arrow and preserves pointer, keyboard, expand and context actions', async () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
  const start = appSource.indexOf('async function renderOverview(version)'),
    end = appSource.indexOf('const grid = createVirtualGrid()', start);
  assert.ok(start > 0 && end > start);
  const navigations = [],
    refreshed = [],
    contexts = [],
    attributes = new Map();
  let removed = false;
  const summary = {
    classList: classes(),
    setAttribute: (key, value) => attributes.set(key, value)
  };
  const cover = { style: {}, classList: { toggle() {} }, getAttribute: () => 'generated' };
  const elements = {
    h3: {},
    '.collection-details p': {},
    '.collection-open': { setAttribute() {} },
    '.collection-image': { insertAdjacentHTML() {} },
    img: cover,
    '.category-enter': {
      remove() {
        removed = true;
      }
    },
    '.category-expand': {},
    '.collection-details > div': summary
  };
  const tile = {
    dataset: { id: 'root' },
    nextElementSibling: null,
    querySelector: (selector) => elements[selector] || null
  };
  const target = { children: [tile], firstElementChild: tile };
  const state = {
    roots: [{ id: 'root', name: 'Generated collection', files: 4, folders: 2 }],
    sort: 'name',
    direction: 'asc',
    loadVersion: 1,
    overviewExpanded: new Set()
  };
  const context = vm.createContext({
    $: () => target,
    S: state,
    fmt: String,
    cardReviewMessage: () => '',
    cardReviewBadge: () => '',
    applyCoverCrop() {},
    thumb: () => 'generated',
    attempt: (action) => action(),
    navigate: (args) => navigations.push(args.parent),
    loadPage: (keep) => refreshed.push(keep),
    showContext: (_event, node) => contexts.push(node.id)
  });
  vm.runInContext(appSource.slice(start, end), context);
  await context.renderOverview(1);
  assert.equal(removed, true);
  assert.equal(summary.tabIndex, 0);
  assert.equal(attributes.get('role'), 'button');
  assert.equal(attributes.get('aria-label'), '打开分类 Generated collection');
  let prevented = 0;
  for (const key of ['Enter', ' ']) summary.onkeydown({ key, preventDefault: () => prevented++ });
  assert.equal(prevented, 2);
  assert.deepEqual(navigations, ['root', 'root']);
  tile.onclick({ target: { closest: () => null } });
  assert.equal(navigations.length, 3);
  elements['.collection-open'].onclick();
  tile.onclick({ target: { closest: () => elements['.collection-open'] } });
  assert.equal(navigations.length, 4, 'native image button enters only once');
  elements['.category-expand'].onclick();
  tile.onclick({ target: { closest: () => elements['.category-expand'] } });
  assert.equal(navigations.length, 4, 'expand does not also enter the collection');
  assert.equal(state.overviewExpanded.has('root'), true);
  assert.deepEqual(refreshed, [true]);
  tile.oncontextmenu({});
  assert.deepEqual(contexts, ['root']);
});

test('font metrics reflow and filter indicator update finish synchronously inside the typography anchor guard', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
  const start = source.indexOf("window.addEventListener('album:font-loaded'"),
    end = source.indexOf('let renderFrame = 0;', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  let loaded;
  vm.runInNewContext(source.slice(start, end), {
    window: {
      addEventListener(name, callback) {
        assert.equal(name, 'album:font-loaded');
        loaded = callback;
      }
    },
    grid: {
      layout() {
        calls.push('layout');
      }
    },
    updateFilterIndicator() {
      calls.push('indicator');
    }
  });
  calls.push('capture');
  loaded();
  calls.push('restore');
  assert.deepEqual(calls, ['capture', 'layout', 'indicator', 'restore']);
});
