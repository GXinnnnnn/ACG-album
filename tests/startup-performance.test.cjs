'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { createHash } = require('node:crypto');
const { client } = require('../scripts/check-startup-performance.cjs');
const { sortKey } = require('../src/natural-sort.cjs');
const { idFor } = require('../src/model.cjs');
const sharp = require('sharp');
const migrations = ['browseOptimizeVersion', 'matchReviewVersion', 'mediaSeedVersion'];
const fullStartupSql = (profile) =>
  profile.filter(
    ({ sql }) =>
      sql.includes('PRAGMA optimize=') ||
      sql.startsWith('run UPDATE nodes SET confirmed=CASE') ||
      sql.startsWith('run INSERT INTO media(id,revision,taken,date_source,status) SELECT') ||
      sql.startsWith("run UPDATE media SET status='missing' WHERE status<>'missing'")
  );
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-startup-test-'));
  const f = { directory, data: path.join(directory, 'data'), active: null };
  t.after(async () => {
    await f.active?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-startup-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  f.active = await client(f.data);
  await f.active.close();
  f.active = null;
  return f;
}
function database(f, work) {
  const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

test('legacy startup repairs commit once and preserve manual media, cover, crop and queue state', async (t) => {
  const f = await fixture(t);
  database(f, (db) => {
    const insert = db.prepare(
      'INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,subject_id,manual_cover,confirmed,match_review,crop_x,favorite) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    );
    insert.run(
      'root',
      'root',
      null,
      path.join(f.directory, 'legacy'),
      'legacy',
      sortKey('legacy'),
      'folder',
      0,
      0,
      1,
      1,
      null,
      0,
      0,
      0,
      50,
      0
    );
    insert.run(
      'auto',
      'root',
      'root',
      path.join(f.directory, 'legacy/auto'),
      'auto',
      sortKey('auto'),
      'folder',
      1,
      0,
      1,
      1,
      42,
      0,
      0,
      1,
      31,
      1
    );
    insert.run(
      'manual',
      'root',
      'root',
      path.join(f.directory, 'legacy/manual'),
      'manual',
      sortKey('manual'),
      'folder',
      1,
      0,
      1,
      1,
      43,
      1,
      1,
      1,
      24,
      1
    );
    insert.run(
      'video',
      'root',
      'auto',
      path.join(f.directory, 'legacy/auto/test.mp4'),
      'test.mp4',
      sortKey('test.mp4'),
      'video',
      2,
      10,
      1700000000000,
      1,
      null,
      0,
      0,
      0,
      50,
      0
    );
    db.prepare(
      "UPDATE nodes SET cover='manual-cover.png',cover_source='manual',crop_zoom=1.8 WHERE id='manual'"
    ).run();
    db.exec(
      "INSERT INTO media(id,revision,taken,status,width,height,place,place_user,latitude,longitude,coords_user) VALUES('video','old',1,'ready',500,400,'自定义地点',1,30,120,1); INSERT INTO media(id,revision,status) VALUES('orphan','old','ready')"
    );
    for (const key of migrations) db.prepare('DELETE FROM settings WHERE key=?').run(key);
    // A paused durable queue must remain intact through the migration. An access
    // pause keeps automatic discovery from consuming this synthetic fixture.
    db.exec("INSERT INTO match_pending VALUES('auto','root','legacy-stamp')");
    const scope = createHash('sha256').update('ACGAlbum Bangumi cache v1\0').digest('hex');
    db.prepare("UPDATE match_resume SET reason='access',scope=?,failures=2 WHERE singleton=1").run(
      scope
    );
  });
  f.active = await client(f.data, { profile: true, suppressMedia: true });
  const firstProfile = await f.active.snapshot();
  assert.equal(
    fullStartupSql(firstProfile).length,
    4,
    'legacy repair, seed, missing check and optimize execute once'
  );
  await f.active.close();
  f.active = null;
  database(f, (db) => {
    for (const key of migrations)
      assert.equal(
        JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key).value),
        1
      );
    const automatic = db.prepare("SELECT * FROM nodes WHERE id='auto'").get();
    assert.equal(automatic.confirmed, 1);
    assert.equal(automatic.match_review, 0);
    assert.equal(automatic.crop_x, 31);
    assert.equal(automatic.favorite, 1);
    const manual = db.prepare("SELECT * FROM nodes WHERE id='manual'").get();
    assert.equal(manual.manual_cover, 1);
    assert.equal(manual.cover, 'manual-cover.png');
    assert.equal(manual.cover_source, 'manual');
    assert.equal(manual.crop_x, 24);
    assert.equal(manual.crop_zoom, 1.8);
    assert.equal(manual.confirmed, 1);
    const media = db.prepare("SELECT * FROM media WHERE id='video'").get();
    assert.equal(media.revision, '1700000000000.0-10');
    assert.equal(media.status, 'pending');
    assert.equal(media.width, null);
    assert.equal(media.place, '自定义地点');
    assert.equal(media.latitude, 30);
    assert.equal(media.longitude, 120);
    assert.equal(db.prepare("SELECT status FROM media WHERE id='orphan'").get().status, 'missing');
    assert.equal(
      db.prepare("SELECT stamp FROM match_pending WHERE id='auto'").get().stamp,
      'legacy-stamp'
    );
    assert.equal(
      db.prepare('SELECT failures FROM match_resume WHERE singleton=1').get().failures,
      2
    );
  });
  f.active = await client(f.data, { profile: true, suppressMedia: true });
  const repeatedProfile = await f.active.snapshot();
  assert.deepEqual(
    fullStartupSql(repeatedProfile),
    [],
    'repeat startup never replays full-library repair SQL'
  );
  assert.equal(
    f.active.events.some((event) => event.event === 'sortMigration'),
    false
  );
  const init = await f.active.call('init');
  assert.equal(init.roots.length, 1);
  assert.equal(init.stats.images, 1);
  assert.ok(
    repeatedProfile.every(({ sql }) => !sql.startsWith('all SELECT rowid,name FROM nodes'))
  );
});

test('interrupted startup media repair rolls back its writes and retries before recording the version', async (t) => {
  const f = await fixture(t);
  database(f, (db) => {
    db.prepare('DELETE FROM settings WHERE key=?').run('mediaSeedVersion');
    db.exec(`INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth)
      VALUES('image','root','root','C:\\Synthetic\\test.jpg','test.jpg','test','image',1,10,1,1);
      INSERT INTO media(id,revision,status) VALUES('orphan','old','ready');
      CREATE TRIGGER interrupt_media_repair BEFORE UPDATE OF status ON media
      WHEN OLD.id='orphan' BEGIN SELECT RAISE(ABORT,'test migration interrupted'); END;`);
  });
  await assert.rejects(() => client(f.data, { suppressMedia: true }), /test migration interrupted/);
  database(f, (db) => {
    assert.equal(
      db.prepare('SELECT value FROM settings WHERE key=?').get('mediaSeedVersion'),
      undefined
    );
    assert.equal(db.prepare("SELECT id FROM media WHERE id='image'").get(), undefined);
    assert.equal(db.prepare("SELECT status FROM media WHERE id='orphan'").get().status, 'ready');
    db.exec('DROP TRIGGER interrupt_media_repair');
  });
  f.active = await client(f.data, { profile: true, suppressMedia: true });
  assert.ok(
    fullStartupSql(await f.active.snapshot()).some(({ sql }) =>
      sql.startsWith('run INSERT INTO media')
    )
  );
  await f.active.close();
  f.active = null;
  database(f, (db) => {
    assert.equal(
      JSON.parse(
        db.prepare('SELECT value FROM settings WHERE key=?').get('mediaSeedVersion').value
      ),
      1
    );
    assert.equal(db.prepare("SELECT status FROM media WHERE id='image'").get().status, 'pending');
    assert.equal(db.prepare("SELECT status FROM media WHERE id='orphan'").get().status, 'missing');
  });
});

test('new scan seeds media atomically and repeat startup reuses the persisted rows without full-library sync', async (t) => {
  const f = await fixture(t),
    source = path.join(f.directory, 'source');
  await fs.mkdir(source);
  const file = path.join(source, 'sample.mp4');
  await fs.writeFile(file, 'small synthetic video placeholder');
  f.active = await client(f.data, { profile: true, suppressMedia: true });
  assert.deepEqual(fullStartupSql(await f.active.snapshot(true)), []);
  await f.active.call('scan', { path: source, onlineMatch: false, directoryKind: 'work' });
  await f.active.close();
  f.active = null;
  const first = database(f, (db) => {
    const media = db.prepare('SELECT * FROM media WHERE id=?').get(idFor(file));
    assert.equal(media.status, 'pending');
    db.prepare(
      "UPDATE media SET place='保留的地点',place_user=1,latitude=30,longitude=120,coords_user=1 WHERE id=?"
    ).run(idFor(file));
    return media.revision;
  });
  f.active = await client(f.data, { profile: true, suppressMedia: true });
  assert.deepEqual(fullStartupSql(await f.active.snapshot(true)), []);
  await f.active.call('scan', { path: source, onlineMatch: false, directoryKind: 'work' });
  const scanProfile = await f.active.snapshot();
  assert.ok(
    !scanProfile.some(({ sql }) =>
      sql.startsWith('run INSERT INTO media(id,revision,taken,date_source,status) VALUES')
    ),
    'unchanged rescan does not reseed media rows'
  );
  await f.active.close();
  f.active = null;
  database(f, (db) => {
    const media = db.prepare('SELECT * FROM media WHERE id=?').get(idFor(file));
    assert.equal(media.revision, first);
    assert.equal(media.place, '保留的地点');
    assert.equal(media.latitude, 30);
    assert.equal(media.longitude, 120);
  });
});

test(
  'folder finalization honors a concurrent manual cover and cancellation without opening a transaction across RPCs',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      source = path.join(f.directory, 'source');
    await fs.mkdir(source);
    const first = path.join(source, 'a.jpg'),
      manual = path.join(source, 'z.jpg');
    await fs.writeFile(first, 'first image placeholder');
    await fs.writeFile(manual, 'manual image placeholder');
    const root = idFor(source);
    f.active = await client(f.data, { suppressMedia: true, pauseBeforeFolderCommit: root });
    const scanning = f.active.call('scan', {
      path: source,
      onlineMatch: false,
      directoryKind: 'work'
    });
    assert.deepEqual(await f.active.paused, { id: root, inTransaction: false });
    await f.active.call('setCover', { id: root, imageId: idFor(manual) });
    await f.active.call('patch', {
      id: root,
      changes: { crop_x: 23, crop_y: 74, crop_zoom: 1.9, favorite: 1 }
    });
    await f.active.call('cancel');
    f.active.resume();
    assert.equal((await scanning).cancelled, true);
    const folder = await f.active.call('get', { id: root });
    assert.deepEqual(
      [
        folder.cover,
        folder.manual_cover,
        folder.crop_x,
        folder.crop_y,
        folder.crop_zoom,
        folder.favorite
      ],
      [idFor(manual), 1, 23, 74, 1.9, 1]
    );
    assert.equal(folder.files, 2);
    await f.active.close();
    f.active = null;
    const db = new DatabaseSync(path.join(f.data, 'library.sqlite'));
    try {
      const indexing = require('../src/indexing.cjs').createIndexing(db);
      const before = db.prepare('SELECT total_changes() n').get().n;
      await indexing.totals(root, async () => {});
      assert.equal(
        db.prepare('SELECT total_changes() n').get().n,
        before,
        'unchanged totals do not dirty browse indexes'
      );
    } finally {
      db.close();
    }
    f.active = await client(f.data, { suppressMedia: true });
    const restored = await f.active.call('get', { id: root });
    assert.equal(restored.cover, idFor(manual));
    assert.equal(restored.crop_zoom, 1.9);
    assert.equal(restored.files, 2);
  }
);

