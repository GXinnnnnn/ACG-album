'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const {
  FULL,
  runtimePackages,
  nativePattern,
  lockIntegrity,
  validateManifest,
  archivePaths,
  safeArchivePath,
  builderConfig,
  download,
  binaryKind,
  asarTool
} = require('../scripts/mac-support.cjs');
const root = path.resolve(__dirname, '..');
const fromBuilder = createRequire(
  require.resolve('app-builder-lib', {
    paths: [path.dirname(require.resolve('electron-builder'))]
  })
);

test('mac config passes the exact installed electron-builder schema and isolates Windows resources', async () => {
  const config = builderConfig({
    root,
    stage: path.join(root, 'release', 'mac-unit-stage'),
    output: path.join(root, 'release', 'mac-unit-output'),
    afterPack: async () => {}
  });
  await fromBuilder('app-builder-lib/out/util/config/config.js').validateConfiguration(config, {
    isEnabled: false
  });
  assert.equal(config.extends, null);
  assert.equal(config.electronVersion, '40.10.6');
  assert.equal(config.win, undefined);
  assert.equal(config.nsis, undefined);
  assert.equal(config.extraFiles, undefined, 'macOS static data must not be copied to Contents/');
  for (const [source, destination] of [
    ['LICENSE', 'LICENSE.app.txt'],
    ['README.md', 'README.md'],
    ['docs', 'docs']
  ]) {
    assert.deepEqual(
      config.extraResources.find((row) => row.from === path.join(root, source)),
      { from: path.join(root, source), to: destination },
      'Keep each complete document payload in Contents/Resources: ' + source
    );
  }
  assert.ok(!config.extraResources.some((row) => /local-index/.test(row.from + row.to)));
  assert.ok(
    config.extraResources.some(
      (row) =>
        row.to === 'codecs/libheif' && row.from.endsWith(path.join('src', 'vendor', 'libheif'))
    )
  );
  assert.equal(config.mac.minimumSystemVersion, '12.0');
  assert.equal(config.mac.identity, '-');
  assert.equal(config.dmg.sign, false);
  assert.equal(config.asar, true);
  assert.equal(config.mac.mergeASARs, true);
  assert.equal(config.npmRebuild, false);
  assert.equal(config.artifactName, 'ACG-album-Setup-1.2.3-Full-universal.${ext}');
});

async function macBundleFixture(t) {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'acg-mac-docs-test-'));
  t.after(async () => {
    assert.equal(path.dirname(temporary), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('acg-mac-docs-test-'));
    await fsp.rm(temporary, { recursive: true });
  });
  const contents = path.join(temporary, 'ACG-album.app', 'Contents');
  const resources = path.join(contents, 'Resources');
  await fsp.mkdir(path.join(resources, 'docs'), { recursive: true });
  for (const filename of [
    'LICENSE.app.txt',
    'README.md',
    'docs/THIRD_PARTY_NOTICES.md',
    'docs/LOCAL_SEARCH_DATA.md'
  ])
    await fsp.writeFile(path.join(resources, filename), 'complete fixture notice\n');
  return { contents, resources };
}

test('physical bundle accepts complete Resources documents and standard Apple Contents directories', async (t) => {
  const { assertMacContentsLayout } = require('../scripts/check-mac-full.cjs');
  const { contents, resources } = await macBundleFixture(t);
  for (const name of [
    'MacOS',
    'Frameworks',
    'SharedFrameworks',
    'SharedSupport',
    'PlugIns',
    'XPCServices',
    'Helpers',
    'Library',
    '_CodeSignature'
  ])
    await fsp.mkdir(path.join(contents, name));
  for (const name of ['Info.plist', 'PkgInfo'])
    await fsp.writeFile(path.join(contents, name), 'fixture metadata\n');
  const entries = await fsp.readdir(contents);
  assert.doesNotThrow(() => assertMacContentsLayout(entries));
  assert.equal(
    await fsp.readFile(path.join(resources, 'README.md'), 'utf8'),
    'complete fixture notice\n'
  );
});

test('physical bundle rejects misplaced README, application license and docs at Contents root', async (t) => {
  const { assertMacContentsLayout } = require('../scripts/check-mac-full.cjs');
  for (const filename of ['README.md', 'LICENSE.app.txt', 'docs']) {
    const { contents } = await macBundleFixture(t);
    if (filename === 'docs') await fsp.mkdir(path.join(contents, filename));
    else await fsp.writeFile(path.join(contents, filename), 'misplaced notice\n');
    const entries = await fsp.readdir(contents);
    assert.throws(
      () => assertMacContentsLayout(entries),
      (error) => {
        assert.match(error.message, /static data belongs in Resources/);
        assert.ok(error.message.endsWith(filename));
        return true;
      }
    );
  }
});

