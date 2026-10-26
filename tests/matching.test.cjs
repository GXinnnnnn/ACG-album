'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  searchPlan,
  searchTerms,
  searchStages,
  scoreSubject,
  newestImage
} = require('../src/model.cjs');
const { importOptions, SUBJECT_TYPES } = require('../src/matching-policy.cjs');
const {
  installment,
  collections,
  dateValue,
  rankSubjects,
  createSearchCache
} = require('../src/matching.cjs');
const subject = (id, name, extra = {}) => ({ id, name, type: 2, ...extra });

test('import input is whitelisted, explicit and limited to the four supported categories', () => {
  assert.deepEqual(importOptions(), {});
  assert.deepEqual(importOptions({ onlineMatch: false }), {
    onlineMatch: false,
    subjectTypes: SUBJECT_TYPES
  });
  assert.deepEqual(
    importOptions({
      onlineMatch: true,
      subjectTypes: [6, 2, 2, 1],
      path: 'injected',
      token: 'secret'
    }),
    { onlineMatch: true, subjectTypes: [1, 2, 6] }
  );
  for (const bad of [
    null,
    [],
    'true',
    { onlineMatch: 'false' },
    { onlineMatch: true },
    { onlineMatch: true, subjectTypes: [] },
    { onlineMatch: true, subjectTypes: [3] },
    { onlineMatch: false, subjectTypes: ['2'] },
    { subjectTypes: [2] }
  ])
    assert.throws(() => importOptions(bad));
});

test('complete title pairs survive noise while bracketed names remain deferred fallbacks', () => {
  const plan = searchPlan('[1080p] [白色相簿2] WHITE ALBUM 2 / ホワイトアルバム2 CG');
  assert.deepEqual(plan.terms, ['[1080p] [白色相簿2] WHITE ALBUM 2 / ホワイトアルバム2 CG']);
  const { terms } = plan.fallbacks[0];
  assert.ok(!terms.includes('白色相簿2'), JSON.stringify(plan));
  assert.ok(plan.fallbacks.some((fallback) => fallback.terms.includes('白色相簿2')));
  assert.ok(terms.includes('WHITE ALBUM 2'), JSON.stringify(terms));
  assert.ok(terms.includes('ホワイトアルバム2'), JSON.stringify(terms));
  assert.ok(terms.length <= 6 && terms.every((term) => term.length <= 160));
  assert.deepEqual(searchTerms('CG'), []);
  assert.deepEqual(searchTerms('screenshots'), []);
  assert.deepEqual(searchTerms('新建文件夹 (2)'), []);
});

test('numeric title prefixes survive cleanup without admitting truncated unrelated titles', () => {
  const unrelated = [
    subject(902, 'Sensation', { collection: { collect: 999999 } }),
    subject(903, 'bit', { collection: { collect: 999999 } }),
    subject(904, '的感动', { collection: { collect: 999999 } })
  ];
  for (const title of ['16bit Sensation', '16bit的感动', '3D Kanojo']) {
    const correct = subject(901, title);
    for (const input of [title, `[1080p] [10bit] ${title} [HDR10] [4K] [壁纸]`]) {
      const terms = searchStages(input).find((stage) => stage.terms.includes(title))?.terms;
      assert.ok(terms?.includes(title), JSON.stringify({ input, terms }));
      assert.equal(
        rankSubjects(terms, [...unrelated, correct], [2]).selected?.id,
        correct.id,
        input
      );
      assert.equal(rankSubjects(terms, unrelated, [2]).selected, null, input);
    }
  }
  assert.deepEqual(searchTerms('[1080p] [4K] [HDR10] [8bit] [10bit] [16bit]'), []);
});

