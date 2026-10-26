'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, similarity } = require('../src/model.cjs');
const {
  MIN_CONFIDENCE,
  IMPORT_MIN_CONFIDENCE,
  rankSubjects,
  rankImportSubjects
} = require('../src/matching.cjs');

const subject = (id, name, extra = {}) => ({ id, type: 2, name, ...extra });
const chars = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x5000 + i));
// Unique bigrams give exact, independently calculable Dice score boundaries.
const queryOf = (length) => chars.slice(0, length).join('');
const fuzzyOf = (length, prefix) =>
  chars.slice(0, prefix).join('') + chars.slice(200, 200 + length - prefix).join('');
const count = (n) => ({ collect: n });
const select = (query, subjects, options) => rankImportSubjects([query], subjects, [2], options);

test('import exports its own threshold and rejects exactly85 while admitting85.1 percent', () => {
  assert.equal(MIN_CONFIDENCE, 0.88);
  assert.equal(IMPORT_MIN_CONFIDENCE, 0.85);
  const boundaryQuery = queryOf(21);
  const boundary = subject(1, fuzzyOf(21, 18));
  assert.equal(similarity(boundaryQuery, boundary.name), 0.85);
  const rejected = select(boundaryQuery, [boundary]);
  assert.equal(rejected.selected, null);
  assert.equal(rejected.selectedMatch, null);
  assert.equal(rejected.candidates[0].match, 0.85);
  const aboveQuery = queryOf(25);
  const above = subject(2, fuzzyOf(24, 21));
  const aboveScore = 40 / 47; // 85.106...%, the smallest chosen real-score fixture above85.1%.
  assert.equal(similarity(aboveQuery, above.name), aboveScore);
  const accepted = select(aboveQuery, [above]);
  assert.equal(accepted.selected.id, 2);
  assert.equal(accepted.selectedMatch, aboveScore);
  assert.equal(accepted.candidates[0].match, aboveScore);
  assert.equal(rankSubjects([aboveQuery], [above], [2]).selected, null);
});

test('a popular candidate more than three score points below the best cannot win', () => {
  const query = queryOf(51);
  const best = subject(1, fuzzyOf(51, 48), { collection: count(10), date: '2020-01-01' });
  const lower = subject(2, fuzzyOf(51, 46), { collection: count(1000000), date: '1980-01-01' });
  assert.equal(similarity(query, best.name), 0.94);
  assert.equal(similarity(query, lower.name), 0.9);
  assert.equal(select(query, [lower, best]).selected.id, 1);
});

test('within the three-point score cohort popularity can outweigh a modest score difference', () => {
  const query = queryOf(51);
  const best = subject(1, fuzzyOf(51, 48), { collection: count(10), date: '1990-01-01' });
  const popular = subject(2, fuzzyOf(51, 47), { collection: count(1000), date: '2020-01-01' });
  const outside = subject(3, fuzzyOf(51, 46), { collection: count(1000000), date: '1980-01-01' });
  assert.equal(similarity(query, popular.name), 0.92);
  const result = select(query, [outside, best, popular]);
  assert.equal(result.selected.id, 2);
  assert.equal(result.selectedMatch, 0.92);
  assert.equal(result.selectionReason, 'similarity-popularity-date');
});

test('exactly three score points are included despite floating point subtraction', () => {
  const query = queryOf(101);
  const best = subject(1, fuzzyOf(101, 98), { collection: count(1) });
  const popular = subject(2, fuzzyOf(101, 95), { collection: count(1000) });
  assert.equal(similarity(query, best.name), 0.97);
  assert.equal(similarity(query, popular.name), 0.94);
  assert.equal(select(query, [best, popular]).selected.id, 2);
});

test('the newest valid date wins within the inclusive90 percent popularity band', () => {
  const recent = subject(1, 'Canonical', { collection: count(1000), date: '2000-01-01' });
  const older = subject(2, 'Canonical', { collection: count(900), date: '2024-01-01' });
  const tooUnpopular = subject(3, 'Canonical', { collection: count(899), date: '2025-01-01' });
  assert.equal(select('Canonical', [recent, tooUnpopular, older]).selected.id, 2);
});

