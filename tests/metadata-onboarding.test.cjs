'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { Worker } = require('node:worker_threads');

async function renderer({
  saved = false,
  roots = [],
  seen = false,
  modalOpen = false,
  failSave = false,
  hidePanel = false
} = {}) {
  const source = await fs.readFile(path.resolve(__dirname, '../src/ui/app.js'), 'utf8');
  const start = source.indexOf('async function showMetadataOnboarding()');
  const end = source.indexOf('\nconst V =', start);
  assert.ok(start >= 0 && end > start);
  const calls = [],
    panel = { hidden: hidePanel, scrollTop: 0, scrollHeight: 1200 },
    modal = { open: modalOpen },
    input = {
      focus(options) {
        calls.push(['focus', options.preventScroll]);
      }
    },
    state = { settings: { metadataOnboardingSeen: seen }, roots };
  const context = vm.createContext({
    S: state,
    $: (selector) =>
      ({ '#modal': modal, '#settings-panel-metadata': panel, '#token-input': input })[selector],
    async api(method, args) {
      calls.push([method, args]);
      if (method === 'tokenStatus') return { saved };
      assert.equal(
        method,
        'settings',
        'onboarding must never save credentials or change the library'
      );
      assert.equal(args.key, 'metadataOnboardingSeen');
      assert.equal(args.value, true);
      if (failSave) throw new Error('fixture save failed');
      return true;
    },
    async settingsModal(tab) {
      calls.push(['settingsModal', tab]);
      modal.open = true;
    }
  });
  new vm.Script(source.slice(start, end)).runInContext(context);
  return { run: () => context.showMetadataOnboarding(), calls, panel, state };
}

test('fresh profile opens metadata only once and focuses the token at the bottom after persisting the marker', async () => {
  const h = await renderer();
  assert.equal(await h.run(), true);
  assert.deepEqual(
    h.calls.map(([name]) => name),
    ['tokenStatus', 'settings', 'settingsModal', 'focus']
  );
  assert.equal(h.calls[2][1], 'metadata');
  assert.equal(h.calls[3][1], true, 'focus must not first jump the surrounding dialog');
  assert.equal(h.panel.scrollTop, h.panel.scrollHeight);
  assert.equal(h.state.settings.metadataOnboardingSeen, true);
  assert.equal(await h.run(), false);
  assert.equal(
    h.calls.length,
    4,
    'a later startup with the marker does not query credentials or reopen settings'
  );
});

for (const options of [
  { saved: true },
  { roots: [{ id: 'existing-root' }] },
  { seen: true },
  { modalOpen: true }
]) {
  test(`established setup or user-opened dialog skips automatic guidance: ${Object.keys(options)[0]}`, async () => {
    const h = await renderer(options);
    assert.equal(await h.run(), false);
    assert.equal(
      h.calls.some(([name]) => name === 'settingsModal'),
      false
    );
    assert.equal(h.panel.scrollTop, 0);
    assert.equal(h.state.settings.metadataOnboardingSeen, true);
  });
}

test('failed marker persistence does not show an every-launch guide; hidden metadata is never focused', async () => {
  const failed = await renderer({ failSave: true });
  await assert.rejects(failed.run(), /fixture save failed/);
  assert.equal(
    failed.calls.some(([name]) => name === 'settingsModal'),
    false
  );
  assert.equal(failed.state.settings.metadataOnboardingSeen, false);
  const hidden = await renderer({ hidePanel: true });
  assert.equal(await hidden.run(), false);
  assert.equal(
    hidden.calls.some(([name]) => name === 'focus'),
    false
  );
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
    async close() {
      await call('shutdown');
      await worker.terminate();
    }
  };
}

test('onboarding marker survives worker restart without resetting existing roots, settings or encrypted token storage', async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-onboarding-'));
  const dataDir = path.join(temporary, 'data'),
    sourceDir = path.join(temporary, 'source');
  let client;
  t.after(async () => {
    if (client) await client.close();
    assert.ok(path.basename(temporary).startsWith('acg-onboarding-'));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  await fs.mkdir(sourceDir);
  client = await open(dataDir);
  assert.equal((await client.call('init')).settings.metadataOnboardingSeen, false);
  await client.call('settings', { key: 'autoMatch', value: false });
  await client.call('settings', { key: 'nickname', value: '既有资料' });
  await client.call('scan', { path: sourceDir, onlineMatch: false, directoryKind: 'photo' });
  const roots = (await client.call('init')).roots;
  assert.equal(roots.length, 1);
  await client.close();
  client = null;
  // Inert fixture bytes at the actual encrypted-storage path; never use a real credential.
  const tokenPath = path.join(dataDir, 'bangumi-token.enc'),
    fixtureCiphertext = Buffer.from([0, 2, 4, 8, 16, 32]);
  await fs.writeFile(tokenPath, fixtureCiphertext);
  client = await open(dataDir);
  for (const value of [null, 'true', 1])
    await assert.rejects(
      client.call('settings', { key: 'metadataOnboardingSeen', value }),
      /布尔值/
    );
  await client.call('settings', { key: 'metadataOnboardingSeen', value: true });
  await client.close();
  client = null;
  client = await open(dataDir);
  const init = await client.call('init');
  assert.equal(init.settings.metadataOnboardingSeen, true);
  assert.equal(init.settings.nickname, '既有资料');
  assert.equal(init.settings.autoMatch, false);
  assert.deepEqual(init.roots, roots);
  assert.equal(Object.hasOwn(init.settings, 'token'), false);
  await client.close();
  client = null;
  assert.deepEqual(await fs.readFile(tokenPath), fixtureCiphertext);
});
