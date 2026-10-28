'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
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

test('glass starts enabled and motion starts high; saved choices and local font survive restart', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-appearance-'));
  let client;
  t.after(async () => {
    if (client) await client.close();
    assert.ok(path.basename(data).startsWith('acg-appearance-'));
    await fs.rm(data, { recursive: true, force: true });
  });
  client = await open(data);
  let settings = (await client.call('init')).settings;
  assert.equal(settings.liquidGlass, true);
  assert.equal(settings.motionLevel, 'high');
  assert.equal(settings.fontFamily, '');
  for (const value of [null, 4, 'bad\nfont', 'x'.repeat(161)])
    await assert.rejects(client.call('settings', { key: 'fontFamily', value }), /字体名称/);
  await client.call('settings', { key: 'fontFamily', value: '  Microsoft YaHei UI  ' });
  for (const value of [0, 1, 'true', null])
    await assert.rejects(client.call('settings', { key: 'liquidGlass', value }), /布尔值/);
  for (const value of ['full', '', null, 1])
    await assert.rejects(client.call('settings', { key: 'motionLevel', value }), /动效强度/);
  await client.call('settings', { key: 'liquidGlass', value: false });
  await client.call('settings', { key: 'motionLevel', value: 'high' });
  await client.close();
  client = null;
  client = await open(data);
  settings = (await client.call('init')).settings;
  assert.equal(settings.liquidGlass, false);
  assert.equal(settings.motionLevel, 'high');
  assert.equal(settings.fontFamily, 'Microsoft YaHei UI');
  await client.call('settings', { key: 'fontFamily', value: '' });
  assert.equal((await client.call('init')).settings.fontFamily, '');
  await client.call('settings', { key: 'motionLevel', value: 'low' });
  assert.equal((await client.call('init')).settings.motionLevel, 'low');
});
