'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  validateRenameName,
  windowsMoveNoReplace,
  createFsRename
} = require('../src/fs-rename.cjs');
const windows = { skip: process.platform !== 'win32' ? 'Windows no-overwrite backend' : false };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, options = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-fs-rename-'));
  const source = path.join(tmp, 'input'),
    journalDir = path.join(tmp, 'journal');
  await fs.mkdir(source);
  t.after(async () => {
    const resolved = path.resolve(tmp);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('acg-fs-rename-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { tmp, source, journalDir, service: createFsRename({ journalDir, ...options }) };
}
const notFound = (p) => assert.rejects(fs.lstat(p), { code: 'ENOENT' });

test('rename basename validation rejects reserved names, traversal, ADS and Windows normalization hazards', () => {
  for (const name of [
    '',
    ' ',
    '.',
    '..',
    '../outside',
    'a/b',
    'a\\b',
    'C:ads',
    'x\0y',
    'end.',
    'end ',
    'CON',
    'nul.txt',
    'COM1.jpg',
    'LPT³.x',
    'CONIN$',
    'CONOUT$.txt',
    'COM1 .txt',
    'x'.repeat(256)
  ])
    assert.throws(() => validateRenameName(name), { code: 'RENAME_NAME' }, name);
  for (const name of ['作品 2026', 'Riddle Joker.jpg', 'A&B;$() `safe`.png', 'normal.consequence'])
    assert.equal(validateRenameName(name), name);
});

test(
  'Windows file and directory renames preserve the original object and commit cleanup touches only the journal',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, '原图 & $().jpg');
    const bytes = Buffer.from('original byte-for-byte source');
    await fs.writeFile(from, bytes);
    await fs.utimes(from, 1700000000, 1700000001);
    const before = await fs.lstat(from, { bigint: true });
    const ticket = await f.service.prepare({ sourcePath: from, newName: '新名 `quoted`.jpg' });
    const receipt = await f.service.execute(ticket);
    const after = await fs.lstat(receipt.path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.birthtimeNs, before.birthtimeNs);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(digest(await fs.readFile(receipt.path)), digest(bytes));
    await notFound(from);
    assert.equal(
      (await fs.readdir(f.journalDir)).filter((name) => name.endsWith('.json')).length,
      1
    );
    await f.service.complete(receipt);
    assert.deepEqual(await fs.readdir(f.journalDir), []);
    const folder = path.join(f.source, 'Album');
    await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'child.jpg'), bytes);
    const dirBefore = await fs.lstat(folder, { bigint: true });
    const dirReceipt = await f.service.execute(
      await f.service.prepare({ sourcePath: folder, newName: 'New Album' })
    );
    assert.equal((await fs.lstat(dirReceipt.path, { bigint: true })).ino, dirBefore.ino);
    assert.deepEqual(await fs.readFile(path.join(dirReceipt.path, 'child.jpg')), bytes);
    await f.service.complete(dirReceipt);
  }
);

test(
  'native Windows Move never replaces an existing file or empty directory',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'from.jpg'),
      target = path.join(f.source, 'target.jpg');
    await fs.writeFile(from, 'source');
    await fs.writeFile(target, 'occupied');
    await assert.rejects(windowsMoveNoReplace(from, target, 'file'));
    assert.equal(await fs.readFile(from, 'utf8'), 'source');
    assert.equal(await fs.readFile(target, 'utf8'), 'occupied');
    const a = path.join(f.source, 'A'),
      b = path.join(f.source, 'B');
    await fs.mkdir(a);
    await fs.mkdir(b);
    await assert.rejects(windowsMoveNoReplace(a, b, 'directory'));
    assert.equal((await fs.lstat(a)).isDirectory(), true);
    assert.equal((await fs.lstat(b)).isDirectory(), true);
  }
);

