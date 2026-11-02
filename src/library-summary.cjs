'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const METHODS = new Set(['statistics', 'mediaStats']);
const REQUEST_TIMEOUT = 30000;
const MAX_PENDING = 64;

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}
function activitySnapshot(activity) {
  const snapshot = activity ?? { queued: 0, active: false, background: false };
  if (
    !Number.isSafeInteger(snapshot.queued) ||
    snapshot.queued < 0 ||
    typeof snapshot.active !== 'boolean' ||
    typeof snapshot.background !== 'boolean'
  )
    throw new TypeError('mediaStats requires {queued, active, background} activity');
  return { queued: snapshot.queued, active: snapshot.active, background: snapshot.background };
}

/**
 * Counts run off the library worker's message loop, on a separate read-only connection.
 * request('mediaStats', media.activity()) includes the caller's activity snapshot;
 * its rows reflect the later read transaction, not the same cross-thread instant.
 * Omitting activity represents an idle snapshot; live services must supply it.
 */
function createLibrarySummary({ databasePath }) {
  if (typeof databasePath !== 'string' || !databasePath)
    throw new TypeError('A library databasePath is required');
  const filename = path.resolve(databasePath);
  const pending = new Map();
  let worker = null,
    serial = 0,
    closed = false,
    closing = null,
    retiring = null;

  function settle(request, error, result) {
    const entry = pending.get(request);
    if (!entry) return;
    pending.delete(request);
    clearTimeout(entry.timer);
    if (pending.size === 0) worker?.unref();
    if (error) entry.reject(error);
    else entry.resolve(result);
  }
  function rejectAll(error) {
    for (const request of pending.keys()) settle(request, error);
  }
  function ensureWorker() {
    if (retiring) throw failure('Library summary worker is stopping', 'SUMMARY_RESTARTING');
    if (worker) return worker;
    const current = new Worker(path.join(__dirname, 'library-summary-worker.cjs'), {
      workerData: { databasePath: filename }
    });
    worker = current;
    current.on('message', ({ request, error, result }) => {
      if (worker !== current) return;
      if (error) {
        const reason = failure(error.message, error.code || 'SUMMARY_QUERY_FAILED');
        if (error.stack) reason.stack = error.stack;
        settle(request, reason);
      } else settle(request, null, result);
    });
    current.on('error', (error) => {
      if (worker !== current) return;
      worker = null;
      rejectAll(error);
    });
    current.on('exit', (code) => {
      if (worker !== current) return;
      worker = null;
      rejectAll(failure('Library summary worker exited (' + code + ')', 'SUMMARY_WORKER_EXITED'));
    });
    current.unref();
    return current;
  }

  function request(method, activity) {
    if (closed) return Promise.reject(failure('Library summary is closed', 'SUMMARY_CLOSED'));
    if (!METHODS.has(method))
      return Promise.reject(failure('Unknown library summary method', 'SUMMARY_METHOD_INVALID'));
    if (pending.size >= MAX_PENDING)
      return Promise.reject(failure('Too many pending library summaries', 'SUMMARY_BUSY'));
    let snapshot, current;
    try {
      if (method === 'mediaStats') snapshot = activitySnapshot(activity);
      current = ensureWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timer = setTimeout(() => {
        if (worker !== current || !pending.has(id)) return;
        worker = null;
        rejectAll(failure('Library summary request timed out', 'SUMMARY_TIMEOUT'));
        // Drop the worker's queued messages too; a timed-out caller must not leave
        // an invisible, growing backlog of database reads behind it.
        retiring = current
          .terminate()
          .catch(() => {})
          .finally(() => {
            retiring = null;
          });
      }, REQUEST_TIMEOUT);
      pending.set(id, { resolve, reject, timer });
      current.ref();
      try {
        current.postMessage({ request: id, method, activity: snapshot });
      } catch (error) {
        settle(id, error);
      }
    });
  }

  function close() {
    if (closing) return closing;
    closed = true;
    const current = worker;
    worker = null;
    rejectAll(failure('Library summary is closed', 'SUMMARY_CLOSED'));
    closing = Promise.all([current ? current.terminate() : undefined, retiring]).then(
      () => undefined
    );
    return closing;
  }

  return { request, close };
}

module.exports = { createLibrarySummary };
