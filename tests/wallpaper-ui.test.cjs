'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const spec = require('../src/wallpaper-settings.cjs');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const decodes = [];
  class Element {
    constructor() {
      this.style = {};
      this.children = [];
      this.naturalWidth = 80;
      this.naturalHeight = 50;
    }
    setAttribute() {}
    append(...children) {
      this.children.push(...children);
      for (const child of children) child.parent = this;
    }
    prepend(child) {
      this.children.unshift(child);
      child.parent = this;
    }
    removeAttribute(name) {
      delete this[name];
    }
    replaceWith(child) {
      const i = this.parent.children.indexOf(this);
      this.parent.children[i] = child;
      child.parent = this.parent;
    }
    decode() {
      return new Promise((resolve) => decodes.push({ image: this, resolve }));
    }
  }
  const root = { dataset: {}, clientWidth: 1600, clientHeight: 1000 };
  const body = new Element();
  const window = {
    albumWallpaperSpec: spec,
    addEventListener() {},
    albumLiquidGlass: { refresh() {} }
  };
  const context = vm.createContext({
    window,
    Image: Element,
    document: { documentElement: root, body, createElement: () => new Element() }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/ui/wallpaper.js'), 'utf8'), context);
  const api = window.albumWallpaper;
  api.configure({
    call: async () =>
      spec.builtinIds.map((id) => ({ id, url: 'acg-image://wallpaper/' + id, builtin: true })),
    notify() {}
  });
  return { api, root, body, decodes };
}
test('late wallpaper decode cannot turn a disabled background back on', async () => {
  const f = fixture();
  const work = f.api.apply({ ...spec.defaults, wallpaperEnabled: true, theme: 'light' });
  await tick();
  assert.equal(f.decodes.length, 1);
  f.api.apply({ ...spec.defaults, wallpaperEnabled: false, theme: 'light' });
  f.decodes[0].resolve();
  await work;
  assert.equal(f.root.dataset.wallpaper, 'off');
  assert.equal(f.body.children[0].hidden, true);
  assert.equal(f.body.children[0].children[0].src, undefined);
});
test('out-of-order theme decodes retain the most recently selected wallpaper', async () => {
  const f = fixture();
  const first = f.api.apply({ ...spec.defaults, wallpaperEnabled: true, theme: 'light' });
  await tick();
  const second = f.api.apply({ ...spec.defaults, wallpaperEnabled: true, theme: 'dark' });
  await tick();
  assert.equal(f.decodes.length, 2);
  f.decodes[1].resolve();
  await second;
  f.decodes[0].resolve();
  await first;
  assert.equal(
    f.body.children[0].children[0].src,
    'acg-image://wallpaper/' + spec.defaults.wallpaperDark
  );
  assert.equal(f.root.dataset.wallpaper, 'on');
});
