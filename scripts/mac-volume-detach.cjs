'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { setTimeout } = require('node:timers/promises');

// Only explicit hdiutil Resource busy / localized volume-busy diagnostics justify a retry.
const busyDiagnostic = /\bResource busy\b|(?:卷|资源)(?:正)?忙/i;
const retryDelays = Object.freeze([500, 1000]);

async function detachMacVolume(mount, options = {}) {
  assert.ok(typeof mount === 'string' && path.isAbsolute(mount), 'Expected owned absolute mount');
  const { execute = spawnSync, wait = setTimeout, log = console.error, pendingError } = options;
  const attempts = [];
  let failure;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    let result;
    try {
      result = execute('hdiutil', ['detach', mount], {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      result = { error, status: null, signal: null };
    }
    const { status, signal, error } = result || {};
    const stderr = String(result?.stderr || '');
    const stdout = String(result?.stdout || '');
    const record = {
      attempt: attempt + 1,
      status: status === undefined ? 'UNKNOWN' : status,
      signal: signal === undefined ? 'UNKNOWN' : signal,
      stderr,
      stdout
    };
    attempts.push(record);
    if (!error && status === 0 && signal === null) return { mount, attempts };
    failure =
      error ||
      Object.assign(
        new Error(`hdiutil detach failed: status=${status}, signal=${signal}: ${stderr || stdout}`),
        { command: 'hdiutil', args: ['detach', mount], status, signal, stderr, stdout }
      );
    // Print raw diagnostics before either retrying or propagating. No finally guard may hide them.
    log(
      JSON.stringify({
        command: 'hdiutil',
        args: ['detach', mount],
        ...record,
        ...(error
          ? { error: { message: error.message, code: error.code, stack: error.stack } }
          : {})
      })
    );
    const retryable =
      !error &&
      signal === null &&
      Number.isInteger(status) &&
      status > 0 &&
      busyDiagnostic.test(stderr);
    if (!retryable || attempt === retryDelays.length) break;
    await wait(retryDelays[attempt]);
  }
  if (pendingError)
    throw new AggregateError([pendingError, failure], 'macOS work and volume detach both failed', {
      cause: pendingError
    });
  throw failure;
}

async function cleanupMacTestDirectory(state, pendingError, options = {}) {
  const { remove = fsp.rm, log = console.error } = options;
  const { temporary, temporaryRoot, activeMount } = state;
  if (activeMount) {
    const message =
      'Temporary macOS test mount requires detach before cleanup; preserving owned volume: ' +
      activeMount;
    log(message);
    if (pendingError) return; // The caller's existing throw continues unchanged through its finally.
    throw new Error(message);
  }
  try {
    // Only this invocation's fresh, detached disk images and helper test payload.
    assert.equal(path.dirname(temporary), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('acg-mac-filesystems-'));
    await remove(temporary, { recursive: true });
  } catch (error) {
    if (!pendingError) throw error;
    log('macOS temporary cleanup also failed; retaining original error: ' + (error.stack || error));
  }
}

module.exports = { detachMacVolume, cleanupMacTestDirectory };
