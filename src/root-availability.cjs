'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Availability is independent of nodes.missing: losing a volume must never prune
// an imported tree or consume its durable work. Only explicit retry clears offline.
function createRootAvailability(db, { timeout = 2000 } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS root_availability(
    root TEXT PRIMARY KEY,path TEXT NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL,
    code TEXT NOT NULL,checked_at REAL NOT NULL,offline_since REAL NOT NULL DEFAULT 0
  )`);
  const inFlight = new Map();
  const row = db.prepare('SELECT * FROM root_availability WHERE root=?');
  const onlineSql = (alias) =>
    `NOT EXISTS(SELECT 1 FROM root_availability ra WHERE ra.root=${alias}.root AND ra.status='offline')`;
  function state(root) {
    const saved = row.get(root.id);
    return {
      id: root.id,
      path: root.path,
      name: root.name || path.basename(root.path),
      status: saved?.status || 'unknown',
      reason: saved?.reason || '',
      code: saved?.code || '',
      checkedAt: saved?.checked_at || 0,
      offlineSince: saved?.offline_since || 0,
      retryable: true
    };
  }
  function record(root, status, error = null) {
    const now = Date.now(),
      previous = row.get(root.id);
    db.prepare(
      `INSERT INTO root_availability VALUES(?,?,?,?,?,?,?) ON CONFLICT(root) DO UPDATE SET
      path=excluded.path,status=excluded.status,reason=excluded.reason,code=excluded.code,
      checked_at=excluded.checked_at,offline_since=excluded.offline_since`
    ).run(
      root.id,
      root.path,
      status,
      String(error?.message || '').slice(0, 1000),
      String(error?.code || ''),
      now,
      status === 'offline' ? previous?.offline_since || now : 0
    );
    return state(root);
  }
  async function inspect(root) {
    const key = root.id + '\0' + root.path;
    if (inFlight.has(key)) return inFlight.get(key);
    const task = (async () => {
      let timer;
      try {
        return await Promise.race([
          (async () => {
            const absolute = path.resolve(root.path),
              volume = path.parse(absolute).root;
            let current = volume,
              stat;
            for (const part of [
              '',
              ...absolute.slice(volume.length).split(path.sep).filter(Boolean)
            ]) {
              if (part) current = path.join(current, part);
              stat = await fs.lstat(current);
              if (stat.isSymbolicLink() || !stat.isDirectory())
                throw Object.assign(new Error('分类目录不可用或包含符号链接/目录联接。'), {
                  code: 'ENOTDIR'
                });
            }
            // Check permission to enumerate, but never enumerate or mutate here.
            const directory = await fs.opendir(absolute);
            await directory.close();
            return { available: true };
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error('分类目录探测超时，请连接磁盘后重试。'), {
                    code: 'ROOT_TIMEOUT'
                  })
                ),
              timeout
            );
          })
        ]);
      } catch (error) {
        return { available: false, error };
      } finally {
        clearTimeout(timer);
      }
    })();
    inFlight.set(key, task);
    try {
      return await task;
    } finally {
      inFlight.delete(key);
    }
  }
  return {
    state,
    record,
    inspect,
    onlineSql,
    isOffline: (root) => row.get(root)?.status === 'offline'
  };
}
module.exports = { createRootAvailability };
