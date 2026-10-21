'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const metadata = require('../package.json');
const version = metadata.version;
const productName = metadata.build.productName;
const executableName = `${productName}.exe`;
const artifactRoot = require('node:fs').realpathSync(path.join(root, 'artifacts'));
const smokeRoot = path.join(artifactRoot, 'installer-smoke');
const run = path.join(
  smokeRoot,
  new Date().toISOString().replaceAll(':', '-') + '-' + crypto.randomUUID()
);
const installed = path.join(run, 'application');
const profile = path.join(run, 'profile');
const source = require('./distribution-paths.cjs').runtimeDirectory();
const installer = path.join(
  require('./distribution-paths.cjs').installerDirectory(),
  `${productName} Setup ${version}.exe`
);
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function parseArguments(args) {
  assert.ok(
    args.every((arg) => arg === '--preserve-existing-profiles'),
    'Only --preserve-existing-profiles is accepted; unknown arguments refuse installation.'
  );
  assert.ok(new Set(args).size === args.length, 'Duplicate smoke arguments are not accepted.');
  return { preserveExistingProfiles: args.includes('--preserve-existing-profiles') };
}

function assertPreserveMetadata(preserveExistingProfiles, packageMetadata = metadata) {
  if (!preserveExistingProfiles) return;
  assert.equal(packageMetadata.build?.appId, 'local.acg.album', 'Unexpected application ID.');
  assert.equal(
    packageMetadata.build?.nsis?.deleteAppDataOnUninstall,
    false,
    'Preserve mode requires deleteAppDataOnUninstall: false.'
  );
}

function isolatedEnvironment(environment = process.env) {
  const env = { ...environment };
  // Windows environment keys are case-insensitive, including keys inherited from another shell.
  for (const key of Object.keys(env)) {
    if (['ACG_DATA_DIR', 'ACG_TEST', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase()))
      delete env[key];
  }
  return { ...env, ACG_DATA_DIR: profile, ACG_TEST: '1' };
}

