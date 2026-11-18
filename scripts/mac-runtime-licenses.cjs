'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sourceLock = require('./mac-native-sources.json');
const archiveLicenses = require('./mac-runtime-license-sources.json');
const { assertDarwinVersions } = require('./mac-native-sources.cjs');
const { digest, safeArchivePath } = require('./mac-support.cjs');

const licenseName = /^(?:licen[cs]e|notice|copying|copyright)(?:[.-]|$)/i;
const supplementReason =
  'The exact npm Darwin libvips 1.2.4 archive contains a Licensing table but no license text; full texts are supplied from the hash-locked matching component sources, not from the npm archive.';

function licenseSupplementPlan(metadata, versions) {
  assert.ok(
    /^@img\/sharp-libvips-darwin-(?:arm64|x64)$/.test(metadata.name) &&
      metadata.version === '1.2.4' &&
      metadata.license === 'LGPL-3.0-or-later',
    'Missing runtime package license: ' + metadata.name
  );
  assertDarwinVersions(versions);
  const shared = sourceLock.reusedFiles
    .filter(
      (row) =>
        ['notices/LICENSE', 'notices/LGPL-3.0.txt', 'notices/GPL-3.0.txt'].includes(row.path) ||
        row.path.startsWith('notices/native/')
    )
    .map((row) => ({
      ...row,
      path: 'shared/' + row.path,
      file:
        row.path === 'notices/LICENSE'
          ? 'LICENSE-LGPL-2.1.txt'
          : row.path === 'notices/LGPL-3.0.txt'
            ? 'LICENSE-LGPL-3.0.txt'
            : row.path === 'notices/GPL-3.0.txt'
              ? 'LICENSE-GPL-3.0.txt'
              : row.path
    }));
  assert.ok(shared.some((row) => row.file === 'LICENSE-LGPL-3.0.txt'));
  assert.ok(shared.some((row) => row.file === 'LICENSE-GPL-3.0.txt'));
  return [
    ...shared,
    ...archiveLicenses.map((row) => ({
      ...row,
      file: 'darwin-source-notices/' + row.member
    }))
  ];
}

function verifyLicensePayload(data, expected) {
  assert.ok(data.length > 0, 'Empty license text: ' + expected.file);
  assert.equal(data.length, expected.bytes, 'License byte count mismatch: ' + expected.file);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(sha256, expected.sha256, 'License SHA256 mismatch: ' + expected.file);
  return { bytes: data.length, sha256 };
}

async function readSupplement(directory, row) {
  if (!row.archive) {
    assert.ok(safeArchivePath(row.path));
    const filename = path.join(directory, ...row.path.split('/'));
    assert.ok((await fsp.lstat(filename)).isFile(), 'Missing license text: ' + row.path);
    return fsp.readFile(filename);
  }
  assert.ok(safeArchivePath(row.archive) && safeArchivePath(row.member));
  const archiveRecord = sourceLock.additionalFiles.find(
    (entry) => 'darwin/' + entry.path === row.archive
  );
  assert.ok(archiveRecord, 'Unpinned license source archive');
  const filename = path.join(directory, ...row.archive.split('/'));
  const stat = await fsp.lstat(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'License source archive must be a real file');
  assert.equal(stat.size, archiveRecord.bytes);
  assert.equal(
    await digest(filename),
    archiveRecord.sha256,
    'License source archive SHA256 mismatch'
  );
  // Keep raw bytes, including the final newline; the ordinary command helper trims stdout.
  const extracted = spawnSync('tar', ['-xOf', filename, row.member], { maxBuffer: 1024 * 1024 });
  if (extracted.error) throw extracted.error;
  assert.equal(extracted.status, 0, 'Cannot read license member: ' + row.member);
  return extracted.stdout;
}

