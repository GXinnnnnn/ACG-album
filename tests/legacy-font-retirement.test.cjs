'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  createLegacyFontRetirement,
  retireLegacyBundledFonts
} = require('../src/legacy-font-retirement.cjs');
const {
  LEGACY_BUNDLED_FONTS,
  OWNERSHIP_PATH,
  makeRuntimeOwnership,
  assertRuntimeOwnership
} = require('../src/runtime-update.cjs');

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');
const names = ['regular.ttf', 'medium.ttf', 'semibold.ttf', 'bold.ttf', 'heavy.ttf'];
const identities = names.map((name) => ({
  name,
  bytes: Buffer.byteLength('KNOWN ' + name),
  sha256: hash('KNOWN ' + name)
}));
const roots = ['fonts/founder-lanting-yuan', 'resources/fonts/founder-lanting-yuan'];
const rows = roots.flatMap((root) =>
  identities.map((font) => ({
    path: root + '/' + font.name,
    bytes: font.bytes,
    sha256: font.sha256
  }))
);
const modulePath = path.resolve(__dirname, '../src/legacy-font-retirement.cjs');
const retire = (options) => createLegacyFontRetirement({ identities, ...options });
async function put(directory, name, bytes) {
  const file = path.join(directory, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes);
}
async function absent(file) {
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
}
async function fixture(t, { owner = 'legacy', fonts = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-font-retirement-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'application');
  await put(directory, 'ACG-album.exe', 'EXECUTABLE');
  await put(directory, 'resources/app.asar', 'ASAR');
  await put(directory, 'resources/local-index/immutable.dat', 'PERSONAL INDEX');
  const profile = path.join(root, 'profile.json');
  const settings = JSON.stringify({ fontFamily: '方正兰亭圆_GBK', sentinel: 'PERSONAL DATA' });
  await fs.writeFile(profile, settings);
  if (fonts)
    for (const row of rows) await put(directory, row.path, 'KNOWN ' + path.basename(row.path));
  const baseOwner = makeRuntimeOwnership({
    version: '1.2.2',
    files: [
      { path: 'ACG-album.exe', bytes: 10, sha256: hash('EXECUTABLE') },
      { path: 'resources/app.asar', bytes: 4, sha256: hash('ASAR') }
    ]
  });
  const oldOwner =
    owner === 'legacy'
      ? { ...baseOwner, files: [...baseOwner.files, ...rows.map((row) => ({ ...row }))] }
      : baseOwner;
  const ownerText = JSON.stringify(oldOwner, null, 2) + '\n';
  if (owner !== 'none') await put(directory, OWNERSHIP_PATH, ownerText);
  const journalPath = path.join(
    root,
    'ACG-album-private-font-retirement-' +
      hash(process.platform === 'win32' ? directory.toLowerCase() : directory).slice(0, 24) +
      '.json'
  );
  return { root, directory, ownerText, oldOwner, baseOwner, profile, settings, journalPath };
}
async function originalFonts(directory) {
  for (const row of rows)
    assert.equal(
      await fs.readFile(path.join(directory, row.path), 'utf8'),
      'KNOWN ' + path.basename(row.path)
    );
}
async function preserved(f) {
  assert.equal(await fs.readFile(f.profile, 'utf8'), f.settings);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'resources/local-index/immutable.dat'), 'utf8'),
    'PERSONAL INDEX'
  );
}
async function backupDirectories(root) {
  return (await fs.readdir(root)).filter((name) =>
    name.startsWith('ACG-album-private-font-backup-')
  );
}

// The default startup export is permanently tied to the real application identities.
test('production export uses all five known provenance identities and leaves synthetic fonts untouched', async (t) => {
  assert.deepEqual(
    LEGACY_BUNDLED_FONTS.map((font) => font.name),
    names
  );
  for (const font of LEGACY_BUNDLED_FONTS) {
    assert.match(font.sha256, /^[a-f0-9]{64}$/);
    assert.ok(font.bytes > 11000000);
  }
  const f = await fixture(t);
  assert.equal((await retireLegacyBundledFonts(f.directory)).status, 'unchanged');
  await originalFonts(f.directory);
  assert.equal((await backupDirectories(f.root)).length, 0);
});

