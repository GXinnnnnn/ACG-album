'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const GiB = 1024 ** 3;
const DMG_SIZE = '12g';
const DMG_CAPACITY_BYTES = 12 * GiB;
const MAXIMUM_PAYLOAD_BYTES = 8 * GiB;
const ALLOCATION_UNIT_BYTES = 4096;
const FRAMEWORK_BINARY =
  'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
const comparePath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const roundPayload = (bytes) => Math.ceil(bytes / ALLOCATION_UNIT_BYTES) * ALLOCATION_UNIT_BYTES;
const inventoryDigest = (entries) =>
  crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}

function validRelativePath(value) {
  assert.equal(typeof value, 'string', 'Inventory path must be text');
  assert.ok(
    value && !value.includes('\\') && !value.includes('\0') && !path.posix.isAbsolute(value),
    'Unsafe inventory path: ' + value
  );
  assert.ok(
    value.split('/').every((part) => part && part !== '.' && part !== '..'),
    'Unsafe inventory path: ' + value
  );
}

function summarize(entries) {
  let logicalBytes = 0;
  let roundedPayloadBytes = 0;
  const counts = { files: 0, directories: 0, symlinks: 0 };
  for (const row of entries) {
    if (row.type === 'file') {
      counts.files++;
      logicalBytes += row.bytes;
      roundedPayloadBytes += roundPayload(row.bytes);
    } else if (row.type === 'directory') {
      counts.directories++;
    } else if (row.type === 'symlink') {
      counts.symlinks++;
      roundedPayloadBytes += roundPayload(Buffer.byteLength(row.target));
    }
    assert.ok(
      Number.isSafeInteger(logicalBytes) && Number.isSafeInteger(roundedPayloadBytes),
      'Application inventory byte count overflow'
    );
  }
  return { counts, logicalBytes, roundedPayloadBytes };
}

function validateInventory(inventory) {
  assert.equal(inventory?.format, 1, 'Expected signed application inventory format 1');
  assert.equal(inventory.algorithm, 'sha256');
  assert.ok(
    Array.isArray(inventory.entries) && inventory.entries.length > 0,
    'Application inventory must not be empty'
  );
  let previous;
  for (const row of inventory.entries) {
    validRelativePath(row.path);
    assert.ok(
      previous === undefined || previous < row.path,
      'Inventory paths must be unique and sorted: ' + row.path
    );
    previous = row.path;
    assert.ok(
      Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o7777,
      'Invalid inventory permissions: ' + row.path
    );
    if (row.type === 'file') {
      assert.ok(
        Number.isSafeInteger(row.bytes) && row.bytes >= 0,
        'Invalid file size: ' + row.path
      );
      assert.match(row.sha256, /^[a-f0-9]{64}$/, 'Invalid file SHA-256: ' + row.path);
      assert.deepEqual(Object.keys(row).sort(), ['bytes', 'mode', 'path', 'sha256', 'type']);
    } else if (row.type === 'symlink') {
      assert.equal(typeof row.target, 'string');
      assert.ok(
        row.target && !row.target.includes('\0') && !path.isAbsolute(row.target),
        'Symlink must use a relative application target: ' + row.path
      );
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(row.path), row.target)
      );
      assert.ok(
        target !== '..' && !target.startsWith('../') && !path.posix.isAbsolute(target),
        'Symlink escapes application: ' + row.path
      );
      assert.deepEqual(Object.keys(row).sort(), ['mode', 'path', 'target', 'type']);
    } else {
      assert.equal(row.type, 'directory', 'Unsupported inventory entry: ' + row.path);
      assert.deepEqual(Object.keys(row).sort(), ['mode', 'path', 'type']);
    }
  }
  const summary = summarize(inventory.entries);
  assert.deepEqual(inventory.counts, summary.counts, 'Inventory counts disagree');
  assert.equal(inventory.logicalBytes, summary.logicalBytes, 'Inventory logical bytes disagree');
  assert.equal(
    inventory.roundedPayloadBytes,
    summary.roundedPayloadBytes,
    'Inventory allocation budget disagrees'
  );
  assert.equal(inventory.sha256, inventoryDigest(inventory.entries), 'Inventory digest disagrees');
  return inventory;
}

