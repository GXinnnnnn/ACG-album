'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const {
  validIdentity,
  sameIdentity,
  validateRuntimeManifest,
  FONT_WEIGHTS
} = require('./runtime-update.cjs');

function appGuid() {
  // build is intentionally absent from electron-builder's packaged metadata.
  const applicationId = 'local.acg.album';
  // electron-builder 26 NSIS UUID v5 namespace (NsisTarget.js).
  const namespace = Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(applicationId, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const powershellPath = () =>
  path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

function contains(directory, target) {
  const relative = path.win32.relative(directory, target);
  return (
    relative === '' ||
    (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
  );
}

function installationPlan({
  executable,
  dataDirectory,
  userData,
  installer,
  sha256,
  parentPid,
  edition,
  version,
  mode = 'full',
  runtimeManifest,
  indexIdentity,
  fontOverlay = [],
  ownershipSha256,
  platform = process.platform,
  packaged,
  testMode = process.env.ACG_TEST === '1'
}) {
  if (platform !== 'win32' || !packaged || testMode)
    throw new Error('仅正式 Windows 安装版支持应用内安装；开发或测试模式请查看发布页。');
  for (const value of [executable, dataDirectory, userData, installer]) {
    if (
      typeof value !== 'string' ||
      !/^[a-z]:\\/i.test(value) ||
      /[\x00-\x1f"<>|?*]/.test(value) ||
      value.length > 240
    )
      throw new Error('更新路径无效或不支持，请从发布页手动安装。');
  }
  if (
    path.win32.basename(executable).toLowerCase() !== 'acg-album.exe' ||
    !/^[a-f\d]{64}$/i.test(sha256) ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    !['standard', 'lite', 'full'].includes(edition) ||
    !/^\d+\.\d+\.\d+$/.test(version)
  )
    throw new Error('安装更新信息无效。');
  const directory = path.win32.dirname(executable);
  if (
    directory === path.win32.parse(directory).root ||
    contains(directory, dataDirectory) ||
    contains(directory, userData) ||
    contains(directory, installer)
  )
    throw new Error('资料或更新缓存位于程序目录内，无法安全覆盖；请从发布页手动更新。');
  if (!['full', 'runtime'].includes(mode)) throw new Error('更新模式无效。');
  if (mode === 'runtime') {
    if (!validIdentity(indexIdentity) || indexIdentity.variant !== edition)
      throw new Error('运行时索引身份无效。');
    runtimeManifest = validateRuntimeManifest(
      Object.fromEntries(Object.entries(runtimeManifest || {}).filter(([key]) => key !== 'url')),
      {
        repository: runtimeManifest?.repository,
        tag: runtimeManifest?.tag,
        version
      }
    );
    if (
      runtimeManifest.payload.sha256 !== sha256.toLowerCase() ||
      !runtimeManifest.localIndexes.some((row) => sameIdentity(row, indexIdentity))
    )
      throw new Error('运行时更新身份不匹配。');
  }
  if (
    !Array.isArray(fontOverlay) ||
    ![0, 5].includes(fontOverlay.length) ||
    fontOverlay.some(
      (font) =>
        !FONT_WEIGHTS.some((weight) => font.name === weight + '.ttf') ||
        !/^[a-f\d]{64}$/.test(font.sha256) ||
        !Number.isSafeInteger(font.bytes) ||
        font.bytes <= 0 ||
        font.bytes > 32 * 1024 ** 2 ||
        font.source !== path.win32.join(path.win32.dirname(installer), 'font-overlay', font.name)
    ) ||
    new Set(fontOverlay.map((font) => font.name)).size !== fontOverlay.length
  )
    throw new Error('本机字体保留信息无效。');
  if (ownershipSha256 !== undefined && !/^[a-f\d]{64}$/.test(ownershipSha256))
    throw new Error('程序文件所有权校验信息无效。');
  return {
    mode,
    ...(mode === 'runtime' ? { runtimeManifest, indexIdentity } : {}),
    fontOverlay,
    ...(ownershipSha256 !== undefined ? { ownershipSha256 } : {}),
    executable,
    directory,
    dataDirectory,
    userData,
    installer,
    sha256: sha256.toLowerCase(),
    parentPid,
    edition,
    version,
    appGuid: appGuid()
  };
}

// Shared by preflight and the detached helper; registry access is read-only.
// Keep reader separate so validation can be exercised with synthetic records.
function registryValidationScript() {
  return String.raw`
function Read-AlbumRegistrations {
  $records = @()
  foreach ($hive in @('CurrentUser', 'LocalMachine')) {
    foreach ($view in @('Registry64', 'Registry32')) {
      $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::$hive, [Microsoft.Win32.RegistryView]::$view)
      try {
        $install = $base.OpenSubKey(('Software\' + $p.appGuid), $false)
        $uninstall = $base.OpenSubKey(('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $p.appGuid), $false)
        try {
          if ($install -or $uninstall) {
            $records += [pscustomobject]@{
              hive = $hive; view = $view
              installLocation = $(if ($install) { $install.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) })
              uninstallString = $(if ($uninstall) { $uninstall.GetValue('UninstallString', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) })
              uninstallExists = [bool]$uninstall
            }
          }
        } finally { if ($install) { $install.Dispose() }; if ($uninstall) { $uninstall.Dispose() } }
      } finally { $base.Dispose() }
    }
  }
  return $records
}
function Confirm-AlbumInstallation($records) {
  $target = [IO.Path]::GetFullPath($p.directory).TrimEnd('\')
  $scopes = @()
  foreach ($entry in @($records)) {
    $locations = @()
    if ($entry.installLocation) { $locations += [string]$entry.installLocation }
    if ($entry.uninstallString) {
      if ([string]$entry.uninstallString -notmatch '^"([a-zA-Z]:\\[^"\r\n]+\.exe)"(?:\s|$)') { throw 'Cannot confirm the registered uninstaller path. Use the release page for a manual update.' }
      $locations += [IO.Path]::GetDirectoryName($Matches[1])
    } elseif ($entry.uninstallExists) { throw 'Registered uninstall information is incomplete. Use the release page for a manual update.' }
    if (-not $locations.Count) { throw 'Registered installation location is missing. Use the release page for a manual update.' }
    foreach ($location in $locations) {
      if ($location -notmatch '^[a-zA-Z]:\\' -or $location -match '[\x00-\x1f"<>|?*]' -or [IO.Path]::GetFullPath($location).TrimEnd('\') -ine $target) {
        throw 'Another registered installation uses a different directory. Use the release page for a manual update.'
      }
    }
    if ($entry.hive -notin @('CurrentUser', 'LocalMachine')) { throw 'Invalid installation scope.' }
    $scopes += $entry.hive
  }
  $scopes = @($scopes | Select-Object -Unique)
  if ($scopes.Count -eq 0) { return 'currentuser' } # Fixed-directory deployments have no NSIS registry entries.
  if ($scopes.Count -ne 1) { throw 'Cannot confirm a single registered installation scope. Use the release page for a manual update.' }
  if ($scopes[0] -eq 'LocalMachine') { return 'allusers' }
  return 'currentuser'
}
`;
}

function preflightScript(plan) {
  // The registry check only needs these fields. Never put the runtime inventory
  // or font plan on Windows' length-limited EncodedCommand command line.
  const encoded = Buffer.from(
    JSON.stringify({ directory: plan.directory, appGuid: plan.appGuid }),
    'utf8'
  ).toString('base64');
  return `$ErrorActionPreference = 'Stop'\n$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n${registryValidationScript()}\nConfirm-AlbumInstallation @(Read-AlbumRegistrations) | Out-Null`;
}

async function preflightInstallation(plan, { spawnProcess = spawn, timeoutMs = 15000 } = {}) {
  const child = spawnProcess(
    powershellPath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(preflightScript(plan), 'utf16le').toString('base64')
    ],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  await new Promise((resolve, reject) => {
    let diagnostic = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('安装位置预检超时；应用未退出，请重试或从发布页手动安装。'));
    }, timeoutMs);
    child.stderr?.on('data', (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-16384);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            '安装位置预检失败；应用未退出。请从发布页手动安装。' +
              (diagnostic ? '\n' + diagnostic : '')
          )
        );
    });
  });
}

