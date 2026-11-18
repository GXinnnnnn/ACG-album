'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { _electron } = require('@playwright/test');
const { exerciseGuiLibrary } = require('./mac-gui-library.cjs');
const { runCli, digest, run } = require('./mac-support.cjs');
const ROOT = path.resolve(__dirname, '..');

async function copySource(stage) {
  const entries = [];
  let bytes = 0;
  async function copy(source, destination, relative) {
    const stat = await fsp.lstat(source);
    assert.equal(stat.isSymbolicLink(), false, 'Source staging never follows links: ' + source);
    if (stat.isDirectory()) {
      await fsp.mkdir(destination);
      for (const name of (await fsp.readdir(source)).sort())
        await copy(path.join(source, name), path.join(destination, name), relative + '/' + name);
    } else {
      assert.ok(stat.isFile());
      bytes += stat.size;
      assert.ok(bytes <= 256 * 1024 * 1024 && entries.length < 2048, 'Bounded source-only stage');
      await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      const sha256 = await digest(source);
      assert.equal(await digest(destination), sha256, 'Staged source must retain exact bytes');
      entries.push({ path: relative, bytes: stat.size, sha256 });
    }
  }
  await copy(path.join(ROOT, 'src'), path.join(stage, 'src'), 'src');
  await copy(path.join(ROOT, 'package.json'), path.join(stage, 'package.json'), 'package.json');
  // Only dependencies are linked. No library, user data, Full DB or artifact tree is copied.
  const dependencies = await fsp.realpath(path.join(ROOT, 'node_modules'));
  await fsp.symlink(
    dependencies,
    path.join(stage, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return {
    files: entries.length,
    bytes,
    sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    dependencyTarget: dependencies
  };
}

async function main(
  expectedArch = process.argv[2],
  reportArgument = process.argv[3],
  mode = process.argv[4]
) {
  assert.ok(['x64', 'arm64'].includes(expectedArch));
  assert.equal(process.arch, expectedArch);
  const nativeMac = mode !== '--windows-local';
  assert.equal(process.platform, nativeMac ? 'darwin' : 'win32');
  assert.equal(mode === undefined || mode === '--windows-local', true);
  const reportPath = path.resolve(
    reportArgument || path.join(ROOT, 'reports', 'mac-gui-preflight-' + expectedArch + '.json')
  );
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  assert.equal(fs.existsSync(reportPath), false, 'Preserve any previous report');
  const owned = await fsp.realpath(
    await fsp.mkdtemp(path.join(os.tmpdir(), 'acg-mac-gui-preflight-'))
  );
  const stage = path.join(owned, 'app');
  const profile = path.join(owned, 'profile');
  await fsp.mkdir(stage);
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: ROOT });
  const report = {
    kind: 'mac-development-gui-preflight',
    ok: false,
    createdAt: new Date().toISOString(),
    sourceCommit: commit,
    expectedNativeArch: expectedArch,
    developmentOnly: true,
    nativeMacAcceptance: nativeMac,
    fullPackagedAcceptance: false,
    host: { platform: process.platform, arch: process.arch, node: process.versions.node },
    isolation: { owned, stage, profile, personalDataUsed: false, fullDatabaseCopied: false },
    dialogSelection: 'controlled fixture result; real preload, IPC, worker, filesystem and database'
  };
  let app, exitPromise, pendingError;
  const errors = [];
  try {
    if (nativeMac) {
      report.host.macOS = run('sw_vers', ['-productVersion']);
      const translated = run('sysctl', ['-in', 'sysctl.proc_translated']);
      assert.ok(translated === '' || translated === '0');
      report.host.rosettaTranslated = false;
      report.host.procTranslatedSysctl = translated || 'not-present';
    }
    report.source = await copySource(stage);
    if (nativeMac) {
      const helper = path.join(stage, 'resources', 'bin', 'acg-fs-rename');
      await fsp.mkdir(path.dirname(helper), { recursive: true });
      const source = path.join(stage, 'src', 'native', 'macos-rename.c');
      run('xcrun', [
        'clang',
        '-std=c11',
        '-D_DARWIN_C_SOURCE',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-arch',
        'arm64',
        '-arch',
        'x86_64',
        '-mmacosx-version-min=12.0',
        source,
        '-o',
        helper
      ]);
      const architectures = run('lipo', ['-archs', helper]).split(/\s+/).sort();
      assert.deepEqual(architectures, ['arm64', 'x86_64']);
      run('codesign', ['--force', '--sign', '-', '--timestamp=none', helper]);
      run('codesign', ['--verify', '--strict', helper]);
      report.helper = {
        sourceSha256: await digest(source),
        sha256: await digest(helper),
        architectures,
        strictVerified: true
      };
    }
    const importRoot = path.join(owned, 'import-media');
    const originalAlbum = path.join(importRoot, 'Original Album');
    await fsp.mkdir(originalAlbum, { recursive: true });
    const originalImage = path.join(originalAlbum, 'photo.png');
    await require('sharp')({
      create: { width: 32, height: 24, channels: 4, background: '#345678' }
    })
      .png()
      .toFile(originalImage);
    const imageSha256 = await digest(originalImage);
    const env = {
      ...process.env,
      ACG_TEST: '1',
      ACG_DATA_DIR: profile,
      ACG_USER_DATA_DIR: path.join(profile, 'chromium-profile')
    };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'ACG_LOCAL_INDEX_PATH', 'NODE_OPTIONS'])
      delete env[key];
    const executable = await fsp.realpath(require('electron'));
    report.electronBinary = { path: executable, sha256: await digest(executable) };
    app = await _electron.launch({
      executablePath: executable,
      args: [stage, '--host-resolver-rules=MAP * ~NOTFOUND'],
      env,
      timeout: 90000
    });
    exitPromise = once(app.process(), 'exit');
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*'] },
        (_details, done) => done({ cancel: true })
      );
    });
    const page = await app.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    await app.context().setOffline(true);
    await page.waitForSelector('#local-search-button', { timeout: 90000 });
    report.runtime = await app.evaluate(({ app }) => ({
      version: app.getVersion(),
      packaged: app.isPackaged,
      arch: process.arch,
      platform: process.platform,
      electron: process.versions.electron,
      node: process.versions.node,
      appPath: app.getAppPath(),
      userData: app.getPath('userData')
    }));
    assert.equal(report.runtime.electron, '40.10.6');
    assert.match(report.runtime.node, /^24\.15\./);
    assert.equal(report.runtime.version, '1.2.3');
    assert.equal(report.runtime.packaged, false);
    assert.equal(report.runtime.arch, expectedArch);
    assert.equal(report.runtime.platform, process.platform);
    assert.equal(await fsp.realpath(report.runtime.appPath), await fsp.realpath(stage));
    assert.equal(
      await fsp.realpath(report.runtime.userData),
      await fsp.realpath(path.join(profile, 'chromium-profile'))
    );
    await page.waitForSelector('#modal[open] #settings-panel-metadata:not([hidden])', {
      timeout: 60000
    });
    await page.click('#modal-close');
    report.library = await exerciseGuiLibrary(app, page, { importRoot, originalAlbum });
    assert.equal(report.library.scan.errors, 0);
    assert.equal(report.library.after.name, 'Renamed Album');
    assert.equal(report.library.after.favorite, 1);
    assert.notEqual(report.library.after.id, report.library.before.id);
    assert.equal(await digest(path.join(report.library.after.path, 'photo.png')), imageSha256);
    await assert.rejects(fsp.lstat(originalAlbum), { code: 'ENOENT' });
    assert.ok(
      report.library.favorites.items.some(
        (item) => item.id === report.library.after.id && item.favorite === 1
      )
    );
    assert.deepEqual(errors, []);
    report.fixture = {
      width: 32,
      height: 24,
      sha256: imageSha256,
      originalAbsent: true,
      renamedBytesUnchanged: true
    };
    await page.screenshot({ path: reportPath + '.png' });
    report.offlineRenderer = true;
    report.blockedHttpSession = true;
    report.rendererErrors = errors;
  } catch (error) {
    pendingError = error;
  } finally {
    if (app) {
      try {
        const [exitCode, signal] = await (async () => {
          await app.close();
          return exitPromise;
        })();
        report.ownedProcessExit = { exitCode, signal };
        assert.equal(exitCode, 0, 'Owned development GUI must quit normally');
        assert.equal(signal, null, 'Terminated GUI is not accepted');
      } catch (error) {
        pendingError = pendingError
          ? new AggregateError([pendingError, error], 'GUI failure and cleanup failure', {
              cause: pendingError
            })
          : error;
      }
    }
    report.ok = !pendingError;
    report.finishedAt = new Date().toISOString();
    if (pendingError) report.error = pendingError.stack || String(pendingError);
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  if (pendingError) throw pendingError;
  console.log(
    JSON.stringify({
      kind: report.kind,
      ok: report.ok,
      arch: expectedArch,
      nativeMacAcceptance: nativeMac,
      developmentOnly: true,
      reportPath
    })
  );
  return report;
}
if (require.main === module) runCli(main);
module.exports = { copySource, main };
