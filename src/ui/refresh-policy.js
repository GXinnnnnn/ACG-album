'use strict';
// Heartbeats keep progress responsive without reloading an unchanged library.
// Root/active transitions are important even when a worker revision is unchanged.
function createScanRefreshGate() {
  let previous = null;
  return (data = {}) => {
    const current = {
      root: data.root || '',
      revision: data.revision ?? null,
      active: data.active === true
    };
    const changed =
      current.active || previous?.active
        ? !previous ||
          current.root !== previous.root ||
          current.revision !== previous.revision ||
          current.active !== previous.active
        : false;
    previous = current;
    return changed;
  };
}

// Bound how long a partial batch waits while later network resources are slow.
// The timer starts at the first change and is not postponed by repeated changes.
function createMatchRefreshBatch(refresh, size = 10, maxWait = 250) {
  const pending = new Set();
  let timer = null,
    disposed = false;
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function flush() {
    clearTimer();
    if (disposed || !pending.size) return false;
    pending.clear();
    refresh();
    return true;
  }
  return {
    changed(id) {
      if (disposed || !id) return false;
      pending.add(id);
      if (pending.size >= size) return flush();
      if (timer === null) timer = setTimeout(flush, maxWait);
      return false;
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      pending.clear();
    },
    get pending() {
      return pending.size;
    }
  };
}
