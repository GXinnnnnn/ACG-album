'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fsp = fs.promises;

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
function validateRenameName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    name.length > 255 ||
    /[<>:"/\\|?*\x00-\x1f]/u.test(name) ||
    /[. ]$/u.test(name) ||
    /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[ .]|$)/iu.test(name)
  )
    throw failure('RENAME_NAME', '名称不符合 Windows 文件和文件夹命名规则。');
  return name;
}
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const absent = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
function identity(stat) {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw failure('RENAME_LINK', '不能重命名符号链接、目录联接或特殊文件。');
  if (stat.ino <= 0n || stat.birthtimeNs <= 0n)
    throw failure('RENAME_IDENTITY', '文件系统无法提供可靠的对象身份。');
  return `${stat.isDirectory() ? 'd' : 'f'}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}
async function safeAncestors(p, allowMissing = false) {
  for (let current = path.resolve(p); ; current = path.dirname(current)) {
    let stat;
    try {
      stat = await fsp.lstat(current, { bigint: true });
    } catch (error) {
      if (!allowMissing || !absent(error)) throw error;
    }
    if (stat?.isSymbolicLink()) throw failure('RENAME_LINK', '不能通过符号链接或目录联接重命名。');
    if (path.dirname(current) === current) break;
  }
}
async function actualEntry(parent, name) {
  const directory = await fsp.opendir(parent);
  let found = null;
  try {
    for await (const entry of directory) {
      if (!samePath(entry.name, name)) continue;
      if (found !== null) throw failure('RENAME_AMBIGUOUS', '目录中存在大小写不明确的名称。');
      found = entry.name;
    }
  } finally {
    // for-await closes both on completion and on an early return.
    await directory.close().catch((error) => {
      if (error.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  return found;
}

// Two-argument .NET Move fails when a destination already exists. Unlike
// fs.rename on Windows, it never requests replacement of an existing target.
// Paths are data in a per-child environment, never interpolated into PowerShell.
const MOVE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $r = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ACG_RENAME_REQUEST)) | ConvertFrom-Json
  $a = [IO.Path]::GetFullPath([string]$r.source)
  $b = [IO.Path]::GetFullPath([string]$r.destination)
  if (![string]::Equals([IO.Path]::GetDirectoryName($a), [IO.Path]::GetDirectoryName($b), [StringComparison]::OrdinalIgnoreCase)) { throw 'Rename requires the same parent directory.' }
  $current = $a
  while ($current) {
    if (([IO.File]::GetAttributes($current) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are not allowed.' }
    $next = [IO.Path]::GetDirectoryName($current)
    if ($next -eq $current) { break }
    $current = $next
  }
  if ($r.kind -eq 'directory') { [IO.Directory]::Move($a, $b) }
  elseif ($r.kind -eq 'file') { [IO.File]::Move($a, $b) }
  else { throw 'Invalid source kind.' }
  @{ok=$true} | ConvertTo-Json -Compress
} catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  @{ok=$false; message=$exception.Message; hresult=$exception.HResult} | ConvertTo-Json -Compress
  exit 1
}
`;
function windowsMoveNoReplace(source, destination, kind) {
  if (process.platform !== 'win32')
    return Promise.reject(failure('RENAME_PLATFORM', '当前平台没有可用的不覆盖重命名后端。'));
  const executable = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const request = Buffer.from(JSON.stringify({ source, destination, kind }), 'utf8').toString(
    'base64'
  );
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(MOVE_SCRIPT, 'utf16le').toString('base64')
      ],
      {
        shell: false,
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 32768,
        encoding: 'utf8',
        env: { ...process.env, ACG_RENAME_REQUEST: request }
      },
      (error, stdout) => {
        let response;
        try {
          response = JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''));
        } catch {}
        if (!error && response?.ok === true) return resolve();
        const number = Number(response?.hresult) & 0xffff;
        const code = [80, 183].includes(number)
          ? 'EEXIST'
          : [5].includes(number)
            ? 'EACCES'
            : [32, 33].includes(number)
              ? 'EBUSY'
              : 'RENAME_MOVE';
        reject(failure(code, response?.message || error?.message || '重命名失败。'));
      }
    );
  });
}

/** No source copy/delete. Caller holds its mutation reservation until complete.
 * Persist DB commit with this opId before complete(); recover() runs before jobs.
 */
