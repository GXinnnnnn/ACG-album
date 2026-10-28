'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const filename = path.resolve(__dirname, '../src/ui/dialog-interaction.js');
const source = fs.readFileSync(filename, 'utf8');
function harness() {
  const listeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    }
  };
  const window = {};
  const context = vm.createContext({ window, document });
  const install = () => vm.runInContext(source, context, { filename });
  install();
  function element({ tagName = 'BUTTON', visible = false, honorsFocusVisible = true } = {}) {
    const attributes = new Map();
    const node = {
      tagName,
      open: tagName === 'DIALOG',
      isConnected: true,
      disabled: false,
      visible,
      inert: false,
      calls: [],
      attributes,
      getBoundingClientRect: () => ({ left: 100, right: 300, top: 100, bottom: 300 }),
      matches: (selector) => selector === ':focus-visible' && node.visible,
      closest: () => (node.inert ? {} : null),
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      focus(options) {
        node.calls.push(options);
        if (document.activeElement && document.activeElement !== node)
          emit('focusout', document.activeElement);
        document.activeElement = node;
        if (honorsFocusVisible) node.visible = options.focusVisible;
      }
    };
    return node;
  }
  function emit(type, target, details = {}, targetHandler = () => {}) {
    const event = {
      target,
      clientX: 0,
      clientY: 0,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...details
    };
    for (const handler of listeners.get(type) || []) {
      handler(event);
      if (event.stopped) break;
    }
    if (!event.stopped) targetHandler(event);
    return event;
  }
  return { ...window.albumDialogInteraction, document, element, emit, install, listeners };
}

test('all four backdrop sides stop legacy light dismissal, including late-created dialogs', () => {
  const h = harness();
  for (const [clientX, clientY] of [
    [99, 150],
    [301, 150],
    [150, 99],
    [150, 301]
  ]) {
    const dialog = h.element({ tagName: 'DIALOG' });
    const e = h.emit('click', dialog, { clientX, clientY }, () => {
      dialog.open = false;
    });
    assert.equal(e.defaultPrevented, true);
    assert.equal(dialog.open, true);
  }
});

test('dialog content, padding, popover choices and underlying pointerdown menu cleanup stay operable', () => {
  const h = harness();
  const dialog = h.element({ tagName: 'DIALOG' });
  for (const target of [dialog, h.element(), h.element({ tagName: 'DIV' })]) {
    let clicks = 0;
    const e = h.emit('click', target, { clientX: 150, clientY: 150 }, () => clicks++);
    assert.equal(clicks, 1);
    assert.equal(e.defaultPrevented, false);
  }
  let menuDismissals = 0;
  h.document.addEventListener('pointerdown', () => menuDismissals++);
  assert.equal(h.emit('pointerdown', dialog).defaultPrevented, false);
  assert.equal(menuDismissals, 1);
  let optionClicks = 0;
  h.emit(
    'click',
    h.element({ tagName: 'DIV' }),
    { clientX: 500, clientY: 500 },
    () => optionClicks++
  );
  assert.equal(optionClicks, 1, 'Top-layer menu options are not dialog backdrops');
});

test('native Escape/cancel and explicit close or cancel buttons retain their close action', () => {
  const h = harness();
  for (const type of ['keydown', 'cancel', 'click']) {
    const dialog = h.element({ tagName: 'DIALOG' });
    const target = type === 'click' ? h.element() : dialog;
    const event = h.emit(type, target, { key: 'Escape' }, () => {
      dialog.open = false;
    });
    assert.equal(event.defaultPrevented, false);
    assert.equal(dialog.open, false);
  }
});

test('pointer-origin focus returns without scrolling and has a scoped fallback for older Chromium', () => {
  const h = harness();
  const button = h.element({ honorsFocusVisible: false });
  const snapshot = h.rememberFocus(button);
  button.visible = true; // Escape made the UA modality keyboard while the dialog was open.
  assert.equal(h.restoreFocus(snapshot), true);
  assert.equal(h.document.activeElement, button);
  assert.equal(button.calls[0].preventScroll, true);
  assert.equal(button.calls[0].focusVisible, false);
  assert.equal(button.attributes.get('data-dialog-focus-return'), 'pointer');
  h.emit('keydown', button, { key: 'Tab' });
  assert.equal(
    button.attributes.has('data-dialog-focus-return'),
    false,
    'New keyboard input restores the normal focus ring'
  );
});

test('keyboard-origin focus keeps its visible ring; blur and pointer input clean a pointer return', () => {
  const h = harness();
  const keyboard = h.element({ visible: true });
  assert.equal(h.restoreFocus(h.rememberFocus(keyboard)), true);
  assert.equal(keyboard.calls[0].focusVisible, true);
  assert.equal(keyboard.attributes.size, 0);
  for (const type of ['focusout', 'pointerdown']) {
    const pointer = h.element();
    h.restoreFocus(h.rememberFocus(pointer));
    h.emit(type, pointer);
    assert.equal(pointer.attributes.size, 0);
  }
});

test('synchronous blur of the previous return clears only its marker, never the new return', () => {
  const h = harness();
  const first = h.element(),
    second = h.element();
  h.restoreFocus(h.rememberFocus(first));
  h.restoreFocus(h.rememberFocus(second));
  assert.equal(first.attributes.size, 0);
  assert.equal(second.attributes.get('data-dialog-focus-return'), 'pointer');
  assert.equal(h.document.activeElement, second);
  h.emit('focusout', second);
  assert.equal(second.attributes.size, 0);
});

test('invalid restoration targets cannot steal focus and installation is idempotent', () => {
  const h = harness();
  const current = h.element();
  h.document.activeElement = current;
  for (const property of ['isConnected', 'disabled', 'inert']) {
    const node = h.element();
    node[property] = property !== 'isConnected';
    assert.equal(h.restoreFocus(h.rememberFocus(node)), false);
    assert.equal(node.calls.length, 0);
    assert.equal(h.document.activeElement, current);
  }
  h.install();
  assert.equal(h.listeners.get('click').length, 1);
});
