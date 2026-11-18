'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { builderConfig } = require('../scripts/mac-support.cjs');
const {
  DMG_SIZE,
  DMG_CAPACITY_BYTES,
  MAXIMUM_PAYLOAD_BYTES,
  FRAMEWORK_BINARY,
  snapshotAppInventory,
  validateInventory,
  dmgCapacityProof,
  requireFrameworkBinary,
  assertAppInventoryMatches
} = require('../scripts/mac-bundle-inventory.cjs');

async function fixture(t) {
  const temporary = await fsp.realpath(os.tmpdir());
  const owned = await fsp.mkdtemp(path.join(temporary, 'acg-mac-inventory-test-'));
  t.after(async () => {
    assert.equal(path.dirname(owned), temporary);
    assert.ok(path.basename(owned).startsWith('acg-mac-inventory-test-'));
    await fsp.rm(owned, { recursive: true });
  });
  const app = path.join(owned, 'ACG-album (copy fixture).app');
  const framework = path.join(app, ...FRAMEWORK_BINARY.split('/'));
  await fsp.mkdir(path.dirname(framework), { recursive: true });
  await fsp.writeFile(framework, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
  const resources = path.join(app, 'Contents', 'Resources');
  await fsp.mkdir(resources);
  const payload = path.join(resources, 'payload.txt');
  await fsp.writeFile(payload, 'source payload\n');
  return { owned, app, framework, resources, payload };
}

async function symlinkOrSkip(t, target, filename) {
  try {
    await fsp.symlink(target, filename, 'file');
    return true;
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
      t.skip(
        'Windows host does not allow test symlink creation; native macOS CI must execute this fixture'
      );
      return false;
    }
    throw error;
  }
}

function oneFileInventory(bytes) {
  const entries = [
    { path: 'Contents/payload', type: 'file', mode: 0o644, bytes, sha256: '1'.repeat(64) }
  ];
  return {
    format: 1,
    algorithm: 'sha256',
    entries,
    counts: { files: 1, directories: 0, symlinks: 0 },
    logicalBytes: bytes,
    roundedPayloadBytes: Math.ceil(bytes / 4096) * 4096,
    sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex')
  };
}

test('physical app inventory streams ordinary hard-linked paths and requires the real framework binary', async (t) => {
  const { app, resources, payload } = await fixture(t);
  await fsp.link(payload, path.join(resources, 'hard-linked.txt'));
  // A snapshot must use streaming I/O even for the large Full SQLite payload.
  const originalReadFile = fsp.readFile;
  fsp.readFile = () => {
    throw new Error('Whole-file reads are forbidden in inventory');
  };
  let inventory;
  try {
    inventory = await snapshotAppInventory(app);
  } finally {
    fsp.readFile = originalReadFile;
  }
  const original = inventory.entries.find((row) => row.path.endsWith('/payload.txt'));
  const linked = inventory.entries.find((row) => row.path.endsWith('/hard-linked.txt'));
  assert.equal(linked.bytes, original.bytes);
  assert.equal(linked.sha256, original.sha256);
  assert.equal(inventory.counts.files, 3);
  assert.ok(inventory.counts.directories > 0);
  assert.equal((await requireFrameworkBinary(app, inventory)).realMachOBinaryVerified, true);
  assert.equal(
    assertAppInventoryMatches(inventory, await snapshotAppInventory(app)).verified,
    true
  );
});

test('mounted inventory rejects missing, truncated, same-size changed, extra and type-changed files', async (t) => {
  for (const change of ['missing', 'truncated', 'changed', 'extra', 'type']) {
    await t.test(change, async (t) => {
      const { app, resources, payload } = await fixture(t);
      const before = await snapshotAppInventory(app);
      if (change === 'missing') await fsp.unlink(payload);
      if (change === 'truncated') await fsp.truncate(payload, 2);
      if (change === 'changed') await fsp.writeFile(payload, 'SOURCE PAYLOAD\n');
      if (change === 'extra') await fsp.writeFile(path.join(resources, 'unexpected.txt'), 'extra');
      if (change === 'type') {
        await fsp.unlink(payload);
        await fsp.mkdir(payload);
      }
      const after = await snapshotAppInventory(app);
      const reason = {
        missing: /is missing:/,
        truncated: /bytes changed:/,
        changed: /sha256 changed:/,
        extra: /extra entry:/,
        type: /type changed:/
      }[change];
      assert.throws(() => assertAppInventoryMatches(before, after), reason);
    });
  }
});

test(
  'native filesystem permission changes are included in the copy proof',
  { skip: process.platform === 'win32' ? 'POSIX modes are verified on native macOS' : false },
  async (t) => {
    const { app, payload } = await fixture(t);
    await fsp.chmod(payload, 0o644);
    const before = await snapshotAppInventory(app);
    await fsp.chmod(payload, 0o600);
    const after = await snapshotAppInventory(app);
    assert.throws(() => assertAppInventoryMatches(before, after), /mode changed:/);
  }
);