test('no known candidates is a cheap no-op without parsing invalid ownership or hashing runtime/index', async (t) => {
  const f = await fixture(t, { fonts: false });
  await put(f.directory, OWNERSHIP_PATH, '{INVALID OWNER');
  await put(f.directory, 'ACG-album.exe', 'CHANGED UNKNOWN RUNTIME');
  const result = await retire()(f.directory);
  assert.deepEqual(result, {
    status: 'unchanged',
    retired: [],
    ownershipRewritten: false,
    backupDirectory: null
  });
  assert.equal((await backupDirectories(f.root)).length, 0);
  await absent(f.journalPath);
  await preserved(f);
});

test('retires ten exact known copies externally and rewrites only fully proven historical ownership', async (t) => {
  const f = await fixture(t),
    operation = retire();
  await put(f.directory, 'resources/fonts/founder-lanting-yuan/custom.otf', 'USER FONT');
  const result = await operation(f.directory);
  assert.equal(result.status, 'retired');
  assert.equal(result.ownershipRewritten, true);
  assert.equal(result.retired.length, 10);
  assert.equal(path.dirname(result.backupDirectory), f.root);
  for (const row of rows) {
    await absent(path.join(f.directory, row.path));
    assert.equal(hash(await fs.readFile(path.join(result.backupDirectory, row.path))), row.sha256);
  }
  const metadata = JSON.parse(
    await fs.readFile(path.join(result.backupDirectory, 'migration.json'), 'utf8')
  );
  assert.equal(metadata.originalDirectory, f.directory);
  assert.equal(metadata.state, 'committed');
  assert.equal(
    await fs.readFile(path.join(result.backupDirectory, 'runtime-owned-files.before.json'), 'utf8'),
    f.ownerText
  );
  assert.deepEqual((await assertRuntimeOwnership(f.directory)).ownership, f.baseOwner);
  assert.equal(
    await fs.readFile(
      path.join(f.directory, 'resources/fonts/founder-lanting-yuan/custom.otf'),
      'utf8'
    ),
    'USER FONT'
  );
  assert.equal((await operation(f.directory)).status, 'unchanged');
  assert.equal((await backupDirectories(f.root)).length, 1);
  await absent(f.journalPath);
  await preserved(f);
});

for (const owner of ['none', 'normal']) {
  test(
    'retirement with ' + owner + ' ownership does not create or rewrite ownership',
    async (t) => {
      const f = await fixture(t, { owner });
      const result = await retire()(f.directory);
      assert.equal(result.status, 'retired');
      assert.equal(result.ownershipRewritten, false);
      if (owner === 'none') await absent(path.join(f.directory, OWNERSHIP_PATH));
      else
        assert.equal(
          await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'),
          f.ownerText
        );
      await preserved(f);
    }
  );
}

test('unknown same-name same-size SHA mismatch and relocated known bytes stay untouched', async (t) => {
  const f = await fixture(t, { owner: 'normal' });
  const unknownPath = rows[1].path,
    unknown = Buffer.alloc(rows[1].bytes, 120);
  await put(f.directory, unknownPath, unknown);
  await put(f.directory, 'resources/fonts/user-renamed.ttf', 'KNOWN regular.ttf');
  const result = await retire()(f.directory);
  assert.equal(result.retired.length, 9);
  assert.deepEqual(await fs.readFile(path.join(f.directory, unknownPath)), unknown);
  assert.equal(
    await fs.readFile(path.join(f.directory, 'resources/fonts/user-renamed.ttf'), 'utf8'),
    'KNOWN regular.ttf'
  );
  await preserved(f);
});

