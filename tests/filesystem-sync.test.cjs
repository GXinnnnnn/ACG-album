'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWatchQueue, watchTarget } = require('../src/filesystem-sync.cjs');
const ROOT = 'C:\\Pictures';
const child = (name) => `${ROOT}\\${name}`;
function fixture(options = {}) {
  let time = 0;
  const queue = createWatchQueue({ ...options, now: () => time });
  return {
    queue,
    at(value) {
      time = value;
    }
  };
}

test('watch queue exposes a quiet-period deadline and takes immutable due snapshots only', () => {
  const { queue, at } = fixture();
  assert.equal(queue.size, 0);
  assert.equal(queue.nextDelay(), null);
  assert.equal(queue.take(), null);
  assert.equal(queue.add('r', ROOT, child('Album')), true);
  assert.equal(queue.size, 1);
  assert.equal(queue.nextDelay(), 350);
  at(349);
  assert.equal(queue.nextDelay(), 1);
  assert.equal(queue.take(), null);
  at(350);
  const entry = queue.take();
  assert.deepEqual(entry, {
    rootId: 'r',
    rootPath: ROOT,
    targets: [child('Album')],
    firstDirty: 0,
    lastDirty: 0,
    attempts: 0,
    notBefore: 0
  });
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(entry.targets), true);
  assert.equal(queue.size, 0);
  assert.equal(queue.nextDelay(), null);
});

test('continuous notifications cannot postpone a root beyond the first maxWait', () => {
  const { queue, at } = fixture();
  queue.add('r', ROOT, child('Album'));
  for (let time = 100; time <= 1400; time += 100) {
    at(time);
    queue.add('r', ROOT, child(`Album${time}`));
    assert.equal(queue.take(), null);
  }
  at(1499);
  queue.add('r', ROOT, child('Latest'));
  assert.equal(queue.nextDelay(), 1);
  at(1500);
  const entry = queue.take();
  assert.equal(entry.firstDirty, 0);
  assert.equal(entry.lastDirty, 1499);
  assert.ok(entry.targets.includes(child('Latest')));
});

test('ancestor targets subsume descendants without confusing pathname prefixes', () => {
  const { queue, at } = fixture();
  queue.add('r', ROOT, child('Album\\Deep'));
  queue.add('r', ROOT, child('Album2'));
  queue.add('r', ROOT, child('Album'));
  queue.add('r', ROOT, child('Album\\Other'));
  at(350);
  assert.deepEqual([...queue.take().targets].sort(), [child('Album'), child('Album2')].sort());
  queue.add('r', ROOT, child('Album'));
  queue.add('r', ROOT, ROOT);
  queue.add('r', ROOT, child('Album\\More'));
  at(700);
  assert.deepEqual(queue.take().targets, [ROOT]);
});

test('per-root target overflow collapses to that root without disturbing another root', () => {
  const { queue, at } = fixture({ maxPaths: 3 });
  for (let i = 0; i < 4; i++) queue.add('r', ROOT, child(`Album${i}`));
  queue.add('other', 'D:\\Images', 'D:\\Images\\Only');
  assert.equal(queue.size, 2);
  at(350);
  assert.deepEqual(queue.take().targets, [ROOT]);
  assert.deepEqual(queue.take().targets, ['D:\\Images\\Only']);
});

test('Windows paths collapse case and slash variants while POSIX names remain distinct', () => {
  const { queue, at } = fixture();
  assert.equal(queue.add('r', ROOT, 'c:/pictures/ALBUM'), true);
  assert.equal(queue.add('r', 'c:/PICTURES/', 'C:\\pictures\\album\\deep'), true);
  assert.equal(queue.add('r', ROOT, 'C:\\PICTURES\\album'), true);
  queue.add('posix', '/images', '/images/Album');
  queue.add('posix', '/images', '/images/album');
  at(350);
  assert.deepEqual(queue.take().targets, [child('ALBUM')]);
  assert.deepEqual(queue.take().targets, ['/images/Album', '/images/album']);
});

