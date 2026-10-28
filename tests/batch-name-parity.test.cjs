'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { createLocalIndex } = require('../src/local-index.cjs');
const { normalize, subjectNames, idFor, searchPlan } = require('../src/model.cjs');

// Identity fields from the read-only Full archive, not network responses.
const games = [
  {
    query: '地平线零之曙光',
    id: 137460,
    type: 4,
    name: 'Horizon Zero Dawn',
    name_cn: '地平线 零之曙光',
    aliases: ['地平线 黎明时分', '地平线 重返黎明', '地平線 期待黎明'],
    date: '2017-02-28'
  },
  {
    query: '荒野大镖客救赎2',
    id: 195573,
    type: 4,
    name: 'Red Dead Redemption 2',
    name_cn: '荒野大镖客：救赎2',
    aliases: ['荒野大镖客2', '碧血狂殺2', 'RDR2'],
    date: '2018-10-26'
  },
  {
    query: '狐姬零',
    id: 247785,
    type: 4,
    name: 'Fox Hime Zero',
    name_cn: '狐姬零',
    aliases: ['狐姫 Zero'],
    date: '2018-05-24'
  },
  {
    query: '鬼泣5',
    id: 249292,
    type: 4,
    name: 'デビル メイ クライ 5',
    name_cn: '鬼泣5',
    aliases: [
      'Devil May Cry 5',
      '恶魔猎人5',
      'デビルメイクライ5',
      'Devil May Cry V',
      '鬼泣5 特别版'
    ],
    date: '2019-03-08'
  }
];
const reported = [
  { ...games[3], query: '鬼泣5Devil May Cry 5' },
  { ...games[1], query: '荒野大镖客：救赎2Red Dead Redemption 2' },
  { ...games[2], query: '狐姬零Fox Hime Zero' },
  { ...games[0], query: '地平线：零之曙光Horizon Zero Dawn Complete Edition' }
];
const variants = games.flatMap((s) => [
  [s.query, s.id],
  [s.query + '（游戏截图）', s.id],
  [s.query.replace(/(2|5)/g, (x) => String.fromCharCode(x.charCodeAt(0) + 65248)), s.id],
  [s.name, s.id]
]);
variants.push(...reported.map((s) => [s.query, s.id]));
variants.push(
  ['地平线 零之曙光', 137460],
  ['荒野大镖客：救赎 2', 195573],
  ['鬼泣 5', 249292],
  ['Devil May Cry V', 249292]
);
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-batch-parity-'));
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
  const rows = [
    ...games,
    { id: 700001, type: 2, name: '鬼泣5', name_cn: '', aliases: [], date: '2026-01-01' },
    {
      id: 333684,
      type: 4,
      name: 'Devil May Cry 5 Special Edition',
      name_cn: '鬼泣5 特别版',
      aliases: [],
      date: '2020-11-12'
    },
    { id: 700002, type: 4, name: 'Fox Hime', name_cn: '狐姬', aliases: [], date: '2017-11-01' }
  ];
  for (const s of rows) {
    const collection = { collect: games.some((g) => g.id === s.id) ? 2000 : 10 };
    db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      s.id,
      s.type,
      s.name,
      s.name_cn,
      0,
      s.date,
      'Generated regression metadata',
      '[]',
      JSON.stringify(collection),
      JSON.stringify(s.aliases),
      '{}'
    );
    for (const name of subjectNames(s))
      db.prepare('INSERT OR IGNORE INTO name_keys VALUES(?,?,?,?,?)').run(
        s.id,
        s.type,
        normalize(name),
        name,
        'name'
      );
  }
  db.exec('INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys');
  db.close();
  const index = createLocalIndex({ localIndexPath: filename });
  const workers = [];
  t.after(async () => {
    for (const worker of workers.reverse()) await worker.close();
    index.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('acg-batch-parity-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, filename, index, workers };
}

function appendSubjects(f, subjects) {
  const db = new DatabaseSync(f.filename);
  try {
    db.exec('BEGIN');
    for (const s of subjects) {
      db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        s.id,
        s.type || 4,
        s.name,
        s.name_cn || '',
        0,
        s.date || '2025-01-01',
        '',
        '[]',
        JSON.stringify({ collect: s.collections || 10000 }),
        JSON.stringify(s.aliases || []),
        '{}'
      );
      for (const name of subjectNames(s)) {
        const key = normalize(name);
        if (
          db
            .prepare('INSERT OR IGNORE INTO name_keys VALUES(?,?,?,?,?)')
            .run(s.id, s.type || 4, key, name, 'name').changes
        )
          db.prepare('INSERT INTO names_fts(key,subject_id,type) VALUES(?,?,?)').run(
            key,
            s.id,
            s.type || 4
          );
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

async function client(
  f,
  {
    localIndexPath = f.filename,
    dataDir = path.join(f.directory, 'data'),
    network = '403',
    fastClock = true
  } = {}
) {
  const worker = new Worker(
    `
    const {parentPort,workerData}=require('node:worker_threads');
    // Preserve throttle ordering without waiting for actual public API intervals.
    if(workerData.fastClock){const realNow=Date.now;let tick=0;Date.now=()=>realNow()+(++tick*2000);}
    global.fetch=async(url)=>{parentPort.postMessage({event:'fixtureHTTP',data:String(url)});
      return {status:workerData.network==='empty'?200:403,ok:workerData.network==='empty',headers:new Headers(),json:async()=>({data:[],total:0,limit:20,offset:0})};};
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        localIndexPath,
        network,
        fastClock,
        token: '',
        watch: false,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  let sequence = 0,
    closed = false,
    failure = null;
  const pending = new Map(),
    events = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Worker ready timeout')), 12000);
    worker.once('error', (error) => {
      failure = error;
      clearTimeout(timer);
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      pending.clear();
      reject(error);
    });
    worker.on('message', (m) => {
      if (m.event === 'ready') {
        clearTimeout(timer);
        resolve();
      }
      if (m.event) events.push(m);
      const p = pending.get(m.request);
      if (p) {
        pending.delete(m.request);
        clearTimeout(p.timer);
        m.error ? p.reject(new Error(m.error)) : p.resolve(m.result);
      }
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const request = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout: ' + method));
      }, 12000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  const c = {
    call,
    events,
    async close() {
      if (closed) return;
      closed = true;
      try {
        if (!failure) await call('shutdown');
      } finally {
        await worker.terminate();
        for (const p of pending.values()) clearTimeout(p.timer);
      }
    }
  };
  f.workers.push(c);
  await ready;
  await call('settings', { key: 'watchChanges', value: false });
  await call('settings', { key: 'autoMatch', value: false });
  return c;
}
async function waitFor(label, action) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    const value = await action();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out: ' + label);
}
function folders(f, names = games.map((s) => s.query)) {
  const source = path.join(f.directory, 'generated-collection');
  for (const name of names) fs.mkdirSync(path.join(source, name), { recursive: true });
  return source;
}
async function bound(c, source, entries = games) {
  return waitFor('all generated game folders bound locally', async () => {
    const rows = await Promise.all(
      entries.map((s) => c.call('get', { id: idFor(path.join(source, s.query)) }))
    );
    return rows.every((n, i) => n?.subject_id === entries[i].id) ? rows : null;
  });
}

test('four reported games preserve manual/import identity for spaces, punctuation, numeric width and aliases', (t) => {
  const f = fixture(t);
  for (const [query, id] of variants) {
    for (const mode of ['manual', 'import']) {
      const result = f.index.search({ query, types: [4], mode });
      assert.equal(result.complete, true, query);
      assert.equal(result.selected?.id, id, query + '/' + mode);
      assert.equal(result.selectedMatch, 1, query + '/' + mode);
      assert.ok(result.candidates.every((s) => s.type === 4));
    }
  }
  assert.equal(f.index.search({ query: '鬼泣5', types: [2], mode: 'import' }).selected.id, 700001);
  for (const query of ['鬼泣4', '荒野大镖客救赎3', '01. 鬼泣5', '狐姬零 Unrelated Adventure'])
    assert.equal(f.index.search({ query, types: [4], mode: 'import' }).selected, null, query);
});

test('403 resource pause still binds every local batch identity, warm manual search agrees and confirm is not a skip flag', async (t) => {
  const f = fixture(t),
    source = folders(f),
    c = await client(f);
  await c.call('scan', {
    path: source,
    onlineMatch: false,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  for (const s of games)
    await c.call('patch', { id: idFor(path.join(source, s.query)), changes: { confirmed: 1 } });
  await c.call('scan', {
    path: source,
    onlineMatch: true,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  const rows = await bound(c, source);
  await waitFor('access pause', async () => (await c.call('init')).online.paused === 'access');
  for (let i = 0; i < games.length; i++) {
    assert.equal(rows[i].manual_subject, 0);
    assert.equal(rows[i].match_confidence, 1);
    assert.equal(rows[i].confirmed, 1);
    for (let warm = 0; warm < 2; warm++) {
      const manual = await c.call('match', { id: rows[i].id });
      assert.equal(manual.candidates[0].id, games[i].id);
      assert.equal(manual.candidates[0].match, 1);
    }
  }
  assert.equal(c.events.filter((e) => e.event === 'error').length, 0);
  assert.ok(c.events.some((e) => e.event === 'fixtureHTTP'));
});

test('same-path remove/reimport and persistent negative HTTP cache do not block newly available local identities', async (t) => {
  const f = fixture(t),
    source = folders(f);
  let c = await client(f, {
    localIndexPath: path.join(f.directory, 'absent.sqlite'),
    network: 'empty',
    fastClock: false
  });
  await c.call('scan', {
    path: source,
    onlineMatch: true,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  await waitFor('negative online sweep completed', async () => {
    const status = (await c.call('init')).online;
    return !status.active && !status.remaining && !status.discovering;
  });
  for (const s of games)
    assert.equal((await c.call('get', { id: idFor(path.join(source, s.query)) })).subject_id, null);
  assert.ok(c.events.some((e) => e.event === 'fixtureHTTP' && e.data.includes('/search/subjects')));
  const negativeCount = () => {
    const db = new DatabaseSync(path.join(f.directory, 'data', 'library.sqlite'), {
      readOnly: true
    });
    try {
      return db
        .prepare(
          "SELECT count(*) count FROM bangumi_cache WHERE json_array_length(value,'$.data')=0 AND expires_at>?"
        )
        .get(Date.now()).count;
    } finally {
      db.close();
    }
  };
  assert.ok(
    negativeCount() >= games.length,
    'Unexpired empty-search responses were actually persisted'
  );
  await c.call('removeRoot', { id: idFor(source) });
  await c.close();
  c = await client(f, { fastClock: false });
  await c.call('scan', {
    path: source,
    onlineMatch: true,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  const rows = await bound(c, source);
  assert.ok(rows.every((n) => n.match_confidence === 1 && n.manual_subject === 0));
  assert.ok(
    negativeCount() >= games.length,
    'Local selection bypasses still-valid negative HTTP cache'
  );
  await c.call('removeRoot', { id: idFor(source) });
  await c.call('scan', {
    path: source,
    onlineMatch: true,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  assert.ok((await bound(c, source)).every((n) => n.match_confidence === 1));
});

test('manual identity, disabled policy and nested directory remain intentional automatic gates', async (t) => {
  const f = fixture(t),
    source = folders(f),
    c = await client(f);
  fs.mkdirSync(path.join(source, 'group', '鬼泣5'), { recursive: true });
  await c.call('scan', {
    path: source,
    onlineMatch: false,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  assert.equal((await c.call('get', { id: idFor(path.join(source, '鬼泣5')) })).subject_id, null);
  await c.call('bind', {
    id: idFor(path.join(source, '鬼泣5')),
    url: 'https://bgm.tv/subject/249292'
  });
  await c.call('scan', {
    path: source,
    onlineMatch: true,
    directoryKind: 'work',
    subjectTypes: [4]
  });
  await bound(c, source);
  const manual = await c.call('get', { id: idFor(path.join(source, '鬼泣5')) });
  assert.equal(manual.manual_subject, 1);
  assert.equal(manual.subject_id, 249292);
  const nested = await c.call('get', { id: idFor(path.join(source, 'group', '鬼泣5')) });
  assert.equal(nested.depth, 2);
  assert.equal(nested.subject_id, null);
  assert.equal((await c.call('match', { id: nested.id })).candidates[0].id, 249292);
});

test('exact bilingual identity precedes broad FTS without relaxing ordinary incomplete recall', (t) => {
  const f = fixture(t);
  appendSubjects(
    f,
    Array.from({ length: 600 }, (_, i) => ({
      id: 800000 + i,
      name: 'Horizon Zero Dawn Other Game ' + i,
      name_cn: '无关游戏' + i
    }))
  );
  const result = f.index.search({ query: reported[3].query, types: [4], mode: 'import' });
  assert.equal(result.selected?.id, 137460);
  assert.equal(result.selectionReason, 'exact-bilingual-identity');
  assert.equal(result.complete, true);
  assert.ok(result.retrievedRows < 10);
  const broad = f.index.search({ query: 'Horizon Zero Dawn', types: [4], mode: 'import' });
  assert.equal(broad.complete, false);
  assert.equal(broad.selected, null, 'Existing truncated exact-name recall remains manual');
  const cappedMain = f.index.search({
    query: 'Horizon Zero Dawx (鬼泣5Devil May Cry 5)',
    types: [4],
    mode: 'import'
  });
  assert.equal(cappedMain.complete, false);
  assert.equal(
    cappedMain.selected,
    null,
    'An earlier incomplete main cannot be bypassed by a note proof'
  );
});

test('bilingual proof rejects mismatched installments, types, translations and unsupported editions', (t) => {
  const f = fixture(t);
  for (const query of [
    '鬼泣5Devil May Cry 4',
    '狐姬零Horizon Zero Dawn',
    '地平线：零之曙光Horizon Zero Dawn Remastered',
    '地平线：零之曙光Horizon Zero Dawn Definitive Edition'
  ])
    assert.equal(f.index.search({ query, types: [4], mode: 'import' }).selected, null, query);
  assert.equal(
    f.index.search({ query: reported[0].query, types: [2], mode: 'import' }).selected,
    null
  );
  appendSubjects(f, [
    { id: 700004, name: 'Horizon Zero Dawn Complete Edition', name_cn: '地平线 完全版' }
  ]);
  for (const mode of ['manual', 'import'])
    assert.equal(
      f.index.search({ query: reported[3].query, types: [4], mode }).selected,
      null,
      'Separately archived edition cannot collapse to base'
    );
});

test('duplicate bilingual identities stay manual and an archived complete whole name keeps precedence', (t) => {
  const f = fixture(t);
  appendSubjects(f, [{ ...games[3], id: 700005 }]);
  for (const mode of ['manual', 'import']) {
    const result = f.index.search({ query: reported[0].query, types: [4], mode });
    assert.equal(
      result.selected,
      null,
      'Popularity cannot choose duplicate translation identities'
    );
    assert.equal(result.selectionReason, 'ambiguous-bilingual-identity');
  }
  appendSubjects(f, [{ id: 700006, name: reported[0].query, name_cn: reported[0].query }]);
  assert.equal(
    f.index.search({ query: reported[0].query, types: [4], mode: 'import' }).selected?.id,
    700006
  );
});

test('truncated exact bilingual recall never claims a unique identity', (t) => {
  const f = fixture(t);
  appendSubjects(
    f,
    Array.from({ length: 520 }, (_, i) => ({ ...games[2], id: 810000 + i }))
  );
  const result = f.index.search({ query: reported[2].query, types: [4], mode: 'import' });
  assert.equal(result.selected, null);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('bilingual preflight cannot promote a note before a credible main or that note whole title', (t) => {
  const f = fixture(t);
  const main = f.index.search({ query: 'Horizon Zero Dawx', types: [4], mode: 'import' });
  assert.equal(main.selected?.id, 137460);
  const annotated = f.index.search({
    query: 'Horizon Zero Dawx (鬼泣5Devil May Cry 5)',
    types: [4],
    mode: 'import'
  });
  assert.equal(annotated.selected?.id, 137460);
  assert.deepEqual(annotated.stages[0].terms, ['Horizon Zero Dawx']);
  appendSubjects(f, [{ id: 700020, name: '鬼泣5Devil May Cry 5', name_cn: '完整名字官方条目' }]);
  const fallback = f.index.search({
    query: 'Missing Main (鬼泣5Devil May Cry 5)',
    types: [4],
    mode: 'import'
  });
  assert.equal(fallback.selected?.id, 700020);
  assert.deepEqual(fallback.stages[0].terms, ['Missing Main']);
});

test('short script pairing keeps media qualifiers inside their complete titles', () => {
  for (const query of [
    '劇場版 Fate/stay night',
    '剧场版 Fate/stay night',
    '特别篇 Devil May Cry',
    '重制版 Horizon Zero Dawn'
  ])
    assert.deepEqual(searchPlan(query).titleGroups, [], query);
});

const fullIndexPath = process.env.ACG_PARITY_FULL_INDEX;
test(
  'optional real Full four-name local and batch parity without live network',
  { skip: !fullIndexPath },
  async (t) => {
    const f = fixture(t),
      index = createLocalIndex({ localIndexPath: fullIndexPath });
    t.after(() => index.close());
    assert.equal(index.status().available, true);
    for (const s of [...games, ...reported])
      for (const mode of ['manual', 'import']) {
        const result = index.search({ query: s.query, types: [4], mode });
        assert.equal(result.selected?.id, s.id);
        assert.equal(result.selectedMatch, 1);
        assert.equal(result.complete, true);
      }
    const c = await client(f, { localIndexPath: fullIndexPath }),
      source = folders(
        f,
        reported.map((s) => s.query)
      );
    await c.call('scan', {
      path: source,
      onlineMatch: true,
      directoryKind: 'work',
      subjectTypes: [4]
    });
    const rows = await bound(c, source, reported);
    assert.ok(rows.every((n) => n.match_confidence === 1 && !n.manual_subject));
    t.diagnostic(
      JSON.stringify({
        scope: 'Generated source tree and profile only; real Full read-only; no live HTTP',
        importPolicy: { directoryKind: 'work', subjectTypes: [4], onlineMatch: true },
        bindings: rows.map((node, i) => ({
          directoryName: reported[i].query,
          depth: node.depth,
          subjectId: node.subject_id,
          confidence: node.match_confidence,
          manual: node.manual_subject
        }))
      })
    );
  }
);

test(
  'optional real Full numeric acronym decorative and series names bind through the production worker',
  { skip: !fullIndexPath },
  async (t) => {
    const entries = [
      { query: '命运2Desiny 2', id: 185085, score: 1 },
      { query: '命运2Destiny 2', id: 185085, score: 1 },
      { query: "漫威蜘蛛侠Marvel's spider-man", id: 216993, score: 1 },
      { query: '猫娘乐园NEKOPARA', id: 107596, score: 0.97 },
      { query: '命运-冠位指定FGO', id: 109378, score: 1 },
      { query: '千恋万花', id: 172612, score: 1 },
      { query: "漫威蜘蛛侠Marvel's Spider-Man Remastered", id: 499487, score: 1 },
      { query: '千恋万花SenrenBanka', id: 172612, score: 1 }
    ];
    const f = fixture(t),
      index = createLocalIndex({ localIndexPath: fullIndexPath });
    t.after(() => index.close());
    const local = entries.map((entry) => {
      for (const mode of ['manual', 'import']) {
        const result = index.search({ query: entry.query, types: [4], mode });
        assert.equal(result.selected?.id, entry.id, entry.query);
        assert.equal(result.selectedMatch, entry.score);
        assert.equal(result.complete, true);
      }
      const result = index.search({ query: entry.query, types: [4], mode: 'import' });
      return {
        directoryName: entry.query,
        id: entry.id,
        score: result.selectedMatch,
        complete: result.complete,
        automatic: !!result.selected,
        reason: result.selectionReason,
        label: result.evidenceLabel || null
      };
    });
    const c = await client(f, { localIndexPath: fullIndexPath }),
      source = folders(
        f,
        entries.map((entry) => entry.query)
      );
    await c.call('scan', {
      path: source,
      onlineMatch: true,
      directoryKind: 'work',
      subjectTypes: [4]
    });
    const policy = await c.call('getRootMatchPolicy', { id: idFor(source) });
    assert.equal(policy.matchDepth, 1);
    assert.deepEqual(policy.subjectTypes, [4]);
    assert.equal(policy.onlineMatch, true);
    const nodes = await bound(c, source, entries);
    for (let i = 0; i < nodes.length; i++) {
      assert.equal(nodes[i].match_confidence, entries[i].score);
      assert.equal(nodes[i].manual_subject, 0);
      assert.equal(nodes[i].depth, 1);
      const manual = await c.call('match', { id: nodes[i].id });
      assert.equal(manual.candidates[0]?.id, entries[i].id);
      assert.equal(manual.candidates[0]?.match, entries[i].score);
    }
    t.diagnostic(
      JSON.stringify({
        scope: 'Isolated generated work root/profile; Full read-only; all HTTP mocked',
        policy: {
          matchDepth: policy.matchDepth,
          types: policy.subjectTypes,
          online: policy.onlineMatch
        },
        local,
        bindings: nodes.map((node, i) => ({
          directoryName: entries[i].query,
          subjectId: node.subject_id,
          confidence: node.match_confidence,
          manual: node.manual_subject
        }))
      })
    );
  }
);

test(
  'optional real Full name-policy upgrade retries old misses once, resets old cursors and preserves protected nodes',
  { skip: !fullIndexPath },
  async (t) => {
    const { MATCHING_POLICY_VERSION } = require('../src/matching.cjs');
    const entries = [
      { query: '命运2Desiny 2', id: 185085 },
      { query: '猫娘乐园NEKOPARA', id: 107596 },
      { query: "漫威蜘蛛侠Marvel's Spider-Man Remastered", id: 499487 },
      { query: '千恋万花SenrenBanka', id: 172612 }
    ];
    for (const oldCursor of [null, 'ffffffffffffffffffffffff']) {
      const f = fixture(t);
      const source = folders(f, [
        ...entries.map((entry) => entry.query),
        '手工保留',
        '既有绑定',
        '分组'
      ]);
      const deepPath = path.join(source, '分组', '命运2Destiny 2');
      fs.mkdirSync(deepPath);
      const disabledRoot = path.join(f.directory, 'disabled-root'),
        disabledPath = path.join(disabledRoot, '命运2Destiny 2');
      fs.mkdirSync(disabledPath, { recursive: true });
      let c = await client(f, { localIndexPath: path.join(f.directory, 'absent.sqlite') });
      for (const folder of [source, disabledRoot])
        await c.call('scan', {
          path: folder,
          onlineMatch: false,
          subjectTypes: [4],
          directoryKind: 'work'
        });
      await c.close();
      const file = path.join(f.directory, 'data', 'library.sqlite');
      let db = new DatabaseSync(file);
      try {
        db.exec('BEGIN');
        db.prepare('DELETE FROM settings WHERE key=?').run('matchingNamePolicyVersion');
        db.exec('DELETE FROM match_pending; DELETE FROM match_frontier;');
        db.prepare(
          'UPDATE root_match_policy SET enabled=1,auto_enabled=1,match_depth=1 WHERE root=?'
        ).run(idFor(source));
        db.prepare('UPDATE root_match_policy SET enabled=0,auto_enabled=0 WHERE root=?').run(
          idFor(disabledRoot)
        );
        db.prepare('UPDATE nodes SET subject_id=7777,manual_subject=1,confirmed=1 WHERE id=?').run(
          idFor(path.join(source, '手工保留'))
        );
        db.prepare(
          'UPDATE nodes SET subject_id=185085,manual_subject=0,match_confidence=0.92,confirmed=1 WHERE id=?'
        ).run(idFor(path.join(source, '既有绑定')));
        db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?,?)').run(
          185085,
          JSON.stringify({
            id: 185085,
            type: 4,
            name: 'Destiny 2',
            name_cn: '命运2',
            resources_complete: true
          }),
          Date.now()
        );
        if (oldCursor)
          db.prepare('INSERT INTO match_frontier(root,after_id) VALUES(?,?)').run(
            idFor(source),
            oldCursor
          );
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      c = await client(f, { localIndexPath: fullIndexPath });
      const nodes = await bound(c, source, entries);
      assert.ok(nodes.every((node) => !node.manual_subject));
      assert.equal(
        (await c.call('get', { id: idFor(path.join(source, '手工保留')) })).subject_id,
        7777
      );
      const existing = await c.call('get', { id: idFor(path.join(source, '既有绑定')) });
      assert.equal(existing.subject_id, 185085);
      assert.equal(existing.match_confidence, 0.92);
      for (const protectedPath of [deepPath, disabledPath])
        assert.equal((await c.call('get', { id: idFor(protectedPath) })).subject_id, null);
      await c.close();
      db = new DatabaseSync(file);
      try {
        assert.equal(
          JSON.parse(
            db.prepare('SELECT value FROM settings WHERE key=?').get('matchingNamePolicyVersion')
              .value
          ),
          MATCHING_POLICY_VERSION
        );
        db.exec('DELETE FROM match_pending; DELETE FROM match_frontier;');
        // An unbound sentinel makes a repeated upgrade observable on restart.
        db.prepare(
          'UPDATE nodes SET subject_id=NULL,manual_subject=0,match_confidence=NULL WHERE id=?'
        ).run(idFor(path.join(source, entries[0].query)));
      } finally {
        db.close();
      }
      c = await client(f, { localIndexPath: fullIndexPath });
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        (await c.call('get', { id: idFor(path.join(source, entries[0].query)) })).subject_id,
        null,
        'Policy upgrade must not requeue a second time'
      );
      db = new DatabaseSync(file, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) n FROM match_pending').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) n FROM match_frontier').get().n, 0);
        assert.equal(
          JSON.parse(
            db.prepare('SELECT value FROM settings WHERE key=?').get('matchingNamePolicyVersion')
              .value
          ),
          MATCHING_POLICY_VERSION
        );
      } finally {
        db.close();
      }
      t.diagnostic(
        JSON.stringify({
          upgrade: 'generated old profile only',
          oldCursor,
          version: MATCHING_POLICY_VERSION,
          retriedIds: nodes.map((node) => node.subject_id),
          manualPreserved: true,
          matchedPreserved: true,
          disabledAndDeepUntouched: true,
          secondBootNotRepeated: true
        })
      );
    }
  }
);
