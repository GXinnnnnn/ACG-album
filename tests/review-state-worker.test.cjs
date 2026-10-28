'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

async function client(dataDir) {
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  let sequence = 0;
  const pending = new Map(),
    events = [];
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event) events.push(m);
      if (m.event === 'ready') resolve();
      const item = pending.get(m.request);
      if (item) {
        pending.delete(m.request);
        m.error ? item.reject(new Error(m.error)) : item.resolve(m.result);
      }
    });
  });
  await ready;
  return {
    events,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        pending.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
    },
    async close() {
      try {
        await this.call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}
async function fixture(t, seed, { legacyReview = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-review-worker-'));
  let c = await client(tmp);
  await c.close();
  const db = new DatabaseSync(path.join(tmp, 'library.sqlite'));
  const insert =
    db.prepare(`INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,cover,cover_source,
    confirmed,match_review,match_confidence,subject_id,manual_subject,manual_cover,character_id,manual_character,favorite,missing)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add = (id, extra = {}) => {
    const n = {
      root: 'root-a',
      parent: 'root-a',
      name: id,
      kind: 'folder',
      depth: 1,
      cover: 'image',
      cover_source: 'fallback',
      confirmed: 0,
      match_review: 0,
      match_confidence: null,
      subject_id: null,
      manual_subject: 0,
      manual_cover: 0,
      character_id: null,
      manual_character: 0,
      favorite: 0,
      missing: 0,
      ...extra
    };
    insert.run(
      id,
      n.root,
      n.parent,
      path.join(tmp, n.root, id),
      n.name,
      n.name,
      n.kind,
      n.depth,
      n.cover,
      n.cover_source,
      n.confirmed,
      n.match_review,
      n.match_confidence,
      n.subject_id,
      n.manual_subject,
      n.manual_cover,
      n.character_id,
      n.manual_character,
      n.favorite,
      n.missing
    );
  };
  seed({ db, add });
  // Schema bootstrap has already migrated its empty database. Fixtures that
  // inject pre-upgrade review state must also restore the missing old marker.
  if (legacyReview) db.prepare('DELETE FROM settings WHERE key=?').run('matchReviewVersion');
  db.exec(
    'DELETE FROM search_index; INSERT INTO search_index(rowid,id,name) SELECT rowid,id,name FROM nodes WHERE missing=0'
  );
  db.close();
  c = await client(tmp);
  t.after(async () => {
    await c.close();
    assert.ok(path.resolve(tmp).startsWith(path.join(os.tmpdir(), 'acg-review-worker-')));
    await fs.rm(tmp, { recursive: true, force: true });
  });
  return {
    call: (...args) => c.call(...args),
    get events() {
      return c.events;
    },
    async restart() {
      await c.close();
      c = await client(tmp);
    }
  };
}

// Real worker startup executes the compatibility migration and reads persisted
// rows; this is deliberately not a unit test of a copied UI predicate.
test('startup confirms every matched identity and clears obsolete folder review without overriding manual covers', async (t) => {
  const c = await fixture(
    t,
    ({ add }) => {
      add('exact-subject', {
        subject_id: 42,
        match_confidence: 1,
        match_review: 1,
        cover_source: 'bangumi'
      });
      add('exact-local', { subject_id: 43, match_confidence: 1 });
      add('exact-character', {
        character_id: 7,
        match_confidence: 1,
        match_review: 1,
        cover_source: 'bangumi-character'
      });
      add('nonexact', { subject_id: 44, match_confidence: 40 / 47, match_review: 1 });
      add('manual-subject', { subject_id: 42, manual_subject: 1 });
      add('manual-character', { character_id: 7, manual_character: 1 });
      add('unknown-character', { character_id: 8, cover_source: 'fallback' });
      add('unknown-subject', { subject_id: 45, cover_source: 'bangumi' });
      add('manual-cover', {
        subject_id: 42,
        manual_cover: 1,
        cover_source: 'manual',
        match_review: 1
      });
      add('manual-confirmed', {
        manual_cover: 1,
        cover_source: 'manual',
        confirmed: 1,
        match_review: 1
      });
      add('unassociated', { match_confidence: 1, match_review: 1 });
      add('zero-subject', { subject_id: 0, match_review: 1 });
      add('negative-character', { character_id: -1, match_review: 1 });
      add('unmatched-online', { cover_source: 'bangumi', match_review: 1 });
      add('unmatched-portrait', { cover_source: 'bangumi-character', match_review: 1 });
      add('unmatched-icon', { cover_source: 'local-icon', match_review: 1 });
      add('unmatched-empty', { cover: null, cover_source: null, match_review: 1 });
      add('manual-unmatched', { manual_cover: 1, cover_source: 'manual', match_review: 1 });
      add('confirmed-fallback', { confirmed: 1, match_review: 1 });
      add('image', { kind: 'image', match_review: 1 });
    },
    { legacyReview: true }
  );
  async function check() {
    for (const id of [
      'exact-subject',
      'exact-local',
      'exact-character',
      'nonexact',
      'manual-subject',
      'manual-character',
      'unknown-character',
      'unknown-subject',
      'manual-confirmed',
      'confirmed-fallback'
    ]) {
      const n = await c.call('get', { id });
      assert.equal(n.confirmed, 1, id);
      assert.equal(n.match_review, 0, id);
    }
    for (const id of [
      'manual-cover',
      'unassociated',
      'zero-subject',
      'negative-character',
      'unmatched-online',
      'unmatched-portrait',
      'unmatched-icon',
      'unmatched-empty',
      'manual-unmatched'
    ]) {
      const n = await c.call('get', { id });
      assert.equal(n.confirmed, 0, id);
      assert.equal(n.match_review, 0, id);
    }
    assert.equal((await c.call('get', { id: 'nonexact' })).match_confidence, 40 / 47);
    assert.equal((await c.call('get', { id: 'unknown-character' })).match_confidence, null);
    assert.deepEqual((await c.call('list', { filter: 'pending' })).items.map((n) => n.id).sort(), [
      'negative-character',
      'unassociated',
      'zero-subject'
    ]);
  }
  await check();
  await c.restart();
  await check();
});

test('completed review migration is not repeated for later injected rows or worker restarts', async (t) => {
  const c = await fixture(t, ({ add, db }) => {
    const marker = db.prepare('SELECT value FROM settings WHERE key=?').get('matchReviewVersion');
    assert.equal(JSON.parse(marker.value), 1);
    // Deliberately inject after migration, retaining its marker to prove startup
    // does not rescan nodes. Normal identity saves confirm their rows immediately.
    add('post-migration', { subject_id: 42, match_confidence: 40 / 47, match_review: 1 });
    add('manual-cover', {
      subject_id: 43,
      manual_cover: 1,
      cover_source: 'manual',
      match_review: 1
    });
  });
  async function check() {
    for (const id of ['post-migration', 'manual-cover']) {
      const n = await c.call('get', { id });
      assert.equal(n.confirmed, 0, id);
      assert.equal(n.match_review, 1, id);
    }
    assert.equal((await c.call('get', { id: 'post-migration' })).match_confidence, 40 / 47);
    assert.equal((await c.call('list', { filter: 'pending' })).total, 0);
  }
  await check();
  await c.restart();
  await check();
});

test('older nodes schema missing review columns opens with unknown evidence preserved', async (t) => {
  const c = await fixture(
    t,
    ({ add, db }) => {
      add('legacy', { subject_id: 42 });
      db.exec(
        'ALTER TABLE nodes DROP COLUMN match_confidence; ALTER TABLE nodes DROP COLUMN match_review'
      );
    },
    { legacyReview: true }
  );
  const n = await c.call('get', { id: 'legacy' });
  assert.equal(n.match_confidence, null);
  assert.equal(n.match_review, 0);
  assert.equal(n.confirmed, 1);
  assert.equal((await c.call('list', { filter: 'pending' })).total, 0);
  await c.restart();
  const restarted = await c.call('get', { id: 'legacy' });
  assert.equal(restarted.match_confidence, null);
  assert.equal(restarted.confirmed, 1);
});

test('bulk confirmation uses full current parent query beyond loaded pages without confirming descendants or other roots', async (t) => {
  const c = await fixture(t, ({ add }) => {
    add('root-a', { parent: null, depth: 0 });
    add('root-b', { root: 'root-b', parent: null, depth: 0 });
    for (let i = 0; i < 620; i++)
      add('album-' + String(i).padStart(4, '0'), {
        match_review: i % 2,
        manual_cover: i % 4 === 1 ? 1 : 0,
        cover_source: ['fallback', 'manual', 'local-icon', null][i % 4]
      });
    add('nested', { parent: 'album-0000', depth: 2, match_review: 1 });
    add('unrelated', { root: 'root-b', parent: 'root-b', match_review: 1 });
    add('missing', { missing: 1, match_review: 1 });
    add('image', { kind: 'image', match_review: 1 });
  });
  assert.equal((await c.call('list', { parent: 'root-a', limit: 5 })).items.length, 5);
  assert.deepEqual(
    await c.call('confirmReview', {
      query: {
        parent: 'root-a',
        search: 'no matching cards',
        favorites: true,
        filter: 'images',
        timeline: true,
        month: '2026-10',
        place: 'somewhere',
        scope: 'root-b',
        offset: 500,
        limit: 5
      }
    }),
    { updated: 620 }
  );
  for (const id of ['album-0000', 'album-0619']) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 1);
    assert.equal(n.match_review, 0);
  }
  for (const id of ['root-a', 'root-b', 'nested', 'unrelated', 'missing', 'image'])
    assert.equal((await c.call('get', { id })).confirmed, 0, id);
  assert.deepEqual(await c.call('confirmReview', { query: { parent: 'root-a' } }), { updated: 0 });
  assert.equal(c.events.filter((e) => e.event === 'changed' && e.data.review).length, 1);
  await c.restart();
  for (let i = 0; i < 620; i++) {
    const n = await c.call('get', { id: 'album-' + String(i).padStart(4, '0') });
    assert.equal(n.confirmed, 1, n.id);
    assert.equal(n.match_review, 0, n.id);
  }
  for (const id of ['root-a', 'root-b', 'nested', 'unrelated', 'missing', 'image'])
    assert.equal((await c.call('get', { id })).confirmed, 0, id);
});

test('bulk query semantics match home, favorites, scoped search, pending, media, and empty results', async (t) => {
  const cases = [
    [{ parent: null }, ['root-a', 'root-b']],
    [{ favorites: true }, ['favorite', 'other-favorite']],
    [{ search: 'Needle', scope: 'root-a' }, ['favorite', 'nested']],
    [{ search: 'Needle', favorites: true }, ['favorite', 'other-favorite']],
    [{ search: 'Needle', filter: 'pending', scope: 'root-b' }, ['other-favorite']],
    [{ filter: 'pending' }, ['favorite', 'other-favorite']],
    [{ parent: 'root-a', filter: 'folders' }, ['favorite']],
    [{ parent: 'root-a', filter: 'images' }, ['favorite']],
    [{ parent: 'root-a', timeline: true, month: '2026-10', place: 'somewhere' }, ['favorite']],
    [{ parent: 'root-a', search: 'no match', favorites: true, filter: 'pending' }, ['favorite']],
    [{ search: "%' OR 1=1 --" }, []],
    [{ parent: 'absent' }, []]
  ];
  for (const [query, expected] of cases)
    await t.test(JSON.stringify(query), async (t) => {
      const c = await fixture(t, ({ add }) => {
        add('root-a', { parent: null, depth: 0 });
        add('root-b', { root: 'root-b', parent: null, depth: 0 });
        add('favorite', { name: 'Needle favorite', favorite: 1, match_review: 1 });
        add('nested', { name: 'Needle nested', parent: 'favorite', depth: 2, match_review: 1 });
        add('other-favorite', {
          name: 'Needle other',
          root: 'root-b',
          parent: 'root-b',
          favorite: 1
        });
        add('image', { kind: 'image' });
        add('missing', { missing: 1, favorite: 1 });
        add('resolved', { confirmed: 1, cover_source: 'bangumi' });
      });
      if (!query.parent) {
        const before = await c.call('list', query);
        assert.deepEqual(
          before.items
            .filter((n) => n.kind === 'folder' && !n.confirmed)
            .map((n) => n.id)
            .sort(),
          [...expected].sort()
        );
      }
      assert.deepEqual(await c.call('confirmReview', { query }), { updated: expected.length });
      for (const id of ['root-a', 'root-b', 'favorite', 'nested', 'other-favorite']) {
        const n = await c.call('get', { id });
        assert.equal(n.confirmed, expected.includes(id) ? 1 : 0, id);
        if (expected.includes(id)) assert.equal(n.match_review, 0, id);
      }
    });
});

test('invalid patch cannot partially confirm and failed bulk update rolls back every confirmation', async (t) => {
  const c = await fixture(
    t,
    ({ add, db }) => {
      add('a', { match_review: 1, manual_cover: 1, cover_source: 'manual' });
      add('z', { match_review: 1 });
      db.exec(`CREATE TRIGGER reject_review BEFORE UPDATE OF confirmed ON nodes
      WHEN NEW.id='z' AND NEW.confirmed=1 BEGIN SELECT RAISE(ABORT,'test atomic review'); END`);
    },
    { legacyReview: true }
  );
  await assert.rejects(
    c.call('patch', { id: 'a', changes: { confirmed: 1, match_review: 0, crop_zoom: 99 } }),
    /无效设置/
  );
  for (const args of [
    {},
    { query: {} },
    { query: [] },
    { query: { parent: 7 } },
    { query: { filter: 'arbitrary' } }
  ])
    await assert.rejects(c.call('confirmReview', args), /浏览条件/);
  await assert.rejects(
    c.call('confirmReview', {
      query: { parent: 'root-a', search: 'a', filter: 'images', favorites: true }
    }),
    /test atomic review/
  );
  for (const id of ['a', 'z']) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 0);
    assert.equal(n.match_review, 0);
  }
  assert.equal(c.events.filter((e) => e.event === 'changed').length, 0);
  assert.deepEqual(await c.call('confirmReview', { query: { search: 'a' } }), { updated: 1 });
  const n = await c.call('get', { id: 'a' });
  assert.equal(n.confirmed, 1);
  assert.equal(n.match_review, 0);
});

test('home confirms only explicitly rendered previews under live roots, leaving unshown and unrelated children pending', async (t) => {
  const c = await fixture(t, ({ add }) => {
    add('root-a', { parent: null });
    add('root-b', { root: 'root-b', parent: null });
    add('dead-root', { root: 'dead-root', parent: null, missing: 1 });
    add('image-root', { root: 'image-root', parent: null, kind: 'image' });
    for (let i = 0; i < 13; i++) add('a-' + i, { match_review: 1 });
    add('b-visible', { root: 'root-b', parent: 'root-b', match_review: 1 });
    add('b-unshown', { root: 'root-b', parent: 'root-b', match_review: 1 });
    add('nested', { parent: 'a-0', depth: 2, match_review: 1 });
    add('missing', { missing: 1, match_review: 1 });
    add('image', { kind: 'image' });
    add('dead-child', { root: 'dead-root', parent: 'dead-root', match_review: 1 });
    add('orphan', { root: 'absent', parent: 'absent', match_review: 1 });
    add('image-child', { root: 'image-root', parent: 'image-root', match_review: 1 });
    add('inconsistent-root', { root: 'root-b', match_review: 1 });
  });
  const visible = Array.from({ length: 12 }, (_, i) => 'a-' + i).concat('b-visible');
  const excluded = [
    'nested',
    'missing',
    'image',
    'dead-child',
    'orphan',
    'image-child',
    'inconsistent-root'
  ];
  const previewIds = visible.concat(
    visible,
    excluded,
    Array.from({ length: 1100 }, (_, i) => 'absent-' + i),
    "x') OR 1=1 --"
  );
  assert.deepEqual(
    await c.call('confirmReview', { query: { parent: null, limit: 1 }, previewIds }),
    { updated: 15 }
  );
  for (const id of ['root-a', 'root-b', ...visible]) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 1, id);
    assert.equal(n.match_review, 0, id);
  }
  for (const id of ['a-12', 'b-unshown', 'dead-root', 'image-root', ...excluded]) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 0, id);
  }
  assert.equal(c.events.filter((e) => e.event === 'changed').length, 1);
  assert.deepEqual(
    await c.call('confirmReview', { query: { parent: null }, previewIds: visible }),
    { updated: 0 }
  );
});

test('invalid preview payloads and nonoverview queries reject before any root or preview confirmation', async (t) => {
  const c = await fixture(
    t,
    ({ add }) => {
      add('root-a', { parent: null, match_review: 1 });
      add('child', { match_review: 1 });
    },
    { legacyReview: true }
  );
  for (const previewIds of [
    null,
    'child',
    {},
    [null],
    [7],
    [''],
    ['x'.repeat(513)],
    Array(10001).fill('child')
  ])
    await assert.rejects(
      c.call('confirmReview', { query: { parent: null }, previewIds }),
      /预览卡片/
    );
  for (const query of [
    { parent: 'root-a' },
    { parent: '' },
    { search: 'child' },
    { favorites: true },
    { filter: 'pending' },
    { filter: 'images' },
    { timeline: true }
  ])
    await assert.rejects(c.call('confirmReview', { query, previewIds: ['child'] }), /预览卡片/);
  for (const id of ['root-a', 'child']) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 0);
    assert.equal(n.match_review, 0);
  }
  assert.equal(c.events.filter((e) => e.event === 'changed').length, 0);
  assert.deepEqual(await c.call('confirmReview', { query: { parent: 'absent' }, previewIds: [] }), {
    updated: 0
  });
  assert.deepEqual(
    await c.call('confirmReview', {
      query: { parent: null, filter: 'folders' },
      previewIds: ['child']
    }),
    { updated: 2 }
  );
});

test('overview roots and rendered previews roll back together when any preview confirmation fails', async (t) => {
  const c = await fixture(
    t,
    ({ add, db }) => {
      add('root-a', { parent: null, match_review: 1 });
      add('a', { match_review: 1 });
      add('z', { match_review: 1 });
      add('unshown', { match_review: 1 });
      db.exec(`CREATE TRIGGER reject_preview BEFORE UPDATE OF confirmed ON nodes
      WHEN NEW.id='z' AND NEW.confirmed=1 BEGIN SELECT RAISE(ABORT,'test atomic preview'); END`);
    },
    { legacyReview: true }
  );
  await assert.rejects(
    c.call('confirmReview', { query: { parent: null }, previewIds: ['a', 'z'] }),
    /test atomic preview/
  );
  for (const id of ['root-a', 'a', 'z', 'unshown']) {
    const n = await c.call('get', { id });
    assert.equal(n.confirmed, 0);
    assert.equal(n.match_review, 0);
  }
  assert.equal(c.events.filter((e) => e.event === 'changed').length, 0);
  assert.deepEqual(await c.call('confirmReview', { query: { parent: null }, previewIds: ['a'] }), {
    updated: 2
  });
  assert.equal((await c.call('get', { id: 'z' })).confirmed, 0);
  assert.equal((await c.call('get', { id: 'unshown' })).confirmed, 0);
});
