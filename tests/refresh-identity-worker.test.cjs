'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const sharp = require('sharp');
const { idFor } = require('../src/model.cjs');

// Execute the real worker with every HTTP entry point denied before loading it.
// A regression can record a matching attempt, but can never contact the network.
async function client(dataDir) {
  const worker = new Worker(
    `
    const { workerData, parentPort } = require('node:worker_threads');
    const deny = (...args) => {
      parentPort.postMessage({ event: 'forbidden-network', data: String(args[0]) });
      throw new Error('Network is forbidden in refresh identity fixtures');
    };
    global.fetch = async (...args) => deny(...args);
    for (const name of ['node:http', 'node:https']) {
      const http = require(name); http.request = deny; http.get = deny;
    }
    require(workerData.script);
  `,
    {
      eval: true,
      workerData: {
        dataDir,
        watch: false,
        script: path.resolve(__dirname, '../src/library-worker.cjs')
      }
    }
  );
  const pending = new Map(),
    events = [];
  let sequence = 0,
    closed = false;
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event) events.push(message);
      if (message.event === 'ready') resolve();
      const request = pending.get(message.request);
      if (request) {
        pending.delete(message.request);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error + '\n' + message.stack));
        else request.resolve(message.result);
      }
    });
  });
  const c = {
    events,
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(request);
          reject(new Error('Timed out: ' + method));
        }, 15000);
        pending.set(request, { resolve, reject, timer });
        worker.postMessage({ request, method, args });
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await c.call('shutdown');
      } finally {
        for (const p of pending.values()) clearTimeout(p.timer);
        await worker.terminate();
      }
    }
  };
  return c;
}
async function fixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-refresh-identity-worker-'));
  const source = path.join(tmp, 'source'),
    data = path.join(tmp, 'data');
  await fs.mkdir(source);
  const clients = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    const resolved = path.resolve(tmp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-refresh-identity-worker-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const open = async () => {
    const c = await client(data);
    clients.push(c);
    return c;
  };
  const sql = () => new DatabaseSync(path.join(data, 'library.sqlite'));
  return { tmp, source, data, open, sql };
}
async function jpg(p) {
  await sharp({ create: { width: 8, height: 6, channels: 3, background: '#8e7462' } })
    .jpeg()
    .toFile(p);
}
function auditMatching(db) {
  db.exec(`CREATE TABLE refresh_match_audit(kind TEXT,id TEXT);
    CREATE TRIGGER refresh_pending AFTER INSERT ON match_pending
      BEGIN INSERT INTO refresh_match_audit VALUES('pending',NEW.id); END;
    CREATE TRIGGER refresh_frontier AFTER INSERT ON match_frontier
      BEGIN INSERT INTO refresh_match_audit VALUES('frontier',NEW.root); END;`);
}

