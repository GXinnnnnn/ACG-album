'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  LEGACY_BUNDLED_FONTS,
  OWNERSHIP_PATH,
  MAX_RUNTIME_MANIFEST_BYTES,
  validateRuntimeOwnership,
  hashFile
} = require('./runtime-update.cjs');

const PREFIX = 'ACG-album-private-font-backup-';
const ROOTS = ['fonts/founder-lanting-yuan', 'resources/fonts/founder-lanting-yuan'];
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const samePath = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const fault = (message) => Object.assign(new Error(message), { code: 'LEGACY_FONT_RETIREMENT' });
async function statOrNull(file) {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function plainDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath(await fs.realpath(directory), directory)
  )
    throw fault('Font retirement requires an ordinary application directory: ' + directory);
}
async function plainFile(directory, relative) {
  const parts = relative.split('/');
  let current = directory;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const stat = await statOrNull(current);
    if (!stat) return null;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw fault('Linked or non-directory retirement path: ' + current);
  }
  const file = path.join(directory, relative),
    stat = await statOrNull(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink()))
    throw fault('Non-regular retirement file: ' + file);
  return stat;
}
async function matches(directory, row) {
  const stat = await plainFile(directory, row.path);
  return Boolean(
    stat &&
      stat.size === row.bytes &&
      (await hashFile(path.join(directory, row.path))) === row.sha256
  );
}
async function writeDurable(file, data, flags = 'wx') {
  const handle = await fs.open(file, flags);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function replaceDurable(file, data) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await writeDurable(temporary, data);
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

// Dependency injection is for temporary unit fixtures. Production startup must
// use retireLegacyBundledFonts(), whose trusted identities cannot be overridden.
function createLegacyFontRetirement({
  identities = LEGACY_BUNDLED_FONTS,
  checkpoint = async () => {}
} = {}) {
  const known = new Map(
    ROOTS.flatMap((root) =>
      identities.map((font) => [
        root + '/' + font.name,
        { path: root + '/' + font.name, bytes: font.bytes, sha256: font.sha256 }
      ])
    )
  );
  const running = new Map();
  function trusted(row) {
    const font = known.get(row?.path);
    return Boolean(
      font &&
        Object.keys(row).length === 3 &&
        font.bytes === row.bytes &&
        font.sha256 === row.sha256
    );
  }
  function ownerValues(text) {
    const original = JSON.parse(text);
    if (!Array.isArray(original?.files) || !original.files.length || original.files.length >= 1500)
      throw fault('Invalid runtime ownership during font retirement.');
    const removed = original.files.filter((row) => known.has(row.path));
    if (removed.some((row) => !trusted(row)))
      throw fault('Historical font ownership does not match its trusted identity.');
    const seen = new Set();
    for (const row of original.files) {
      if (typeof row.path !== 'string' || seen.has(row.path.toLowerCase()))
        throw fault('Duplicate or invalid ownership path.');
      seen.add(row.path.toLowerCase());
    }
    const sanitized = validateRuntimeOwnership({
      ...original,
      files: original.files.filter((row) => !known.has(row.path))
    });
    return {
      original,
      removed,
      sanitized,
      after: removed.length ? JSON.stringify(sanitized) + '\n' : null
    };
  }
  async function proveOtherOwnership(directory, owner) {
    for (const row of owner.sanitized.files) {
      if (!(await matches(directory, row)))
        throw fault('Owned runtime file changed before font retirement: ' + row.path);
    }
    const files = new Set(owner.sanitized.files.map((row) => row.path.toLowerCase()));
    files.add(OWNERSHIP_PATH);
    const directories = new Set();
    for (const name of files) {
      const parts = name.split('/');
      parts.pop();
      while (parts.length) {
        directories.add(parts.join('/'));
        parts.pop();
      }
    }
    async function visit(relative = '') {
      for (const entry of await fs.readdir(path.join(directory, relative), {
        withFileTypes: true
      })) {
        const name = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isSymbolicLink())
          throw fault('Linked runtime path during font retirement: ' + name);
        if (/^(?:fonts|resources\/(?:fonts|local-index))(?:\/|$)/i.test(name)) continue;
        if (entry.isDirectory()) {
          if (!directories.has(name.toLowerCase()))
            throw fault('Unknown runtime directory during font retirement: ' + name);
          await visit(name);
        } else if (!entry.isFile() || !files.has(name.toLowerCase()))
          throw fault('Unknown runtime file during font retirement: ' + name);
      }
    }
    await visit();
  }
  async function readOwner(directory, moves) {
    const stat = await plainFile(directory, OWNERSHIP_PATH);
    if (!stat) return { before: null, after: null };
    if (stat.size > MAX_RUNTIME_MANIFEST_BYTES) throw fault('Runtime ownership is too large.');
    const before = await fs.readFile(path.join(directory, OWNERSHIP_PATH), 'utf8');
    const owner = ownerValues(before);
    if (owner.removed.some((row) => !moves.some((move) => move.path === row.path)))
      throw fault('Owned historical font is absent or differs from its trusted bytes.');
    if (owner.removed.length) await proveOtherOwnership(directory, owner);
    return { before, after: owner.after };
  }
  async function ownerUnchanged(directory, expected) {
    const stat = await plainFile(directory, OWNERSHIP_PATH);
    if (expected === null) {
      if (stat) throw fault('Runtime ownership appeared during font retirement.');
    } else if (
      !stat ||
      stat.size > MAX_RUNTIME_MANIFEST_BYTES ||
      digest(await fs.readFile(path.join(directory, OWNERSHIP_PATH))) !== digest(expected)
    ) {
      throw fault('Runtime ownership changed during font retirement.');
    }
  }
  function validateJournal(value, directory, parent) {
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.kind !== 'legacy-font-retirement' ||
      value.originalDirectory !== directory ||
      !['prepared', 'committed'].includes(value.state) ||
      !Array.isArray(value.retired) ||
      !value.retired.length ||
      value.retired.some((row) => !trusted(row)) ||
      new Set(value.retired.map((row) => row.path)).size !== value.retired.length ||
      typeof value.backupDirectory !== 'string' ||
      path.dirname(value.backupDirectory) !== parent ||
      !new RegExp('^' + PREFIX + '[a-f0-9-]{36}$').test(path.basename(value.backupDirectory)) ||
      (value.ownerBefore !== null &&
        (typeof value.ownerBefore !== 'string' ||
          Buffer.byteLength(value.ownerBefore) > MAX_RUNTIME_MANIFEST_BYTES))
    )
      throw fault('Unrecognized font-retirement recovery journal; no files were changed.');
    const expectedAfter = value.ownerBefore === null ? null : ownerValues(value.ownerBefore).after;
    if (value.ownerAfter !== expectedAfter)
      throw fault('Font-retirement ownership recovery data differs.');
    return value;
  }
  async function verifyBackup(journal, directory, parent) {
    await plainDirectory(journal.backupDirectory);
    const stat = await plainFile(journal.backupDirectory, 'migration.json');
    if (!stat || stat.size > 1024 * 1024)
      throw fault('Font-retirement backup metadata is missing or too large.');
    const metadata = validateJournal(
      JSON.parse(await fs.readFile(path.join(journal.backupDirectory, 'migration.json'), 'utf8')),
      directory,
      parent
    );
    if (JSON.stringify({ ...metadata, state: journal.state }) !== JSON.stringify(journal))
      throw fault('Font-retirement journal and backup metadata differ.');
  }
  async function rollback(directory, journal) {
    const current = await plainFile(directory, OWNERSHIP_PATH);
    if (current && current.size > MAX_RUNTIME_MANIFEST_BYTES)
      throw fault('Changed runtime ownership is too large to recover safely.');
    const text = current ? await fs.readFile(path.join(directory, OWNERSHIP_PATH), 'utf8') : null;
    if (
      text !== journal.ownerBefore &&
      (journal.ownerAfter === null || text !== journal.ownerAfter)
    )
      throw fault('Cannot restore ownership over an unknown changed file.');
    // Check every recovery path before moving any file or replacing ownership.
    const restore = [];
    for (const row of journal.retired) {
      const source = await plainFile(directory, row.path),
        backup = await plainFile(journal.backupDirectory, row.path);
      if (source && !(await matches(directory, row)))
        throw fault('Cannot restore a historical font over an unknown user file: ' + row.path);
      if (backup && !(await matches(journal.backupDirectory, row)))
        throw fault('Historical font recovery bytes changed: ' + row.path);
      if (!source && !backup) throw fault('Historical font recovery file is missing: ' + row.path);
      if (!source && backup) restore.push(row);
    }
    if (journal.ownerBefore !== null && journal.ownerAfter !== null)
      await proveOtherOwnership(directory, ownerValues(journal.ownerBefore));
    for (const row of restore) {
      const target = path.join(directory, row.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(path.join(journal.backupDirectory, row.path), target);
    }
    if (journal.ownerBefore !== null && text !== journal.ownerBefore)
      await replaceDurable(path.join(directory, OWNERSHIP_PATH), journal.ownerBefore);
  }
  async function execute(directoryInput) {
    const directory = path.resolve(directoryInput),
      parent = path.dirname(directory);
    if (directory === parent) throw fault('Cannot retire fonts at a filesystem root.');
    await plainDirectory(parent);
    await plainDirectory(directory);
    const journalPath = path.join(
      parent,
      'ACG-album-private-font-retirement-' +
        digest(process.platform === 'win32' ? directory.toLowerCase() : directory).slice(0, 24) +
        '.json'
    );
    let recovered = false,
      recoveredCommit = null;
    const prior = await statOrNull(journalPath);
    if (prior) {
      if (!prior.isFile() || prior.isSymbolicLink() || prior.size > 1024 * 1024)
        throw fault('Unsafe font-retirement journal.');
      const journal = validateJournal(
        JSON.parse(await fs.readFile(journalPath, 'utf8')),
        directory,
        parent
      );
      await verifyBackup(journal, directory, parent);
      if (journal.state === 'prepared') await rollback(directory, journal);
      else {
        for (const row of journal.retired)
          if (!(await matches(journal.backupDirectory, row)))
            throw fault('Committed private font backup changed: ' + row.path);
        await replaceDurable(
          path.join(journal.backupDirectory, 'migration.json'),
          JSON.stringify(journal, null, 2) + '\n'
        );
        recoveredCommit = journal;
      }
      await fs.unlink(journalPath);
      recovered = true;
    }
    const moves = [];
    for (const row of known.values()) if (await matches(directory, row)) moves.push(row);
    if (!moves.length)
      return {
        status: recovered ? 'recovered' : 'unchanged',
        retired: recoveredCommit ? recoveredCommit.retired.map((row) => row.path) : [],
        ownershipRewritten: Boolean(recoveredCommit?.ownerAfter),
        backupDirectory: recoveredCommit?.backupDirectory || null
      };
    const owner = await readOwner(directory, moves);
    const backupDirectory = path.join(parent, PREFIX + crypto.randomUUID());
    const journal = {
      schemaVersion: 1,
      kind: 'legacy-font-retirement',
      state: 'prepared',
      originalDirectory: directory,
      backupDirectory,
      retired: moves,
      ownerBefore: owner.before,
      ownerAfter: owner.after
    };
    await fs.mkdir(backupDirectory);
    await writeDurable(
      path.join(backupDirectory, 'migration.json'),
      JSON.stringify(journal, null, 2) + '\n'
    );
    if (owner.before !== null)
      await writeDurable(
        path.join(backupDirectory, 'runtime-owned-files.before.json'),
        owner.before
      );
    await writeDurable(journalPath, JSON.stringify(journal));
    let committed = false;
    try {
      await checkpoint('prepared');
      for (const row of moves) {
        if (!(await matches(directory, row)))
          throw fault('Historical font changed during retirement: ' + row.path);
        const destination = path.join(backupDirectory, row.path);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.rename(path.join(directory, row.path), destination);
        if (!(await matches(backupDirectory, row)))
          throw fault('Historical font backup verification failed: ' + row.path);
        await checkpoint('font-moved', row.path);
      }
      await checkpoint('fonts-moved');
      await ownerUnchanged(directory, owner.before);
      if (owner.after !== null) {
        await proveOtherOwnership(directory, ownerValues(owner.before));
        await ownerUnchanged(directory, owner.before);
        await replaceDurable(path.join(directory, OWNERSHIP_PATH), owner.after);
        await checkpoint('owner-rewritten');
      }
      journal.state = 'committed';
      await replaceDurable(journalPath, JSON.stringify(journal));
      committed = true;
      await checkpoint('committed');
      await verifyBackup(journal, directory, parent);
      await replaceDurable(
        path.join(backupDirectory, 'migration.json'),
        JSON.stringify(journal, null, 2) + '\n'
      );
      await fs.unlink(journalPath);
      return {
        status: 'retired',
        retired: moves.map((row) => row.path),
        ownershipRewritten: owner.after !== null,
        backupDirectory,
        recovered
      };
    } catch (error) {
      if (!committed) {
        try {
          await rollback(directory, journal);
          await fs.unlink(journalPath);
        } catch (recoveryError) {
          throw fault(
            error.message +
              '; recovery remains pending: ' +
              recoveryError.message +
              '; journal: ' +
              journalPath
          );
        }
      }
      throw error;
    }
  }
  return function retire(directory) {
    const key = path.resolve(directory);
    if (!running.has(key)) {
      const operation = execute(key)
        .catch((error) => {
          if (!error.code || error.code !== 'LEGACY_FONT_RETIREMENT')
            error.code = 'LEGACY_FONT_RETIREMENT';
          throw error;
        })
        .finally(() => running.delete(key));
      running.set(key, operation);
    }
    return running.get(key);
  };
}
const retireLegacyBundledFonts = createLegacyFontRetirement();
module.exports = { retireLegacyBundledFonts, createLegacyFontRetirement };
