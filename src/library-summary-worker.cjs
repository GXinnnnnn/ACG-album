'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

// Each request gets a fresh read transaction, including committed WAL contents.
// This worker never imports the library/media services, creates schema, or seeds data.
function summarize(method) {
  const db = new DatabaseSync(workerData.databasePath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; BEGIN');
    const hasRemovals =
      !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='root_removals'")
        .get() && !!db.prepare('SELECT root FROM root_removals LIMIT 1').get();
    const visible = hasRemovals
      ? 'NOT EXISTS(SELECT 1 FROM root_removals removed_root WHERE removed_root.root=n.root)'
      : '1';
    let result;
    if (method === 'statistics') {
      result = db
        .prepare(
          `SELECT COUNT(*) total,
          COALESCE(SUM(CASE WHEN kind IN ('image','video') THEN 1 ELSE 0 END),0) images,
          COALESCE(SUM(CASE WHEN kind='folder' THEN 1 ELSE 0 END),0) folders
          FROM nodes n WHERE missing=0 AND ${visible}`
        )
        .get();
    } else if (method === 'mediaStats') {
      // Match media.stats(): missing nodes remain, logically removed roots do not,
      // and orphan media rows remain visible. No status values are filtered out.
      result = db
        .prepare(
          hasRemovals
            ? `SELECT m.status,COUNT(*) count FROM media m LEFT JOIN nodes n ON n.id=m.id
              WHERE n.id IS NULL OR ${visible} GROUP BY m.status`
            : 'SELECT status,COUNT(*) count FROM media GROUP BY status'
        )
        .all();
    } else {
      throw new Error('Unknown library summary method');
    }
    db.exec('COMMIT');
    return result;
  } finally {
    db.close();
  }
}

parentPort.on('message', ({ request, method, activity }) => {
  try {
    const data = summarize(method);
    parentPort.postMessage({
      request,
      result: method === 'mediaStats' ? { rows: data, ...activity } : data
    });
  } catch (error) {
    parentPort.postMessage({
      request,
      error: { message: error.message, code: error.code, stack: error.stack }
    });
  }
});
