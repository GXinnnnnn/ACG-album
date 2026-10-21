'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Worker } = require('node:worker_threads');
const { normalize, subjectNames, idFor } = require('../src/model.cjs');
const { rankImportSubjects } = require('../src/matching.cjs');
const { createLocalIndex, MAX_ROWS } = require('../src/local-index.cjs');

function fixture(
  t,
  { lite = false, detailNone = false, subjects = [], entities = [], links = [], manifest } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acg-local-index-'));
  const directory = path.join(root, 'local-index');
  fs.mkdirSync(directory);
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
    CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram'${detailNone ? ',detail=none' : ''});
    CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram'${detailNone ? ',detail=none' : ''});`);
  db.exec('BEGIN');
  db.prepare('INSERT INTO metadata VALUES(?,?)').run(
    'source',
    JSON.stringify({
      mode: lite ? 'lite-search' : 'full-pilot',
      rawRecordsPreserved: !lite,
      archiveName: 'dump-2026-10-13.210353Z.zip'
    })
  );
  for (const entry of subjects) {
    const s = {
      type: 4,
      name_cn: '',
      date: '2000-01-01',
      summary: '本地简介',
      aliases: [],
      collection: { collect: 100 },
      ...entry
    };
    db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
      s.id,
      s.type,
      s.name,
      s.name_cn,
      0,
      s.date,
      lite ? '' : s.summary,
      '[]',
      JSON.stringify(s.collection),
      JSON.stringify(s.aliases),
      JSON.stringify(s)
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
  for (const e of entities) {
    db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?)').run(
      e.kind,
      e.id,
      e.name,
      e.name_cn || '',
      lite ? '' : e.summary || '人物简介',
      '[]',
      JSON.stringify(e.aliases || []),
      '{}'
    );
    for (const name of new Set([e.name, e.name_cn, ...(e.aliases || [])].filter(Boolean)))
      db.prepare('INSERT OR IGNORE INTO entity_keys VALUES(?,?,?,?)').run(
        e.kind,
        e.id,
        normalize(name),
        name
      );
  }
  for (const link of links)
    db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?)').run(...link, 'fixture');
  db.exec(
    'INSERT INTO names_fts SELECT key,subject_id,type FROM name_keys; INSERT INTO entity_names_fts SELECT key,kind,id FROM entity_keys;'
  );
  db.exec('COMMIT');
  db.close();
  if (manifest) fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  const index = createLocalIndex({ localIndexPath: filename });
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    index.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'acg-local-index-')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, filename, index, cleanups };
}
const subjects = [
  { id: 1, name: '千恋＊万花', aliases: ['千恋万花'], date: '2016-07-29' },
  { id: 2, name: 'AIR', aliases: ['エアー'], date: '2000-09-08', collection: { collect: 10000 } },
  { id: 3, name: 'AIR', type: 2 },
  { id: 4, name: 'First Story', aliases: ['最初的故事'] },
  { id: 5, name: 'First Story 2', date: '2001-01-01' }
];

test('discovers resources path, reads manifest and probes schema without a table scan', (t) => {
  const f = fixture(t, {
    subjects,
    manifest: { readerSchemaVersion: 1, dataVersion: 'manifest-version' }
  });
  const index = createLocalIndex({ resourcesPath: f.root });
  f.cleanups.push(() => index.close());
  assert.deepEqual(index.status(), {
    available: true,
    variant: 'full',
    dataVersion: 'manifest-version',
    entities: ['subject', 'person', 'character'],
    path: f.filename
  });
});
test('Standard without an optional bundled index is unavailable without a filesystem error', (t) => {
  const f = fixture(t);
  const resourcesPath = path.join(f.root, 'standard-resources');
  fs.mkdirSync(resourcesPath);
  const index = createLocalIndex({ resourcesPath });
  f.cleanups.push(() => index.close());
  assert.equal(index.status().available, false);
  assert.equal(index.status().error, undefined);
  assert.equal(index.search({ query: 'AIR' }).error, undefined);
  assert.deepEqual(index.search({ query: 'AIR' }).candidates, []);
  assert.equal(fs.existsSync(path.join(resourcesPath, 'local-index')), false);
});