for (const mode of ['new', 'changed', 'revived', 'unchanged missing media']) {
  test(`manual cover selection persists ${mode} media for timeline and metadata after restart`, async (t) => {
    const f = await fixture(t),
      source = path.join(f.directory, 'source'),
      file = path.join(source, 'selected.png'),
      root = idFor(source),
      image = idFor(file),
      exists = mode !== 'new',
      changed = mode === 'changed' || mode === 'revived';
    await fs.mkdir(source);
    const writeImage = async (width, height) => {
      await fs.writeFile(
        file,
        await sharp({ create: { width, height, channels: 3, background: '#aaccee' } })
          .png()
          .toBuffer()
      );
    };
    if (exists) {
      await writeImage(13, 17);
      await fs.utimes(file, 1700000100, 1700000100);
    }
    f.active = await client(f.data, { suppressMedia: true });
    await f.active.call('scan', { path: source, offline: true });
    await f.active.close();
    f.active = null;
    database(f, (db) => {
      db.prepare('UPDATE nodes SET favorite=1,subject_id=42,manual_subject=1 WHERE id=?').run(root);
      if (exists) {
        db.prepare('UPDATE nodes SET favorite=1 WHERE id=?').run(image);
        db.prepare(
          `UPDATE media SET status='ready',width=13,height=17,place='手动地点',place_user=1,
          latitude=30,longitude=120,coords_user=1 WHERE id=?`
        ).run(image);
      }
      if (mode === 'revived') {
        db.prepare('UPDATE nodes SET missing=1 WHERE id=?').run(image);
        db.prepare("UPDATE media SET status='missing' WHERE id=?").run(image);
      }
      if (mode === 'unchanged missing media') db.prepare('DELETE FROM media WHERE id=?').run(image);
    });
    if (!exists || changed) {
      await writeImage(29, 31);
      await fs.utimes(file, 1700000200, 1700000200);
    }
    f.active = await client(f.data, { profile: true, suppressMedia: true });
    await f.active.snapshot(true);
    const selected = await f.active.call('selectCoverPath', { id: root, file });
    assert.equal(selected.cover, image);
    assert.equal(selected.manual_cover, 1);
    assert.equal(selected.favorite, 1);
    assert.equal(selected.subject_id, 42);
    assert.equal(selected.manual_subject, 1);
    await f.active.call('patch', { id: root, changes: { crop_x: 23, crop_y: 74, crop_zoom: 1.9 } });
    const timeline = await f.active.call('list', { timeline: true, limit: 24 });
    assert.ok(
      timeline.items.some((item) => item.id === image),
      'cover is visible without mediaInfo or rescan'
    );
    assert.deepEqual(
      fullStartupSql(await f.active.snapshot()),
      [],
      'selection does not seed the full library'
    );
    await f.active.close();
    f.active = null;
    database(f, (db) => {
      const node = db.prepare('SELECT * FROM nodes WHERE id=?').get(image),
        media = db.prepare('SELECT * FROM media WHERE id=?').get(image),
        revision = db
          .prepare(
            "SELECT CAST(mtime AS TEXT)||'-'||CAST(CAST(bytes AS INTEGER) AS TEXT) revision FROM nodes WHERE id=?"
          )
          .get(image).revision;
      assert.equal(node.missing, 0);
      assert.ok(media, 'media row is durable before restart');
      assert.equal(media.revision, revision);
      assert.equal(media.status, 'pending');
      assert.equal(media.width, null);
      assert.equal(media.height, null);
      assert.equal(media.taken, node.mtime);
      if (changed) {
        assert.equal(node.favorite, 1);
        assert.equal(media.place, '手动地点');
        assert.equal(media.place_user, 1);
        assert.equal(media.latitude, 30);
        assert.equal(media.longitude, 120);
        assert.equal(media.coords_user, 1);
      }
    });
    // No mediaInfo/rescan: the normal startup decoder must consume the persisted row.
    f.active = await client(f.data);
    assert.ok(
      (await f.active.call('list', { timeline: true })).items.some((item) => item.id === image)
    );
    const deadline = Date.now() + 5000;
    while (
      !f.active.events.some(
        (event) =>
          event.event === 'media' && event.data.id === image && event.data.status === 'ready'
      )
    ) {
      assert.ok(Date.now() < deadline, 'startup decoder finishes the selected cover');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const restored = await f.active.call('get', { id: root });
    assert.deepEqual(
      [
        restored.cover,
        restored.manual_cover,
        restored.favorite,
        restored.subject_id,
        restored.manual_subject,
        restored.crop_x,
        restored.crop_y,
        restored.crop_zoom
      ],
      [image, 1, 1, 42, 1, 23, 74, 1.9]
    );
    await f.active.close();
    f.active = null;
    database(f, (db) => {
      const media = db.prepare('SELECT * FROM media WHERE id=?').get(image);
      assert.equal(media.status, 'ready');
      assert.equal(media.width, !exists || changed ? 29 : 13);
      assert.equal(media.height, !exists || changed ? 31 : 17);
      if (changed) {
        assert.equal(media.place, '手动地点');
        assert.equal(media.latitude, 30);
        assert.equal(media.longitude, 120);
      }
    });
  });
}

test('manual cover media write failure rolls back the image and search row atomically', async (t) => {
  const f = await fixture(t),
    source = path.join(f.directory, 'source'),
    file = path.join(source, 'failed-cover.png'),
    root = idFor(source),
    image = idFor(file);
  await fs.mkdir(source);
  f.active = await client(f.data, { suppressMedia: true });
  await f.active.call('scan', { path: source, offline: true });
  await f.active.close();
  f.active = null;
  await fs.writeFile(
    file,
    await sharp({ create: { width: 13, height: 17, channels: 3, background: '#aaccee' } })
      .png()
      .toBuffer()
  );
  database(f, (db) =>
    db.exec(`CREATE TRIGGER fail_cover_media BEFORE INSERT ON media
    BEGIN SELECT RAISE(ABORT,'forced manual-cover media failure'); END;`)
  );
  f.active = await client(f.data, { suppressMedia: true });
  await assert.rejects(
    f.active.call('selectCoverPath', { id: root, file }),
    /forced manual-cover media failure/
  );
  assert.equal(await f.active.call('get', { id: image }), null);
  assert.equal((await f.active.call('list', { search: 'failed-cover' })).total, 0);
  assert.equal((await f.active.call('get', { id: root })).files, 0);
  await f.active.close();
  f.active = null;
  database(f, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes WHERE id=?').get(image).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM media WHERE id=?').get(image).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM search_index WHERE id=?').get(image).n, 0);
  });
});
