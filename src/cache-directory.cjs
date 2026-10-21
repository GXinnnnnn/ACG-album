'use strict';
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const KINDS = ['thumbnails', 'metadata', 'covers'];
const DIRECTORY_NAME = 'ACG-album-cache';
const contains = (parent, child) => {
  const relative = path.relative(
    path.resolve(parent).toLowerCase(),
    path.resolve(child).toLowerCase()
  );
  return (
    !relative ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};
async function noLinks(directory) {
  let current = path.resolve(directory);
  while (true) {
    const stat = await fsp.lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory()))
      throw new Error('缓存路径不能包含符号链接、目录联接或普通文件。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
async function validateCacheLocation(directory, roots = []) {
  await noLinks(directory);
  for (const root of roots) {
    // Compare both lexical and resolved paths; disconnected collections still retain protection.
    const realRoot = await fsp.realpath(root).catch(() => path.resolve(root));
    const realDirectory = await fsp.realpath(directory).catch(() => path.resolve(directory));
    if (
      contains(root, directory) ||
      contains(directory, root) ||
      contains(realRoot, realDirectory) ||
      contains(realDirectory, realRoot)
    )
      throw new Error('缓存目录与已导入的收藏目录不能互相包含，请选择独立位置。');
  }
}
async function* files(directory) {
  await noLinks(directory);
  let handle;
  try {
    handle = await fsp.opendir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for await (const entry of handle) {
    const file = path.join(directory, entry.name);
    const stat = await fsp.lstat(file).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    // A live writer can atomically rename its temporary file while stats are being read.
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('缓存子目录包含非普通文件，已停止操作以保护资料。');
    yield { file, name: entry.name, stat };
  }
}
async function cacheStats(directory, defaultPath) {
  const result = {
    path: directory,
    defaultPath,
    isDefault: path.resolve(directory) === path.resolve(defaultPath)
  };
  for (const kind of KINDS) {
    const stats = { path: path.join(directory, kind), count: 0, bytes: 0 };
    for await (const { stat } of files(stats.path)) {
      stats.count++;
      stats.bytes += stat.size;
    }
    result[kind] = stats;
  }
  return result;
}
function initializeCache(directory) {
  // Startup is synchronous because no worker requests may run before these directories exist.
  for (let current = path.resolve(directory); ; ) {
    if (
      fs.existsSync(current) &&
      (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory())
    )
      throw new Error('缓存路径不能包含符号链接、目录联接或普通文件。');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const kind of KINDS) {
    const target = path.join(directory, kind);
    if (
      fs.existsSync(target) &&
      (fs.lstatSync(target).isSymbolicLink() || !fs.statSync(target).isDirectory())
    )
      throw new Error('缓存子目录不是安全的普通目录。');
    fs.mkdirSync(target, { recursive: true });
  }
}
async function migrateCache({ source, destination, roots = [], commit, progress = () => {} }) {
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) return;
  await validateCacheLocation(destination, roots);
  if (contains(source, destination) || contains(destination, source))
    throw new Error('新旧缓存目录不能互相包含。');
  // Preflight every source and destination before writing or removing anything.
  for (const kind of KINDS) {
    for await (const unused of files(path.join(source, kind))) void unused;
    for await (const unused of files(path.join(destination, kind)))
      throw new Error('目标位置已存在缓存文件，请选择空目录，避免覆盖现有资料。');
  }
  await fsp.mkdir(destination, { recursive: true });
  const stage = path.join(destination, '.acg-cache-move-' + randomUUID());
  const installed = [];
  let committed = false,
    count = 0,
    bytes = 0;
  try {
    await fsp.mkdir(stage);
    for (const kind of KINDS) {
      const stagedKind = path.join(stage, kind);
      await fsp.mkdir(stagedKind);
      for await (const entry of files(path.join(source, kind))) {
        const target = path.join(stagedKind, entry.name);
        await fsp.copyFile(entry.file, target, fs.constants.COPYFILE_EXCL);
        await fsp.utimes(target, entry.stat.atime, entry.stat.mtime);
        progress({ phase: 'copy', files: ++count, bytes: (bytes += entry.stat.size) });
      }
      // Revalidate after copying, then remove only a verified empty target directory.
      await noLinks(path.join(destination, kind));
      for await (const unused of files(path.join(destination, kind)))
        throw new Error('迁移期间目标目录发生变化，请重试。');
      await fsp.rmdir(path.join(destination, kind)).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fsp.rename(stagedKind, path.join(destination, kind));
      installed.push(kind);
    }
    await commit(destination);
    committed = true;
  } finally {
    if (!committed)
      for (const kind of installed)
        await fsp.rm(path.join(destination, kind), { recursive: true, force: true });
    await fsp.rm(stage, { recursive: true, force: true });
  }
  // The database now points to the complete copy. Cleanup failure leaves a safe redundant copy.
  let cleanupWarning = '';
  try {
    for (const kind of KINDS) {
      for await (const entry of files(path.join(source, kind))) await fsp.unlink(entry.file);
      await fsp.rmdir(path.join(source, kind));
    }
  } catch (error) {
    cleanupWarning = '缓存已迁移，旧缓存未完全移除：' + error.message;
  }
  progress({ phase: 'done', files: count, bytes });
  return { cleanupWarning };
}
async function resetCacheFiles(directory, commit) {
  // Validate all three trees first: a late unsafe entry must not cause partial clearing.
  const before = await cacheStats(directory, directory);
  const quarantine = path.join(directory, '.acg-cache-reset-' + randomUUID());
  await fsp.mkdir(quarantine);
  const moved = [];
  let committed = false;
  try {
    for (const kind of KINDS) {
      await fsp.rename(path.join(directory, kind), path.join(quarantine, kind));
      moved.push(kind);
      await fsp.mkdir(path.join(directory, kind));
    }
    await commit();
    committed = true;
  } finally {
    if (!committed)
      for (const kind of moved.reverse()) {
        await fsp.rmdir(path.join(directory, kind)).catch(() => {});
        await fsp.rename(path.join(quarantine, kind), path.join(directory, kind));
      }
    if (!committed) await fsp.rmdir(quarantine);
  }
  // These are exactly the validated, app-owned cache subdirectories, never the profile root.
  await fsp.rm(quarantine, { recursive: true, force: true });
  return {
    removed: KINDS.reduce((n, kind) => n + before[kind].count, 0),
    bytes: KINDS.reduce((n, kind) => n + before[kind].bytes, 0)
  };
}
module.exports = {
  KINDS,
  DIRECTORY_NAME,
  contains,
  noLinks,
  files,
  validateCacheLocation,
  initializeCache,
  cacheStats,
  migrateCache,
  resetCacheFiles
};
