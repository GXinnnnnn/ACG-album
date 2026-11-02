'use strict';
const path = require('node:path');

// A watcher path is lexical evidence only. The scanner still owns symlink,
// filesystem identity and permission validation before changing indexed rows.
function absolute(value, api) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !api.isAbsolute(value))
    return null;
  const normalized = api.normalize(value);
  const root = api.parse(normalized).root;
  return normalized.length > root.length
    ? normalized.replace(api.sep === '\\' ? /[\\/]+$/ : /\/+$/, '')
    : normalized;
}
function rootOf(value) {
  if (typeof value !== 'string') return null;
  const windows = /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value);
  const api = windows ? path.win32 : path.posix;
  const rootPath = absolute(value, api);
  return rootPath ? { api, windows, rootPath } : null;
}
function within(context, parent, child) {
  const relative = context.api.relative(parent, child);
  return (
    relative === '' ||
    (!context.api.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + context.api.sep))
  );
}
const pathKey = (context, value) => (context.windows ? value.toLowerCase() : value);
function targetOf(context, value) {
  if (context.windows && !/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)) return null;
  const target = absolute(value, context.api);
  if (!target || !within(context, context.rootPath, target)) return null;
  // Keep one spelling of the registered root even when Windows reports a
  // different drive/root case. Relative child names retain their actual case.
  const relative = context.api.relative(context.rootPath, target);
  return relative ? context.api.join(context.rootPath, relative) : context.rootPath;
}

/**
 * Resolve one fs.watch notification to a directory that can be enumerated.
 * Windows drive/UNC paths use Windows semantics even in a POSIX test process.
 * Returns null for invalid/outside paths. It never reads the filesystem.
 */
function watchTarget(rootPath, filename, eventType, getNodeByPath = () => null) {
  const context = rootOf(rootPath);
  if (!context) return null;
  if (filename == null || filename === '') return context.rootPath;
  if (Buffer.isBuffer(filename)) filename = filename.toString();
  if (typeof filename !== 'string' || filename.includes('\0')) return null;
  // C:relative is drive-relative, not a safe filename relative to this root.
  if (context.windows && /^[a-z]:/i.test(filename) && !context.api.isAbsolute(filename))
    return null;
  const raw = context.api.isAbsolute(filename)
    ? filename
    : context.api.resolve(context.rootPath, filename);
  const absolutePath = targetOf(context, raw);
  if (!absolutePath) return null;
  if (pathKey(context, absolutePath) === pathKey(context, context.rootPath))
    return context.rootPath;
  let target;
  if (eventType === 'rename') target = context.api.dirname(absolutePath);
  else if (eventType === 'change')
    target =
      getNodeByPath(absolutePath)?.kind === 'folder'
        ? absolutePath
        : context.api.dirname(absolutePath);
  else return null;
  return targetOf(context, target);
}

/**
 * Pure watcher scheduling state. No timers, filesystem calls or SQL are owned
 * here. add() accepts absolute targets; nextDelay() tells the caller when to
 * try take(). An entry is a frozen, single-use snapshot for requeue().
 *
 * Normal debounce is capped by the first event's maxWait. A failed snapshot
 * has an independent notBefore deadline; retries never hold up another root.
 */
