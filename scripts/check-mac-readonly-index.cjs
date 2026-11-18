'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { run, runCli, digest } = require('./mac-support.cjs');
const { detachMacVolume } = require('./mac-volume-detach.cjs');

const root = path.resolve(__dirname, '..');
const resultPrefix = 'ACG_MAC_READONLY_RESULT=';
const resourceName = 'tiny resources #?% 雪';
const maximumFixtureBytes = 4 * 1024 * 1024;
const sqliteReadOnlyFailure = /unable to open database file|readonly|read.only/i;
const queries = [
  { query: '千恋＊万花', kind: 'subject', types: [4], id: 172612 },
  { query: 'AIR', kind: 'subject', types: [4], id: 232 },
  { query: '朝武芳乃', kind: 'character', subjectId: 172612, id: 39360 },
  { query: 'こぶいち', kind: 'person', subjectId: 172612, id: 5795 }
];

function errorRecord(error, depth = 0) {
  return {
    message: error.message,
    code: error.code,
    errcode: error.errcode,
    errstr: error.errstr,
    stack: error.stack,
    ...(depth < 3 && error.cause ? { cause: errorRecord(error.cause, depth + 1) } : {}),
    ...(depth < 3 && error instanceof AggregateError
      ? { errors: error.errors.map((item) => errorRecord(item, depth + 1)) }
      : {})
  };
}

function contains(directory, filename) {
  const relative = path.relative(directory, filename);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
}

async function childRuntime(expectedArch) {
  assert.equal(process.platform, 'darwin', 'A real macOS Electron runtime is required');
  assert.ok(['arm64', 'x64'].includes(expectedArch));
  assert.equal(process.arch, expectedArch, 'Electron must execute the native runner architecture');
  assert.equal(process.versions.electron, '40.10.6');
  assert.equal(process.versions.node, '24.15.0');
  assert.equal(
    await fsp.realpath(process.execPath),
    process.env.ACG_MAC_READONLY_ELECTRON,
    'The child must execute the validated Electron binary'
  );
  const { DatabaseSync } = require('node:sqlite');
  const memory = new DatabaseSync(':memory:');
  let sqliteVersion;
  try {
    sqliteVersion = memory.prepare('SELECT sqlite_version() AS version').get().version;
  } finally {
    memory.close();
  }
  return {
    platform: process.platform,
    nativeArch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    sqliteVersion,
    executable: await fsp.realpath(process.execPath)
  };
}

async function assertOwnedResources(resources) {
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const owned = process.env.ACG_MAC_READONLY_OWNED;
  assert.ok(owned && path.isAbsolute(owned));
  assert.equal(path.dirname(owned), temporaryRoot);
  assert.ok(path.basename(owned).startsWith('acg-mac-readonly-index-'));
  assert.ok(
    path.isAbsolute(resources) && contains(owned, resources),
    "Only this invocation's tiny fixture may be accessed"
  );
  assert.ok(
    contains(owned, await fsp.realpath(resources)),
    'Fixture resources escaped the owned temporary directory'
  );
}

async function snapshotFixture(resources) {
  await assertOwnedResources(resources);
  const filename = path.join(resources, 'local-index', 'subjects.sqlite');
  const stat = await fsp.lstat(filename);
  assert.ok(
    stat.isFile() && stat.size > 0 && stat.size <= maximumFixtureBytes,
    'Only the bounded tiny fixture database may be read'
  );
  const handle = await fsp.open(filename, 'r');
  let header;
  try {
    header = Buffer.alloc(20);
    assert.equal((await handle.read(header, 0, 20, 0)).bytesRead, 20);
  } finally {
    await handle.close();
  }
  assert.equal(header.subarray(0, 16).toString('binary'), 'SQLite format 3\0');
  assert.deepEqual(
    [header[18], header[19]],
    [2, 2],
    'The fixture must retain its closed WAL-mode file header'
  );
  const entries = [];
  async function visit(directory) {
    for (const name of (await fsp.readdir(directory)).sort()) {
      const file = path.join(directory, name);
      const relative = path.relative(resources, file).split(path.sep).join('/');
      const current = await fsp.lstat(file);
      assert.ok(!current.isSymbolicLink(), 'Tiny fixture must not contain links');
      if (current.isDirectory()) {
        entries.push({ path: relative, type: 'directory' });
        await visit(file);
      } else {
        assert.ok(
          current.isFile() && current.size <= maximumFixtureBytes,
          'Unexpected tiny fixture payload'
        );
        entries.push({
          path: relative,
          type: 'file',
          bytes: current.size,
          mtimeMs: current.mtimeMs,
          sha256: await digest(file)
        });
      }
    }
  }
  await visit(resources);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['local-index', 'local-index/manifest.json', 'local-index/subjects.sqlite'],
    'No WAL/SHM/journal sidecars or extra files may exist'
  );
  return {
    filename,
    bytes: stat.size,
    sha256: await digest(filename),
    mtimeMs: stat.mtimeMs,
    header: { writeVersion: header[18], readVersion: header[19] },
    entries,
    sidecarsAbsent: true
  };
}

