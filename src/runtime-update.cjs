'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { githubAssetUrl, MAX_INSTALLER_BYTES } = require('./update-release.cjs');
const MAX_RUNTIME_MANIFEST_BYTES = 256 * 1024;
const IDENTITY_KEYS = ['variant', 'dataVersion', 'readerSchemaVersion', 'bytes', 'sha256'];
const OWNERSHIP_PATH = 'resources/runtime-owned-files.json';
const REQUIRED_RUNTIME_FILES = [
  'ACG-album.exe',
  'resources/app.asar',
  'icudtl.dat',
  'resources.pak',
  'v8_context_snapshot.bin',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'libEGL.dll',
  'libGLESv2.dll',
  'ffmpeg.dll',
  'locales/zh-CN.pak',
  OWNERSHIP_PATH
];
const EMPTY_SHA256 = crypto.createHash('sha256').digest('hex');
const STANDARD_IDENTITY = Object.freeze({
  variant: 'standard',
  dataVersion: 'none',
  readerSchemaVersion: 1,
  bytes: 0,
  sha256: EMPTY_SHA256
});
function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validIdentity(value) {
  if (
    !exactKeys(value, IDENTITY_KEYS) ||
    !['standard', 'lite', 'full'].includes(value.variant) ||
    typeof value.dataVersion !== 'string' ||
    !value.dataVersion ||
    value.dataVersion.length > 128 ||
    value.readerSchemaVersion !== 1 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !/^[a-f\d]{64}$/.test(value.sha256)
  )
    return false;
  return value.variant === 'standard'
    ? IDENTITY_KEYS.every((key) => value[key] === STANDARD_IDENTITY[key])
    : value.bytes > 0;
}
function sameIdentity(a, b) {
  return validIdentity(a) && validIdentity(b) && IDENTITY_KEYS.every((key) => a[key] === b[key]);
}
function runtimeName(version) {
  return `ACG-album-Runtime-${version}-win32-x64`;
}
function safeRuntimePath(value) {
  return (
    typeof value === 'string' &&
    value.length <= 200 &&
    value.split('/').every(
      (part) =>
        part.length > 0 &&
        // Unicode mode treats a valid surrogate pair as one scalar; Cs then
        // rejects only unpaired surrogates. Format characters stay forbidden.
        !/[<>:"\\|?*\u0000-\u001f\u007f-\u009f\p{Cf}\p{Cs}]/u.test(part) &&
        !/[. ]$/.test(part) &&
        !/^\.{1,2}$/.test(part) &&
        !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)(?: *\.| *$)/i.test(part)
    ) &&
    !/^(?:resources\/(?:local-index|fonts)|fonts)(?:\/|$)/i.test(value)
  );
}
function validateRuntimeManifest(
  value,
  { repository, tag, version, platform = 'win32', arch = 'x64' }
) {
  const fail = () => {
    throw new Error('运行时更新清单无效或不兼容，请使用完整安装包。');
  };
  if (
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'repository',
      'tag',
      'version',
      'platform',
      'arch',
      'localIndexes',
      'payload',
      'files'
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'runtime' ||
    value.repository !== repository ||
    value.tag !== tag ||
    value.version !== version ||
    value.platform !== platform ||
    value.arch !== arch ||
    platform !== 'win32' ||
    arch !== 'x64' ||
    !Array.isArray(value.localIndexes) ||
    !value.localIndexes.length ||
    value.localIndexes.length > 32 ||
    !value.localIndexes.every(validIdentity) ||
    new Set(value.localIndexes.map((row) => JSON.stringify(IDENTITY_KEYS.map((key) => row[key]))))
      .size !== value.localIndexes.length ||
    !exactKeys(value.payload, ['name', 'bytes', 'sha256']) ||
    value.payload.name !== runtimeName(version) + '.zip' ||
    !Number.isSafeInteger(value.payload.bytes) ||
    value.payload.bytes <= 0 ||
    value.payload.bytes > MAX_INSTALLER_BYTES ||
    !/^[a-f\d]{64}$/.test(value.payload.sha256) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 1500
  )
    fail();
  const paths = new Set();
  let bytes = 0;
  for (const row of value.files) {
    if (
      !exactKeys(row, ['path', 'bytes', 'sha256']) ||
      !safeRuntimePath(row.path) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      !/^[a-f\d]{64}$/.test(row.sha256) ||
      paths.has(row.path.toLowerCase())
    )
      fail();
    paths.add(row.path.toLowerCase());
    bytes += row.bytes;
  }
  for (const name of paths) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) fail();
      parts.pop();
    }
  }
  if (
    bytes > MAX_INSTALLER_BYTES ||
    !REQUIRED_RUNTIME_FILES.every((name) => paths.has(name.toLowerCase())) ||
    !value.files.some((row) => /^resources\/app\.asar\.unpacked\/.+\.node$/i.test(row.path)) ||
    !value.files.some((row) => row.path.startsWith('resources/demo/')) ||
    !value.files.some((row) => row.path.startsWith('resources/codecs/'))
  )
    fail();
  const url = githubAssetUrl(
    `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${value.payload.name}`,
    repository,
    tag,
    value.payload.name
  );
  if (!url) fail();
  return {
    ...value,
    files: value.files.map((row) => ({ ...row })),
    localIndexes: value.localIndexes.map((row) => ({ ...row })),
    url
  };
}
function validateRuntimeOwnership(value) {
  const fail = () => {
    throw new Error('运行程序所有权清单无效；请从发布页手动更新。');
  };
  if (
    !exactKeys(value, ['schemaVersion', 'kind', 'version', 'platform', 'arch', 'files']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'runtime-ownership' ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    value.platform !== 'win32' ||
    value.arch !== 'x64' ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length >= 1500
  )
    fail();
  const names = new Set();
  let bytes = 0;
  for (const file of value.files) {
    if (
      !exactKeys(file, ['path', 'bytes', 'sha256']) ||
      !safeRuntimePath(file.path) ||
      file.path.toLowerCase() === OWNERSHIP_PATH ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f\d]{64}$/.test(file.sha256) ||
      names.has(file.path.toLowerCase())
    )
      fail();
    names.add(file.path.toLowerCase());
    bytes += file.bytes;
  }
  for (const name of names) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join('/'))) fail();
      parts.pop();
    }
  }
  if (
    !names.has('acg-album.exe') ||
    bytes > MAX_INSTALLER_BYTES ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_RUNTIME_MANIFEST_BYTES
  )
    fail();
  return { ...value, files: value.files.map((file) => ({ ...file })) };
}
function makeRuntimeOwnership({ version, files }) {
  return validateRuntimeOwnership({
    schemaVersion: 1,
    kind: 'runtime-ownership',
    version,
    platform: 'win32',
    arch: 'x64',
    files: files
      .filter((file) => file.path.toLowerCase() !== OWNERSHIP_PATH)
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
  });
}
async function assertRuntimeOwnership(directory) {
  const fail = (file) => {
    throw Object.assign(
      new Error('无法证明程序文件所有权，自动更新已停止：' + file + '；请从发布页手动更新。'),
      { code: 'UPDATE_OWNERSHIP' }
    );
  };
  const ownerFile = path.join(directory, OWNERSHIP_PATH);
  let ownership, text;
  try {
    for (const root of [directory, path.join(directory, 'resources')]) {
      const item = await fs.lstat(root);
      if (!item.isDirectory() || item.isSymbolicLink()) fail(root);
    }
    const stat = await fs.lstat(ownerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RUNTIME_MANIFEST_BYTES)
      fail(ownerFile);
    text = await fs.readFile(ownerFile);
    ownership = validateRuntimeOwnership(JSON.parse(text.toString('utf8')));
  } catch {
    fail(ownerFile);
  }
  const expected = new Map(ownership.files.map((file) => [file.path.toLowerCase(), file]));
  expected.set(OWNERSHIP_PATH, { path: OWNERSHIP_PATH });
  const directories = new Set();
  for (const name of expected.keys()) {
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      directories.add(parts.join('/'));
      parts.pop();
    }
  }
  const seen = new Set();
  async function visit(relative = '') {
    const root = path.join(directory, relative),
      item = await fs.lstat(root);
    if (!item.isDirectory() || item.isSymbolicLink()) fail(root);
    for (const name of await fs.readdir(root)) {
      const child = relative ? relative + '/' + name : name;
      const file = path.join(directory, child),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail(file);
      if (/^(?:fonts|resources\/(?:fonts|local-index))(?:\/|$)/i.test(child)) continue;
      if (stat.isDirectory()) {
        if (!directories.has(child.toLowerCase())) fail(file);
        await visit(child);
      } else if (!stat.isFile() || !expected.has(child.toLowerCase())) fail(file);
      else seen.add(child.toLowerCase());
    }
  }
  await visit();
  for (const [name, row] of expected) {
    const file = path.join(directory, row.path);
    if (!seen.has(name)) fail(file);
    if (
      name !== OWNERSHIP_PATH &&
      ((await fs.lstat(file)).size !== row.bytes || (await hashFile(file)) !== row.sha256)
    )
      fail(file);
  }
  return { ownership, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function bundledIndexIdentity(resourcesDirectory) {
  const directory = path.join(resourcesDirectory, 'local-index');
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return { ...STANDARD_IDENTITY };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('随包离线索引目录无效。');
  const manifestFile = path.join(directory, 'manifest.json');
  const manifestStat = await fs.lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536)
    throw new Error('随包离线索引清单无效。');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  const identity = Object.fromEntries(IDENTITY_KEYS.map((key) => [key, manifest[key]]));
  if (
    !validIdentity(identity) ||
    identity.variant === 'standard' ||
    manifest.database !== 'subjects.sqlite'
  )
    throw new Error('随包离线索引身份不完整。');
  const database = path.join(directory, 'subjects.sqlite');
  const databaseStat = await fs.lstat(database);
  if (
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    databaseStat.size !== identity.bytes ||
    (await hashFile(database)) !== identity.sha256
  )
    throw new Error('随包离线索引大小或 SHA-256 不匹配。');
  return identity;
}
const FONT_WEIGHTS = ['regular', 'medium', 'semibold', 'bold', 'heavy'];
async function prepareFontOverlay(appPath, cacheDirectory) {
  const files = [];
  for (const weight of FONT_WEIGHTS) {
    const source = path.join(
      appPath,
      'src',
      'assets',
      'fonts',
      'founder-lanting-yuan',
      weight + '.ttf'
    );
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 32 * 1024 ** 2)
      throw new Error('本机字体无法安全保留，请手动更新。');
    const bytes = await fs.readFile(source);
    if (bytes.length !== stat.size) throw new Error('本机字体读取期间已改变。');
    files.push({ weight, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  if (!files.length) return [];
  if (files.length !== FONT_WEIGHTS.length)
    throw new Error('本机五款字体不完整，更新已停止以保留旧程序。');
  const directory = path.join(cacheDirectory, 'font-overlay');
  await fs.mkdir(directory, { recursive: true });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
    throw new Error('字体保留缓存包含链接。');
  const result = [];
  for (const file of files) {
    const source = path.join(directory, file.weight + '.ttf');
    // A retry must not silently replace an overlay that was changed after preparation.
    try {
      await fs.writeFile(source, file.bytes, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(source);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== file.bytes.length ||
        (await hashFile(source)) !== file.sha256
      )
        throw new Error('字体保留缓存已改变。');
    }
    result.push({
      source,
      name: file.weight + '.ttf',
      bytes: file.bytes.length,
      sha256: file.sha256
    });
  }
  return result;
}
module.exports = {
  MAX_RUNTIME_MANIFEST_BYTES,
  REQUIRED_RUNTIME_FILES,
  IDENTITY_KEYS,
  STANDARD_IDENTITY,
  FONT_WEIGHTS,
  prepareFontOverlay,
  validIdentity,
  sameIdentity,
  runtimeName,
  safeRuntimePath,
  validateRuntimeManifest,
  OWNERSHIP_PATH,
  makeRuntimeOwnership,
  validateRuntimeOwnership,
  assertRuntimeOwnership,
  bundledIndexIdentity,
  hashFile
};
