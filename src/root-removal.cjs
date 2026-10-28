'use strict';
const path = require('node:path');

// Durable logical removal precedes bounded physical cleanup. A scan of the same
// path must await wait(root), so old cleanup can never delete a reimported row.
function createRootRemoval(
  db,
  {
    checkpoint = async () => {},
    notify = () => {},
    error = () => {},
    yieldNow = () => new Promise((resolve) => setImmediate(resolve))
  } = {}
) {
  db.exec(`CREATE TABLE IF NOT EXISTS root_removals(
    root TEXT PRIMARY KEY,path TEXT NOT NULL,name TEXT NOT NULL,removed_at REAL NOT NULL,removed INTEGER NOT NULL DEFAULT 0
  )`);
  const hidden = new Set(
    db
      .prepare('SELECT root FROM root_removals')
      .all()
      .map((row) => row.root)
  );
  const job = db.prepare('SELECT * FROM root_removals WHERE root=?');
  const next = db.prepare('SELECT * FROM root_removals ORDER BY removed_at,root LIMIT 1');
  const page = db.prepare('SELECT rowid,id FROM nodes WHERE root=? ORDER BY rowid LIMIT 128');
  const pending = db.prepare('SELECT id FROM match_pending WHERE root=? ORDER BY id LIMIT 128');
  const removeSearch = db.prepare('DELETE FROM search_index WHERE rowid=?');
  const removeMedia = db.prepare('DELETE FROM media WHERE id=?');
  const removePending = db.prepare('DELETE FROM match_pending WHERE id=? AND root=?');
  const removeNode = db.prepare('DELETE FROM nodes WHERE rowid=? AND root=?');
  const progress = db.prepare('UPDATE root_removals SET removed=removed+? WHERE root=?');
  const waiters = new Map();
  let active = null,
    scheduled = null,
    closing = false,
    preferred = null,
    lastEvent = 0;
  function visibleSql(alias = 'n') {
    if (!/^[a-z_][a-z\d_]*$/i.test(alias)) throw new Error('Invalid SQL alias');
    return hidden.size
      ? `NOT EXISTS(SELECT 1 FROM root_removals removed_root WHERE removed_root.root=${alias}.root)`
      : '1';
  }
  function status() {
    const current = next.get();
    return current
      ? {
          active: true,
          root: current.root,
          name: current.name,
          phase: '正在清理已移除分类',
          removed: current.removed
        }
      : { active: false };
  }
  function publish(current, force = false) {
    if (force || Date.now() - lastEvent >= 250) {
      lastEvent = Date.now();
      notify(
        current
          ? {
              active: true,
              root: current.root,
              name: current.name,
              phase: '正在清理已移除分类',
              removed: current.removed
            }
          : { active: false }
      );
    }
  }
  function settle(root, failure) {
    const requests = waiters.get(root) || [];
    waiters.delete(root);
    for (const request of requests) failure ? request.reject(failure) : request.resolve();
  }
  async function drain() {
    let dirty = 0;
    try {
      while (!closing) {
        const current = (preferred && job.get(preferred)) || next.get();
        if (!current) break;
        const rows = page.all(current.root);
        const orphanedPending = rows.length ? [] : pending.all(current.root);
        db.exec('BEGIN');
        try {
          for (const row of rows) {
            removeSearch.run(row.rowid);
            removeMedia.run(row.id);
            removePending.run(row.id, current.root);
            removeNode.run(row.rowid, current.root);
          }
          for (const row of orphanedPending) removePending.run(row.id, current.root);
          if (rows.length) progress.run(rows.length, current.root);
          else if (!orphanedPending.length) {
            db.prepare('DELETE FROM match_frontier WHERE root=?').run(current.root);
            db.prepare('DELETE FROM root_match_policy WHERE root=?').run(current.root);
            db.prepare('DELETE FROM root_removals WHERE root=?').run(current.root);
          }
          db.exec('COMMIT');
        } catch (failure) {
          db.exec('ROLLBACK');
          throw failure;
        }
        if (!rows.length && !orphanedPending.length) {
          hidden.delete(current.root);
          if (preferred === current.root) preferred = null;
          settle(current.root);
          publish(null, true);
        } else {
          current.removed += rows.length;
          publish(current);
          dirty += rows.length + orphanedPending.length;
        }
        // No transaction spans a yield or PASSIVE checkpoint.
        await yieldNow();
        if (dirty >= 2048) {
          await checkpoint();
          dirty = 0;
        }
      }
      if (dirty) await checkpoint();
      return true;
    } catch (failure) {
      for (const root of waiters.keys()) settle(root, failure);
      error(failure);
      // The committed tombstone remains hidden and can be resumed after restart.
      return false;
    }
  }
  function start() {
    if (closing || active || scheduled || !hidden.size) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      if (closing) return;
      let completed = false;
      active = drain()
        .then((result) => {
          completed = result;
        })
        .finally(() => {
          active = null;
          // A different root can be enqueued while the final checkpoint awaits.
          if (completed) start();
        });
    });
  }
  function enqueue(node) {
    if (closing) throw new Error('资料库正在关闭。');
    if (hidden.has(node.id)) return;
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO root_removals(root,path,name,removed_at) VALUES(?,?,?,?)').run(
        node.id,
        node.path,
        node.name,
        Date.now()
      );
      // Root-level frontier/policy rows are bounded. Large pending queues are
      // cleared with their nodes (and any tail entries) by the background job.
      db.prepare('DELETE FROM match_frontier WHERE root=?').run(node.id);
      db.prepare('DELETE FROM root_match_policy WHERE root=?').run(node.id);
      db.exec('COMMIT');
    } catch (failure) {
      db.exec('ROLLBACK');
      throw failure;
    }
    hidden.add(node.id);
    publish(job.get(node.id), true);
    start();
  }
  function wait(root, signal) {
    if (!hidden.has(root)) return Promise.resolve();
    if (closing) return Promise.reject(new Error('资料库正在关闭。'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    preferred = root;
    const promise = new Promise((resolve, reject) => {
      let request;
      const finish = (failure) => {
        signal?.removeEventListener('abort', abort);
        const requests = waiters.get(root);
        if (requests?.includes(request)) {
          requests.splice(requests.indexOf(request), 1);
          if (!requests.length) waiters.delete(root);
        }
        failure ? reject(failure) : resolve();
      };
      const abort = () => finish(signal.reason);
      request = { resolve: () => finish(), reject: finish };
      if (!waiters.has(root)) waiters.set(root, []);
      waiters.get(root).push(request);
      signal?.addEventListener('abort', abort, { once: true });
    });
    start();
    return promise;
  }
  async function stop() {
    closing = true;
    if (scheduled) {
      clearImmediate(scheduled);
      scheduled = null;
    }
    for (const root of waiters.keys()) settle(root, new Error('资料库正在关闭。'));
    if (active) await active;
  }
  function blockers(directory) {
    const target = path.resolve(directory).toLowerCase();
    return db
      .prepare('SELECT root,path FROM root_removals ORDER BY removed_at')
      .all()
      .filter((row) => {
        const old = path.resolve(row.path).toLowerCase();
        return (
          old === target || target.startsWith(old + path.sep) || old.startsWith(target + path.sep)
        );
      });
  }
  return {
    enqueue,
    start,
    wait,
    stop,
    status,
    visibleSql,
    blockers,
    isHidden: (root) => hidden.has(root)
  };
}
module.exports = { createRootRemoval };
