'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createLocalIndex } = require('../src/local-index.cjs');
const { searchPlan, searchStages, normalize, subjectNames } = require('../src/model.cjs');
function fixture(t, rows, { omitVerifiedKeys = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-symbol-titles-'));
  const filename = path.join(directory, 'subjects.sqlite');
  const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
    CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT,PRIMARY KEY(subject_id,key)) WITHOUT ROWID;
    CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
    CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT,PRIMARY KEY(kind,id)) WITHOUT ROWID;
    CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT,PRIMARY KEY(kind,id,key)) WITHOUT ROWID;
    CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
    CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT,source TEXT);
    CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
    CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
    CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
    CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');`);
  db.prepare('INSERT INTO metadata VALUES(?,?)').run(
    'source',
    JSON.stringify({ mode: 'full-pilot' })
  );
  db.exec('BEGIN');
  for (const source of rows) {
    const s = {
      type: 4,
      name_cn: '',
      aliases: [],
      date: '2020-01-01',
      collection: { collect: 100 },
      ...source
    };
    db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      s.id,
      s.type,
      s.name,
      s.name_cn,
      0,
      s.date,
      '',
      '[]',
      JSON.stringify(s.collection),
      JSON.stringify(s.aliases),
      '{}'
    );
    for (const name of subjectNames(s).filter(
      (name) => !omitVerifiedKeys || normalize(name) !== 'senrenbanka'
    ))
      db.prepare('INSERT OR IGNORE INTO name_keys VALUES(?,?,?,?,?)').run(
        s.id,
        s.type,
        normalize(name),
        name,
        'name'
      );
  }
  db.exec('INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys; COMMIT');
  db.close();
  const index = createLocalIndex({ localIndexPath: filename });
  assert.equal(index.status().available, true);
  t.after(() => {
    index.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('acg-symbol-titles-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return (query, mode = 'import', types = [4]) => index.search({ query, types, mode });
}
const destiny = { id: 185085, name: 'Destiny 2', name_cn: '命运2' };
const family = (extra = []) => [
  {
    id: 11,
    name: 'Stellar Garden Vol. 1',
    name_cn: '星河花园 第1卷',
    collection: { collect: 1000 },
    date: '2018-01-01'
  },
  {
    id: 12,
    name: 'Stellar Garden Vol. 2',
    name_cn: '星河花园 第2卷',
    collection: { collect: 950 },
    date: '2024-01-01'
  },
  ...extra
];

test('volume representatives reject high-popularity side stories even when clean volume aliases exist', (t) => {
  const extensions = ['After Story', '外传', '番外', 'OVA', 'movie', 'special', '后日谈'];
  const search = fixture(
    t,
    family(
      extensions.map((label, i) => ({
        id: 30 + i,
        name: 'Stellar Garden Vol. 3 ' + label,
        name_cn: '星河花园 第3卷',
        aliases: ['Stellar Garden Vol. 3'],
        collection: { collect: 100000 }
      }))
    )
  );
  const result = search('星河花园Stellar Garden');
  assert.equal(result.selected?.id, 12);
  assert.deepEqual(result.familyEvidence.map((item) => item.id).sort(), [11, 12]);
});

test('raw parenthetical volume numbers and short uppercase acronyms never authorize representatives', (t) => {
  const search = fixture(t, family());
  for (const suffix of ['(Vol. 2)', '（第2卷）', '（第二卷）', '(Vol. II)']) {
    const result = search('星河花园Stellar Garden ' + suffix);
    assert.notEqual(result.seriesRepresentative, true, suffix);
    assert.notEqual(result.selected?.id, 11, suffix);
  }
  const acronym = fixture(t, [
    { id: 41, name: 'ABCDEF Vol. 1', name_cn: '星河花园 第1卷' },
    { id: 42, name: 'ABCDEF Vol. 2', name_cn: '星河花园 第2卷' }
  ]);
  assert.equal(acronym('星河花园ABCDEF').selected, null);
});

test('bare canonical Roman annotations cannot select a popular wrong volume, while ordinary notes still work', (t) => {
  const search = fixture(t, [
    { id: 11, name: 'NEKOPARA Vol.1', name_cn: '猫娘乐园 第1卷', collection: { collect: 10000 } },
    { id: 12, name: 'NEKOPARA Vol.2', name_cn: '猫娘乐园 第2卷', collection: { collect: 100 } }
  ]);
  for (const mode of ['manual', 'import']) {
    assert.equal(search('猫娘乐园NEKOPARA', mode).selected?.id, 11);
    for (const suffix of ['(II)', '（II）', '[II]', '［II］', '(Ⅱ)', '[Ⅱ]', '(IV)', '(ix)']) {
      const result = search('猫娘乐园NEKOPARA ' + suffix, mode);
      assert.notEqual(result.seriesRepresentative, true, suffix + '/' + mode);
      assert.notEqual(result.selected?.id, 11, suffix + '/' + mode);
    }
    for (const suffix of ['(notes)', '[screenshots]', '(civil)', '[IIII]'])
      assert.equal(
        search('猫娘乐园NEKOPARA ' + suffix, mode).selected?.id,
        11,
        suffix + '/' + mode
      );
  }
});

test('uppercase abbreviations and Unicode number differences never become spelling repairs', (t) => {
  const search = fixture(t, [
    { id: 43, name: 'Galaxy', name_cn: '星河花园' },
    { id: 44, name: 'Galaxy ٢', name_cn: '宇宙花园' }
  ]);
  for (const query of ['星河花园GALAXI', '宇宙花园Galaxy ٣']) {
    const result = search(query);
    assert.equal(result.selected, null, query);
    assert.ok(
      result.stages.every((stage) => !stage.spellingCorrection),
      query
    );
  }
});

test('an explicit edition needs the identical qualifier in an independently archived translated name', (t) => {
  const original = { id: 216993, name: "Marvel's Spider-Man", name_cn: '漫威蜘蛛侠' };
  const remastered = {
    id: 499487,
    name: "Marvel's Spider-Man Remastered",
    name_cn: '漫威蜘蛛侠 Remastered'
  };
  const search = fixture(t, [original, remastered]);
  for (const mode of ['manual', 'import']) {
    const result = search("漫威蜘蛛侠Marvel's Spider-Man Remastered", mode);
    assert.equal(result.selected?.id, 499487);
    assert.equal(result.selectedMatch, 1);
    assert.equal(result.stages.at(-1).editionTranslation.qualified, '漫威蜘蛛侠 Remastered');
    assert.equal(search("无关蜘蛛侠Marvel's Spider-Man Remastered", mode).selected, null);
  }
  const untranslated = fixture(t, [original, { ...remastered, name_cn: '漫威蜘蛛侠 重制版' }]);
  assert.equal(
    untranslated("漫威蜘蛛侠Marvel's Spider-Man Remastered").selected,
    null,
    'Do not guess qualifier translations'
  );
  const missing = fixture(t, [original]);
  assert.equal(
    missing("漫威蜘蛛侠Marvel's Spider-Man Remastered").selected,
    null,
    'Never remove the explicit edition to bind its base'
  );
  const wrongType = fixture(t, [original, { ...remastered, type: 2 }]);
  assert.equal(wrongType("漫威蜘蛛侠Marvel's Spider-Man Remastered").selected, null);
});

test('reviewed Senren alias requires the exact canonical ID type and title without modifying archived keys', (t) => {
  const canonical = { id: 172612, name: '千恋＊万花', name_cn: '千恋＊万花' };
  const search = fixture(t, [canonical], { omitVerifiedKeys: true });
  for (const mode of ['manual', 'import']) {
    assert.equal(search('千恋万花SenrenBanka', mode).selected?.id, 172612);
    assert.equal(search('SenrenBanka', mode).selected?.id, 172612);
    assert.equal(search('千恋万花UnrelatedAdventure', mode).selected, null);
  }
  for (const changed of [
    { ...canonical, id: 999 },
    { ...canonical, type: 2 },
    { ...canonical, name: '千恋万花其他作品' }
  ]) {
    const guarded = fixture(t, [changed], { omitVerifiedKeys: true });
    assert.equal(guarded('千恋万花SenrenBanka').selected, null);
    assert.ok(!subjectNames(changed).some((name) => normalize(name) === 'senrenbanka'));
  }
});

test('numeric and uppercase acronym boundaries preserve complete names and both numeric tokens', () => {
  for (const [query, parts] of [
    ['命运2Destiny 2', ['命运2', 'Destiny 2']],
    ['命运2Desiny 2', ['命运2', 'Desiny 2']],
    ['命运-冠位指定FGO', ['命运-冠位指定', 'FGO']]
  ]) {
    assert.deepEqual(searchPlan(query).titleGroups[0]?.parts, parts);
    assert.deepEqual(searchStages(query)[0].terms, [query]);
  }
  for (const query of ['劇場版 FGO', '电影 ABC', '命运2ABC3'])
    assert.deepEqual(searchPlan(query).titleGroups, [], query);
});

test('one Latin typo needs independent exact Han evidence, exact repaired alias and the same digits', (t) => {
  const search = fixture(t, [
    destiny,
    { id: 109378, name: 'Fate/Grand Order', name_cn: '命运-冠位指定', aliases: ['FGO'] }
  ]);
  for (const mode of ['manual', 'import']) {
    for (const query of ['命运2Destiny 2', '命运２Destiny ２', '命运2Desiny 2']) {
      const r = search(query, mode);
      assert.equal(r.selected?.id, 185085);
      assert.equal(r.selectedMatch, 1);
      assert.equal(r.complete, true);
    }
    const typo = search('命运2Desiny 2', mode);
    assert.deepEqual(typo.stages.at(-1).spellingCorrection, {
      original: 'Desiny 2',
      corrected: 'Destiny 2'
    });
    assert.equal(search('命运-冠位指定FGO', mode).selected?.id, 109378);
  }
  for (const query of ['命运2Unrelated 2', '命运2Desiny 3', '命运3Destiny 2', '命运2Dsny 2'])
    assert.equal(search(query).selected, null, query);
});

test('a conflicting archived foreign identity or two possible repairs remain manual', (t) => {
  const exact = fixture(t, [destiny, { id: 90, name: 'Desiny 2', name_cn: '另一个作品' }]);
  assert.equal(exact('命运2Desiny 2').selected, null);
  const ambiguous = fixture(t, [destiny, { id: 91, name: 'Desiny 2X', name_cn: '命运2' }]);
  assert.equal(ambiguous('命运2Desiny 2').selected, null);
  assert.equal(exact('命运2Desiny 2', 'import', [2]).selected, null);
});

test('two fully proven bilingual volumes select a labeled representative by existing popularity/date policy', (t) => {
  const search = fixture(t, family());
  for (const mode of ['manual', 'import']) {
    const r = search('星河花园Stellar Garden', mode);
    assert.equal(r.selected?.id, 12);
    assert.equal(r.selectedMatch, 0.97);
    assert.equal(r.complete, true);
    assert.equal(r.selectionReason, 'bilingual-series-representative');
    assert.equal(r.evidenceLabel, '系列代表');
    assert.equal(r.familyEvidence.length, 2);
  }
  const popular = fixture(
    t,
    family().map((s) => (s.id === 12 ? { ...s, collection: { collect: 100 } } : s))
  );
  assert.equal(
    popular('星河花园Stellar Garden').selected?.id,
    11,
    'Much weaker popularity cannot be replaced merely by a newer date'
  );
});

test('ordinary extensions, another type and one-sided aliases do not join the bilingual volume family', (t) => {
  const search = fixture(
    t,
    family([
      {
        id: 20,
        name: 'Stellar Garden After',
        name_cn: '星河花园 After',
        collection: { collect: 900000 }
      },
      {
        id: 21,
        name: 'Stellar Garden Extra',
        name_cn: '星河花园 世界连结',
        collection: { collect: 900000 }
      },
      {
        id: 22,
        type: 2,
        name: 'Stellar Garden Vol. 3',
        name_cn: '星河花园 第3卷',
        collection: { collect: 900000 }
      },
      {
        id: 23,
        name: 'Stellar Garden Vol. 4',
        name_cn: '另一中文系列 第4卷',
        collection: { collect: 900000 }
      }
    ])
  );
  const r = search('星河花园Stellar Garden');
  assert.deepEqual(r.familyEvidence.map((s) => s.id).sort(), [11, 12]);
  assert.equal(r.selected?.id, 12);
  const one = fixture(t, [
    family()[0],
    { id: 24, name: 'Stellar Garden Vol. 2', name_cn: '其他译名 第2卷' }
  ]);
  assert.equal(one('星河花园Stellar Garden').selected, null);
});

test('duplicate volumes, contradictory volume translations and insufficient family evidence stay manual', (t) => {
  const duplicate = fixture(
    t,
    family([{ id: 25, name: 'Stellar Garden Volume 2', name_cn: '星河花园 卷2' }])
  );
  assert.equal(duplicate('星河花园Stellar Garden').selected, null);
  assert.equal(duplicate('星河花园Stellar Garden').selectionReason, 'ambiguous-series-identity');
  const inconsistent = fixture(t, [
    family()[0],
    { id: 26, name: 'Stellar Garden Vol. 3', name_cn: '星河花园 第2卷' }
  ]);
  assert.equal(inconsistent('星河花园Stellar Garden').selected, null);
});

test('explicit installment input never uses unnumbered representative selection and complete whole names win', (t) => {
  const search = fixture(
    t,
    family([{ id: 27, name: '星河花园Stellar Garden', name_cn: '完整名称' }])
  );
  assert.equal(search('星河花园Stellar Garden').selected?.id, 27);
  const numbered = fixture(t, family());
  const r = numbered('星河花园 第2卷Stellar Garden Vol. 2');
  assert.equal(r.selected?.id, 12);
  assert.equal(r.seriesRepresentative, undefined);
  assert.equal(numbered('星河花园2Stellar Garden3').selected, null);
});

test('a capped volume-family prefix recall cannot fall back to an automatic fragment', (t) => {
  const rows = Array.from({ length: 520 }, (_, i) => ({
    id: 1000 + i,
    name: `Stellar Garden Vol. ${i % 99}`,
    name_cn: `星河花园 第${i % 99}卷`
  }));
  const search = fixture(t, rows);
  const r = search('星河花园Stellar Garden');
  assert.equal(r.selected, null);
  assert.equal(r.complete, false);
  assert.equal(r.truncated, true);
  assert.equal(r.selectionReason, 'incomplete-recall');
});

test('decorative symbols and exact unnumbered titles retain their original safe behavior', (t) => {
  const search = fixture(t, [
    { id: 172612, name: '千恋＊万花', name_cn: '千恋＊万花' },
    { id: 216993, name: "Marvel's Spider-Man", name_cn: '漫威蜘蛛侠' },
    {
      id: 349034,
      name: "Marvel's Spider-Man 2",
      name_cn: '漫威蜘蛛侠2',
      date: '2025-01-01',
      collection: { collect: 999999 }
    }
  ]);
  assert.equal(search('千恋万花').selected?.id, 172612);
  assert.equal(search("漫威蜘蛛侠Marvel's spider-man").selected?.id, 216993);
});
