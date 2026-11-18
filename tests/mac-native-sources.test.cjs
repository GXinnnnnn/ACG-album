'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertDarwinVersions, sourceRecords } = require('../scripts/mac-native-sources.cjs');
const lock = require('../scripts/mac-native-sources.json');
const { safeArchivePath } = require('../scripts/mac-support.cjs');

test('Darwin native source versions reject added, missing and changed components', () => {
  assertDarwinVersions({ ...lock.versions });
  for (const actual of [
    { ...lock.versions, vips: '8.17.4' },
    { ...lock.versions, unknown: '1' },
    Object.fromEntries(Object.entries(lock.versions).filter(([name]) => name !== 'heif'))
  ])
    assert.throws(() => assertDarwinVersions(actual), /corresponding sources/);
  assert.equal(Object.keys(lock.versions).length, 28);
  assert.equal(lock.components.length, 28);
});

test('every reused component and Rust crate has bounded, unique, hash-locked source bytes', () => {
  const records = sourceRecords();
  assert.equal(new Set(records.map((row) => row.path)).size, records.length);
  for (const row of records) {
    assert.ok(safeArchivePath(row.path), row.path);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0, row.path);
    assert.match(row.sha256, /^[a-f0-9]{64}$/);
  }
  for (const component of lock.components) {
    const record = records.find((row) => row.path === 'shared/sources/' + component.file);
    assert.ok(record, component.name);
    assert.equal(record.sha256, component.sha256, component.name);
    assert.equal(record.bytes, component.bytes, component.name);
  }
  assert.equal(
    records.filter(
      (row) => row.path.startsWith('shared/rust/crates/') && row.path.endsWith('.crate')
    ).length,
    348
  );
  assert.ok(
    records.reduce((sum, row) => sum + row.bytes, 0) < 1024 ** 3,
    'Source payload stays bounded below 1 GiB'
  );
});

test('Darwin posix inputs include all five patches, gvdb and matching official Rust std source', () => {
  const added = lock.additionalFiles;
  assert.equal(added.filter((row) => row.path.startsWith('patches/')).length, 5);
  assert.ok(
    added.some((row) => row.path.includes('gvdb-2b42fc75f09dbe1cd1057580b5782b08f2dcb400'))
  );
  assert.equal(lock.rustStd.commit, '82ae0ee6487e93bd6c05167ccb2ef3485fdbc890');
  const rust = added.find((row) => row.path === 'sources/rust-src-nightly-2025-11-01.tar.xz');
  assert.equal(rust.sha256, 'cbb745bda29c7f4b66218778c11c21c70180d0a2a4c7cc28d2244d65f45e9487');
  assert.equal(rust.bytes, 3532240);
  for (const row of added) assert.match(row.url, /^https:\/\//);
});
