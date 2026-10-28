'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { sortKey } = require('../src/natural-sort.cjs');
const compare = (a, b) => Buffer.compare(Buffer.from(sortKey(a)), Buffer.from(sortKey(b)));

test('symbols, numbers and Latin names precede Han names instead of interleaving by pinyin', () => {
  const names = [
    '阿尔法10',
    'zebra',
    '中文10',
    '2',
    '中文2',
    '!',
    'A中文10',
    '10',
    '阿尔法2',
    'A中文2'
  ];
  assert.deepEqual(names.sort(compare), [
    '!',
    '2',
    '10',
    'A中文2',
    'A中文10',
    'zebra',
    '阿尔法2',
    '阿尔法10',
    '中文2',
    '中文10'
  ]);
});

test('the first letter or number determines mixed names; leading decorations do not disguise Chinese', () => {
  const front = ['[Alpha2]', '😀Alpha10', '  02中文', 'A中文', 'カナ2', '###', '😀'];
  const chinese = ['[中文2]', '【白色2】', '(阿尔法10)', '  中文A', '😀中文10'];
  const result = [...chinese, ...front].sort(compare);
  assert.deepEqual(result.slice(0, front.length).slice().sort(), front.slice().sort());
  assert.deepEqual(result.slice(front.length).slice().sort(), chinese.slice().sort());
  assert.deepEqual(['[中文2]', '阿尔法10', '(白色2)', '陈2', '😀中文10'].sort(compare), [
    '阿尔法10',
    '(白色2)',
    '陈2',
    '[中文2]',
    '😀中文10'
  ]);
  assert.ok(compare('A中文', '中文A') < 0);
  assert.ok(compare('2中文', '中文2') < 0);
});

test('SQLite binary keys provide stable timestamp ties, natural numeric ties and paginated directions', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE nodes(id TEXT PRIMARY KEY,name TEXT,sortkey TEXT,mtime INTEGER); CREATE INDEX ordered ON nodes(mtime,sortkey,id);'
    );
    const insert = db.prepare('INSERT INTO nodes VALUES(?,?,?,?)');
    const names = [
      '中文10',
      'zebra',
      '阿2',
      '[白色2]',
      'Work10',
      'Work02',
      'work2',
      '2中文',
      '中文2',
      '!'
    ];
    names.forEach((name, index) =>
      insert.run(String(index).padStart(2, '0'), name, sortKey(name), 42)
    );
    const expected = [
      '!',
      '2中文',
      'Work02',
      'work2',
      'Work10',
      'zebra',
      '阿2',
      '[白色2]',
      '中文2',
      '中文10'
    ];
    for (const direction of ['ASC', 'DESC']) {
      const rows = db
        .prepare(
          `SELECT name FROM nodes ORDER BY mtime ${direction},sortkey ${direction},id ${direction}`
        )
        .all()
        .map((row) => row.name);
      assert.deepEqual(rows, direction === 'ASC' ? expected : [...expected].reverse());
      const paginated = [];
      for (let offset = 0; offset < names.length; offset += 3)
        paginated.push(
          ...db
            .prepare(
              `SELECT name FROM nodes ORDER BY mtime ${direction},sortkey ${direction},id ${direction} LIMIT 3 OFFSET ?`
            )
            .all(offset)
            .map((row) => row.name)
        );
      assert.deepEqual(paginated, rows);
    }
    const plan = db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT name FROM nodes ORDER BY mtime,sortkey,id LIMIT 3 OFFSET 3'
      )
      .all();
    assert.ok(plan.some((row) => row.detail.includes('ordered')));
    assert.ok(plan.every((row) => !row.detail.includes('TEMP B-TREE')));
  } finally {
    db.close();
  }
});
