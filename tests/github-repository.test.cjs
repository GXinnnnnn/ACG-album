'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const {
  OFFICIAL_REPOSITORY,
  effectiveRepository,
  officialDownloads
} = require('../src/repository.cjs');

test('effective repository defaults only missing/blank values and preserves custom configuration', () => {
  for (const value of [undefined, null, '', '  \n'])
    assert.equal(effectiveRepository(value), OFFICIAL_REPOSITORY);
  for (const value of ['custom-owner/custom-repo', 'https://invalid.example'])
    assert.equal(effectiveRepository(value), value);
  const version = require('../package.json').version;
  const links = officialDownloads(version);
  assert.equal(links.releaseUrl, `https://github.com/GXinnnnnn/ACG-album/releases/tag/v${version}`);
  assert.equal(
    links.downloads.lite,
    `https://github.com/GXinnnnnn/ACG-album/releases/download/v${version}/ACG-album-Setup-${version}-Lite.exe`
  );
  assert.equal(
    links.downloads.full,
    `https://github.com/GXinnnnnn/ACG-album/releases/download/v${version}/ACG-album-Setup-${version}-Full.exe`
  );
});

async function start(t, stored) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'album-repository-test-'));
  const dbPath = path.join(dataDir, 'library.sqlite');
  if (stored !== undefined) {
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO settings VALUES(?,?)').run('githubRepository', JSON.stringify(stored));
    db.close();
  }
  const worker = new Worker(path.resolve(__dirname, '../src/library-worker.cjs'), {
    workerData: { dataDir, watch: false }
  });
  let sequence = 0;
  const pending = new Map();
  function call(method, args = {}) {
    return new Promise((resolve, reject) => {
      const request = ++sequence;
      const timer = setTimeout(() => reject(new Error('Worker timed out: ' + method)), 10000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  }
  t.after(async () => {
    try {
      await call('shutdown');
    } finally {
      await worker.terminate();
      for (const item of pending.values()) clearTimeout(item.timer);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  await new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.event === 'ready') resolve();
      const item = pending.get(message.request);
      if (!item) return;
      pending.delete(message.request);
      clearTimeout(item.timer);
      message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
    });
  });
  return { call, dbPath };
}

for (const stored of [undefined, '', '  ', 'custom-owner/custom-repo', 'https://legacy.invalid']) {
  test(
    `real worker init resolves repository without rewriting stored ${JSON.stringify(stored)}`,
    { timeout: 15000 },
    async (t) => {
      const { call, dbPath } = await start(t, stored);
      const info = await call('init');
      assert.equal(info.settings.githubRepository, effectiveRepository(stored));
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM settings WHERE key='githubRepository'").get();
        assert.equal(row?.value, stored === undefined ? undefined : JSON.stringify(stored));
      } finally {
        db.close();
      }
      assert.equal(
        await call('settings', { key: 'githubRepository', value: '' }),
        OFFICIAL_REPOSITORY
      );
      assert.equal((await call('init')).settings.githubRepository, OFFICIAL_REPOSITORY);
      assert.equal(
        await call('settings', { key: 'githubRepository', value: 'my-owner/my-repo' }),
        'my-owner/my-repo'
      );
      assert.equal((await call('init')).settings.githubRepository, 'my-owner/my-repo');
      await assert.rejects(call('settings', { key: 'githubRepository', value: '../bad' }), /仓库/);
    }
  );
}
