'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const workerSource = fs.readFileSync(path.join(__dirname, '../src/library-worker.cjs'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
function resourceFixture() {
  const timers = new Set();
  const context = vm.createContext({
    AbortController,
    Map,
    Set,
    Promise,
    Error,
    stopping: false,
    rootGenerations: new Map(),
    rootAvailability: { isOffline: () => false },
    setTimeout(fn, ms) {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    }
  });
  vm.runInContext(
    workerSource.slice(
      workerSource.indexOf('const rootResourceControllers ='),
      workerSource.indexOf('async function sourceFor(')
    ),
    context
  );
  return { context, timers, run: (code) => vm.runInContext(code, context) };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('queued thumbnails receive a fresh IO deadline only after acquiring a slot', async () => {
  const { context, timers, run } = resourceFixture();
  await run(
    'Promise.all([1,2,3,4].map(n=>thumbSlot(String(n),false,new AbortController().signal)))'
  );
  const request = run(`withRootResource('fixture', async (check, signal, startDeadline) => {
    await thumbSlot('fifth', true, signal);
    acquired = true;
    check();
    startDeadline();
    await new Promise(resolve => { finishDecode = resolve; });
    check();
    return 'decoded';
  }, { deferDeadline: true }).finally(() => { if (typeof acquired !== 'undefined') releaseThumb(); })`);
  await tick();
  assert.equal(timers.size, 0, 'waiting for a decoder must not start the IO timeout');
  run('releaseThumb()');
  await tick();
  assert.equal(context.acquired, true);
  assert.equal(timers.size, 1);
  assert.equal([...timers][0].ms, 8000);
  context.finishDecode();
  assert.equal(await request, 'decoded');
  assert.equal(timers.size, 0);
  const thumbSource = workerSource.slice(
    workerSource.indexOf('async function thumb('),
    workerSource.indexOf('let videoSaveTail')
  );
  assert.match(
    thumbSource.replace(/\/\/[^\n]*/g, ''),
    /await thumbSlot\(key, priority, signal\);\s*acquired = true;\s*check\(\);\s*startDeadline\(\)/
  );
  assert.match(thumbSource, /deferDeadline: true/);
});

test('queued root cancellation removes its waiter and active reads still time out', async () => {
  const { timers, run } = resourceFixture();
  await run(
    'Promise.all([1,2,3,4].map(n=>thumbSlot(String(n),false,new AbortController().signal)))'
  );
  const waiting = run(`withRootResource('fixture', async (check, signal, startDeadline) => {
    await thumbSlot('fifth', false, signal); check(); startDeadline();
  }, { deferDeadline: true })`);
  await tick();
  run("abortRootResources('fixture')");
  await assert.rejects(waiting, { code: 'ROOT_OFFLINE' });
  assert.equal(run('thumbWait.length'), 0);
  assert.equal(run('activeThumbs'), 4);
  assert.equal(timers.size, 0);
  const reading = run("withRootResource('other', async () => new Promise(() => {}))");
  await tick();
  assert.equal([...timers][0].ms, 8000);
  [...timers][0].fn();
  await assert.rejects(reading, { code: 'RESOURCE_TIMEOUT' });
  assert.equal(timers.size, 0);
});

function imageFixture(kind = 'image') {
  const timers = new Set(),
    classes = new Set();
  let removed = false,
    videoRequests = 0;
  const image = {
    src: 'acg-image://thumb/fixture?size=512',
    isConnected: true,
    style: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
    getAttribute(name) {
      return this[name];
    }
  };
  const context = vm.createContext({
    n: { kind },
    b: {
      querySelector: (s) =>
        s === 'img'
          ? image
          : {
              remove: () => {
                removed = true;
              }
            }
    },
    applyCoverCrop() {},
    window: {
      queueVideoThumbnail: () => {
        videoRequests++;
      }
    },
    setTimeout(fn, ms) {
      const timer = { fn, ms };
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    }
  });
  const begin = appSource.indexOf(
    "  const img = b.querySelector('img');",
    appSource.indexOf('function card(')
  );
  vm.runInContext(
    appSource.slice(begin, appSource.indexOf('  // Request the final column/DPR tier', begin)),
    context
  );
  return {
    image,
    timers,
    classes,
    get removed() {
      return removed;
    },
    get videoRequests() {
      return videoRequests;
    },
    fire() {
      const timer = [...timers][0];
      assert.ok(timer);
      timers.delete(timer);
      timer.fn();
    }
  };
}
test('image errors retry twice, retain the placeholder, and show successful images', () => {
  const f = imageFixture();
  f.image.onerror();
  assert.equal(f.removed, false);
  assert.equal([...f.timers][0].ms, 300);
  f.fire();
  assert.match(f.image.src, /[?&]retry=1$/);
  f.image.onerror();
  assert.equal([...f.timers][0].ms, 1200);
  f.fire();
  assert.match(f.image.src, /[?&]retry=2$/);
  assert.equal((f.image.src.match(/retry=/g) || []).length, 1);
  f.image.onerror();
  assert.equal(f.timers.size, 0, 'per-card retries are bounded');
  f.image.onload();
  assert.equal(f.image.style.display, '');
  assert.ok(f.classes.has('loaded'));
  assert.equal(f.removed, true);
});
test('late retry cannot mutate disconnected or retargeted cards and video fallback is preserved', () => {
  for (const change of [
    (img) => {
      img.isConnected = false;
    },
    (img) => {
      img.src = 'new-source';
    }
  ]) {
    const f = imageFixture();
    f.image.onerror();
    change(f.image);
    const before = f.image.src;
    f.fire();
    assert.equal(f.image.src, before);
  }
  const success = imageFixture();
  success.image.onerror();
  success.image.onload();
  assert.equal(success.timers.size, 0);
  const video = imageFixture('video');
  video.image.onerror();
  assert.equal(video.videoRequests, 1);
  assert.equal(video.image.style.display, 'none');
  assert.equal(video.timers.size, 0);
});
