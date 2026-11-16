'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/app.js'), 'utf8');
const code = source.slice(
  source.indexOf('const rootProbeRequests = new Set()'),
  source.indexOf('function updateSidebar()')
);
function harness(call) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: '' });
    return elements.get(id);
  };
  const root = {
    id: 'root',
    root: 'root',
    path: 'R:/Collection',
    rootStatus: { id: 'root', status: 'online' }
  };
  const state = { roots: [root], current: root, parent: root.id, loadVersion: 1 };
  const toasts = [];
  const context = vm.createContext({
    S: state,
    $: element,
    api: call,
    updateSidebar() {},
    viewKey: () => state.parent,
    toast: (...args) => toasts.push(args),
    loadSummary: async () => {},
    applyTaskSnapshot() {},
    renamingNodes: new Set(),
    captureRenameNavigation: () => ({}),
    grid: { invalidateNavigationCache() {} },
    applyRenameNavigation: async () => {},
    attempt: async (fn) => fn()
  });
  vm.runInContext(code, context);
  return { state, root, elements, toasts, run: (s) => vm.runInContext(s, context), element };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
test('known offline sources browse cache without repeated availability probes', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
  });
  h.root.rootStatus.status = 'offline';
  await h.run("probeBrowseSource(1, 'root')");
  await h.run("probeBrowseSource(1, 'root')");
  h.run('renderSourceStatus()');
  assert.equal(calls, 0);
  assert.equal(h.element('#source-status').hidden, false);
  assert.equal(h.element('#source-retry').disabled, false);
});
test('availability probes are single-flight and a late old root result cannot alter a remapped root', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return pending.promise;
  });
  const first = h.run("probeBrowseSource(1, 'root')");
  await h.run("probeBrowseSource(1, 'root')");
  assert.equal(calls, 1);
  h.state.roots = [{ id: 'new', root: 'new', rootStatus: { status: 'online' } }];
  pending.resolve({ roots: [{ id: 'root', status: 'offline' }] });
  await first;
  assert.equal(h.state.roots[0].rootStatus.status, 'online');
});
test('failed explicit reconnect releases its button and keeps offline state repairable', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness(async () => {
    calls++;
    return pending.promise;
  });
  h.root.rootStatus.status = 'offline';
  const first = h.run('retrySource(S.roots[0])');
  assert.equal(h.element('#source-retry').disabled, true);
  await h.run('retrySource(S.roots[0])');
  assert.equal(calls, 1);
  pending.resolve({ accepted: false, root: { id: 'root', status: 'offline' } });
  await first;
  assert.equal(h.element('#source-retry').disabled, false);
  assert.equal(h.root.rootStatus.status, 'offline');
  assert.equal(h.toasts.length, 1);
});
test('reconnect exception and folder-picker cancellation both release recovery ownership', async () => {
  let calls = 0;
  const h = harness(async (method) => {
    calls++;
    if (method === 'retryRoot') throw Error('unavailable');
    return null;
  });
  await assert.rejects(h.run('retrySource(S.roots[0])'), /unavailable/);
  assert.equal(h.run('rootRecoveryRequests.size'), 0);
  await h.run('relinkSource(S.roots[0])');
  assert.equal(h.run('rootRecoveryRequests.size'), 0);
  assert.equal(calls, 2);
  assert.equal(h.root.path, 'R:/Collection');
});
test('missing subfolder retains a repair action while another root remains online', () => {
  const h = harness(async () => {});
  h.state.current = { id: 'child', root: 'root', parent: 'root', missing: 1 };
  h.state.parent = 'child';
  h.run('renderSourceStatus()');
  assert.equal(h.element('#source-status').hidden, false);
  assert.equal(h.element('#source-relink').hidden, false);
  assert.equal(h.element('#source-status-title').textContent, '文件夹已不可用');
  assert.equal(h.root.rootStatus.status, 'online');
});
