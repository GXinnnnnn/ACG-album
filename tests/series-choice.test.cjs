'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseSeriesSubject,
  rankSubjects,
  rankImportSubjects,
  rankVerifiedSeriesMembers
} = require('../src/matching.cjs');
const options = { verified: true, query: '星河花园', base: '星河花园' };
const member = (id, collect, score, date) => ({
  id,
  type: 4,
  name: `Stellar Garden ${id}`,
  name_cn: `星河花园${id}`,
  collection: { collect },
  rating: { score },
  date
});
function selectedAcrossOrders(items, expected) {
  for (const subjects of [items, [...items].reverse()])
    assert.equal(chooseSeriesSubject(subjects, options)?.id ?? null, expected);
}

test('a fivefold collection lead chooses the representative before rating or age', () => {
  selectedAcrossOrders([member(1, 10000, 6, '2000-01-01'), member(2, 1000, 10, '2025-01-01')], 1);
  selectedAcrossOrders([member(1, 10000, null, null), member(2, 2000, 10, '2025-01-01')], 1);
  selectedAcrossOrders([member(1, 9999, 6, '2000-01-01'), member(2, 2000, 9, '2025-01-01')], 2);
});

test('comparable collection counts prefer the unique highest rating when scores differ', () => {
  selectedAcrossOrders(
    [
      member(1, 10000, 7.5, '2025-01-01'),
      member(2, 8000, 8.5, '2000-01-01'),
      member(3, 1000, 10, '2026-01-01')
    ],
    2
  );
});

test('scores within inclusive 0.3 prefer the unique latest complete date', () => {
  selectedAcrossOrders(
    [member(1, 10000, 8.1, '2000-01-01'), member(2, 7000, 7.8, '2025-01-01')],
    2
  );
  selectedAcrossOrders(
    [member(1, 10000, 8.11, '2000-01-01'), member(2, 7000, 7.8, '2025-01-01')],
    1
  );
});

test('missing counts scores dates and unresolved ties remain unselected', () => {
  const good = member(1, 10000, 8.1, '2020-01-01');
  for (const count of [undefined, null, 0, -1, NaN, Infinity, '1000'])
    selectedAcrossOrders([good, member(2, count, 9, '2025-01-01')], null);
  for (const score of [undefined, null, 0, NaN, Infinity, '8.1'])
    selectedAcrossOrders([good, member(2, 8000, score, '2025-01-01')], null);
  for (const date of [undefined, null, '', '2025-02-30'])
    selectedAcrossOrders([good, member(2, 8000, 8, date)], null);
  selectedAcrossOrders([good, member(2, 8000, 8, good.date)], null);
  selectedAcrossOrders(
    [good, member(2, 8000, 8.1, '2025-01-01'), member(3, 9000, 7, '2026-01-01')],
    null
  );
});

test('representative choice requires separate series proof and an unqualified parent title', () => {
  const subjects = [member(1, 10000, 8, '2020-01-01'), member(2, 8000, 8, '2025-01-01')];
  assert.equal(chooseSeriesSubject(subjects), null);
  assert.equal(chooseSeriesSubject(subjects, { ...options, verified: false }), null);
  for (const query of [
    '星河花园2',
    '星河花园2025',
    '星河花园 第二部',
    '星河花园 外传',
    '星河花园：月之章'
  ])
    assert.equal(chooseSeriesSubject(subjects, { ...options, query }), null, query);
  for (const query of ['星河花园2', '星河花园2025', '星河花园 第二部', '星河花园 外传'])
    assert.equal(
      chooseSeriesSubject(subjects, { verified: true, query, base: query }),
      null,
      query
    );
  assert.equal(chooseSeriesSubject([subjects[0], { ...subjects[1], type: 2 }], options), null);
  assert.equal(
    chooseSeriesSubject(
      [subjects[0], { ...subjects[1], name: 'Stellar Garden After Story' }],
      options
    ),
    null
  );
  assert.equal(
    chooseSeriesSubject([subjects[0], { ...subjects[0], collection: { collect: 1 } }], options),
    null
  );
});

for (const rank of [rankSubjects, rankImportSubjects]) {
  test(`${rank.name} applies the series policy only after all candidates share the proven base`, () => {
    const first = { ...member(1, 10000, 7.5, '2025-01-01'), name_cn: '星河花园' };
    const second = member(2, 8000, 8.5, '2000-01-01');
    const select = (subjects, extra = {}) =>
      rank(['星河花园'], subjects, [4], { series: true, ...extra });
    assert.equal(rank(['星河花园'], [first, second], [4]).selected?.id, 1);
    assert.equal(select([first, second]).selected?.id, 2);
    assert.equal(select([{ ...first, rating: {} }, second]).selected, null);
    assert.equal(select([first, second], { complete: false }).selected?.id, 1);
    // An explicit installment retains its own identity even when another member dominates.
    assert.equal(rank(['星河花园2'], [first, second], [4], { series: true }).selected?.id, 2);
    const longBase = '星河花园的美丽长篇物语';
    const unrelated = {
      ...member(3, 9000, 10, '2026-01-01'),
      name_cn: longBase + '录',
      name: 'Different Garden'
    };
    assert.equal(
      rank([longBase], [{ ...first, name_cn: longBase }, unrelated], [4], { series: true }).selected
        ?.id,
      1
    );
  });
}

test('verified volume ranking runs the same collection and rating rules without bypassing query guards', () => {
  const members = [member(1, 10000, 7.5, '2025-01-01'), member(2, 8000, 8.5, '2000-01-01')].map(
    (subject, index) => ({ subject, volume: index + 1 })
  );
  assert.equal(rankVerifiedSeriesMembers(members, [4], options).selected?.id, 2);
  assert.equal(rankVerifiedSeriesMembers(members, [4]).selected, null);
  assert.equal(
    rankVerifiedSeriesMembers(members, [4], { ...options, query: '星河花园2' }).selected,
    null
  );
  assert.equal(
    rankVerifiedSeriesMembers([{ ...members[0] }, { ...members[1], volume: 1 }], [4], options)
      .selected,
    null
  );
});
