'use strict';
// Public-service test, generated fixture/profile only, never reads saved credentials.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const sharp = require('sharp');
const { idFor, searchPlan } = require('../src/model.cjs');
const metadata = require('../package.json');
const root = path.resolve(__dirname, '..');
(async () => {
  const base = path.join(root, 'artifacts/bilingual-live');
  await fs.mkdir(base, { recursive: true });
  const run = await fs.mkdtemp(path.join(base, metadata.version + '-'));
  const title = '天选庶民的真命之选セレクトオブリージュ';
  const source = path.join(run, 'generated-source');
  const album = path.join(source, title);
  await fs.mkdir(album, { recursive: true });
  await sharp({ create: { width: 32, height: 32, channels: 3, background: '#c9b5cf' } })
    .png()
    .toFile(path.join(album, 'fixture.png'));
  const report = {
    version: metadata.version,
    run,
    started: new Date().toISOString(),
    scope:
      'Unmocked public Bangumi HTTP and production worker; generated image/profile, empty token, no user data access.',
    plan: searchPlan(title),
    requests: [],
    passed: false
  };
  const worker = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
      const response = await originalFetch(url, options);
      if (String(url).includes('/search/subjects') || new RegExp('^/v0/subjects/[0-9]+$').test(new URL(String(url)).pathname)) {
        const body = options?.body ? JSON.parse(options.body) : null;
        const json = await response.clone().json();
        parentPort.postMessage({ event: 'live-request', data: { url: String(url), status: response.status,
          keyword: body?.keyword, filter: body?.filter, authorized: !!options?.headers?.Authorization,
          subjects: (body ? json.data || [] : [json]).map(({id,type,name,name_cn}) => ({id,type,name,name_cn})) } });
      }
      return response;
    };
    require(workerData.source);
  `,
    {
      eval: true,
      workerData: {
        source: path.join(root, 'src/library-worker.cjs'),
        dataDir: path.join(run, 'profile'),
        token: '',
        watch: false
      }
    }
  );
  let seq = 0,
    started = false,
    idle = false,
    wake;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (m) => {
      if (m.event === 'ready') resolve();
      if (m.event === 'live-request') report.requests.push(m.data);
      if (m.event === 'online') {
        if (m.data.active) started = true;
        else if (started) {
          idle = true;
          wake?.();
        }
      }
      const task = pending.get(m.request);
      if (task) {
        pending.delete(m.request);
        clearTimeout(task.timer);
        m.error ? task.reject(new Error(m.error)) : task.resolve(m.result);
      }
    });
  });
  const call = (method, args = {}) =>
    new Promise((resolve, reject) => {
      const request = ++seq;
      const timer = setTimeout(() => {
        pending.delete(request);
        reject(new Error('RPC timeout: ' + method));
      }, 60000);
      pending.set(request, { resolve, reject, timer });
      worker.postMessage({ request, method, args });
    });
  try {
    await ready;
    await call('settings', { key: 'autoMatch', value: false });
    await call('scan', { path: source, onlineMatch: true, subjectTypes: [4] });
    if (!idle)
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Live queue timeout')), 240000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (idle) wake();
      });
    const node = await call('get', { id: idFor(album) });
    report.automatic = {
      id: node.subject_id,
      manual: node.manual_subject,
      type: node.metadata?.type,
      name: node.metadata?.name,
      name_cn: node.metadata?.name_cn
    };
    assert.equal(node.subject_id, 456680);
    assert.equal(node.metadata.type, 4);
    assert.equal(node.manual_subject, 0);
    for (const part of report.plan.titleGroups[0].parts)
      assert.ok(
        report.requests.some((r) => r.keyword === part && r.subjects.some((s) => s.id === 456680)),
        'Independent search must retrieve the shared subject: ' + part
      );
    const manual = await call('match', { id: node.id });
    assert.equal(manual.needs_selection, true);
    assert.equal(manual.candidates[0].id, 456680);
    assert.equal(manual.searchAccess.tokenPresent, false);
    assert.deepEqual(await call('get', { id: node.id }), node);
    assert.ok(report.requests.every((r) => !r.authorized && (!r.filter || !('nsfw' in r.filter))));
    report.manualSearchReadOnly = true;
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    process.exitCode = 1;
  } finally {
    try {
      await call('shutdown');
    } catch {}
    await worker.terminate();
    for (const task of pending.values()) clearTimeout(task.timer);
    report.finished = new Date().toISOString();
    await fs.writeFile(path.join(run, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
