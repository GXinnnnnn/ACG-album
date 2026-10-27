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
    has: (name) => values.has(name)
  };
}
function card() {
  const properties = new Map();
  const node = {
    classList: classes(),
    isConnected: true,
    reads: 0,
    properties,
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: (name) => properties.delete(name)
    },
    closest() {
      return this;
    },
    contains(child) {
      return child === this || child?.parent === this;
    },
    getBoundingClientRect() {
      this.reads++;
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
}

test('effects normalize settings and low/medium never schedule pointer work', () => {
  const f = fixture(),
    node = card();
  assert.equal(f.root.dataset.liquidGlass, 'on');
  assert.equal(f.root.dataset.motion, 'medium');
  for (const motionLevel of ['low', 'medium', 'unsupported', undefined]) {
    f.apply({ motionLevel, liquidGlass: false });
    f.point('pointerover', node);
    f.point('pointermove', node);
    clean(node, f);
    assert.equal(node.reads, 0);
    assert.equal(f.root.dataset.liquidGlass, 'off');
  }
  f.apply({ liquidGlass: true, motionLevel: 'high' });
  assert.equal(f.root.dataset.liquidGlass, 'on');
  assert.equal(f.root.dataset.motion, 'high');
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
  assert.equal(a.properties.get('--effect-rx'), '5.00deg');
  assert.equal(a.properties.get('--effect-ry'), '5.00deg');
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
});

test('glass applies only to bounded floating surfaces and only active cards are promoted', () => {
  assert.match(styles, /@supports \(backdrop-filter: blur\(1px\)\)/);
  assert.match(styles, /:root\[data-liquid-glass='on'\][\s\S]*?\.sidebar-shell/);
  assert.equal((styles.match(/backdrop-filter:\s*blur\(12px\)/g) || []).length, 1);
  assert.doesNotMatch(styles, /(?:url\(|feTurbulence|feDisplacementMap|WebGL)/i);
  assert.match(styles, /\.effects-active\s*\{[^}]*will-change: transform;/);
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
  assert.match(styles, /\.effects-active\s*\{[^}]*scale\(1\.065\)/);
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
