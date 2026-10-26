'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const {
  normalize,
  idFor,
  searchTerms,
  searchPlan,
  searchStages,
  similarity,
  scoreSubject,
  parseSubjectId,
  thumbnailKey
} = require('../src/model.cjs');
test('Chinese and multilingual names normalize and match conservatively', () => {
  assert.equal(normalize('ＡＢＣ · 测试！'), 'abc测试');
  assert.equal(similarity('星际牛仔', '星际牛仔'), 1);
  assert.ok(similarity('星际牛仔', '星际牛仔 天国之扉') < 0.88);
  const terms = searchTerms('[4K] 星际牛仔 Cowboy Bebop [壁纸]');
  assert.ok(terms.some((t) => t.includes('星际牛仔')));
  assert.equal(scoreSubject(['星际牛仔'], { name_cn: '星际牛仔', name: 'カウボーイビバップ' }), 1);
  assert.ok(scoreSubject(['星际牛仔'], { name_cn: '星界的纹章' }) < 0.88);
});
test('Chinese album suffixes preserve the actual work name', () => {
  assert.deepEqual(searchTerms('假面骑士图片'), ['假面骑士图片']);
  assert.deepEqual(searchStages('假面骑士图片').at(-1).terms, ['假面骑士']);
  assert.deepEqual(searchTerms('崩坏3壁纸'), ['崩坏3壁纸']);
  assert.deepEqual(searchStages('崩坏3壁纸').at(-1).terms, ['崩坏3']);
  assert.ok(searchTerms('喜羊羊与灰太狼').includes('喜羊羊与灰太狼'));
});
test('complete single-language and embedded-language titles never yield fragments', () => {
  for (const title of [
    '星际牛仔',
    'Cowboy Bebop',
    'カウボーイビバップ',
    '彼女は友達です',
    '天気の子',
    '東京リベンジャーズ',
    '機動戦士ガンダム',
    '機動戦士ガンダムユニコーン',
    '新世紀エヴァンゲリオン',
    'とある科学の超電磁砲',
    '汉字English汉字',
    '汉字 English 汉字',
    'English汉字English',
    'とある科学のRailgun超電磁砲',
    'ラブライブ! School idol project',
    '魔法少女まどか☆マギカ Rebellion',
    '劇場版 Fate/stay night',
    '16bit Sensation',
    '16bit的感动',
    '3D Kanojo'
  ]) {
    assert.deepEqual(searchPlan(title), { terms: [title], titleGroups: [], fallbacks: [] }, title);
    assert.deepEqual(searchTerms(title), [title], title);
  }
});

test('two complete title phrases retain the whole query and independent identity groups', () => {
  const chinese = '天选庶民的真命之选';
  const japanese = 'セレクトオブリージュ';
  const english = 'Select Oblige';
  const mixedJapanese = '蒼の彼方のフォーリズム';
  for (const [left, right, separator] of [
    [chinese, japanese, ''],
    [japanese, chinese, ''],
    [chinese, japanese, ' '],
    [japanese, chinese, ' '],
    [chinese, japanese, ' / '],
    [japanese, chinese, ' | '],
    [chinese, japanese, '_'],
    [chinese, japanese, ' — '],
    ['苍之彼方的四重奏', mixedJapanese, ' '],
    [mixedJapanese, '苍之彼方的四重奏', ' / '],
    ['星际牛仔', 'Cowboy Bebop', ''],
    ['Cowboy Bebop', '星际牛仔', ''],
    ['星际牛仔', 'Cowboy Bebop', ' '],
    ['Cowboy Bebop', '星际牛仔', ' '],
    ['命运石之门', 'Steins;Gate', ' '],
    ['命运石之门', 'Steins;Gate', ' / '],
    ['Steins;Gate', '命运石之门', ' / '],
    [chinese, english, ' / '],
    [english, chinese, ' - '],
    [chinese + '2', japanese + '2', '']
  ]) {
    const whole = left + separator + right;
    assert.deepEqual(
      searchPlan(whole),
      {
        terms: [whole, left, right],
        titleGroups: [{ whole, parts: [left, right] }],
        fallbacks: []
      },
      whole
    );
  }
});

test('three complete translated names retain independent identity evidence without fragmenting interleaved names', () => {
  const parts = ['白色相簿2', 'WHITE ALBUM 2', 'ホワイトアルバム2'];
  for (const separator of [' ', ' / ']) {
    const whole = parts.join(separator);
    assert.deepEqual(searchPlan(whole), {
      terms: [whole, ...parts],
      titleGroups: [{ whole, parts }],
      fallbacks: []
    });
  }
  assert.deepEqual(searchTerms('汉字 English 汉字'), ['汉字 English 汉字']);
});

