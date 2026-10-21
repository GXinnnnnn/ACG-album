'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rankCharacters,
  parseCharacterId,
  firstImage,
  searchCharacterPages
} = require('../src/character-matching.cjs');
test('characters require a unique exact canonical or independently supplied alias', () => {
  assert.equal(rankCharacters('綾波レイ', [{ id: 1, name: '綾波レイ' }]).selected.id, 1);
  assert.equal(
    rankCharacters('绫波丽', [
      { id: 1, name: '綾波レイ', infobox: [{ key: '别名', value: [{ v: '绫波丽' }] }] }
    ]).selected.id,
    1
  );
  assert.equal(
    rankCharacters('rei', [
      { id: 1, name: 'Rei' },
      { id: 2, name: 'REI' }
    ]).selected,
    null
  );
  assert.equal(rankCharacters('Rei', [{ id: 1, name: 'Rei Ayanami' }]).selected, null);
  assert.equal(rankCharacters('A.B', [{ id: 1, name: 'AB' }]).selected, null);
  assert.equal(rankCharacters('Rei', [{ id: 1, name: 'Rei', kind: 'subject' }]).selected, null);
  assert.equal(rankCharacters('Rei', [{ id: 1, name: 'Rei' }], { complete: false }).selected, null);
  assert.equal(
    rankCharacters('Rei', [
      { id: 1, name: 'Rei' },
      { id: 1, name: 'Rei' }
    ]).selected.id,
    1
  );
});
test('character URL parser rejects subject, foreign and unsafe IDs', () => {
  assert.equal(parseCharacterId('https://bgm.tv/character/123'), 123);
  assert.equal(parseCharacterId('123'), 123);
  for (const value of [
    'https://bgm.tv/subject/123',
    'https://evil.test/character/123',
    '0',
    '-1',
    '9007199254740992'
  ])
    assert.throws(() => parseCharacterId(value));
});
test('local fallback uses natural name order, ignores videos and modification times', () => {
  const rows = [
    { id: 'c', name: '10.jpg', kind: 'image', mtime: 1000 },
    { id: 'b', name: '2.png', kind: 'image', mtime: 2000 },
    { id: 'a', name: '1.jpg', kind: 'image', mtime: 1 },
    { id: 'v', name: '0.mp4', kind: 'video' }
  ];
  assert.equal(rows.reduce(firstImage, null).id, 'a');
  assert.equal(rows.toReversed().reduce(firstImage, null).id, 'a');
});
test('character paginated search does not auto-select from truncated recall', async () => {
  let calls = 0;
  const result = await searchCharacterPages('Rei', async (endpoint, body) => {
    calls++;
    assert.equal(body.keyword, 'Rei');
    assert.match(endpoint, /search\/characters/);
    return {
      total: 100,
      data: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: i ? 'Other' : 'Rei' }))
    };
  });
  assert.equal(calls, 3);
  assert.equal(result.selected, null);
  assert.equal(result.truncated, true);
  const unique = await searchCharacterPages('Rei', async () => ({
    total: 1,
    data: [{ id: 9, name: 'Rei' }]
  }));
  assert.equal(unique.selected.id, 9);
});
test('duplicate character pages, duplicate or invalid IDs and contradictory pagination never auto-bind', async () => {
  const page = [
    { id: 1, name: 'Rei' },
    { id: 2, name: 'Other' }
  ];
  const repeats = await searchCharacterPages('Rei', async () => ({ total: 4, data: page }), {
    limit: 2
  });
  assert.equal(repeats.selected, null);
  assert.equal(repeats.candidates.length, 2);
  assert.equal(repeats.complete, false);
  for (const response of [
    {
      total: 2,
      data: [
        { id: 1, name: 'Rei' },
        { id: 1, name: 'Rei' }
      ]
    },
    {
      total: 2,
      data: [
        { id: 1, name: 'Rei' },
        { id: -2, name: 'Other' }
      ]
    },
    { total: 0, data: [{ id: 1, name: 'Rei' }] },
    { total: 3, data: [{ id: 1, name: 'Rei' }] },
    { total: 1, offset: 20, data: [{ id: 1, name: 'Rei' }] }
  ]) {
    const result = await searchCharacterPages('Rei', async () => response);
    assert.equal(result.selected, null);
    assert.equal(result.complete, false);
  }
  let index = 0;
  const shifting = await searchCharacterPages(
    'Rei',
    async () =>
      index++ ? { total: 3, data: [{ id: 3, name: 'Other' }] } : { total: 4, data: page },
    { limit: 2 }
  );
  assert.equal(shifting.selected, null);
  assert.equal(shifting.complete, false);
});