test('complete slash titles retain exact matching evidence without admitting generic folder combinations', () => {
  const canonical = subject(91, 'Fate/stay night');
  const terms = searchStages('[1080p] Fate/stay night CG').at(-1).terms;
  assert.ok(terms.includes('Fate/stay night'), JSON.stringify(terms));
  assert.equal(scoreSubject(terms, canonical), 1);
  assert.equal(rankSubjects(terms, [canonical], [2]).selected.id, canonical.id);
  assert.deepEqual(searchTerms('pictures / images / wallpapers / CG'), []);
  assert.deepEqual(searchTerms('新建文件夹 (2) / screenshots'), []);
});

test('installment suffixes preserve complete years and recognize Chinese and separated Roman numbers', () => {
  for (const title of [
    'Festival 2006',
    'Festival2006',
    'Festival season 2006',
    'Festival 2006th season'
  ]) {
    assert.equal(installment(title).number, null, title);
  }
  assert.deepEqual(installment('Festival 2006'), { base: 'festival2006', number: null });
  for (const [suffix, number] of [
    ['第十二季', 12],
    ['第二十一季', 21],
    [' XII', 12],
    [' XXI', 21]
  ]) {
    assert.deepEqual(installment(`Test Saga${suffix}`), { base: 'testsaga', number });
    const broad = subject(92, 'Test Saga', { date: '2001-01-01', collection: { collect: 90000 } });
    const numbered = subject(93, `Test Saga${suffix}`, { date: '2020-01-01' });
    assert.equal(
      rankSubjects([numbered.name, broad.name], [broad, numbered], [2]).selected.id,
      numbered.id
    );
  }
  assert.equal(installment('Test SagaXII').number, null);
  assert.equal(installment('Test Saga IIX').number, null);
});

test('aliases count as title evidence; ratings and collection totals do not create confidence', () => {
  const alias = subject(1, 'Alias Original', {
    infobox: [{ key: '别名', value: [{ v: '月色真美' }] }]
  });
  assert.equal(scoreSubject(['月色真美'], alias), 1);
  const unrelated = subject(2, '完全无关的作品', {
    rating: { score: 10, total: 9999999 },
    collection: { collect: 9999999 }
  });
  assert.equal(rankSubjects(['月色真美'], [unrelated], [2]).selected, null);
  assert.equal(rankSubjects(['CG'], [subject(3, 'CG')], [2]).selected, null);
  assert.equal(
    collections({
      collection: { collect: 10, wish: 4, doing: 3, on_hold: 2, dropped: 1 },
      rating: { total: 999999 }
    }),
    20
  );
});

test('confidence precedes collections; equal credible titles prefer collection popularity', () => {
  const exact = subject(1, 'Steins Gate', { collection: { collect: 1 } });
  const fuzzy = subject(2, 'Steins Gata', { collection: { collect: 1000000 } });
  assert.equal(rankSubjects(['Steins Gate'], [fuzzy, exact], [2]).selected.id, 1);
  const popular = subject(3, 'Steins Gate', { collection: { collect: 100 } });
  assert.equal(rankSubjects(['Steins Gate'], [exact, popular], [2]).selected.id, 3);
  assert.equal(
    rankSubjects(
      ['Steins Gate'],
      [
        { ...exact, date: '1990-01-01' },
        { ...popular, date: '2020-01-01' }
      ],
      [2]
    ).selected.id,
    3
  );
});

test('a numbered sequel cannot displace the full unnumbered title on its date alone', () => {
  const latest = subject(1, 'Test Saga II', { date: '2020-01-01', collection: { collect: 10000 } });
  const earliest = subject(2, 'Test Saga', { date: '2001-02-03', collection: { collect: 1 } });
  const unknown = subject(3, 'Test Saga III', { date: '', collection: { collect: 20000 } });
  assert.equal(rankSubjects(['Test Saga'], [latest, unknown, earliest], [2]).selected.id, 2);
  const knownSequel = subject(4, 'Test Saga II', { date: '2004-01-01' });
  assert.equal(
    rankSubjects(['Test Saga'], [subject(5, 'Test Saga'), knownSequel], [2]).selected.id,
    5
  );
  const differentMedium = subject(6, 'Test Saga', {
    type: 4,
    date: '1900-01-01',
    collection: { collect: 1 }
  });
  assert.equal(
    rankSubjects(['Test Saga'], [latest, earliest, differentMedium], [2, 4]).selected.id,
    2
  );
  assert.equal(dateValue('2023-02-30'), Infinity);
  assert.equal(dateValue(''), Infinity);
});

