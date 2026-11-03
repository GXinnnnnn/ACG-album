'use strict';

(() => {
  const sorts = new Set(['name', 'date', 'modified', 'size', 'contentDate']);
  const views = new Set(['library', 'favorites', 'pending', 'timeline']);
  const defaultPair = (view) =>
    view === 'timeline'
      ? { sort: 'contentDate', direction: 'desc' }
      : { sort: 'name', direction: 'asc' };
  function normalizePath(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
      return undefined;
    const input = value.replace(/\//g, '\\').toLowerCase();
    let prefix, rest;
    const drive = input.match(/^(?:\\\\\?\\)?[a-z]:\\/);
    if (drive) {
      prefix = drive[0];
      rest = input.slice(prefix.length);
    } else {
      const share = input.match(/^\\\\(?:\?\\unc\\)?[^\\]+\\[^\\]+(?:\\|$)/);
      if (!share) return undefined;
      prefix = share[0].replace(/\\+$/, '');
      rest = input.slice(share[0].length);
    }
    const parts = [];
    for (const part of rest.split(/\\+/)) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return prefix + (parts.length ? (prefix.endsWith('\\') ? '' : '\\') + parts.join('\\') : '');
  }
  function scope(view, path) {
    if (arguments.length < 2) path = null;
    if (!views.has(view)) return null;
    const normalized = normalizePath(path);
    if (normalized === undefined) return null;
    const key = JSON.stringify([view, normalized]);
    return key.length <= 8192 ? key : null;
  }
  function validPair(value) {
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
    const proto = Object.getPrototypeOf(value);
    return (
      (!proto || Object.getPrototypeOf(proto) === null) &&
      Object.keys(value).length === 2 &&
      Object.hasOwn(value, 'sort') &&
      Object.hasOwn(value, 'direction') &&
      sorts.has(value.sort) &&
      (value.direction === 'asc' || value.direction === 'desc')
    );
  }
  function validKey(key) {
    if (typeof key !== 'string' || key.length > 8192) return false;
    try {
      const parsed = JSON.parse(key);
      return Array.isArray(parsed) && parsed.length === 2 && scope(...parsed) === key;
    } catch {
      return false;
    }
  }
  function applyOperation(map, operation) {
    if (operation.kind === 'set') {
      map.delete(operation.key);
      map.set(operation.key, { ...operation.pair });
      return;
    }
    for (const rename of operation.renames) {
      const moved = [];
      for (const [key, pair] of map) {
        const [view, path] = JSON.parse(key),
          oldPath = rename.oldPath,
          nextPath = rename.path;
        if (
          path &&
          (path === oldPath || path.startsWith(oldPath.endsWith('\\') ? oldPath : oldPath + '\\'))
        ) {
          const tail = path.slice(oldPath.length).replace(/^\\/, '');
          const next = scope(
            view,
            nextPath + (tail ? (nextPath.endsWith('\\') ? '' : '\\') + tail : '')
          );
          if (next) {
            map.delete(key);
            moved.push([next, pair]);
          }
        }
      }
      for (const [key, pair] of moved) {
        map.delete(key);
        map.set(key, pair);
      }
    }
  }
  function create({ save, onError = () => {}, requireHydration = false } = {}) {
    let entries = new Map(),
      revision = 0,
      dirty = false,
      writing = null,
      ready = !requireHydration,
      readId = 0,
      lastHydrated = 0;
    const reads = new Set(),
      pendingOperations = [];
    const snapshot = () =>
      Object.fromEntries([...entries].map(([key, value]) => [key, { ...value }]));
    const clip = () => {
      while (entries.size > 1024) entries.delete(entries.keys().next().value);
    };
    function persist() {
      if (!ready || !dirty || writing) return writing;
      let failed = false;
      writing = Promise.resolve()
        .then(async () => {
          while (dirty) {
            const count = pendingOperations.length,
              value = snapshot();
            dirty = false;
            try {
              await save(value);
              pendingOperations.splice(0, count);
            } catch (error) {
              failed = true;
              dirty = true;
              onError(error);
              throw error;
            }
          }
        })
        .finally(() => {
          writing = null;
          if (dirty && !failed) persist();
        });
      // Automatic event-driven writes report through onError; explicit flush still rejects.
      void writing.catch(() => {});
      return writing;
    }
    function record(operation) {
      pendingOperations.push(operation);
      for (const token of reads) token.operations.push(operation);
      applyOperation(entries, operation);
      clip();
      revision++;
      dirty = true;
      persist();
    }
    return {
      beginRead() {
        const token = { id: ++readId, operations: pendingOperations.slice() };
        reads.add(token);
        return token;
      },
      cancelRead(token) {
        reads.delete(token);
      },
      hydrate(value, token) {
        if (!reads.delete(token) || token.id < lastHydrated) return false;
        lastHydrated = token.id;
        const incoming = new Map();
        if (value && Object.prototype.toString.call(value) === '[object Object]')
          for (const [key, pair] of Object.entries(value))
            if (validKey(key) && validPair(pair)) incoming.set(key, { ...pair });
        for (const operation of token.operations) applyOperation(incoming, operation);
        entries = incoming;
        clip();
        ready = true;
        if (token.operations.length) dirty = true;
        persist();
        return true;
      },
      get(view, path = null) {
        const key = scope(view, path),
          value = entries.get(key);
        if (value) {
          entries.delete(key);
          entries.set(key, value);
        }
        return { ...(value || defaultPair(view)) };
      },
      set(view, path, pair) {
        const key = scope(view, path);
        if (!key || !validPair(pair)) return false;
        const previous = entries.get(key) || defaultPair(view);
        if (previous.sort === pair.sort && previous.direction === pair.direction) {
          persist();
          return false;
        }
        record({ kind: 'set', key, pair: { ...pair } });
        return true;
      },
      rename(renames) {
        const normalized = renames
          .map((rename) => ({
            oldPath: normalizePath(rename.oldPath),
            path: normalizePath(rename.path)
          }))
          .filter((rename) => rename.oldPath && rename.path && rename.oldPath !== rename.path);
        if (!normalized.length) return false;
        const operation = { kind: 'rename', renames: normalized },
          probe = new Map(entries);
        applyOperation(probe, operation);
        const changed = JSON.stringify([...probe]) !== JSON.stringify([...entries]);
        if (changed || !ready || reads.size) {
          record(operation);
          return true;
        }
        persist();
        return false;
      },
      snapshot,
      async flush() {
        if (!ready) return;
        do {
          const task = persist();
          if (task) await task;
        } while (dirty || writing);
      },
      get revision() {
        return revision;
      }
    };
  }
  window.albumBrowseSort = { create, scope, normalizePath, validPair };
})();
