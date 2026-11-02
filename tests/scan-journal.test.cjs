'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { createScanJournal } = require('../src/scan-journal.cjs');

const snapshot = (time = 10) => ({ fsIdentity: 'v1:d:1:2:3', mtimeMs: time, ctimeMs: time });
const begin = (journal, id = 'one', extra = {}) =>
  journal.begin({
    id,
    root: 'root-' + id,
    path: path.resolve('source-' + id),
    started: 100,
    options: { onlineMatch: false, matchDepth: 2, offline: true, matchNewOnly: true },
    ...extra
  });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-scan-journal-'));
  let db;
  const open = () => {
    db = new DatabaseSync(path.join(dir, 'library.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    return createScanJournal(db);
  };
  t.after(async () => {
    db?.close();
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('acg-scan-journal-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    open,
    close: () => {
      db.close();
      db = null;
    },
    db: () => db
  };
}

test('scan job options, directory phases and completed work survive reopening without reset', async (t) => {
  const f = await fixture(t);
  let j = f.open();
  const job = begin(j, 'one', {
    options: {
      onlineMatch: true,
      subjectTypes: [4, 2],
      matchDepth: 3,
      offline: false,
      matchNewOnly: true,
      token: 'never-persist-this',
      arbitrary: 'discard'
    }
  });
  j.resume();
  j.discoverDirectory({ id: 'root', path: job.path, snapshot: snapshot() });
  j.discoverDirectory({
    id: 'child',
    parent: 'root',
    path: path.join(job.path, 'child'),
    depth: 1
  });
  j.completeDirectory('child', { snapshot: snapshot(20) });
  j.checkpointDirectory('root', { phase: 'children', afterChild: 'child' });
  j.checkpoint({ phase: 'scan', counters: { folders: 2, visited: 1, images: 130 } });
  j.pause({ reason: 'shutdown' });
  f.close();
  j = f.open();
  assert.equal(j.load(), null, 'startup enumerates saved jobs before selecting one');
  assert.equal(j.jobs().length, 1);
  j.setJob('one');
  const restored = j.resume();
  assert.equal(restored.started, 100);
  assert.deepEqual(restored.options, {
    onlineMatch: true,
    subjectTypes: [2, 4],
    matchDepth: 3,
    offline: false,
    matchNewOnly: true
  });
  assert.deepEqual(restored.counters, { folders: 2, images: 130, visited: 1 });
  assert.equal(j.directory('root').after_child, 'child');
  assert.equal(j.directory('child').phase, 'done');
  assert.equal(j.directoryUnchanged('child', snapshot(20)), true);
  assert.equal(j.directoryUnchanged('child', { mtimeMs: 20, ctimeMs: 20 }), false);
  j.discoverDirectory({
    id: 'child',
    parent: 'root',
    path: path.join(job.path, 'child'),
    depth: 1
  });
  assert.equal(j.directory('child').phase, 'done', 'rediscovery does not requeue completed work');
  assert.equal(JSON.stringify(j.jobs()).includes('never-persist-this'), false);
});

test('offline directory changes reopen only that directory and ancestor traversal, with a new prune stamp', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const j = createScanJournal(db),
      job = begin(j);
    for (const [id, parent] of [
      ['root', null],
      ['old', 'root'],
      ['sibling', 'root']
    ]) {
      j.discoverDirectory({ id, parent, path: path.join(job.path, id), snapshot: snapshot() });
      j.completeDirectory(id);
    }
    j.checkpointDirectory('root', { phase: 'children', afterChild: 'sibling' });
    assert.equal(j.directoryUnchanged('old', snapshot(11)), false);
    assert.throws(() => j.reopenDirectory('old', { snapshot: snapshot(11), stamp: 100 }), /newer/);
    j.reopenDirectory('old', { snapshot: snapshot(11), stamp: 101 });
    assert.equal(j.directory('old').phase, 'enumerate');
    assert.equal(j.directory('old').stamp, 101);
    assert.equal(j.load().started, 100, 'the original job timestamp stays stable');
    assert.equal(j.directory('root').phase, 'children');
    assert.equal(
      j.directory('root').after_child,
      '',
      'an earlier changed child cannot be skipped by an old cursor'
    );
    assert.equal(j.directory('sibling').phase, 'done');
    assert.equal(j.directoryUnchanged('sibling', snapshot()), true);
    assert.equal(Object.hasOwn(j.directory('old'), 'offset'), false);
  } finally {
    db.close();
  }
});

test('multiple jobs stay isolated and finish participates in the caller matching-handoff transaction', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const j = createScanJournal(db);
    begin(j, 'a');
    j.resume();
    j.discoverDirectory({ id: 'same', path: path.resolve('a') });
    begin(j, 'b');
    j.discoverDirectory({ id: 'same', path: path.resolve('b') });
    assert.throws(() => j.resume(), /Another scan job/);
    j.setJob('a');
    j.pause();
    j.setJob('b');
    j.resume();
    assert.equal(j.directory('same').path, path.resolve('b'));
    db.exec('CREATE TABLE handoff(id TEXT PRIMARY KEY); BEGIN');
    db.prepare('INSERT INTO handoff VALUES(?)').run('b');
    j.finish();
    db.exec('ROLLBACK');
    assert.equal(j.load().id, 'b', 'rollback restores the selected job too');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM handoff').get().n, 0);
    db.exec('BEGIN');
    db.prepare('INSERT INTO handoff VALUES(?)').run('b');
    j.finish();
    db.exec('COMMIT');
    assert.equal(j.load(), null);
    assert.deepEqual(
      j.jobs().map((job) => job.id),
      ['a']
    );
    j.setJob('a');
    j.cancel();
    assert.equal(j.jobs().length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scan_directories').get().n, 0);
    assert.throws(() => j.jobs({ limit: 129 }), /limit/);
  } finally {
    db.close();
  }
});

test(
  'an actual killed writer retains committed checkpoints but cannot publish an unfinished batch',
  { timeout: 20000 },
  async (t) => {
    let child;
    t.after(async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGKILL');
        await stopped;
      }
    });
    const f = await fixture(t),
      file = path.join(f.dir, 'library.sqlite');
    const script = `
      const { DatabaseSync } = require('node:sqlite');
      const { createScanJournal } = require(process.argv[2]);
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      const j = createScanJournal(db);
      j.begin({id:'kill',root:'root',path:'source',started:100}); j.resume();
      db.exec('BEGIN');
      j.discoverDirectory({id:'done',path:'source/done'}); j.completeDirectory('done');
      j.checkpoint({counters:{visited:1}}); db.exec('COMMIT');
      db.exec('BEGIN');
      j.discoverDirectory({id:'uncommitted',path:'source/uncommitted'});
      j.checkpoint({counters:{visited:2}});
      process.send({ready:true});
      setInterval(()=>{},1000);
    `;
    child = spawn(
      process.execPath,
      ['-e', script, file, path.resolve(__dirname, '../src/scan-journal.cjs')],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    );
    await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error('Checkpoint child exited early: ' + code)));
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const j = f.open();
    j.setJob('kill');
    assert.equal(j.load().counters.visited, 1);
    assert.equal(j.directory('done').phase, 'done');
    assert.equal(j.directory('uncommitted'), null);
    assert.equal(j.resume().state, 'running');
    assert.equal(f.db().prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  }
);
