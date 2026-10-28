'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { idFor } = require('../src/model.cjs');
const script = path.resolve(__dirname, '../src/library-worker.cjs');
async function client(dataDir, { holdFirst = false } = {}) {
  const worker = new Worker(
    `
    const {workerData,parentPort}=require('node:worker_threads');
    const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
    let source=fs.readFileSync(workerData.script,'utf8');
    source=source.replace("const media = require('./media.cjs').createMedia({ db, home, getNode, send });","const media = require('./media.cjs').createMedia({ db, home, getNode, send }); media.start = () => Promise.resolve(media.stats());");
    if(!source.includes('1050 - (Date.now() - lastRequest)'))throw Error('API throttle test anchor missing');
    source=source.replace('1050 - (Date.now() - lastRequest)','0');
    if(!source.includes('const response = await fetch('))throw Error('API request test anchor missing');
    source=source.replace('const response = await fetch(',"parentPort.postMessage({event:'policy-request',data:{owner:activeOnlineJob?.id}}); const response = await fetch(");
    let held=false;
    global.fetch=async(url,options={})=>{
      if(workerData.holdFirst&&!held){held=true;parentPort.postMessage({event:'policy-held'});await new Promise(resolve=>parentPort.on('message',message=>{if(message.release)resolve();}));}
      const subject={id:42,type:4,name:'原神',name_cn:'原神',platform:'PC',date:'2020-09-28',collection:{collect:10000},images:{}};
      const body=workerData.holdFirst ? (String(url).endsWith('/42') ? subject : {data:[subject],list:[subject],total:1}) : {data:[],list:[],total:0};
      return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
    };
    const compiled=new Module(workerData.script,module);compiled.filename=workerData.script;compiled.paths=Module._nodeModulePaths(path.dirname(workerData.script));compiled._compile(source,workerData.script);
  `,
    { eval: true, workerData: { script, dataDir, watch: false, holdFirst } }
  );
  let readyResolve,
    readyReject,
    heldResolve,
    seq = 0;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const held = new Promise((resolve) => {
    heldResolve = resolve;
  });
  const pending = new Map(),
    events = [];
  worker.on('error', (error) => {
    readyReject(error);
    for (const p of pending.values()) p.reject(error);
  });
  worker.on('message', (message) => {
    if (message.event) events.push(message);
    if (message.event === 'ready') readyResolve();
    if (message.event === 'policy-held') heldResolve();
    if (message.request) {
      const p = pending.get(message.request);
      pending.delete(message.request);
      if (p) message.error ? p.reject(Error(message.error)) : p.resolve(message.result);
    }
  });
  await ready;
  return {
    events,
    held,
    release() {
      worker.postMessage({ release: true });
    },
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++seq;
        pending.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
    },
    async idle() {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const state = await this.call('syncStatus');
        if (!state.active && !state.discovering && !state.pending && !state.buffered) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw Error('matching queue did not drain');
    },
    async close() {
      this.release();
      try {
        await this.call('shutdown');
      } finally {
        await worker.terminate();
      }
    }
  };
}
async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-root-policy-'));
  const f = {
    directory,
    data: path.join(directory, 'data'),
    source: path.join(directory, '游戏图片'),
    active: null
  };
  f.album = path.join(f.source, '原神');
  f.images = path.join(f.album, '原神图片');
  f.photos = path.join(f.album, '摄影');
  for (const folder of [f.images, f.photos]) {
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'cover.jpg'), 'placeholder image; decoding disabled');
  }
  t.after(async () => {
    await f.active?.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('acg-root-policy-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  f.active = await client(f.data, options);
  return f;
}
async function scan(f, options = {}) {
  return f.active.call('scan', {
    path: f.source,
    onlineMatch: true,
    subjectTypes: [4],
    directoryKind: 'work',
    ...options
  });
}
function database(f, work) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

test(
  'default one-level binding leaves deeper images indexed but never schedules or reviews their folders',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await scan(f);
    await f.active.idle();
    const root = idFor(f.source),
      album = idFor(f.album);
    const policy = await f.active.call('getRootMatchPolicy', { id: root });
    assert.equal(policy.matchDepth, 1);
    assert.equal(policy.enabled, true);
    assert.equal(policy.onlineMatch, true);
    const owners = f.active.events
      .filter((e) => e.event === 'policy-request')
      .map((e) => e.data.owner);
    assert.ok(owners.length);
    assert.deepEqual([...new Set(owners)], [album]);
    assert.deepEqual(
      (await f.active.call('list', { filter: 'pending' })).items.map((n) => n.id),
      [album]
    );
    for (const folder of [f.images, f.photos]) {
      const n = await f.active.call('get', { id: idFor(folder) });
      assert.ok(n.cover);
      assert.equal(n.review_eligible, false);
      assert.equal(n.subject_id, null);
    }
    assert.equal((await f.active.call('get', { id: album })).review_eligible, true);
    assert.equal(
      (await f.active.call('list', { parent: null })).items[0].review_eligible,
      false,
      'overview root agrees with get'
    );
    assert.equal(
      (await f.active.call('list', { parent: root })).items[0].review_eligible,
      true,
      'first-level preview agrees with pending'
    );
    const deepRows = (await f.active.call('list', { parent: album })).items;
    assert.equal(deepRows.length, 2);
    assert.ok(
      deepRows.every((n) => n.review_eligible === false),
      'ordinary browse suppresses deeper review dots'
    );
    assert.equal((await f.active.call('list', { filter: 'images' })).total, 2);
  }
);

test(
  'editing depth expands the bounded frontier, and reducing depth removes old deeper review without changing manual confirmation',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await scan(f);
    await f.active.idle();
    const root = idFor(f.source);
    const before = await f.active.call('getRootMatchPolicy', { id: root }),
      eventStart = f.active.events.length;
    const deeper = await f.active.call('setRootMatchPolicy', { id: root, matchDepth: 2 });
    assert.equal(deeper.onlineMatch, before.onlineMatch);
    assert.ok(deeper.revision > before.revision);
    await f.active.idle();
    const owners = f.active.events
      .slice(eventStart)
      // Earlier parent fallback queries may have cached the same names; assert
      // actual scheduled folder identities rather than requiring another HTTP.
      .filter((e) => e.event === 'online' && e.data.active && e.data.id)
      .map((e) => e.data.id);
    for (const folder of [f.images, f.photos])
      assert.ok(owners.includes(idFor(folder)), 'frontier discovers level two');
    const manual = idFor(f.images),
      image = idFor(path.join(f.images, 'cover.jpg'));
    await f.active.call('setCover', { id: manual, imageId: image });
    await f.active.call('patch', {
      id: manual,
      changes: { crop_x: 23, crop_y: 74, crop_zoom: 1.9, favorite: 1 }
    });
    await f.active.call('setRootMatchPolicy', { id: root, matchDepth: 1 });
    await f.active.idle();
    const saved = await f.active.call('get', { id: manual });
    assert.deepEqual(
      [
        saved.cover,
        saved.manual_cover,
        saved.confirmed,
        saved.crop_x,
        saved.crop_y,
        saved.crop_zoom,
        saved.favorite
      ],
      [image, 1, 1, 23, 74, 1.9, 1]
    );
    assert.equal((await f.active.call('get', { id: idFor(f.photos) })).review_eligible, false);
    assert.deepEqual(
      (await f.active.call('list', { filter: 'pending' })).items.map((n) => n.id),
      [idFor(f.album)]
    );
  }
);