test('queue rejects traversal, neighboring prefixes, relative targets and root identity changes', () => {
  const { queue, at } = fixture();
  for (const target of [
    'C:\\Pictures2\\Album',
    'D:\\Pictures\\Album',
    'C:\\Pictures\\..\\Other',
    'Album',
    '\\Pictures\\Album'
  ])
    assert.equal(queue.add('r', ROOT, target), false, target);
  assert.equal(queue.add('', ROOT, ROOT), false);
  assert.equal(queue.add('r', 'relative', ROOT), false);
  assert.equal(queue.add('r', ROOT, 'C:\\Pictures\\bad\0name'), false);
  assert.equal(queue.size, 0);
  queue.add('r', ROOT, ROOT);
  assert.equal(queue.add('r', 'C:\\Elsewhere', 'C:\\Elsewhere\\Album'), false);
  at(350);
  queue.take();
  assert.equal(queue.add('r', 'C:\\Elsewhere', 'C:\\Elsewhere\\Album'), false);
  queue.delete('r');
  assert.equal(queue.add('r', 'C:\\Elsewhere', 'C:\\Elsewhere\\Album'), true);
});

test('retry notBefore is honored and a failed root does not block another due root', () => {
  const { queue, at } = fixture();
  queue.add('bad', ROOT, child('Album'));
  at(350);
  const failed = queue.take();
  assert.equal(queue.requeue(failed), true);
  assert.equal(queue.nextDelay(), 500);
  assert.equal(queue.take(), null);
  at(400);
  queue.add('good', 'D:\\Images', 'D:\\Images\\New');
  assert.equal(queue.nextDelay(), 350);
  at(750);
  assert.equal(queue.take().rootId, 'good');
  assert.equal(queue.nextDelay(), 100);
  at(849);
  assert.equal(queue.take(), null);
  at(850);
  const retry = queue.take();
  assert.equal(retry.rootId, 'bad');
  assert.equal(retry.attempts, 1);
  assert.equal(retry.notBefore, 850);
  assert.equal(queue.requeue(retry, { delay: 2000 }), true);
  assert.equal(queue.nextDelay(), 2000);
});

test('default retry backoff grows to 30 seconds instead of spinning after maxWait', () => {
  const { queue, at } = fixture({ debounce: 0, maxWait: 0 });
  let time = 0;
  queue.add('r', ROOT, ROOT);
  for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const entry = queue.take();
    assert.ok(entry);
    assert.equal(queue.requeue(entry), true);
    assert.equal(queue.nextDelay(), delay);
    assert.equal(queue.take(), null);
    time += delay;
    at(time);
  }
});

test('requeue merges events received during a scan and preserves their earliest dirty time', () => {
  const { queue, at } = fixture();
  queue.add('r', ROOT, child('Old'));
  at(350);
  const failed = queue.take();
  at(360);
  queue.add('r', ROOT, child('New'));
  assert.equal(queue.requeue(failed), true);
  assert.equal(queue.requeue(failed), false, 'a failed snapshot is consumed once');
  at(860);
  const merged = queue.take();
  assert.equal(merged.firstDirty, 0);
  assert.equal(merged.lastDirty, 360);
  assert.deepEqual([...merged.targets].sort(), [child('New'), child('Old')].sort());
});

test('successful snapshots need no acknowledgement and cannot consume newly queued notifications', () => {
  const { queue, at } = fixture();
  queue.add('r', ROOT, child('Old'));
  at(350);
  const completed = queue.take();
  at(360);
  queue.add('r', ROOT, child('New'));
  assert.deepEqual(completed.targets, [child('Old')]);
  assert.equal(queue.size, 1);
  at(710);
  assert.deepEqual(queue.take().targets, [child('New')]);
});

test('delete and clear invalidate taken snapshots without reviving removed roots', () => {
  const { queue, at } = fixture({ debounce: 0 });
  queue.add('r', ROOT, ROOT);
  const removed = queue.take();
  assert.equal(queue.delete('r'), false, 'no pending entry but its taken snapshot is invalidated');
  assert.equal(queue.requeue(removed), false);
  queue.add('r', ROOT, ROOT);
  const cleared = queue.take();
  queue.clear();
  queue.add('r', ROOT, ROOT);
  assert.equal(queue.requeue(cleared), false);
  assert.equal(queue.delete('r'), true);
  assert.equal(queue.size, 0);
  assert.equal(queue.requeue({ ...removed }), false);
  at(2000);
  assert.equal(queue.take(), null);
});

