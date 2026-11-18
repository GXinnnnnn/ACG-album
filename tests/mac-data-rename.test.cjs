'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { validateRenameName, macosMoveNoReplace, createFsRename } = require('../src/fs-rename.cjs');
const identity = (p) => {
  const s = fs.lstatSync(p, { bigint: true });
  return `${s.isDirectory() ? 'd' : 'f'}:${s.dev}:${s.ino}:${s.birthtimeNs}`;
};
function fixture(t) {
  const parent = fs.realpathSync(process.env.ACG_MAC_TEST_ROOT || os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'acg-mac-rename-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input');
  fs.mkdirSync(input);
  return { root, input, journalDir: path.join(root, 'journal') };
}
function darwinModule() {
  const file = path.resolve(__dirname, '../src/fs-rename.cjs'),
    module = { exports: {} };
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['require', 'module', 'exports', 'process'])(
    require,
    module,
    module.exports,
    { ...process, platform: 'darwin' }
  );
  return module.exports;
}
test('Mac rename preserves legitimate POSIX names and bounds UTF-8 filename bytes', () => {
  for (const name of ['CON', 'photo ', 'photo.', '图\\片: A.jpg', '相册'])
    assert.equal(validateRenameName(name, 'darwin'), name);
  for (const name of ['', '.', '..', 'bad/name', 'bad\u0000name', 'bad\u007fname', '图'.repeat(86)])
    assert.throws(() => validateRenameName(name, 'darwin'));
  assert.equal(validateRenameName('图'.repeat(85), 'darwin'), '图'.repeat(85));
  for (const name of ['CON', 'photo ', 'photo.', '图\\片: A.jpg'])
    assert.throws(() => validateRenameName(name, 'win32'));
});
test('Mac helper uses fixed executable and argv, bounded execution, and no shell', async () => {
  let call;
  const helperPath = path.resolve('helper');
  const move = macosMoveNoReplace({
    helperPath,
    run(...args) {
      call = args;
      args[3](null, '{"ok":true}\n');
    }
  });
  const source = '/tmp/图\\片 $(touch nope).jpg',
    destination = '/tmp/CON ';
  await move(source, destination, 'file', { identity: 'f:1:2:3', parentIdentity: 'd:1:4:5' });
  assert.equal(call[0], helperPath);
  assert.deepEqual(call[1], [source, destination, 'file', 'f:1:2:3', 'd:1:4:5']);
  assert.deepEqual(call[2], { shell: false, timeout: 30000, maxBuffer: 32768, encoding: 'utf8' });
});
test('Mac helper distinguishes confirmed non-overwrite failure from uncertain result', async () => {
  const helperPath = path.resolve('helper'),
    evidence = { identity: 'f:1:2:3', parentIdentity: 'd:1:4:5' };
  for (const response of [
    { error: { code: 1 }, stdout: '{"ok":false,"errno":17,"code":"EEXIST"}', known: true },
    { error: { code: 1 }, stdout: 'invalid' },
    { error: { code: 'ETIMEDOUT', killed: true }, stdout: '{"ok":true}' },
    { error: null, stdout: '' },
    { error: { code: 1 }, stdout: '{"ok":false,"errno":17,"code":"arbitrary"}' }
  ]) {
    const move = macosMoveNoReplace({
      helperPath,
      run(_file, _args, _opts, done) {
        done(response.error, response.stdout);
      }
    });
    await assert.rejects(move('/tmp/a', '/tmp/b', 'file', evidence), (e) =>
      response.known
        ? e.code === 'EEXIST' && !e.renameOutcomeUnknown
        : e.recoveryRequired === true && e.renameOutcomeUnknown === true
    );
  }
  await assert.rejects(macosMoveNoReplace()('/tmp/a', '/tmp/b', 'file', evidence), {
    code: 'RENAME_PLATFORM'
  });
});
test('uncertain helper outcome preserves journal and waits for explicit recovery', async (t) => {
  const f = fixture(t),
    oldPath = path.join(f.input, 'old.jpg'),
    destination = path.join(f.input, 'new.jpg');
  fs.writeFileSync(oldPath, 'source');
  let calls = 0;
  const move = macosMoveNoReplace({
    helperPath: path.resolve('helper'),
    run(_file, args, _opts, done) {
      calls++;
      fs.renameSync(args[0], args[1]); // Controlled temporary fixture only.
      if (calls === 1) done({ code: 'ETIMEDOUT', killed: true }, '');
      else done(null, '{"ok":true}');
    }
  });
  const service = createFsRename({ journalDir: f.journalDir, moveNoReplace: move });
  const ticket = await service.prepare({ sourcePath: oldPath, newName: 'new.jpg' });
  await assert.rejects(
    service.execute(ticket),
    (e) => e.renameOutcomeUnknown && e.recoveryRequired
  );
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(destination), true);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.readdirSync(f.journalDir).filter((n) => n.endsWith('.json')).length, 1);
  await service.recover({ isCommitted: () => false });
  assert.equal(calls, 2);
  assert.equal(fs.readFileSync(oldPath, 'utf8'), 'source');
  assert.equal(fs.readdirSync(f.journalDir).filter((n) => n.endsWith('.json')).length, 0);
});
test('successful helper followed by missing or replaced target never triggers automatic rollback', async (t) => {
  const { createFsRename: darwinRename } = darwinModule();
  for (const replacement of [false, true]) {
    const f = fixture(t),
      oldPath = path.join(f.input, 'old.jpg');
    fs.writeFileSync(oldPath, 'source');
    let calls = 0;
    const service = darwinRename({
      journalDir: f.journalDir,
      moveNoReplace: async (source, destination) => {
        calls++;
        fs.renameSync(source, path.join(f.input, 'displaced.jpg'));
        if (replacement) fs.writeFileSync(destination, 'different object');
      }
    });
    const ticket = await service.prepare({ sourcePath: oldPath, newName: 'new.jpg' });
    await assert.rejects(
      service.execute(ticket),
      (e) => e.renameOutcomeUnknown && e.recoveryRequired
    );
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(path.join(f.input, 'displaced.jpg'), 'utf8'), 'source');
    assert.equal(fs.readdirSync(f.journalDir).filter((n) => n.endsWith('.json')).length, 1);
  }
});
const realHelper = process.platform === 'darwin' && process.env.ACG_MAC_RENAME_HELPER;
test(
  'real Mac helper renames files/directories, keeps object identity, and supports case-only spelling',
  { skip: !realHelper },
  async (t) => {
    const f = fixture(t),
      service = createFsRename({ journalDir: f.journalDir, helperPath: realHelper });
    for (const kind of ['file', 'directory']) {
      const oldPath = path.join(f.input, kind + 'a');
      if (kind === 'file') fs.writeFileSync(oldPath, 'source bytes');
      else {
        fs.mkdirSync(oldPath);
        fs.writeFileSync(path.join(oldPath, 'child.jpg'), 'child bytes');
      }
      const sourceId = identity(oldPath);
      const ticket = await service.prepare({ sourcePath: oldPath, newName: kind + 'A' });
      assert.equal(ticket.caseOnly, fs.existsSync(ticket.path));
      const receipt = await service.execute(ticket);
      assert.equal(identity(receipt.path), sourceId);
      assert.equal(fs.readdirSync(f.input).includes(kind + 'a'), false);
      assert.equal(fs.readdirSync(f.input).includes(kind + 'A'), true);
      assert.equal(
        fs.readFileSync(
          kind === 'file' ? receipt.path : path.join(receipt.path, 'child.jpg'),
          'utf8'
        ),
        kind === 'file' ? 'source bytes' : 'child bytes'
      );
      await service.complete(receipt);
    }
  }
);
test(
  'real Mac helper refuses file/empty-directory collisions, stale identity, and symlink parent',
  { skip: !realHelper },
  async (t) => {
    const f = fixture(t),
      move = macosMoveNoReplace({ helperPath: realHelper });
    for (const kind of ['file', 'directory']) {
      const source = path.join(f.input, kind + '-source'),
        destination = path.join(f.input, kind + '-destination');
      if (kind === 'file') {
        fs.writeFileSync(source, 'source');
        fs.writeFileSync(destination, 'existing');
      } else {
        fs.mkdirSync(source);
        fs.mkdirSync(destination);
      }
      const sourceId = identity(source),
        destinationId = identity(destination);
      await assert.rejects(
        move(source, destination, kind, { identity: sourceId, parentIdentity: identity(f.input) }),
        { code: 'EEXIST' }
      );
      assert.equal(identity(source), sourceId);
      assert.equal(identity(destination), destinationId);
      if (kind === 'file') assert.equal(fs.readFileSync(destination, 'utf8'), 'existing');
      const free = path.join(f.input, kind + '-free');
      await assert.rejects(
        move(source, free, kind, {
          identity: sourceId.replace(/:\d+$/u, ':0'),
          parentIdentity: identity(f.input)
        }),
        { code: 'ESTALE' }
      );
      assert.equal(fs.existsSync(free), false);
    }
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(f.input, alias, 'dir');
    await assert.rejects(
      move(path.join(alias, 'file-source'), path.join(alias, 'free'), 'file', {
        identity: identity(path.join(f.input, 'file-source')),
        parentIdentity: identity(f.input)
      })
    );
    assert.equal(fs.existsSync(path.join(f.input, 'free')), false);
  }
);
