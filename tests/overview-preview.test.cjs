'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/masonry.js'), 'utf8');
const geometry = vm.runInNewContext(source + '\noverviewPreviewGeometry;');

function fixture(width = 960, density = 222) {
  const frames = new Map(),
    requests = [],
    observers = [],
    mutations = [],
    created = [],
    errors = [];
  const document = { documentElement: {}, activeElement: null };
  const S = { settings: { density }, sort: 'name', direction: 'asc', loadVersion: 1 };
  let serial = 0;
  function element(className = '') {
    const node = {
      className,
      dataset: {},
      children: [],
      attributes: {},
      parentElement: null,
      get isConnected() {
        return node.connected || !!node.parentElement?.isConnected;
      },
      get firstElementChild() {
        return node.children[0] || null;
      },
      get lastElementChild() {
        return node.children.at(-1) || null;
      },
      get nextElementSibling() {
        const siblings = node.parentElement?.children;
        return siblings?.[siblings.indexOf(node) + 1] || null;
      },
      setAttribute(name, value) {
        node.attributes[name] = value;
      },
      removeAttribute(name) {
        delete node.attributes[name];
      },
      contains(other) {
        return node === other || node.children.some((child) => child.contains(other));
      },
      focus() {
        document.activeElement = node;
      },
      remove() {
        if (node.parentElement) {
          const siblings = node.parentElement.children;
          siblings.splice(siblings.indexOf(node), 1);
        }
        node.parentElement = null;
      },
      insertBefore(child, before) {
        assert.ok(before === null || node.children.includes(before));
        child.remove();
        node.children.splice(
          before === null ? node.children.length : node.children.indexOf(before),
          0,
          child
        );
        child.parentElement = node;
      },
      moveBefore(child, before) {
        node.insertBefore(child, before);
      },
      append(child) {
        node.insertBefore(child, null);
      },
      querySelectorAll(selector) {
        assert.equal(selector, '.album-card');
        return node.children.filter((child) => child.className === 'album-card');
      },
      querySelector(selector) {
        return node.children.find((child) => '.' + child.className === selector) || null;
      }
    };
    return node;
  }
  const preview = element('collection-preview');
  preview.connected = true;
  preview.clientWidth = width + 36;
  preview.getBoundingClientRect = () => ({ width: preview.clientWidth });
  document.createElement = () => element();
  class ResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
  }
  class MutationObserver {
    constructor(callback) {
      this.callback = callback;
      mutations.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }
  const context = {
    S,
    document,
    ResizeObserver,
    MutationObserver,
    $: () => ({}),
    requestAnimationFrame(callback) {
      frames.set(++serial, callback);
      return serial;
    },
    getComputedStyle(target) {
      return target === document.documentElement
        ? { getPropertyValue: () => String(S.settings.density) }
        : { paddingLeft: '18px', paddingRight: '18px', columnGap: '19px' };
    },
    api(method, args) {
      assert.equal(method, 'list');
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      requests.push({ args, resolve, reject });
      return promise;
    },
    card(node, index, inline, width) {
      const el = element('album-card');
      el.dataset.id = String(node.id);
      el.node = node;
      el.width = width;
      el.inline = inline;
      created.push(el);
      return el;
    },
    updateFolderCard(el, node, index, width) {
      el.node = node;
      el.width = width;
      return el;
    },
    svg: () => '<svg></svg>',
    navigate: () => Promise.resolve(),
    attempt: (action) =>
      Promise.resolve()
        .then(action)
        .catch((error) => errors.push(error))
  };
  const controller = vm.runInNewContext(source + '\ncreateOverviewPreviewController();', context);
  const reply = (index, prefix = 'album-', total = 100) => {
    const request = requests[index];
    request.resolve({
      total,
      items: Array.from({ length: Math.min(total, request.args.limit) }, (_, i) => ({
        id: prefix + i
      }))
    });
  };
  async function frame() {
    const work = [...frames.values()];
    frames.clear();
    for (const callback of work) callback();
    await Promise.resolve();
  }
  async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    controller,
    preview,
    document,
    S,
    requests,
    observers,
    mutations,
    created,
    errors,
    reply,
    frame,
    settle
  };
}

test('overview geometry retains requested widths in top-left rows with bounded trailing space', () => {
  for (const width of [120, 320, 960, 1180, 1920, 3448, 3840]) {
    for (const density of [158, 186, 222]) {
      const result = geometry(width, density);
      assert.equal(result.limit, result.columns * 2);
      const occupied = result.columns * result.width + (result.columns - 1) * 19;
      assert.equal(result.width, Math.min(width, density));
      assert.ok(occupied <= width + 1e-7);
      assert.ok(width - occupied < density + 19);
      assert.ok(result.columns >= 1);
    }
  }
  assert.ok(geometry(3448, 158).limit > 12);
  assert.ok(geometry(3448, 186).limit > 12);
  assert.ok(geometry(3448, 222).limit > 12);
  assert.equal(geometry(100000, 158).limit, 500);
});

test('fractional content widths follow native CSS track thresholds without rounding up a column', async () => {
  const f = fixture(596, 186);
  f.preview.getBoundingClientRect = () => ({ width: 595.8 + 36 });
  const loading = f.controller.render(f.preview, { id: 'root' }, 1);
  assert.equal(f.requests[0].args.limit, 4);
  f.reply(0);
  await loading;
  assert.equal(f.preview.dataset.previewColumns, '2');
});