test(
  'real worker refresh reuses renamed file and album identities without matching unchanged entries',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const album = path.join(f.source, 'Rename Album'),
      nested = path.join(album, 'Nested Album');
    const stable = path.join(f.source, 'Unchanged Mystic Title');
    await fs.mkdir(nested, { recursive: true });
    await fs.mkdir(stable);
    const inside = path.join(nested, 'inside.jpg'),
      loose = path.join(f.source, 'loose.jpg');
    await jpg(inside);
    await jpg(loose);
    let c = await f.open();
    await c.call('settings', { key: 'autoMatch', value: true });
    const first = await c.call('scan', {
      path: f.source,
      offline: true,
      onlineMatch: true,
      subjectTypes: [4]
    });
    assert.equal(first.errors, 0);
    await c.close();
    let db = f.sql();
    try {
      assert.ok(
        db.prepare('SELECT fs_identity FROM nodes WHERE id=?').get(idFor(album)).fs_identity
      );
      db.prepare(
        `UPDATE nodes SET subject_id=42,manual_subject=1,cover=?,cover_source='manual',
        manual_cover=1,confirmed=1,crop_x=23,crop_y=72,crop_zoom=2,favorite=1,
        intro=1,album_kind='work',custom_character=? WHERE id=?`
      ).run(
        idFor(inside),
        JSON.stringify({ name: 'Saved local character', note: 'User annotation' }),
        idFor(album)
      );
      db.prepare('UPDATE nodes SET cover=?,local_newest=? WHERE id=?').run(
        idFor(inside),
        idFor(inside),
        idFor(f.source)
      );
      db.prepare(
        `UPDATE media SET status='ready',width=8,height=6,place='Explicit local place',place_user=1,
        latitude=12,longitude=34,coords_user=1 WHERE id IN (?,?)`
      ).run(idFor(inside), idFor(loose));
      db.prepare(
        'INSERT INTO manual_title_keys(node_id,name_key,subject_id,type,name) VALUES(?,?,?,?,?)'
      ).run(idFor(album), 'trusted-original-title', 42, 4, 'Saved title');
      auditMatching(db);
    } finally {
      db.close();
    }
    const renamedAlbum = path.join(f.source, 'Renamed Album');
    const renamedLoose = path.join(f.source, 'renamed-loose.jpg');
    await fs.rename(album, renamedAlbum);
    await fs.rename(loose, renamedLoose);
    c = await f.open();
    const refreshed = await c.call('scan', { path: f.source, matchNewOnly: true });
    assert.equal(refreshed.errors, 0);
    assert.equal(refreshed.cancelled, false);
    const newInside = path.join(renamedAlbum, 'Nested Album', 'inside.jpg');
    const saved = await c.call('get', { id: idFor(renamedAlbum) });
    assert.equal(saved.subject_id, 42);
    assert.equal(saved.manual_subject, 1);
    assert.equal(saved.manual_cover, 1);
    assert.equal(saved.cover, idFor(newInside));
    assert.equal(saved.crop_x, 23);
    assert.equal(saved.crop_y, 72);
    assert.equal(saved.crop_zoom, 2);
    assert.equal(saved.favorite, 1);
    assert.equal(saved.intro, 1);
    assert.equal(saved.album_kind, 'work');
    assert.equal(JSON.parse(saved.custom_character).note, 'User annotation');
    assert.equal((await c.call('asset', { id: idFor(newInside) })).path, newInside);
    assert.equal((await c.call('asset', { id: idFor(renamedLoose) })).path, renamedLoose);
    assert.equal(
      (await c.call('list', { search: 'renamed-loose' })).items[0].id,
      idFor(renamedLoose)
    );
    assert.equal((await c.call('get', { id: idFor(f.source) })).files, 2);
    await c.close();
    db = f.sql();
    try {
      for (const p of [album, nested, inside, loose])
        assert.equal(db.prepare('SELECT id FROM nodes WHERE id=?').get(idFor(p)), undefined);
      for (const p of [newInside, renamedLoose]) {
        const media = db.prepare('SELECT * FROM media WHERE id=?').get(idFor(p));
        assert.equal(media.place, 'Explicit local place');
        assert.equal(media.latitude, 12);
        assert.equal(media.longitude, 34);
        assert.equal(media.place_user, 1);
        assert.equal(media.coords_user, 1);
        assert.equal(media.width, 8);
      }
      assert.equal(db.prepare('SELECT COUNT(*) n FROM refresh_match_audit').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM match_pending').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM match_frontier').get().n, 0);
      assert.equal(
        db
          .prepare('SELECT node_id FROM manual_title_keys WHERE name_key=?')
          .get('trusted-original-title').node_id,
        idFor(renamedAlbum)
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM search_index').get().n,
        db.prepare('SELECT COUNT(*) n FROM nodes WHERE missing=0').get().n
      );
      assert.equal(
        db
          .prepare(
            'SELECT COUNT(*) n FROM search_index s LEFT JOIN nodes n ON n.id=s.id WHERE n.id IS NULL'
          )
          .get().n,
        0
      );
    } finally {
      db.close();
    }
    assert.equal(c.events.filter((event) => event.event === 'forbidden-network').length, 0);
  }
);

