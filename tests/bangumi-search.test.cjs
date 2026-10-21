'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { searchSubjectPages } = require('../src/bangumi-search.cjs');
const row = (id, name = '其他作品', type = 2) => ({ id, name, type });

test('canonical animation at result ten survives recall and excludes games before exact detection', async () => {
  const calls = [];
  const result = await searchSubjectPages('宝可梦', [2], async (url, body) => {
    calls.push({ url, body });
    return {
      total: 194,
      limit: 20,
      data: [
        row(9, '宝可梦', 4),
        ...Array.from({ length: 8 }, (_, i) => row(i + 100)),
        { ...row(3019, 'ポケットモンスター'), name_cn: '宝可梦' },
        ...Array.from({ length: 10 }, (_, i) => row(i + 200))
      ]
    };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.filter.type, [2]);
  assert.match(calls[0].url, /limit=20&offset=0$/);
  assert.ok(result.data.some((s) => s.id === 3019));
  assert.ok(result.data.every((s) => s.type === 2));
  assert.equal(result.complete, false);
});

test('pagination advances by the actual returned size and finds a later main title', async () => {
  const offsets = [];
  const result = await searchSubjectPages('本体', [2], async (url) => {
    const offset = Number(new URL(url, 'https://api.bgm.tv').searchParams.get('offset'));
    offsets.push(offset);
    return {
      total: 30,
      limit: 8,
      offset,
      data:
        offset === 0
          ? Array.from({ length: 8 }, (_, i) => row(i + 1))
          : [row(3019, '本体'), ...Array.from({ length: 7 }, (_, i) => row(i + 20))]
    };
  });
  assert.deepEqual(offsets, [0, 8]);
  assert.ok(result.data.some((s) => s.id === 3019));
  assert.equal(result.complete, false);
});

test('fallback recall is bounded, includes popularity and deduplicates IDs', async () => {
  const calls = [];
  const result = await searchSubjectPages('罕见标题', [2, 4], async (url, body) => {
    calls.push({ url, body });
    const start = body.sort === 'heat' ? 200 : calls.length * 20;
    return { total: 1000, limit: 20, data: Array.from({ length: 20 }, (_, i) => row(start + i)) };
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.body.sort),
    ['match', 'match', 'heat']
  );
  assert.deepEqual(
    calls.map((c) => Number(new URL(c.url, 'https://api.bgm.tv').searchParams.get('offset'))),
    [0, 20, 0]
  );
  assert.ok(result.data.length <= 60);
  assert.equal(new Set(result.data.map((s) => s.id)).size, result.data.length);
  assert.equal(result.complete, false);
});

test('a complete single-result typed search retains proof of scoped uniqueness', async () => {
  let calls = 0;
  const result = await searchSubjectPages('16bit的感动', [2], async () => {
    calls++;
    return { total: 1, limit: 20, data: [row(413741, '16bit的感动 ANOTHER LAYER')] };
  });
  assert.equal(calls, 1);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.data.map((s) => s.id),
    [413741]
  );
});

test('duplicated first-page identities and contradictory totals cannot prove uniqueness', async () => {
  for (const total of [0, 2]) {
    const anime = row(413741, '16bit的感动 ANOTHER LAYER');
    const result = await searchSubjectPages('16bit的感动', [2], async () => ({
      total,
      limit: 20,
      offset: 0,
      data: total === 0 ? [anime] : [anime, anime]
    }));
    assert.equal(result.complete, false, `total ${total}`);
    assert.equal(result.data.length, 1);
  }
});

test('a repeated or empty relevance page still permits the reserved popularity recall', async () => {
  for (const repeated of [false, true]) {
    const calls = [],
      fillers = Array.from({ length: 20 }, (_, i) => row(i + 100));
    const result = await searchSubjectPages('宝可梦', [2], async (url, body) => {
      calls.push(body.sort);
      return {
        total: 100,
        limit: 20,
        offset: calls.length === 2 ? 20 : 0,
        data:
          body.sort === 'heat'
            ? [row(3019, '宝可梦')]
            : calls.length === 1 || repeated
              ? fillers
              : []
      };
    });
    assert.deepEqual(calls, ['match', 'match', 'heat']);
    assert.ok(result.data.some((s) => s.id === 3019));
    assert.equal(result.complete, false);
  }
});

test('malformed responses cannot masquerade as complete empty search pages', async () => {
  await assert.rejects(
    searchSubjectPages('16bit的感动', [2], async () => ({ error: 'bad response' })),
    /搜索响应/
  );
});

test('manual recall continues past an exact main title and preserves all-permitted NSFW filtering', async () => {
  const calls = [];
  const result = await searchSubjectPages(
    'AIR',
    [1, 2, 3, 4, 6],
    async (url, body) => {
      calls.push({ url, body });
      return {
        total: 200,
        data:
          body.sort === 'heat'
            ? [row(232, 'AIR', 4)]
            : Array.from({ length: 20 }, (_, i) =>
                row(calls.length * 100 + i, i ? '其他作品' : 'AIR')
              )
      };
    },
    { fullCandidates: true }
  );
  assert.deepEqual(
    calls.map((c) => c.body.sort),
    ['match', 'match', 'heat']
  );
  assert.deepEqual(
    calls.map((c) => Number(new URL(c.url, 'https://api.bgm.tv').searchParams.get('offset'))),
    [0, 20, 0]
  );
  assert.ok(calls.every((c) => !Object.hasOwn(c.body.filter, 'nsfw')));
  assert.ok(result.data.some((s) => s.id === 232 && s.type === 4));
  assert.equal(result.complete, false);
});

test('manual recall stops when scoped relevance pages are complete', async () => {
  let calls = 0;
  const result = await searchSubjectPages(
    'AIR',
    [4],
    async () => {
      calls++;
      return { total: 2, data: [row(232, 'AIR', 4), row(233, 'AIR alternative', 4)] };
    },
    { fullCandidates: true }
  );
  assert.equal(calls, 1);
  assert.equal(result.complete, true);
  assert.equal(result.data.length, 2);
});

test('a repeated page cannot establish completeness or loop indefinitely', async () => {
  let calls = 0;
  const result = await searchSubjectPages('16bit的感动', [2], async () => {
    calls++;
    return { total: 2, limit: 1, offset: 0, data: [row(413741, '16bit的感动 ANOTHER LAYER')] };
  });
  assert.ok(calls <= 3);
  assert.equal(result.complete, false);
});