test('an explicit installment cannot lose to an older broad title or a wrong category', () => {
  assert.deepEqual(installment('Test Saga 第二季'), { base: 'testsaga', number: 2 });
  assert.deepEqual(installment('Test Saga II'), { base: 'testsaga', number: 2 });
  const correct = subject(2, 'Test Saga 2', { date: '2020-01-01' });
  const older = subject(1, 'Test Saga', { date: '1990-01-01', collection: { collect: 999999 } });
  assert.equal(rankSubjects(['Test Saga 2'], [older, correct], [2]).selected.id, 2);
  assert.equal(rankSubjects(['Test Saga 2'], [older], [2]).selected, null);
  assert.equal(rankSubjects(['Test Saga 2', 'Test Saga'], [older, correct], [2]).selected.id, 2);
  assert.equal(
    rankSubjects(['Test Saga 2', '月色真美'], [{ ...older, name_cn: '月色真美' }], [2]).selected,
    null
  );
  assert.equal(rankSubjects(['Test Saga 2'], [{ ...correct, type: 4 }], [2]).selected, null);
  assert.equal(
    rankSubjects(['Test Saga 2'], [{ ...correct, id: '../escape' }], [2]).selected,
    null
  );
});

test('unique popular subtitle matching requires complete typed recall and full base coverage', () => {
  const anime = subject(413741, '16bitセンセーション ANOTHER LAYER', {
    name_cn: '16bit的感动 ANOTHER LAYER',
    infobox: [
      {
        key: '别名',
        value: [
          { v: '16位元的輝煌 Another Layer' },
          { v: '16bit Sensation: Another Layer' },
          { v: '16位的辉煌 Another Layer' }
        ]
      }
    ],
    collection: { collect: 10206 }
  });
  const book = subject(314759, '16bit的感动', { type: 1, collection: { collect: 999999 } });
  assert.equal(rankSubjects(['16bit的感动'], [book, anime], [2]).selected?.id, 413741);
  assert.equal(rankSubjects(['16bit的感动'], [anime], [2], { complete: false }).selected, null);
  for (const collection of [undefined, {}, { collect: 999 }, { collect: 'bad', wish: -2 }]) {
    assert.equal(rankSubjects(['16bit的感动'], [{ ...anime, collection }], [2]).selected, null);
  }
  assert.equal(rankSubjects(['16bit的感动'], [anime, { ...anime, id: 999 }], [2]).selected, null);
  assert.equal(
    rankSubjects(['16bit的感动'], [anime, subject(998, '其他作品')], [2]).selected,
    null
  );
  assert.equal(rankSubjects(['16bit的感动'], [{ ...anime, type: 4 }], [2]).selected, null);
  for (const name_cn of [
    '16bit的感动ANOTHER LAYER',
    '16bit的感动者 ANOTHER LAYER',
    '的感动 ANOTHER LAYER',
    '完全无关 ANOTHER LAYER'
  ]) {
    assert.equal(
      rankSubjects(['16bit的感动'], [{ ...anime, name: name_cn, name_cn }], [2]).selected,
      null,
      name_cn
    );
  }
});