test('missing, corrupt, incompatible schema and unsupported manifest soften to unavailable', (t) => {
  const f = fixture(t);
  for (const name of ['missing.sqlite', 'corrupt.sqlite', 'wrong.sqlite']) {
    const target = path.join(f.root, name);
    if (name === 'corrupt.sqlite') fs.writeFileSync(target, 'broken');
    if (name === 'wrong.sqlite') {
      const d = new DatabaseSync(target);
      d.exec('CREATE TABLE wrong(id)');
      d.close();
    }
    const index = createLocalIndex({ localIndexPath: target });
    assert.equal(index.status().available, false);
    assert.ok(index.status().error);
    assert.equal(index.search({ query: 'AIR' }).complete, false);
    index.close();
  }
  assert.equal(fs.existsSync(path.join(f.root, 'missing.sqlite')), false);
  fs.writeFileSync(
    path.join(path.dirname(f.filename), 'manifest.json'),
    '{"readerSchemaVersion":2}'
  );
  assert.match(createLocalIndex({ localIndexPath: f.filename }).status().error, /schema/);
});
test('full and lite provide identical names/types/aliases/date/collection and no raw JSON', (t) => {
  const full = fixture(t, { subjects }),
    lite = fixture(t, { subjects, lite: true, detailNone: true });
  for (const [f, variant] of [
    [full, 'full'],
    [lite, 'lite']
  ]) {
    const result = f.index.search({ query: '千恋*万花（CG集）', kind: 'subject', types: [4] });
    assert.equal(result.available, true);
    assert.equal(result.variant, variant);
    assert.equal(result.dataVersion, '2026-10-13.210353Z');
    assert.equal(result.selected.id, 1);
    const candidate = result.candidates[0];
    assert.equal(candidate.type, 4);
    assert.equal(candidate.date, '2016-07-29');
    assert.equal(candidate.collection.collect, 100);
    assert.deepEqual(candidate.aliases, ['千恋万花']);
    assert.equal(candidate.raw_json, undefined);
    assert.equal(candidate.summary, variant === 'full' ? '本地简介' : '');
  }
});
test('production normalizer handles fullwidth and punctuation; types isolate identities', (t) => {
  const { index } = fixture(t, { subjects });
  for (const query of ['ＡＩＲ', 'air', 'A I R']) {
    const result = index.search({ query, types: [4] });
    assert.equal(result.selected.id, 2);
    assert.equal(
      result.candidates.some((x) => x.type === 2),
      false
    );
  }
  assert.equal(index.search({ query: 'AIR', types: [2] }).selected.id, 3);
  assert.equal(index.search({ query: '千恋万花', types: [2] }).selected, null);
});
test('current production import ranker controls exact popularity/date and sequel behavior', (t) => {
  const entries = [
    ...subjects,
    { id: 6, name: 'First Story', date: '1999-01-01', collection: { collect: 95 } }
  ];
  const { index } = fixture(t, { subjects: entries });
  for (const query of ['First Story', 'First Story 2']) {
    const result = index.search({ query, types: [4], mode: 'import' });
    const current = rankImportSubjects(
      result.terms,
      entries.map((entry) => index.readSubject(entry.id)),
      [4],
      {
        complete: result.complete,
        titleGroups: result.titleGroups,
        queryHits: new Map(
          Object.entries(result.queryHits).map(([id, hits]) => [Number(id), new Set(hits)])
        )
      }
    );
    assert.equal(result.selected?.id, current.selected?.id);
    assert.equal(result.selectedMatch, current.selectedMatch);
  }
  assert.equal(index.search({ query: 'First Story 2', types: [4], mode: 'import' }).selected.id, 5);
});
test('bilingual conflict and wrong installment never auto-link', (t) => {
  const { index } = fixture(t, {
    subjects: [
      { id: 100, name: 'セレクトオブリージュ', name_cn: '其他中文标题' },
      { id: 101, name: '天选庶民的真命之选', name_cn: '另一个标题' },
      ...subjects
    ]
  });
  const bilingual = index.search({
    query: '天选庶民的真命之选 セレクトオブリージュ',
    types: [4],
    mode: 'import'
  });
  assert.equal(bilingual.selected, null);
  assert.notEqual(index.search({ query: 'AIR 2', types: [4], mode: 'import' }).selected?.id, 2);
});
test('512-row recall boundary forbids even an exact import selection', (t) => {
  const entries = Array.from({ length: MAX_ROWS }, (_, i) => ({
    id: i + 1,
    name: 'Shared Exact Name',
    collection: { collect: i + 1 }
  }));
  const { index } = fixture(t, { subjects: entries });
  const result = index.search({ query: 'Shared Exact Name', types: [4], mode: 'import' });
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.selected, null);
  assert.equal(result.candidates.length, 10);
  assert.equal(result.retrievedRows, MAX_ROWS);
});
test('short misses and FTS operators stay bounded and do not manufacture identity', (t) => {
  const { index } = fixture(t, { subjects });
  assert.equal(index.search({ query: 'ZZ', types: [4] }).complete, false);
  for (const query of ['" OR * NOT : ()', 'nonexistent-title-xyz', '游戏CG'])
    assert.equal(index.search({ query, types: [4] }).selected, null);
});
test('person and character are separate, context supports both direct relation directions', (t) => {
  const { index } = fixture(t, {
    subjects,
    entities: [
      { kind: 'character', id: 10, name: '朝武芳乃', aliases: ['芳乃'] },
      { kind: 'person', id: 10, name: 'こぶいち' },
      { kind: 'character', id: 11, name: '朝武芳乃' }
    ],
    links: [
      ['subject', 1, 'character', 10, 'main'],
      ['person', 10, 'subject', 1, 'artist']
    ]
  });
  assert.equal(index.search({ query: '朝武芳乃', kind: 'character' }).selected, null);
  const role = index.search({ query: '芳乃', kind: 'character', subjectId: 1 });
  assert.equal(role.selected.id, 10);
  assert.equal(role.candidates[0].match, 1);
  assert.deepEqual(role.candidates[0].relatedSubjectIds, [1]);
  assert.equal(index.search({ query: 'こぶいち', kind: 'person', subjectId: 1 }).selected.id, 10);
  assert.equal(index.search({ query: 'こぶいち', kind: 'character', subjectId: 1 }).selected, null);
  assert.equal(
    index.search({ query: '芳乃', kind: 'character', subjectId: 999 }).selectionReason,
    'subject-not-found'
  );
  assert.equal(index.staffFor(1)[0].name, 'こぶいち');
});
test('entity FTS detail=none restores matched aliases and related samples report truncation', (t) => {
  const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: 'Work ' + i }));
  const { index } = fixture(t, {
    subjects: many,
    detailNone: true,
    entities: [
      { kind: 'person', id: 10, name: 'Long Person Name', aliases: ['Another Person Alias'] }
    ],
    links: many.map((s) => ['subject', s.id, 'person', 10, 'staff'])
  });
  const result = index.search({ query: 'Another Person Alia', kind: 'person' });
  assert.ok(result.candidates.length);
  assert.equal(result.candidates[0].matchedName, 'Another Person Alias');
  assert.equal(result.candidates[0].relatedSubjects.length, 20);
  assert.equal(result.candidates[0].relatedSubjectsTruncated, true);
});
test('query validation rejects malformed input without disabling the database', (t) => {
  const { index } = fixture(t, { subjects });
  for (const options of [
    { query: 3 },
    { query: 'x', types: [5] },
    { query: 'x', kind: 'sql' },
    { query: 'x', subjectId: -1 },
    { query: 'x', limit: 11 },
    { query: 'x'.repeat(241) }
  ])
    assert.throws(() => index.search(options));
  assert.equal(index.status().available, true);
});
test('read-only searches leave database bytes, mtime and sidecar files untouched', (t) => {
  const f = fixture(t, { subjects });
  const before = fs.statSync(f.filename),
    hash = () => crypto.createHash('sha256').update(fs.readFileSync(f.filename)).digest('hex'),
    digest = hash();
  f.index.search({ query: 'First Story', types: [4] });
  f.index.readSubject(1);
  f.index.staffFor(1);
  assert.equal(hash(), digest);
  assert.equal(fs.statSync(f.filename).mtimeMs, before.mtimeMs);
  for (const suffix of ['-wal', '-shm', '-journal'])
    assert.equal(fs.existsSync(f.filename + suffix), false);
});

