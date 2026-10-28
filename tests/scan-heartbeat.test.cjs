'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { Worker, MessageChannel } = require('node:worker_threads');
const { idFor } = require('../src/model.cjs');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fixture(t, mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acg-scan-heartbeat-'));
  const source = path.join(directory, 'source'),
    data = path.join(directory, 'data');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'cover.jpg'), 'decoder suppressed');
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `
    const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
    const {workerData} = require('node:worker_threads');
    const intervals = new Set(), originalInterval = global.setInterval, originalClear = global.clearInterval;
    global.setInterval = (callback, ms, ...args) => {
      const timer = originalInterval(callback, ms, ...args);
      if(ms === 500) intervals.add(timer);
      return timer;
    };
    global.clearInterval = timer => { intervals.delete(timer); return originalClear(timer); };
    let release; const gate = new Promise(resolve => {release=resolve;}); let blocked=false;
    const originalOpen = fs.promises.opendir;
    fs.promises.opendir = async (...args) => {
      if(!blocked && path.resolve(args[0]) === workerData.source) {
        blocked=true; workerData.testPort.postMessage({held:true}); await gate;
        if(workerData.mode === 'error') { const error=new Error('forced asynchronous directory failure'); error.code='ERR_HEARTBEAT_FIXTURE'; throw error; }
      }
      return originalOpen(...args);
    };
    workerData.testPort.on('message', message => {
      if(message.release)release();
      if(message.probe)workerData.testPort.postMessage({probe:message.probe,intervals:intervals.size});
    });
    let source=fs.readFileSync(workerData.script,'utf8');
    const anchor="const media = require('./media.cjs').createMedia({ db, home, getNode, send });";
    if(!source.includes(anchor))throw new Error('media fixture anchor missing');
    source=source.replace(anchor,anchor+' media.start = () => Promise.resolve(media.stats());');
    const mod=new Module(workerData.script); mod.filename=workerData.script;
    mod.paths=Module._nodeModulePaths(path.dirname(workerData.script)); mod._compile(source,workerData.script);
  `,
    {
      eval: true,
      workerData: {
        script: path.resolve(__dirname, '../src/library-worker.cjs'),
        source,
        dataDir: data,
        watch: false,
        mode,
        testPort: port2
      },
      transferList: [port2]
    }
  );
  const events = [],
    requests = new Map(),
    probes = new Map();
  let sequence = 0,
    resolveHeld,
    closed = false;
  const held = new Promise((resolve) => {
    resolveHeld = resolve;
  });
  port1.on('message', (message) => {
    if (message.held) resolveHeld();
    if (message.probe) {
      probes.get(message.probe)(message.intervals);
      probes.delete(message.probe);
    }
  });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  worker.on('error', (error) => {
    readyReject(error);
    for (const request of requests.values()) request.reject(error);
  });
  worker.on('message', (message) => {
    if (message.event) {
      events.push({ at: performance.now(), ...message });
      if (message.event === 'ready') readyResolve();
    }
    if (message.request) {
      const request = requests.get(message.request);
      requests.delete(message.request);
      if (request)
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    }
  });
  const client = {
    events,
    held,
    release: () => port1.postMessage({ release: true }),
    call(method, args = {}) {
      return new Promise((resolve, reject) => {
        const request = ++sequence;
        requests.set(request, { resolve, reject });
        worker.postMessage({ request, method, args });
      });
    },
    intervals() {
      return new Promise((resolve) => {
        const probe = ++sequence;
        probes.set(probe, resolve);
        port1.postMessage({ probe });
      });
    },
    async shutdown() {
      if (!closed) {
        closed = true;
        return client.call('shutdown');
      }
    },
    async close() {
      client.release();
      try {
        await client.shutdown();
      } finally {
        await worker.terminate();
        port1.close();
      }
    }
  };
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('acg-scan-heartbeat-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await ready;
  return { client, source };
}
for (const mode of ['success', 'error', 'cancel', 'shutdown'])
  test(
    `scan heartbeat during asynchronous I/O preserves real counts and cleans up on ${mode}`,
    { timeout: 12000 },
    async (t) => {
      const { client: c, source } = await fixture(t, mode);
      // Convert rejection to data immediately: the intentional error is not an
      // unhandled rejection while the test observes its blocked operation.
      const scan = c.call('scan', { path: source, offline: true }).then(
        (result) => ({ result }),
        (error) => ({ error })
      );
      await c.held;
      const since = performance.now(),
        changed = c.events.filter((event) => event.event === 'changed').length;
      const initial = c.events
        .filter((event) => event.event === 'progress' && event.data.active)
        .at(-1);
      assert.ok(initial);
      const readAt = performance.now();
      assert.ok(await c.call('get', { id: idFor(source) }));
      assert.ok(
        performance.now() - readAt < 2000,
        'RPC remains readable while the scan awaits filesystem I/O'
      );
      await delay(2100);
      const pulses = c.events.filter(
        (event) => event.at >= since && event.event === 'progress' && event.data.active
      );
      assert.ok(
        pulses.length >= 3,
        'active scan must send repeated heartbeats during a >2s filesystem await'
      );
      assert.ok(pulses.length <= 5, 'heartbeats stay bounded to the 500ms cadence');
      const points = [initial, ...pulses];
      for (let i = 1; i < points.length; i++)
        assert.ok(
          points[i].at - points[i - 1].at < 2000,
          'existing heartbeat budget remains unchanged'
        );
      for (const pulse of pulses)
        for (const key of [
          'root',
          'phase',
          'folders',
          'images',
          'visited',
          'queued',
          'errors',
          'scanStamp',
          'revision'
        ])
          assert.equal(pulse.data[key], initial.data[key], `heartbeat does not invent ${key}`);
      assert.equal(
        c.events.filter((event) => event.event === 'changed').length,
        changed,
        'idle heartbeats must not refresh the grid'
      );
      assert.equal(await c.intervals(), 1, 'exactly one scan heartbeat interval is active');
      let shutdown;
      if (mode === 'cancel') {
        await c.call('cancel');
        assert.equal(
          await c.intervals(),
          0,
          'cancel releases the timer before pending I/O settles'
        );
        const count = c.events.filter((event) => event.event === 'progress').length;
        await delay(600);
        assert.equal(
          c.events.filter((event) => event.event === 'progress').length,
          count,
          'cancelled waiting scan emits no further heartbeat'
        );
      }
      if (mode === 'shutdown') {
        shutdown = c.shutdown();
        // The RPC sets stopping synchronously before awaiting the still-blocked scan.
        await c.call('get', { id: idFor(source) });
        assert.equal(
          await c.intervals(),
          0,
          'shutdown releases the timer before pending I/O settles'
        );
      }
      c.release();
      const outcome = await scan;
      if (shutdown) await shutdown;
      if (mode === 'error')
        assert.match(outcome.error?.message || '', /forced asynchronous directory failure/);
      else {
        assert.ok(!outcome.error);
        assert.equal(outcome.result.cancelled, mode === 'cancel' || mode === 'shutdown');
      }
      assert.equal(await c.intervals(), 0, 'the settled scan owns no timer');
      const settled = c.events.filter((event) => event.event === 'progress').length;
      await delay(600);
      assert.equal(
        c.events.filter((event) => event.event === 'progress').length,
        settled,
        'success/error/cancel/shutdown leaves no progress timer behind'
      );
    }
  );