test('universal exception matches only architecture-named sharp binaries in unpacked and ASAR paths', () => {
  const { minimatch } = fromBuilder('minimatch');
  for (const arch of ['arm64', 'x64']) {
    for (const name of ['sharp', 'sharp-libvips']) {
      for (const prefix of ['Contents/Resources/app.asar.unpacked/', '/']) {
        assert.equal(
          minimatch(
            `${prefix}node_modules/@img/${name}-darwin-${arch}/lib/native.node`,
            nativePattern
          ),
          true
        );
      }
    }
  }
  for (const name of ['sharp-win32-x64', 'sharp-linux-x64', 'untrusted-darwin-x64'])
    assert.equal(
      minimatch(
        `Contents/Resources/app.asar.unpacked/node_modules/@img/${name}/lib/native.node`,
        nativePattern
      ),
      false
    );
  assert.equal(
    minimatch('Contents/Frameworks/Electron Framework.framework/Electron Framework', nativePattern),
    false
  );
});

test('all runtime tarballs have locked SHA512 and both sharp architectures are pinned', () => {
  const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  for (const [name, version] of Object.entries(runtimePackages))
    assert.equal(Buffer.from(lockIntegrity(lock, name, version), 'base64').length, 64, name);
  assert.throws(() => lockIntegrity(lock, 'sharp', '0.34.6'), /Missing locked SHA512/);
  assert.equal(runtimePackages['@img/sharp-darwin-arm64'], '0.34.5');
  assert.equal(runtimePackages['@img/sharp-darwin-x64'], '0.34.5');
  assert.equal(runtimePackages['@img/sharp-libvips-darwin-arm64'], '1.2.4');
  assert.equal(runtimePackages['@img/sharp-libvips-darwin-x64'], '1.2.4');
  assert.ok(!Object.keys(runtimePackages).some((name) => /win32|linux/.test(name)));
});

test('Full manifest rejects variant, database and byte identity substitutions', () => {
  const trusted = {
    variant: 'full',
    bundled: true,
    readerSchemaVersion: 1,
    database: 'subjects.sqlite',
    bytes: FULL.bytes,
    sha256: FULL.sha256
  };
  assert.equal(validateManifest(trusted), trusted);
  for (const changes of [
    { variant: 'lite' },
    { bundled: false },
    { readerSchemaVersion: 2 },
    { database: '../subjects.sqlite' },
    { bytes: FULL.bytes - 1 },
    { sha256: '0'.repeat(64) }
  ])
    assert.throws(() => validateManifest({ ...trusted, ...changes }), /trusted database/);
});

test('archive listing supports Windows separators and rejects escaping archive paths', () => {
  assert.deepEqual(
    archivePaths(
      'Path = $PLUGINSDIR\\app-64.7z\r\nSize = 4\r\nPath = resources\\local-index\\subjects.sqlite'
    ),
    ['$PLUGINSDIR/app-64.7z', 'resources/local-index/subjects.sqlite']
  );
  for (const value of ['../data', '/root/data', 'C:/data', 'resources/../../data', './data', ''])
    assert.equal(!!safeArchivePath(value), false, value);
  assert.equal(safeArchivePath('resources/local-index/subjects.sqlite'), true);
});

test('streaming download verifies bytes and refuses to overwrite an existing file', async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'acg-mac-download-test-'));
  const filename = path.join(directory, 'verified.bin');
  const payload = Buffer.from('trusted macOS payload');
  const expected = crypto.createHash('sha256').update(payload).digest('hex');
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    body: (async function* () {
      yield payload.subarray(0, 4);
      yield payload.subarray(4);
    })()
  });
  try {
    await download('https://example.invalid/full', filename, expected);
    assert.deepEqual(await fsp.readFile(filename), payload);
    await assert.rejects(download('https://example.invalid/full', filename, expected), {
      code: 'EEXIST'
    });
    await assert.rejects(
      download('https://example.invalid/full', path.join(directory, 'bad.bin'), '0'.repeat(64)),
      /integrity mismatch/
    );
  } finally {
    global.fetch = originalFetch;
    // Exactly the new temp directory owned by this test; never a repository or user-data path.
    assert.equal(path.dirname(directory), os.tmpdir());
    assert.ok(path.basename(directory).startsWith('acg-mac-download-test-'));
    await fsp.rm(directory, { recursive: true });
  }
});

test('CLI cannot report success after rejection or an idle unsettled task', () => {
  const support = JSON.stringify(path.join(root, 'scripts', 'mac-support.cjs'));
  for (const [task, expected] of [
    ['async () => { throw new Error("synthetic build rejection") }', /synthetic build rejection/],
    ['() => new Promise(() => {})', /remained pending/]
  ]) {
    const script = `process.on('beforeExit', () => { process.exitCode = 0; }); require(${support}).runCli(${task});`;
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.signal, null);
    assert.match(result.stderr, expected);
  }
  const success = spawnSync(
    process.execPath,
    ['-e', `require(${support}).runCli(async () => 42)`],
    { encoding: 'utf8', timeout: 10_000 }
  );
  assert.ifError(success.error);
  assert.equal(success.status, 0);
});

test('binary detector distinguishes Mach-O and Windows PE headers and ASAR tooling resolves', () => {
  assert.equal(binaryKind(Buffer.from('4d5a9000', 'hex')), 'pe');
  for (const magic of ['feedfacf', 'cffaedfe', 'cafebabe', 'cafebabf'])
    assert.equal(binaryKind(Buffer.from(magic, 'hex')), 'macho');
  assert.equal(binaryKind(Buffer.from('OTTO')), null);
  assert.equal(typeof asarTool().listPackage, 'function');
});