test('relative internal symlinks preserve exact target text and changed targets fail the copy proof', async (t) => {
  const { app, resources, payload } = await fixture(t);
  const alias = path.join(resources, 'alias');
  if (!(await symlinkOrSkip(t, 'payload.txt', alias))) return;
  const before = await snapshotAppInventory(app);
  assert.equal(before.counts.symlinks, 1);
  assert.equal(before.entries.find((row) => row.path.endsWith('/alias')).target, 'payload.txt');
  await fsp.copyFile(payload, path.join(resources, 'same-bytes.txt'));
  // Include the second real file in both inventories, so only the link changes.
  const expected = await snapshotAppInventory(app);
  await fsp.unlink(alias);
  await fsp.symlink('same-bytes.txt', alias, 'file');
  const changed = await snapshotAppInventory(app);
  assert.throws(() => assertAppInventoryMatches(expected, changed), /target changed:/);
});

test('dangling and escaped links, including a chain through an internal alias, are rejected', async (t) => {
  for (const kind of ['dangling', 'escape', 'chain', 'absolute']) {
    await t.test(kind, async (t) => {
      const { owned, app, resources } = await fixture(t);
      const outside = path.join(owned, 'outside.txt');
      await fsp.writeFile(outside, 'outside the application');
      let target =
        kind === 'dangling'
          ? 'missing.txt'
          : kind === 'absolute'
            ? outside
            : '../../../outside.txt';
      const alias = path.join(resources, 'alias');
      if (kind === 'chain') {
        if (!(await symlinkOrSkip(t, '../../../outside.txt', path.join(resources, 'escape'))))
          return;
        target = 'escape';
      }
      if (!(await symlinkOrSkip(t, target, alias))) return;
      await assert.rejects(
        snapshotAppInventory(app),
        /Dangling or cyclic|escapes application|relative application target/
      );
    });
  }
});

test('a missing framework or a framework replaced with text never satisfies the physical binary proof', async (t) => {
  const { app, framework } = await fixture(t);
  await fsp.unlink(framework);
  await assert.rejects(
    requireFrameworkBinary(app, await snapshotAppInventory(app)),
    /real Versions\/A Mach-O binary/
  );
  await fsp.writeFile(framework, 'not an Electron Framework binary');
  await assert.rejects(
    requireFrameworkBinary(app, await snapshotAppInventory(app)),
    /must be Mach-O/
  );
});

test('12 GiB DMG capacity allows exactly 8 GiB rounded payload and rejects one-byte overflow', () => {
  assert.equal(DMG_CAPACITY_BYTES, 12 * 1024 ** 3);
  assert.equal(MAXIMUM_PAYLOAD_BYTES, 8 * 1024 ** 3);
  const exact = dmgCapacityProof(oneFileInventory(MAXIMUM_PAYLOAD_BYTES));
  assert.equal(exact.size, '12g');
  assert.equal(exact.shrink, true);
  assert.equal(exact.minimumReserveBytes, 4 * 1024 ** 3);
  assert.equal(exact.remainingCapacityBytes, exact.minimumReserveBytes);
  assert.equal(
    dmgCapacityProof(oneFileInventory(MAXIMUM_PAYLOAD_BYTES - 1)).roundedPayloadBytes,
    MAXIMUM_PAYLOAD_BYTES
  );
  assert.throws(
    () => dmgCapacityProof(oneFileInventory(MAXIMUM_PAYLOAD_BYTES + 1)),
    /exceeds the 8 GiB/
  );
});

test('inventory rejects altered summaries, malformed paths and a tampered source digest', () => {
  const inventory = oneFileInventory(1);
  assert.equal(validateInventory(inventory), inventory);
  for (const update of [
    { logicalBytes: 999 },
    { roundedPayloadBytes: 0 },
    { counts: { files: 0, directories: 0, symlinks: 0 } },
    { sha256: '0'.repeat(64) },
    { entries: [{ ...inventory.entries[0], path: '../outside' }] },
    { entries: [inventory.entries[0], inventory.entries[0]] }
  ])
    assert.throws(() => validateInventory({ ...inventory, ...update }));
});

test(
  'real builder 26.8.1 DMG target retains the configured bounded workspace and shrink option',
  {
    skip:
      process.platform !== 'darwin'
        ? 'Real DmgTarget requires native macOS and its Darwin-only optional dmg-license dependency'
        : false
  },
  async () => {
    const root = path.resolve(__dirname, '..');
    const config = builderConfig({
      root,
      stage: path.join(root, 'release', 'fixture-stage'),
      output: path.join(root, 'release', 'fixture-output')
    });
    assert.equal(config.dmg.size, DMG_SIZE);
    assert.equal(config.dmg.shrink, true);
    const fromBuilder = createRequire(
      require.resolve('app-builder-lib', {
        paths: [path.dirname(require.resolve('electron-builder'))]
      })
    );
    const { DmgTarget } = fromBuilder('dmg-builder/out/dmg.js');
    const packager = { config, appInfo: { productFilename: 'ACG-album' } };
    const target = new DmgTarget(packager, '/fixture/output');
    assert.equal(target.options, config.dmg);
    config.dmg.icon = null;
    config.dmg.backgroundColor = '#ffffff';
    const effective = await target.computeDmgOptions('/fixture/ACG-album.app');
    assert.equal(effective.size, '12g');
    assert.equal(effective.shrink, true);
    assert.equal(effective.sign, false);
    assert.equal(effective.format, 'ULFO');
  }
);