function runtimeTransactionScript() {
  return String.raw`
function Assert-AlbumPlainTree($directory) {
  $pending = @($directory)
  while ($pending.Count) {
    $current = $pending[0]; $pending = @($pending | Select-Object -Skip 1)
    $item = Get-Item -LiteralPath $current -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update path contains a link.' }
    if ($item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $current -Force)) { $pending += $child.FullName }
    }
  }
}
function Confirm-AlbumIndex {
  $index = Join-Path $p.directory 'resources\local-index'
  if ($p.indexIdentity.variant -eq 'standard') {
    if (Test-Path -LiteralPath $index) { throw 'An offline index appeared after verification.' }
    return
  }
  Assert-AlbumPlainTree $index
  $manifestFile = Join-Path $index 'manifest.json'
  if ((Get-Item -LiteralPath $manifestFile).Length -gt 65536) { throw 'Index manifest is too large.' }
  $m = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($key in @('variant','dataVersion','readerSchemaVersion','bytes','sha256')) {
    if ($m.$key -cne $p.indexIdentity.$key) { throw ('Original index identity changed: ' + $key) }
  }
  $database = Join-Path $index 'subjects.sqlite'
  if ($m.database -cne 'subjects.sqlite' -or (Get-Item -LiteralPath $database).Length -ne $p.indexIdentity.bytes -or (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -ine $p.indexIdentity.sha256) { throw 'Original index bytes changed.' }
}
function Copy-AlbumFontOverlay($target) {
  foreach ($font in @($p.fontOverlay)) {
    $source = Get-Item -LiteralPath $font.source -Force
    if ($source.Attributes -band [IO.FileAttributes]::ReparsePoint -or $source.Length -ne $font.bytes -or (Get-FileHash -LiteralPath $font.source -Algorithm SHA256).Hash -ine $font.sha256) { throw 'Local font overlay changed.' }
    $folder = Join-Path $target 'resources\fonts\founder-lanting-yuan'
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $destination = Join-Path $folder $font.name
    if (Test-Path -LiteralPath $destination) {
      if ((Get-Item -LiteralPath $destination -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $font.sha256) { throw 'Existing local font differs from retained font.' }
    } else { Copy-Item -LiteralPath $font.source -Destination $destination -ErrorAction Stop }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $font.sha256) { throw 'Retained font verification failed.' }
  }
}
function Confirm-AlbumRuntimeFiles($directory) {
  foreach ($file in @($p.runtimeManifest.files)) {
    $target = Join-Path $directory $file.path
    $item = Get-Item -LiteralPath $target -Force
    if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $file.sha256) { throw ('Runtime file verification failed: ' + $file.path) }
  }
}
function Expand-AlbumRuntime($stage) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $inventory = @{}; foreach ($file in @($p.runtimeManifest.files)) { $inventory[$file.path] = $file }
  $seen = @{}
  $zip = [IO.Compression.ZipFile]::OpenRead($p.installer)
  try {
    if ($zip.Entries.Count -ne $inventory.Count) { throw 'Runtime ZIP inventory count differs.' }
    foreach ($entry in $zip.Entries) {
      $file = $inventory[$entry.FullName]
      if (-not $file -or $entry.FullName -cne $file.path -or $seen.ContainsKey($entry.FullName) -or $entry.Length -ne $file.bytes -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or ($entry.ExternalAttributes -band 1024)) { throw 'Runtime ZIP contains an unexpected or linked entry.' }
      $seen[$entry.FullName] = $true
      $target = Join-Path $stage $file.path
      New-Item -ItemType Directory -Path (Split-Path -LiteralPath $target) -Force | Out-Null
      $inputStream = $entry.Open(); $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew)
      try {
        $buffer = New-Object byte[] 65536; $written = 0L
        while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $written += $count; if ($written -gt $file.bytes) { throw 'Runtime ZIP expanded beyond declared size.' }
          $outputStream.Write($buffer, 0, $count)
        }
        if ($written -ne $file.bytes) { throw 'Runtime ZIP file is truncated.' }
      } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $zip.Dispose() }
  Confirm-AlbumRuntimeFiles $stage
}
function Test-AlbumRuntimePathPart([string]$part) {
  if (-not $part -or $part -match '[<>:"\\|?*\x00-\x1f\x7f-\x9f]' -or $part -match '[. ]$|^\.{1,2}$|^(?i:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?: *\.| *$)') { return $false }
  # .NET regex operates on UTF-16 units; validate pairs before reading categories
  # so ordinary emoji survive, while astral format characters remain forbidden.
  for ($i = 0; $i -lt $part.Length; $i++) {
    if ([char]::IsSurrogate($part[$i]) -and (-not [char]::IsHighSurrogate($part[$i]) -or $i + 1 -ge $part.Length -or -not [char]::IsLowSurrogate($part[$i + 1]))) { return $false }
    if ([Globalization.CharUnicodeInfo]::GetUnicodeCategory($part, $i) -eq [Globalization.UnicodeCategory]::Format) { return $false }
    if ([char]::IsHighSurrogate($part[$i])) { $i++ }
  }
  return $true
}
function Get-AlbumOwnership($directory) {
  $owner = Join-Path $directory 'resources\runtime-owned-files.json'
  if (-not (Test-Path -LiteralPath $owner -PathType Leaf)) { throw ('Runtime ownership is unavailable. Use the release page for a manual update: ' + $owner) }
  $item = Get-Item -LiteralPath $owner -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -gt 262144) { throw ('Invalid runtime ownership: ' + $owner) }
  $m = Get-Content -LiteralPath $owner -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@($m.PSObject.Properties).Count -ne 6 -or $m.schemaVersion -ne 1 -or $m.kind -cne 'runtime-ownership' -or $m.version -notmatch '^\d+\.\d+\.\d+$' -or $m.platform -cne 'win32' -or $m.arch -cne 'x64' -or @($m.files).Count -lt 1 -or @($m.files).Count -ge 1500) { throw ('Invalid runtime ownership: ' + $owner) }
  $names = @{}; $bytes = 0L
  foreach ($file in @($m.files)) {
    $name = [string]$file.path
    if (@($file.PSObject.Properties).Count -ne 3 -or -not $name -or $name.Length -gt 200 -or $name -ieq 'resources/runtime-owned-files.json' -or $name -match '^(?i:fonts|resources/(?:fonts|local-index))(?:/|$)' -or $names.ContainsKey($name) -or $file.bytes -lt 0 -or $file.bytes -ne [long]$file.bytes -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw ('Invalid owned runtime path: ' + $name) }
    foreach ($part in $name.Split('/')) {
      if (-not (Test-AlbumRuntimePathPart $part)) { throw ('Invalid owned runtime path: ' + $name) }
    }
    $names[$name] = $true; $bytes += $file.bytes
  }
  if (-not $names.ContainsKey('ACG-album.exe') -or $bytes -gt 8589934592) { throw 'Invalid runtime ownership inventory.' }
  return $m
}
function Confirm-AlbumRuntimeOwnership($directory, $expectedSha = $null) {
  $m = Get-AlbumOwnership $directory
  $owner = Join-Path $directory 'resources\runtime-owned-files.json'
  if ($expectedSha -and (Get-FileHash -LiteralPath $owner -Algorithm SHA256).Hash -ine $expectedSha) { throw 'Original runtime ownership changed.' }
  $files = @{}; $directories = @{}
  foreach ($file in @($m.files)) { $files[$file.path] = $file }
  $files['resources/runtime-owned-files.json'] = $null
  foreach ($name in @($files.Keys)) {
    $parent = $name
    while ($parent.Contains('/')) { $parent = $parent.Substring(0, $parent.LastIndexOf('/')); $directories[$parent] = $true }
  }
  $pending = @(''); $seen = @{}
  while ($pending.Count) {
    $relative = $pending[0]; $pending = @($pending | Select-Object -Skip 1)
    foreach ($item in @(Get-ChildItem -LiteralPath (Join-Path $directory $relative) -Force)) {
      $name = $item.Name; if ($relative) { $name = $relative + '/' + $name }
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Unknown or linked runtime path; use the release page: ' + $item.FullName) }
      if ($name -match '^(?i:fonts|resources/(?:fonts|local-index))(?:/|$)') { continue }
      if ($item.PSIsContainer) {
        if (-not $directories.ContainsKey($name)) { throw ('Unknown runtime path; use the release page: ' + $item.FullName) }
        $pending += $name
      } elseif (-not $files.ContainsKey($name)) { throw ('Unknown runtime path; use the release page: ' + $item.FullName) }
      else { $seen[$name] = $true }
    }
  }
  foreach ($name in @($files.Keys)) {
    $target = Join-Path $directory $name; $file = $files[$name]
    if (-not $seen.ContainsKey($name)) { throw ('Owned runtime file is missing: ' + $target) }
    if ($file -and ((Get-Item -LiteralPath $target).Length -ne $file.bytes -or (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $file.sha256)) { throw ('Owned runtime file changed; use the release page: ' + $target) }
  }
}
function Get-AlbumRuntimeEntries($directory) {
  $m = Get-AlbumOwnership $directory
  foreach ($file in @($m.files)) { $file.path }
  'resources/runtime-owned-files.json'
}
function Move-AlbumRuntimeFile($source, $destination) {
  $item = Get-Item -LiteralPath $source -Force
  if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Owned runtime file changed: ' + $source) }
  New-Item -ItemType Directory -Path (Split-Path -LiteralPath $destination) -Force | Out-Null
  Move-Item -LiteralPath $source -Destination $destination -Force -ErrorAction Stop
}
function Remove-AlbumRuntimeFile($file) {
  if (Test-Path -LiteralPath $file) {
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Cannot remove an unproven runtime path: ' + $file) }
    Remove-Item -LiteralPath $file -Force -ErrorAction Stop
  }
}
function Remove-AlbumEmptyRuntimeDirectories($directory, $entries) {
  $directories = @{}
  foreach ($name in @($entries)) {
    while ($name.Contains('/')) { $name = $name.Substring(0, $name.LastIndexOf('/')); $directories[$name] = $true }
  }
  foreach ($name in @($directories.Keys | Sort-Object Length -Descending)) {
    $target = Join-Path $directory $name
    if ((Test-Path -LiteralPath $target -PathType Container) -and @(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { Remove-Item -LiteralPath $target -Force -ErrorAction Stop }
  }
}
function Confirm-AlbumBundledIndexTree($index) {
  if (Test-Path -LiteralPath $index) {
    Assert-AlbumPlainTree $index
    foreach ($item in @(Get-ChildItem -LiteralPath $index -Force)) {
      if ($item.PSIsContainer -or $item.Name -cnotin @('manifest.json', 'subjects.sqlite')) { throw ('Unknown offline-index path; use the release page: ' + $item.FullName) }
    }
  }
}
function Install-AlbumRuntime {
  $parent = Split-Path -LiteralPath $p.directory
  $stage = Join-Path $parent ('ACG-album-runtime-stage-' + [Guid]::NewGuid().ToString('N'))
  $backup = Join-Path $parent ('ACG-album-runtime-backup-' + [Guid]::NewGuid().ToString('N'))
  $oldMoved = @(); $newMoved = @(); $committed = $false
  try {
    Assert-AlbumPlainTree $p.directory
    Confirm-AlbumRuntimeOwnership $p.directory $p.ownershipSha256
    $oldEntries = @(Get-AlbumRuntimeEntries $p.directory)
    Confirm-AlbumIndex
    $manifestHash = $null
    if ($p.indexIdentity.variant -ne 'standard') { $manifestHash = (Get-FileHash -LiteralPath (Join-Path $p.directory 'resources\local-index\manifest.json') -Algorithm SHA256).Hash }
    New-Item -ItemType Directory -Path $stage -ErrorAction Stop | Out-Null
    Expand-AlbumRuntime $stage
    Confirm-AlbumRuntimeOwnership $stage
    if ((Get-AlbumOwnership $stage).version -cne $p.runtimeManifest.version) { throw 'Runtime ownership version differs.' }
    foreach ($relative in @('fonts', 'resources\fonts')) {
      $source = Join-Path $p.directory $relative
      if (Test-Path -LiteralPath $source) {
        $target = Join-Path $stage $relative
        New-Item -ItemType Directory -Path (Split-Path -LiteralPath $target) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop
        foreach ($font in @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)) {
          $suffix = $font.FullName.Substring($source.Length).TrimStart('\')
          if ((Get-FileHash -LiteralPath $font.FullName -Algorithm SHA256).Hash -ine (Get-FileHash -LiteralPath (Join-Path $target $suffix) -Algorithm SHA256).Hash) { throw 'Existing fonts could not be preserved.' }
        }
      }
    }
    Copy-AlbumFontOverlay $stage
    New-Item -ItemType Directory -Path (Join-Path $backup 'resources') -ErrorAction Stop | Out-Null
    foreach ($relative in $oldEntries) {
      Move-AlbumRuntimeFile (Join-Path $p.directory $relative) (Join-Path $backup $relative)
      $oldMoved += $relative
    }
    New-Item -ItemType Directory -Path (Join-Path $p.directory 'resources') -Force | Out-Null
    foreach ($relative in @(Get-AlbumRuntimeEntries $stage)) {
      Move-AlbumRuntimeFile (Join-Path $stage $relative) (Join-Path $p.directory $relative)
      $newMoved += $relative
    }
    Remove-AlbumEmptyRuntimeDirectories $p.directory $oldEntries
    Confirm-AlbumRuntimeFiles $p.directory
    Confirm-AlbumRuntimeOwnership $p.directory
    Confirm-AlbumIndex
    if ($manifestHash -and (Get-FileHash -LiteralPath (Join-Path $p.directory 'resources\local-index\manifest.json') -Algorithm SHA256).Hash -cne $manifestHash) { throw 'Original index manifest changed.' }
    Copy-AlbumFontOverlay $p.directory
    $committed = $true
  } catch {
    $failure = $_
    foreach ($relative in $newMoved) { Remove-AlbumRuntimeFile (Join-Path $p.directory $relative) }
    Remove-AlbumEmptyRuntimeDirectories $p.directory $newMoved
    foreach ($relative in $oldMoved) { Move-AlbumRuntimeFile (Join-Path $backup $relative) (Join-Path $p.directory $relative) }
    throw $failure
  } finally {
    # Keep the backup on any failure for recovery, including a failed rollback.
    if ($committed) { Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
`;
}

