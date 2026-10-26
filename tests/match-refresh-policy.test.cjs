'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({});
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '../src/ui/refresh-policy.js'), 'utf8'),
  context
);
const create = context.createMatchRefreshBatch;

test('automatic matches refresh every ten distinct folders and flush the final partial batch', () => {
  let refreshes = 0;
  const batch = create(() => refreshes++);
  for (let i = 0; i < 9; i++) assert.equal(batch.changed('folder-' + i), false);
  assert.equal(refreshes, 0);
  assert.equal(batch.pending, 9);
  assert.equal(batch.changed('folder-9'), true);
  assert.equal(refreshes, 1);
  assert.equal(batch.pending, 0);
  batch.changed('folder-10');
  batch.changed('folder-11');
  assert.equal(batch.flush(), true);
  assert.equal(refreshes, 2);
  assert.equal(batch.flush(), false);
  assert.equal(refreshes, 2);
});

test('local identity and online detail saves for the same folder do not cause premature refreshes', () => {
  let refreshes = 0;
  const batch = create(() => refreshes++);
  for (let i = 0; i < 30; i++) batch.changed('same-folder');
  batch.changed(null);
  assert.equal(batch.pending, 1);
  assert.equal(refreshes, 0);
  batch.flush();
  assert.equal(refreshes, 1);
  batch.changed('same-folder');
  assert.equal(batch.pending, 1);
});

test('a long import emits one refresh per completed batch rather than per matched item', () => {
  let refreshes = 0;
  const batch = create(() => refreshes++);
  for (let i = 0; i < 237; i++) batch.changed('folder-' + i);
  assert.equal(refreshes, 23);
  assert.equal(batch.pending, 7);
  batch.flush();
  assert.equal(refreshes, 24);
});
