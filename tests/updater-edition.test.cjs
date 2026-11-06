'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { currentEdition } = require('../src/update-service.cjs');
const metadata = require('../package.json');
const bytes = Buffer.from('synthetic bundled database metadata fixture');
const hash = createHash('sha256').update(bytes).digest('hex');

function changeMetadata(t, edition) {
  const present = Object.hasOwn(metadata, 'searchEdition');
  const previous = metadata.searchEdition;
  metadata.searchEdition = edition;
  t.after(() => {
    if (present) metadata.searchEdition = previous;
    else delete metadata.searchEdition;
  });
}

async function fixture(t, edition) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'album-edition-recognition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const installation = path.join(root, 'application');
  const executable = path.join(installation, 'ACG-album.exe');
  const resources = path.join(installation, 'resources');
  const index = path.join(resources, 'local-index');
  const manifestFile = path.join(index, 'manifest.json');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(executable, 'NOT AN EXECUTABLE');
  const app = { isPackaged: true, getPath: (key) => (key === 'exe' ? executable : undefined) };
  async function write(variant) {
    await fs.mkdir(index, { recursive: true });
    await fs.writeFile(path.join(index, 'subjects.sqlite'), bytes);
    await fs.writeFile(
      manifestFile,
      JSON.stringify({
        manifestVersion: 1,
        readerSchemaVersion: 1,
        bundled: true,
        variant,
        dataVersion: 'synthetic-2026-11',
        database: 'subjects.sqlite',
        bytes: bytes.length,
        sha256: hash,
        counts: { subjects: 1 }
      })
    );
  }
  if (edition !== 'standard') await write(edition);
  return { app, installation, resources, index, manifestFile, write };
}

for (const packagedEdition of ['standard', 'lite', 'full']) {
  for (const actualEdition of ['standard', 'lite', 'full']) {
    test(`packaged ${packagedEdition} body recognizes actual ${actualEdition} index`, async (t) => {
      changeMetadata(t, packagedEdition);
      const h = await fixture(t, actualEdition);
      assert.equal(currentEdition(h.app), actualEdition);
    });
  }
}

test('edition reads the same manifest path fresh after changes and recognizes only actual absence as Standard', async (t) => {
  changeMetadata(t, 'standard');
  const h = await fixture(t, 'lite');
  assert.equal(currentEdition(h.app), 'lite');
  await h.write('full');
  assert.equal(currentEdition(h.app), 'full');
  await fs.writeFile(h.manifestFile, '{broken');
  assert.equal(currentEdition(h.app), null);
  // This is exclusively a newly created fixture index, not a user/runtime path.
  await fs.rm(h.index, { recursive: true });
  metadata.searchEdition = 'full';
  assert.equal(currentEdition(h.app), 'standard');
});

const invalidManifests = [
  ['null JSON', () => null],
  ['array JSON', () => []],
  ['unknown variant', (value) => ({ ...value, variant: 'standard' })],
  ['missing manifest version', (value) => ({ ...value, manifestVersion: undefined })],
  ['unknown manifest version', (value) => ({ ...value, manifestVersion: 2 })],
  ['string manifest version', (value) => ({ ...value, manifestVersion: '1' })],
  ['missing reader schema', (value) => ({ ...value, readerSchemaVersion: undefined })],
  ['unknown reader schema', (value) => ({ ...value, readerSchemaVersion: 99 })],
  ['missing bundled flag', (value) => ({ ...value, bundled: undefined })],
  ['false bundled flag', (value) => ({ ...value, bundled: false })],
  ['missing data version', (value) => ({ ...value, dataVersion: undefined })],
  ['empty data version', (value) => ({ ...value, dataVersion: '' })],
  ['unknown database path', (value) => ({ ...value, database: '../subjects.sqlite' })],
  ['invalid byte count', (value) => ({ ...value, bytes: 1.5 })],
  ['missing SHA', (value) => ({ ...value, sha256: undefined })],
  ['invalid SHA', (value) => ({ ...value, sha256: 'unknown' })]
];
for (const [name, mutate] of invalidManifests) {
  test(`existing bundled index with ${name} stays unknown`, async (t) => {
    changeMetadata(t, 'standard');
    const h = await fixture(t, 'full');
    const value = JSON.parse(await fs.readFile(h.manifestFile, 'utf8'));
    await fs.writeFile(h.manifestFile, JSON.stringify(mutate(value)));
    assert.equal(currentEdition(h.app), null);
  });
}
for (const broken of [
  'malformed-json',
  'missing-manifest',
  'missing-database',
  'wrong-database-size',
  'empty-manifest',
  'oversized-manifest'
]) {
  test(`existing bundled index ${broken} stays unknown`, async (t) => {
    changeMetadata(t, 'standard');
    const h = await fixture(t, 'full');
    if (broken === 'malformed-json') await fs.writeFile(h.manifestFile, '{');
    if (broken === 'missing-manifest') await fs.unlink(h.manifestFile);
    if (broken === 'missing-database') await fs.unlink(path.join(h.index, 'subjects.sqlite'));
    if (broken === 'wrong-database-size')
      await fs.writeFile(path.join(h.index, 'subjects.sqlite'), 'short');
    if (broken === 'empty-manifest') await fs.writeFile(h.manifestFile, '');
    if (broken === 'oversized-manifest') await fs.writeFile(h.manifestFile, ' '.repeat(65537));
    assert.equal(currentEdition(h.app), null);
  });
}