for (const change of [
  'invalid-json',
  'changed-runtime',
  'unknown-runtime',
  'bad-font-identity',
  'duplicate-font-row',
  'untrusted-font-row'
]) {
  test('preflight refuses ' + change + ' without moving any font or creating backup', async (t) => {
    const f = await fixture(t);
    if (change === 'invalid-json') await put(f.directory, OWNERSHIP_PATH, '{BAD');
    if (change === 'changed-runtime')
      await put(f.directory, 'ACG-album.exe', 'USER MODIFIED EXECUTABLE');
    if (change === 'unknown-runtime') await put(f.directory, 'unknown-user.txt', 'UNKNOWN');
    if (change === 'bad-font-identity') {
      f.oldOwner.files.at(-1).sha256 = hash('DIFFERENT');
      await put(f.directory, OWNERSHIP_PATH, JSON.stringify(f.oldOwner));
    }
    if (change === 'duplicate-font-row') {
      f.oldOwner.files.push({ ...rows[0] });
      await put(f.directory, OWNERSHIP_PATH, JSON.stringify(f.oldOwner));
    }
    if (change === 'untrusted-font-row') {
      f.oldOwner.files.push({ path: 'fonts/user.ttf', bytes: 4, sha256: hash('USER') });
      await put(f.directory, OWNERSHIP_PATH, JSON.stringify(f.oldOwner));
    }
    await assert.rejects(retire()(f.directory), { code: 'LEGACY_FONT_RETIREMENT' });
    await originalFonts(f.directory);
    assert.equal((await backupDirectories(f.root)).length, 0);
    await absent(f.journalPath);
    await preserved(f);
  });
}

test('junction font root is rejected without following it into unknown files', async (t) => {
  const f = await fixture(t, { fonts: false, owner: 'normal' });
  const outside = path.join(f.root, 'user-fonts');
  await put(outside, 'founder-lanting-yuan/regular.ttf', 'KNOWN regular.ttf');
  await fs.symlink(outside, path.join(f.directory, 'fonts'), 'junction');
  await assert.rejects(retire()(f.directory), { code: 'LEGACY_FONT_RETIREMENT' });
  assert.equal(
    await fs.readFile(path.join(outside, 'founder-lanting-yuan/regular.ttf'), 'utf8'),
    'KNOWN regular.ttf'
  );
  assert.equal((await backupDirectories(f.root)).length, 0);
});

for (const stop of ['font-moved', 'owner-rewritten']) {
  test(
    'ordinary failure at ' + stop + ' rolls back fonts and exact original owner bytes',
    async (t) => {
      const f = await fixture(t);
      await assert.rejects(
        retire({
          checkpoint: async (event) => {
            if (event === stop) throw new Error('INJECTED FAILURE');
          }
        })(f.directory),
        /INJECTED FAILURE/
      );
      await originalFonts(f.directory);
      assert.equal(await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'), f.ownerText);
      await absent(f.journalPath);
      await preserved(f);
    }
  );
}

test('recovery collision preserves unknown user file and trusted backup without partial rollback', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    retire({
      checkpoint: async (event, relative) => {
        if (event === 'font-moved') {
          await put(f.directory, relative, 'NEW UNKNOWN USER FONT');
          throw new Error('COLLISION');
        }
      }
    })(f.directory),
    /recovery remains pending/
  );
  const journal = JSON.parse(await fs.readFile(f.journalPath, 'utf8'));
  assert.equal(
    await fs.readFile(path.join(f.directory, rows[0].path), 'utf8'),
    'NEW UNKNOWN USER FONT'
  );
  assert.equal(
    hash(await fs.readFile(path.join(journal.backupDirectory, rows[0].path))),
    rows[0].sha256
  );
  await assert.rejects(retire()(f.directory), /unknown user file/);
  assert.equal(
    await fs.readFile(path.join(f.directory, rows[0].path), 'utf8'),
    'NEW UNKNOWN USER FONT'
  );
  assert.equal(await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'), f.ownerText);
});