test('subtitle relaxation never removes explicit installment or marked sequel and spinoff evidence', () => {
  const popular = (suffix) =>
    subject(413741, `16bit的感动 ${suffix}`, { collection: { collect: 999999 } });
  for (const suffix of [
    'II ANOTHER LAYER',
    '第2季 ANOTHER LAYER',
    'ANOTHER LAYER Season 2',
    'ANOTHER LAYER 2',
    'ANOTHER LAYER Movie',
    '劇場版 ANOTHER LAYER',
    'ANOTHER LAYER OVA',
    'SPIN-OFF ANOTHER LAYER',
    'Season II ANOTHER LAYER',
    'Second Season ANOTHER LAYER'
  ]) {
    assert.equal(rankSubjects(['16bit的感动'], [popular(suffix)], [2]).selected, null, suffix);
    assert.equal(
      rankSubjects(
        ['16bit的感动'],
        [{ ...popular(suffix), aliases: ['16bit的感动 ANOTHER LAYER'] }],
        [2]
      ).selected,
      null,
      `alias must not erase ${suffix}`
    );
  }
  assert.equal(
    rankSubjects(['16bit的感动 第二季', '16bit的感动'], [popular('ANOTHER LAYER')], [2]).selected,
    null
  );
});

test('an exact official main title precedes a more popular derivative using its broad alias', () => {
  const original = subject(3019, 'ポケットモンスター', {
    name_cn: ' 宝可梦 ',
    date: '1997-04-01',
    collection: { collect: 8511 }
  });
  const derivative = subject(99, '宝可梦 旅途', {
    aliases: ['宝可梦'],
    collection: { collect: 999999 }
  });
  const ranked = rankSubjects(['宝可梦'], [derivative, original], [2]);
  assert.equal(ranked.selected?.id, 3019);
  assert.equal(ranked.candidates[0].id, 3019);
});

test('query cache coalesces normalized requests, separates categories, bounds memory and retries errors', async () => {
  const cache = createSearchCache({ limit: 2 });
  let calls = 0;
  const load = async () => ++calls;
  const first = cache.get('ＡＢ title', [2, 4], load);
  assert.equal(first, cache.get('ab-title', [4, 2], load));
  assert.equal(await first, 1);
  assert.equal(await cache.get('ab-title', [1], load), 2);
  await cache.get('third', [2], load);
  assert.equal(cache.size, 2);
  await assert.rejects(
    cache.get('failure', [2], async () => {
      throw new Error('offline');
    }),
    /offline/
  );
  assert.equal(await cache.get('failure', [2], load), 4);
  let clock = 0;
  const ttlCache = createSearchCache({ ttl: 10, now: () => clock });
  await ttlCache.get('ttl', [2], load);
  clock = 11;
  await ttlCache.get('ttl', [2], load);
  assert.equal(calls, 6);
});

test('newest image reducer ignores name precedence and breaks equal-time ties deterministically', () => {
  const oldIcon = { id: 'a', name: 'folder.ico', sortkey: 'folder.ico', mtime: 1 };
  const latest = { id: 'b', name: 'z.jpg', sortkey: 'z.jpg', mtime: 20 };
  assert.equal(newestImage(oldIcon, latest), latest);
  const tied = { id: 'c', name: 'a.jpg', sortkey: 'a.jpg', mtime: 20 };
  assert.equal(newestImage(latest, tied), tied);
  assert.equal(newestImage(tied, latest), tied);
});

test('native import cancellation has no scan side effects and only passes sanitized options', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
  const block = source.slice(
    source.indexOf("  ipcMain.handle('library:import'"),
    source.indexOf("  ipcMain.handle('library:refresh'")
  );
  let handler,
    canceled = true;
  const calls = [];
  vm.runInNewContext(block, {
    ipcMain: {
      handle: (_, fn) => {
        handler = fn;
      }
    },
    win: {},
    require: (name) => {
      assert.equal(name, './matching-policy.cjs');
      return { importOptions };
    },
    dialog: { showOpenDialog: async () => ({ canceled, filePaths: ['C:\\fixture'] }) },
    call: (...args) => {
      calls.push(args);
      return 'scanned';
    }
  });
  assert.equal(await handler(null, { onlineMatch: false }), null);
  assert.equal(calls.length, 0);
  canceled = false;
  assert.equal(
    await handler(null, { onlineMatch: true, subjectTypes: [4], token: 'injected', path: 'bad' }),
    'scanned'
  );
  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([['scan', { path: 'C:\\fixture', onlineMatch: true, subjectTypes: [4] }]])
  );
});
