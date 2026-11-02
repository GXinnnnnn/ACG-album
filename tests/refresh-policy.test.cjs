'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let clock = 0,
    sequence = 0,
    refreshes = 0;
  const timers = new Map();
  const context = vm.createContext({
    setTimeout(fn, delay) {
      const id = ++sequence;
      timers.set(id, { fn, due: clock + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    }
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../src/ui/refresh-policy.js'), 'utf8'),
    context
  );
  return {
    create: (...args) => context.createMatchRefreshBatch(() => refreshes++, ...args),
    get refreshes() {
      return refreshes;
    },
    get timers() {
      return timers.size;
    },
    advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > until) break;
        clock = next[1].due;
        timers.delete(next[0]);
        next[1].fn();
      }
      clock = until;
    }
  };
}

test('a partial match batch refreshes after 250ms while later network work stays unresolved', () => {
  const f = fixture(),
    batch = f.create();
  assert.equal(batch.changed('ready-local-folder'), false);
  assert.equal(f.timers, 1);
  f.advance(249);
  assert.equal(f.refreshes, 0);
  f.advance(1);
  assert.equal(f.refreshes, 1);
  assert.equal(batch.pending, 0);
  assert.equal(f.timers, 0);
  f.advance(10000);
  assert.equal(f.refreshes, 1);
});

test('duplicate and distinct changes share the first deadline instead of postponing it', () => {
  const f = fixture(),
    batch = f.create();
  batch.changed('same');
  f.advance(100);
  for (let i = 0; i < 30; i++) batch.changed('same');
  batch.changed('second');
  batch.changed(null);
  assert.equal(batch.pending, 2);
  assert.equal(f.timers, 1);
  f.advance(150);
  assert.equal(f.refreshes, 1);
  assert.equal(batch.pending, 0);
});

test('threshold and final flush cancel the timer and a later batch gets its own deadline', () => {
  const f = fixture(),
    batch = f.create();
  for (let i = 0; i < 9; i++) batch.changed('folder-' + i);
  f.advance(100);
  assert.equal(batch.changed('folder-9'), true);
  assert.equal(f.refreshes, 1);
  assert.equal(f.timers, 0);
  f.advance(250);
  assert.equal(f.refreshes, 1);
  batch.changed('last');
  assert.equal(batch.flush(), true);
  assert.equal(batch.flush(), false);
  assert.equal(f.timers, 0);
  assert.equal(f.refreshes, 2);
  batch.changed('new-batch');
  f.advance(250);
  assert.equal(f.refreshes, 3);
});

test('dispose drops a pending refresh and late events cannot schedule another one', () => {
  const f = fixture(),
    batch = f.create();
  batch.changed('pending');
  batch.dispose();
  batch.dispose();
  assert.equal(f.timers, 0);
  assert.equal(batch.pending, 0);
  assert.equal(batch.changed('late'), false);
  assert.equal(batch.flush(), false);
  f.advance(10000);
  assert.equal(f.refreshes, 0);
  assert.equal(f.timers, 0);
});