// Installation changes the current user's registry and Start Menu. Refuse to
// displace any real installation, shortcut or running instance, even an old one.
// Preserve mode bypasses only profile existence; every installation guard remains unconditional.
function safetyCommand(preserveExistingProfiles) {
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$preserveExistingProfiles = $${preserveExistingProfiles ? 'true' : 'false'}
$keys = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')
$names = @('ACG-album', 'acg-album', '玖玖瑠相册', '拾光相册')
$existing = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'ACG-album|玖玖瑠|拾光相册' })
if ($existing.Count -gt 0) { throw 'ALBUM_INSTALL_EXISTS' }
foreach ($name in $names) {
  if (Get-Process -Name $name -ErrorAction SilentlyContinue) { throw 'ALBUM_PROCESS_RUNNING' }
}
$profileRoots = @($env:APPDATA, $env:LOCALAPPDATA, [Environment]::GetFolderPath('MyDocuments'))
$profileCandidates = @('${path.join(root, 'data').replaceAll("'", "''")}', '${path.join(require('./distribution-paths.cjs').workspaceRoot, '.review-data').replaceAll("'", "''")}')
foreach ($folder in $profileRoots) {
  if (-not $folder) { continue }
  foreach ($name in $names) {
    $profileCandidates += Join-Path $folder $name
    if (Test-Path -LiteralPath (Join-Path $folder ('Programs\\' + $name))) { throw 'ALBUM_INSTALL_DIRECTORY_EXISTS' }
  }
}
$installationRoots = @($env:ProgramFiles, ${'${env:ProgramFiles(x86)}'}, $env:ProgramW6432)
foreach ($folder in $installationRoots) {
  if (-not $folder) { continue }
  foreach ($name in $names) {
    if (Test-Path -LiteralPath (Join-Path $folder $name)) { throw 'ALBUM_INSTALL_DIRECTORY_EXISTS' }
  }
}
if (-not $preserveExistingProfiles) {
  foreach ($folder in $profileCandidates) {
    if (Test-Path -LiteralPath $folder) { throw 'ALBUM_PROFILE_EXISTS' }
  }
}
$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
foreach ($folder in $folders) {
  if (-not $folder) { continue }
  foreach ($name in @('ACG-album.lnk', 'ACG-album', 'acg-album.lnk', 'acg-album', '玖玖瑠相册.lnk', '玖玖瑠相册', '拾光相册.lnk', '拾光相册')) {
    if (Test-Path -LiteralPath (Join-Path $folder $name)) { throw 'ALBUM_SHORTCUT_EXISTS' }
  }
}
[pscustomobject]@{ status = 'SAFE_TO_TEST'; profileCandidates = @($profileCandidates) } | ConvertTo-Json -Compress
`;
}

function ensureNoExistingInstallation(preserveExistingProfiles) {
  assertPreserveMetadata(preserveExistingProfiles);
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-EncodedCommand',
      Buffer.from(safetyCommand(preserveExistingProfiles), 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  );
  assert.equal(
    result.status,
    0,
    'Installer smoke refuses an existing installation, shortcut, app process or unapproved profile. ' +
      (result.error?.message || result.stderr || '')
  );
  const safety = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(safety.status, 'SAFE_TO_TEST');
  assert.ok(Array.isArray(safety.profileCandidates));
  return [...new Set(safety.profileCandidates.map((candidate) => path.resolve(candidate)))];
}

function assertChildPath(parent, target) {
  assert.ok(path.isAbsolute(parent) && path.isAbsolute(target), 'Require absolute test targets.');
  const relative = path.relative(parent, target);
  assert.ok(
    relative &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative),
    'Refusing a target outside the isolated test directory: ' + target
  );
}

async function assertIsolatedTargets() {
  assertChildPath(artifactRoot, smokeRoot);
  assertChildPath(smokeRoot, run);
  assert.equal(installed, path.join(run, 'application'));
  assert.equal(profile, path.join(run, 'profile'));
  assertChildPath(run, installed);
  assertChildPath(run, profile);
  // Reject junctions/symlinks before creation, execution and removal, including ancestors.
  for (const target of [installed, profile]) {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep)) {
      current = path.join(current, component);
      const stat = await fs.lstat(current).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) break;
      assert.equal(stat.isSymbolicLink(), false, 'Refusing linked test target: ' + current);
      assert.equal(stat.isDirectory(), true, 'Expected test directory: ' + current);
      assert.equal(
        (await fs.realpath(current)).toLowerCase(),
        path.resolve(current).toLowerCase(),
        'Refusing redirected test target: ' + current
      );
    }
  }
}

async function criticalProfileFiles() {
  // Read source only to obtain the encrypted filename, never a saved token value.
  const mainSource = await fs.readFile(path.join(root, 'src/main.cjs'), 'utf8');
  const tokenName = mainSource.match(
    /tokenPath\s*=\s*path\.join\(dataDir,\s*['"]([^'"\r\n]+)['"]\s*\)/
  )?.[1];
  assert.ok(
    tokenName && path.basename(tokenName) === tokenName,
    'Cannot identify encrypted token filename.'
  );
  return [
    'library.sqlite',
    'library.sqlite-wal',
    'library.sqlite-shm',
    ...new Set(['token.bin', tokenName]),
    'window.json',
    'Local State',
    path.join('Default', 'Preferences'),
    path.join('chromium-profile', 'Local State'),
    path.join('chromium-profile', 'Default', 'Preferences')
  ];
}

async function snapshotFile(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return { present: false };
    throw error;
  }
  try {
    const before = await handle.stat();
    assert.ok(before.isFile(), 'Expected a critical profile file: ' + file);
    const digest = crypto.createHash('sha256');
    // Stream through the same read-only handle; no profile copies or contents enter the report.
    for await (const chunk of createReadStream(file, { fd: handle.fd, autoClose: false }))
      digest.update(chunk);
    const after = await handle.stat();
    assert.equal(after.size, before.size, 'Profile changed during snapshot: ' + file);
    assert.equal(after.mtimeMs, before.mtimeMs, 'Profile changed during snapshot: ' + file);
    return { present: true, size: after.size, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function snapshotProfiles(candidates, criticalFiles) {
  const files = [];
  for (const candidate of candidates) {
    for (const relative of criticalFiles) {
      const file = path.join(candidate, relative);
      assertChildPath(candidate, file);
      files.push({ file, ...(await snapshotFile(file)) });
    }
  }
  return files;
}

function changedSnapshotFiles(before, after) {
  const afterByPath = new Map(after.map((entry) => [entry.file, entry]));
  return before
    .filter((entry) => JSON.stringify(entry) !== JSON.stringify(afterByPath.get(entry.file)))
    .map((entry) => entry.file);
}

function execute(file, args, env) {
  assert.equal(env.ACG_DATA_DIR, profile);
  assert.equal(env.ACG_TEST, '1');
  assert.ok(!Object.keys(env).some((key) => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE'));
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'ignore', timeout: 120000, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`Installer process exited ${code}, signal ${signal}`))
    );
  });
}
async function walk(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await walk(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

async function main(args = process.argv.slice(2)) {
  const { preserveExistingProfiles } = parseArguments(args);
  assertPreserveMetadata(preserveExistingProfiles);
  const candidates = ensureNoExistingInstallation(preserveExistingProfiles);
  await assertIsolatedTargets();
  // An exclusive run directory prevents cleanup from adopting any pre-existing test installation.
  await fs.mkdir(smokeRoot, { recursive: true });
  await fs.mkdir(run);
  await fs.mkdir(profile);
  const env = isolatedEnvironment();
  const report = {
    version,
    run,
    started: new Date().toISOString(),
    preserveExistingProfiles,
    existingCriticalFilesUnchanged: null,
    isolatedRuntime: false,
    childEnvironment: { ACG_DATA_DIR: profile, ACG_TEST: '1', ELECTRON_RUN_AS_NODE: 'cleared' },
    passed: false,
    errors: []
  };
  let app,
    failure,
    before,
    criticalFiles,
    installAttempted = false;
  try {
    criticalFiles = await criticalProfileFiles();
    before = await snapshotProfiles(candidates, criticalFiles);
    report.existingProfilesBefore = before;
    await fs.writeFile(path.join(profile, 'preserve-on-uninstall.txt'), 'isolated test data');
    report.installerSha256 = hash(await fs.readFile(installer));
    await assertIsolatedTargets();
    // Recheck immediately before installing; never upgrade or uninstall a real installation.
    ensureNoExistingInstallation(preserveExistingProfiles);
    installAttempted = true;
    await execute(
      installer,
      ['/S', '/currentuser', '--no-desktop-shortcut', '/D=' + installed],
      env
    );
    console.log('PASS silent current-user installation into isolated directory');
    const exe = path.join(installed, executableName);
    assert.ok((await fs.stat(exe)).isFile());
    const files = await walk(source);
    for (const file of files) {
      const relative = path.relative(source, file);
      assert.equal(
        hash(await fs.readFile(path.join(installed, relative))),
        hash(await fs.readFile(file)),
        relative
      );
    }
    report.installedFilesVerified = files.length;
    report.installedBytes = (
      await Promise.all(
        files.map(
          async (file) => (await fs.stat(path.join(installed, path.relative(source, file)))).size
        )
      )
    ).reduce((a, b) => a + b, 0);
    report.asarSha256 = hash(await fs.readFile(path.join(installed, 'resources/app.asar')));
    console.log(`PASS ${files.length} installed files match the tested directory build`);
    const { _electron: electron } = require('@playwright/test');
    app = await electron.launch({ executablePath: exe, env, timeout: 30000 });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.waitForFunction(
      () =>
        typeof api === 'function' &&
        S.settings &&
        document.querySelector('#index-count')?.textContent !== '正在准备资料库'
    );
    report.runtime = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      userData: app.getPath('userData'),
      dataDir: process.env.ACG_DATA_DIR,
      testMode: process.env.ACG_TEST,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null
    }));
    assert.equal(report.runtime.version, version);
    assert.equal(report.runtime.packaged, true);
    assert.equal(report.runtime.userData, path.join(profile, 'chromium-profile'));
    assert.equal(report.runtime.dataDir, profile);
    assert.equal(report.runtime.testMode, '1');
    assert.equal(report.runtime.electronRunAsNode, null);
    report.isolatedRuntime = true;
    report.appInfo = await page.evaluate(() => api('appInfo'));
    assert.equal(report.appInfo.version, version);
    assert.equal(report.appInfo.repository, '');
    await page.screenshot({ path: path.join(run, 'installed-first-launch.png') });
    assert.deepEqual(report.errors, []);
    await app.close();
    app = null;
    console.log('PASS installed application boots with isolated data and shuts down cleanly');
  } catch (error) {
    failure = error;
    report.error = error.stack;
  } finally {
    if (app) await app.close().catch(() => {});
    if (installAttempted) {
      try {
        await assertIsolatedTargets();
        const uninstaller = (await fs.readdir(installed).catch(() => [])).find((name) =>
          /^Uninstall.*\.exe$/i.test(name)
        );
        assert.ok(uninstaller, 'Expected isolated installation uninstaller was not created.');
        const uninstallPath = path.join(installed, uninstaller);
        assertChildPath(installed, uninstallPath);
        const uninstallStat = await fs.lstat(uninstallPath);
        assert.ok(uninstallStat.isFile() && !uninstallStat.isSymbolicLink());
        // _? keeps NSIS synchronous rather than copying to a detached temp process.
        await execute(uninstallPath, ['/S', '/currentuser', '_?=' + installed], env);
        assert.equal(
          await fs.stat(path.join(installed, executableName)).then(
            () => true,
            () => false
          ),
          false
        );
        assert.equal(
          await fs.readFile(path.join(profile, 'preserve-on-uninstall.txt'), 'utf8'),
          'isolated test data'
        );
        ensureNoExistingInstallation(preserveExistingProfiles);
        report.uninstalled = true;
        report.profilePreserved = true;
        console.log('PASS uninstall removes program registration and preserves isolated test data');
        await assertIsolatedTargets();
        console.log('Remove verified test-only installation directory: ' + path.resolve(installed));
        await fs.rm(installed, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        failure ||= error;
        report.uninstallError = error.stack;
      }
    }
    if (before) {
      try {
        const after = await snapshotProfiles(candidates, criticalFiles);
        report.existingProfilesAfter = after;
        report.changedCriticalFiles = changedSnapshotFiles(before, after);
        report.existingCriticalFilesUnchanged = report.changedCriticalFiles.length === 0;
        assert.equal(
          report.existingCriticalFilesUnchanged,
          true,
          'Existing critical profile files changed; no automatic restoration attempted: ' +
            report.changedCriticalFiles.join(', ')
        );
      } catch (error) {
        failure ||= error;
        report.existingCriticalFilesUnchanged = false;
        report.profileVerificationError = error.stack;
      }
    }
    report.finished = new Date().toISOString();
    report.passed =
      !failure &&
      report.uninstalled === true &&
      report.isolatedRuntime === true &&
      report.existingCriticalFilesUnchanged === true;
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  if (failure) throw failure;
  console.log(
    JSON.stringify({
      run,
      passed: report.passed,
      preserveExistingProfiles,
      existingCriticalFilesUnchanged: report.existingCriticalFilesUnchanged,
      isolatedRuntime: report.isolatedRuntime,
      installedFilesVerified: report.installedFilesVerified
    })
  );
}

// Pure helpers are exported for static checks; importing this file performs no smoke operations.
module.exports = {
  parseArguments,
  assertPreserveMetadata,
  isolatedEnvironment,
  safetyCommand,
  assertChildPath,
  changedSnapshotFiles
};
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