async function snapshotAppInventory(appPath) {
  assert.ok((await fsp.lstat(appPath)).isDirectory(), 'Application root must be a real directory');
  const root = await fsp.realpath(appPath);
  const entries = [];
  async function visit(directory) {
    for (const name of await fsp.readdir(directory)) {
      const filename = path.join(directory, name);
      const relative = path.relative(root, filename).split(path.sep).join('/');
      validRelativePath(relative);
      const stat = await fsp.lstat(filename, { bigint: true });
      const mode = Number(stat.mode & 0o7777n);
      if (stat.isSymbolicLink()) {
        const target = await fsp.readlink(filename);
        assert.ok(
          !path.isAbsolute(target),
          'Symlink must use a relative application target: ' + relative
        );
        assert.ok(
          inside(root, path.resolve(directory, target)),
          'Symlink escapes application: ' + relative
        );
        let resolved;
        try {
          resolved = await fsp.realpath(filename);
        } catch (error) {
          throw new Error('Dangling or cyclic application symlink: ' + relative, { cause: error });
        }
        assert.ok(inside(root, resolved), 'Symlink chain escapes application: ' + relative);
        const targetStat = await fsp.stat(resolved);
        assert.ok(
          targetStat.isFile() || targetStat.isDirectory(),
          'Unsupported application symlink target: ' + relative
        );
        entries.push({ path: relative, type: 'symlink', mode, target });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory', mode });
        await visit(filename);
      } else {
        assert.ok(stat.isFile(), 'Unsupported application filesystem entry: ' + relative);
        const bytes = Number(stat.size);
        assert.ok(Number.isSafeInteger(bytes), 'Unsafe application file size: ' + relative);
        const hash = crypto.createHash('sha256');
        // Stream even the 4.7 GB database. Hard links are ordinary readable files;
        // each path is recorded independently rather than rejected or deduplicated.
        const handle = await fsp.open(
          filename,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        try {
          const opened = await handle.stat({ bigint: true });
          const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'];
          for (const field of fields)
            assert.equal(
              opened[field],
              stat[field],
              'Application file identity changed before hashing: ' + relative
            );
          for await (const chunk of handle.createReadStream({ autoClose: false }))
            hash.update(chunk);
          const afterFd = await handle.stat({ bigint: true });
          const afterPath = await fsp.lstat(filename, { bigint: true });
          for (const field of fields) {
            assert.equal(
              afterFd[field],
              stat[field],
              'Open application file changed while hashing: ' + relative
            );
            assert.equal(
              afterPath[field],
              stat[field],
              'Application path changed while hashing: ' + relative
            );
          }
        } finally {
          await handle.close();
        }
        entries.push({ path: relative, type: 'file', mode, bytes, sha256: hash.digest('hex') });
      }
    }
  }
  await visit(root);
  entries.sort(comparePath);
  return validateInventory({
    format: 1,
    algorithm: 'sha256',
    entries,
    ...summarize(entries),
    sha256: inventoryDigest(entries)
  });
}

function dmgCapacityProof(inventory) {
  validateInventory(inventory);
  assert.ok(
    inventory.roundedPayloadBytes <= MAXIMUM_PAYLOAD_BYTES,
    'Signed application exceeds the 8 GiB payload budget for the 12 GiB DMG'
  );
  return {
    size: DMG_SIZE,
    shrink: true,
    capacityBytes: DMG_CAPACITY_BYTES,
    maximumPayloadBytes: MAXIMUM_PAYLOAD_BYTES,
    allocationUnitBytes: ALLOCATION_UNIT_BYTES,
    roundedPayloadBytes: inventory.roundedPayloadBytes,
    minimumReserveBytes: DMG_CAPACITY_BYTES - MAXIMUM_PAYLOAD_BYTES,
    remainingCapacityBytes: DMG_CAPACITY_BYTES - inventory.roundedPayloadBytes,
    budgetVerified: true
  };
}

async function requireFrameworkBinary(appPath, inventory) {
  validateInventory(inventory);
  const row = inventory.entries.find((entry) => entry.path === FRAMEWORK_BINARY);
  assert.ok(
    row?.type === 'file' && row.bytes > 4,
    'Electron Framework must have its real Versions/A Mach-O binary'
  );
  const filename = path.join(appPath, ...FRAMEWORK_BINARY.split('/'));
  assert.ok(
    (await fsp.lstat(filename)).isFile(),
    'Electron Framework binary must not be a symlink'
  );
  const handle = await fsp.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const header = Buffer.alloc(4);
    assert.equal((await handle.read(header, 0, 4, 0)).bytesRead, 4);
    assert.ok(
      [
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca
      ].includes(header.readUInt32BE(0)),
      'Electron Framework real binary must be Mach-O'
    );
  } finally {
    await handle.close();
  }
  return { path: row.path, bytes: row.bytes, sha256: row.sha256, realMachOBinaryVerified: true };
}

function assertAppInventoryMatches(expected, actual) {
  validateInventory(expected);
  validateInventory(actual);
  const wanted = new Map(expected.entries.map((row) => [row.path, row]));
  const found = new Map(actual.entries.map((row) => [row.path, row]));
  for (const [name, row] of wanted) {
    const mounted = found.get(name);
    assert.ok(mounted, 'Mounted application is missing: ' + name);
    for (const field of ['type', 'mode', 'bytes', 'sha256', 'target'])
      assert.equal(
        mounted[field],
        row[field],
        'Mounted application ' + field + ' changed: ' + name
      );
  }
  for (const name of found.keys())
    assert.ok(wanted.has(name), 'Mounted application has an extra entry: ' + name);
  assert.equal(
    actual.sha256,
    expected.sha256,
    'Mounted application inventory differs from the signed source'
  );
  return {
    verified: true,
    sourceInventorySha256: expected.sha256,
    mountedInventorySha256: actual.sha256,
    counts: actual.counts,
    logicalBytes: actual.logicalBytes,
    roundedPayloadBytes: actual.roundedPayloadBytes
  };
}

module.exports = {
  DMG_SIZE,
  DMG_CAPACITY_BYTES,
  MAXIMUM_PAYLOAD_BYTES,
  FRAMEWORK_BINARY,
  snapshotAppInventory,
  validateInventory,
  dmgCapacityProof,
  requireFrameworkBinary,
  assertAppInventoryMatches
};
