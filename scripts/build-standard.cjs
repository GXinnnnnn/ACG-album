'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { build, Platform, Arch } = require('electron-builder');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const releaseRoot = path.resolve(
  process.env.ACG_RELEASE_OUTPUT || path.join(root, 'release', metadata.version)
);
const out = path.join(releaseRoot, 'standard');
const installer = path.join(out, `ACG-album-Setup-${metadata.version}-Standard.exe`);

async function digest(file) {
  const sha = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) sha.update(chunk);
  return sha.digest('hex');
}
async function sourceSnapshot() {
  const rows = [];
  async function walk(directory) {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile())
        rows.push({ file: path.relative(root, file), sha256: await digest(file) });
    }
  }
  await walk(path.join(root, 'src'));
  await walk(path.join(root, 'docs'));
  for (const file of ['package.json', 'README.md', 'LICENSE'])
    rows.push({ file, sha256: await digest(path.join(root, file)) });
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}
async function assertNoLocalIndex(directory) {
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    assert.notEqual(
      entry.name.toLowerCase(),
      'local-index',
      'Standard must not contain local-index: ' + directory
    );
    if (entry.isDirectory()) await assertNoLocalIndex(path.join(directory, entry.name));
  }
}

(async () => {
  assert.equal(process.argv.length, 2, 'Usage: node scripts/build-standard.cjs');
  assert.match(metadata.version, /^\d+\.\d+\.\d+$/, 'A stable release version is required');
  assert.equal(metadata.build.appId, 'local.acg.album');
  assert.ok(!fs.existsSync(installer), 'Refusing to overwrite an existing installer: ' + installer);
  assert.ok(
    !/local-index/i.test(JSON.stringify(metadata.build.extraResources)),
    'Unexpected index resource in base configuration'
  );
  const before = await sourceSnapshot();
  const runtimeSnapshot = (snapshot) =>
    snapshot.filter((row) => row.file === 'package.json' || /^src[\\/]/.test(row.file));
  const variantComparison = [];
  for (const variant of ['lite', 'full']) {
    const existing = path.join(releaseRoot, variant, 'build-report.json');
    if (!fs.existsSync(existing)) continue;
    const previous = JSON.parse(await fsp.readFile(existing, 'utf8'));
    assert.deepEqual(
      runtimeSnapshot(before),
      runtimeSnapshot(previous.sourceSnapshot),
      'Runtime src/package must match existing ' + variant + ' edition'
    );
    const previousHashes = new Map(previous.sourceSnapshot.map((row) => [row.file, row.sha256]));
    variantComparison.push({
      variant,
      runtimeSourceMatches: true,
      changedSnapshotFiles: before
        .filter((row) => previousHashes.get(row.file) !== row.sha256)
        .map((row) => row.file)
    });
  }
  await fsp.mkdir(out, { recursive: true });
  console.log('BUILD standard ' + metadata.version);
  const artifacts = await build({
    projectDir: root,
    targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never',
    config: {
      ...metadata.build,
      directories: { ...metadata.build.directories, output: out },
      artifactName: `ACG-album-Setup-${metadata.version}-Standard.` + '${ext}',
      extraMetadata: { searchEdition: 'standard' },
      extraResources: [...metadata.build.extraResources],
      nsis: { ...metadata.build.nsis, differentialPackage: false }
    }
  });
  assert.deepEqual(
    await sourceSnapshot(),
    before,
    'Source changed while building; do not deliver inconsistent editions.'
  );
  const runtime = path.join(out, 'win-unpacked');
  await assertNoLocalIndex(path.join(runtime, 'resources'));
  const report = {
    version: metadata.version,
    variant: 'standard',
    appId: metadata.build.appId,
    createdAt: new Date().toISOString(),
    installer,
    bytes: (await fsp.stat(installer)).size,
    sha256: await digest(installer),
    runtime,
    index: null,
    noLocalIndex: true,
    differentialPackage: false,
    sourceSnapshot: before,
    variantComparison,
    artifacts
  };
  await fsp.writeFile(path.join(out, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  await fsp.writeFile(installer + '.sha256', `${report.sha256}  ${path.basename(installer)}\n`);
  console.log(
    'BUILT ' +
      JSON.stringify({ variant: 'standard', installer, bytes: report.bytes, sha256: report.sha256 })
  );
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
