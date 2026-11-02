'use strict';
const { randomUUID } = require('node:crypto');
const { importOptions } = require('./matching-policy.cjs');

const DIRECTORY_PHASES = new Set(['enumerate', 'prune', 'children', 'finalize', 'done']);
const text = (value, label, max = 32768) => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new TypeError(`Invalid scan ${label}`);
  return value;
};
const stampValue = (value) => {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError('Invalid scan stamp');
  return value;
};
function snapshotOf(value) {
  if (!value || typeof value !== 'object') return null;
  const identity = value.fsIdentity ?? value.identity;
  if (typeof identity !== 'string' || !identity || identity.length > 240) return null;
  if (!Number.isFinite(value.mtimeMs) || !Number.isFinite(value.ctimeMs)) return null;
  return { identity, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
}
function optionsOf(options) {
  const result = importOptions(options);
  for (const key of ['offline', 'matchNewOnly', 'externalSync', 'deepSync'])
    if (Object.hasOwn(options, key)) {
      if (typeof options[key] !== 'boolean') throw new TypeError(`Invalid scan ${key}`);
      result[key] = options[key];
    }
  return result;
}
function countersOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid scan counters');
  const result = {};
  for (const key of ['folders', 'images', 'visited', 'queued', 'errors'])
    if (Object.hasOwn(value, key)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0)
        throw new TypeError('Invalid scan counter');
      result[key] = value[key];
    }
  return result;
}

