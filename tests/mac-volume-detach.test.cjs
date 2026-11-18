'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { detachMacVolume, cleanupMacTestDirectory } = require('../scripts/mac-volume-detach.cjs');

function fixture(results) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const temporary = path.join(temporaryRoot, 'acg-mac-filesystems-fixture');
  const state = { temporaryRoot, temporary, activeMount: path.join(temporary, 'APFSX-volume') };
  const calls = [];
  const waits = [];
  const logs = [];
  const removals = [];
  const options = {
    execute(command, args, configuration) {
      calls.push({ command, args, configuration });
      assert.ok(results.length, 'Detach must not exceed the supplied attempts');
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    log: (message) => {
      logs.push(message);
    },
    remove: async (...args) => {
      removals.push(args);
    }
  };
  return { state, calls, waits, logs, removals, options };
}

async function detachAndClean(data, pendingError) {
  let failure;
  try {
    const result = await detachMacVolume(data.state.activeMount, { ...data.options, pendingError });
    data.state.activeMount = null; // Same success-only transition as the filesystem checker.
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanupMacTestDirectory(data.state, failure, data.options);
  }
}
const busy = (stderr = 'hdiutil: detach failed - Resource busy\n') => ({
  status: 16,
  signal: null,
  stderr,
  stdout: ''
});
const success = { status: 0, signal: null, stderr: '', stdout: 'disk detached\n' };

test('explicit transient busy retries the same mount at most three times, then permits cleanup', async () => {
  const data = fixture([busy(), busy('hdiutil: 卷忙\n'), success]);
  const mount = data.state.activeMount;
  const result = await detachAndClean(data);
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(data.waits, [500, 1000]);
  for (const call of data.calls) {
    assert.equal(call.command, 'hdiutil');
    assert.deepEqual(call.args, ['detach', mount]);
    assert.equal(call.configuration.timeout, 10_000);
    assert.equal(call.configuration.shell, undefined);
  }
  assert.equal(data.state.activeMount, null);
  assert.deepEqual(data.removals, [[data.state.temporary, { recursive: true }]]);
  assert.equal(data.logs.length, 2);
  assert.equal(JSON.parse(data.logs[0]).stderr, 'hdiutil: detach failed - Resource busy\n');
});

test('busy exhaustion preserves the active volume and final raw detach failure through outer cleanup', async () => {
  const data = fixture([busy(), busy(), busy('hdiutil: detach failed - Resource busy (final)\n')]);
  const mount = data.state.activeMount;
  let original;
  await assert.rejects(detachAndClean(data), (error) => {
    original = error;
    assert.equal(error.status, 16);
    assert.equal(error.signal, null);
    assert.equal(error.stderr, 'hdiutil: detach failed - Resource busy (final)\n');
    assert.deepEqual(error.args, ['detach', mount]);
    return true;
  });
  assert.equal(data.calls.length, 3);
  assert.deepEqual(data.waits, [500, 1000]);
  assert.equal(data.state.activeMount, mount);
  assert.deepEqual(data.removals, []);
  const attempts = data.logs.slice(0, 3).map((line) => JSON.parse(line));
  assert.deepEqual(
    attempts.map(({ status, signal }) => [status, signal]),
    [
      [16, null],
      [16, null],
      [16, null]
    ]
  );
  await cleanupMacTestDirectory(data.state, original, data.options);
  assert.deepEqual(data.removals, []);
});

test('non-busy detach failure is printed and rejected without retry or mounted-directory removal', async () => {
  const stderr = 'hdiutil: detach failed - No such file or directory\n';
  const data = fixture([{ status: 1, signal: null, stderr, stdout: 'original stdout\n' }]);
  await assert.rejects(
    detachAndClean(data),
    (error) => error.stderr === stderr && error.status === 1 && error.stdout === 'original stdout\n'
  );
  assert.equal(data.calls.length, 1);
  assert.deepEqual(data.waits, []);
  assert.deepEqual(data.removals, []);
  const diagnostic = JSON.parse(data.logs[0]);
  assert.equal(diagnostic.stderr, stderr);
  assert.equal(diagnostic.status, 1);
  assert.equal(diagnostic.signal, null);
});

test('spawn errors, signals and unknown process results never retry even if stderr says busy', async () => {
  const timeout = Object.assign(new Error('spawnSync hdiutil ETIMEDOUT'), { code: 'ETIMEDOUT' });
  const thrown = new Error('original unknown spawn failure');
  for (const result of [
    { ...busy(), error: timeout },
    { ...busy(), status: null, signal: 'SIGTERM' },
    { ...busy(), status: null },
    { ...busy(), status: 0, signal: 'SIGTERM' },
    { ...busy(), signal: undefined },
    undefined,
    thrown
  ]) {
    const data = fixture([result]);
    await assert.rejects(detachAndClean(data), (error) => {
      if (result?.error) assert.equal(error, timeout);
      if (result === thrown) assert.equal(error, thrown);
      return true;
    });
    assert.equal(data.calls.length, 1);
    assert.deepEqual(data.waits, []);
    assert.deepEqual(data.removals, []);
    assert.ok(data.state.activeMount);
  }
});

test('work failure plus detach failure retains both original references and preserves the volume', async () => {
  const work = new Error('original filesystem or inspection failure');
  const detach = Object.assign(new Error('original hdiutil spawn error'), { code: 'UNKNOWN' });
  const data = fixture([
    { error: detach, status: null, signal: null, stderr: 'raw unknown stderr\n' }
  ]);
  await assert.rejects(detachAndClean(data, work), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [work, detach]);
    assert.equal(error.cause, work);
    return true;
  });
  assert.equal(data.calls.length, 1);
  assert.deepEqual(data.removals, []);
  assert.equal(JSON.parse(data.logs[0]).stderr, 'raw unknown stderr\n');
});

test('cleanup refuses any still-active mount and never overwrites an existing original error', async () => {
  const data = fixture([]);
  await assert.rejects(
    cleanupMacTestDirectory(data.state, undefined, data.options),
    /requires detach before cleanup/
  );
  assert.deepEqual(data.removals, []);
  const original = new Error('original detach failure');
  await assert.rejects(
    (async () => {
      try {
        throw original;
      } finally {
        await cleanupMacTestDirectory(data.state, original, data.options);
      }
    })(),
    (error) => error === original
  );
  assert.deepEqual(data.removals, []);
  data.state.activeMount = null;
  await assert.rejects(
    (async () => {
      try {
        throw original;
      } finally {
        await cleanupMacTestDirectory(data.state, original, {
          ...data.options,
          remove: async () => {
            throw new Error('secondary cleanup failure');
          }
        });
      }
    })(),
    (error) => error === original
  );
});
