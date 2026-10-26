'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { similarity } = require('../src/model.cjs');
const { rankImportSubjects } = require('../src/matching.cjs');

// A 101-character title has 100 unique bigrams. Replacing its tail gives
// independently checked scores in exact hundredths without mocking evidence.
const chars = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x5000 + i));
const query = chars.slice(0, 101).join('');
function candidate(id, score, total, date) {
  const prefix = score * 100 + 1;
  const name = chars.slice(0, prefix).join('') + chars.slice(200, 301 - prefix).join('');
  assert.equal(similarity(query, name), score);
  return { id, type: 2, name, collection: { collect: total }, date };
}
function selectAcrossOrders(candidates, options, expectedId, expectedScore, expectedReason) {
  for (const order of [
    candidates,
    [...candidates].reverse(),
    [...candidates.slice(1), candidates[0]]
  ]) {
    const result = rankImportSubjects([query], order, [2], options);
    assert.equal(result.selected?.id ?? null, expectedId);
    assert.equal(result.selectedMatch, expectedScore);
    assert.equal(result.selectionReason, expectedReason);
    if (expectedId !== null) assert.equal(result.candidates[0].id, expectedId);
  }
}

test('complete recall admits the 1.00 to 0.97 boundary and excludes a score below it', () => {
  selectAcrossOrders(
    [
      candidate(1, 1, 10, '2020-01-01'),
      candidate(2, 0.97, 1000, '2000-01-01'),
      candidate(3, 0.96, 1000000, '1980-01-01')
    ],
    { complete: true },
    2,
    0.97,
    'similarity-popularity-date'
  );
});

test('a score chain cannot extend the cohort beyond three points from its highest score', () => {
  selectAcrossOrders(
    [
      candidate(1, 1, 10, '2020-01-01'),
      candidate(2, 0.98, 1000, '2000-01-01'),
      candidate(3, 0.96, 1000000, '1980-01-01')
    ],
    { complete: true },
    2,
    0.98,
    'similarity-popularity-date'
  );
});

test('the newest candidate in the inclusive ninety-percent band can beat the most popular exact', () => {
  selectAcrossOrders(
    [
      candidate(1, 1, 1000, '2000-01-01'),
      candidate(2, 0.98, 900, '2024-01-01'),
      candidate(3, 0.97, 899, '2025-01-01')
    ],
    { complete: true },
    2,
    0.98,
    'similarity-popularity-date'
  );
});

test('a popularity chain cannot admit a newer candidate below ninety percent of the maximum', () => {
  selectAcrossOrders(
    [
      candidate(1, 1, 1000, '2000-01-01'),
      candidate(2, 0.98, 900, '2024-01-01'),
      candidate(3, 0.97, 810, '2025-01-01')
    ],
    { complete: true },
    2,
    0.98,
    'similarity-popularity-date'
  );
});

test('selectionReason describes the winning exact even when nearby fuzzy candidates compete', () => {
  selectAcrossOrders(
    [candidate(1, 1, 900, '2025-01-01'), candidate(2, 0.98, 1000, '2000-01-01')],
    { complete: true },
    1,
    1,
    'exact-popularity-date'
  );
});

test('incomplete recall selects only verified exacts despite more popular nearby fuzzy candidates', () => {
  selectAcrossOrders(
    [
      candidate(1, 1, 1000, '2024-01-01'),
      candidate(2, 1, 900, '2025-01-01'),
      candidate(3, 0.98, 1000000, '1980-01-01'),
      candidate(4, 0.97, 900000, '1970-01-01')
    ],
    { complete: false },
    2,
    1,
    'exact-popularity-date'
  );
});

test('incomplete recall cannot select a fuzzy candidate without any verified exact', () => {
  selectAcrossOrders(
    [candidate(1, 0.98, 1000, '2024-01-01'), candidate(2, 0.97, 900, '2000-01-01')],
    { complete: false },
    null,
    null,
    'incomplete-recall'
  );
});