function editionTransactionScript() {
  return String.raw`
function Invoke-AlbumInstaller($mode) {
  return Start-Process -FilePath $p.installer -ArgumentList ('/S /' + $mode + ' /D=' + $p.directory) -Wait -PassThru
}
function Install-AlbumEdition($mode) {
  $index = Join-Path $p.directory 'resources\local-index'
  $backup = Join-Path (Split-Path -LiteralPath $p.directory) ('ACG-album-update-backup-' + [Guid]::NewGuid().ToString('N'))
  $hadIndex = Test-Path -LiteralPath $index
  $backedUp = $false
  $runtimeBackedUp = $false
  $installerStarted = $false
  $committed = $false
  try {
    if ($p.mode -eq 'full') {
      Assert-AlbumPlainTree $p.directory
      Confirm-AlbumRuntimeOwnership $p.directory $p.ownershipSha256
      Confirm-AlbumBundledIndexTree $index
      $oldRuntimeEntries = @(Get-AlbumRuntimeEntries $p.directory)
      New-Item -ItemType Directory -Path (Join-Path $backup 'runtime\resources') -ErrorAction Stop | Out-Null
      foreach ($relative in $oldRuntimeEntries) {
        $target = Join-Path $backup ('runtime\' + $relative)
        New-Item -ItemType Directory -Path (Split-Path -LiteralPath $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $p.directory $relative) -Destination $target -ErrorAction Stop
      }
      foreach ($relative in @('fonts', 'resources\fonts')) {
        $source = Join-Path $p.directory $relative
        if (Test-Path -LiteralPath $source) {
          $target = Join-Path $backup ('preserved\' + $relative)
          New-Item -ItemType Directory -Path (Split-Path -LiteralPath $target) -Force | Out-Null
          Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop
        }
      }
      $runtimeBackedUp = $true
    }
    if ($hadIndex) {
      if ((Get-Item -LiteralPath $index -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bundled index is linked. Manual update is required.' }
      New-Item -ItemType Directory -Path $backup -Force -ErrorAction Stop | Out-Null
      Move-Item -LiteralPath $index -Destination (Join-Path $backup 'local-index') -ErrorAction Stop
      $backedUp = $true
    }
    $installerStarted = $true
    $installed = Invoke-AlbumInstaller $mode
    if ($installed.ExitCode -ne 0) { throw ('Installer failed with exit code ' + $installed.ExitCode) }
    if (-not (Test-Path -LiteralPath $p.executable -PathType Leaf)) { throw 'Updated executable was not found at the intended location.' }
    if ($p.edition -eq 'standard') {
      if (Test-Path -LiteralPath $index) { throw 'Standard installation unexpectedly contains an offline index.' }
    } else {
      $manifestFile = Join-Path $index 'manifest.json'
      if ((Get-Item -LiteralPath $manifestFile).Length -gt 65536) { throw 'Bundled index manifest is too large.' }
      $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
      $database = Join-Path $index 'subjects.sqlite'
      if ($manifest.variant -ne $p.edition -or $manifest.database -ne 'subjects.sqlite' -or $manifest.readerSchemaVersion -ne 1 -or $manifest.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-Item -LiteralPath $database).Length -ne $manifest.bytes -or (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash -ine $manifest.sha256) { throw 'Installed offline index does not match the selected edition or manifest.' }
    }
    if ($runtimeBackedUp) {
      foreach ($relative in @('fonts', 'resources\fonts')) {
        $source = Join-Path $backup ('preserved\' + $relative)
        if (Test-Path -LiteralPath $source) {
          $target = Join-Path $p.directory $relative
          New-Item -ItemType Directory -Path $target -Force | Out-Null
          foreach ($file in @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)) {
            $suffix = $file.FullName.Substring($source.Length).TrimStart('\')
            $destination = Join-Path $target $suffix
            New-Item -ItemType Directory -Path (Split-Path -LiteralPath $destination) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $destination -Force -ErrorAction Stop
          }
        }
      }
    }
    if ($p.fontOverlay) { Copy-AlbumFontOverlay $p.directory }
    if ($p.mode -eq 'full') {
      Confirm-AlbumRuntimeOwnership $p.directory
      if ((Get-AlbumOwnership $p.directory).version -cne $p.version) { throw 'Installed runtime ownership version differs.' }
    }
    $committed = $true
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  } catch {
    $failure = $_
    if (-not $committed -and $backedUp) {
      if (Test-Path -LiteralPath $index) { Remove-Item -LiteralPath $index -Recurse -Force }
      New-Item -ItemType Directory -Path (Split-Path -LiteralPath $index) -Force | Out-Null
      Move-Item -LiteralPath (Join-Path $backup 'local-index') -Destination $index -ErrorAction Stop
    } elseif (-not $committed -and -not $hadIndex -and (Test-Path -LiteralPath $index)) {
      Remove-Item -LiteralPath $index -Recurse -Force
    }
    if (-not $committed -and $runtimeBackedUp -and $installerStarted) {
      # A failed installer may remove the entire old Standard directory. Create
      # it before restoring; remove only exact old-owned file collisions.
      New-Item -ItemType Directory -Path (Join-Path $p.directory 'resources') -Force | Out-Null
      foreach ($relative in $oldRuntimeEntries) {
        Remove-AlbumRuntimeFile (Join-Path $p.directory $relative)
        Move-AlbumRuntimeFile (Join-Path $backup ('runtime\' + $relative)) (Join-Path $p.directory $relative)
      }
      foreach ($relative in @('fonts', 'resources\fonts')) {
        $source = Join-Path $backup ('preserved\' + $relative)
        if (Test-Path -LiteralPath $source) {
          $target = Join-Path $p.directory $relative
          New-Item -ItemType Directory -Path (Split-Path -LiteralPath $target) -Force | Out-Null
          if (-not (Test-Path -LiteralPath $target)) { Copy-Item -LiteralPath $source -Destination $target -Recurse -ErrorAction Stop }
          else {
            foreach ($file in @(Get-ChildItem -LiteralPath $source -File -Recurse -Force)) {
              $destination = Join-Path $target ($file.FullName.Substring($source.Length).TrimStart('\'))
              New-Item -ItemType Directory -Path (Split-Path -LiteralPath $destination) -Force | Out-Null
              Copy-Item -LiteralPath $file.FullName -Destination $destination -Force -ErrorAction Stop
            }
          }
        }
      }
    }
    if (-not $committed -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Recurse -Force }
    throw $failure
  }
}
`;
}

