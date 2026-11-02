'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lookupLearnedTitleBindings,
  LEARNED_BINDINGS_STATS
} = require('../src/learned-title-bindings.cjs');
const { rankKnownSubjects } = require('../src/matching.cjs');

test('reviewed manual bindings recover exact existing missed folder names without search', () => {
  assert.deepEqual(LEARNED_BINDINGS_STATS, { records: 157, names: 156, ambiguousNames: 1 });
  for (const [name, id, collect] of [
    ['Adorable Witch', 390830, 44],
    ['CLANNAD', 13, 7814],
    ['Riddle Joker', 231798, 5967],
    ['奥日Ori and the Will of the Wisps', 216896, 2017],
    ['巫师3The Witcher 3', 66198, 4491]
  ]) {
    const result = lookupLearnedTitleBindings(name, [4]);
    assert.equal(result.complete, true);
    assert.equal(result.ambiguous, false, name);
    assert.equal(result.subjects[0].id, id, name);
    assert.equal(result.subjects[0].collection.collect, collect);
    assert.equal(rankKnownSubjects(name, result.subjects, [4]).selected?.id, id, name);
  }
});

test('learned manual truth does not infer another spelling number or title category', () => {
  assert.equal(lookupLearnedTitleBindings('Ｒｉｄｄｌｅ・Ｊｏｋｅｒ', [4]).subjects[0].id, 231798);
  for (const query of ['Ridle Joker', '巫师4The Witcher 4', 'CLANNAD After Story'])
    assert.deepEqual(lookupLearnedTitleBindings(query, [4]).subjects, [], query);
  assert.deepEqual(lookupLearnedTitleBindings('CLANNAD', [2]).subjects, []);
  assert.deepEqual(lookupLearnedTitleBindings('CLANNAD', [3]).subjects, []);
  assert.deepEqual(lookupLearnedTitleBindings('x'.repeat(241), [4]).subjects, []);
});

test('a normalized manual name with two identities remains ambiguous before type filtering', () => {
  for (const types of [[2, 4], [2], [4]]) {
    const result = lookupLearnedTitleBindings('9－nine', types);
    assert.equal(result.ambiguous, true);
    assert.equal(result.complete, true);
    assert.ok(result.subjects.every((subject) => types.includes(subject.type)));
  }
  const result = lookupLearnedTitleBindings('9-nine', [2, 4]);
  assert.deepEqual(
    result.subjects.map((s) => s.id).sort((a, b) => a - b),
    [290856, 496973]
  );
  assert.equal(rankKnownSubjects('9-nine', result.subjects, [2, 4]).selected, null);
});

test('lookup exposes only subject name and collection fields and cannot mutate stored truth', () => {
  const first = lookupLearnedTitleBindings('CLANNAD', [4]);
  assert.deepEqual(Object.keys(first.subjects[0]).sort(), [
    'aliases',
    'collection',
    'id',
    'name',
    'name_cn',
    'type'
  ]);
  first.subjects[0].aliases.push('wrong alias');
  first.subjects[0].collection.collect = 999999;
  first.subjects[0].name = 'wrong title';
  const second = lookupLearnedTitleBindings('CLANNAD', [4]);
  assert.deepEqual(second.subjects[0].aliases, ['CLANNAD']);
  assert.equal(second.subjects[0].collection.collect, 7814);
  assert.equal(second.subjects[0].name, 'CLANNAD');
});
