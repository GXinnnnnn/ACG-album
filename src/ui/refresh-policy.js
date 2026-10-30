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

// Background matches update the browser in batches; the worker's final status
// flushes the remainder. Manual edits use their existing immediate update path.
function createMatchRefreshBatch(refresh, size = 10) {
  const pending = new Set();
  function flush() {
    if (!pending.size) return false;
    pending.clear();
    refresh();
    return true;
  }
  return {
    changed(id) {
      if (id) pending.add(id);
      return pending.size >= size ? flush() : false;
    },
    flush,
    get pending() {
      return pending.size;
    }
  };
}