// All methods are synchronous and join the caller's transaction. In particular,
// directory completion belongs in the cover/totals transaction, and finish belongs
// in the matching-handoff transaction. No filesystem enumeration offsets are stored.
function createScanJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS scan_jobs(
    id TEXT PRIMARY KEY,root TEXT NOT NULL,path TEXT NOT NULL,target TEXT,options TEXT NOT NULL,
    started REAL NOT NULL,state TEXT NOT NULL,phase TEXT NOT NULL,counters TEXT NOT NULL,reason TEXT NOT NULL DEFAULT ''
  );
  CREATE UNIQUE INDEX IF NOT EXISTS scan_jobs_one_running ON scan_jobs(state) WHERE state='running';
  CREATE INDEX IF NOT EXISTS scan_jobs_root ON scan_jobs(root,id);
  CREATE TABLE IF NOT EXISTS scan_directories(
    job TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,path TEXT NOT NULL,depth INTEGER NOT NULL,
    phase TEXT NOT NULL,after_child TEXT NOT NULL DEFAULT '',stamp REAL NOT NULL,snapshot TEXT,
    PRIMARY KEY(job,id)
  );
  CREATE INDEX IF NOT EXISTS scan_directories_parent ON scan_directories(job,parent,id);
  CREATE INDEX IF NOT EXISTS scan_directories_phase ON scan_directories(job,phase,id);`);
  let selected = null;
  const getJob = db.prepare('SELECT * FROM scan_jobs WHERE id=?');
  const getDir = db.prepare('SELECT * FROM scan_directories WHERE job=? AND id=?');
  const decodeJob = (row) =>
    row ? { ...row, options: JSON.parse(row.options), counters: JSON.parse(row.counters) } : null;
  const decodeDir = (row) =>
    row ? { ...row, snapshot: row.snapshot ? JSON.parse(row.snapshot) : null } : null;
  const current = () => {
    const job = selected && getJob.get(selected);
    if (!job) throw new Error('No selected scan job');
    return job;
  };
  const frame = (id) => {
    const job = current();
    const row = getDir.get(job.id, text(id, 'directory id', 240));
    if (!row) throw new Error('Unknown scan directory');
    return row;
  };
  const limitOf = (limit) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      throw new TypeError('Invalid scan page limit');
    return limit;
  };
  function checkpointDirectory(id, patch = {}) {
    const old = frame(id);
    const phase = patch.phase ?? old.phase;
    if (!DIRECTORY_PHASES.has(phase)) throw new TypeError('Invalid scan directory phase');
    const after = patch.afterChild ?? old.after_child;
    if (typeof after !== 'string' || after.length > 240 || after.includes('\0'))
      throw new TypeError('Invalid scan child cursor');
    const stamp = patch.stamp === undefined ? old.stamp : stampValue(patch.stamp);
    const snapshot = Object.hasOwn(patch, 'snapshot')
      ? JSON.stringify(snapshotOf(patch.snapshot))
      : old.snapshot;
    db.prepare(
      'UPDATE scan_directories SET phase=?,after_child=?,stamp=?,snapshot=? WHERE job=? AND id=?'
    ).run(phase, after, stamp, snapshot, old.job, old.id);
    return decodeDir(getDir.get(old.job, old.id));
  }
  function atomic(change) {
    // A savepoint joins an existing caller transaction. It also keeps a standalone
    // multi-row cancel/reopen indivisible if the process closes between statements.
    db.exec('SAVEPOINT scan_journal_change');
    try {
      const result = change();
      db.exec('RELEASE scan_journal_change');
      return result;
    } catch (error) {
      db.exec('ROLLBACK TO scan_journal_change; RELEASE scan_journal_change');
      throw error;
    }
  }
  function remove() {
    return atomic(() => {
      const job = current();
      db.prepare('DELETE FROM scan_directories WHERE job=?').run(job.id);
      db.prepare('DELETE FROM scan_jobs WHERE id=?').run(job.id);
      // Keep the selection key until the caller's transaction commits. A rollback
      // then restores load()/current() without an inconsistent in-memory reset.
      return decodeJob(job);
    });
  }
  return {
    begin({ id = randomUUID(), root, path, target = null, options = {}, started }) {
      text(id, 'job id', 240);
      text(root, 'root id', 240);
      text(path, 'path');
      if (target !== null) text(target, 'target');
      stampValue(started);
      const safeOptions = optionsOf(options);
      db.prepare(
        "INSERT INTO scan_jobs(id,root,path,target,options,started,state,phase,counters) VALUES(?,?,?,?,?,?,'queued','scan','{}')"
      ).run(id, root, path, target, JSON.stringify(safeOptions), started);
      selected = id;
      return decodeJob(getJob.get(id));
    },
    setJob(id) {
      if (!getJob.get(text(id, 'job id', 240))) throw new Error('Unknown scan job');
      selected = id;
      return decodeJob(getJob.get(id));
    },
    load(id = selected) {
      if (id !== null) text(id, 'job id', 240);
      return decodeJob(id ? getJob.get(id) : undefined);
    },
    jobs({ after = '', limit = 64 } = {}) {
      if (typeof after !== 'string' || after.length > 240)
        throw new TypeError('Invalid scan cursor');
      return db
        .prepare('SELECT * FROM scan_jobs WHERE id>? ORDER BY id LIMIT ?')
        .all(after, limitOf(limit))
        .map(decodeJob);
    },
    resume(id = selected) {
      const job = getJob.get(text(id, 'job id', 240));
      if (!job) throw new Error('Unknown scan job');
      const other = db.prepare("SELECT id FROM scan_jobs WHERE state='running' AND id<>?").get(id);
      if (other) throw new Error('Another scan job is running');
      db.prepare("UPDATE scan_jobs SET state='running',reason='' WHERE id=?").run(id);
      selected = id;
      return decodeJob(getJob.get(id));
    },
    pause({ reason = '' } = {}) {
      const job = current();
      if (typeof reason !== 'string' || reason.length > 1000)
        throw new TypeError('Invalid scan reason');
      db.prepare("UPDATE scan_jobs SET state='paused',reason=? WHERE id=?").run(reason, job.id);
      return decodeJob(getJob.get(job.id));
    },
    block({ reason } = {}) {
      const job = current();
      text(reason, 'reason', 1000);
      db.prepare("UPDATE scan_jobs SET state='blocked',reason=? WHERE id=?").run(reason, job.id);
      return decodeJob(getJob.get(job.id));
    },
    checkpoint({ phase, counters, target } = {}) {
      const job = current();
      if (phase !== undefined) text(phase, 'phase', 80);
      if (target !== undefined && target !== null) text(target, 'target');
      const next =
        counters === undefined
          ? job.counters
          : JSON.stringify({ ...JSON.parse(job.counters), ...countersOf(counters) });
      db.prepare('UPDATE scan_jobs SET phase=?,counters=?,target=? WHERE id=?').run(
        phase ?? job.phase,
        next,
        target === undefined ? job.target : target,
        job.id
      );
      return decodeJob(getJob.get(job.id));
    },
    discoverDirectory({ id, parent = null, path, depth = 0, snapshot = null, stamp }) {
      const job = current();
      text(id, 'directory id', 240);
      text(path, 'directory path');
      if (parent !== null) text(parent, 'parent id', 240);
      if (!Number.isSafeInteger(depth) || depth < 0) throw new TypeError('Invalid scan depth');
      const scanStamp = stamp === undefined ? job.started : stampValue(stamp);
      db.prepare(
        "INSERT OR IGNORE INTO scan_directories(job,id,parent,path,depth,phase,stamp,snapshot) VALUES(?,?,?,?,?,'enumerate',?,?)"
      ).run(job.id, id, parent, path, depth, scanStamp, JSON.stringify(snapshotOf(snapshot)));
      return decodeDir(getDir.get(job.id, id));
    },
    directory(id) {
      return decodeDir(getDir.get(current().id, text(id, 'directory id', 240)));
    },
    directories({ after = '', limit = 64, phase } = {}) {
      const job = current();
      if (typeof after !== 'string' || after.length > 240)
        throw new TypeError('Invalid scan cursor');
      if (phase !== undefined && !DIRECTORY_PHASES.has(phase))
        throw new TypeError('Invalid scan directory phase');
      const sql =
        phase === undefined
          ? 'SELECT * FROM scan_directories WHERE job=? AND id>? ORDER BY id LIMIT ?'
          : 'SELECT * FROM scan_directories WHERE job=? AND id>? AND phase=? ORDER BY id LIMIT ?';
      const values =
        phase === undefined
          ? [job.id, after, limitOf(limit)]
          : [job.id, after, phase, limitOf(limit)];
      return db
        .prepare(sql)
        .all(...values)
        .map(decodeDir);
    },
    checkpointDirectory,
    completeDirectory(id, patch = {}) {
      return checkpointDirectory(id, { ...patch, phase: 'done', afterChild: '' });
    },
    directoryUnchanged(id, snapshot) {
      const old = frame(id),
        value = snapshotOf(snapshot);
      return old.phase === 'done' && value !== null && old.snapshot === JSON.stringify(value);
    },
    reopenDirectory(id, { snapshot = null, stamp } = {}) {
      return atomic(() => {
        const old = frame(id);
        stampValue(stamp);
        if (stamp <= old.stamp) throw new TypeError('Revalidation requires a newer scan stamp');
        const result = checkpointDirectory(id, {
          phase: 'enumerate',
          afterChild: '',
          snapshot,
          stamp
        });
        // The worker's depth-bounded directory ancestry is already represented by
        // frames. Reopen ancestors for children/totals, never completed siblings.
        let parent = old.parent;
        const seen = new Set([id]);
        while (parent && !seen.has(parent)) {
          seen.add(parent);
          const ancestor = getDir.get(old.job, parent);
          if (!ancestor) break;
          if (['done', 'finalize', 'children'].includes(ancestor.phase))
            checkpointDirectory(parent, { phase: 'children', afterChild: '' });
          parent = ancestor.parent;
        }
        return result;
      });
    },
    finish: remove,
    cancel: remove
  };
}
module.exports = { createScanJournal, snapshotOf };
