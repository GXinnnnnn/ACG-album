'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  appGuid,
  registryValidationScript,
  editionTransactionScript,
  preflightInstallation
} = require('../src/update-install.cjs');
const { assertExternalPaths } = require('../src/update-service.cjs');
const powershell = path.win32.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
const decode = (value) =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(value)).toString('base64')}')) | ConvertFrom-Json`;
function run(source) {
  const result = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from("$ErrorActionPreference = 'Stop'\n" + source, 'utf16le').toString('base64')
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true }
  );
  assert.equal(result.error, undefined);
  return result;
}

test('NSIS identity is stable even when packaged metadata has no build field', () => {
  const metadata = require('../package.json');
  const previous = metadata.build;
  try {
    delete metadata.build;
    assert.equal(appGuid(), '01590695-ff0e-5a5a-91df-33cd1f350739');
  } finally {
    metadata.build = previous;
  }
});

test(
  'actual PowerShell validator accepts NSIS install keys and quoted uninstall fallback across both hives/views',
  { skip: process.platform !== 'win32' },
  () => {
    for (const hive of ['CurrentUser', 'LocalMachine']) {
      for (const fallback of [false, true]) {
        const records = ['Registry64', 'Registry32'].map((view) => ({
          hive,
          view,
          installLocation: fallback ? null : 'C:\\Program Files\\ACG-album',
          uninstallString: '"C:\\Program Files\\ACG-album\\Uninstall ACG-album.exe" /currentuser',
          uninstallExists: true
        }));
        const result = run(
          `$p = ${decode({ directory: 'C:\\Program Files\\ACG-album' })}\n${registryValidationScript()}\n$records = ${decode(records)}\nConfirm-AlbumInstallation $records`
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, hive === 'CurrentUser' ? /currentuser/ : /allusers/);
      }
    }
    const manual = run(
      `$p = ${decode({ directory: 'D:\\ACG-album' })}\n${registryValidationScript()}\nConfirm-AlbumInstallation @()`
    );
    assert.equal(manual.status, 0, manual.stderr);
    assert.match(manual.stdout, /currentuser/);
  }
);

test(
  'actual PowerShell validator rejects foreign directory, conflicting uninstall path, missing data and ambiguous scope',
  { skip: process.platform !== 'win32' },
  () => {
    const base = {
      hive: 'CurrentUser',
      view: 'Registry64',
      installLocation: 'C:\\Apps\\ACG-album',
      uninstallString: '"C:\\Apps\\ACG-album\\Uninstall ACG-album.exe" /currentuser',
      uninstallExists: true
    };
    for (const records of [
      [{ ...base, installLocation: 'D:\\other' }],
      [{ ...base, uninstallString: '"D:\\other\\Uninstall ACG-album.exe" /currentuser' }],
      [{ ...base, installLocation: null, uninstallString: null }],
      [{ ...base, uninstallString: 'C:\\Apps\\ACG-album\\uninstall.exe' }],
      [base, { ...base, hive: 'LocalMachine' }]
    ]) {
      const result = run(
        `$p = ${decode({ directory: 'C:\\Apps\\ACG-album' })}\n${registryValidationScript()}\n$records = ${decode(records)}\nConfirm-AlbumInstallation $records`
      );
      assert.notEqual(result.status, 0);
      assert.match(
        result.stderr,
        /different directory|incomplete|uninstaller path|single registered/
      );
    }
  }
);

test(
  'production registry reader opens both Windows views read-only and permits an unregistered deployment',
  { skip: process.platform !== 'win32' },
  async () => {
    await preflightInstallation({
      appGuid: '00000000-0000-0000-0000-000000000000',
      directory: 'C:\\Unregistered fixture'
    });
  }
);

test('preflight is bounded and rejects failed registry validation before any installation handoff', async () => {
  const plan = { directory: 'C:\\Apps\\ACG-album', appGuid: appGuid() };
  let killed = false;
  const processFor = (outcome) => () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      killed = true;
    };
    if (outcome !== 'timeout')
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('Different registered directory'));
        child.emit('exit', outcome);
      });
    return child;
  };
  await preflightInstallation(plan, { spawnProcess: processFor(0) });
  await assert.rejects(preflightInstallation(plan, { spawnProcess: processFor(1) }), /预检失败/);
  await assert.rejects(
    preflightInstallation(plan, { spawnProcess: processFor('timeout'), timeoutMs: 5 }),
    /预检超时/
  );
  assert.equal(killed, true);
});