test('missing, invalid, and overflowing counts do not masquerade as popularity', () => {
  const candidates = [
    subject(1, 'Canonical', { date: '1980-01-01' }),
    subject(2, 'Canonical', {
      collection: { collect: -2, wish: NaN, doing: Infinity, on_hold: 'bad' },
      date: '1980-01-01'
    }),
    subject(3, 'Canonical', { collection: { collect: 1e308, wish: 1e308 }, date: '1980-01-01' }),
    subject(4, 'Canonical', {
      collection: { collect: '4', wish: 3, doing: 2, on_hold: 1, dropped: 1 },
      date: '2020-01-01'
    })
  ];
  const result = select('Canonical', candidates);
  assert.equal(result.selected.id, 4);
  const totals = new Map(result.candidates.map((item) => [item.id, item.collection_total]));
  assert.equal(totals.get(1), 0);
  assert.equal(totals.get(2), 0);
  assert.equal(totals.get(3), 0);
  assert.equal(totals.get(4), 11);
});

test('when every count is missing or invalid chronology still picks the newest valid date', () => {
  const candidates = [
    subject(1, 'Canonical', { date: 'not-a-date' }),
    subject(2, 'Canonical', { collection: { collect: -1 }, date: '2000-01-01' }),
    subject(3, 'Canonical', { date: '1990-01-01' })
  ];
  assert.equal(select('Canonical', candidates).selected.id, 2);
});

test('invalid and impossible dates sort after valid dates, then use deterministic count/score/id ties', () => {
  const candidates = [
    subject(1, 'Canonical', { collection: count(100), date: '1900-02-30' }),
    subject(2, 'Canonical', { collection: count(95), date: '1990-01-01' }),
    subject(3, 'Canonical', { collection: count(100), date: 'bad' })
  ];
  assert.equal(select('Canonical', candidates).selected.id, 2);
  assert.equal(select('Canonical', [candidates[0], candidates[2]]).selected.id, 1);
  const sameDate = [
    subject(7, 'Canonical', { collection: count(95), date: '2000-01-01' }),
    subject(8, 'Canonical', { collection: count(100), date: '2000-01-01' })
  ];
  assert.equal(select('Canonical', sameDate).selected.id, 8);
});

test('same-date and same-count ties use score before lowest id', () => {
  const query = queryOf(51);
  const weaker = subject(1, fuzzyOf(51, 47), { collection: count(100), date: '2000-01-01' });
  const stronger = subject(2, fuzzyOf(51, 48), { collection: count(100), date: '2000-01-01' });
  assert.equal(select(query, [weaker, stronger]).selected.id, 2);
  const duplicateScore = subject(3, stronger.name, { collection: count(100), date: '2000-01-01' });
  assert.equal(select(query, [duplicateScore, stronger]).selected.id, 2);
});

test('complete recall compares exact and nearby fuzzy matches by popularity and date', () => {
  const query = queryOf(51);
  const exact = subject(1, query, { collection: count(1), date: '2020-01-01' });
  const fuzzy = subject(2, fuzzyOf(51, 50), { collection: count(1000000), date: '1980-01-01' });
  assert.equal(similarity(query, fuzzy.name), 0.98);
  const result = select(query, [fuzzy, exact]);
  assert.equal(result.selected.id, 2);
  assert.equal(result.selectedMatch, 0.98);
  assert.equal(result.selectionReason, 'similarity-popularity-date');
});

test('exact ties still follow near-maximum popularity and newest release date', () => {
  const candidates = [
    subject(1, 'AIR', { collection: count(1000), date: '2000-09-08' }),
    subject(2, 'AIR', { collection: count(900), date: '2020-01-01' }),
    subject(3, 'AIR', { collection: count(899), date: '2025-01-01' })
  ];
  assert.equal(select('air', candidates).selected.id, 2);
});

test('wrong categories and malformed subject ids cannot win regardless of exact score or popularity', () => {
  const correct = subject(8, 'AIR', { collection: count(1) });
  const result = select('AIR', [
    null,
    subject(-1, 'AIR'),
    subject('1', 'AIR'),
    subject(NaN, 'AIR'),
    subject(1.5, 'AIR'),
    subject(2, 'AIR', { type: 4, collection: count(99999999) }),
    correct
  ]);
  assert.equal(result.selected.id, 8);
  assert.deepEqual(
    result.candidates.map((item) => item.id),
    [8]
  );
});

