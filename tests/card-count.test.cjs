'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
const start = source.indexOf('function cardCountText('),
  end = source.indexOf('function cardReviewMessage(', start);
assert.ok(start >= 0 && end > start);
const ctx = vm.createContext({
  fmt: (value) => Number(value || 0).toLocaleString('zh-CN'),
  esc: (value) =>
    String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
  pathExt: (name) => name.split('.').at(-1).toUpperCase()
});
new vm.Script(source.slice(start, end)).runInContext(ctx);
test('folder counts preserve exact small values and switch to one-decimal units above the requested boundaries', () => {
  for (const [value, expected] of [
    [0, '0 张'],
    [1234, '1,234 张'],
    [1000000, '1,000,000 张'],
    [1000001, '100.0万张'],
    [12345678, '1234.6万张'],
    [10000000000, '1000000.0万张'],
    [10000000001, '100.0亿张'],
    [123456789012, '1234.6亿张'],
    [-1, '0 张'],
    [NaN, '0 张'],
    [Infinity, '0 张']
  ])
    assert.equal(ctx.cardCountText(value), expected, String(value));
});
test('abbreviated badges retain the exact full count as tooltip and accessible text, while extensions stay escaped', () => {
  const html = ctx.cardCountMarkup({ kind: 'folder', files: 123456789012 });
  assert.equal(html.replace(/<[^>]*>/g, ''), '1234.6亿张');
  assert.match(html, /class="card-count-value">1234\.6<\/span>/);
  assert.match(html, /class="card-count-unit">亿张<\/span>/);
  assert.match(html, /title="123,456,789,012 张"/);
  assert.match(html, /aria-label="123,456,789,012 张"/);
  assert.match(ctx.cardCountMarkup({ kind: 'image', name: 'a.<png' }), /&lt;PNG/);
});
