'use strict';
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