function createWatchQueue({ maxPaths = 64, debounce = 350, maxWait = 1500, now = Date.now } = {}) {
  if (!Number.isSafeInteger(maxPaths) || maxPaths < 1)
    throw new RangeError('maxPaths must be a positive safe integer');
  for (const [name, value] of [
    ['debounce', debounce],
    ['maxWait', maxWait]
  ])
    if (!Number.isFinite(value) || value < 0)
      throw new RangeError(`${name} must be a finite nonnegative number`);
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const pending = new Map();
  // Version objects invalidate taken snapshots when a root is removed without
  // retaining a tombstone for every previously removed root ID.
  const versions = new Map();
  const tickets = new WeakMap();
  function clock() {
    const value = now();
    if (!Number.isFinite(value)) throw new TypeError('now() must return a finite number');
    return value;
  }
  const validId = (value) => typeof value === 'string' && value.length > 0 && !value.includes('\0');
  const due = (entry) =>
    Math.max(entry.notBefore, Math.min(entry.lastDirty + debounce, entry.firstDirty + maxWait));
  function collapse(entry, target) {
    for (const existing of entry.targets.values())
      if (within(entry.context, existing, target)) return;
    for (const [key, existing] of entry.targets)
      if (within(entry.context, target, existing)) entry.targets.delete(key);
    entry.targets.set(pathKey(entry.context, target), target);
    if (entry.targets.size > maxPaths) {
      entry.targets.clear();
      entry.targets.set(pathKey(entry.context, entry.rootPath), entry.rootPath);
    }
  }
  function fresh(rootId, context, time) {
    return {
      rootId,
      rootPath: context.rootPath,
      context,
      targets: new Map(),
      firstDirty: time,
      lastDirty: time,
      attempts: 0,
      notBefore: 0
    };
  }
  function compatible(entry, context) {
    return (
      entry.context.windows === context.windows &&
      pathKey(context, entry.rootPath) === pathKey(context, context.rootPath)
    );
  }
  return {
    get size() {
      return pending.size;
    },
    add(rootId, rootPath, target) {
      if (!validId(rootId)) return false;
      const context = rootOf(rootPath);
      if (!context) return false;
      const normalized = targetOf(context, target);
      if (!normalized) return false;
      let entry = pending.get(rootId);
      const version = versions.get(rootId);
      if ((entry && !compatible(entry, context)) || (version && !compatible(version, context)))
        return false;
      const time = clock();
      if (!version) versions.set(rootId, { context, rootPath: context.rootPath });
      if (!entry) {
        entry = fresh(rootId, context, time);
        pending.set(rootId, entry);
      }
      entry.lastDirty = time;
      collapse(entry, targetOf(entry.context, normalized));
      return true;
    },
    nextDelay() {
      if (!pending.size) return null;
      const time = clock();
      let earliest = Infinity;
      for (const entry of pending.values()) earliest = Math.min(earliest, due(entry));
      return Math.max(0, earliest - time);
    },
    take() {
      if (!pending.size) return null;
      const time = clock();
      let selected = null;
      for (const entry of pending.values()) {
        if (due(entry) > time) continue;
        if (!selected || due(entry) < due(selected)) selected = entry;
      }
      if (!selected) return null;
      pending.delete(selected.rootId);
      const snapshot = Object.freeze({
        rootId: selected.rootId,
        rootPath: selected.rootPath,
        targets: Object.freeze([...selected.targets.values()]),
        firstDirty: selected.firstDirty,
        lastDirty: selected.lastDirty,
        attempts: selected.attempts,
        notBefore: selected.notBefore
      });
      tickets.set(snapshot, {
        version: versions.get(snapshot.rootId),
        context: selected.context
      });
      return snapshot;
    },
    requeue(snapshot, { delay } = {}) {
      if (delay !== undefined && (!Number.isFinite(delay) || delay < 0))
        throw new RangeError('retry delay must be a finite nonnegative number');
      const ticket = snapshot && typeof snapshot === 'object' ? tickets.get(snapshot) : null;
      if (!ticket || ticket.version !== versions.get(snapshot.rootId)) return false;
      let entry = pending.get(snapshot.rootId);
      if (entry && !compatible(entry, ticket.context)) return false;
      const time = clock();
      if (!entry) entry = fresh(snapshot.rootId, ticket.context, snapshot.firstDirty);
      const attempts = Math.max(entry.attempts, snapshot.attempts) + 1;
      const backoff = delay ?? Math.min(30000, 500 * 2 ** Math.min(attempts - 1, 6));
      entry.firstDirty = Math.min(entry.firstDirty, snapshot.firstDirty);
      entry.lastDirty = Math.max(entry.lastDirty, snapshot.lastDirty);
      entry.attempts = attempts;
      entry.notBefore = Math.max(entry.notBefore, time + backoff);
      for (const target of snapshot.targets) collapse(entry, targetOf(entry.context, target));
      pending.set(snapshot.rootId, entry);
      tickets.delete(snapshot);
      return true;
    },
    delete(rootId) {
      const removed = pending.delete(rootId);
      versions.delete(rootId);
      return removed;
    },
    clear() {
      pending.clear();
      versions.clear();
    }
  };
}

module.exports = { createWatchQueue, watchTarget };
