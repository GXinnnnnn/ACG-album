'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const spec = require('../src/wallpaper-settings.cjs');

test('wallpaper contract has safe opt-in defaults and identical classic-script exports', () => {
  assert.deepEqual(spec.defaults, {
    wallpaperEnabled: false,
    wallpaperLight: 'builtin-bilibili-05',
    wallpaperDark: 'builtin-bilibili-07',
    wallpaperMask: true,
    wallpaperBlur: true,
    wallpaperPositionX: 50,
    wallpaperPositionY: 50,
    wallpaperScale: 100,
    wallpaperMaskTransparency: 75,
    wallpaperBlurAmount: 14,
    wallpaperGallery: {
      version: 1,
      light: { hidden: [], order: [], crops: {} },
      dark: { hidden: [], order: [], crops: {} }
    }
  });
  const context = vm.createContext({ window: {} });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/wallpaper-settings.cjs'), 'utf8'),
    context
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.albumWallpaperSpec.defaults)),
    spec.defaults
  );
  assert.equal(context.window.albumWallpaperSpec.valid('wallpaperScale', 50), true);
  assert.deepEqual(spec.normalize(null), spec.defaults);
  assert.deepEqual(spec.normalize('unexpected'), spec.defaults);
  assert.equal(Object.isFrozen(spec), true);
});

test('all wallpaper values validate without coercion or accepting arbitrary image paths/URLs', () => {
  for (const [key, range] of Object.entries(spec.ranges)) {
    for (const value of [
      NaN,
      Infinity,
      -Infinity,
      null,
      '50',
      {},
      range.min - 0.01,
      range.max + 0.01
    ])
      assert.equal(spec.valid(key, value), false, key);
    for (const value of [range.min, range.default, range.max, (range.min + range.max) / 2])
      assert.equal(spec.normalize({ [key]: value })[key], value, key);
    assert.equal(spec.normalize({ [key]: Infinity })[key], range.default);
  }
  for (const key of ['wallpaperEnabled', 'wallpaperMask', 'wallpaperBlur']) {
    for (const value of [0, 1, 'false', null, undefined])
      assert.equal(spec.valid(key, value), false);
    assert.equal(spec.valid(key, false), true);
    assert.equal(spec.valid(key, true), true);
  }
  for (const key of ['wallpaperLight', 'wallpaperDark']) {
    for (const value of spec.builtinIds.concat('custom-' + 'a'.repeat(64)))
      assert.equal(spec.valid(key, value), true);
    for (const value of [
      'builtin-bilibili-08',
      'custom-abcd',
      'custom-' + 'A'.repeat(64),
      '../image',
      'C:\\secret.jpg',
      'file:///secret.jpg',
      'https://example.test/a.png',
      'data:image/svg+xml,<svg/>',
      null
    ])
      assert.equal(spec.valid(key, value), false, String(value));
  }
  for (const key of ['constructor', '__proto__', 'prototype', 'unexpected'])
    assert.equal(spec.valid(key, 50), false);
});
