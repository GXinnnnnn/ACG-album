'use strict';

// Standalone publisher tool. Feed a verified public, unpacked Windows x64 runtime;
// never point it at a personal installation. This does not publish or deploy.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validRepository } = require('../src/repository.cjs');
const {
  safeRuntimePath,
  runtimeName,
  hashFile,
  validateRuntimeManifest,
  MAX_RUNTIME_MANIFEST_BYTES,
  OWNERSHIP_PATH,
  makeRuntimeOwnership,
  assertRuntimeOwnership
} = require('../src/runtime-update.cjs');

async function assertPublicAsar(file) {
  const handle = await fs.open(file, 'r');
  try {
    const prefix = Buffer.alloc(16);
    if ((await handle.read(prefix, 0, 16, 0)).bytesRead !== 16)
      throw new Error('Invalid public app.asar');
    const length = prefix.readUInt32LE(12);
    if (!length || length > 16 * 1024 ** 2) throw new Error('Invalid app.asar header');
    const bytes = Buffer.alloc(length);
    if ((await handle.read(bytes, 0, length, 16)).bytesRead !== length)
      throw new Error('Truncated app.asar header');
    const header = JSON.parse(bytes.toString('utf8'));
    function visit(node, name = '') {
      for (const [key, value] of Object.entries(node.files || {})) {
        const target = name + '/' + key;
        if (/\/founder-lanting-yuan\/.*\.(?:ttf|otf)$/i.test(target))
          throw new Error('Public runtime contains proprietary embedded fonts');
        visit(value, target);
      }
    }
    visit(header);
  } finally {
    await handle.close();
  }
}
async function runtimeInventory(directory) {
  const files = [];
  async function visit(relative = '') {
    const root = path.join(directory, relative);
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Runtime source contains a linked directory');
    for (const name of (await fs.readdir(root)).sort()) {
      const target = relative ? relative + '/' + name : name;
      const file = path.join(directory, target);
      const item = await fs.lstat(file);
      if (item.isSymbolicLink()) throw new Error('Runtime source contains a link: ' + target);
      if (
        /^(?:resources\/(?:local-index|fonts)|fonts)(?:\/|$)/i.test(target) ||
        target.toLowerCase() === OWNERSHIP_PATH
      )
        continue;
      if (!safeRuntimePath(target) || /\.(?:ttf|otf)$/i.test(target))
        throw new Error('Unsafe or private runtime path: ' + target);
      if (item.isDirectory()) await visit(target);
      else if (item.isFile())
        files.push({ path: target, bytes: item.size, sha256: await hashFile(file) });
      else throw new Error('Runtime source contains a special file');
    }
  }
  await visit();
  return files;
}
async function runtimePayloadInventory(directory, version) {
  const files = await runtimeInventory(directory);
  const ownership = makeRuntimeOwnership({ version, files });
  const ownershipText = JSON.stringify(ownership) + '\n';
  return {
    ownership,
    ownershipText,
    files: [
      ...files,
      {
        path: OWNERSHIP_PATH,
        bytes: Buffer.byteLength(ownershipText),
        sha256: createHash('sha256').update(ownershipText).digest('hex')
      }
    ]
  };
}
async function buildRuntimeUpdate({
  runtimeDirectory,
  identitiesFile,
  outputDirectory,
  repository,
  tag,
  version
}) {
  if (process.platform !== 'win32')
    throw new Error('This publisher tool requires Windows PowerShell');
  if (
    !validRepository(repository) ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    typeof tag !== 'string' ||
    !tag ||
    /[\x00-\x1f]/.test(tag)
  )
    throw new Error('Explicit repository, tag and version are required');
  runtimeDirectory = path.resolve(runtimeDirectory);
  outputDirectory = path.resolve(outputDirectory);
  const relative = path.relative(runtimeDirectory, outputDirectory);
  if (
    !relative ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('Output must be outside the runtime source');
  const identityStat = await fs.lstat(identitiesFile);
  if (!identityStat.isFile() || identityStat.isSymbolicLink() || identityStat.size > 65536)
    throw new Error('Invalid identity input');
  const localIndexes = JSON.parse(await fs.readFile(identitiesFile, 'utf8'));
  const { files, ownershipText } = await runtimePayloadInventory(runtimeDirectory, version);
  await assertPublicAsar(path.join(runtimeDirectory, 'resources', 'app.asar'));
  const base = runtimeName(version);
  const manifest = {
    schemaVersion: 1,
    kind: 'runtime',
    repository,
    tag,
    version,
    platform: 'win32',
    arch: 'x64',
    localIndexes,
    payload: { name: base + '.zip', bytes: 1, sha256: '0'.repeat(64) },
    files
  };
  validateRuntimeManifest(manifest, { repository, tag, version });
  await fs.mkdir(outputDirectory, { recursive: true });
  const zip = path.join(outputDirectory, manifest.payload.name);
  const metadata = path.join(outputDirectory, base + '.manifest.json');
  for (const target of [zip, metadata]) {
    try {
      await fs.lstat(target);
      throw new Error('Output already exists: ' + target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'ACG-public-runtime-'));
  try {
    for (const file of files) {
      const target = path.join(staging, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (file.path === OWNERSHIP_PATH) await fs.writeFile(target, ownershipText, { flag: 'wx' });
      else await fs.copyFile(path.join(runtimeDirectory, file.path), target);
      if ((await hashFile(target)) !== file.sha256)
        throw new Error('Source runtime changed during packaging');
    }
    await assertRuntimeOwnership(staging);
    const config = Buffer.from(JSON.stringify({ staging, zip })).toString('base64');
    // Create file entries only; the installer rejects unlisted directory entries.
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${config}'))|ConvertFrom-Json
$archive=[IO.Compression.ZipFile]::Open($p.zip,[IO.Compression.ZipArchiveMode]::Create)
try { foreach($file in Get-ChildItem -LiteralPath $p.staging -File -Recurse -Force) {
$name=$file.FullName.Substring($p.staging.Length+1).Replace('\\','/')
[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$name,[IO.Compression.CompressionLevel]::Optimal)|Out-Null
} } finally { $archive.Dispose() }`;
    const result = spawnSync(
      path.win32.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64')
      ],
      { stdio: 'inherit', windowsHide: true }
    );
    if (result.error || result.status !== 0)
      throw result.error || new Error('Runtime ZIP creation failed');
    manifest.payload.bytes = (await fs.stat(zip)).size;
    manifest.payload.sha256 = await hashFile(zip);
    validateRuntimeManifest(manifest, { repository, tag, version });
    const text = JSON.stringify(manifest, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_RUNTIME_MANIFEST_BYTES)
      throw new Error('Runtime manifest exceeds its size limit');
    await fs.writeFile(metadata, text, { flag: 'wx' });
    return { zip, metadata };
  } finally {
    // Only this invocation's new staging leaf is disposable.
    await fs.rm(staging, { recursive: true, force: true });
  }
}
if (require.main === module) {
  const names = {
    '--runtime': 'runtimeDirectory',
    '--identities': 'identitiesFile',
    '--out': 'outputDirectory',
    '--repository': 'repository',
    '--tag': 'tag',
    '--version': 'version'
  };
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1] || options[names[args[i]]])
      throw new Error('Use --runtime --identities --out --repository --tag --version');
    options[names[args[i]]] = args[i + 1];
  }
  if (Object.keys(options).length !== 6) throw new Error('All six explicit options are required');
  buildRuntimeUpdate(options).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
module.exports = {
  assertPublicAsar,
  runtimeInventory,
  runtimePayloadInventory,
  buildRuntimeUpdate
};