test('short, interleaved and ambiguous script fragments are not invented as title pairs', () => {
  for (const title of [
    '汉字English',
    'English汉字',
    '天选庶民English真命之选',
    'セレクト天选庶民オブリージュ',
    '天选庶民の真命之选セレクトオブリージュ'
  ]) {
    assert.deepEqual(searchPlan(title), { terms: [title], titleGroups: [], fallbacks: [] }, title);
  }
});

test('trailing bracket noise is removed and leading annotations remain in the original stage', () => {
  const title = '星际牛仔';
  for (const note of [
    '(CG)',
    '（4K）',
    '[1080p]',
    '【CG 4K HDR10 10bit】',
    '{壁纸}',
    '「screenshots」',
    '『汉化版』',
    '〈完整版〉',
    '《web-dl》'
  ]) {
    for (const input of [note + ' ' + title, title + ' ' + note]) {
      assert.deepEqual(
        searchPlan(input),
        input.startsWith(title)
          ? { terms: [title], titleGroups: [], fallbacks: [] }
          : {
              terms: [input.normalize('NFKC')],
              titleGroups: [],
              fallbacks: [{ terms: [title], titleGroups: [] }]
            },
        input
      );
    }
  }
  assert.deepEqual(searchPlan('[1080p] [4K] [HDR10] [8bit] [10bit] [16bit]'), {
    terms: [],
    titleGroups: [],
    fallbacks: []
  });
});

test('meaningful bracket contents are exposed only as labeled-independent fallback plans', () => {
  for (const [open, close, label] of [
    ['(', ')', ''],
    ['（', '）', '原名：'],
    ['[', ']', '英文名: '],
    ['【', '】', '别名：'],
    ['{', '}', '別名:'],
    ['「', '」', 'original title: ']
  ]) {
    const input = `星际牛仔${open}${label}Cowboy Bebop${close}`;
    assert.deepEqual(searchPlan(input), {
      terms: ['星际牛仔'],
      titleGroups: [],
      fallbacks: [{ terms: ['Cowboy Bebop'], titleGroups: [] }]
    });
    assert.deepEqual(searchTerms(input), ['星际牛仔']);
  }
  assert.deepEqual(searchPlan('星际牛仔（日文名：カウボーイビバップ）'), {
    terms: ['星际牛仔'],
    titleGroups: [],
    fallbacks: [{ terms: ['カウボーイビバップ'], titleGroups: [] }]
  });
  assert.deepEqual(searchPlan('[白色相簿2] WHITE ALBUM 2'), {
    terms: ['[白色相簿2] WHITE ALBUM 2'],
    titleGroups: [],
    fallbacks: [
      { terms: ['WHITE ALBUM 2'], titleGroups: [] },
      { terms: ['白色相簿2'], titleGroups: [] }
    ]
  });
});

test('nested and malformed brackets retain useful fallbacks without leaking note text', () => {
  for (const input of [
    '星际牛仔 (原名: Cowboy Bebop [CG 4K])',
    '星际牛仔 (备注 [原名: Cowboy Bebop] [4K])',
    '星际牛仔 (备注: [原名: Cowboy Bebop] [4K])',
    '星际牛仔 (原名: Cowboy Bebop',
    '星际牛仔 [原名: Cowboy Bebop (4K]'
  ]) {
    assert.deepEqual(
      searchPlan(input),
      {
        terms: ['星际牛仔'],
        titleGroups: [],
        fallbacks: [{ terms: ['Cowboy Bebop'], titleGroups: [] }]
      },
      input
    );
  }
  assert.deepEqual(searchPlan('(Cowboy Bebop)'), {
    terms: [],
    titleGroups: [],
    fallbacks: [{ terms: ['Cowboy Bebop'], titleGroups: [] }]
  });
});

test('fallback plans retain complete title constraints even when queries are deduplicated or capped', () => {
  const whole = '天选庶民的真命之选セレクトオブリージュ';
  const parts = ['天选庶民的真命之选', 'セレクトオブリージュ'];
  assert.deepEqual(searchPlan(`主作品名称 (原名: ${whole})`), {
    terms: ['主作品名称'],
    titleGroups: [],
    fallbacks: [{ terms: [whole, ...parts], titleGroups: [{ whole, parts }] }]
  });
  const bounded = searchPlan(`主作品名称 (Alpha) (Bravo) (Charlie) (Delta) (${whole})`);
  assert.equal(bounded.fallbacks.at(-1).terms[0], whole);
  assert.deepEqual(bounded.fallbacks.at(-1).titleGroups, [{ whole, parts }]);
  const repeated = searchPlan('雾海来信 (雾海来信 Silver Meadow)');
  assert.deepEqual(repeated.fallbacks, [
    {
      terms: ['雾海来信 Silver Meadow', 'Silver Meadow'],
      titleGroups: [{ whole: '雾海来信 Silver Meadow', parts: ['雾海来信', 'Silver Meadow'] }]
    }
  ]);
});

