'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  validateReadOnlyVolume,
  verifyReadOnlyWriteProbe
} = require('../scripts/check-mac-readonly-index.cjs');

test('diskutil must explicitly describe non-writable APFS without contradictory volume flags', () => {
  validateReadOnlyVolume({ FilesystemType: 'apfs', Writable: false });
  validateReadOnlyVolume({ FilesystemType: 'APFS', Writable: false, WritableVolume: false });
  for (const value of [undefined, null, true, 0, 'false']) {
    assert.throws(() => validateReadOnlyVolume({ FilesystemType: 'apfs', Writable: value }));
  }
  assert.throws(() =>
    validateReadOnlyVolume({ FilesystemType: 'apfs', Writable: false, WritableVolume: true })
  );
  assert.throws(() => validateReadOnlyVolume({ FilesystemType: 'hfs', Writable: false }));
  assert.throws(() => validateReadOnlyVolume({ FilesystemType: 'apfs', ReadOnlyVolume: true }));
});

test('write probe accepts only an actual EROFS failure and uses exclusive unique markers', async () => {
  const markers = [];
  const io = {
    async open(marker, flags) {
      markers.push(marker);
      assert.equal(flags, 'wx');
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    }
  };
  for (let i = 0; i < 2; i++)
    assert.deepEqual(await verifyReadOnlyWriteProbe(os.tmpdir(), io), {
      code: 'EROFS',
      syscall: 'open',
      flags: 'wx',
      creationRejected: true
    });
  assert.notEqual(markers[0], markers[1]);
  assert.equal(path.dirname(markers[0]), os.tmpdir());
  assert.match(path.basename(markers[0]), /^\.acg-readonly-probe-[a-f0-9-]{36}$/);
});

test('permissions, collision and unknown errors cannot establish a read-only filesystem', async () => {
  for (const code of ['EACCES', 'EPERM', 'EEXIST', 'EIO', undefined]) {
    await assert.rejects(
      verifyReadOnlyWriteProbe(os.tmpdir(), {
        async open() {
          throw Object.assign(new Error('fixture error'), { code });
        }
      })
    );
  }
});

test('a real writable directory fails validation after removing only its own marker', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-readonly-marker-test-'));
  try {
    await fs.writeFile(path.join(folder, 'keep.txt'), 'keep');
    await assert.rejects(verifyReadOnlyWriteProbe(folder), /unexpectedly permitted/);
    assert.deepEqual(await fs.readdir(folder), ['keep.txt']);
    assert.equal(await fs.readFile(path.join(folder, 'keep.txt'), 'utf8'), 'keep');
  } finally {
    await fs.rm(folder, { recursive: true });
  }
});

test('a successful open closes before unlink and cleanup failures remain failures', async () => {
  const order = [];
  await assert.rejects(
    verifyReadOnlyWriteProbe(os.tmpdir(), {
      async open() {
        return {
          async close() {
            order.push('close');
          }
        };
      },
      async unlink() {
        order.push('unlink');
      }
    }),
    /unexpectedly permitted/
  );
  assert.deepEqual(order, ['close', 'unlink']);
  const failure = new Error('cleanup failure');
  await assert.rejects(
    verifyReadOnlyWriteProbe(os.tmpdir(), {
      async open() {
        return { async close() {} };
      },
      async unlink() {
        throw failure;
      }
    }),
    (error) => error === failure
  );
});
