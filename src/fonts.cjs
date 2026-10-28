'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');

// Fixed, read-only script: renderer input is never interpolated into commands.
// Windows exposes installed system and per-user fonts through this collection;
// reading family names avoids loading hundreds of font files a second time.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
$names = New-Object 'System.Collections.Generic.List[string]'
function Add-Families($families) {
  foreach ($family in $families) {
    $names.Add($family.Name)
    foreach ($language in @(2052,1033,[System.Globalization.CultureInfo]::CurrentUICulture.LCID)) {
      try { $names.Add($family.GetName($language)) } catch {}
    }
  }
}
$installed = New-Object System.Drawing.Text.InstalledFontCollection
try {
  Add-Families $installed.Families
  ConvertTo-Json -InputObject @($names.ToArray()) -Compress
} finally {
  $installed.Dispose()
}
`;
function execute(file, args, run) {
  return new Promise((resolve, reject) => {
    run(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const message =
            error.killed || error.code === 'ETIMEDOUT'
              ? '读取本机字体超时，请稍后重试。'
              : '无法读取本机已安装字体，请稍后重试。';
          reject(new Error(message));
        } else resolve(stdout.replace(/^\uFEFF/, ''));
      }
    );
  });
}
function normalize(families) {
  if (!Array.isArray(families) || families.length > 50000)
    throw new Error('本机字体列表格式无效，请重试。');
  const unique = new Map();
  for (const family of families) {
    if (typeof family !== 'string') throw new Error('本机字体列表格式无效，请重试。');
    const name = family.normalize('NFC').trim();
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    const key = name.toLocaleLowerCase('en-US');
    if (!unique.has(key)) unique.set(key, name);
  }
  return [...unique.values()].sort(
    new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare
  );
}
function createSystemFonts({
  platform = process.platform,
  run = execFile,
  enumerate,
  now = Date.now,
  ttlMs = 60000
} = {}) {
  let cached = null,
    cachedAt = 0,
    pending = null;
  async function read() {
    if (enumerate) return enumerate();
    if (platform === 'win32') {
      const executable = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const output = await execute(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
        ],
        run
      );
      try {
        return { families: JSON.parse(output), source: 'windows-installed-fonts' };
      } catch {
        throw new Error('本机字体列表格式无效，请重试。');
      }
    }
    if (platform === 'linux') {
      const output = await execute('fc-list', ['--format=%{family[0]}\\n'], run);
      return { families: output.split(/\r?\n/), source: 'fontconfig' };
    }
    return { families: [], source: 'unsupported-platform' };
  }
  async function list() {
    if (cached && now() - cachedAt < ttlMs) return { ...cached, families: [...cached.families] };
    if (!pending) {
      pending = read()
        .then((result) => {
          const families = normalize(result.families);
          if (!families.length && result.source !== 'unsupported-platform')
            throw new Error('未读取到已安装字体，请稍后重试。');
          cached = { families, source: result.source };
          cachedAt = now();
          return cached;
        })
        .finally(() => {
          pending = null;
        });
    }
    const result = await pending;
    return { ...result, families: [...result.families] };
  }
  return { list };
}
const systemFonts = createSystemFonts();
module.exports = { createSystemFonts, systemFonts: () => systemFonts.list() };