function createFsRename({ journalDir, moveNoReplace = windowsMoveNoReplace } = {}) {
  if (typeof journalDir !== 'string' || !path.isAbsolute(journalDir))
    throw new TypeError('journalDir must be an absolute application-owned directory');
  const home = path.resolve(journalDir),
    issued = new WeakSet();
  const journalPath = (opId) => path.join(home, opId + '.json');
  function validateRecord(r) {
    if (
      !r ||
      r.version !== 1 ||
      !/^[A-Za-z0-9_-]{1,100}$/u.test(r.opId) ||
      !['file', 'directory'].includes(r.kind) ||
      typeof r.identity !== 'string' ||
      typeof r.parentIdentity !== 'string' ||
      ![r.oldPath, r.path, r.tempPath].every((p) => typeof p === 'string' && path.isAbsolute(p))
    )
      throw failure('RENAME_JOURNAL', '重命名恢复记录无效。');
    const parent = path.dirname(r.oldPath);
    if (
      !samePath(parent, path.dirname(r.path)) ||
      !samePath(parent, path.dirname(r.tempPath)) ||
      path.basename(r.tempPath) !== '.acg-rename-' + r.opId
    )
      throw failure('RENAME_JOURNAL', '重命名恢复记录的目录不一致。');
    validateRenameName(path.basename(r.oldPath));
    validateRenameName(path.basename(r.path));
    return r;
  }
  async function ready() {
    await safeAncestors(home, true);
    await fsp.mkdir(home, { recursive: true });
    await safeAncestors(home);
  }
  async function syncDirectory() {
    let handle;
    try {
      handle = await fsp.open(home, 'r');
      await handle.sync();
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EISDIR', 'EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
    } finally {
      await handle?.close();
    }
  }
  async function persist(r, initial = false) {
    await ready();
    const target = journalPath(r.opId),
      temp = target + '.' + randomUUID() + '.tmp';
    const handle = await fsp.open(initial ? target : temp, 'wx');
    try {
      await handle.writeFile(JSON.stringify(r), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // This rename only replaces our own journal, never a user source object.
    if (!initial) await fsp.rename(temp, target);
    await syncDirectory();
  }
  async function load(opId) {
    await safeAncestors(home);
    const p = journalPath(opId);
    const stat = await fsp.lstat(p);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw failure('RENAME_JOURNAL', '恢复记录不是普通文件。');
    const record = validateRecord(JSON.parse(await fsp.readFile(p, 'utf8')));
    if (record.opId !== opId) throw failure('RENAME_JOURNAL', '恢复记录的操作编号不一致。');
    return record;
  }
  async function clear(r) {
    await fsp.unlink(journalPath(r.opId));
    await syncDirectory();
  }
  async function checkParent(r) {
    const parent = path.dirname(r.oldPath);
    await safeAncestors(parent);
    if (identity(await fsp.lstat(parent, { bigint: true })) !== r.parentIdentity)
      throw failure('RENAME_CHANGED', '重命名期间父目录已变化。');
  }
  async function where(r) {
    await checkParent(r);
    const found = [];
    for (const candidate of [...new Set([r.oldPath, r.path, r.tempPath])]) {
      const name = await actualEntry(path.dirname(candidate), path.basename(candidate));
      if (!name || name !== path.basename(candidate)) continue;
      const stat = await fsp.lstat(candidate, { bigint: true });
      if (!stat.isSymbolicLink() && identity(stat) === r.identity) found.push(candidate);
    }
    if (found.length !== 1)
      throw failure('RENAME_RECOVERY', '无法唯一定位重命名的原对象。', { recoveryRequired: true });
    return found[0];
  }
  async function move(r, from, to) {
    await checkParent(r);
    if (identity(await fsp.lstat(from, { bigint: true })) !== r.identity)
      throw failure('RENAME_CHANGED', '重命名期间源对象已变化。');
    if (await actualEntry(path.dirname(to), path.basename(to)))
      throw failure('EEXIST', '目标名称已存在，未覆盖任何文件。');
    await moveNoReplace(from, to, r.kind);
    if (identity(await fsp.lstat(to, { bigint: true })) !== r.identity)
      throw failure('RENAME_CHANGED', '重命名后的对象身份不一致。', { recoveryRequired: true });
  }
  async function restore(r) {
    let current = await where(r);
    if (current !== r.oldPath) {
      if (samePath(current, r.oldPath)) {
        await move(r, current, r.tempPath);
        current = r.tempPath;
      }
      await move(r, current, r.oldPath);
    }
    await clear(r);
    return { recovered: true, rolledBack: true, opId: r.opId, path: r.oldPath };
  }
  return {
    async prepare({ sourcePath, newName, operationId = randomUUID() }) {
      validateRenameName(newName);
      if (
        typeof sourcePath !== 'string' ||
        !path.isAbsolute(sourcePath) ||
        !/^[A-Za-z0-9_-]{1,100}$/u.test(operationId)
      )
        throw failure('RENAME_SOURCE', '重命名源路径或操作编号无效。');
      let oldPath = path.resolve(sourcePath);
      if (path.dirname(oldPath) === oldPath)
        throw failure('RENAME_SOURCE', '不能重命名磁盘根目录。');
      await safeAncestors(oldPath);
      const parent = path.dirname(oldPath),
        actual = await actualEntry(parent, path.basename(oldPath));
      if (!actual) throw failure('ENOENT', '源文件或文件夹不存在。');
      oldPath = path.join(parent, actual);
      const stat = await fsp.lstat(oldPath, { bigint: true });
      const journalRelative = path.relative(oldPath, home);
      if (
        stat.isDirectory() &&
        (samePath(oldPath, home) ||
          (journalRelative &&
            !path.isAbsolute(journalRelative) &&
            journalRelative !== '..' &&
            !journalRelative.startsWith('..' + path.sep)))
      )
        throw failure('RENAME_JOURNAL', '恢复目录不能放在待重命名的子树内。');
      const r = {
        version: 1,
        opId: operationId,
        oldPath,
        path: path.join(parent, newName),
        tempPath: path.join(parent, '.acg-rename-' + operationId),
        kind: stat.isDirectory() ? 'directory' : 'file',
        identity: identity(stat),
        parentIdentity: identity(await fsp.lstat(parent, { bigint: true })),
        phase: 'prepared',
        noOp: actual === newName,
        caseOnly: actual !== newName && samePath(actual, newName)
      };
      validateRecord(r);
      if (!r.noOp && !r.caseOnly && (await actualEntry(parent, newName)))
        throw failure('EEXIST', '目标名称已存在，未覆盖任何文件。');
      if (await actualEntry(parent, path.basename(r.tempPath)))
        throw failure('EEXIST', '临时重命名位置已存在。');
      const ticket = Object.freeze(r);
      issued.add(ticket);
      return ticket;
    },
    async execute(ticket) {
      if (!issued.delete(ticket)) throw failure('RENAME_PLAN', '重命名计划已过期或已执行。');
      const r = { ...validateRecord(ticket) };
      if (r.noOp) {
        await where(r);
        return { ...r, renamed: false };
      }
      if ((await where(r)) !== r.oldPath) throw failure('RENAME_CHANGED', '源名称已发生变化。');
      await persist(r, true);
      try {
        if (r.caseOnly) {
          await move(r, r.oldPath, r.tempPath);
          r.phase = 'staged';
          await persist(r);
          await move(r, r.tempPath, r.path);
        } else await move(r, r.oldPath, r.path);
        r.phase = 'moved';
        await persist(r);
        return { ...r, renamed: true };
      } catch (error) {
        try {
          await restore(r);
          error.rolledBack = true;
        } catch (rollbackError) {
          error.recoveryRequired = true;
          error.rollbackError = rollbackError.message;
          try {
            error.actualPath = await where(r);
          } catch {}
        }
        throw error;
      }
    },
    async rollback(receipt) {
      if (receipt.noOp) return { recovered: true, rolledBack: false, path: receipt.oldPath };
      const r = await load(validateRecord(receipt).opId);
      return restore(r);
    },
    async complete(receipt) {
      if (receipt.noOp) return;
      let r;
      try {
        r = await load(validateRecord(receipt).opId);
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
      if ((await where(r)) !== r.path)
        throw failure('RENAME_RECOVERY', '数据库已提交，但文件系统位置需要恢复。', {
          recoveryRequired: true
        });
      await clear(r);
    },
    async recover({ isCommitted }) {
      if (typeof isCommitted !== 'function') throw new TypeError('isCommitted is required');
      await ready();
      const results = [];
      const directory = await fsp.opendir(home);
      for await (const entry of directory) {
        if (!/^[A-Za-z0-9_-]{1,100}\.json$/u.test(entry.name)) continue;
        let r;
        try {
          r = await load(entry.name.slice(0, -5));
          if (await isCommitted(r.opId)) {
            if ((await where(r)) !== r.path)
              throw failure('RENAME_RECOVERY', '已提交操作的新路径不一致。');
            await clear(r);
            results.push({ recovered: true, committed: true, opId: r.opId, path: r.path });
          } else results.push(await restore(r));
        } catch (error) {
          let actualPath;
          if (r) {
            try {
              actualPath = await where(r);
            } catch {}
          }
          results.push({
            recovered: false,
            recoveryRequired: true,
            opId: r?.opId || entry.name.slice(0, -5),
            actualPath,
            error: error.message
          });
        }
      }
      return results;
    }
  };
}
module.exports = { validateRenameName, windowsMoveNoReplace, createFsRename };