test('bilingual fallback stages recover only previously queried evidence within the unique budget', () => {
  const main = '雾海来信',
    english = 'Silver Meadow',
    whole = `${main} ${english}`;
  const stages = searchStages(`${main} (${whole})`);
  assert.deepEqual(
    stages.map((stage) => stage.terms),
    [[main], [whole], [whole, english, main]]
  );
  assert.deepEqual(stages[2].titleGroups, [{ whole, parts: [main, english] }]);
  const capped = searchStages(`主作品名称 (Alpha) (Bravo) (Charlie) (Delta) (${whole})`);
  const queries = new Set(capped.flatMap((stage) => stage.terms.map(normalize)));
  assert.equal(queries.size, 6);
  assert.equal(queries.has(normalize(main)), false);
  assert.equal(queries.has(normalize(english)), false);
  assert.deepEqual(capped.at(-1).titleGroups, [{ whole, parts: [main, english] }]);
});

test('all query stages share a six-query budget and normalized duplicate exclusion', () => {
  const plan = searchPlan(
    '星际牛仔 Cowboy Bebop (星际牛仔) (ＣＯＷＢＯＹ ＢＥＢＯＰ) (日文名: カウボーイビバップ) (Alpha) (Bravo) (Charlie)'
  );
  const terms = [...plan.terms, ...plan.fallbacks.flatMap((fallback) => fallback.terms)];
  assert.equal(terms.length, 6);
  assert.equal(new Set(terms.map(normalize)).size, terms.length);
  assert.deepEqual(plan.terms, ['星际牛仔 Cowboy Bebop', '星际牛仔', 'Cowboy Bebop']);
  assert.deepEqual(plan.fallbacks, [
    { terms: ['カウボーイビバップ'], titleGroups: [] },
    { terms: ['Alpha'], titleGroups: [] },
    { terms: ['Bravo'], titleGroups: [] }
  ]);
  for (const input of [
    null,
    undefined,
    '',
    'CG',
    '新建文件夹 (2)',
    'pictures / images / wallpapers / CG'
  ]) {
    assert.deepEqual(searchPlan(input), { terms: [], titleGroups: [], fallbacks: [] });
  }
  assert.ok(searchPlan('A'.repeat(200)).terms.every((term) => term.length <= 160));
});

test('canonical slash titles and numeric titles survive cleanup and generic combinations stay suppressed', () => {
  for (const title of ['Fate/stay night', '16bit Sensation', '16bit的感动', '3D Kanojo']) {
    const input = `[1080p] [10bit] ${title} CG [HDR10] [4K] [壁纸]`;
    assert.deepEqual(searchTerms(input), [`[1080p] [10bit] ${title} CG`]);
    assert.deepEqual(searchStages(input).at(-1).terms, [title]);
  }
  assert.deepEqual(searchTerms('新建文件夹 (2) / screenshots'), []);
});

test('complete original titles precede translation splits and cleaned fallbacks', () => {
  const input = '雾海来信 Silver Meadow 2系列 (资源说明)';
  const stages = searchStages(input);
  assert.deepEqual(stages[0], {
    terms: ['雾海来信 Silver Meadow 2'],
    titleGroups: [],
    series: true
  });
  assert.ok(stages.slice(1).some((stage) => stage.terms.includes('Silver Meadow 2')));
  assert.deepEqual(searchTerms('CG World 游戏2'), ['CG World 游戏2']);
  assert.deepEqual(searchTerms('作品(序)正文系列'), ['作品(序)正文']);
  assert.deepEqual(searchTerms('系列中的故事'), ['系列中的故事']);
  assert.deepEqual(searchTerms('作品2 (原名: 另一作品)'), ['作品2']);
  assert.deepEqual(searchTerms('星际牛仔 ) [原名: Cowboy Bebop]'), ['星际牛仔 )']);
});

test('subject URLs use official HTTPS hosts and positive numeric ids', () => {
  assert.equal(parseSubjectId('253'), 253);
  assert.equal(parseSubjectId('https://bgm.tv/subject/253'), 253);
  assert.equal(parseSubjectId('https://bangumi.tv/subject/253'), 253);
  assert.throws(() => parseSubjectId('https://bgm.tv.evil.test/subject/253'));
  assert.throws(() => parseSubjectId('file:///C:/test'));
  assert.throws(() => parseSubjectId('https://example.com/253'));
});
test('identity remains stable and thumbnail identity changes with source content stamp', () => {
  assert.equal(idFor('C:\\Images\\ACG'), idFor('c:\\images\\acg'));
  const n = { path: 'C:\\image.png', mtime: 1, bytes: 100 };
  assert.equal(thumbnailKey(n), thumbnailKey({ ...n }));
  assert.notEqual(thumbnailKey(n), thumbnailKey({ ...n, mtime: 2 }));
  assert.notEqual(thumbnailKey(n), thumbnailKey({ ...n, bytes: 101 }));
});