test(
  'partial edits and ordinary refresh preserve disabled policy and custom types/depth across restart',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await scan(f, { onlineMatch: false });
    const root = idFor(f.source);
    const disabled = await f.active.call('setRootMatchPolicy', {
      id: root,
      enabled: false,
      matchDepth: 3,
      subjectTypes: [2, 4]
    });
    const edited = await f.active.call('setRootMatchPolicy', { id: root, subjectTypes: [4] });
    assert.equal(edited.enabled, false);
    assert.equal(edited.onlineMatch, false);
    assert.equal(edited.matchDepth, 3);
    const same = await f.active.call('setRootMatchPolicy', { id: root });
    assert.equal(same.revision, edited.revision);
    await f.active.call('scan', { path: f.source, offline: true });
    await f.active.close();
    f.active = await client(f.data);
    const restored = await f.active.call('getRootMatchPolicy', { id: root });
    assert.equal(restored.matchDepth, 3);
    assert.equal(restored.enabled, false);
    assert.equal(restored.onlineMatch, false);
    assert.deepEqual(restored.subjectTypes, [4]);
    assert.ok(restored.revision >= disabled.revision);
    assert.equal((await f.active.call('list', { filter: 'pending' })).total, 0);
    for (const parent of [null, idFor(f.source), idFor(f.album)]) {
      const listed = (await f.active.call('list', { parent })).items;
      assert.ok(listed.length);
      assert.ok(
        listed.every((n) => n.review_eligible === false),
        'disabled work browse/overview has no review dots'
      );
    }
    await f.active.call('scan', { path: f.source, offline: true, matchDepth: 4 });
    assert.equal((await f.active.call('getRootMatchPolicy', { id: root })).matchDepth, 4);
    assert.equal((await f.active.call('getRootMatchPolicy', { id: root })).onlineMatch, false);
  }
);