async function writeRuntimeLicenses(stage, resources, packages, sourceDirectory) {
  const directory = path.join(resources, 'licenses', 'mac-runtime');
  await fsp.mkdir(directory, { recursive: true });
  const inventory = [];
  for (const row of packages) {
    const source = path.join(stage, 'node_modules', ...row.name.split('/'));
    const metadata = JSON.parse(await fsp.readFile(path.join(source, 'package.json'), 'utf8'));
    assert.equal(metadata.name, row.name);
    assert.equal(metadata.version, row.version);
    const destination = path.join(directory, row.name.replaceAll('/', '__'));
    await fsp.mkdir(destination);
    const names = (await fsp.readdir(source, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && licenseName.test(entry.name))
      .map((entry) => entry.name);
    const records = [];
    if (!names.length) {
      const versions = /^@img\/sharp-libvips-darwin-(?:arm64|x64)$/.test(row.name)
        ? JSON.parse(await fsp.readFile(path.join(source, 'versions.json'), 'utf8'))
        : undefined;
      const supplements = licenseSupplementPlan(metadata, versions);
      for (const required of ['package.json', 'README.md', 'versions.json']) {
        const stat = await fsp.lstat(path.join(source, required));
        assert.ok(
          stat.isFile() && stat.size > 0,
          'Missing original Darwin package notice: ' + required
        );
      }
      assert.ok(sourceDirectory, 'Missing verified license source directory');
      for (const expected of supplements) {
        const data = await readSupplement(sourceDirectory, expected);
        const actual = verifyLicensePayload(data, expected);
        const target = path.join(destination, ...expected.file.split('/'));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, data, { flag: 'wx' });
        const sourceArchive =
          expected.archive &&
          sourceLock.additionalFiles.find((entry) => 'darwin/' + entry.path === expected.archive);
        records.push({
          file: expected.file,
          ...actual,
          supplementReason,
          source: {
            file: 'native-sources/' + (expected.path || expected.archive),
            manifest: 'native-sources/manifest.json',
            ...(expected.member
              ? {
                  member: expected.member,
                  memberManifest: 'licenses/mac-runtime/source-license-members.json',
                  archiveBytes: sourceArchive.bytes,
                  archiveSha256: sourceArchive.sha256
                }
              : {}),
            bytes: expected.bytes,
            sha256: expected.sha256
          }
        });
      }
    }
    for (const name of [...names, 'package.json', 'README.md', 'versions.json']) {
      const filename = path.join(source, name);
      if (!fs.existsSync(filename) || !(await fsp.lstat(filename)).isFile()) continue;
      const bytes = (await fsp.stat(filename)).size;
      assert.ok(bytes > 0, 'Empty runtime package notice: ' + row.name + '/' + name);
      await fsp.copyFile(filename, path.join(destination, name), fs.constants.COPYFILE_EXCL);
      records.push({
        file: name,
        bytes,
        sha256: await digest(filename),
        source: { package: row.name, file: name, integrity: row.integrity }
      });
    }
    assert.ok(
      records.some((record) => licenseName.test(record.file)),
      'Missing runtime package license: ' + row.name
    );
    inventory.push({
      ...row,
      license: metadata.license,
      repository: metadata.repository,
      files: records
    });
  }
  const result = {
    packages: inventory,
    nativeSource: {
      sharp: 'https://github.com/lovell/sharp/tree/v0.34.5',
      libvipsBundle: 'https://github.com/lovell/sharp-libvips/tree/v1.2.4',
      libvips: 'https://github.com/libvips/libvips/tree/v8.17.3',
      notices: 'https://github.com/lovell/sharp-libvips/blob/v1.2.4/THIRD-PARTY-NOTICES.md'
    }
  };
  await fsp.writeFile(
    path.join(directory, 'source-license-members.json'),
    JSON.stringify(archiveLicenses, null, 2) + '\n'
  );
  await fsp.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify(result, null, 2) + '\n'
  );
  return result;
}

module.exports = { licenseSupplementPlan, verifyLicensePayload, writeRuntimeLicenses };
