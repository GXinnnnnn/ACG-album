'use strict';
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const DEFAULTS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxPixels: 40000000,
  maxOutputBytes: 160 * 1024 * 1024,
  maxQueue: 2,
  timeoutMs: 15000
});
function failure(code, message) {
  return Object.assign(new Error(message), { code });
}
function integer(value, fallback, name, minimum = 1) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new TypeError(`HEIF ${name} must be a safe integer >= ${minimum}`);
  return value;
}
function codecPath(directory) {
  if (directory !== undefined) {
    if (typeof directory !== 'string' || !directory || /^[a-z]+:\/\//i.test(directory))
      throw new TypeError('HEIF codecDirectory must be a local directory');
    return path.resolve(directory);
  }
  return /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/i.test(__dirname)
    ? path.resolve(__dirname, '../../codecs/libheif')
    : path.join(__dirname, 'vendor/libheif');
}

// One separately scheduled decoder, created on the first accepted job. Never transfer
// caller-owned memory (including pooled Buffers), and never execute WASM on the RPC thread.
function createHeifDecoder(options = {}) {
  const config = {};
  for (const key of Object.keys(DEFAULTS)) {
    const ceiling = key === 'timeoutMs' ? 120000 : key === 'maxQueue' ? 16 : DEFAULTS[key];
    config[key] = Math.min(
      ceiling,
      integer(options[key], DEFAULTS[key], key, key === 'maxQueue' ? 0 : 1)
    );
  }
  if (options.maxBytes !== undefined)
    config.maxInputBytes = Math.min(
      config.maxInputBytes,
      integer(options.maxBytes, config.maxInputBytes, 'maxBytes')
    );
  config.codecDirectory = codecPath(options.codecDirectory);
  const queue = [],
    waiters = [];
  let worker,
    active,
    retiring,
    stopped = false,
    sequence = 0;
  function notifyIdle() {
    if (!active && !queue.length && !retiring) for (const resolve of waiters.splice(0)) resolve();
  }
  function settle(job, error, result) {
    clearTimeout(job.timer);
    job.bytes = null;
    if (error) job.reject(error);
    else job.resolve(result);
  }
  function retire(target) {
    if (!target || target !== worker) return;
    worker = null;
    // Await termination before spawning another large WASM heap.
    retiring = target
      .terminate()
      .catch(() => {})
      .finally(() => {
        retiring = null;
        pump();
        notifyIdle();
      });
  }
  function crash(target, error) {
    if (target !== worker) return;
    if (active) {
      const job = active;
      active = null;
      settle(job, error);
    }
    retire(target);
  }
  function start() {
    const target = new Worker(path.join(__dirname, 'heif-worker.cjs'), {
      workerData: { codecDirectory: config.codecDirectory },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 }
    });
    worker = target;
    target.on('error', (error) =>
      crash(target, failure('HEIF_WORKER', `HEIF worker failed: ${error.message}`))
    );
    target.on('exit', (code) =>
      crash(target, failure('HEIF_WORKER', `HEIF worker exited (${code})`))
    );
    target.on('message', (message) => {
      if (target !== worker || !active || message?.id !== active.id) return;
      const job = active;
      if (message.error) {
        active = null;
        settle(
          job,
          failure(
            message.error.code || 'HEIF_DECODE',
            String(message.error.message || 'HEIF decoding failed')
          )
        );
      } else {
        const { width, height, channels, data } = message;
        const pixels = width * height;
        if (
          !Number.isSafeInteger(width) ||
          width <= 0 ||
          !Number.isSafeInteger(height) ||
          height <= 0 ||
          !Number.isSafeInteger(pixels) ||
          pixels > job.limits.maxPixels ||
          channels !== 4 ||
          !(data instanceof Uint8Array) ||
          data.byteLength !== pixels * 4 ||
          data.byteLength > job.limits.maxOutputBytes
        ) {
          crash(
            target,
            failure('HEIF_OUTPUT', 'HEIF worker returned invalid RGBA dimensions or bytes')
          );
          return;
        }
        active = null;
        settle(job, null, {
          data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
          width,
          height,
          channels: 4
        });
      }
      if (!queue.length) target.unref();
      pump();
      notifyIdle();
    });
    return target;
  }
  function pump() {
    if (stopped || active || retiring || !queue.length) return;
    const job = queue.shift();
    active = job;
    try {
      const target = worker || start();
      target.ref();
      target.postMessage({ id: job.id, bytes: job.bytes, limits: job.limits }, [job.bytes.buffer]);
      job.bytes = null;
    } catch (error) {
      active = null;
      settle(job, failure('HEIF_WORKER', `HEIF worker could not start: ${error.message}`));
      if (worker) retire(worker);
      else {
        pump();
        notifyIdle();
      }
    }
  }
  function decode(buffer, limits = {}) {
    try {
      if (stopped) throw failure('HEIF_STOPPED', 'HEIF decoder has stopped');
      if (!(buffer instanceof Uint8Array) || !buffer.byteLength)
        throw failure('HEIF_INPUT', 'HEIF input must be a nonempty Buffer or Uint8Array');
      const bounded = {};
      for (const key of ['maxInputBytes', 'maxPixels', 'maxOutputBytes', 'timeoutMs'])
        bounded[key] = Math.min(config[key], integer(limits[key], config[key], key));
      if (limits.maxBytes !== undefined)
        bounded.maxInputBytes = Math.min(
          bounded.maxInputBytes,
          integer(limits.maxBytes, bounded.maxInputBytes, 'maxBytes')
        );
      if (buffer.byteLength > bounded.maxInputBytes)
        throw failure('HEIF_INPUT_LIMIT', 'HEIF input exceeds the configured byte limit');
      if ((active || retiring) && queue.length >= config.maxQueue)
        throw failure('HEIF_BUSY', 'HEIF decoder queue is full');
      const bytes = new Uint8Array(buffer.byteLength);
      bytes.set(buffer);
      return new Promise((resolve, reject) => {
        const job = { id: ++sequence, bytes, limits: bounded, resolve, reject };
        job.timer = setTimeout(() => {
          if (active === job) {
            active = null;
            settle(job, failure('HEIF_TIMEOUT', 'HEIF decoding timed out'));
            retire(worker);
          } else {
            const index = queue.indexOf(job);
            if (index < 0) return;
            queue.splice(index, 1);
            settle(job, failure('HEIF_TIMEOUT', 'HEIF decoding timed out while queued'));
            notifyIdle();
          }
        }, bounded.timeoutMs);
        queue.push(job);
        pump();
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return {
    decode,
    idle() {
      return !active && !queue.length && !retiring
        ? Promise.resolve()
        : new Promise((resolve) => waiters.push(resolve));
    },
    async stop() {
      stopped = true;
      if (active) {
        settle(active, failure('HEIF_STOPPED', 'HEIF decoder has stopped'));
        active = null;
      }
      for (const job of queue.splice(0))
        settle(job, failure('HEIF_STOPPED', 'HEIF decoder has stopped'));
      if (worker) retire(worker);
      if (retiring) await retiring;
      notifyIdle();
    }
  };
}
module.exports = { createHeifDecoder };
