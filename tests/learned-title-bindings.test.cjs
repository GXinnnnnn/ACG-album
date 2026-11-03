'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lookupLearnedTitleBindings,
  LEARNED_BINDINGS_VERSION,
  LEARNED_BINDINGS_STATS
} = require('../src/learned-title-bindings.cjs');
const { rankKnownSubjects } = require('../src/matching.cjs');

test('reviewed manual bindings recover exact existing missed folder names without search', () => {
  assert.deepEqual(LEARNED_BINDINGS_STATS, { records: 165, names: 161, ambiguousNames: 4 });
  for (const [name, id, collect] of [
    ['Adorable Witch', 390830, 44],
    ['CLANNAD', 13, 7814],
    ['Riddle Joker', 231798, 5967],
    ['奥日Ori and the Will of the Wisps', 216896, 2017]
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

// All 157 previously reviewed relations, including historical spellings, remain.
const previousRelations = [
  ['16bit的感动', 2, 413741],
  ['2.5次元的诱惑', 2, 410346],
  ['9-nine', 4, 290856],
  ['9-nine', 2, 496973],
  ['9-nine-NewEpisode新篇', 4, 314651],
  ['9-nine-九次九日九重色', 4, 189739],
  ['9-nine-天色天歌天籁音', 4, 222145],
  ['9-nine-支配者的王冠', 2, 496973],
  ['9-nine-春色春恋春熙风', 4, 256657],
  ['9-nine-雪色雪花雪之痕', 4, 290856],
  ['Adorable Witch', 4, 390830],
  ['AIR', 4, 232],
  ['anemoi', 4, 465493],
  ['Another', 2, 20851],
  ["BanG Dream! （It's MyGO!!!!!+Ave Mujica）", 2, 428735],
  ['Charlotte', 2, 120925],
  ['CLANNAD', 4, 13],
  ['CLANNAD -クラナド&CLANNAD ～AFTER STORY～', 2, 876],
  ['COCORO', 4, 513971],
  ['DARLING in the FRANXX', 2, 218711],
  ['D.C.初音岛', 2, 2063],
  ['D.C.初音岛Da Capo', 4, 19078],
  ['DRACU-RIOT！', 4, 25370],
  ['D.S. -Dal Segno-', 4, 142141],
  ['Fate', 2, 10639],
  ['FORTUNE×WORLD～僕らがゲームを作る理由～（FORTUNE×WORLD～我们制作游戏的理由～）', 4, 472597],
  ['G弦上的魔王 G線上の魔王', 4, 1385],
  ['Island', 4, 150191],
  ['JOJO', 2, 113292],
  ['KANADE', 4, 513940],
  ['Lain玲音', 2, 2582],
  ['LAMUNATION! -international-', 4, 146910],
  ['Little Busters!', 2, 38040],
  ['Love live', 2, 49294],
  ['LUNARiA -Virtualized Moonchild-', 4, 317674],
  ['NEKOPARA EXTRA 小猫篇（猫娘乐园）', 2, 254374],
  ['NEW GAME!', 2, 150775],
  ['One Room', 2, 198395],
  ['Overlord', 2, 112146],
  ['PARQUET', 4, 344272],
  ['pieces', 4, 256595],
  ['PRIMAL×HEARTS', 4, 100309],
  ['Rewrite', 4, 4022],
  ['Re：创造主', 2, 202419],
  ['Riddle Joker', 4, 231798],
  ['SSSS古力特', 2, 218712],
  ['Trinoline', 4, 186677],
  ['东方project', 4, 659172],
  ['乱步奇谭', 2, 118785],
  ['优米雅的炼金工房', 4, 509948],
  ['侠盗猎车手5Grand Theft Auto V', 4, 56705],
  ['偶像荣耀IDOLY PRIDE', 4, 325000],
  ['凉宫春日', 2, 3375],
  ['刀剑神域GGO', 2, 226750],
  ['刀剑神域Sword Art Online', 4, 84871],
  ['初雪樱', 4, 19002],
  ['初音未来：缤纷舞台', 4, 309303],
  ['判处勇者刑', 2, 445905],
  ['双人成行It Takes Two', 4, 308947],
  ['双影奇境SplitFiction', 4, 528272],
  ['反叛的鲁路修', 2, 793],
  ['只有我不存在的街道', 2, 137722],
  ['可塑性记忆 プラスティック･メモリーズ', 2, 114685],
  ['向日葵马戏团', 2, 570583],
  ['吸血姬的天秤座吸血姫のリブラ', 4, 137670],
  ['命运之夜Fate stay night REMASTERED', 4, 478369],
  ['命运-冠位指定FGO', 4, 109378],
  ['命运石之门STEINS;GATE', 4, 3154],
  ['哪吒2魔童闹海', 2, 383308],
  ['喵斯快跑muse dash', 4, 241623],
  ['圣女太过完美不够可爱被废除婚约并卖到邻国', 2, 520672],
  ['在世界尽头吟唱恋曲的少女YU-NO', 4, 1075],
  ['塞尔达传说The Legend of Zelda', 4, 659151],
  ['壳中少女', 2, 4274],
  ['夏日口袋summer pockets', 4, 200763],
  ['天使☆騒々 RE-BOOT！', 4, 409483],
  ['天才王子的赤字国家再生术', 2, 326868],
  ['天神乱漫', 4, 10119],
  ['奥日Ori and the Will of the Wisps', 4, 216896],
  ['女神异闻录', 4, 88868],
  ['妮姬：胜利女神(NIKKE)', 4, 343054],
  ['学战都市Asterisk', 2, 130250],
  ['守望先锋2Overwatch 2', 4, 294014],
  ['寄生兽', 2, 88433],
  ['密特罗德metroid', 4, 108286],
  ['小小克星Little Busters！', 4, 125131],
  ['少女☆歌剧 Revue Starlight', 2, 214265],
  ['巧克甜恋', 4, 290343],
  ['巫师3The Witcher 3', 4, 66198],
  ['常轨脱离creative', 4, 295364],
  ['幽灵行者Ghostrunner', 4, 314034],
  ['废村少女', 4, 586274],
  ['异度神剑Xenoblade Chronicles', 4, 6486],
  ['弹丸论破danganronpa', 4, 10336],
  ['我们的阅读理解出错了', 1, 410317],
  ['我的身体，变透明了！？不可视之药与坎坷的命运', 4, 293734],
  ['战国乱舞传 戦国やらいでか -乱舞伝-', 4, 172230],
  ['战国明日香ZERO', 4, 171136],
  ['战地battlefield', 4, 181958],
  ['战鬼与战姬的圣灾战争', 1, 369664],
  ['无职转生', 2, 277554],
  ['明日方舟：黎明前奏&冬隐归路&焰烬曙明', 2, 354190],
  ['星之终途 終のステラ', 4, 317675],
  ['星空列车与白的旅行Hoshizora Tetsudou to Shiro no Tabi', 4, 304421],
  ['星空的记忆 星空のメモリア', 4, 3651],
  ['最终幻想Final Fantasy', 4, 13522],
  ['机动战士高达GQuuuuuuX跨时之战', 2, 526816],
  ['极恶千金的乌龙救国记', 1, 556218],
  ['极限国度Riders Republic', 4, 314740],
  ['极限竞速：地平线Forza Horizon', 4, 235675],
  ['树莓立方体ラズベリーキューブ', 4, 242786],
  ['梦限大BanG Dream! YUME∞MITA', 2, 583729],
  ["樱花、萌放。-as the Night's, Reincarnation-", 4, 233030],
  ['橘光柠水随想曲LimeLight Lemonade Jamライムライト・レモネードジャム', 4, 561526],
  [
    '欧尼酱ConTiNuE！我与结梨的爱爱小秘密おにいちゃんコンティニュー！ ゆうりとしーくれっとらぶ',
    4,
    448628
  ],
  ['沉默魔女的秘密', 2, 506677],
  ['流星 -a wish star-', 4, 499055],
  ['海王星之梦', 4, 565014],
  ['游魂タユタマ', 4, 114064],
  ['演剧星世界 世界巨星', 2, 409088],
  ['漫威死侍VR MarvelsDeadpoolVR', 4, 664432],
  ["漫威钢铁侠Marvel's Iron Man", 4, 402135],
  ['爱上火车-Last Run!!-', 4, 305045],
  ['爱因斯坦携爱敬上アインシュタインより愛を込めて APOLLOCRISIS', 4, 276402],
  ['片方的祈愿カタネガ', 4, 554946],
  ['物语系列', 2, 475354],
  ['狐妖小红娘', 2, 281271],
  ['破碎的祈愿カタネガ', 4, 554946],
  ['破碎的祈愿カタネガイ', 4, 554946],
  ['碧蓝航线', 2, 260677],
  ['空之境界', 2, 11629],
  ['管乐恋曲！~The bonds of melody~', 4, 21757],
  ['箱庭推理箱庭ロジック', 4, 100902],
  ['约会大作战 或守Install', 4, 96125],
  ['绝区零ZenlessZoneZero', 4, 380974],
  ['缘之空&悠之空', 4, 2388],
  ['罪之光约会&继代深柑篇 罪ノ光ランデヴー&罪ノ光ランデヴー みかんブロッサム', 4, 363276],
  ['舰队collection', 2, 84386],
  ['花咲workspring', 4, 113633],
  ['药物少女的呢喃', 2, 420628],
  ['蔚蓝Celeste', 4, 236561],
  ['蔚蓝档案BA', 4, 300648],
  ['蔚蓝档案 The Animation', 2, 416777],
  ['虽然逃走的鱼很大、但钓上来的鱼更大', 2, 604307],
  ['装甲核心系列ARMORED CORE', 4, 410290],
  ['要来点百合吗Base Profile', 4, 441750],
  ['赛博朋克Cyberpunk 2077', 4, 65759],
  ['超兽武装', 2, 33695],
  ['超次元恋人！！ディメンション凸ラバース!!', 4, 611546],
  ['铠甲勇士', 6, 121599],
  ['银花GINKA', 4, 402654],
  ['霞流宝石心ジュエリー・ナイツ・アルカディア -The ends of the world-（白玉）', 4, 489490],
  ['青春猪头少年不会梦到兔女郎学姐-怀梦美少女-娇怜外出妹-红书包女孩', 2, 240038],
  ['靠死亡游戏混饭吃', 2, 510753],
  ['马里奥', 4, 205917],
  ['魔弹战记龙剑道', 6, 212252],
  ['龙娘777埋藏的宝藏', 2, 90388]
];

test('the updated snapshot preserves every previous relation and clone isolation', () => {
  assert.equal(LEARNED_BINDINGS_VERSION, 2);
  assert.equal(previousRelations.length, 157);
  for (const [name, type, id] of previousRelations) {
    const first = lookupLearnedTitleBindings(name, [type]);
    const subject = first.subjects.find((value) => value.id === id && value.type === type);
    assert.ok(subject, name + ':' + type + ':' + id);
    const expected = structuredClone(subject);
    subject.name = 'mutated title';
    subject.name_cn = 'mutated translation';
    subject.aliases.push('mutated alias');
    subject.collection.collect = 999999;
    const second = lookupLearnedTitleBindings(name, [type]).subjects.find(
      (value) => value.id === id
    );
    assert.deepEqual(second, expected, name);
  }
});

test('five newly reviewed names are exact typed exceptions without season or franchise inference', () => {
  for (const [name, type, id] of [
    ['无力系的我，乐观派的她', 4, 598429],
    ['海蓝星之梦', 4, 565014],
    ['凡人修仙传', 2, 518425],
    ['崩坏3', 2, 412301],
    ['游戏人生No Game No Life', 2, 79227]
  ]) {
    const result = lookupLearnedTitleBindings(name, [type]);
    assert.equal(result.complete, true, name);
    assert.equal(result.ambiguous, false, name);
    assert.deepEqual(
      result.subjects.map((value) => [value.type, value.id]),
      [[type, id]],
      name
    );
    assert.deepEqual(lookupLearnedTitleBindings(name, type === 4 ? [2] : [4]).subjects, [], name);
  }
  assert.equal(lookupLearnedTitleBindings('崩坏３', [2]).subjects[0].id, 412301);
  assert.equal(
    lookupLearnedTitleBindings('游戏人生Ｎｏ Ｇａｍｅ Ｎｏ Ｌｉｆｅ', [2]).subjects[0].id,
    79227
  );
  for (const name of ['凡人修仙传 第五季', '崩坏4', '游戏人生No Game No Life Zero', '海蓝星之梦2'])
    assert.deepEqual(lookupLearnedTitleBindings(name, [1, 2, 4, 6]).subjects, [], name);
});

test('new same-type manual corrections keep both facts and reject automatic guessing', () => {
  for (const [name, ids] of [
    ['塞尔达传说The Legend of Zelda', [62229, 659151]],
    ['密特罗德metroid', [108286, 339162]],
    ['巫师3The Witcher 3', [66198, 262220]]
  ]) {
    for (const types of [[4], [1, 2, 4, 6]]) {
      const result = lookupLearnedTitleBindings(name, types);
      assert.equal(result.complete, true);
      assert.equal(result.ambiguous, true, name);
      assert.deepEqual(
        result.subjects.map((value) => value.id).sort((a, b) => a - b),
        ids,
        name
      );
      assert.equal(rankKnownSubjects(name, result.subjects, types).selected, null, name);
    }
    const excluded = lookupLearnedTitleBindings(name, [2]);
    assert.equal(excluded.ambiguous, true, 'ambiguity precedes category filtering');
    assert.deepEqual(excluded.subjects, []);
  }
});
