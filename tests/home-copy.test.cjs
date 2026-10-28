'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { HOME_COPY_DEFAULTS, normalizeHomeCopy } = require('../src/home-copy.cjs');

test('homepage copy validates single-line plain text, resets blank fields and bounds each field', () => {
  assert.deepEqual(normalizeHomeCopy({}), HOME_COPY_DEFAULTS);
  assert.equal(normalizeHomeCopy({ title: '  私藏相册  ' }).title, '私藏相册');
  assert.equal(normalizeHomeCopy({ title: '' }).title, HOME_COPY_DEFAULTS.title);
  assert.equal(
    normalizeHomeCopy({ title: '<img src=x onerror=alert(1)>' }).title,
    '<img src=x onerror=alert(1)>'
  );
  for (const value of [
    null,
    [],
    '',
    { other: 'bad' },
    { title: 1 },
    { title: 'x'.repeat(81) },
    { title: 'a\nb' },
    { description: '\0' },
    { eyebrow: 'x'.repeat(121) }
  ])
    assert.throws(() => normalizeHomeCopy(value), /文案/);
});

async function open(dataDir) {
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  let sequence = 0;
  const pending = new Map();
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      const request = pending.get(message.request);
      if (!request) return;
      pending.delete(message.request);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++sequence;
      pending.set(request, { resolve, reject });
      worker.postMessage({ request, method, args });
    });
  return {
    call,
    close: async () => {
      await call('shutdown');
      await worker.terminate();
    }
  };
}

test('real worker saves homepage copy across restart and rejects malformed writes without changing saved text', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-home-copy-'));
  let client;
  t.after(async () => {
    if (client) await client.close();
    assert.ok(path.isAbsolute(data) && path.basename(data).startsWith('acg-home-copy-'));
    await fs.rm(data, { recursive: true, force: true });
  });
  client = await open(data);
  const original = (await client.call('init')).settings;
  assert.deepEqual(original.homeCopy, HOME_COPY_DEFAULTS);
  const saved = {
    eyebrow: 'MY COLLECTION',
    title: '我的珍藏',
    description: '每一帧，都值得留下。'
  };
  assert.deepEqual(await client.call('settings', { key: 'homeCopy', value: saved }), saved);
  await assert.rejects(
    client.call('settings', { key: 'homeCopy', value: { title: 'x'.repeat(81) } }),
    /文案/
  );
  assert.deepEqual((await client.call('init')).settings.homeCopy, saved);
  await client.close();
  client = null;
  client = await open(data);
  const restored = (await client.call('init')).settings;
  assert.deepEqual(restored.homeCopy, saved);
  assert.equal(restored.nickname, original.nickname);
  assert.equal(restored.fontFamily, original.fontFamily);
});