test(
  'legacy deeper review and stale pending are excluded on restart while manual bindings and confirmations survive',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await scan(f, { onlineMatch: false });
    const root = idFor(f.source),
      deep = idFor(f.photos),
      manual = idFor(f.images);
    await f.active.close();
    f.active = null;
    database(f, (db) => {
      db.prepare('DELETE FROM settings WHERE key=?').run('rootMatchPolicyVersion');
      db.prepare(
        'UPDATE root_match_policy SET enabled=1,auto_enabled=1,match_depth=1 WHERE root=?'
      ).run(root);
      db.prepare('UPDATE nodes SET match_review=1 WHERE id=?').run(deep);
      db.prepare(
        'UPDATE nodes SET manual_subject=1,subject_id=99,confirmed=1,manual_cover=1 WHERE id=?'
      ).run(manual);
      db.prepare('INSERT OR REPLACE INTO match_pending VALUES(?,?,?)').run(
        deep,
        root,
        'obsolete-depth-two'
      );
    });
    f.active = await client(f.data);
    assert.equal((await f.active.call('get', { id: deep })).match_review, 0);
    assert.equal((await f.active.call('get', { id: deep })).review_eligible, false);
    assert.ok(
      !(await f.active.call('list', { filter: 'pending' })).items.some((n) => n.id === deep)
    );
    const saved = await f.active.call('get', { id: manual });
    assert.deepEqual(
      [saved.manual_subject, saved.subject_id, saved.confirmed, saved.manual_cover],
      [1, 99, 1, 1]
    );
    await f.active.idle();
    assert.equal((await f.active.call('syncStatus')).pending, 0);
  }
);

test(
  'root policy edits invalidate a delayed automatic response before it can assign a subject',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { holdFirst: true });
    await scan(f);
    await f.active.held;
    const root = idFor(f.source);
    const old = await f.active.call('getRootMatchPolicy', { id: root });
    const disabled = await f.active.call('setRootMatchPolicy', { id: root, enabled: false });
    assert.ok(disabled.revision > old.revision);
    f.active.release();
    await f.active.idle();
    assert.equal((await f.active.call('get', { id: idFor(f.album) })).subject_id, null);
    assert.equal((await f.active.call('syncStatus')).pending, 0);
  }
);

test('policy edits validate root identity, types and integer depth without changing saved values on failure', async (t) => {
  const f = await fixture(t);
  await scan(f, { onlineMatch: false });
  const id = idFor(f.source),
    before = await f.active.call('getRootMatchPolicy', { id });
  for (const matchDepth of [0, 9, 1.5, '2', null])
    await assert.rejects(f.active.call('setRootMatchPolicy', { id, matchDepth }), /深度/);
  await assert.rejects(f.active.call('setRootMatchPolicy', { id, subjectTypes: [3] }), /作品类型/);
  await assert.rejects(f.active.call('setRootMatchPolicy', { id, enabled: 'yes' }), /开关/);
  await assert.rejects(f.active.call('getRootMatchPolicy', { id: idFor(f.album) }), /顶层/);
  await assert.rejects(f.active.call('setRootMatchPolicy', { id, unexpected: true }), /无效/);
  assert.deepEqual(await f.active.call('getRootMatchPolicy', { id }), before);
});

