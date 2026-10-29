'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');

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
  return {
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
  const encoded = Buffer.from(JSON.stringify(plan), 'utf8').toString('base64');
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
  $committed = $false
  try {
    if ($hadIndex) {
      if ((Get-Item -LiteralPath $index -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Bundled index is linked. Manual update is required.' }
      New-Item -ItemType Directory -Path $backup -ErrorAction Stop | Out-Null
      Move-Item -LiteralPath $index -Destination (Join-Path $backup 'local-index') -ErrorAction Stop
      $backedUp = $true
    }
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
    $committed = $true
    if ($backedUp) { Remove-Item -LiteralPath $backup -Recurse -Force }
  } catch {
    $failure = $_
    if (-not $committed -and $backedUp) {
      if (Test-Path -LiteralPath $index) { Remove-Item -LiteralPath $index -Recurse -Force }
      New-Item -ItemType Directory -Path (Split-Path -LiteralPath $index) -Force | Out-Null
      Move-Item -LiteralPath (Join-Path $backup 'local-index') -Destination $index -ErrorAction Stop
      Remove-Item -LiteralPath $backup -Force
    } elseif (-not $committed -and -not $hadIndex -and (Test-Path -LiteralPath $index)) {
      Remove-Item -LiteralPath $index -Recurse -Force
    }
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
  } else { Install-AlbumEdition $mode }
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
  helperScript,
  launchInstaller
};