test('explicit installment evidence excludes first and wrong numbered seasons even when more popular', () => {
  const candidates = [
    subject(1, 'Horizon', { collection: count(9999999) }),
    subject(2, 'Horizon 3', { collection: count(9999999) }),
    subject(3, 'Horizon 2', { aliases: ['Horizon II'], collection: count(10) })
  ];
  assert.equal(select('Horizon 2', candidates).selected.id, 3);
  assert.equal(select('Horizon II', candidates).selected.id, 3);
  assert.equal(select('Horizon 2', candidates.slice(0, 2)).selected, null);
});

test('conflicting bilingual identities cannot be settled with popularity or age', () => {
  const titleGroups = [{ whole: 'Blue Horizon 青空', parts: ['Blue Horizon', '青空'] }];
  const candidates = [
    subject(1, 'Blue Horizon', { collection: count(9999999), date: '1980-01-01' }),
    subject(2, '青空', { collection: count(9999999), date: '1980-01-01' })
  ];
  const hits = new Map([
    [1, new Set([normalize('Blue Horizon')])],
    [2, new Set([normalize('青空')])]
  ]);
  const result = rankImportSubjects(['Blue Horizon', '青空'], candidates, [2], {
    titleGroups,
    queryHits: hits
  });
  assert.equal(result.selected, null);
  assert.equal(result.selectedMatch, null);
  assert.ok(result.candidates.every((item) => item.match === 1));
});

test('bilingual parts require independent query hits, while the complete official whole title suffices', () => {
  const titleGroups = [{ whole: 'Blue Horizon 青空', parts: ['Blue Horizon', '青空'] }];
  const pair = subject(1, 'Blue Horizon', { name_cn: '青空' });
  const missing = new Map([[1, new Set([normalize('Blue Horizon')])]]);
  assert.equal(
    rankImportSubjects(['Blue Horizon', '青空'], [pair], [2], { titleGroups, queryHits: missing })
      .selected,
    null
  );
  const supported = new Map([[1, new Set([normalize('Blue Horizon'), normalize('青空')])]]);
  assert.equal(
    rankImportSubjects(['Blue Horizon', '青空'], [pair], [2], { titleGroups, queryHits: supported })
      .selected.id,
    1
  );
  const whole = subject(2, 'Blue Horizon 青空');
  assert.equal(
    rankImportSubjects(['Blue Horizon 青空'], [whole], [2], { titleGroups, queryHits: new Map() })
      .selected.id,
    2
  );
});

test('bounded recall keeps verified exact matches but blocks fuzzy selection', () => {
  const exact = select('AIR', [subject(1, 'AIR', { collection: count(999999) })], {
    complete: false
  });
  assert.equal(exact.selected.id, 1);
  assert.equal(exact.selectedMatch, 1);
  const result = select('Moonlit Symphony', [subject(2, 'Moonlit Symphonies')], {
    complete: false
  });
  assert.equal(result.selected, null);
  assert.equal(result.selectedMatch, null);
  assert.equal(result.selectionReason, 'incomplete-recall');
  assert.ok(result.candidates[0].match > IMPORT_MIN_CONFIDENCE);
});

test('the winner is selected before the ten-row display limit and is guaranteed visible', () => {
  const candidates = Array.from({ length: 500 }, (_, i) =>
    subject(i + 1, 'Canonical', {
      collection: count(100),
      date: i === 399 ? '2025-01-01' : '2000-01-01'
    })
  );
  const result = select('Canonical', candidates);
  assert.equal(result.selected.id, 400);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.candidates[0].id, 400);
  assert.equal(result.selectedMatch, 1);
});

