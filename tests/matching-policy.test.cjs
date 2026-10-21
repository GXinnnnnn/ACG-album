'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { importOptions } = require('../src/matching-policy.cjs');
test('legacy calls keep implicit defaults and explicit work matching type validation', () => {
  assert.deepEqual(importOptions(), {});
  assert.deepEqual(importOptions({ onlineMatch: false }), {
    onlineMatch: false,
    subjectTypes: [1, 2, 4, 6]
  });
  assert.throws(() => importOptions({ onlineMatch: true }));
  assert.throws(() => importOptions({ onlineMatch: false, subjectTypes: [3] }));
});
test('role cover preference is independent of online metadata choice', () => {
  const local = importOptions({ directoryKind: 'character', onlineMatch: true });
  assert.equal(local.characterCover, 'local-first');
  assert.equal(local.onlineMatch, true);
  const offline = importOptions({
    directoryKind: 'character',
    characterCover: 'bangumi',
    onlineMatch: false
  });
  assert.equal(offline.characterCover, 'bangumi');
  assert.equal(offline.onlineMatch, false);
  assert.equal(importOptions({ directoryKind: 'photo', onlineMatch: true }).onlineMatch, false);
});
test('renderer policies reject invalid types and incomplete requests', () => {
  for (const options of [
    { directoryKind: 'person', onlineMatch: true },
    { directoryKind: 'character' },
    { directoryKind: 'character', onlineMatch: false, characterCover: 'newest' },
    { directoryKind: 'work', onlineMatch: false, characterCover: 'local-first' }
  ])
    assert.throws(() => importOptions(options));
});