test('runtime change after migration begins leaves recoverable evidence and never overwrites changed runtime', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    retire({
      checkpoint: async (event) => {
        if (event === 'fonts-moved') await put(f.directory, 'ACG-album.exe', 'UNKNOWN RUNTIME');
      }
    })(f.directory),
    /recovery remains pending/
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, 'ACG-album.exe'), 'utf8'),
    'UNKNOWN RUNTIME'
  );
  assert.equal(await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'), f.ownerText);
  assert.equal(JSON.parse(await fs.readFile(f.journalPath, 'utf8')).state, 'prepared');
  // The test restores only its own synthetic executable before recovery.
  await put(f.directory, 'ACG-album.exe', 'EXECUTABLE');
  const result = await retire()(f.directory);
  assert.equal(result.recovered, true);
  assert.equal(result.status, 'retired');
  await assertRuntimeOwnership(f.directory);
});

for (const stop of ['prepared', 'font-moved', 'fonts-moved', 'owner-rewritten', 'committed']) {
  test(
    'real process termination at ' + stop + ' is safely recovered on next invocation',
    async (t) => {
      const f = await fixture(t);
      const code = `const {createLegacyFontRetirement}=require(process.argv[1]);
const config=JSON.parse(process.argv[2]);
createLegacyFontRetirement({identities:config.identities,checkpoint:async event=>{if(event===config.stop)process.exit(73)}})(config.directory).then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(2)});`;
      const result = spawnSync(
        process.execPath,
        ['-e', code, modulePath, JSON.stringify({ identities, directory: f.directory, stop })],
        { encoding: 'utf8', timeout: 15000 }
      );
      assert.equal(result.status, 73, result.stdout + result.stderr);
      assert.ok(await fs.stat(f.journalPath));
      const recovered = await retire()(f.directory);
      assert.equal(recovered.status, stop === 'committed' ? 'recovered' : 'retired');
      await absent(f.journalPath);
      await assertRuntimeOwnership(f.directory);
      for (const row of rows) await absent(path.join(f.directory, row.path));
      await preserved(f);
    }
  );
}

for (const corrupt of [
  'outside-backup',
  'traversal-font',
  'untrusted-sha',
  'forged-owner',
  'linked-journal'
]) {
  test('recovery rejects ' + corrupt + ' journal without changing user files', async (t) => {
    const f = await fixture(t);
    const backupDirectory = path.join(
      f.root,
      'ACG-album-private-font-backup-' + crypto.randomUUID()
    );
    await fs.mkdir(backupDirectory);
    const journal = {
      schemaVersion: 1,
      kind: 'legacy-font-retirement',
      state: 'prepared',
      originalDirectory: f.directory,
      backupDirectory,
      retired: [rows[0]],
      ownerBefore: f.ownerText,
      ownerAfter: JSON.stringify(f.baseOwner) + '\n'
    };
    if (corrupt === 'outside-backup') journal.backupDirectory = path.join(f.root, '..', 'unknown');
    if (corrupt === 'traversal-font') journal.retired = [{ ...rows[0], path: '../unknown.ttf' }];
    if (corrupt === 'untrusted-sha') journal.retired = [{ ...rows[0], sha256: hash('UNKNOWN') }];
    if (corrupt === 'forged-owner') journal.ownerAfter = '{OTHER OWNER}';
    if (corrupt === 'linked-journal') await fs.symlink(backupDirectory, f.journalPath, 'junction');
    else await fs.writeFile(f.journalPath, JSON.stringify(journal));
    await assert.rejects(retire()(f.directory), { code: 'LEGACY_FONT_RETIREMENT' });
    await originalFonts(f.directory);
    assert.equal(await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'), f.ownerText);
    await preserved(f);
  });
}

test('concurrent in-process startup calls share one transaction', async (t) => {
  const f = await fixture(t),
    operation = retire();
  const [one, two] = await Promise.all([operation(f.directory), operation(f.directory)]);
  assert.equal(one.backupDirectory, two.backupDirectory);
  assert.equal((await backupDirectories(f.root)).length, 1);
  await assertRuntimeOwnership(f.directory);
});

test('changed ownership during rollback is preserved with recovery materials', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    retire({
      checkpoint: async (event) => {
        if (event === 'owner-rewritten') {
          await put(f.directory, OWNERSHIP_PATH, 'UNKNOWN USER OWNERSHIP');
          throw new Error('OWNER COLLISION');
        }
      }
    })(f.directory),
    /recovery remains pending/
  );
  assert.equal(
    await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'),
    'UNKNOWN USER OWNERSHIP'
  );
  const journal = JSON.parse(await fs.readFile(f.journalPath, 'utf8'));
  for (const row of rows)
    assert.equal(hash(await fs.readFile(path.join(journal.backupDirectory, row.path))), row.sha256);
  await assert.rejects(retire()(f.directory), /unknown changed file/);
  assert.equal(
    await fs.readFile(path.join(f.directory, OWNERSHIP_PATH), 'utf8'),
    'UNKNOWN USER OWNERSHIP'
  );
});