async function workerClient(t, f, { network = 'deny' } = {}) {
  const dataDir = path.join(f.root, 'private-fixture-data');
  const worker = new Worker(
    `
    const {workerData}=require('node:worker_threads');
    global.fetch=async(url)=>{global.httpCalls=(global.httpCalls||0)+1;
      require('node:worker_threads').parentPort.postMessage({event:'fixtureHTTP',data:{url:String(url)}});
      if(workerData.network==='deny') {const e=new Error('isolated network disabled');e.code='BANGUMI_NETWORK';throw e;}
      return {status:403,ok:false,headers:new Headers(),json:async()=>({})};};
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        localIndexPath: f.filename,
        watch: false,
        token: '',
        network,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  let sequence = 0;
  const pending = new Map(),
    events = [];
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      if (message.event) events.push(message);
      if (pending.has(message.request)) {
        const p = pending.get(message.request);
        pending.delete(message.request);
        clearTimeout(p.timer);
        message.error ? p.reject(new Error(message.error)) : p.resolve(message.result);
      }
    });
  });
  function call(method, args = {}) {
    const request = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout ' + method));
      }, 12000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  }
  f.cleanups.push(async () => {
    try {
      await call('shutdown');
    } finally {
      await worker.terminate();
    }
  });
  return {
    call,
    events,
    async idle() {
      if (events.some((x) => x.event === 'online' && !x.data.active)) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.off('message', check);
          reject(new Error('online timeout'));
        }, 12000);
        function check(m) {
          if (m.event === 'online' && !m.data.active) {
            clearTimeout(timer);
            worker.off('message', check);
            resolve();
          }
        }
        worker.on('message', check);
      });
    }
  };
}
async function scanned(t, options = {}) {
  const f = fixture(t, options),
    source = path.join(f.root, 'source'),
    folder = path.join(source, options.album || '千恋＊万花');
  fs.mkdirSync(folder, { recursive: true });
  const client = await workerClient(t, f, options);
  return { ...f, ...client, source, folder, id: idFor(folder) };
}
test('worker exposes status/search/init and manual bind keeps full local summary when HTTP fails', async (t) => {
  const f = await scanned(t, { subjects });
  assert.equal((await f.call('init')).localIndex.available, true);
  assert.equal((await f.call('localIndexStatus')).variant, 'full');
  assert.equal(
    (await f.call('searchLocalIndex', { query: '千恋万花', kind: 'subject', types: [4] }))
      .candidates[0].id,
    1
  );
  await f.call('scan', { path: f.source, offline: true });
  const search = await f.call('match', { id: f.id });
  assert.equal(search.candidates[0].id, 1);
  const node = await f.call('bind', { id: f.id, url: 'https://bgm.tv/subject/1' });
  assert.equal(node.subject_id, 1);
  assert.equal(node.manual_subject, 1);
  assert.equal(node.metadata.summary, '本地简介');
});
test('worker import saves exact local identity, confidence and review under denied HTTP', async (t) => {
  const f = await scanned(t, { subjects, network: 'forbidden' });
  await f.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
  await f.idle();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 1);
  assert.equal(node.match_confidence, 1);
  assert.equal(node.match_review, 0);
  assert.equal(node.confirmed, 1);
  assert.equal(node.metadata.source, 'local-index');
});
test('fresh legacy-root local-index selection stores exact and fuzzy evidence under denied HTTP', async (t) => {
  for (const exact of [true, false])
    await t.test(exact ? 'exact' : 'fuzzy', async (t) => {
      const chars = Array.from({ length: 210 }, (_, i) => String.fromCodePoint(0x5000 + i));
      const album = chars.slice(0, 25).join('');
      const name = exact ? album : chars.slice(0, 23).join('') + chars[200];
      const f = await scanned(t, { album, subjects: [{ id: 420, name }], network: 'forbidden' });
      await f.call('settings', { key: 'autoMatch', value: false });
      await f.call('scan', { path: f.source });
      await f.call('setAlbumKind', { id: idFor(f.source), kind: 'work' });
      const db = new DatabaseSync(path.join(f.root, 'private-fixture-data', 'library.sqlite'), {
        readOnly: true
      });
      assert.equal(db.prepare('SELECT count(*) AS count FROM root_match_policy').get().count, 0);
      db.close();
      await f.call('settings', { key: 'autoMatch', value: true });
      f.events.length = 0;
      await f.call('scan', { path: f.source });
      await f.idle();
      const node = await f.call('get', { id: f.id });
      assert.equal(node.subject_id, 420);
      assert.equal(node.match_confidence, exact ? 1 : 44 / 47);
      assert.equal(node.match_review, exact ? 0 : 1);
      assert.equal(node.confirmed, exact ? 1 : 0);
      assert.equal(node.metadata.source, 'local-index');
    });
});

test('worker lite import retains aliases and collection without requesting missing summary', async (t) => {
  const f = await scanned(t, { subjects, lite: true, detailNone: true });
  await f.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
  await f.idle();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 1);
  assert.equal(node.metadata.summary, '');
  assert.equal(node.metadata.collection.collect, 100);
});
test('worker truncated local recall stays unbound and returns manual candidates', async (t) => {
  const entries = Array.from({ length: MAX_ROWS }, (_, i) => ({
    id: i + 1,
    name: 'Shared Exact Name'
  }));
  const f = await scanned(t, { subjects: entries, album: 'Shared Exact Name' });
  await f.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
  await f.idle();
  assert.equal((await f.call('get', { id: f.id })).subject_id, null);
  const search = await f.call('match', { id: f.id });
  assert.equal(search.complete, false);
  assert.equal(search.truncated, true);
  assert.ok(search.candidates.length);
});
test('local imports preserve strict85 threshold, three-point cohort and90 percent popularity/date rule', (t) => {
  const chars = Array.from({ length: 400 }, (_, i) => String.fromCodePoint(0x5000 + i));
  const query = (length) => chars.slice(0, length).join('');
  const fuzzy = (length, prefix) =>
    chars.slice(0, prefix).join('') + chars.slice(200, 200 + length - prefix).join('');
  const f = fixture(t, { subjects: [{ id: 1, name: fuzzy(21, 18) }] });
  const boundary = f.index.search({ query: query(21), types: [4], mode: 'import' });
  assert.equal(boundary.candidates[0].match, 0.85);
  assert.equal(boundary.selected, null);
  const ranked = fixture(t, {
    subjects: [
      { id: 1, name: fuzzy(51, 48), date: '1990-01-01', collection: { collect: 10 } },
      { id: 2, name: fuzzy(51, 47), date: '2020-01-01', collection: { collect: 1000 } },
      { id: 3, name: fuzzy(51, 46), date: '1980-01-01', collection: { collect: 1000000 } }
    ]
  });
  assert.equal(
    ranked.index.search({ query: query(51), types: [4], mode: 'import' }).selected.id,
    2
  );
  const exact = fixture(t, {
    subjects: [
      { id: 1, name: 'AIR', date: '2020-01-01', collection: { collect: 1000 } },
      { id: 2, name: 'AIR', date: '2000-09-08', collection: { collect: 900 } },
      { id: 3, name: 'AIR', date: '1990-01-01', collection: { collect: 899 } }
    ]
  });
  assert.equal(exact.index.search({ query: 'AIR', types: [4], mode: 'import' }).selected.id, 2);
});
test('85.1 percent local import persists confidence and pending identity review', async (t) => {
  const chars = Array.from({ length: 230 }, (_, i) => String.fromCodePoint(0x5000 + i));
  const album = chars.slice(0, 25).join('');
  const subject = { id: 420, name: chars.slice(0, 21).join('') + chars.slice(200, 203).join('') };
  const f = await scanned(t, { subjects: [subject], album, network: 'forbidden' });
  await f.call('scan', { path: f.source, onlineMatch: true, subjectTypes: [4] });
  await f.idle();
  const node = await f.call('get', { id: f.id });
  assert.equal(node.subject_id, 420);
  assert.equal(node.match_confidence, 40 / 47);
  assert.equal(node.match_review, 1);
  assert.equal(node.confirmed, 0);
  assert.ok((await f.call('list', { filter: 'pending' })).items.some((n) => n.id === f.id));
});
test('worker refresh falls back to local data after 403 and keeps the manual association', async (t) => {
  const f = await scanned(t, { subjects, network: 'forbidden' });
  await f.call('scan', { path: f.source, offline: true });
  await f.call('bind', { id: f.id, url: '1' });
  const node = await f.call('refreshMetadata', { id: f.id });
  assert.equal(node.subject_id, 1);
  assert.equal(node.manual_subject, 1);
  assert.equal(node.metadata.summary, '本地简介');
});
