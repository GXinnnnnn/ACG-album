'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const lock = require('./mac-native-sources.json');
const {
  run,
  digest,
  download,
  archivePaths,
  safeArchivePath,
  walkFiles
} = require('./mac-support.cjs');

function assertDarwinVersions(actual) {
  assert.deepEqual(
    actual,
    lock.versions,
    'Actual Darwin libvips component versions must match corresponding sources'
  );
}
function sourceRecords() {
  return [
    ...lock.reusedFiles.map((row) => ({ ...row, path: 'shared/' + row.path })),
    ...lock.additionalFiles.map((row) => ({ ...row, path: 'darwin/' + row.path }))
  ];
}
async function verifySourceFiles(directory) {
  const records = sourceRecords();
  for (const row of records) {
    assert.ok(safeArchivePath(row.path), 'Unsafe source record');
    const filename = path.join(directory, ...row.path.split('/'));
    const stat = await fsp.lstat(filename);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), row.path);
    assert.equal(stat.size, row.bytes, row.path);
    assert.equal(await digest(filename), row.sha256, row.path);
  }
  return {
    files: records.length,
    bytes: records.reduce((sum, row) => sum + row.bytes, 0),
    components: Object.keys(lock.versions).length,
    rustStdCommit: lock.rustStd.commit
  };
}
async function acquireNativeArchive(zip) {
  const local = process.env.ACG_MAC_NATIVE_SOURCE_ARCHIVE;
  if (local === undefined) {
    await download(lock.bundle.url, zip, lock.bundle.sha256);
    return;
  }
  assert.ok(local.length > 0 && path.isAbsolute(local), 'Native source input must be an absolute archive path');
  const before = await fsp.lstat(local, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink(), 'Native source input must be a regular non-symlink file');
  const resolved = await fsp.realpath(local);
  const destination = path.join(await fsp.realpath(path.dirname(zip)), path.basename(zip));
  assert.notEqual(resolved, destination, 'Native source input must not alias its destination');
  // An existing destination (including a hardlink or symlink) is always an error.
  const existing = await fsp.lstat(zip).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  assert.equal(existing, null, 'Native source destination must be fresh');
  const source = await fsp.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const identity = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs];
    const opened = await source.stat({ bigint: true });
    const named = await fsp.lstat(local, { bigint: true });
    assert.ok(opened.isFile() && named.isFile() && !named.isSymbolicLink());
    assert.deepEqual(identity(opened), identity(named), 'Native source changed while opening');
    assert.deepEqual(identity(opened), identity(before), 'Native source changed before opening');
    assert.equal(opened.size, BigInt(lock.bundle.bytes));
    assert.equal(await fsp.realpath(local), resolved, 'Native source path changed');
    const target = await fsp.open(zip, 'wx');
    try {
      // Copy from the checked descriptor, not by reopening a mutable source path.
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let total = 0;
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        assert.ok(total <= lock.bundle.bytes, 'Native source input grew');
        await target.writeFile(buffer.subarray(0, bytesRead));
      }
      assert.equal(total, lock.bundle.bytes);
      await target.sync();
      const written = await target.stat({ bigint: true });
      assert.equal(written.size, BigInt(lock.bundle.bytes));
      assert.deepEqual(identity(await source.stat({ bigint: true })), identity(opened), 'Native source changed during copy');
      assert.deepEqual(identity(await fsp.lstat(local, { bigint: true })), identity(opened), 'Native source path changed during copy');
      assert.equal(await fsp.realpath(local), resolved);
      assert.equal(await digest(zip), lock.bundle.sha256, 'Actual copied native source archive SHA-256');
      assert.deepEqual(identity(await fsp.lstat(zip, { bigint: true })), identity(written), 'Native source destination changed');
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}
async function prepareNativeSources(input, stage, seven) {
  for (const arch of ['arm64', 'x64']) {
    const file = path.join(
      stage,
      'node_modules',
      '@img',
      'sharp-libvips-darwin-' + arch,
      'versions.json'
    );
    assertDarwinVersions(JSON.parse(await fsp.readFile(file, 'utf8')));
  }
  const zip = path.join(input, 'trusted-native-sources.zip');
  await acquireNativeArchive(zip);
  assert.equal((await fsp.stat(zip)).size, lock.bundle.bytes);
  const paths = archivePaths(run(seven, ['l', '-slt', zip]));
  const selected = paths.filter((name) => name.startsWith(lock.bundle.prefix));
  assert.ok(selected.length > 0);
  assert.ok(selected.every(safeArchivePath));
  const unpacked = path.join(input, 'native-source-extract');
  await fsp.mkdir(unpacked);
  run(seven, ['x', '-y', '-bsp0', '-bso0', '-o' + unpacked, zip, lock.bundle.prefix + '*']);
  const directory = path.join(input, 'native-sources');
  await fsp.mkdir(directory);
  for (const row of lock.reusedFiles) {
    assert.ok(safeArchivePath(row.path));
    const original = path.join(
      unpacked,
      ...lock.bundle.prefix.split('/').filter(Boolean),
      ...row.path.split('/')
    );
    const destination = path.join(directory, 'shared', ...row.path.split('/'));
    assert.ok((await fsp.lstat(original)).isFile());
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.copyFile(original, destination, fs.constants.COPYFILE_EXCL);
  }
  for (const row of lock.additionalFiles) {
    assert.ok(safeArchivePath(row.path));
    const filename = path.join(directory, 'darwin', ...row.path.split('/'));
    await fsp.mkdir(path.dirname(filename), { recursive: true });
    await download(row.url, filename, row.sha256);
  }
  const evidence = await verifySourceFiles(directory);
  await fsp.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(lock, null, 2) + '\n');
  await fsp.writeFile(
    path.join(directory, 'README.mac.txt'),
    [
      'ACG-album macOS universal corresponding native source',
      '',
      'Both Darwin sharp 0.34.5 / sharp-libvips 1.2.4 packages were checked against all 28 component versions in manifest.json.',
      'shared/ contains the exact, hash-locked component source archives, Rust crates, licenses, upstream sharp and sharp-libvips build scripts reused from the public v1.2.3 source bundle.',
      'Windows build metadata in shared/ documents reuse and does not describe the Darwin build. Darwin uses sharp-libvips build.sh and build/posix.sh from shared/upstream/sharp-libvips-1.2.4.zip, with platforms/darwin-x64 or platforms/darwin-arm64v8.',
      'darwin/ supplies the patches and gvdb fallback used by posix.sh, plus the exact Rust standard-library source matching /rustc/' +
        lock.rustStd.commit +
        ' in both Darwin dylibs. The older Windows Rust source in shared/ is retained only as original provenance.',
      'Source archive bytes and every patch are in this DMG, not just external download links. manifest.json records file sizes, SHA-256 values and original URLs. shared/notices/ contains component licenses.',
      'The sharp-libvips archive carries the upstream build inputs and scripts. Extract its sources, provide component archives from shared/sources and darwin/sources, Rust crates from shared/rust/crates, and Darwin patches at their recorded paths when rebuilding offline. Build dependencies/toolchain and SDK are not distributed here.',
      'The application atomic rename helper source is app.asar/src/native/macos-rename.c (project MIT license); it is compiled with Apple clang for arm64 and x86_64, deployment target 12.0.',
      'The independent HEIC WASM decoder and its four audited corresponding source archives are in ../codecs/libheif/.',
      '',
      'The native dependency binaries are unmodified npm release binaries; the application has no proprietary bundled font.',
      ''
    ].join('\n')
  );
  return { directory, evidence };
}
async function installNativeSources(prepared, resources) {
  const destination = path.join(resources, 'native-sources');
  await fsp.cp(prepared.directory, destination, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
  return verifyNativeSources(resources);
}
async function verifyNativeSources(resources) {
  const directory = path.join(resources, 'native-sources');
  const manifest = JSON.parse(await fsp.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest, lock, 'Packaged source lock must equal audited checkout');
  const result = await verifySourceFiles(directory);
  const files = await walkFiles(directory);
  assert.equal(files.length, sourceRecords().length + 2, 'No unrecorded source payloads');
  for (const arch of ['arm64', 'x64']) {
    const native = path.join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      '@img',
      'sharp-libvips-darwin-' + arch
    );
    assertDarwinVersions(
      JSON.parse(await fsp.readFile(path.join(native, 'versions.json'), 'utf8'))
    );
    const dylib = (await walkFiles(native)).find((name) => name.endsWith('.dylib'));
    assert.ok(
      (await fsp.readFile(dylib)).includes(Buffer.from('/rustc/' + lock.rustStd.commit)),
      'Darwin Rust std source identity'
    );
  }
  return result;
}

module.exports = {
  assertDarwinVersions,
  sourceRecords,
  verifySourceFiles,
  prepareNativeSources,
  installNativeSources,
  verifyNativeSources
};
