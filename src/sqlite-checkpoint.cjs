'use strict';
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

// Checkpoint I/O belongs on a separate connection/thread. PASSIVE never waits
// for a reader or takes the writer lock; FULL still syncs every writer commit.
if (!isMainThread && workerData?.sqliteCheckpoint) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(workerData.filename);
  db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=0');
  parentPort.on('message', async ({ action }) => {
    try {
      if (action === 'close') {
        db.close();
        parentPort.postMessage({ result: true });
        parentPort.close();
        return;
      }
      const deadline = Date.now() + 4000;
      let result;
      do {
        result = { ...db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() };
        if (result.busy === 0 && result.log >= 0 && result.checkpointed === result.log) {
          parentPort.postMessage({ result });
          return;
        }
        // A long-lived external reader can pin WAL frames. Do not accept more
        // dirty batches indefinitely when maintenance cannot catch up.
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      const error = new Error('SQLite checkpoint could not drain WAL (reader or writer busy).');
      error.code = 'SQLITE_CHECKPOINT_BUSY';
      throw error;
    } catch (error) {
      parentPort.postMessage({ error: { message: error.message, code: error.code } });
    }
  });
} else {
  function createSqliteCheckpoint(
    filename,
    { createWorker = (file, options) => new Worker(file, options), timeoutMs = 30000 } = {}
  ) {
    let worker,
      pending,
      failure,
      closing = false,
      closeTask;
    function fail(error) {
      failure ||= error;
      pending?.reject(failure);
    }
    function request(action) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const error = new Error('SQLite checkpoint worker timed out.');
          error.code = 'SQLITE_CHECKPOINT_TIMEOUT';
          fail(error);
          void worker.terminate();
        }, timeoutMs);
        const settle = (fn, value) => {
          clearTimeout(timer);
          pending = undefined;
          fn(value);
        };
        pending = {
          resolve: (value) => settle(resolve, value),
          reject: (error) => settle(reject, error)
        };
        try {
          worker.postMessage({ action });
        } catch (error) {
          fail(error);
        }
      });
    }
    let checkpointTask;
    return {
      checkpoint() {
        if (closing) return Promise.reject(new Error('SQLite checkpoint maintenance is closed.'));
        if (failure) return Promise.reject(failure);
        // All simultaneous consumers wait for the same task; there is no queue.
        if (checkpointTask) return checkpointTask;
        if (!worker) {
          try {
            worker = createWorker(__filename, { workerData: { sqliteCheckpoint: true, filename } });
            worker.on('message', ({ result, error }) => {
              if (error) {
                const cause = new Error(error.message);
                cause.code = error.code;
                pending?.reject(cause);
              } else pending?.resolve(result);
            });
            worker.on('error', fail);
            worker.on('exit', (code) => {
              if (!closing || pending)
                fail(new Error(`SQLite checkpoint worker exited (${code}).`));
            });
          } catch (error) {
            fail(error);
            return Promise.reject(error);
          }
        }
        checkpointTask = request('checkpoint').finally(() => {
          checkpointTask = undefined;
        });
        return checkpointTask;
      },
      close() {
        if (closeTask) return closeTask;
        closing = true;
        closeTask = (async () => {
          let error;
          try {
            await checkpointTask;
          } catch (cause) {
            error = cause;
          }
          try {
            if (worker && !failure) await request('close');
          } catch (cause) {
            error ||= cause;
          } finally {
            if (worker) await worker.terminate();
          }
          if (error || failure) throw error || failure;
        })();
        return closeTask;
      }
    };
  }
  module.exports = { createSqliteCheckpoint };
}
