'use strict';

// Scanner-owned SQL. Every call is bounded by the caller's batch; no image
// decoding or in-memory queue grows with the library's file count.
function createIndexing(db, maintenance = null) {
  db.exec(`CREATE INDEX IF NOT EXISTS nodes_parent_scan ON nodes(parent,missing,indexed);
    CREATE INDEX IF NOT EXISTS nodes_parent_id ON nodes(parent,missing,id);
    CREATE TEMP TABLE IF NOT EXISTS scan_new(id TEXT PRIMARY KEY);
    CREATE TEMP TABLE IF NOT EXISTS scan_prune(node_rowid INTEGER PRIMARY KEY,id TEXT UNIQUE);`);
  // Read media state with the node so unchanged files need only a scan stamp.
  // SQLite formats fractional mtimes in revisions; keep that comparison in SQL.
  const previous = db.prepare(`SELECT n.rowid,n.missing,n.root,n.parent,n.name,n.sortkey,n.kind,
    n.depth,n.bytes,n.mtime,n.birth,m.status AS media_status,m.error AS media_error,
    m.revision=CAST(COALESCE(n.mtime,0) AS TEXT)||'-'||CAST(CAST(COALESCE(n.bytes,0) AS INTEGER) AS TEXT) AS media_current
    FROM nodes n LEFT JOIN media m ON m.id=n.id WHERE n.id=?`);
  const write =
    db.prepare(`INSERT INTO nodes(id,root,parent,path,name,sortkey,kind,depth,bytes,mtime,birth,indexed)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET root=excluded.root,parent=excluded.parent,
    name=excluded.name,sortkey=excluded.sortkey,kind=excluded.kind,depth=excluded.depth,
    bytes=excluded.bytes,mtime=excluded.mtime,birth=excluded.birth,missing=0,indexed=excluded.indexed`);
  const removeSearch = db.prepare('DELETE FROM search_index WHERE rowid=?');
  const addSearch = db.prepare('INSERT INTO search_index(rowid,id,name) VALUES(?,?,?)');
  const newFolder = db.prepare('INSERT OR IGNORE INTO scan_new VALUES(?)');
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
    'SELECT id FROM nodes WHERE parent=? AND missing=0 AND indexed<? LIMIT 128'
  );
  const enqueue = db.prepare(
    'INSERT OR IGNORE INTO scan_prune SELECT rowid,id FROM nodes WHERE id=?'
  );
  // Keep the bounded frontier outermost; a regular JOIN can scan all nodes
  // again for every removal batch as this temporary queue drains. A bounded
  // 128-row write batch matches the direct-child page size. Descendant queues
  // can hold an entire removed subtree; larger batches block reads while FTS
  // and the missing-keyed browse indexes are updated and durably committed.
  // Process queued rows in physical-table order rather than hashed-id order.
  // This keeps FTS and browse-index writes local with a bounded SQLite cache.
  const pending = db.prepare(
    'SELECT p.id,n.rowid FROM scan_prune p CROSS JOIN nodes n ON n.id=p.id ORDER BY p.rowid LIMIT 128'
  );
  const children = db.prepare(
    'SELECT id FROM nodes WHERE parent=? AND missing=0 AND id>? ORDER BY id LIMIT 128'
  );
  const missing = db.prepare('UPDATE nodes SET missing=1 WHERE id=?');
  const missingMedia = db.prepare(
    "UPDATE media SET status='missing' WHERE id=? AND status<>'missing'"
  );
  const dequeue = db.prepare('DELETE FROM scan_prune WHERE id=?');
  const totalPage = db.prepare(`SELECT id,kind,files,folders,bytes,total_bytes FROM nodes
    WHERE parent=? AND missing=0 AND id>? ORDER BY id LIMIT 256`);
  const saveTotals = db.prepare(`UPDATE nodes SET files=?,folders=?,total_bytes=? WHERE id=?
    AND (files IS NOT ? OR folders IS NOT ? OR total_bytes IS NOT ?)`);
  return {
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
      db.exec('DELETE FROM scan_new; DELETE FROM scan_prune');
    },
    protect(id, started) {
      protect.run(started, id);
    },
    upsert(n, s, started) {
      const old = previous.get(n.id);
      const birth = Number.isFinite(s.birthtimeMs) && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
      const unchanged =
        old &&
        !old.missing &&
        old.root === n.root &&
        old.parent === n.parent &&
        old.name === n.name &&
        old.sortkey === n.sortkey &&
        old.kind === n.kind &&
        old.depth === n.depth &&
        old.bytes === s.size &&
        old.mtime === s.mtimeMs &&
        old.birth === birth;
      let rowid = old?.rowid;
      if (unchanged) protect.run(started, n.id);
      else {
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
          started
        );
        rowid ??= result.lastInsertRowid;
      }
      if (!old || old.missing || old.name !== n.name) {
        if (old) removeSearch.run(rowid);
        addSearch.run(rowid, n.id, n.name);
      }
      if (n.kind === 'folder') {
        if (!old || old.missing) newFolder.run(n.id);
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
    // Enumeration has completed before this starts. Finish this folder's prune
    // even if cancellation arrives, yielding between pages so requests stay live.
    async prune(parent, started, checkpoint) {
      let autoCheckpoint = null,
        dirtyRows = 0;
      try {
        while (true) {
          const batch = stale.all(parent, started);
          if (!batch.length) break;
          if (maintenance && autoCheckpoint === null) {
            autoCheckpoint = db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint;
            db.exec('PRAGMA wal_autocheckpoint=0');
          }
          for (const n of batch) enqueue.run(n.id);
          while (true) {
            const work = pending.all();
            if (!work.length) break;
            for (const next of work) {
              let after = '';
              while (true) {
                const page = children.all(next.id, after);
                if (!page.length) break;
                db.exec('BEGIN');
                try {
                  for (const child of page) enqueue.run(child.id);
                  db.exec('COMMIT');
                } catch (e) {
                  db.exec('ROLLBACK');
                  throw e;
                }
                after = page.at(-1).id;
                await checkpoint();
              }
            }
            db.exec('BEGIN');
            try {
              for (const next of work) {
                removeSearch.run(next.rowid);
                missing.run(next.id);
                missingMedia.run(next.id);
                dequeue.run(next.id);
              }
              db.exec('COMMIT');
            } catch (e) {
              db.exec('ROLLBACK');
              throw e;
            }
            dirtyRows += work.length;
            await checkpoint(true);
            // A completed PASSIVE checkpoint may leave a large physical WAL
            // file for reuse. Budget changed rows, not that file's high water.
            if (maintenance && dirtyRows >= 2048) {
              await maintenance.checkpoint();
              dirtyRows = 0;
            }
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
  };
}
module.exports = { createIndexing };