test('configuration and explicit retry delays reject invalid numeric inputs', () => {
  for (const maxPaths of [0, -1, 1.5, Infinity])
    assert.throws(() => createWatchQueue({ maxPaths }), /maxPaths/);
  for (const debounce of [-1, NaN, Infinity])
    assert.throws(() => createWatchQueue({ debounce }), /debounce/);
  for (const maxWait of [-1, NaN, Infinity])
    assert.throws(() => createWatchQueue({ maxWait }), /maxWait/);
  assert.throws(() => createWatchQueue({ now: 1 }), /now/);
  const { queue, at } = fixture();
  queue.add('r', ROOT, ROOT);
  at(350);
  const entry = queue.take();
  assert.throws(() => queue.requeue(entry, { delay: -1 }), /retry delay/);
  assert.equal(queue.requeue(entry, { delay: 0 }), true);
  assert.equal(queue.nextDelay(), 0);
});

test('rename notifications enumerate the parent even when case-only lookup finds the old folder', () => {
  let lookups = 0;
  const getNode = () => {
    lookups++;
    return { kind: 'folder' };
  };
  assert.equal(watchTarget(ROOT, 'Album', 'rename', getNode), ROOT);
  assert.equal(watchTarget(ROOT, 'album', 'rename', getNode), ROOT);
  assert.equal(watchTarget(ROOT, 'Parent\\aLbUm', 'rename', getNode), child('Parent'));
  assert.equal(lookups, 0, 'rename target cannot depend on a stale database folder name');
  assert.equal(watchTarget(ROOT, ROOT, 'rename', getNode), ROOT);
});

test('change notifications select known folders but enumerate parents for images and unknown paths', () => {
  const getNode = (value) => (value === child('Folder') ? { kind: 'folder' } : { kind: 'image' });
  assert.equal(watchTarget(ROOT, 'Folder', 'change', getNode), child('Folder'));
  assert.equal(watchTarget(ROOT, 'Folder\\image.png', 'change', getNode), child('Folder'));
  assert.equal(watchTarget(ROOT, 'Unknown\\image.png', 'change'), child('Unknown'));
  assert.equal(
    watchTarget(ROOT, Buffer.from('Folder\\image.png'), 'change', getNode),
    child('Folder')
  );
  assert.equal(watchTarget(ROOT, null, 'rename'), ROOT);
  assert.equal(watchTarget(ROOT, undefined, 'change'), ROOT);
  assert.equal(watchTarget(ROOT, '', 'change'), ROOT);
});

test('watch targets enforce real boundaries for absolute, traversal and drive-relative paths', () => {
  assert.equal(watchTarget(ROOT, 'c:/PICTURES/Album/image.png', 'change'), child('Album'));
  for (const filename of [
    'C:\\Pictures2\\image.png',
    'D:\\Pictures\\image.png',
    '..\\Pictures2\\image.png',
    'C:relative',
    '\\Pictures\\image.png',
    'bad\0name'
  ])
    assert.equal(watchTarget(ROOT, filename, 'rename'), null, filename);
  assert.equal(watchTarget(ROOT, '.', 'rename'), ROOT);
  assert.equal(watchTarget(ROOT, 'image.png', 'other'), null);
  assert.equal(watchTarget('relative', 'image.png', 'rename'), null);
  assert.equal(watchTarget('/images', '../images2/image.png', 'rename'), null);
  assert.equal(watchTarget('/images', 'Folder/image.png', 'rename'), '/images/Folder');
});

test('UNC watch roots use case-insensitive share containment without accepting neighboring shares', () => {
  const root = '\\\\server\\share\\Pictures';
  assert.equal(
    watchTarget(root, '\\\\SERVER\\SHARE\\pictures\\Album\\one.png', 'rename'),
    root + '\\Album'
  );
  assert.equal(watchTarget(root, '\\\\server\\share2\\Pictures\\one.png', 'rename'), null);
  const { queue, at } = fixture();
  queue.add('unc', root, root + '\\Album');
  queue.add('unc', '\\\\SERVER\\SHARE\\pictures', '\\\\server\\share\\PICTURES\\album\\Deep');
  at(350);
  assert.deepEqual(queue.take().targets, [root + '\\Album']);
});