test('large exact tie groups are deterministic across reversed and rotated input orders', () => {
  const candidates = Array.from({ length: 1200 }, (_, i) =>
    subject(i + 1, 'Canonical', {
      collection: count(100),
      date: i >= 999 ? '2025-01-01' : '2000-01-01'
    })
  );
  for (const order of [
    candidates,
    [...candidates].reverse(),
    [...candidates.slice(700), ...candidates.slice(0, 700)]
  ]) {
    const result = select('Canonical', order);
    assert.equal(result.selected.id, 1000);
    assert.equal(result.candidates[0].id, 1000);
    assert.equal(result.candidates.length, 10);
  }
});

test('generic names, subtitle shortcuts, and empty candidates cannot bypass the import threshold', () => {
  assert.equal(select('CG', [subject(1, 'CG')]).selected, null);
  assert.equal(select('Canonical', []).selected, null);
  const subtitle = subject(2, 'Canonical: A Very Long Unrelated Subtitle', {
    collection: count(100000)
  });
  assert.ok(similarity('Canonical', subtitle.name) < 0.85);
  assert.equal(select('Canonical', [subtitle]).selected, null);
  // Ordinary matching intentionally retains its preexisting popular-subtitle shortcut.
  assert.equal(rankSubjects(['Canonical'], [subtitle], [2]).selected.id, 2);
});

test('short Chinese full names admit attached Latin names and delimited taglines', () => {
  for (const [query, name] of [
    ['常轨脱离', '常轨脱离Creative'],
    ['亚托莉', '亚托莉 -我挚爱的时光-']
  ]) {
    const result = select(query, [subject(1, name)]);
    assert.equal(result.selected?.id, 1, name);
    assert.equal(result.selectedMatch, 0.97, name);
    assert.equal(select(query, [subject(1, name)], { complete: false }).selected, null);
    for (const suffix of [' 2', ' III', ' Season 2', ' 剧场版', ' After Story', ' 续'])
      assert.equal(select(query, [subject(1, name + suffix, { aliases: [name] })]).selected, null);
  }
  assert.equal(select('常轨脱离', [subject(1, '常轨脱离凸')]).selected, null);
  assert.equal(select('常轨脱离', [subject(1, '常轨脱离III')]).selected, null);
  assert.equal(
    select('英雄传说', [subject(1, '英雄传说6：空之轨迹', { aliases: ['英雄传说：空之轨迹'] })])
      .selected,
    null
  );
});

test('explicit series intent permits only the full base with a verified numbered installment', () => {
  const mobile = subject(453293, 'Legend of Heroes', { name_cn: '英雄传说', collection: count(2) });
  const installment = subject(260, '英雄伝説VI 空の軌跡', {
    name_cn: '英雄传说6：空之轨迹',
    collection: count(4000)
  });
  assert.equal(select('英雄传说', [mobile, installment]).selected?.id, 453293);
  const result = select('英雄传说', [mobile, installment], { series: true });
  assert.equal(result.selected?.id, 260);
  assert.equal(result.selectedMatch, 0.97);
  assert.equal(select('英雄传说', [installment], { series: true, complete: false }).selected, null);
  assert.equal(
    select('英雄传说', [subject(9, '新英雄传说6：空之轨迹')], { series: true }).selected,
    null
  );
});

test('explicit installment evidence survives a subtitle after the number', () => {
  const game = subject(410290, 'ARMORED CORE VI FIRES OF RUBICON', {
    aliases: ['装甲核心6 境界天火', 'Armored Core 6 Fires of Rubicon']
  });
  assert.equal(select('装甲核心6', [game]).selected?.id, 410290);
  assert.equal(select('装甲核心6', [game]).selectedMatch, 0.97);
  assert.equal(select('装甲核心5', [game]).selected, null);
  assert.equal(select('装甲核心', [game]).selected, null);
});

test('duplicate ids are deduplicated and caller arrays and subjects are not mutated', () => {
  const weak = Object.freeze(subject(1, 'Something Else'));
  const exact = Object.freeze(subject(1, 'AIR', { collection: Object.freeze(count(100)) }));
  const subjects = Object.freeze([weak, exact]);
  const terms = Object.freeze(['AIR']);
  const types = Object.freeze([2]);
  const result = rankImportSubjects(terms, subjects, types);
  assert.equal(result.selected, exact);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(subjects, [weak, exact]);
  assert.deepEqual(terms, ['AIR']);
  assert.deepEqual(types, [2]);
});
