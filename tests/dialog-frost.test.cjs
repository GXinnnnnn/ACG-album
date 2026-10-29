'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dialogFrostBounds, frostMask } = require('../src/ui/liquid-glass.js');
const box = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
});
test('one content rectangle encloses separated header, controls and footer on all four sides', () => {
  const dialog = box(100, 100, 640, 600);
  const frost = dialogFrostBounds(dialog, [
    box(132, 132, 200, 24),
    box(140, 320, 520, 22),
    box(132, 630, 550, 24)
  ]);
  assert.deepEqual(frost, { x: 24, y: 24, width: 566, height: 538 });
  const svg = decodeURIComponent(frostMask(dialog, frost).slice(24, -2));
  assert.match(svg, /feGaussianBlur/);
  assert.equal((svg.match(/<rect /g) || []).length, 1, 'no per-section opaque blocks');
  assert.match(svg, /rx="18"/);
});
test('scroll-clipped text and off-dialog controls cannot extend the material past its rim', () => {
  const frost = dialogFrostBounds(box(10, 20, 300, 240), [box(-200, -100, 900, 600)]);
  assert.deepEqual(frost, { x: 12, y: 12, width: 276, height: 216 });
  assert.deepEqual(dialogFrostBounds(box(0, 0, 300, 240), [box(800, 800, 40, 20)]), {
    x: 24,
    y: 24,
    width: 252,
    height: 192
  });
});
test('the same geometry has distinct theme tint without changing layout or foreground opacity', () => {
  const rect = box(0, 0, 500, 400),
    frost = dialogFrostBounds(rect, []);
  const light = decodeURIComponent(frostMask(rect, frost));
  const dark = decodeURIComponent(frostMask(rect, frost, true));
  assert.match(light, /#faf8ff/);
  assert.match(dark, /#1a1825/);
  assert.equal(light.match(/<rect[^>]+rx="18"/)[0], dark.match(/<rect[^>]+rx="18"/)[0]);
});
