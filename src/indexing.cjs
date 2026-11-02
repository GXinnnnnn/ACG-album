'use strict';
const { ensureIdentitySchema, nodeIdentity } = require('./scan-identity.cjs');

// Scanner-owned SQL. Every call is bounded by the caller's batch; no image
// decoding or in-memory queue grows with the library's file count.
function createIndexing(db, maintenance = null) {
  ensureIdentitySchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS nodes_parent_scan ON nodes(parent,missing,indexed);
    CREATE INDEX IF NOT EXISTS nodes_parent_id ON nodes(parent,missing,id);`);
  // Durable queues are scoped to one scan job. The empty job preserves legacy
  // callers; a resumed job selects its original key and must not call reset().
  const queueSchema = `CREATE TABLE IF NOT EXISTS scan_new(
    job TEXT NOT NULL DEFAULT '',id TEXT NOT NULL,PRIMARY KEY(job,id));
    CREATE TABLE IF NOT EXISTS scan_prune(
    job TEXT NOT NULL DEFAULT '',node_rowid INTEGER NOT NULL,id TEXT NOT NULL,stamp REAL,
    PRIMARY KEY(job,node_rowid),UNIQUE(job,id));`;
  db.exec(queueSchema);
  for (const name of ['scan_new', 'scan_prune']) {
    if (
      db
        .prepare(`PRAGMA main.table_info(${name})`)
        .all()
        .some((c) => c.name === 'job')
    )
      continue;
    db.exec('SAVEPOINT scan_queue_upgrade');
    try {
      db.exec(`ALTER TABLE ${name} RENAME TO ${name}_legacy;`);
      db.exec(queueSchema);
      const hadStamp = db
        .prepare(`PRAGMA main.table_info(${name}_legacy)`)
        .all()
        .some((c) => c.name === 'stamp');
      const columns = name === 'scan_new' ? 'id' : `node_rowid,id${hadStamp ? ',stamp' : ''}`;
      db.exec(`INSERT INTO ${name}(job,${columns}) SELECT '',${columns} FROM ${name}_legacy;
        DROP TABLE ${name}_legacy; RELEASE scan_queue_upgrade;`);
    } catch (error) {
      db.exec('ROLLBACK TO scan_queue_upgrade; RELEASE scan_queue_upgrade');
      throw error;
    }
  }
  if (
    !db
      .prepare('PRAGMA main.table_info(scan_prune)')
      .all()
      .some((c) => c.name === 'stamp')
  )
    db.exec('ALTER TABLE scan_prune ADD COLUMN stamp REAL');
  let job = '';
  const jobKey = (value) => {
    if (typeof value !== 'string' || value.length > 240 || value.includes('\0'))
      throw new TypeError('Invalid scan job');
    return value;
  };
  // Read media state with the node so unchanged files need only a scan stamp.
  // SQLite formats fractional mtimes in revisions; keep that comparison in SQL.
  const previous =
    db.prepare(`SELECT n.rowid,n.missing,n.root,n.parent,n.path,n.name,n.sortkey,n.kind,
    n.depth,n.bytes,n.mtime,n.birth,n.fs_identity,m.status AS media_status,m.error AS media_error,
    m.revision=CAST(COALESCE(n.mtime,0) AS TEXT)||'-'||CAST(CAST(COALESCE(n.bytes,0) AS INTEGER) AS TEXT) AS media_current
    FROM nodes n LEFT JOIN media m ON m.id=n.id WHERE n.id=?`);
  const write =
    db.prepare(`INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed,fs_identity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,parent=excluded.parent,
    path=excluded.path,name=excluded.name,sortkey=excluded.sortkey,kind=excluded.kind,depth=excluded.depth,
    bytes=excluded.bytes,mtime=excluded.mtime,birth=excluded.birth,missing=0,indexed=excluded.indexed,
    fs_identity=excluded.fs_identity`);
  const saveIdentity = db.prepare('UPDATE nodes SET fs_identity=? WHERE id=?');
  const removeSearch = db.prepare('DELETE FROM search_index WHERE rowid=?');
  const addSearch = db.prepare('INSERT INTO search_index(rowid,id,name) VALUES(?,?,?)');
  const newFolder = db.prepare('INSERT OR IGNORE INTO scan_new(job,id) VALUES(?,?)');
  const protect = db.prepare('UPDATE nodes SET indexed=? WHERE id=?');
  // Match media.sync's reset semantics, including explicit place/coordinate overrides.
  const seedMedia = db.prepare(`INSERT INTO media(id,revision,taken,date_source,status)
    VALUES(?,?,?,?,'pending') ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,taken=excluded.taken,
    date_source=excluded.date_source,width=NULL,height=NULL,format=NULL,frames=NULL,delays=NULL,camera=NULL,
    hdr=NULL,depth=NULL,space=NULL,has_icc=NULL,orientation=1,page_height=NULL,loop=0,status='pending',error=NULL,
    latitude=CASE WHEN media.coords_user=1 THEN media.latitude ELSE NULL END,
    longitude=CASE WHEN media.coords_user=1 THEN media.longitude ELSE NULL END
    WHERE media.revision<>excluded.revision OR media.status='missing'
      OR (media.status='error' AND media.error='媒体服务已停止。')`);
  const revision = db.prepare(
    "SELECT CAST(? AS TEXT)||'-'||CAST(CAST(? AS INTEGER) AS TEXT) value"
  );
  const stale = db.prepare(
    `SELECT id,indexed,rowid FROM nodes WHERE parent=? AND missing=0 AND indexed<?
      AND (indexed,rowid)>(?,?) ORDER BY indexed,rowid LIMIT 128`
  );
  const enqueue = db.prepare(
    'INSERT OR IGNORE INTO scan_prune(job,node_rowid,id,stamp) SELECT ?,rowid,id,? FROM nodes WHERE id=?'
  );
  // Keep the bounded frontier outermost; a regular JOIN can scan all nodes
  // again for every removal batch as this temporary queue drains. A bounded
  // 128-row write batch matches the direct-child page size. Descendant queues
  // can hold an entire removed subtree; larger batches block reads while FTS
  // and the missing-keyed browse indexes are updated and durably committed.
  // Process queued rows in physical-table order rather than hashed-id order.
  // This keeps FTS and browse-index writes local with a bounded SQLite cache.
  const pending = db.prepare(
    'SELECT id,node_rowid,stamp FROM scan_prune WHERE job=? ORDER BY node_rowid LIMIT 128'
  );
  const pruneLive = db.prepare('SELECT rowid,indexed,missing,parent FROM nodes WHERE id=?');
  const pruneProtected = (next) => {
    const live = pruneLive.get(next.id);
    // A legacy queue without an enumeration stamp cannot prove deletion. A fresh
    // EOF prune can enqueue it again with a known stamp after safe revalidation.
    if (
      !live ||
      live.rowid !== next.node_rowid ||
      !Number.isFinite(next.stamp) ||
      (!live.missing && live.indexed >= next.stamp)
    )
      return true;
    // A previously queued descendant can outlive its dequeued missing parent.
    // A newer ancestor stamp invalidates that old subtree deletion. The same
    // generation must still prune missing children after its normal parent upsert.
    const seen = new Set([next.id]);
    let parent = live.parent,
      depth = 0;
    while (parent !== null) {
      if (depth++ >= 256 || seen.has(parent)) return true;
      seen.add(parent);
      const ancestor = pruneLive.get(parent);
      if (!ancestor || !Number.isFinite(ancestor.indexed)) return true;
      if (ancestor.indexed > next.stamp) return true;
      parent = ancestor.parent;
    }
    return false;
  };
  const children = db.prepare(
    'SELECT id FROM nodes WHERE parent=? AND missing=0 AND id>? ORDER BY id LIMIT 128'
  );
  const missing = db.prepare('UPDATE nodes SET missing=1 WHERE id=?');
  const missingMedia = db.prepare(
    "UPDATE media SET status='missing' WHERE id=? AND status<>'missing'"
  );
  const dequeue = db.prepare('DELETE FROM scan_prune WHERE job=? AND id=?');
  const totalPage = db.prepare(`SELECT id,kind,files,folders,bytes,total_bytes FROM nodes
    WHERE parent=? AND missing=0 AND id>? ORDER BY id LIMIT 256`);
  const saveTotals = db.prepare(`UPDATE nodes SET files=?,folders=?,total_bytes=? WHERE id=?
    AND (files IS NOT ? OR folders IS NOT ? OR total_bytes IS NOT ?)`);
  async function drainPrune(parent, started, checkpoint) {
    const activeJob = job;
    let autoCheckpoint = null,
      dirtyRows = 0,
      afterIndexed = -Number.MAX_VALUE,
      afterRowid = 0;
    try {
      while (true) {
        let work = pending.all(activeJob);
        // Drain persisted descendants first. Their parent may already be missing,
        // so looking only for fresh stale direct children cannot reconstruct them.
        if (!work.length && parent !== null) {
          const batch = stale.all(parent, started, afterIndexed, afterRowid);
          if (!batch.length) break;
          // Protected/broken-chain rows remain live. Advance a stable SQLite
          // index cursor so skipping them cannot immediately enqueue them forever.
          afterIndexed = batch.at(-1).indexed;
          afterRowid = batch.at(-1).rowid;
          db.exec('BEGIN');
          try {
            for (const n of batch) enqueue.run(activeJob, started, n.id);
            db.exec('COMMIT');
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
          work = pending.all(activeJob);
        }
        if (!work.length) break;
        if (maintenance && autoCheckpoint === null) {
          autoCheckpoint = db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;
          db.exec('PRAGMA wal_autocheckpoint=0');
        }
        for (const next of work) {
          if (pruneProtected(next)) continue;
          let after = '';
          while (true) {
            const page = children.all(next.id, after);
            if (!page.length) break;
            db.exec('BEGIN');
            try {
              for (const child of page) enqueue.run(activeJob, next.stamp, child.id);
              db.exec('COMMIT');
            } catch (error) {
              db.exec('ROLLBACK');
              throw error;
            }
            after = page.at(-1).id;
            await checkpoint();
          }
        }
        db.exec('BEGIN');
        try {
          for (const next of work) {
            // Re-read after the yielding child-enqueue pass. A newer scan may
            // already have protected/revived this row while pruning was paused.
            if (!pruneProtected(next)) {
              removeSearch.run(next.node_rowid);
              missing.run(next.id);
              missingMedia.run(next.id);
            }
            dequeue.run(activeJob, next.id);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        dirtyRows += work.length;
        await checkpoint(true);
        if (maintenance && dirtyRows >= 2048) {
          await maintenance.checkpoint();
          dirtyRows = 0;
        }
      }
    } finally {
      if (autoCheckpoint !== null) {
        try {
          if (dirtyRows) await maintenance.checkpoint();
        } finally {
          db.exec(`PRAGMA wal_autocheckpoint=${autoCheckpoint}`);
        }
      }
    }
  }
  return {
    setJob(value = '') {
      job = jobKey(value);
      return job;
    },
    recovery() {
      return {
        job,
        newFolders: db.prepare('SELECT COUNT(*) count FROM scan_new WHERE job=?').get(job).count,
        prunePending: db.prepare('SELECT COUNT(*) count FROM scan_prune WHERE job=?').get(job).count
      };
    },
    resumePrune(checkpoint = async () => {}) {
      return drainPrune(null, null, checkpoint);
    },
    async totals(parent, checkpoint, deferWrite = false) {
      let after = '',
        files = 0,
        folders = 0,
        bytes = 0;
      while (true) {
        const page = totalPage.all(parent, after);
        if (!page.length) break;
        for (const n of page) {
          const folder = n.kind === 'folder';
          files += folder ? n.files || 0 : 1;
          folders += folder ? 1 + (n.folders || 0) : 0;
          bytes += (folder ? n.total_bytes : n.bytes) || 0;
        }
        after = page.at(-1).id;
        await checkpoint();
      }
      // The scanner may combine this final write with its cover pointer after
      // all paged reads have yielded. Never hold a transaction across an await.
      const save = () => saveTotals.run(files, folders, bytes, parent, files, folders, bytes);
      if (deferWrite) return save;
      save();
    },
    reset() {
      db.prepare('DELETE FROM scan_new WHERE job=?').run(job);
      db.prepare('DELETE FROM scan_prune WHERE job=?').run(job);
    },
    protect(id, started) {
      protect.run(started, id);
    },
    upsert(n, s, started) {
      const old = previous.get(n.id);
      const identity = nodeIdentity(n, s);
      const birth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
      const unchanged =
        old &&
        !old.missing &&
        old.root === n.root &&
        old.parent === n.parent &&
        old.path === n.path &&
        old.name === n.name &&
        old.sortkey === n.sortkey &&
        old.kind === n.kind &&
        old.depth === n.depth &&
        old.bytes === s.size &&
        old.mtime === s.mtimeMs &&
        old.birth === birth;
      let rowid = old?.rowid;
      if (unchanged) {
        protect.run(started, n.id);
        // First refresh of an older database can learn identity without broad
        // metadata writes, media resets, or classifying the folder as new.
        if (old.fs_identity !== identity) saveIdentity.run(identity, n.id);
      } else {
        const result = write.run(
          n.id,
          n.root,
          n.parent,
          n.path,
          n.name,
          n.sortkey,
          n.kind,
          n.depth,
          s.size,
          s.mtimeMs,
          birth,
          started,
          identity
        );
        rowid ??= result.lastInsertRowid;
      }
      if (!old || old.missing || old.name !== n.name) {
        if (old) removeSearch.run(rowid);
        addSearch.run(rowid, n.id, n.name);
      }
      if (n.kind === 'folder') {
        if (!old || old.missing) newFolder.run(job, n.id);
      } else if (
        !old ||
        old.mtime !== s.mtimeMs ||
        old.bytes !== s.size ||
        !old.media_current ||
        old.media_status === 'missing' ||
        (old.media_status === 'error' && old.media_error === '媒体服务已停止。')
      ) {
        const modified = Number.isFinite(s.mtimeMs) && s.mtimeMs > 0;
        seedMedia.run(
          n.id,
          revision.get(s.mtimeMs || 0, s.size || 0).value,
          modified ? s.mtimeMs : s.birthtimeMs || 0,
          modified ? 'mtime' : 'birth'
        );
      }
    },
    // Only call prune after this directory reached EOF. Recovery can drain
    // already committed deletion work without assuming enumeration completed.
    prune(parent, started, checkpoint = async () => {}) {
      return drainPrune(parent, started, checkpoint);
    }
  };
}
module.exports = { createIndexing };
