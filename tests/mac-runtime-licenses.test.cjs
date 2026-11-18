'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const sourceLock = require('../scripts/mac-native-sources.json');
const {
  licenseSupplementPlan,
  verifyLicensePayload,
  writeRuntimeLicenses
} = require('../scripts/mac-runtime-licenses.cjs');
const root = path.resolve(__dirname, '..');
const metadata = (arch = 'arm64') => ({
  name: '@img/sharp-libvips-darwin-' + arch,
  version: '1.2.4',
  license: 'LGPL-3.0-or-later'
});

async function fixture(t, pkg) {
  const temporary = await fsp.realpath(os.tmpdir());
  const owned = await fsp.mkdtemp(path.join(temporary, 'acg-mac-license-test-'));
  t.after(async () => {
    assert.equal(path.dirname(owned), temporary);
    assert.ok(path.basename(owned).startsWith('acg-mac-license-test-'));
    await fsp.rm(owned, { recursive: true });
  });
  const stage = path.join(owned, 'stage');
  const directory = path.join(stage, 'node_modules', ...pkg.name.split('/'));
  await fsp.mkdir(directory, { recursive: true });
  await fsp.writeFile(path.join(directory, 'package.json'), JSON.stringify(pkg));
  await fsp.writeFile(path.join(directory, 'README.md'), '# Package notice\n');
  if (pkg.name.startsWith('@img/sharp-libvips-'))
    await fsp.writeFile(path.join(directory, 'versions.json'), JSON.stringify(sourceLock.versions));
  const sources = path.join(owned, 'sources');
  await fsp.mkdir(sources);
  return { owned, directory, sources, stage, resources: path.join(owned, 'resources'), pkg };
}

const write = (data) =>
  writeRuntimeLicenses(
    data.stage,
    data.resources,
    [{ name: data.pkg.name, version: data.pkg.version, integrity: 'fixture' }],
    data.sources
  );

test('license supplements are limited to exact two Darwin libvips releases and exact component versions', () => {
  for (const arch of ['arm64', 'x64']) {
    const plan = licenseSupplementPlan(metadata(arch), sourceLock.versions);
    assert.ok(plan.some((row) => row.file === 'LICENSE-LGPL-3.0.txt'));
    assert.ok(plan.some((row) => row.file === 'LICENSE-GPL-3.0.txt'));
    assert.equal(plan.filter((row) => row.archive).length, 17);
    assert.ok(
      plan.some((row) => row.member?.endsWith('/COPYING') && row.archive.includes('gvdb-'))
    );
    assert.ok(plan.some((row) => row.member === 'rust-src-nightly/LICENSE-MIT'));
  }
  for (const changed of [
    metadata('win32-x64'),
    { ...metadata(), name: 'ordinary-package' },
    { ...metadata(), version: '1.2.5' },
    { ...metadata(), license: 'MIT' }
  ])
    assert.throws(
      () => licenseSupplementPlan(changed, sourceLock.versions),
      /Missing runtime package license/
    );
  assert.throws(
    () => licenseSupplementPlan(metadata(), { ...sourceLock.versions, vips: '8.17.4' }),
    /component versions/
  );
  assert.throws(() => licenseSupplementPlan(metadata(), {}), /component versions/);
});

test('real complete LGPL text has pinned bytes and SHA; empty, truncated and altered text fail', async () => {
  const expected = licenseSupplementPlan(metadata(), sourceLock.versions).find(
    (row) => row.file === 'LICENSE-LGPL-3.0.txt'
  );
  const data = await fsp.readFile(path.join(root, 'src/assets/licenses/libvips/LGPL-3.0.txt'));
  assert.deepEqual(verifyLicensePayload(data, expected), {
    bytes: expected.bytes,
    sha256: expected.sha256
  });
  assert.throws(() => verifyLicensePayload(Buffer.alloc(0), expected), /Empty license/);
  assert.throws(() => verifyLicensePayload(data.subarray(1), expected), /byte count mismatch/);
  const changed = Buffer.from(data);
  changed[0] ^= 1;
  assert.throws(() => verifyLicensePayload(changed, expected), /SHA256 mismatch/);
});

test('ordinary package without real license still rejects even when it has README and license metadata', async (t) => {
  const data = await fixture(t, { name: 'ordinary-package', version: '1.0.0', license: 'MIT' });
  await assert.rejects(write(data), /Missing runtime package license/);
});

test('Darwin supplement rejects a missing or changed source text without altering npm package bytes', async (t) => {
  const missing = await fixture(t, metadata());
  const original = await fsp.readFile(path.join(missing.directory, 'package.json'));
  await assert.rejects(write(missing), { code: 'ENOENT' });
  assert.deepEqual(await fsp.readFile(path.join(missing.directory, 'package.json')), original);
  const changed = await fixture(t, metadata('x64'));
  const expected = licenseSupplementPlan(metadata('x64'), sourceLock.versions)[0];
  const target = path.join(changed.sources, ...expected.path.split('/'));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, Buffer.alloc(expected.bytes));
  await assert.rejects(write(changed), /License SHA256 mismatch/);
});

test('ordinary real license and raw package metadata are copied with byte hashes and source provenance', async (t) => {
  const data = await fixture(t, { name: 'ordinary-package', version: '1.0.0', license: 'MIT' });
  const text = await fsp.readFile(path.join(root, 'LICENSE'));
  await fsp.writeFile(path.join(data.directory, 'LICENSE'), text);
  const result = await write(data);
  const entry = result.packages[0].files.find((row) => row.file === 'LICENSE');
  assert.equal(entry.bytes, text.length);
  assert.equal(entry.sha256, crypto.createHash('sha256').update(text).digest('hex'));
  assert.equal(entry.source.package, 'ordinary-package');
  assert.equal(entry.supplementReason, undefined);
  assert.deepEqual(
    await fsp.readFile(path.join(data.resources, 'licenses/mac-runtime/ordinary-package/LICENSE')),
    text
  );
});
