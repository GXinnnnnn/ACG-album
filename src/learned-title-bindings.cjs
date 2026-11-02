'use strict';
const { normalize } = require('./model.cjs');

// Offline user-confirmed folder bindings reviewed 2026-11-02. Source rows must
// have manual_subject=1 and matching metadata ID, supported type and title.
// Automatic/cover-only confirmations are not promoted into this truth set.
// Names only: no personal paths, credentials, images or network access.
const LEARNED_BINDINGS_VERSION = 1;
const records = [
  {
    folder_name: '16bit的感动',
    subject_id: 413741,
    type: 2,
    name: '16bitセンセーション ANOTHER LAYER',
    name_cn: '16bit的感动 ANOTHER LAYER',
    collection: { wish: 1908, collect: 10241, doing: 1799, on_hold: 894, dropped: 1762 }
  },
  {
    folder_name: '2.5次元的诱惑',
    subject_id: 410346,
    type: 2,
    name: '2.5次元の誘惑',
    name_cn: '2.5次元的诱惑',
    collection: { wish: 3067, collect: 6456, doing: 2655, on_hold: 1156, dropped: 954 }
  },
  {
    folder_name: '9-nine',
    subject_id: 290856,
    type: 4,
    name: '9-nine-ゆきいろゆきはなゆきのあと  Episode.4 Yuki Noa',
    name_cn: '9-nine-雪色雪花雪之痕',
    collection: { wish: 880, collect: 5874, doing: 144, on_hold: 105, dropped: 35 }
  },
  {
    folder_name: '9-nine',
    subject_id: 496973,
    type: 2,
    name: "9-nine- Ruler's Crown",
    name_cn: '9-nine- 支配者的王冠',
    collection: { wish: 1130, collect: 1932, doing: 922, on_hold: 283, dropped: 576 }
  },
  {
    folder_name: '9-nine-NewEpisode新篇',
    subject_id: 314651,
    type: 4,
    name: '9-nine- NewEpisode',
    name_cn: '9-nine- 新章',
    collection: { wish: 446, collect: 3749, doing: 68, on_hold: 79, dropped: 31 }
  },
  {
    folder_name: '9-nine-九次九日九重色',
    subject_id: 189739,
    type: 4,
    name: '9-nine-ここのつここのかここのいろ Episode.1 Miyako Kujo',
    name_cn: '9-nine-九次九日九重色',
    collection: { wish: 952, collect: 6887, doing: 220, on_hold: 144, dropped: 57 }
  },
  {
    folder_name: '9-nine-天色天歌天籁音',
    subject_id: 222145,
    type: 4,
    name: '9-nine-そらいろそらうたそらのおと Episode.2 Sora Nimi',
    name_cn: '9-nine-天色天歌天籁音',
    collection: { wish: 735, collect: 6718, doing: 160, on_hold: 123, dropped: 39 }
  },
  {
    folder_name: '9-nine-支配者的王冠',
    subject_id: 496973,
    type: 2,
    name: "9-nine- Ruler's Crown",
    name_cn: '9-nine- 支配者的王冠',
    collection: { wish: 1130, collect: 1932, doing: 922, on_hold: 283, dropped: 576 }
  },
  {
    folder_name: '9-nine-春色春恋春熙风',
    subject_id: 256657,
    type: 4,
    name: '9-nine-はるいろはるこいはるのかぜ Episode.3 Haruka Kousaka',
    name_cn: '9-nine-春色春恋春熙风',
    collection: { wish: 633, collect: 5792, doing: 117, on_hold: 83, dropped: 25 }
  },
  {
    folder_name: '9-nine-雪色雪花雪之痕',
    subject_id: 290856,
    type: 4,
    name: '9-nine-ゆきいろゆきはなゆきのあと  Episode.4 Yuki Noa',
    name_cn: '9-nine-雪色雪花雪之痕',
    collection: { wish: 880, collect: 5874, doing: 144, on_hold: 105, dropped: 35 }
  },
  {
    folder_name: 'Adorable Witch',
    subject_id: 390830,
    type: 4,
    name: 'Adorable Witch',
    name_cn: '',
    collection: { wish: 11, collect: 44, doing: 0, on_hold: 1, dropped: 0 }
  },
  {
    folder_name: 'AIR',
    subject_id: 232,
    type: 4,
    name: 'AIR',
    name_cn: '',
    collection: { wish: 1725, collect: 3381, doing: 263, on_hold: 318, dropped: 76 }
  },
  {
    folder_name: 'anemoi',
    subject_id: 465493,
    type: 4,
    name: 'anemoi -アネモイ-',
    name_cn: '',
    collection: { wish: 1421, collect: 870, doing: 276, on_hold: 75, dropped: 42 }
  },
  {
    folder_name: 'Another',
    subject_id: 20851,
    type: 2,
    name: 'Another',
    name_cn: '',
    collection: { wish: 4297, collect: 23259, doing: 1259, on_hold: 951, dropped: 495 }
  },
  {
    folder_name: "BanG Dream! （It's MyGO!!!!!+Ave Mujica）",
    subject_id: 428735,
    type: 2,
    name: "BanG Dream! It's MyGO!!!!!",
    name_cn: '',
    collection: { wish: 4118, collect: 49678, doing: 3698, on_hold: 758, dropped: 661 }
  },
  {
    folder_name: 'Charlotte',
    subject_id: 120925,
    type: 2,
    name: 'Charlotte',
    name_cn: '夏洛特',
    collection: { wish: 2428, collect: 36806, doing: 1134, on_hold: 657, dropped: 615 }
  },
  {
    folder_name: 'CLANNAD',
    subject_id: 13,
    type: 4,
    name: 'CLANNAD',
    name_cn: '',
    collection: { wish: 3032, collect: 7814, doing: 1092, on_hold: 891, dropped: 199 }
  },
  {
    folder_name: 'CLANNAD -クラナド&CLANNAD ～AFTER STORY～',
    subject_id: 876,
    type: 2,
    name: 'CLANNAD 〜AFTER STORY〜',
    name_cn: '',
    collection: { wish: 9135, collect: 48120, doing: 1985, on_hold: 1382, dropped: 396 }
  },
  {
    folder_name: 'COCORO',
    subject_id: 513971,
    type: 4,
    name: 'COCORO',
    name_cn: '',
    collection: { wish: 117, collect: 167, doing: 24, on_hold: 6, dropped: 12 }
  },
  {
    folder_name: 'DARLING in the FRANXX',
    subject_id: 218711,
    type: 2,
    name: 'ダーリン・イン・ザ・フランキス',
    name_cn: 'DARLING in the FRANXX',
    collection: { wish: 2809, collect: 22600, doing: 2013, on_hold: 1295, dropped: 1692 }
  },
  {
    folder_name: 'D.C.初音岛',
    subject_id: 2063,
    type: 2,
    name: 'D.C. 〜ダ・カーポ〜',
    name_cn: '初音岛',
    collection: { wish: 1462, collect: 2829, doing: 302, on_hold: 278, dropped: 132 }
  },
  {
    folder_name: 'D.C.初音岛Da Capo',
    subject_id: 19078,
    type: 4,
    name: 'D.C. 〜ダ・カーポ〜',
    name_cn: '初音岛',
    collection: { wish: 290, collect: 223, doing: 24, on_hold: 30, dropped: 9 }
  },
  {
    folder_name: 'DRACU-RIOT！',
    subject_id: 25370,
    type: 4,
    name: 'DRACU-RIOT!',
    name_cn: '',
    collection: { wish: 697, collect: 3510, doing: 220, on_hold: 204, dropped: 81 }
  },
  {
    folder_name: 'D.S. -Dal Segno-',
    subject_id: 142141,
    type: 4,
    name: 'D.S. -Dal Segno-',
    name_cn: '',
    collection: { wish: 263, collect: 247, doing: 36, on_hold: 47, dropped: 24 }
  },
  {
    folder_name: 'Fate',
    subject_id: 10639,
    type: 2,
    name: 'Fate/Zero',
    name_cn: 'Fate/Zero',
    collection: { wish: 4539, collect: 50709, doing: 3134, on_hold: 1363, dropped: 374 }
  },
  {
    folder_name: 'FORTUNE×WORLD～僕らがゲームを作る理由～（FORTUNE×WORLD～我们制作游戏的理由～）',
    subject_id: 472597,
    type: 4,
    name: 'FORTUNE×WORLD～僕らがゲームを作る理由～',
    name_cn: '',
    collection: { wish: 254, collect: 15, doing: 41, on_hold: 6, dropped: 4 }
  },
  {
    folder_name: 'G弦上的魔王 G線上の魔王',
    subject_id: 1385,
    type: 4,
    name: 'G線上の魔王',
    name_cn: 'G弦上的魔王',
    collection: { wish: 2260, collect: 5666, doing: 330, on_hold: 381, dropped: 82 }
  },
  {
    folder_name: 'Island',
    subject_id: 150191,
    type: 4,
    name: 'ISLAND',
    name_cn: 'ISLAND',
    collection: { wish: 2080, collect: 4021, doing: 301, on_hold: 292, dropped: 123 }
  },
  {
    folder_name: 'JOJO',
    subject_id: 113292,
    type: 2,
    name: 'ジョジョの奇妙な冒険 スターダストクルセイダース エジプト編',
    name_cn: 'JOJO的奇妙冒险 星尘斗士 埃及篇',
    collection: { wish: 1559, collect: 32836, doing: 933, on_hold: 488, dropped: 164 }
  },
  {
    folder_name: 'KANADE',
    subject_id: 513940,
    type: 4,
    name: 'KANADE',
    name_cn: '',
    collection: { wish: 280, collect: 458, doing: 34, on_hold: 16, dropped: 19 }
  },
  {
    folder_name: 'Lain玲音',
    subject_id: 2582,
    type: 2,
    name: 'Serial Experiments Lain',
    name_cn: '玲音',
    collection: { wish: 6442, collect: 10600, doing: 1637, on_hold: 1176, dropped: 267 }
  },
  {
    folder_name: 'LAMUNATION! -international-',
    subject_id: 146910,
    type: 4,
    name: 'ラムネーション！',
    name_cn: '',
    collection: { wish: 692, collect: 825, doing: 89, on_hold: 99, dropped: 52 }
  },
  {
    folder_name: 'Little Busters!',
    subject_id: 38040,
    type: 2,
    name: 'リトルバスターズ！',
    name_cn: 'Little Busters!',
    collection: { wish: 3965, collect: 9445, doing: 1293, on_hold: 1216, dropped: 598 }
  },
  {
    folder_name: 'Love live',
    subject_id: 49294,
    type: 2,
    name: 'ラブライブ!',
    name_cn: 'Love Live!',
    collection: { wish: 1973, collect: 17567, doing: 674, on_hold: 659, dropped: 450 }
  },
  {
    folder_name: 'LUNARiA -Virtualized Moonchild-',
    subject_id: 317674,
    type: 4,
    name: 'LUNARiA -Virtualized Moonchild-',
    name_cn: '',
    collection: { wish: 401, collect: 855, doing: 48, on_hold: 35, dropped: 19 }
  },
  {
    folder_name: 'NEKOPARA EXTRA 小猫篇（猫娘乐园）',
    subject_id: 254374,
    type: 2,
    name: 'ネコぱら OVA Extra 仔ネコの日の約束',
    name_cn: 'NEKOPARA OVA Extra 小猫之日的约定',
    collection: { wish: 286, collect: 1283, doing: 84, on_hold: 46, dropped: 18 }
  },
  {
    folder_name: 'NEW GAME!',
    subject_id: 150775,
    type: 2,
    name: 'NEW GAME!',
    name_cn: '',
    collection: { wish: 3228, collect: 16292, doing: 960, on_hold: 833, dropped: 352 }
  },
  {
    folder_name: 'One Room',
    subject_id: 198395,
    type: 2,
    name: 'One Room',
    name_cn: '',
    collection: { wish: 1922, collect: 12810, doing: 670, on_hold: 516, dropped: 348 }
  },
  {
    folder_name: 'Overlord',
    subject_id: 112146,
    type: 2,
    name: 'オーバーロード',
    name_cn: 'OVERLORD',
    collection: { wish: 1639, collect: 28095, doing: 944, on_hold: 550, dropped: 604 }
  },
  {
    folder_name: 'PARQUET',
    subject_id: 344272,
    type: 4,
    name: 'PARQUET',
    name_cn: '',
    collection: { wish: 211, collect: 1309, doing: 58, on_hold: 66, dropped: 50 }
  },
  {
    folder_name: 'pieces',
    subject_id: 256595,
    type: 4,
    name: 'pieces/渡り鳥のソムニウム',
    name_cn: 'pieces/候鸟的梦',
    collection: { wish: 901, collect: 662, doing: 110, on_hold: 92, dropped: 34 }
  },
  {
    folder_name: 'PRIMAL×HEARTS',
    subject_id: 100309,
    type: 4,
    name: 'PRIMAL×HEARTS',
    name_cn: '',
    collection: { wish: 673, collect: 850, doing: 83, on_hold: 67, dropped: 32 }
  },
  {
    folder_name: 'Rewrite',
    subject_id: 4022,
    type: 4,
    name: 'Rewrite',
    name_cn: '',
    collection: { wish: 3188, collect: 6506, doing: 694, on_hold: 532, dropped: 129 }
  },
  {
    folder_name: 'Re：创造主',
    subject_id: 202419,
    type: 2,
    name: 'Re:CREATORS',
    name_cn: 'Re：创世主们',
    collection: { wish: 1448, collect: 11342, doing: 858, on_hold: 896, dropped: 1055 }
  },
  {
    folder_name: 'Riddle Joker',
    subject_id: 231798,
    type: 4,
    name: 'RIDDLE JOKER',
    name_cn: '',
    collection: { wish: 779, collect: 5967, doing: 357, on_hold: 254, dropped: 131 }
  },
  {
    folder_name: 'SSSS古力特',
    subject_id: 218712,
    type: 2,
    name: 'SSSS.GRIDMAN',
    name_cn: 'SSSS.古立特',
    collection: { wish: 3353, collect: 19011, doing: 1320, on_hold: 783, dropped: 374 }
  },
  {
    folder_name: 'Trinoline',
    subject_id: 186677,
    type: 4,
    name: 'トリノライン',
    name_cn: '特里诺兰',
    collection: { wish: 645, collect: 797, doing: 116, on_hold: 124, dropped: 55 }
  },
  {
    folder_name: '东方project',
    subject_id: 659172,
    type: 4,
    name: '東方紅魔郷：New Classic ~ the Embodiment of Scarlet Devil.',
    name_cn: '东方红魔乡：新典 ~ the Embodiment of Scarlet Devil.',
    collection: { wish: 72, collect: 90, doing: 34, on_hold: 5, dropped: 5 }
  },
  {
    folder_name: '乱步奇谭',
    subject_id: 118785,
    type: 2,
    name: '乱歩奇譚 Game of Laplace',
    name_cn: '乱步奇谭 拉普拉斯的游戏',
    collection: { wish: 950, collect: 5534, doing: 371, on_hold: 426, dropped: 790 }
  },
  {
    folder_name: '优米雅的炼金工房',
    subject_id: 509948,
    type: 4,
    name: 'ユミアのアトリエ ～追憶の錬金術士と幻創の地～',
    name_cn: '优米雅的炼金工房 ～追忆之炼金术士与幻创之地～',
    collection: { wish: 155, collect: 184, doing: 47, on_hold: 24, dropped: 36 }
  },
  {
    folder_name: '侠盗猎车手5Grand Theft Auto V',
    subject_id: 56705,
    type: 4,
    name: 'Grand Theft Auto V',
    name_cn: '侠盗猎车手5',
    collection: { wish: 549, collect: 5189, doing: 436, on_hold: 357, dropped: 139 }
  },
  {
    folder_name: '偶像荣耀IDOLY PRIDE',
    subject_id: 325000,
    type: 4,
    name: 'IDOLY PRIDE',
    name_cn: '偶像荣耀',
    collection: { wish: 39, collect: 76, doing: 54, on_hold: 13, dropped: 11 }
  },
  {
    folder_name: '凉宫春日',
    subject_id: 3375,
    type: 2,
    name: '涼宮ハルヒの消失',
    name_cn: '凉宫春日的消失',
    collection: { wish: 7902, collect: 38533, doing: 1046, on_hold: 868, dropped: 213 }
  },
  {
    folder_name: '刀剑神域GGO',
    subject_id: 226750,
    type: 2,
    name: 'ソードアート・オンライン オルタナティブ ガンゲイル・オンライン',
    name_cn: '刀剑神域外传 Gun Gale Online',
    collection: { wish: 1207, collect: 8935, doing: 506, on_hold: 581, dropped: 442 }
  },
  {
    folder_name: '刀剑神域Sword Art Online',
    subject_id: 84871,
    type: 4,
    name: 'ソードアート・オンライン -ホロウ・フラグメント-',
    name_cn: '刀剑神域：虚空断章',
    collection: { wish: 44, collect: 119, doing: 22, on_hold: 16, dropped: 18 }
  },
  {
    folder_name: '初雪樱',
    subject_id: 19002,
    type: 4,
    name: 'はつゆきさくら',
    name_cn: '初雪樱',
    collection: { wish: 1661, collect: 3979, doing: 271, on_hold: 244, dropped: 90 }
  },
  {
    folder_name: '初音未来：缤纷舞台',
    subject_id: 309303,
    type: 4,
    name: 'プロジェクトセカイ カラフルステージ！ feat. 初音ミク',
    name_cn: '世界计划 缤纷舞台！ feat. 初音未来',
    collection: { wish: 118, collect: 1025, doing: 737, on_hold: 141, dropped: 92 }
  },
  {
    folder_name: '判处勇者刑',
    subject_id: 445905,
    type: 2,
    name: '勇者刑に処す 懲罰勇者9004隊刑務記録',
    name_cn: '判处勇者刑 惩罚勇者9004队刑务纪录',
    collection: { wish: 2366, collect: 7363, doing: 3990, on_hold: 711, dropped: 1043 }
  },
  {
    folder_name: '双人成行It Takes Two',
    subject_id: 308947,
    type: 4,
    name: 'It Takes Two',
    name_cn: '双人成行',
    collection: { wish: 461, collect: 4026, doing: 204, on_hold: 203, dropped: 42 }
  },
  {
    folder_name: '双影奇境SplitFiction',
    subject_id: 528272,
    type: 4,
    name: 'Split Fiction',
    name_cn: '双影奇境',
    collection: { wish: 353, collect: 1840, doing: 114, on_hold: 58, dropped: 27 }
  },
  {
    folder_name: '反叛的鲁路修',
    subject_id: 793,
    type: 2,
    name: 'コードギアス 反逆のルルーシュ',
    name_cn: 'Code Geass 反叛的鲁路修',
    collection: { wish: 6070, collect: 35569, doing: 1568, on_hold: 1237, dropped: 404 }
  },
  {
    folder_name: '只有我不存在的街道',
    subject_id: 137722,
    type: 2,
    name: '僕だけがいない街',
    name_cn: '只有我不存在的城市',
    collection: { wish: 5967, collect: 23610, doing: 1136, on_hold: 733, dropped: 265 }
  },
  {
    folder_name: '可塑性记忆 プラスティック･メモリーズ',
    subject_id: 114685,
    type: 2,
    name: 'プラスティック・メモリーズ',
    name_cn: '可塑性记忆',
    collection: { wish: 3671, collect: 23189, doing: 1196, on_hold: 1206, dropped: 762 }
  },
  {
    folder_name: '向日葵马戏团',
    subject_id: 570583,
    type: 2,
    name: 'グロウアップショウ ～ひまわりのサーカス団～',
    name_cn: 'Grow Up Show ～向日葵马戏团～',
    collection: { wish: 1781, collect: 5606, doing: 3160, on_hold: 216, dropped: 222 }
  },
  {
    folder_name: '吸血姬的天秤座吸血姫のリブラ',
    subject_id: 137670,
    type: 4,
    name: '吸血姫のリブラ',
    name_cn: '吸血姬的天秤座',
    collection: { wish: 145, collect: 55, doing: 12, on_hold: 19, dropped: 8 }
  },
  {
    folder_name: '命运之夜Fate stay night REMASTERED',
    subject_id: 478369,
    type: 4,
    name: 'Fate/stay night REMASTERED',
    name_cn: '',
    collection: { wish: 157, collect: 288, doing: 100, on_hold: 25, dropped: 14 }
  },
  {
    folder_name: '命运-冠位指定FGO',
    subject_id: 109378,
    type: 4,
    name: 'Fate/Grand Order',
    name_cn: '命运-冠位指定',
    collection: { wish: 82, collect: 1836, doing: 1199, on_hold: 174, dropped: 432 }
  },
  {
    folder_name: '命运石之门STEINS;GATE',
    subject_id: 3154,
    type: 4,
    name: 'STEINS;GATE',
    name_cn: '命运石之门',
    collection: { wish: 3011, collect: 10647, doing: 1319, on_hold: 841, dropped: 115 }
  },
  {
    folder_name: '哪吒2魔童闹海',
    subject_id: 383308,
    type: 2,
    name: '哪吒之魔童闹海',
    name_cn: '哪吒之魔童闹海',
    collection: { wish: 205, collect: 6451, doing: 77, on_hold: 45, dropped: 151 }
  },
  {
    folder_name: '喵斯快跑muse dash',
    subject_id: 241623,
    type: 4,
    name: '喵斯快跑',
    name_cn: '',
    collection: { wish: 75, collect: 1705, doing: 312, on_hold: 104, dropped: 68 }
  },
  {
    folder_name: '圣女太过完美不够可爱被废除婚约并卖到邻国',
    subject_id: 520672,
    type: 2,
    name: '完璧すぎて可愛げがないと婚約破棄された聖女は隣国に売られる',
    name_cn: '圣女因太过完美不够可爱而被废除婚约并卖到邻国',
    collection: { wish: 420, collect: 2349, doing: 586, on_hold: 157, dropped: 296 }
  },
  {
    folder_name: '在世界尽头吟唱恋曲的少女YU-NO',
    subject_id: 1075,
    type: 4,
    name: 'この世の果てで恋を唄う少女YU-NO',
    name_cn: '在世界尽头咏唱恋曲的少女YU-NO',
    collection: { wish: 2359, collect: 1632, doing: 282, on_hold: 253, dropped: 74 }
  },
  {
    folder_name: '塞尔达传说The Legend of Zelda',
    subject_id: 659151,
    type: 4,
    name: 'ゼルダの伝説 時のオカリナ',
    name_cn: '塞尔达传说 时之笛',
    collection: { wish: 295, collect: 0, doing: 2, on_hold: 2, dropped: 0 }
  },
  {
    folder_name: '壳中少女',
    subject_id: 4274,
    type: 2,
    name: 'マルドゥック・スクランブル 圧縮',
    name_cn: '壳中少女 压缩',
    collection: { wish: 1910, collect: 3577, doing: 141, on_hold: 175, dropped: 32 }
  },
  {
    folder_name: '夏日口袋summer pockets',
    subject_id: 200763,
    type: 4,
    name: 'Summer Pockets',
    name_cn: '夏日口袋',
    collection: { wish: 2368, collect: 7519, doing: 769, on_hold: 364, dropped: 119 }
  },
  {
    folder_name: '天使☆騒々 RE-BOOT！',
    subject_id: 409483,
    type: 4,
    name: '天使☆騒々 RE-BOOT!',
    name_cn: '天使☆嚣嚣 RE-BOOT!',
    collection: { wish: 876, collect: 2842, doing: 374, on_hold: 196, dropped: 140 }
  },
  {
    folder_name: '天才王子的赤字国家再生术',
    subject_id: 326868,
    type: 2,
    name: '天才王子の赤字国家再生術',
    name_cn: '天才王子的赤字国家振兴术',
    collection: { wish: 929, collect: 9958, doing: 742, on_hold: 546, dropped: 695 }
  },
  {
    folder_name: '天神乱漫',
    subject_id: 10119,
    type: 4,
    name: '天神乱漫 -LUCKY or UNLUCKY!?-',
    name_cn: '天神乱漫 -LUCKY or UNLUCKY!?-',
    collection: { wish: 369, collect: 2330, doing: 104, on_hold: 111, dropped: 63 }
  },
  {
    folder_name: '奥日Ori and the Will of the Wisps',
    subject_id: 216896,
    type: 4,
    name: 'Ori and the Will of the Wisps',
    name_cn: '精灵与萤火意志',
    collection: { wish: 386, collect: 2017, doing: 134, on_hold: 186, dropped: 64 }
  },
  {
    folder_name: '女神异闻录',
    subject_id: 88868,
    type: 4,
    name: 'ペルソナ5',
    name_cn: '女神异闻录5',
    collection: { wish: 1438, collect: 5131, doing: 545, on_hold: 328, dropped: 111 }
  },
  {
    folder_name: '妮姬：胜利女神(NIKKE)',
    subject_id: 343054,
    type: 4,
    name: '승리의 여신：니케',
    name_cn: '胜利女神：妮姬',
    collection: { wish: 63, collect: 411, doing: 197, on_hold: 46, dropped: 121 }
  },
  {
    folder_name: '学战都市Asterisk',
    subject_id: 130250,
    type: 2,
    name: '学戦都市アスタリスク',
    name_cn: '学战都市 六芒星',
    collection: { wish: 844, collect: 7831, doing: 369, on_hold: 291, dropped: 395 }
  },
  {
    folder_name: '守望先锋2Overwatch 2',
    subject_id: 294014,
    type: 4,
    name: 'OVERWATCH 2',
    name_cn: '守望先锋2',
    collection: { wish: 25, collect: 385, doing: 101, on_hold: 19, dropped: 56 }
  },
  {
    folder_name: '寄生兽',
    subject_id: 88433,
    type: 2,
    name: '寄生獣 セイの格率',
    name_cn: '寄生兽 生命的准则',
    collection: { wish: 3798, collect: 28137, doing: 1538, on_hold: 906, dropped: 402 }
  },
  {
    folder_name: '密特罗德metroid',
    subject_id: 108286,
    type: 4,
    name: 'メトロイド',
    name_cn: '密特罗德',
    collection: { wish: 21, collect: 51, doing: 0, on_hold: 5, dropped: 9 }
  },
  {
    folder_name: '小小克星Little Busters！',
    subject_id: 125131,
    type: 4,
    name: 'リトルバスターズ！',
    name_cn: 'Little Busters!',
    collection: { wish: 1271, collect: 1412, doing: 167, on_hold: 146, dropped: 32 }
  },
  {
    folder_name: '少女☆歌剧 Revue Starlight',
    subject_id: 214265,
    type: 2,
    name: '少女☆歌劇 レヴュースタァライト',
    name_cn: '少女☆歌剧 Revue Starlight',
    collection: { wish: 5024, collect: 25447, doing: 2061, on_hold: 1001, dropped: 386 }
  },
  {
    folder_name: '巧克甜恋',
    subject_id: 290343,
    type: 4,
    name: 'あまいろショコラータ',
    name_cn: '巧可甜恋',
    collection: { wish: 517, collect: 1261, doing: 79, on_hold: 93, dropped: 31 }
  },
  {
    folder_name: '巫师3The Witcher 3',
    subject_id: 66198,
    type: 4,
    name: 'The Witcher 3: Wild Hunt',
    name_cn: '巫师3：狂猎',
    collection: { wish: 796, collect: 4491, doing: 852, on_hold: 960, dropped: 284 }
  },
  {
    folder_name: '常轨脱离creative',
    subject_id: 295364,
    type: 4,
    name: 'ハミダシクリエイティブ',
    name_cn: '常轨脱离Creative',
    collection: { wish: 1115, collect: 4003, doing: 445, on_hold: 219, dropped: 116 }
  },
  {
    folder_name: '幽灵行者Ghostrunner',
    subject_id: 314034,
    type: 4,
    name: 'Ghostrunner',
    name_cn: '幽灵行者',
    collection: { wish: 70, collect: 450, doing: 28, on_hold: 41, dropped: 38 }
  },
  {
    folder_name: '废村少女',
    subject_id: 586274,
    type: 4,
    name: '廃村少女 番外 ～籠愛拾遺～',
    name_cn: '废村少女 外传 ～笼爱拾遗～',
    collection: { wish: 91, collect: 323, doing: 19, on_hold: 15, dropped: 5 }
  },
  {
    folder_name: '异度神剑Xenoblade Chronicles',
    subject_id: 6486,
    type: 4,
    name: 'ゼノブレイド',
    name_cn: '异度神剑',
    collection: { wish: 488, collect: 588, doing: 75, on_hold: 110, dropped: 35 }
  },
  {
    folder_name: '弹丸论破danganronpa',
    subject_id: 10336,
    type: 4,
    name: 'ダンガンロンパ 希望の学園と絶望の高校生',
    name_cn: '弹丸论破 希望的学园和绝望高中生',
    collection: { wish: 731, collect: 6506, doing: 285, on_hold: 186, dropped: 74 }
  },
  {
    folder_name: '我们的阅读理解出错了',
    subject_id: 410317,
    type: 1,
    name: '僕らは『読み』を間違える',
    name_cn: '我们在「解读」上犯了错误',
    collection: { wish: 534, collect: 367, doing: 208, on_hold: 33, dropped: 12 }
  },
  {
    folder_name: '我的身体，变透明了！？不可视之药与坎坷的命运',
    subject_id: 293734,
    type: 4,
    name: '俺の姿が、透明に！？ 不可視の薬（インビジブル）と数奇な運命',
    name_cn: '',
    collection: { wish: 306, collect: 941, doing: 62, on_hold: 65, dropped: 39 }
  },
  {
    folder_name: '战国乱舞传 戦国やらいでか -乱舞伝-',
    subject_id: 172230,
    type: 4,
    name: '戦国やらいでか -乱舞伝-',
    name_cn: '',
    collection: { wish: 0, collect: 3, doing: 1, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: '战国明日香ZERO',
    subject_id: 171136,
    type: 4,
    name: '戦国アスカZERO',
    name_cn: '战国明日香ZERO',
    collection: { wish: 1, collect: 3, doing: 1, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: '战地battlefield',
    subject_id: 181958,
    type: 4,
    name: 'Battlefield 1',
    name_cn: '战地1',
    collection: { wish: 89, collect: 1439, doing: 145, on_hold: 75, dropped: 51 }
  },
  {
    folder_name: '战鬼与战姬的圣灾战争',
    subject_id: 369664,
    type: 1,
    name: '戦鬼と戦姫の聖災戦争',
    name_cn: '',
    collection: { wish: 3, collect: 2, doing: 0, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: '无职转生',
    subject_id: 277554,
    type: 2,
    name: '無職転生 ～異世界行ったら本気だす～',
    name_cn: '无职转生～到了异世界就拿出真本事～',
    collection: { wish: 4236, collect: 47237, doing: 3500, on_hold: 1009, dropped: 918 }
  },
  {
    folder_name: '明日方舟：黎明前奏&冬隐归路&焰烬曙明',
    subject_id: 354190,
    type: 2,
    name: 'アークナイツ【黎明前奏/PRELUDE TO DAWN】',
    name_cn: '明日方舟：黎明前奏',
    collection: { wish: 675, collect: 4722, doing: 763, on_hold: 393, dropped: 516 }
  },
  {
    folder_name: '星之终途 終のステラ',
    subject_id: 317675,
    type: 4,
    name: '終のステラ',
    name_cn: '星之终途',
    collection: { wish: 1666, collect: 4032, doing: 219, on_hold: 118, dropped: 31 }
  },
  {
    folder_name: '星空列车与白的旅行Hoshizora Tetsudou to Shiro no Tabi',
    subject_id: 304421,
    type: 4,
    name: '星空鉄道とシロの旅',
    name_cn: '星空列车与白的旅行',
    collection: { wish: 1465, collect: 4755, doing: 243, on_hold: 173, dropped: 57 }
  },
  {
    folder_name: '星空的记忆 星空のメモリア',
    subject_id: 3651,
    type: 4,
    name: '星空のメモリア Eternal Heart',
    name_cn: '星空的记忆 Eternal Heart',
    collection: { wish: 619, collect: 1595, doing: 67, on_hold: 84, dropped: 22 }
  },
  {
    folder_name: '最终幻想Final Fantasy',
    subject_id: 13522,
    type: 4,
    name: 'ファイナルファンタジー',
    name_cn: '最终幻想',
    collection: { wish: 45, collect: 286, doing: 10, on_hold: 16, dropped: 14 }
  },
  {
    folder_name: '机动战士高达GQuuuuuuX跨时之战',
    subject_id: 526816,
    type: 2,
    name: '機動戦士Gundam GQuuuuuuX',
    name_cn: '机动战士高达 GQuuuuuuX',
    collection: { wish: 2373, collect: 11686, doing: 3685, on_hold: 682, dropped: 884 }
  },
  {
    folder_name: '极恶千金的乌龙救国记',
    subject_id: 556218,
    type: 1,
    name: '極悪令嬢の勘違い救国記',
    name_cn: '极恶千金的乌龙救国记',
    collection: { wish: 4, collect: 0, doing: 11, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: '极限国度Riders Republic',
    subject_id: 314740,
    type: 4,
    name: 'Riders Republic',
    name_cn: '极限国度',
    collection: { wish: 41, collect: 135, doing: 14, on_hold: 12, dropped: 14 }
  },
  {
    folder_name: '极限竞速：地平线Forza Horizon',
    subject_id: 235675,
    type: 4,
    name: 'Forza Horizon 4',
    name_cn: '极限竞速 地平线4',
    collection: { wish: 124, collect: 1309, doing: 152, on_hold: 92, dropped: 47 }
  },
  {
    folder_name: '树莓立方体ラズベリーキューブ',
    subject_id: 242786,
    type: 4,
    name: 'ラズベリーキューブ',
    name_cn: '树莓立方体',
    collection: { wish: 401, collect: 778, doing: 69, on_hold: 76, dropped: 58 }
  },
  {
    folder_name: '梦限大BanG Dream! YUME∞MITA',
    subject_id: 583729,
    type: 2,
    name: 'BanG Dream! ゆめ∞みた',
    name_cn: 'BanG Dream! YUME∞MITA',
    collection: { wish: 1443, collect: 7003, doing: 3673, on_hold: 279, dropped: 739 }
  },
  {
    folder_name: "樱花、萌放。-as the Night's, Reincarnation-",
    subject_id: 233030,
    type: 4,
    name: "さくら、もゆ。-as the Night's, Reincarnation-",
    name_cn: "樱花、萌放。-as the Night's, Reincarnation-",
    collection: { wish: 3025, collect: 3100, doing: 760, on_hold: 456, dropped: 143 }
  },
  {
    folder_name: '橘光柠水随想曲LimeLight Lemonade Jamライムライト・レモネードジャム',
    subject_id: 561526,
    type: 4,
    name: 'ライムライト・レモネードジャム',
    name_cn: '橘光柠水随想曲',
    collection: { wish: 1042, collect: 2140, doing: 689, on_hold: 144, dropped: 64 }
  },
  {
    folder_name:
      '欧尼酱ConTiNuE！我与结梨的爱爱小秘密おにいちゃんコンティニュー！ ゆうりとしーくれっとらぶ',
    subject_id: 448628,
    type: 4,
    name: 'おにいちゃんコンティニュー！ ゆうりとしーとくれっとらぶ♥',
    name_cn: '欧尼酱ConTiNuE！我与结梨的恋爱小秘密',
    collection: { wish: 272, collect: 331, doing: 42, on_hold: 20, dropped: 8 }
  },
  {
    folder_name: '沉默魔女的秘密',
    subject_id: 506677,
    type: 2,
    name: 'サイレント・ウィッチ 沈黙の魔女の隠しごと',
    name_cn: 'Silent Witch 沉默魔女的秘密',
    collection: { wish: 3235, collect: 10845, doing: 5527, on_hold: 878, dropped: 1315 }
  },
  {
    folder_name: '流星 -a wish star-',
    subject_id: 499055,
    type: 4,
    name: '流る星 -a Wish Star-',
    name_cn: '流星 -a Wish Star-',
    collection: { wish: 207, collect: 449, doing: 21, on_hold: 25, dropped: 8 }
  },
  {
    folder_name: '海王星之梦',
    subject_id: 565014,
    type: 4,
    name: '海蓝星之梦',
    name_cn: '海蓝星之梦',
    collection: { wish: 21, collect: 35, doing: 5, on_hold: 4, dropped: 1 }
  },
  {
    folder_name: '游魂タユタマ',
    subject_id: 114064,
    type: 4,
    name: 'タユタマ -It’s happy days-',
    name_cn: '游魂 -It’s happy days-',
    collection: { wish: 121, collect: 307, doing: 20, on_hold: 21, dropped: 10 }
  },
  {
    folder_name: '演剧星世界 世界巨星',
    subject_id: 409088,
    type: 2,
    name: 'ワールドダイスター',
    name_cn: '演剧星世界',
    collection: { wish: 827, collect: 2170, doing: 324, on_hold: 203, dropped: 220 }
  },
  {
    folder_name: '漫威死侍VR MarvelsDeadpoolVR',
    subject_id: 664432,
    type: 4,
    name: "Marvel's Deadpool VR",
    name_cn: '漫威死侍VR',
    collection: { wish: 0, collect: 0, doing: 0, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: "漫威钢铁侠Marvel's Iron Man",
    subject_id: 402135,
    type: 4,
    name: 'Iron Man video game',
    name_cn: '',
    collection: { wish: 3, collect: 1, doing: 0, on_hold: 0, dropped: 0 }
  },
  {
    folder_name: '爱上火车-Last Run!!-',
    subject_id: 305045,
    type: 4,
    name: 'まいてつ Last Run!!',
    name_cn: '爱上火车-Last Run!!-',
    collection: { wish: 553, collect: 1404, doing: 301, on_hold: 257, dropped: 61 }
  },
  {
    folder_name: '爱因斯坦携爱敬上アインシュタインより愛を込めて APOLLOCRISIS',
    subject_id: 276402,
    type: 4,
    name: 'アインシュタインより愛を込めて',
    name_cn: '爱因斯坦携爱敬上',
    collection: { wish: 664, collect: 1205, doing: 78, on_hold: 73, dropped: 58 }
  },
  {
    folder_name: '片方的祈愿カタネガ',
    subject_id: 554946,
    type: 4,
    name: 'カタネガイ',
    name_cn: '破碎的祈愿',
    collection: { wish: 296, collect: 424, doing: 15, on_hold: 15, dropped: 8 }
  },
  {
    folder_name: '物语系列',
    subject_id: 475354,
    type: 2,
    name: '〈物語〉シリーズ オフ&モンスターシーズン',
    name_cn: '物语系列 外传季&怪物季',
    collection: { wish: 3721, collect: 9359, doing: 2209, on_hold: 475, dropped: 101 }
  },
  {
    folder_name: '狐妖小红娘',
    subject_id: 281271,
    type: 2,
    name: '狐妖小红娘 王权篇',
    name_cn: '狐妖小红娘2 王权篇',
    collection: { wish: 110, collect: 3964, doing: 34, on_hold: 33, dropped: 33 }
  },
  {
    folder_name: '破碎的祈愿カタネガ',
    subject_id: 554946,
    type: 4,
    name: 'カタネガイ',
    name_cn: '破碎的祈愿',
    collection: { wish: 296, collect: 424, doing: 15, on_hold: 15, dropped: 8 }
  },
  {
    folder_name: '破碎的祈愿カタネガイ',
    subject_id: 554946,
    type: 4,
    name: 'カタネガイ',
    name_cn: '破碎的祈愿',
    collection: { wish: 296, collect: 424, doing: 15, on_hold: 15, dropped: 8 }
  },
  {
    folder_name: '碧蓝航线',
    subject_id: 260677,
    type: 2,
    name: 'アズールレーン THE ANIMATION',
    name_cn: '碧蓝航线 THE ANIMATION',
    collection: { wish: 546, collect: 3898, doing: 395, on_hold: 344, dropped: 584 }
  },
  {
    folder_name: '空之境界',
    subject_id: 11629,
    type: 2,
    name: '劇場版 空の境界 終章 空の境界',
    name_cn: '剧场版 空之境界 终章 空之境界',
    collection: { wish: 1190, collect: 11800, doing: 139, on_hold: 159, dropped: 35 }
  },
  {
    folder_name: '管乐恋曲！~The bonds of melody~',
    subject_id: 21757,
    type: 4,
    name: 'ぶらばん！～The bonds of melody～',
    name_cn: '管乐恋曲！~The bonds of melody~',
    collection: { wish: 150, collect: 405, doing: 26, on_hold: 31, dropped: 17 }
  },
  {
    folder_name: '箱庭推理箱庭ロジック',
    subject_id: 100902,
    type: 4,
    name: '箱庭ロジック',
    name_cn: '箱庭逻辑',
    collection: { wish: 317, collect: 433, doing: 47, on_hold: 72, dropped: 37 }
  },
  {
    folder_name: '约会大作战 或守Install',
    subject_id: 96125,
    type: 4,
    name: 'デート・ア・ライブ 或守インストール',
    name_cn: '约会大作战 或守装置',
    collection: { wish: 52, collect: 147, doing: 6, on_hold: 16, dropped: 6 }
  },
  {
    folder_name: '绝区零ZenlessZoneZero',
    subject_id: 380974,
    type: 4,
    name: '绝区零',
    name_cn: '绝区零',
    collection: { wish: 96, collect: 794, doing: 494, on_hold: 104, dropped: 315 }
  },
  {
    folder_name: '缘之空&悠之空',
    subject_id: 2388,
    type: 4,
    name: 'ヨスガノソラ',
    name_cn: '缘之空',
    collection: { wish: 902, collect: 5131, doing: 310, on_hold: 308, dropped: 108 }
  },
  {
    folder_name: '罪之光约会&继代深柑篇 罪ノ光ランデヴー&罪ノ光ランデヴー みかんブロッサム',
    subject_id: 363276,
    type: 4,
    name: '罪ノ光ランデヴー みかんブロッサム',
    name_cn: '罪之光:约会 继代深柑篇',
    collection: { wish: 30, collect: 144, doing: 5, on_hold: 7, dropped: 7 }
  },
  {
    folder_name: '舰队collection',
    subject_id: 84386,
    type: 2,
    name: '艦隊これくしょん -艦これ-',
    name_cn: '舰队Collection',
    collection: { wish: 787, collect: 7044, doing: 383, on_hold: 362, dropped: 590 }
  },
  {
    folder_name: '花咲workspring',
    subject_id: 113633,
    type: 4,
    name: '花咲ワークスプリング！',
    name_cn: '花咲workspring！',
    collection: { wish: 544, collect: 1273, doing: 100, on_hold: 80, dropped: 33 }
  },
  {
    folder_name: '药物少女的呢喃',
    subject_id: 420628,
    type: 2,
    name: '薬屋のひとりごと',
    name_cn: '药屋少女的呢喃',
    collection: { wish: 5356, collect: 18976, doing: 3915, on_hold: 1377, dropped: 729 }
  },
  {
    folder_name: '蔚蓝Celeste',
    subject_id: 236561,
    type: 4,
    name: 'Celeste',
    name_cn: '蔚蓝',
    collection: { wish: 462, collect: 2537, doing: 310, on_hold: 372, dropped: 134 }
  },
  {
    folder_name: '蔚蓝档案BA',
    subject_id: 300648,
    type: 4,
    name: 'ブルーアーカイブ -Blue Archive-',
    name_cn: '蔚蓝档案',
    collection: { wish: 213, collect: 1554, doing: 1190, on_hold: 200, dropped: 332 }
  },
  {
    folder_name: '蔚蓝档案 The Animation',
    subject_id: 416777,
    type: 2,
    name: 'ブルーアーカイブ The Animation',
    name_cn: '蔚蓝档案 动画版',
    collection: { wish: 1149, collect: 4147, doing: 916, on_hold: 556, dropped: 1086 }
  },
  {
    folder_name: '虽然逃走的鱼很大、但钓上来的鱼更大',
    subject_id: 604307,
    type: 2,
    name: '逃がした魚は大きかったが釣りあげた魚が大きすぎた件',
    name_cn: '关于虽然逃走的鱼很大、但钓上来的鱼却太大了这件事',
    collection: { wish: 325, collect: 1086, doing: 521, on_hold: 84, dropped: 218 }
  },
  {
    folder_name: '装甲核心系列ARMORED CORE',
    subject_id: 410290,
    type: 4,
    name: 'ARMORED CORE VI FIRES OF RUBICON',
    name_cn: '机战佣兵VI 境界天火',
    collection: { wish: 333, collect: 777, doing: 86, on_hold: 59, dropped: 44 }
  },
  {
    folder_name: '要来点百合吗Base Profile',
    subject_id: 441750,
    type: 4,
    name: '要来点百合吗',
    name_cn: '要来点百合吗',
    collection: { wish: 14, collect: 73, doing: 3, on_hold: 2, dropped: 3 }
  },
  {
    folder_name: '赛博朋克Cyberpunk 2077',
    subject_id: 65759,
    type: 4,
    name: 'Cyberpunk 2077',
    name_cn: '赛博朋克 2077',
    collection: { wish: 576, collect: 3176, doing: 384, on_hold: 290, dropped: 124 }
  },
  {
    folder_name: '超兽武装',
    subject_id: 33695,
    type: 2,
    name: '超兽武装之勇者无惧',
    name_cn: '超兽武装之勇者无惧',
    collection: { wish: 123, collect: 2270, doing: 35, on_hold: 38, dropped: 43 }
  },
  {
    folder_name: '超次元恋人！！ディメンション凸ラバース!!',
    subject_id: 611546,
    type: 4,
    name: 'ディメンション凸ラバース!!',
    name_cn: '越界恋人!!',
    collection: { wish: 1378, collect: 2279, doing: 490, on_hold: 58, dropped: 21 }
  },
  {
    folder_name: '铠甲勇士',
    subject_id: 121599,
    type: 6,
    name: '铠甲勇士之帝皇侠',
    name_cn: '',
    collection: { wish: 9, collect: 474, doing: 0, on_hold: 2, dropped: 11 }
  },
  {
    folder_name: '银花GINKA',
    subject_id: 402654,
    type: 4,
    name: 'GINKA',
    name_cn: '',
    collection: { wish: 623, collect: 2057, doing: 129, on_hold: 115, dropped: 58 }
  },
  {
    folder_name: '霞流宝石心ジュエリー・ナイツ・アルカディア -The ends of the world-（白玉）',
    subject_id: 489490,
    type: 4,
    name: 'ジュエリー・ナイツ・アルカディア -The ends of the world-',
    name_cn: '宝石夜乐园',
    collection: { wish: 408, collect: 603, doing: 54, on_hold: 27, dropped: 13 }
  },
  {
    folder_name: '青春猪头少年不会梦到兔女郎学姐-怀梦美少女-娇怜外出妹-红书包女孩',
    subject_id: 240038,
    type: 2,
    name: '青春ブタ野郎はバニーガール先輩の夢を見ない',
    name_cn: '青春猪头少年不会梦到兔女郎学姐',
    collection: { wish: 3113, collect: 45040, doing: 1951, on_hold: 1014, dropped: 650 }
  },
  {
    folder_name: '靠死亡游戏混饭吃',
    subject_id: 510753,
    type: 2,
    name: '死亡遊戯で飯を食う。',
    name_cn: '靠死亡游戏混饭吃。',
    collection: { wish: 1850, collect: 4200, doing: 2837, on_hold: 729, dropped: 1995 }
  },
  {
    folder_name: '马里奥',
    subject_id: 205917,
    type: 4,
    name: 'スーパーマリオ オデッセイ',
    name_cn: '超级马力欧 奥德赛',
    collection: { wish: 543, collect: 3428, doing: 390, on_hold: 246, dropped: 98 }
  },
  {
    folder_name: '魔弹战记龙剑道',
    subject_id: 212252,
    type: 6,
    name: '魔弾戦記リュウケンドー',
    name_cn: '魔弹战记龙剑道',
    collection: { wish: 41, collect: 105, doing: 10, on_hold: 3, dropped: 4 }
  },
  {
    folder_name: '龙娘777埋藏的宝藏',
    subject_id: 90388,
    type: 2,
    name: '龍ヶ嬢七々々の埋蔵金',
    name_cn: '龙娘七七七埋藏的宝藏',
    collection: { wish: 1057, collect: 5152, doing: 385, on_hold: 399, dropped: 361 }
  }
];
const byName = new Map();
for (const record of records) {
  const key = normalize(record.folder_name);
  const group = byName.get(key) || [];
  group.push(record);
  byName.set(key, group);
}
const LEARNED_BINDINGS_STATS = Object.freeze({
  records: records.length,
  names: byName.size,
  ambiguousNames: [...byName.values()].filter(
    (group) => new Set(group.map((record) => `${record.type}:${record.subject_id}`)).size > 1
  ).length
});
function lookupLearnedTitleBindings(name, types) {
  const empty = { subjects: [], ambiguous: false, complete: true };
  if (typeof name !== 'string' || name.length > 240 || !Array.isArray(types)) return empty;
  const group = byName.get(normalize(name));
  if (!group) return empty;
  // Check the entire learned name before category filtering. A second known
  // identity must not disappear merely because this caller requested one type.
  const ambiguous = new Set(group.map((record) => `${record.type}:${record.subject_id}`)).size > 1;
  const subjects = group
    .filter((record) => types.includes(record.type))
    .map((record) => ({
      id: record.subject_id,
      type: record.type,
      name: record.name,
      name_cn: record.name_cn,
      aliases: [record.folder_name],
      collection: { ...record.collection }
    }));
  return { subjects, ambiguous, complete: true };
}
module.exports = { LEARNED_BINDINGS_VERSION, LEARNED_BINDINGS_STATS, lookupLearnedTitleBindings };
