'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sortKey, NATURAL_SORT_VERSION } = require('../src/natural-sort.cjs');

const compare = (a, b) => Buffer.compare(Buffer.from(sortKey(a)), Buffer.from(sortKey(b)));

test('grouped keys retain natural integer magnitude without floating point or digit limits', () => {
  const names = ['Work100', 'Work02', 'Work0', 'Work10', 'Work1'];
  assert.deepEqual(names.sort(compare), ['Work0', 'Work1', 'Work02', 'Work10', 'Work100']);
  assert.ok(compare('image9999999999999999999999999999', 'image10000000000000000000000000000') < 0);
  assert.ok(compare('image' + '9'.repeat(200), 'image1' + '0'.repeat(200)) < 0);
  assert.equal(sortKey('000'), sortKey('0'));
  assert.equal(sortKey('image000002'), sortKey('image2'));
  assert.equal(sortKey('中文000002'), sortKey('中文2'));
});

test('normalization treats width, case and leading numeric zeros equivalently', () => {
  for (const [a, b] of [
    ['Ａ０２', 'a2'],
    ['Work02', 'work2'],
    ['é2', 'e2'],
    ['中文０２', '中文2'],
    ['［中文２］', '[中文2]']
  ])
    assert.equal(sortKey(a), sortKey(b), `${a} / ${b}`);
  assert.equal(sortKey(null), '');
  assert.equal(sortKey(undefined), '');
  assert.equal(sortKey(''), '');
  assert.equal(sortKey(12), sortKey('12'));
});

test('ordinary Chinese names retain locale pinyin ordering within the Chinese group', () => {
  const names = [
    '张1',
    '阿10',
    '中文10000000000000000',
    '波2',
    '阿2',
    '中文999999999999999',
    '中文2',
    '中文1'
  ];
  const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
  assert.deepEqual([...names].sort(compare), [...names].sort(collator.compare));
  assert.deepEqual(['中', '波', '张', '阿', '白', '陈', '左'].sort(compare), [
    '阿',
    '白',
    '波',
    '陈',
    '张',
    '中',
    '左'
  ]);
});

test('versioned keys are NUL-free SQLite text and ordinary names add only one group byte', () => {
  assert.equal(NATURAL_SORT_VERSION, `zh-cn-grouped-bmp-v2:${process.versions.icu}`);
  const samples = ['阿波张中文标题', '[中文2]', 'A2', '中文2', '\u0000A2', '😀', '𠮷野家2'];
  for (const name of samples) assert.equal(sortKey(name).includes('\0'), false, name);
  assert.ok(Buffer.byteLength(sortKey(samples[0])) <= Buffer.byteLength(samples[0]) + 1);
  for (const name of ['A', '2', '!', 'カナ']) assert.ok(sortKey(name).startsWith('0'));
  for (const name of ['阿', '[中文]', '😀中文', '𠮷野家']) assert.ok(sortKey(name).startsWith('1'));
});
