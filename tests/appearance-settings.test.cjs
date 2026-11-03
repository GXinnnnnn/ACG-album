'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');
const appearance = require('../src/appearance-settings.cjs');
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

test('responsive preset interpolation clamps CSS widths and leaves saved density normalization unchanged', () => {
  for (const [width, expected] of [
    [800, [120, 155, 191]],
    [1920, [120, 155, 191]],
    [2240, [122, 153, 190]],
    [2559, [124, 150, 188]],
    [2560, [124, 150, 188]],
    [2561, [124, 150, 188]],
    [2880, [127, 154, 189]],
    [3200, [130, 158, 190]],
    [3839, [135, 165, 192]],
    [3840, [135, 165, 192]],
    [5120, [135, 165, 192]],
    [0, [135, 165, 192]],
    [NaN, [135, 165, 192]]
  ]) {
    const presets = appearance.cardPresets(width);
    assert.deepEqual(presets, expected);
    assert.ok(presets.every((value) => appearance.valid('density', value)));
  }
  for (const density of [120, 124, 135, 150, 155, 165, 166, 188, 191, 192, 195, 222, 267.5, 360])
    assert.equal(appearance.normalize({ density }).density, density);
  assert.equal(
    appearance.defaults.density,
    166,
    'No migration guesses from a previous default number'
  );
});

test('density remains unconfigured until explicitly saved, and every numeric choice survives a worker restart', async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-density-state-'));
  let client;
  t.after(async () => {
    if (client) await client.close();
    assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(data).startsWith('acg-density-state-'));
    await fs.rm(data, { recursive: true, force: true });
  });
  client = await open(data);
  for (const args of [{ lightweight: true }, {}]) {
    const settings = (await client.call('init', args)).settings;
    assert.equal(settings.density, 166);
    assert.equal(
      settings.densityConfigured,
      false,
      'reading defaults must not create an explicit density row'
    );
  }
  await client.close();
  client = await open(data);
  assert.equal(
    (await client.call('init', { lightweight: true })).settings.densityConfigured,
    false
  );
  // Cover the previous fixed default, every responsive medium, a preset and a
  // custom continuous width. An explicitly saved 166 must never be guessed away.
  for (const density of [166, 155, 150, 165, 191, 222, 267.5]) {
    await client.call('settings', { key: 'density', value: density });
    await client.close();
    client = await open(data);
    for (const args of [{ lightweight: true }, {}]) {
      const settings = (await client.call('init', args)).settings;
      assert.equal(settings.density, density);
      assert.equal(settings.densityConfigured, true);
    }
  }
});

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