test('first render requests actual two-row capacity and uses the final thumbnail width', async () => {
  const f = fixture(3448, 186);
  const loading = f.controller.render(f.preview, { id: 'root' }, 1);
  assert.equal(f.requests[0].args.limit, 32);
  f.reply(0);
  assert.equal(await loading, true);
  assert.equal(f.preview.querySelectorAll('.album-card').length, 32);
  assert.equal(f.preview.dataset.previewColumns, '16');
  assert.equal(f.preview.dataset.previewCount, '32');
  assert.equal(f.preview.lastElementChild.className, 'collection-more');
  assert.ok(f.created.every((el) => Math.abs(el.width - geometry(3448, 186).width) < 0.001));
});

test('small collections show only their actual albums while keeping the fitted columns', async () => {
  const f = fixture(3448, 158);
  const loading = f.controller.render(f.preview, { id: 'root' }, 1);
  f.reply(0, 'small-', 3);
  await loading;
  assert.equal(f.preview.querySelectorAll('.album-card').length, 3);
  assert.equal(f.preview.dataset.previewTotal, '3');
  assert.ok(Number(f.preview.dataset.previewColumns) > 3);
});

test('resize and density changes replenish rows; pixel-only resizing reuses data and DOM', async () => {
  const f = fixture();
  const first = f.controller.render(f.preview, { id: 'root' }, 1);
  f.reply(0);
  await first;
  const retained = f.created[0];
  f.preview.clientWidth += 20;
  f.observers[0].callback();
  await f.frame();
  assert.equal(f.requests.length, 1);
  assert.equal(f.preview.firstElementChild, retained);
  assert.equal(retained.width, 222, 'Pixel-only resize retains requested size and DOM');
  f.preview.clientWidth = 3448 + 36;
  f.observers[0].callback();
  await f.frame();
  assert.equal(f.requests[1].args.limit, 28);
  f.reply(1);
  await f.settle();
  assert.equal(f.preview.querySelectorAll('.album-card').length, 28);
  assert.equal(f.preview.firstElementChild, retained);
  f.S.settings.density = 158;
  f.mutations[0].callback([{ type: 'attributes' }]);
  await f.frame();
  assert.equal(f.requests[2].args.limit, 38);
  f.reply(2);
  await f.settle();
  assert.equal(f.preview.querySelectorAll('.album-card').length, 38);
  assert.equal(f.preview.firstElementChild, retained);
  assert.deepEqual(f.errors, []);
});

test('sort, root refresh and load generations reject stale responses', async () => {
  const f = fixture();
  const obsolete = f.controller.render(f.preview, { id: 'root' }, 1);
  f.S.sort = 'modified';
  f.S.direction = 'desc';
  const latest = f.controller.render(f.preview, { id: 'root' }, 1);
  f.reply(1, 'current-');
  await latest;
  const retained = f.preview.firstElementChild;
  f.document.activeElement = retained;
  f.reply(0, 'obsolete-');
  assert.equal(await obsolete, false);
  assert.equal(f.preview.firstElementChild, retained);
  const refresh = f.controller.render(f.preview, { id: 'root', files: 123 }, 1);
  f.reply(2, 'current-');
  await refresh;
  assert.equal(f.preview.firstElementChild, retained);
  assert.equal(f.document.activeElement, retained);
  const navigating = f.controller.render(f.preview, { id: 'root' }, 1);
  f.S.loadVersion++;
  f.reply(3, 'navigated-');
  assert.equal(await navigating, false);
  assert.equal(f.preview.firstElementChild, retained);
});

test('a response arriving before ResizeObserver cannot commit the former row capacity', async () => {
  const f = fixture();
  const initial = f.controller.render(f.preview, { id: 'root' }, 1);
  f.preview.clientWidth = 3448 + 36;
  f.reply(0);
  assert.equal(await initial, false);
  assert.equal(f.preview.querySelectorAll('.album-card').length, 0);
  await f.frame();
  assert.equal(f.requests[1].args.limit, 28);
  f.reply(1);
  await f.settle();
  assert.equal(f.preview.querySelectorAll('.album-card').length, 28);
});

test('detaching previews releases observers and pending results; future previews can reconnect', async () => {
  const f = fixture();
  const obsolete = f.controller.render(f.preview, { id: 'root' }, 1);
  f.preview.connected = false;
  f.mutations[0].callback([{ type: 'childList' }]);
  await f.frame();
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(f.mutations[0].disconnected, true);
  f.reply(0);
  assert.equal(await obsolete, false);
  assert.equal(f.preview.querySelectorAll('.album-card').length, 0);
  f.preview.connected = true;
  const current = f.controller.render(f.preview, { id: 'root' }, 1);
  assert.equal(f.observers.length, 2);
  f.reply(1);
  await current;
  assert.equal(f.preview.querySelectorAll('.album-card').length, 8);
});

test('shrinking a preview keeps keyboard focus on its remaining open-category action', async () => {
  const f = fixture(1920);
  const initial = f.controller.render(f.preview, { id: 'root' }, 1);
  f.reply(0);
  await initial;
  f.document.activeElement = f.preview.querySelectorAll('.album-card').at(-1);
  f.preview.clientWidth = 960 + 36;
  f.observers[0].callback();
  await f.frame();
  f.reply(1);
  await f.settle();
  assert.equal(f.preview.querySelectorAll('.album-card').length, 8);
  assert.equal(f.document.activeElement, f.preview.lastElementChild);
});