test('failure after durable commit never rolls fonts back and next invocation completes metadata', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    retire({
      checkpoint: async (event) => {
        if (event === 'committed') throw new Error('COMMITTED CLEANUP FAILURE');
      }
    })(f.directory),
    /COMMITTED CLEANUP FAILURE/
  );
  for (const row of rows) await absent(path.join(f.directory, row.path));
  await assertRuntimeOwnership(f.directory);
  const result = await retire()(f.directory);
  assert.equal(result.status, 'recovered');
  assert.equal(result.retired.length, rows.length);
  assert.equal(result.ownershipRewritten, true);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(result.backupDirectory, 'migration.json'), 'utf8'))
      .state,
    'committed'
  );
  await absent(f.journalPath);
});

test('crash without ownership recovers fonts without manufacturing an ownership file', async (t) => {
  const f = await fixture(t, { owner: 'none' });
  const code = `const {createLegacyFontRetirement}=require(process.argv[1]);const config=JSON.parse(process.argv[2]);createLegacyFontRetirement({identities:config.identities,checkpoint:async event=>{if(event==='font-moved')process.exit(73)}})(config.directory).catch(e=>{console.error(e);process.exit(2)});`;
  const result = spawnSync(
    process.execPath,
    ['-e', code, modulePath, JSON.stringify({ identities, directory: f.directory })],
    { encoding: 'utf8', timeout: 15000 }
  );
  assert.equal(result.status, 73, result.stdout + result.stderr);
  assert.equal((await retire()(f.directory)).status, 'retired');
  await absent(path.join(f.directory, OWNERSHIP_PATH));
  await absent(f.journalPath);
});

test('recovery refuses altered backup metadata without trusting a forged journal alone', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    retire({
      checkpoint: async (event, name) => {
        if (event === 'font-moved') {
          await put(f.directory, name, 'UNKNOWN SOURCE COLLISION');
          throw new Error('KEEP JOURNAL');
        }
      }
    })(f.directory),
    /recovery remains pending/
  );
  const journal = JSON.parse(await fs.readFile(f.journalPath, 'utf8'));
  await fs.writeFile(path.join(journal.backupDirectory, 'migration.json'), '{}');
  await assert.rejects(retire()(f.directory), /recovery journal/);
  assert.equal(
    await fs.readFile(path.join(f.directory, rows[0].path), 'utf8'),
    'UNKNOWN SOURCE COLLISION'
  );
  assert.equal(
    hash(await fs.readFile(path.join(journal.backupDirectory, rows[0].path))),
    rows[0].sha256
  );
});