function helperScript(plan) {
  const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
  // No interpolated paths/commands: all variable data is decoded JSON, passed as data.
  return `\uFEFFparam([switch]$Apply)\n$ErrorActionPreference = 'Stop'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json
$log = Join-Path (Split-Path -LiteralPath $p.installer) 'install.log'
$started = $false
$parentExited = $false
${registryValidationScript()}
${runtimeTransactionScript()}
${editionTransactionScript()}
function Restart-Album {
  $env:ACG_DATA_DIR = $p.dataDirectory
  $env:ACG_USER_DATA_DIR = $p.userData
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Start-Process -FilePath $p.executable -ArgumentList ('--user-data-dir="' + $p.userData + '"') -WorkingDirectory $p.directory
}
try {
  $parent = Get-Process -Id $p.parentPid -ErrorAction SilentlyContinue
  if ($parent) { $parent.WaitForExit(120000) | Out-Null; if (-not $parent.HasExited) { throw 'Application did not exit within 120 seconds. Installer was not started.' } }
  $parentExited = $true
  # The same check already ran before quitting; repeat after exit to catch changes.
  $mode = Confirm-AlbumInstallation @(Read-AlbumRegistrations)
  if ((Get-FileHash -LiteralPath $p.installer -Algorithm SHA256).Hash -ine $p.sha256) { throw 'Installer SHA-256 changed. Installer was not started.' }
  # All-users backups require elevation; only the transaction is elevated.
  # The original helper always restarts the app with the original user/profile.
  if ($mode -eq 'allusers' -and -not $Apply) {
    $shell = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    $transaction = Start-Process -FilePath $shell -Verb RunAs -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Apply') -Wait -PassThru
    if ($transaction.ExitCode -ne 0) { throw 'Elevated update transaction failed. See install.log.' }
  } elseif ($p.mode -eq 'runtime') { Install-AlbumRuntime } else { Install-AlbumEdition $mode }
  if ($Apply) { exit 0 }
  Restart-Album
  $started = $true
  'Update installed successfully.' | Out-File -LiteralPath $log -Encoding utf8
} catch {
  $message = $_.Exception.Message
  $message | Out-File -LiteralPath $log -Encoding utf8
  if ($Apply) { exit 1 }
  # The verified download remains available for retry. Never remove user data.
  if ($parentExited -and -not $started -and (Test-Path -LiteralPath $p.executable -PathType Leaf)) { try { Restart-Album } catch {} }
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(('Update could not complete. Your library was retained. See ' + $log + [Environment]::NewLine + $message), 'ACG-album update') | Out-Null
  exit 1
}
`;
}

async function launchInstaller(plan, { spawnProcess = spawn, writeFile = fs.writeFile } = {}) {
  const script = path.win32.join(path.win32.dirname(plan.installer), 'install.ps1');
  await writeFile(script, helperScript(plan), { encoding: 'utf8', flag: 'w' });
  const powershell = path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const child = spawnProcess(
    powershell,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, ACG_DATA_DIR: plan.dataDirectory }
    }
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
}

module.exports = {
  contains,
  appGuid,
  installationPlan,
  registryValidationScript,
  preflightScript,
  preflightInstallation,
  editionTransactionScript,
  runtimeTransactionScript,
  helperScript,
  launchInstaller
};
