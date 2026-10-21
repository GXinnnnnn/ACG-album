'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { build, Platform, Arch } = require('electron-builder');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
const indexRoot = path.resolve(
  process.env.ACG_INDEX_SOURCE || path.join(root, '..', '资料归档', 'local-index-pilot-2026-10-20')
);
const outputRoot = path.resolve(
  process.env.ACG_RELEASE_OUTPUT || path.join(root, 'release', metadata.version)
);
const args = process.argv.slice(2);
if (args.some((arg) => !['lite', 'full'].includes(arg)) || new Set(args).size !== args.length)
  throw new Error('Usage: node scripts/build-search-editions.cjs [lite] [full]');
const variants = args.length ? args : ['lite', 'full'];

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

(async () => {
  const sourceManifest = JSON.parse(
    await fsp.readFile(path.join(indexRoot, 'packages', 'manifest.draft.json'), 'utf8')
  );
  const before = await sourceSnapshot();
  const reports = [];
  for (const variant of variants) {
    const data = sourceManifest.variants.find((row) => row.id === variant);
    if (!data) throw new Error('Unknown index variant: ' + variant);
    const database = path.join(
      indexRoot,
      variant === 'lite' ? 'subjects-lite.sqlite' : 'subjects.sqlite'
    );
    const label = variant === 'lite' ? 'Lite' : 'Full';
    const out = path.join(outputRoot, variant);
    const installer = path.join(out, `ACG-album-Setup-${metadata.version}-${label}.exe`);
    if (fs.existsSync(installer))
      throw new Error('Refusing to overwrite an existing installer: ' + installer);
    console.log(`VERIFY ${variant} database`);
    if (
      (await fsp.stat(database)).size !== data.uncompressedBytes ||
      (await digest(database)) !== data.uncompressedSha256
    )
      throw new Error('Index integrity mismatch: ' + variant);
    await fsp.mkdir(out, { recursive: true });
    const manifest = {
      manifestVersion: 1,
      readerSchemaVersion: sourceManifest.readerSchemaVersion,
      variant,
      dataVersion: sourceManifest.dataVersion,
      bundled: true,
      database: 'subjects.sqlite',
      bytes: data.uncompressedBytes,
      sha256: data.uncompressedSha256,
      counts: data.counts,
      rawRecordsPreserved: data.rawRecordsPreserved,
      source: sourceManifest.source,
      attribution: 'Bangumi community / bangumi/Archive; see docs/LOCAL_SEARCH_DATA.md'
    };
    const manifestPath = path.join(out, 'index-manifest.json');
    await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(`BUILD ${variant} ${metadata.version}`);
    const artifacts = await build({
      projectDir: root,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        ...metadata.build,
        directories: { ...metadata.build.directories, output: out },
        artifactName: `ACG-album-Setup-${metadata.version}-${label}.` + '${ext}',
        extraMetadata: { searchEdition: variant },
        extraResources: [
          ...metadata.build.extraResources,
          { from: database, to: 'local-index/subjects.sqlite' },
          { from: manifestPath, to: 'local-index/manifest.json' },
          { from: path.join(root, 'docs', 'LOCAL_SEARCH_DATA.md'), to: 'local-index/SOURCE.md' }
        ],
        nsis: { ...metadata.build.nsis, differentialPackage: false }
      }
    });
    const after = await sourceSnapshot();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error('Source changed while building; do not deliver inconsistent editions.');
    const bundled = path.join(out, 'win-unpacked', 'resources', 'local-index', 'subjects.sqlite');
    if (
      (await fsp.stat(bundled)).size !== data.uncompressedBytes ||
      (await digest(bundled)) !== data.uncompressedSha256
    )
      throw new Error('Bundled index mismatch: ' + variant);
    const report = {
      version: metadata.version,
      variant,
      createdAt: new Date().toISOString(),
      installer,
      bytes: (await fsp.stat(installer)).size,
      sha256: await digest(installer),
      runtime: path.join(out, 'win-unpacked'),
      index: manifest,
      sourceSnapshot: before,
      artifacts
    };
    await fsp.writeFile(
      path.join(out, 'build-report.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
    await fsp.writeFile(installer + '.sha256', `${report.sha256}  ${path.basename(installer)}\n`);
    reports.push(report);
    console.log(
      'BUILT ' + JSON.stringify({ variant, installer, bytes: report.bytes, sha256: report.sha256 })
    );
  }
  await fsp.writeFile(
    path.join(outputRoot, 'build-report.json'),
    JSON.stringify({ version: metadata.version, reports }, null, 2) + '\n'
  );
})().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