test(
  'real worker preview preserves an album moved beneath two new ancestors',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const album = path.join(f.source, 'Existing Album'),
      image = path.join(album, 'inside.jpg');
    await fs.mkdir(album);
    await jpg(image);
    let c = await f.open();
    assert.equal((await c.call('scan', { path: f.source, offline: true })).errors, 0);
    await c.close();
    let db = f.sql();
    try {
      db.prepare(
        `UPDATE nodes SET subject_id=42,manual_subject=1,cover=?,manual_cover=1,
      cover_source='manual',crop_x=23,crop_y=72,crop_zoom=2,favorite=1,custom_character=? WHERE id=?`
      ).run(
        idFor(image),
        JSON.stringify({ name: 'Saved character', note: 'Keep deep move note' }),
        idFor(album)
      );
      db.prepare(
        `UPDATE media SET status='ready',width=8,height=6,place='Keep explicit place',
      place_user=1,latitude=12,longitude=34,coords_user=1 WHERE id=?`
      ).run(idFor(image));
      db.prepare('INSERT INTO manual_title_keys VALUES(?,?,?,?,?)').run(
        idFor(album),
        'existingalbum',
        42,
        4,
        'Existing Album'
      );
      auditMatching(db);
    } finally {
      db.close();
    }
    const parent = path.join(f.source, 'New Parent', 'Nested New');
    await fs.mkdir(parent, { recursive: true });
    const renamed = path.join(parent, 'Renamed Album'),
      newImage = path.join(renamed, 'inside.jpg');
    await fs.rename(album, renamed);
    c = await f.open();
    const result = await c.call('scan', { path: f.source, offline: true, matchNewOnly: true });
    assert.equal(result.errors, 0);
    assert.equal(result.cancelled, false);
    const saved = await c.call('get', { id: idFor(renamed) });
    assert.equal(saved.subject_id, 42);
    assert.equal(saved.manual_subject, 1);
    assert.equal(saved.cover, idFor(newImage));
    assert.equal(saved.manual_cover, 1);
    assert.equal(saved.crop_x, 23);
    assert.equal(saved.crop_y, 72);
    assert.equal(saved.crop_zoom, 2);
    assert.equal(saved.favorite, 1);
    assert.equal(JSON.parse(saved.custom_character).note, 'Keep deep move note');
    assert.equal((await c.call('asset', { id: idFor(newImage) })).path, newImage);
    assert.equal((await c.call('get', { id: idFor(f.source) })).files, 1);
    await c.close();
    db = f.sql();
    try {
      assert.equal(db.prepare('SELECT id FROM nodes WHERE id=?').get(idFor(album)), undefined);
      assert.equal(db.prepare('SELECT id FROM nodes WHERE id=?').get(idFor(image)), undefined);
      const media = db.prepare('SELECT * FROM media WHERE id=?').get(idFor(newImage));
      assert.equal(media.place, 'Keep explicit place');
      assert.equal(media.place_user, 1);
      assert.equal(media.latitude, 12);
      assert.equal(media.longitude, 34);
      assert.equal(media.coords_user, 1);
      assert.equal(
        db.prepare('SELECT node_id FROM manual_title_keys').get().node_id,
        idFor(renamed)
      );
      assert.equal(db.prepare('SELECT COUNT(*) n FROM refresh_match_audit').get().n, 0);
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM search_index WHERE id=?').get(idFor(renamed)).n,
        1
      );
      assert.equal(
        db.prepare('SELECT COUNT(*) n FROM search_index WHERE id=?').get(idFor(album)).n,
        0
      );
    } finally {
      db.close();
    }
    assert.equal(c.events.filter((event) => event.event === 'forbidden-network').length, 0);
  }
);

test(
  'real worker rejects a root beneath a junction ancestor before inserting any rows',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const real = path.join(f.tmp, 'real'),
      inner = path.join(real, 'inner');
    await fs.mkdir(inner, { recursive: true });
    await fs.mkdir(path.join(inner, 'Album'));
    const alias = path.join(f.tmp, 'alias');
    await fs.symlink(real, alias, 'junction');
    const c = await f.open();
    await assert.rejects(
      c.call('scan', { path: path.join(alias, 'inner'), offline: true }),
      /符号链接|目录联接/
    );
    assert.equal((await c.call('init')).roots.length, 0);
    const db = f.sql();
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes').get().n, 0);
    } finally {
      db.close();
    }
    assert.equal(c.events.filter((event) => event.event === 'forbidden-network').length, 0);
  }
);

test(
  'real worker backfills old identities without rescheduling unchanged folders',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const album = path.join(f.source, 'Existing Unmatched Title');
    await fs.mkdir(album);
    const image = path.join(album, 'same.jpg');
    await jpg(image);
    let c = await f.open();
    await c.call('scan', { path: f.source, offline: true, onlineMatch: true, subjectTypes: [4] });
    await c.close();
    let db = f.sql();
    try {
      db.exec('UPDATE nodes SET fs_identity=NULL');
      db.prepare('UPDATE nodes SET favorite=1,crop_zoom=2 WHERE id=?').run(idFor(album));
      auditMatching(db);
    } finally {
      db.close();
    }
    c = await f.open();
    assert.equal((await c.call('scan', { path: f.source, matchNewOnly: true })).errors, 0);
    await c.close();
    db = f.sql();
    try {
      assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE fs_identity IS NULL').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM refresh_match_audit').get().n, 0);
      const saved = db.prepare('SELECT * FROM nodes WHERE id=?').get(idFor(album));
      assert.equal(saved.favorite, 1);
      assert.equal(saved.crop_zoom, 2);
    } finally {
      db.close();
    }
    assert.equal(c.events.filter((event) => event.event === 'forbidden-network').length, 0);
  }
);