for (const [oldEdition, edition, failure] of [
  ['full', 'standard', ''],
  ['lite', 'full', ''],
  ['standard', 'lite', ''],
  ['full', 'lite', 'exit'],
  ['full', 'lite', 'manifest'],
  ['standard', 'lite', 'manifest']
]) {
  test(
    `transaction ${oldEdition} -> ${edition}${failure ? ' rolls back ' + failure : ' replaces only bundled index'}`,
    { skip: process.platform !== 'win32' },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'album-edition-transaction-'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const directory = path.join(root, 'custom application');
      const index = path.join(directory, 'resources', 'local-index');
      const profile = path.join(root, 'profile');
      await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
      await fs.mkdir(profile);
      await fs.writeFile(path.join(profile, 'token'), 'untouched-token-and-roots');
      const executable = path.join(directory, 'ACG-album.exe');
      await fs.writeFile(executable, 'THIS IS NOT AN EXECUTABLE');
      if (oldEdition !== 'standard') {
        await fs.mkdir(index);
        await fs.writeFile(path.join(index, 'old-index'), oldEdition);
      }
      // Only shared function definitions are evaluated; the installer function is
      // replaced before the transaction. No real helper or installer is executed.
      const source = `$p = ${decode({ directory, executable, edition, installer: 'NEVER_EXECUTE' })}\n$failure = '${failure}'\n${editionTransactionScript()}\nfunction Invoke-AlbumInstaller($mode) {
      if ($failure -eq 'exit') { return @{ ExitCode = 7 } }
      if ($p.edition -ne 'standard') {
        $index = Join-Path $p.directory 'resources\\local-index'
        New-Item -ItemType Directory -Path $index -Force | Out-Null
        $database = Join-Path $index 'subjects.sqlite'
        [IO.File]::WriteAllText($database, 'NEW DATABASE FIXTURE')
        $variant = $p.edition; if ($failure -eq 'manifest') { $variant = 'standard' }
        @{ variant = $variant; database = 'subjects.sqlite'; readerSchemaVersion = 1; bytes = (Get-Item -LiteralPath $database).Length; sha256 = (Get-FileHash -LiteralPath $database -Algorithm SHA256).Hash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $index 'manifest.json') -Encoding UTF8
      }
      return @{ ExitCode = 0 }
    }
    try { Install-AlbumEdition 'currentuser'; if ($failure) { throw 'Expected rollback did not happen' } }
    catch { if (-not $failure -or $_.Exception.Message -eq 'Expected rollback did not happen') { throw } }; exit 0`;
      const result = run(source);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (failure && oldEdition !== 'standard')
        assert.equal(await fs.readFile(path.join(index, 'old-index'), 'utf8'), oldEdition);
      else if (failure) await assert.rejects(fs.stat(index), { code: 'ENOENT' });
      else if (edition === 'standard') await assert.rejects(fs.stat(index), { code: 'ENOENT' });
      else {
        assert.equal(
          JSON.parse(
            (await fs.readFile(path.join(index, 'manifest.json'), 'utf8')).replace(/^\uFEFF/, '')
          ).variant,
          edition
        );
        await assert.rejects(fs.stat(path.join(index, 'old-index')), { code: 'ENOENT' });
      }
      assert.equal(
        await fs.readFile(path.join(profile, 'token'), 'utf8'),
        'untouched-token-and-roots'
      );
      assert.equal(
        (await fs.readdir(root)).filter((name) => name.startsWith('ACG-album-update-backup-'))
          .length,
        0
      );
    }
  );
}

test(
  'filesystem identities reject Windows short-name aliases even when string containment differs',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const long = 'C:\\Program Files';
    const short = 'C:\\PROGRA~1';
    try {
      await fs.stat(short);
    } catch {
      t.skip('8.3 aliases are disabled on this volume');
      return;
    }
    const a = await fs.stat(long, { bigint: true }),
      b = await fs.stat(short, { bigint: true });
    if (a.dev !== b.dev || a.ino !== b.ino) {
      t.skip('The expected system alias is unavailable');
      return;
    }
    await assert.rejects(assertExternalPaths(long, [short]), /重叠/);
    await assert.rejects(assertExternalPaths(path.join(long, 'Common Files'), [short]), /重叠/);
  }
);