for (const failure of ['EACCES', 'EPERM', 'EIO', 'ENOTDIR']) {
  test(`index lstat ${failure} cannot masquerade as Standard`, async (t) => {
    const h = await fixture(t, 'full');
    const original = syncFs.lstatSync;
    t.mock.method(syncFs, 'lstatSync', (target, ...args) => {
      if (target === h.index)
        throw Object.assign(new Error('synthetic stat failure'), { code: failure });
      return original(target, ...args);
    });
    assert.equal(currentEdition(h.app), null);
  });
}
for (const failure of ['EACCES', 'EPERM']) {
  test(`manifest read ${failure} stays unknown`, async (t) => {
    const h = await fixture(t, 'full');
    const original = syncFs.readFileSync;
    t.mock.method(syncFs, 'readFileSync', (target, ...args) => {
      if (target === h.manifestFile)
        throw Object.assign(new Error('synthetic read failure'), { code: failure });
      return original(target, ...args);
    });
    assert.equal(currentEdition(h.app), null);
  });
}

test('unreadable resources parent cannot prove absent index', async (t) => {
  const h = await fixture(t, 'standard');
  const original = syncFs.lstatSync;
  t.mock.method(syncFs, 'lstatSync', (target, ...args) => {
    if (target === h.resources)
      throw Object.assign(new Error('synthetic parent failure'), { code: 'EACCES' });
    return original(target, ...args);
  });
  assert.equal(currentEdition(h.app), null);
});

for (const target of ['installation', 'resources', 'index', 'manifestFile', 'database']) {
  test(`${target} reparse point cannot select a packaged edition`, async (t) => {
    const h = await fixture(t, 'full');
    const selected = target === 'database' ? path.join(h.index, 'subjects.sqlite') : h[target];
    const original = syncFs.lstatSync;
    t.mock.method(syncFs, 'lstatSync', (file, ...args) => {
      const result = original(file, ...args);
      if (file !== selected) return result;
      return {
        isSymbolicLink: () => true,
        isDirectory: () => result.isDirectory(),
        isFile: () => result.isFile(),
        size: result.size
      };
    });
    assert.equal(currentEdition(h.app), null);
  });
}

test('a local-index file and missing resources parent both stay unknown', async (t) => {
  const h = await fixture(t, 'standard');
  await fs.writeFile(h.index, 'not a directory');
  assert.equal(currentEdition(h.app), null);
  await fs.unlink(h.index);
  await fs.rmdir(h.resources);
  assert.equal(currentEdition(h.app), null);
});

test('unpackaged metadata remains a development hint without runtime filesystem reads', (t) => {
  changeMetadata(t, 'full');
  assert.equal(
    currentEdition({
      isPackaged: false,
      getPath: () => {
        throw new Error('must not read');
      }
    }),
    'full'
  );
  metadata.searchEdition = 'not-an-edition';
  assert.equal(currentEdition({ isPackaged: false }), 'standard');
});
