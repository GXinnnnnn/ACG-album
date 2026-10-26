'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchPlan, searchTerms, searchStages, normalize } = require('../src/model.cjs');
const { rankSubjects } = require('../src/matching.cjs');

const chinese = '天选庶民的真命之选';
const japanese = 'セレクトオブリージュ';
const title = chinese + japanese;
const game = { id: 456680, type: 4, name: japanese, name_cn: chinese };
const hits = (subjects, parts = [chinese, japanese]) =>
  new Map(subjects.map((s) => [s.id, new Set(parts.map(normalize))]));

// This fixture describes the reported official subject; all requests are mocked
// in worker tests. The release live probe records actual anonymous API evidence.
test('unseparated, reversed and delimited bilingual names yield independent bounded queries', () => {
  for (const input of [
    title,
    japanese + chinese,
    chinese + ' ' + japanese,
    chinese + ' / ' + japanese,
    '[1080p] ' + chinese + '_' + japanese + ' [CG]'
  ]) {
    const stages = searchStages(input);
    const whole =
      input === '[1080p] ' + chinese + '_' + japanese + ' [CG]'
        ? '[1080p] ' + chinese + '_' + japanese
        : input;
    assert.deepEqual(stages[0], { terms: [whole], titleGroups: [] });
    assert.equal(rankSubjects(stages[0].terms, [game], [4]).selected, null);
    const plan = stages.find((stage) =>
      stage.titleGroups.some(
        (group) => group.parts.includes(chinese) && group.parts.includes(japanese)
      )
    );
    assert.ok(plan, input);
    assert.ok(plan.terms.includes(chinese), JSON.stringify(plan));
    assert.ok(plan.terms.includes(japanese), JSON.stringify(plan));
    assert.ok(plan.terms.length <= 6 && plan.terms.every((t) => t.length <= 160));
    assert.equal(
      rankSubjects(plan.terms, [game], [4], {
        titleGroups: plan.titleGroups,
        queryHits: hits([game])
      }).selected?.id,
      game.id,
      input
    );
  }
  assert.ok(searchTerms(title).includes(title));
});

test('parenthetical original names are deferred rather than competing with the main title', () => {
  const plan = searchPlan(chinese + '（' + japanese + '）');
  assert.deepEqual(plan.terms, [chinese]);
  assert.deepEqual(plan.titleGroups, []);
  assert.deepEqual(plan.fallbacks, [{ terms: [japanese], titleGroups: [] }]);
  assert.equal(rankSubjects(plan.terms, [game], [4]).selected?.id, game.id);
});

test('complete Chinese-English pairs need both retrieved official names, while embedded English is intact', () => {
  const original = { id: 240, type: 2, name: 'Cowboy Bebop', name_cn: '星际牛仔' };
  const plan = searchPlan('星际牛仔 Cowboy Bebop');
  const options = {
    titleGroups: plan.titleGroups,
    queryHits: hits([original], ['星际牛仔', 'Cowboy Bebop'])
  };
  assert.equal(rankSubjects(plan.terms, [original], [2], options).selected?.id, original.id);
  assert.equal(
    rankSubjects(plan.terms, [original], [2], {
      ...options,
      queryHits: hits([original], ['Cowboy Bebop'])
    }).selected,
    null
  );
  const mixed = searchPlan('魔法少女English的日常');
  assert.deepEqual(mixed.terms, ['魔法少女English的日常']);
  assert.equal(
    rankSubjects(mixed.terms, [{ id: 11, type: 2, name: 'English' }], [2]).selected,
    null
  );
});

test('bilingual identity requires both independent retrieval and official title evidence', () => {
  const plan = searchPlan(title);
  const options = { titleGroups: plan.titleGroups, queryHits: hits([game]) };
  assert.equal(rankSubjects(plan.terms, [game], [4], options).selected?.id, game.id);
  assert.equal(rankSubjects(plan.terms, [game], [2], options).selected, null);
  assert.equal(
    rankSubjects(plan.terms, [game], [4], {
      ...options,
      queryHits: hits([game], [japanese])
    }).selected,
    null
  );
  assert.equal(
    rankSubjects(plan.terms, [{ ...game, name_cn: '其他作品' }], [4], options).selected,
    null
  );
  assert.equal(
    rankSubjects(plan.terms, [{ ...game, name_cn: '', aliases: [chinese] }], [4], options).selected
      ?.id,
    game.id
  );
});

test('conflicting exact bilingual identities cannot be resolved by popularity or date', () => {
  const plan = searchPlan(title);
  const a = { id: 1, type: 4, name: chinese, date: '1990-01-01', collection: { collect: 9999999 } };
  const b = { id: 2, type: 4, name: japanese, date: '2024-01-01' };
  assert.equal(
    rankSubjects(plan.terms, [a, b], [4], {
      titleGroups: plan.titleGroups,
      queryHits: hits([a, b])
    }).selected,
    null
  );
  const duplicate = { ...game, id: 99, collection: { collect: 9999999 } };
  assert.equal(
    rankSubjects(plan.terms, [game, duplicate], [4], {
      titleGroups: plan.titleGroups,
      queryHits: hits([game, duplicate])
    }).selected,
    null
  );
});

test('a Japanese script boundary never authorizes binding a title fragment', () => {
  const original = { id: 90, type: 2, name: '機動戦士ガンダム' };
  const plan = searchPlan(original.name);
  const fragments = [
    { id: 91, type: 2, name: '機動戦士', collection: { collect: 9999999 } },
    { id: 92, type: 2, name: 'ガンダム', collection: { collect: 9999999 } }
  ];
  const options = { titleGroups: plan.titleGroups, queryHits: hits(fragments, plan.terms) };
  assert.ok(plan.terms.includes(original.name));
  assert.equal(rankSubjects(plan.terms, fragments, [2], options).selected, null);
  assert.equal(
    rankSubjects(plan.terms, [...fragments, original], [2], options).selected?.id,
    original.id
  );
  for (const title of ['彼女は友達です', '天気の子', '東京リベンジャーズ'])
    assert.deepEqual(searchPlan(title).titleGroups, [], title);
});

test('bilingual consensus cannot erase explicit installments or admit a wrong sequel', () => {
  const plan = searchPlan(chinese + '2' + japanese + '2');
  const sequel = { ...game, id: 456681, name: japanese + '2', name_cn: chinese + '2' };
  const options = { titleGroups: plan.titleGroups, queryHits: hits([game, sequel], plan.terms) };
  assert.equal(rankSubjects(plan.terms, [game], [4], options).selected, null);
  assert.equal(rankSubjects(plan.terms, [game, sequel], [4], options).selected?.id, sequel.id);
});