test(
  'a destination appearing after prepare is retained and the original name is rolled back safely',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'old.jpg'),
      target = path.join(f.source, 'new.jpg');
    await fs.writeFile(from, 'original');
    const ticket = await f.service.prepare({ sourcePath: from, newName: 'new.jpg' });
    await fs.writeFile(target, 'late outsider');
    await assert.rejects(
      f.service.execute(ticket),
      (error) => error.code === 'EEXIST' && error.rolledBack === true
    );
    assert.equal(await fs.readFile(from, 'utf8'), 'original');
    assert.equal(await fs.readFile(target, 'utf8'), 'late outsider');
    assert.deepEqual(await fs.readdir(f.journalDir), []);
    await assert.rejects(f.service.prepare({ sourcePath: from, newName: 'new.jpg' }), {
      code: 'EEXIST'
    });
  }
);

test(
  'case-only rename uses a temporary name and exact no-op does not create a journal',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'Album');
    await fs.mkdir(from);
    await fs.writeFile(path.join(from, 'child.jpg'), 'unchanged');
    const before = await fs.lstat(from, { bigint: true });
    const noOp = await f.service.execute(
      await f.service.prepare({ sourcePath: from, newName: 'Album' })
    );
    assert.equal(noOp.renamed, false);
    await notFound(f.journalDir);
    const receipt = await f.service.execute(
      await f.service.prepare({ sourcePath: from, newName: 'ALBUM' })
    );
    assert.equal(receipt.caseOnly, true);
    assert.ok((await fs.readdir(f.source)).includes('ALBUM'));
    assert.equal((await fs.lstat(receipt.path, { bigint: true })).ino, before.ino);
    assert.equal(await fs.readFile(path.join(receipt.path, 'child.jpg'), 'utf8'), 'unchanged');
    await notFound(receipt.tempPath);
    await f.service.complete(receipt);
  }
);

test(
  'case-only second-move failure restores the original spelling without copying or deleting the object',
  windows,
  async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      moveNoReplace: async (...args) => {
        if (++calls === 2)
          throw Object.assign(new Error('injected sharing violation'), { code: 'EBUSY' });
        return windowsMoveNoReplace(...args);
      }
    });
    const from = path.join(f.source, 'Mixed.jpg');
    await fs.writeFile(from, 'original');
    const before = await fs.lstat(from, { bigint: true });
    const ticket = await f.service.prepare({ sourcePath: from, newName: 'MIXED.JPG' });
    await assert.rejects(
      f.service.execute(ticket),
      (error) => error.code === 'EBUSY' && error.rolledBack
    );
    assert.ok((await fs.readdir(f.source)).includes('Mixed.jpg'));
    assert.equal((await fs.lstat(from, { bigint: true })).ino, before.ino);
    assert.equal(await fs.readFile(from, 'utf8'), 'original');
    await notFound(ticket.tempPath);
    assert.deepEqual(await fs.readdir(f.journalDir), []);
  }
);

test(
  'startup recovery rolls uncommitted moves back and keeps moves with a durable DB receipt',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'old.jpg');
    await fs.writeFile(from, 'original');
    const first = await f.service.execute(
      await f.service.prepare({ sourcePath: from, newName: 'new.jpg' })
    );
    let restarted = createFsRename({ journalDir: f.journalDir });
    const rolledBack = await restarted.recover({ isCommitted: () => false });
    assert.equal(rolledBack[0].rolledBack, true);
    assert.equal(await fs.readFile(from, 'utf8'), 'original');
    await notFound(first.path);
    const second = await restarted.execute(
      await restarted.prepare({ sourcePath: from, newName: 'committed.jpg' })
    );
    restarted = createFsRename({ journalDir: f.journalDir });
    const committed = await restarted.recover({ isCommitted: (op) => op === second.opId });
    assert.equal(committed[0].committed, true);
    assert.equal(await fs.readFile(second.path, 'utf8'), 'original');
    await notFound(from);
    assert.deepEqual(await fs.readdir(f.journalDir), []);
  }
);