test('offline character policy retains local automatic lookup when only its depth or cover preference changes', async (t) => {
  const f = await fixture(t);
  await scan(f, { onlineMatch: false, directoryKind: 'character' });
  await f.active.idle();
  const id = idFor(f.source);
  const before = await f.active.call('getRootMatchPolicy', { id });
  assert.equal(before.enabled, true);
  assert.equal(before.onlineMatch, false);
  const after = await f.active.call('setRootMatchPolicy', {
    id,
    matchDepth: 2,
    characterCover: 'bangumi'
  });
  assert.equal(after.enabled, true);
  assert.equal(after.onlineMatch, false);
  assert.equal(after.characterCover, 'bangumi');
  assert.equal(f.active.events.filter((e) => e.event === 'policy-request').length, 0);
});

test(
  'network-only patches keep character local matching, enable it on entry, and disable work automatic matching when offline',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    await scan(f, { onlineMatch: false, directoryKind: 'character' });
    const id = idFor(f.source);
    const network = await f.active.call('setRootMatchPolicy', { id, onlineMatch: true });
    assert.equal(network.enabled, true);
    assert.equal(network.onlineMatch, true);
    const character = await f.active.call('setRootMatchPolicy', { id, onlineMatch: false });
    assert.equal(character.enabled, true);
    assert.equal(character.onlineMatch, false);
    for (const directoryKind of ['work', 'photo']) {
      const off = await f.active.call('setRootMatchPolicy', {
        id,
        directoryKind,
        onlineMatch: false
      });
      assert.equal(off.enabled, false);
      for (const parent of [null, id, idFor(f.album)])
        assert.ok(
          (await f.active.call('list', { parent })).items.every((n) => n.review_eligible === false)
        );
      assert.equal((await f.active.call('list', { filter: 'pending' })).total, 0);
      const local = await f.active.call('setRootMatchPolicy', { id, directoryKind: 'character' });
      assert.equal(local.enabled, true);
      assert.equal(local.onlineMatch, false);
    }
    const work = await f.active.call('setRootMatchPolicy', {
      id,
      directoryKind: 'work',
      onlineMatch: true
    });
    assert.equal(work.enabled, true);
    const offline = await f.active.call('setRootMatchPolicy', { id, onlineMatch: false });
    assert.equal(offline.enabled, false);
    assert.equal(offline.onlineMatch, false);
    const explicit = await f.active.call('setRootMatchPolicy', {
      id,
      directoryKind: 'character',
      enabled: false
    });
    assert.equal(explicit.enabled, false, 'explicit enabled retains its API override');
    const depth = await f.active.call('setRootMatchPolicy', { id, matchDepth: 2 });
    assert.equal(depth.enabled, false);
    assert.equal(depth.onlineMatch, false);
  }
);

for (const directoryKind of ['work', 'photo'])
  test(
    `deep ${directoryKind} fallback keeps its first preview across scans and replaces it only when missing`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        folder = idFor(f.photos),
        original = path.join(f.photos, 'cover.jpg');
      await scan(f, { onlineMatch: false, directoryKind });
      const initial = await f.active.call('get', { id: folder });
      assert.equal(initial.cover, idFor(original));
      const added = path.join(f.photos, '000-newer.jpg');
      await fs.writeFile(added, 'another isolated image');
      await fs.utimes(added, 1900000000, 1900000000);
      await f.active.call('scan', { path: f.source, offline: true });
      assert.equal(
        (await f.active.call('get', { id: folder })).cover,
        initial.cover,
        'an earlier natural name or newer mtime does not change the deep preview'
      );
      assert.equal(
        (await f.active.call('get', { id: idFor(f.album) })).cover,
        idFor(added),
        'the first-level selection and ancestor candidate cache retain their original policy'
      );
      await f.active.close();
      f.active = await client(f.data);
      await f.active.call('scan', { path: f.source, offline: true });
      assert.equal((await f.active.call('get', { id: folder })).cover, initial.cover);
      assert.equal(path.dirname(original), f.photos);
      assert.ok(path.resolve(original).startsWith(path.resolve(f.directory) + path.sep));
      await fs.unlink(original);
      await f.active.call('scan', { path: f.source, offline: true });
      assert.equal((await f.active.call('get', { id: folder })).cover, idFor(added));
    }
  );
