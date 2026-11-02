'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { similarity, searchPlan } = require('../src/model.cjs');
const { rankImportSubjects, rankSubjects, rankKnownSubjects } = require('../src/matching.cjs');

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

test('colliding bigram sets and rounded 100 percent do not supply exact identity', () => {
  const collision = { id: 1, type: 4, name: 'ababa' };
  assert.equal(Math.round(similarity('abab', collision.name) * 100), 100);
  assert.ok(similarity('abab', collision.name) < 1);
  for (const rank of [rankSubjects, rankImportSubjects]) {
    const result = rank(['abab'], [collision], [4], { complete: false });
    assert.equal(result.selected, null);
    assert.equal(Math.round(result.candidates[0].match * 100), 100);
  }
  const complete = rankImportSubjects(['abab'], [collision], [4]);
  assert.equal(complete.selectionReason, 'similarity-popularity-date');
  assert.equal(rankKnownSubjects('abab', [collision], [4]).selected, null);
});

test('an exact Chinese half explains a 100 percent candidate without bilingual identity', () => {
  const destiny = { id: 185085, type: 4, name: 'Destiny 2', name_cn: '命运2' };
  const plan = searchPlan('命运2Desiny 2');
  const result = rankImportSubjects(plan.terms, [destiny], [4], {
    titleGroups: plan.titleGroups
  });
  assert.equal(result.candidates[0].match, 1);
  assert.equal(result.selected, null);
  assert.equal(rankKnownSubjects('命运2Desiny 2', [destiny], [4]).selected, null);
  assert.equal(rankKnownSubjects('命运2Destiny 2', [destiny], [4]).selected?.id, 185085);
});

test('known names reuse exact canonical and reviewed aliases with category and identity guards', () => {
  const senren = { id: 172612, type: 4, name: '千恋＊万花', name_cn: '千恋万花' };
  assert.equal(rankKnownSubjects('千恋万花', [senren], [4]).selected?.id, senren.id);
  assert.equal(rankKnownSubjects('Senren＊Banka', [senren], [4]).selected?.id, senren.id);
  assert.equal(rankKnownSubjects('千恋万花SenrenBanka', [senren], [4]).selected?.id, senren.id);
  assert.equal(rankKnownSubjects('SenrenBanka', [{ ...senren, id: 999 }], [4]).selected, null);
  assert.equal(rankKnownSubjects('千恋万花', [senren], [2]).selected, null);
  assert.equal(rankKnownSubjects('千恋万花', [{ ...senren, id: -1 }], [4]).selected, null);
});

test('short Chinese plus English requires two complete names already stored under one identity', () => {
  const known = { id: 1, type: 4, name: 'Destiny', name_cn: '命运' };
  assert.deepEqual(searchPlan('命运Destiny').titleGroups, []);
  for (const query of ['命运Destiny', 'Destiny 命运', '命运 / Ｄｅｓｔｉｎｙ']) {
    const result = rankKnownSubjects(query, [known], [4]);
    assert.equal(result.selected?.id, known.id, query);
    assert.equal(result.selectionReason, 'known-title-identity');
  }
  for (const query of ['命运Desiny', '命运Destiny壁纸', '命运Destiny外传', '命运Destiny命运'])
    assert.equal(rankKnownSubjects(query, [known], [4]).selected, null, query);
  const separate = [
    { id: 2, type: 4, name_cn: '命运', name: 'Another Game' },
    { id: 3, type: 4, name: 'Destiny', name_cn: '另一个游戏' }
  ];
  assert.equal(rankKnownSubjects('命运Destiny', separate, [4]).selected, null);
});

test('known bilingual names preserve numbers years sequel guards and the complete original title', () => {
  const destiny = { id: 185085, type: 4, name: 'Destiny 2', name_cn: '命运2' };
  assert.equal(rankKnownSubjects('命运２Destiny2', [destiny], [4]).selected?.id, destiny.id);
  const fullwidth = { ...destiny, name: 'Ｄｅｓｔｉｎｙ ２', name_cn: '命运２' };
  assert.equal(rankKnownSubjects('命运2Destiny2', [fullwidth], [4]).selected?.id, destiny.id);
  for (const query of ['命运2Destiny3', '命运Destiny', '命运2Destiny2006', '命运2Destiny 2外传'])
    assert.equal(rankKnownSubjects(query, [destiny], [4]).selected, null, query);
  assert.equal(
    rankKnownSubjects('命运2Destiny2', [{ ...destiny, aliases: ['Destiny 3'] }], [4]).selected,
    null
  );
  const conflict = { ...destiny, name: 'Destiny 3' };
  assert.equal(rankKnownSubjects('命运2Destiny3', [conflict], [4]).selected, null);
  const year = { id: 2, type: 4, name: 'Galaxy 2006', name_cn: '星河2006' };
  assert.equal(rankKnownSubjects('星河2006Galaxy2006', [year], [4]).selected?.id, year.id);
  assert.equal(rankKnownSubjects('星河2006Galaxy2007', [year], [4]).selected, null);
  const derivative = { id: 3, type: 4, name_cn: '星河花园2', aliases: ['星河花园'] };
  assert.equal(rankKnownSubjects('星河花园', [derivative], [4]).selected, null);
});

test('known identity ambiguity cannot be resolved by popularity date or the ten-row view', () => {
  const identities = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    type: 4,
    name: 'Destiny',
    name_cn: '命运',
    collection: { collect: i * 1000 },
    date: `${2000 + i}-01-01`
  }));
  for (const candidates of [identities, [...identities].reverse()]) {
    const result = rankKnownSubjects('命运Destiny', candidates, [4]);
    assert.equal(result.selected, null);
    assert.equal(result.selectionReason, 'ambiguous-known-title-identity');
    assert.equal(result.candidates.length, 10);
  }
  assert.equal(rankKnownSubjects('Destiny', [identities[0], identities[0]], [4]).selected?.id, 1);
  const types = [identities[0], { ...identities[0], type: 2 }];
  assert.equal(rankKnownSubjects('Destiny', types, [2, 4]).selected, null);
  const capped = Array.from({ length: 513 }, () => identities[0]);
  assert.equal(
    rankKnownSubjects('Destiny', capped, [4]).selectionReason,
    'incomplete-known-recall'
  );
  assert.equal(rankKnownSubjects('Destiny', capped, [4]).selected, null);
});