test(
  'failed rollback retains an actionable journal and never overwrites a newly occupied old name',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'old.jpg');
    await fs.writeFile(from, 'original');
    const receipt = await f.service.execute(
      await f.service.prepare({ sourcePath: from, newName: 'new.jpg' })
    );
    await fs.writeFile(from, 'outsider');
    const restarted = createFsRename({ journalDir: f.journalDir });
    const results = await restarted.recover({ isCommitted: () => false });
    assert.equal(results[0].recoveryRequired, true);
    assert.equal(results[0].actualPath, receipt.path);
    assert.equal(await fs.readFile(from, 'utf8'), 'outsider');
    assert.equal(await fs.readFile(receipt.path, 'utf8'), 'original');
    assert.equal((await fs.readdir(f.journalDir)).length, 1);
    await fs.unlink(from); // Only the outsider created by this isolated fixture.
    assert.equal((await restarted.recover({ isCommitted: () => false }))[0].rolledBack, true);
    assert.equal(await fs.readFile(from, 'utf8'), 'original');
  }
);

test(
  'a crash at the temporary case-only name is recoverable after both the second move and immediate rollback fail',
  windows,
  async (t) => {
    let calls = 0;
    const f = await fixture(t, {
      moveNoReplace: async (...args) => {
        if (++calls >= 2)
          throw Object.assign(new Error('injected locked destination'), { code: 'EBUSY' });
        return windowsMoveNoReplace(...args);
      }
    });
    const from = path.join(f.source, 'Mixed.jpg');
    await fs.writeFile(from, 'original');
    const ticket = await f.service.prepare({ sourcePath: from, newName: 'MIXED.JPG' });
    await assert.rejects(
      f.service.execute(ticket),
      (error) => error.recoveryRequired && error.actualPath === ticket.tempPath
    );
    assert.equal(await fs.readFile(ticket.tempPath, 'utf8'), 'original');
    const recovery = await createFsRename({ journalDir: f.journalDir }).recover({
      isCommitted: () => false
    });
    assert.equal(recovery[0].rolledBack, true);
    assert.ok((await fs.readdir(f.source)).includes('Mixed.jpg'));
  }
);

test(
  'source replacement and junction ancestors are rejected before a source move',
  windows,
  async (t) => {
    const f = await fixture(t),
      from = path.join(f.source, 'old.jpg');
    await fs.writeFile(from, 'original');
    const ticket = await f.service.prepare({ sourcePath: from, newName: 'new.jpg' });
    const hidden = path.join(f.source, 'held-original.jpg');
    await fs.rename(from, hidden);
    await fs.writeFile(from, 'replacement');
    await assert.rejects(f.service.execute(ticket), { code: 'RENAME_RECOVERY' });
    assert.equal(await fs.readFile(from, 'utf8'), 'replacement');
    assert.equal(await fs.readFile(hidden, 'utf8'), 'original');
    await notFound(ticket.path);
    const nestedJournal = createFsRename({ journalDir: path.join(f.source, 'nested-journal') });
    await assert.rejects(
      nestedJournal.prepare({ sourcePath: f.source, newName: 'renamed-input' }),
      { code: 'RENAME_JOURNAL' }
    );
    const alias = path.join(f.tmp, 'alias');
    await fs.symlink(f.source, alias, 'junction');
    const linkedJournal = createFsRename({ journalDir: path.join(alias, 'new-journal') });
    const linkedTicket = await linkedJournal.prepare({ sourcePath: from, newName: 'new.jpg' });
    await assert.rejects(linkedJournal.execute(linkedTicket), { code: 'RENAME_LINK' });
    await notFound(path.join(f.source, 'new-journal'));
    await assert.rejects(
      f.service.prepare({ sourcePath: path.join(alias, 'old.jpg'), newName: 'alias-new.jpg' }),
      { code: 'RENAME_LINK' }
    );
  }
);
