'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { run, runCli } = require('./mac-support.cjs');
const { buildRenameHelper } = require('./build-mac-full.cjs');

async function checkCaseBehavior(directory, sensitive) {
  const original = path.join(directory, 'AcgCaseProbe');
  const alternate = path.join(directory, 'acgcaseprobe');
  await fsp.writeFile(original, 'case probe', { flag: 'wx' });
  if (sensitive) await assert.rejects(fsp.readFile(alternate), { code: 'ENOENT' });
  else assert.equal(await fsp.readFile(alternate, 'utf8'), 'case probe');
  return { sensitive, checked: true };
}
async function main() {
  assert.equal(process.platform, 'darwin', 'Real macOS filesystem tests require a native runner');
  assert.equal(process.arch, process.env.ACG_MAC_EXPECT_ARCH);
  const root = path.resolve(__dirname, '..');
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const temporary = await fsp.mkdtemp(path.join(temporaryRoot, 'acg-mac-filesystems-'));
  const results = [];
  let activeMount = null;
  try {
    const helperResources = path.join(temporary, 'helper-resources');
    const helper = await buildRenameHelper(root, helperResources);
    const env = {
      ...process.env,
      ACG_MAC_RENAME_HELPER: path.join(helperResources, 'bin', 'acg-fs-rename')
    };
    delete env.ACG_MAC_TEST_ROOT;
    delete env.ELECTRON_RUN_AS_NODE;
    const tests = (await fsp.readdir(path.join(root, 'tests')))
      .filter((name) => /^mac-.*\.test\.cjs$/.test(name))
      .sort();
    const dataTests = tests.filter((name) => name.startsWith('mac-data'));
    assert.ok(dataTests.includes('mac-data-rename.test.cjs'), 'Real helper tests must be present');
    run(
      process.execPath,
      ['--test', '--test-concurrency=1', ...tests.map((name) => path.join(root, 'tests', name))],
      { env, stdio: 'inherit', timeout: 600_000 }
    );
    // APFSX is a diskutil-only alias; hdiutil needs the filesystem personality name.
    for (const [filesystem, personality, sensitive] of [
      ['APFS', 'APFS', false],
      ['APFSX', 'Case-sensitive APFS', true]
    ]) {
      const image = path.join(temporary, filesystem + '.sparseimage');
      const mount = path.join(temporary, filesystem + '-volume');
      await fsp.mkdir(mount);
      console.log(
        `Creating ${filesystem} test volume: hdiutil -size 512m -type SPARSE -fs ${JSON.stringify(personality)}`
      );
      run('hdiutil', [
        'create',
        '-size',
        '512m',
        '-type',
        'SPARSE',
        '-fs',
        personality,
        '-volname',
        'ACG-' + filesystem,
        '-o',
        image
      ]);
      let attached = false;
      try {
        activeMount = mount;
        run('hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, image]);
        attached = true;
        const caseBehavior = await checkCaseBehavior(mount, sensitive);
        const dataRoot = path.join(mount, 'tests');
        await fsp.mkdir(dataRoot);
        run(
          process.execPath,
          [
            '--test',
            '--test-concurrency=1',
            ...dataTests.map((name) => path.join(root, 'tests', name))
          ],
          { env: { ...env, ACG_MAC_TEST_ROOT: dataRoot }, stdio: 'inherit', timeout: 600_000 }
        );
        results.push({ filesystem, personality, caseBehavior, tests: dataTests, passed: true });
      } finally {
        if (attached) {
          run('hdiutil', ['detach', mount]);
          activeMount = null;
        }
      }
    }
    const evidence =
      process.env.ACG_MAC_FS_EVIDENCE ||
      path.join(temporaryRoot, 'acg-mac-filesystems-' + process.arch + '.json');
    const report = {
      ok: true,
      nativeArch: process.arch,
      helper,
      allMacTests: tests,
      volumes: results,
      createdAt: new Date().toISOString()
    };
    await fsp.writeFile(evidence, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    assert.equal(path.dirname(temporary), temporaryRoot);
    assert.ok(path.basename(temporary).startsWith('acg-mac-filesystems-'));
    // Never traverse a mount that could not be detached. Keep its owned evidence.
    if (activeMount)
      throw new Error('Temporary macOS test mount requires detach before cleanup: ' + activeMount);
    // Only this invocation's fresh, detached disk images and helper test payload.
    await fsp.rm(temporary, { recursive: true });
  }
}
if (require.main === module) runCli(main);
module.exports = { checkCaseBehavior, main };
