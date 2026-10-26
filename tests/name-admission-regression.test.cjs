'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchStages, normalize } = require('../src/model.cjs');
const { rankSubjects } = require('../src/matching.cjs');

const work = (id, name, fields = {}) => ({
  id,
  type: 2,
  name,
  collection: { collect: 10 },
  ...fields
});

const sequelStages = () => searchStages('系列名第二季 Series');
const stageOptions = (stage, subjects) => ({
  titleGroups: stage.titleGroups,
  queryHits: new Map(subjects.map((subject) => [subject.id, new Set(stage.terms.map(normalize))]))
});

test('identical names alone do not prove a franchise chronology', () => {
  const popular = work(11, 'Home', { collection: { collect: 4000 }, date: '2015-03-27' });
  const older = work(12, 'Home', { collection: { collect: 20 }, date: '2009-06-05' });
  assert.equal(rankSubjects(['Home'], [popular, older], [2]).selected.id, popular.id);
});

test('a bilingual base alias cannot erase an explicit sequel number', () => {
  const first = work(21, 'Series', {
    name_cn: '系列名',
    collection: { collect: 90000 },
    date: '2001-01-01'
  });
  const second = work(22, 'Series 2', { name_cn: '系列名第二季', date: '2004-01-01' });
  const [whole, split] = sequelStages();
  assert.deepEqual(whole.terms, ['系列名第二季 Series']);
  assert.equal(rankSubjects(whole.terms, [first, second], [2]).selected, null);
  assert.equal(
    rankSubjects(split.terms, [first, second], [2], stageOptions(split, [first, second])).selected
      ?.id,
    second.id
  );
});

test('an unnumbered translated alias needs positive evidence for the explicit installment', () => {
  const first = work(31, 'Series', { collection: { collect: 90000 }, date: '2001-01-01' });
  const second = work(32, 'Series 2', { name_cn: '系列名第二季', date: '2004-01-01' });
  const [whole, split] = sequelStages();
  const { terms } = split;
  const options = stageOptions(split, [first, second]);
  assert.equal(rankSubjects(whole.terms, [first, second], [2]).selected, null);
  assert.equal(rankSubjects(terms, [first], [2], options).selected, null);
  assert.equal(rankSubjects(terms, [first, second], [2], options).selected?.id, second.id);
  assert.equal(
    rankSubjects([...terms].reverse(), [second, first], [2], options).selected?.id,
    second.id
  );
  for (const missing of ['Series', '系列名第二季']) {
    const queryHits = new Map([
      [second.id, new Set(terms.filter((term) => term !== missing).map(normalize))]
    ]);
    assert.equal(rankSubjects(terms, [second], [2], { ...options, queryHits }).selected, null);
  }
  for (const candidate of [
    { ...second, name: 'Series 3' },
    { ...second, aliases: ['Series 3'] },
    { ...second, name: 'Different Series 2' }
  ])
    assert.equal(
      rankSubjects(terms, [candidate], [2], stageOptions(split, [candidate])).selected,
      null
    );
});

test('one exact sequel alias cannot hide a comparable contradictory installment alias', () => {
  const conflicting = work(41, 'Series 2', {
    name_cn: '系列名第二季',
    aliases: ['Series 3'],
    collection: { collect: 90000 }
  });
  const correct = work(42, 'Series 2', { name_cn: '系列名第二季', aliases: ['Series', '系列名'] });
  const terms = ['系列名第二季', 'Series 2', 'Series'];
  assert.equal(rankSubjects(terms, [conflicting], [2]).selected, null);
  assert.equal(rankSubjects(terms, [conflicting, correct], [2]).selected.id, correct.id);
  assert.equal(
    rankSubjects([...terms].reverse(), [correct, conflicting], [2]).selected.id,
    correct.id
  );
});

test('numbered evidence for one alias family cannot date-order a different unnumbered family', () => {
  const original = work(51, 'Alpha', {
    name_cn: 'Beta',
    collection: { collect: 90000 },
    date: '2001-01-01'
  });
  const sequel = work(52, 'Alpha II', { date: '2004-01-01' });
  const unrelated = work(53, 'Beta', { date: '1900-01-01' });
  assert.equal(
    rankSubjects(['Alpha', 'Beta'], [original, sequel, unrelated], [2]).selected.id,
    original.id
  );
});

test('a four-digit title year does not constrain an otherwise exact bilingual alias', () => {
  const original = work(61, 'Festival Original');
  assert.equal(
    rankSubjects(['Festival 2006', 'Festival Original'], [original], [2]).selected.id,
    original.id
  );
});
