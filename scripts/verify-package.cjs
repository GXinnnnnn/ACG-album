'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const builderRequire = createRequire(require.resolve('electron-builder'));
const asarRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = asarRequire('@electron/asar');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
async function walk(dir) {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...(await walk(file)));
    else if (item.isFile()) result.push({ file, bytes: (await fs.stat(file)).size });
  }
  return result;
}
(async () => {
  const installed = require('./distribution-paths.cjs').runtimeDirectory();
  const archive = path.join(installed, 'resources/app.asar');
  const entries = asar
    .listPackage(archive)
    .map((name) => name.replaceAll('\\', '/').replace(/^\//, ''));
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'src/assets/licenses/manifest.json'), 'utf8')
  );
  const extract = (name) => asar.extractFile(archive, name.replaceAll('/', path.sep));
  const report = {
    version: require('../package.json').version,
    sourceFiles: 0,
    licenseArtifacts: 0
  };
  for (const { file } of await walk(path.join(root, 'src'))) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (relative.startsWith('src/demo/')) continue;
    if (relative.startsWith('src/vendor/libheif/')) {
      const target = path.join(
        installed,
        'resources/codecs/libheif',
        path.relative(path.join(root, 'src/vendor/libheif'), file)
      );
      assert.equal(hash(await fs.readFile(target)), hash(await fs.readFile(file)), relative);
      report.sourceFiles++;
      continue;
    }
    const privateFont = /^src\/assets\/fonts\/founder-lanting-yuan\/[^/]+\.ttf$/i.test(relative);
    if (privateFont && !entries.includes(relative)) continue;
    assert.equal(hash(extract(relative)), hash(await fs.readFile(file)), relative);
    report.sourceFiles++;
  }
  for (const artifact of manifest.artifacts) {
    const buffer = extract('src/assets/licenses/' + artifact.file);
    assert.equal(buffer.length, artifact.bytes, artifact.file);
    assert.equal(hash(buffer), artifact.sha256, artifact.file);
    report.licenseArtifacts++;
  }
  for (const name of [
    'prettier',
    '@playwright/test',
    'playwright',
    'playwright-core',
    'electron-builder'
  ]) {
    assert.equal(
      entries.some((entry) => entry.startsWith('node_modules/' + name + '/')),
      false,
      'development package: ' + name
    );
  }
  for (const name of ['tests', 'scripts', 'artifacts', '.review-data', 'src/demo']) {
    assert.equal(
      entries.some((entry) => entry.startsWith(name + '/')),
      false,
      'excluded directory: ' + name
    );
  }
  const metadata = require('../package.json');
  assert.equal(metadata.build.productName, 'ACG-album');
  assert.ok((await fs.stat(path.join(installed, `${metadata.build.productName}.exe`))).isFile());
  const packagedMetadata = JSON.parse(extract('package.json'));
  assert.equal(packagedMetadata.version, report.version);
  assert.equal(packagedMetadata.name, metadata.name);
  const packagedHtml = extract('src/ui/index.html').toString('utf8');
  assert.match(packagedHtml, /<title>ACG-album<\/title>/);
  for (const [source, target] of [
    ['LICENSE', 'LICENSE.app.txt'],
    ['README.md', 'README.md']
  ]) {
    assert.equal(
      hash(await fs.readFile(path.join(installed, target))),
      hash(await fs.readFile(path.join(root, source))),
      target
    );
  }
  for (const { file } of await walk(path.join(root, 'docs'))) {
    const relative = path.relative(root, file);
    assert.equal(
      hash(await fs.readFile(path.join(installed, relative))),
      hash(await fs.readFile(file)),
      relative
    );
  }
  const chromium = await fs.readFile(path.join(installed, 'LICENSES.chromium.html'));
  assert.equal(chromium.length, manifest.chromium.bytes);
  assert.equal(hash(chromium), manifest.chromium.sha256);
  const files = await walk(installed);
  for (const native of manifest.nativeBinaries) {
    const entry = files.find((entry) => path.basename(entry.file) === native.file);
    assert.ok(entry && entry.file.includes('app.asar.unpacked'), native.file);
    assert.equal(entry.bytes, native.bytes);
    assert.equal(hash(await fs.readFile(entry.file)), native.sha256);
  }
  report.credits = Object.values(JSON.parse(extract('src/assets/credits.json'))).flat().length;
  report.installedBytes = files.reduce((sum, entry) => sum + entry.bytes, 0);
  const archiveBytes = await fs.readFile(archive);
  report.asar = { bytes: archiveBytes.length, sha256: hash(archiveBytes) };
  report.chromiumLicenseBytes = chromium.length;
  const output = path.join(root, 'artifacts/release-verification');
  await fs.mkdir(output, { recursive: true });
  if (process.argv.includes('--installer')) {
    const baseline = JSON.parse(
      await fs.readFile(path.join(output, `${report.version}-directory.json`), 'utf8')
    );
    assert.equal(
      report.asar.sha256,
      baseline.asar.sha256,
      'installer ASAR must match the GUI-tested directory build'
    );
    const name = `${require('../package.json').build.productName} Setup ${report.version}.exe`;
    const bytes = await fs.readFile(
      path.join(require('./distribution-paths.cjs').installerDirectory(), name)
    );
    report.installer = { name, bytes: bytes.length, sha256: hash(bytes) };
    await fs.writeFile(
      path.join(require('./distribution-paths.cjs').installerDirectory(), name + '.sha256'),
      report.installer.sha256 + '  ' + name + '\n'
    );
  }
  await fs.writeFile(
    path.join(output, `${report.version}-${report.installer ? 'installer' : 'directory'}.json`),
    JSON.stringify(report, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
