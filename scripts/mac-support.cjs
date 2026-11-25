'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { DMG_SIZE } = require('./mac-bundle-inventory.cjs');

const FULL = Object.freeze({
  version: '1.2.3',
  installer: 'ACG-album-Setup-1.2.3-Full.exe',
  installerBytes: 642170398,
  installerSha256: '45985221536c039be197e9bd7adc3b196a83f9cdd69856e982a5fb7a776d1b7d',
  bytes: 4734013440,
  sha256: 'd4aea4e16c0b2aacf00c2947c66fb8d78428a4a9103f257f4f458e67c77787ff'
});
const runtimePackages = Object.freeze({
  exifr: '7.1.3',
  sharp: '0.34.5',
  '@img/colour': '1.1.0',
  'detect-libc': '2.1.2',
  semver: '7.8.5',
  '@img/sharp-darwin-arm64': '0.34.5',
  '@img/sharp-darwin-x64': '0.34.5',
  '@img/sharp-libvips-darwin-arm64': '1.2.4',
  '@img/sharp-libvips-darwin-x64': '1.2.4'
});
const nativePattern = '**/node_modules/@img/{sharp,sharp-libvips}-darwin-{arm64,x64}/**/*';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr || result.stdout || ''}`
    );
  return result.stdout?.trim() || '';
}
async function digest(filename, algorithm = 'sha256', encoding = 'hex') {
  const hash = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest(encoding);
}
async function download(url, filename, expected, algorithm = 'sha256', encoding = 'hex') {
  // A streaming GET is deliberate: neither a HEAD nor a cached release API response proves bytes.
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60_000)
  });
  if (!response.ok || !response.body) throw new Error(`GET ${url}: ${response.status}`);
  const handle = await fsp.open(filename, 'wx');
  const hash = crypto.createHash(algorithm);
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
  } finally {
    await handle.close();
  }
  if (hash.digest(encoding) !== expected) throw new Error(`Download integrity mismatch: ${url}`);
}
function lockIntegrity(lock, name, version) {
  const key = `${name}@${version}`;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = lock.match(
    new RegExp(
      `^  '?${escaped}'?:\\r?\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
      'm'
    )
  );
  if (!match) throw new Error(`Missing locked SHA512: ${key}`);
  return match[1].slice('sha512-'.length);
}
function validateManifest(manifest) {
  if (
    manifest.variant !== 'full' ||
    manifest.bundled !== true ||
    manifest.readerSchemaVersion !== 1 ||
    manifest.database !== 'subjects.sqlite' ||
    manifest.bytes !== FULL.bytes ||
    manifest.sha256 !== FULL.sha256
  )
    throw new Error('Published Full manifest does not match the trusted database identity');
  return manifest;
}
function archivePaths(listing) {
  return listing
    .split(/\r?\n/)
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice(7).replaceAll('\\', '/'));
}
function safeArchivePath(name) {
  return (
    name &&
    !name.startsWith('/') &&
    !/^[A-Za-z]:/.test(name) &&
    !name.split('/').some((part) => part === '..' || part === '.')
  );
}
function runCli(task) {
  let settled = false;
  const fail = (error) => {
    settled = true;
    fs.writeSync(2, (error?.stack || String(error)) + '\n');
    // builder-util's async-exit-hook can reset process.exitCode at beforeExit.
    // An explicit nonzero exit preserves failure even when that hook is loaded.
    process.exit(1);
  };
  const beforeExit = () => {
    if (!settled) fail(new Error('CLI task remained pending when the event loop became idle'));
  };
  process.once('beforeExit', beforeExit);
  Promise.resolve()
    .then(task)
    .then(() => {
      settled = true;
      process.removeListener('beforeExit', beforeExit);
    }, fail);
}
function builderConfig({ root, stage, output, afterPack }) {
  const metadata = require(path.join(root, 'package.json'));
  return {
    extends: null,
    appId: metadata.build.appId,
    productName: 'ACG-album',
    electronVersion: '40.10.6',
    electronLanguages: metadata.build.electronLanguages,
    directories: { app: stage, output, buildResources: path.join(output, 'build-resources') },
    files: [
      'src/**/*',
      '!src/demo/**/*',
      '!src/vendor/libheif/**/*',
      'package.json',
      '!**/*.{[tT][tT][fF],[oO][tT][fF],[wW][oO][fF][fF],[wW][oO][fF][fF]2,[tT][tT][cC],[oO][tT][cC],[eE][oO][tT]}',
      'src/assets/fonts/source-han-sans/SourceHanSansSC-VF.otf'
    ],
    extraResources: [
      { from: path.join(stage, 'src/demo'), to: 'demo' },
      { from: path.join(stage, 'src/vendor/libheif'), to: 'codecs/libheif' },
      // Static documents are resources; extraFiles would put them in macOS Contents/.
      { from: path.join(root, 'LICENSE'), to: 'LICENSE.app.txt' },
      { from: path.join(root, 'README.md'), to: 'README.md' },
      { from: path.join(root, 'docs'), to: 'docs' }
    ],
    asar: true,
    asarUnpack: ['**/node_modules/@img/**/*'],
    npmRebuild: false,
    nodeGypRebuild: false,
    artifactName: `ACG-album-Setup-${metadata.version}-Full-universal.\${ext}`,
    mac: {
      target: [{ target: 'dmg', arch: ['universal'] }],
      category: 'public.app-category.photography',
      minimumSystemVersion: '12.0',
      identity: '-',
      hardenedRuntime: false,
      notarize: false,
      mergeASARs: true,
      // Both thin inputs contain BOTH packages. Identical thin Mach-O files must
      // bypass lipo; architecture-specific package names select them at runtime.
      x64ArchFiles: nativePattern,
      singleArchFiles: nativePattern
    },
    // The vendored dmgbuild does not check ditto's exit code. Use a bounded
    // workspace with >=4 GiB reserve; afterSign enforces its 8 GiB payload budget.
    dmg: { format: 'ULFO', writeUpdateInfo: false, sign: false, size: DMG_SIZE, shrink: true },
    publish: null,
    afterPack
  };
}
function asarTool() {
  const fromBuilder = createRequire(
    require.resolve('app-builder-lib', {
      paths: [path.dirname(require.resolve('electron-builder'))]
    })
  );
  return fromBuilder('@electron/asar');
}
function binaryKind(header) {
  if (header.length < 4) return null;
  if (header[0] === 0x4d && header[1] === 0x5a) return 'pe';
  const magic = header.readUInt32BE(0);
  return [
    0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca
  ].includes(magic)
    ? 'macho'
    : null;
}
async function walkFiles(directory) {
  const result = [];
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    // Do not follow framework links or any source junction/symlink.
    if (entry.isDirectory()) result.push(...(await walkFiles(filename)));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}

module.exports = {
  FULL,
  runtimePackages,
  nativePattern,
  run,
  runCli,
  digest,
  download,
  lockIntegrity,
  validateManifest,
  archivePaths,
  safeArchivePath,
  builderConfig,
  asarTool,
  binaryKind,
  walkFiles
};