async function createFixture(resources) {
  await assertOwnedResources(resources);
  const { DatabaseSync } = require('node:sqlite');
  const { normalize } = require('../src/model.cjs');
  const directory = path.join(resources, 'local-index');
  await fsp.mkdir(directory);
  const filename = path.join(directory, 'subjects.sqlite');
  assert.ok(!fs.existsSync(filename), 'Fixture database must be newly created');
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE subjects(id INTEGER PRIMARY KEY,type INTEGER,name TEXT,name_cn TEXT,nsfw INTEGER,date TEXT,summary TEXT,infobox TEXT,collection_json TEXT,aliases_json TEXT,raw_json TEXT);
      CREATE TABLE name_keys(subject_id INTEGER,type INTEGER,key TEXT,name TEXT,kind TEXT,PRIMARY KEY(subject_id,key)) WITHOUT ROWID;
      CREATE INDEX name_keys_type_key ON name_keys(type,key,subject_id);
      CREATE TABLE entities(kind TEXT,id INTEGER,name TEXT,name_cn TEXT,summary TEXT,infobox TEXT,aliases_json TEXT,raw_json TEXT,PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE TABLE entity_keys(kind TEXT,id INTEGER,key TEXT,name TEXT,PRIMARY KEY(kind,id,key)) WITHOUT ROWID;
      CREATE INDEX entity_keys_kind_key ON entity_keys(kind,key,id);
      CREATE TABLE links(source_kind TEXT,source_id INTEGER,target_kind TEXT,target_id INTEGER,relation_type TEXT,source TEXT);
      CREATE INDEX links_source ON links(source_kind,source_id,target_kind,target_id);
      CREATE INDEX links_target ON links(target_kind,target_id,source_kind,source_id);
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
      CREATE VIRTUAL TABLE names_fts USING fts5(key,subject_id UNINDEXED,type UNINDEXED,tokenize='trigram');
      CREATE VIRTUAL TABLE entity_names_fts USING fts5(key,kind UNINDEXED,id UNINDEXED,tokenize='trigram');`);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const subjects = [
      { id: 172612, name: '千恋＊万花', name_cn: '千恋万花' },
      { id: 232, name: 'AIR', name_cn: 'AIR' }
    ];
    const entities = [
      { kind: 'character', id: 39360, name: '朝武芳乃' },
      { kind: 'person', id: 5795, name: 'こぶいち' }
    ];
    for (const item of subjects) {
      db.prepare('INSERT INTO subjects VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        item.id,
        4,
        item.name,
        item.name_cn,
        0,
        '2016-07-29',
        '只读卷预验使用的本地完整简介，内容仅来自脚本内的小型测试数据。',
        '[]',
        '{}',
        '[]',
        '{}'
      );
      for (const key of new Set([item.name, item.name_cn].map(normalize))) {
        db.prepare('INSERT INTO name_keys VALUES(?,?,?,?,?)').run(
          item.id,
          4,
          key,
          item.name,
          'name'
        );
        db.prepare('INSERT INTO names_fts VALUES(?,?,?)').run(key, item.id, 4);
      }
    }
    for (const item of entities) {
      db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?)').run(
        item.kind,
        item.id,
        item.name,
        '',
        '只读卷实体简介',
        '[]',
        '[]',
        '{}'
      );
      const key = normalize(item.name);
      db.prepare('INSERT INTO entity_keys VALUES(?,?,?,?)').run(item.kind, item.id, key, item.name);
      db.prepare('INSERT INTO entity_names_fts VALUES(?,?,?)').run(key, item.kind, item.id);
      db.prepare('INSERT INTO links VALUES(?,?,?,?,?,?)').run(
        'subject',
        172612,
        item.kind,
        item.id,
        'test',
        'readonly-preflight'
      );
    }
    db.prepare('INSERT INTO metadata VALUES(?,?)').run(
      'source',
      JSON.stringify({
        mode: 'full',
        dataVersion: 'tiny-readonly-preflight',
        rawRecordsPreserved: true
      })
    );
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    assert.equal(checkpoint.busy, 0);
  } finally {
    db.close();
  }
  // Closing the last WAL connection removes sidecars while preserving header 2/2.
  await fsp.writeFile(
    path.join(directory, 'manifest.json'),
    JSON.stringify({
      readerSchemaVersion: 1,
      variant: 'full',
      bundled: true,
      database: 'subjects.sqlite',
      dataVersion: 'tiny-readonly-preflight'
    }) + '\n',
    { flag: 'wx' }
  );
  return {
    snapshot: await snapshotFixture(resources),
    schemaAndFtsCreated: true,
    subjects: [172612, 232],
    entities: [39360, 5795]
  };
}

async function probeFixture(resources) {
  const { DatabaseSync } = require('node:sqlite');
  const { createLocalIndex } = require('../src/local-index.cjs');
  const before = await snapshotFixture(resources);
  let baseline;
  let baselineError;
  try {
    baseline = new DatabaseSync(before.filename, { readOnly: true });
    // SQLite can defer its VFS failure until the first statement, not construction.
    baseline.prepare('SELECT id FROM subjects LIMIT 1').get();
  } catch (error) {
    baselineError = error;
  } finally {
    baseline?.close();
  }
  assert.ok(baselineError, 'The old bare readOnly path must reproduce the read-only WAL failure');
  assert.match(
    baselineError.message,
    sqliteReadOnlyFailure,
    'Negative control failed for an unrelated reason'
  );
  assert.equal(baselineError.code, 'ERR_SQLITE_ERROR');
  assert.ok(Number.isInteger(baselineError.errcode) && baselineError.errcode > 0);
  const primaryCode = baselineError.errcode & 0xff;
  assert.ok(
    [8, 14].includes(primaryCode),
    'Expected SQLITE_READONLY or SQLITE_CANTOPEN VFS primary code'
  );
  const negativeControl = {
    expectedFailure: true,
    executedSql: 'SELECT id FROM subjects LIMIT 1',
    primaryCode,
    error: errorRecord(baselineError)
  };

  const local = createLocalIndex({ resourcesPath: resources });
  const results = [];
  let bundledStatus;
  try {
    bundledStatus = local.status();
    assert.equal(bundledStatus.available, true, JSON.stringify(bundledStatus));
    assert.equal(bundledStatus.variant, 'full');
    assert.equal(
      bundledStatus.path,
      before.filename,
      'Status must expose the ordinary absolute path'
    );
    for (const { id, ...query } of queries) {
      const result = local.search(query);
      assert.equal(result.available, true, JSON.stringify(result));
      assert.equal(result.complete, true, JSON.stringify(result));
      const found = result.candidates.find((item) => item.id === id);
      assert.ok(found, JSON.stringify(result));
      if (id === 172612) assert.ok(found.summary.length > 20);
      results.push({ ...query, expectedId: id, foundId: found.id });
    }
  } finally {
    local.close();
  }

  const override = createLocalIndex({ resourcesPath: resources, localIndexPath: before.filename });
  let overrideStatus;
  try {
    overrideStatus = override.status();
    assert.equal(
      overrideStatus.available,
      false,
      'Explicit overrides must retain ordinary WAL locking semantics'
    );
    assert.equal(overrideStatus.path, before.filename);
    assert.match(overrideStatus.error, sqliteReadOnlyFailure);
    const result = override.search({ query: 'AIR', kind: 'subject', types: [4] });
    assert.equal(result.available, false);
    assert.equal(result.complete, false);
  } finally {
    override.close();
  }
  const after = await snapshotFixture(resources);
  assert.deepEqual(
    after,
    before,
    'All tiny database bytes, mtimes and directory entries must remain unchanged'
  );
  return {
    negativeControl,
    bundledStatus,
    queries: results,
    override: { ordinarySemanticsVerified: true, status: overrideStatus },
    before,
    after,
    databaseUnchanged: true,
    entriesUnchanged: true,
    sidecarsAbsent: true
  };
}

async function electronChild(mode, expectedArch, resources) {
  const runtime = await childRuntime(expectedArch);
  if (mode === 'identity') return { runtime };
  if (mode === 'fixture') return { runtime, fixture: await createFixture(resources) };
  assert.equal(mode, 'probe', 'Unknown Electron child action');
  return { runtime, probe: await probeFixture(resources) };
}

function invokeElectron(executable, expectedArch, mode, resources, owned) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ACG_MAC_READONLY_ELECTRON: executable,
    ACG_MAC_READONLY_OWNED: owned
  };
  for (const name of ['ACG_LOCAL_INDEX_PATH', 'ACG_DATA_DIR', 'ACG_USER_DATA_DIR', 'NODE_OPTIONS'])
    delete env[name];
  const args = [
    expectedArch === 'x64' ? '-x86_64' : '-arm64',
    executable,
    __filename,
    '--electron-child',
    mode,
    expectedArch,
    resources || ''
  ];
  const result = spawnSync('/usr/bin/arch', args, {
    env,
    encoding: 'utf8',
    timeout: 90_000,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.stderr) console.error(result.stderr.trim());
  if (result.error) throw result.error;
  assert.equal(result.signal, null, 'Actual Electron child must exit normally');
  assert.equal(
    result.status,
    0,
    'Actual Electron child failed: ' + (result.stderr || result.stdout)
  );
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(resultPrefix));
  assert.equal(lines.length, 1, 'Expected exactly one real Electron proof record');
  return JSON.parse(lines[0].slice(resultPrefix.length));
}

async function main(expectedArch = process.argv[2], reportArgument = process.argv[3]) {
  assert.equal(process.platform, 'darwin', 'Run the small read-only preflight on a native Mac');
  assert.equal(
    process.versions.node.split('.')[0],
    '24',
    'Node 24 must orchestrate the actual Electron process'
  );
  assert.equal(process.versions.electron, undefined, 'The orchestrator must be Node, not Electron');
  assert.ok(['x64', 'arm64'].includes(expectedArch), 'First argument must be x64 or arm64');
  assert.equal(process.arch, expectedArch);
  assert.ok(
    reportArgument,
    'Second argument must be a new reports/mac-readonly-index-ARCH.json path'
  );
  const reportPath = path.resolve(root, reportArgument);
  assert.ok(
    contains(path.join(root, 'reports'), reportPath) &&
      path.basename(reportPath).startsWith('mac-readonly-index-' + expectedArch),
    'Report must stay in the dedicated repository reports subtree'
  );
  assert.ok(!fs.existsSync(reportPath), 'Refusing to overwrite existing evidence');
  await fsp.mkdir(path.dirname(reportPath), { recursive: true });
  assert.equal(require('electron/package.json').version, '40.10.6');
  const configuredElectron = require('electron');
  assert.equal(typeof configuredElectron, 'string');
  const executable = await fsp.realpath(configuredElectron);
  assert.ok(
    (await fsp.lstat(executable)).isFile(),
    'Electron executable must be a canonical ordinary file'
  );
  await fsp.access(executable, fs.constants.X_OK);
  assert.notEqual(executable, await fsp.realpath(process.execPath));
  const slices = run('lipo', ['-archs', executable]).split(/\s+/).sort();
  assert.ok(
    slices.includes(expectedArch === 'x64' ? 'x86_64' : 'arm64'),
    'Electron Mach-O must contain the native architecture'
  );
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const owned = await fsp.mkdtemp(path.join(temporaryRoot, 'acg-mac-readonly-index-'));
  let activeMount = null;
  let mounted = false;
  let pendingError;
  const report = {
    ok: false,
    createdAt: new Date().toISOString(),
    expectedNativeArch: expectedArch,
    host: { platform: process.platform, arch: process.arch, node: process.versions.node },
    electronBinary: { configured: configuredElectron, canonical: executable, slices }
  };
  try {
    report.host.macOS = run('sw_vers', ['-productVersion']);
    const translated = run('sysctl', ['-in', 'sysctl.proc_translated']);
    assert.ok(
      translated === '' || translated === '0',
      'A Rosetta-translated Node process is not a native runner'
    );
    report.host.rosettaTranslated = false;
    report.host.procTranslatedSysctl = translated || 'not-present';
    report.electronBinary.sha256 = await digest(executable);
    console.log('Validate actual Electron runtime on native ' + expectedArch);
    report.runtime = invokeElectron(executable, expectedArch, 'identity', undefined, owned).runtime;
    const sourceRoot = path.join(owned, 'image-root');
    const resources = path.join(sourceRoot, resourceName);
    await fsp.mkdir(resources, { recursive: true });
    console.log('Create bounded closed-WAL schema/FTS fixture with actual Electron');
    report.fixture = invokeElectron(executable, expectedArch, 'fixture', resources, owned).fixture;
    const image = path.join(owned, 'readonly-fixture.dmg');
    run(
      'hdiutil',
      [
        'create',
        '-size',
        '512m',
        '-fs',
        'APFS',
        '-format',
        'UDRO',
        '-srcfolder',
        sourceRoot,
        '-volname',
        'ACGReadonlyIndex',
        '-o',
        image
      ],
      { timeout: 120_000 }
    );
    const mount = path.join(owned, 'readonly-volume');
    await fsp.mkdir(mount);
    activeMount = mount; // Even a partial attach failure must never allow recursive removal.
    run(
      'hdiutil',
      ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, image],
      { timeout: 60_000 }
    );
    mounted = true;
    const plist = run('diskutil', ['info', '-plist', mount], { timeout: 30_000 });
    const volume = JSON.parse(
      run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, timeout: 30_000 })
    );
    assert.equal(
      String(volume.FilesystemType).toLowerCase(),
      'apfs',
      'The real mounted fixture must use APFS'
    );
    assert.equal(volume.ReadOnlyVolume, true, 'The fixture volume must actually be read-only');
    assert.equal(
      await fsp.realpath(volume.MountPoint),
      await fsp.realpath(mount),
      "diskutil must describe this invocation's actual mount"
    );
    report.volume = {
      filesystem: volume.FilesystemType,
      readOnlyVolume: volume.ReadOnlyVolume,
      readOnlyMedia: volume.ReadOnlyMedia,
      mountPoint: volume.MountPoint,
      personality: volume.FileSystemPersonality,
      imageFormat: 'UDRO',
      requestedSize: '512m',
      attachReadonly: true
    };
    console.log(
      'Run bare-path negative control, production bundled queries and explicit override on read-only APFS'
    );
    report.probe = invokeElectron(
      executable,
      expectedArch,
      'probe',
      path.join(mount, resourceName),
      owned
    ).probe;
    assert.equal(
      report.probe.before.sha256,
      report.fixture.snapshot.sha256,
      'The image must contain exactly the fixture database bytes'
    );
    assert.equal(report.probe.before.bytes, report.fixture.snapshot.bytes);
    report.ok = true;
  } catch (error) {
    pendingError = error;
  } finally {
    if (mounted) {
      try {
        report.detach = await detachMacVolume(activeMount, { pendingError });
        activeMount = null;
      } catch (error) {
        pendingError = error; // Shared detach preserves the work failure as AggregateError cause.
      }
    }
    if (activeMount) {
      console.error(
        'Preserving owned temporary payload because its mount is not confirmed detached: ' +
          activeMount
      );
      report.preservedTemporaryDirectory = owned;
    } else {
      try {
        assert.equal(path.dirname(owned), temporaryRoot);
        assert.ok(path.basename(owned).startsWith('acg-mac-readonly-index-'));
        await fsp.rm(owned, { recursive: true });
        report.temporaryPayloadRemoved = true;
      } catch (error) {
        pendingError = pendingError
          ? new AggregateError(
              [pendingError, error],
              'Read-only preflight and cleanup both failed',
              { cause: pendingError }
            )
          : error;
      }
    }
  }
  report.ok = report.ok && !pendingError;
  if (pendingError) report.error = errorRecord(pendingError);
  try {
    await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  } catch (error) {
    if (pendingError)
      throw new AggregateError(
        [pendingError, error],
        'Read-only preflight and evidence writing both failed',
        { cause: pendingError }
      );
    throw error;
  }
  console.log(JSON.stringify(report, null, 2));
  if (pendingError) throw pendingError;
  return report;
}

if (require.main === module)
  runCli(async () => {
    if (process.argv[2] === '--electron-child') {
      const proof = await electronChild(process.argv[3], process.argv[4], process.argv[5]);
      console.log(resultPrefix + JSON.stringify(proof));
    } else await main();
  });
module.exports = { snapshotFixture, createFixture, probeFixture, main };
