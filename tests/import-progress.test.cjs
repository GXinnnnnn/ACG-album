'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/ui/app.js');
const source = fs.readFileSync(filename, 'utf8');
const start = source.indexOf('let latestOnlineProgress = null');
const end = source.indexOf('window.album.onEvent(', start);
assert.ok(start >= 0 && end > start, 'real progress handlers must be present');
const script = new vm.Script(source.slice(start, end), { filename });
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function harness({ reducedMotion = false } = {}) {
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  const animations = [];
  let timerId = 0;
  function element() {
    const attributes = new Map();
    let text = '';
    return {
      hidden: false,
      textWrites: 0,
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = String(value);
        this.textWrites++;
      },
      title: '',
      dataset: {},
      style: {},
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      removeAttribute(name) {
        attributes.delete(name);
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      after(child) {
        elements.set('#' + child.id, child);
      },
      animate() {
        const animation = {
          cancelled: false,
          play() {},
          cancel() {
            this.cancelled = true;
          }
        };
        animations.push(animation);
        return animation;
      }
    };
  }
  for (const selector of [
    '#progress-panel',
    '#progress-title',
    '#progress-detail',
    '#progress-path',
    '#progress-percent',
    '#progress-bar',
    '#cancel-import',
    '.progress-spinner',
    '#footer-status'
  ])
    elements.set(selector, element());
  elements.get('#progress-bar').parentElement = element();
  const context = vm.createContext({
    $: (selector) => elements.get(selector) || null,
    document: { createElement: element },
    scanActive: false,
    pendingImport: {},
    progressHideTimer: null,
    updateImportBusy() {},
    fmt: (value) => String(value || 0),
    matchMedia: () => ({ matches: reducedMotion }),
    clearTimeout: (id) => timers.delete(id),
    setTimeout(action, delay = 0) {
      const id = ++timerId;
      timers.set(id, { action, delay });
      return id;
    },
    api(method, args) {
      assert.equal(method, 'get');
      return new Promise((resolve, reject) => requests.push({ id: args.id, resolve, reject }));
    }
  });
  script.runInContext(context);
  return {
    context,
    requests,
    animations,
    scan: (value) => context.showProgress(value),
    online: (value) => context.showOnlineStatus(value),
    get: (selector) => elements.get(selector),
    flushTimers(maxDelay = Infinity) {
      for (const [id, timer] of [...timers])
        if (timer.delay <= maxDelay) {
          timers.delete(id);
          timer.action();
        }
    },
    timerCount: () => timers.size
  };
}

test('scan and matching events keep one title, preserve counts and leave cancel available until scanning ends', () => {
  const h = harness();
  h.scan({
    active: true,
    name: '分类A',
    current: 'C:\\生成目录\\相册A',
    images: 35,
    folders: 7,
    errors: 2
  });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#progress-directory').textContent, '相册A');
  assert.equal(h.get('#progress-directory').title, 'C:\\生成目录\\相册A');
  assert.equal(h.get('#cancel-import').hidden, false);
  assert.equal(h.context.pendingImport.sawProgress, true);
  h.online({ active: true, id: 'first', completed: 3, remaining: 4, total: 7 });
  assert.match(h.get('#progress-detail').textContent, /35 个媒体项目/);
  assert.match(h.get('#progress-detail').textContent, /2 项跳过/);
  assert.match(h.get('#progress-detail').textContent, /3 \/ 7/);
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#progress-directory').textContent, '相册A');
  assert.equal(h.get('#cancel-import').hidden, false);
  h.scan({ active: true, current: 'C:\\生成目录\\相册B', images: 70, folders: 11 });
  assert.equal(h.get('#progress-directory').textContent, '相册B');
  h.scan({ active: false, current: 'C:\\生成目录\\相册B', images: 70, folders: 11 });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#cancel-import').hidden, true);
  assert.equal(h.timerCount(), 0, 'must not hide while matching continues');
});

test('matching directory follows latest folder ID and discards stale asynchronous results', async () => {
  const h = harness();
  h.online({ active: true, id: 'old', completed: 0, remaining: 2 });
  h.online({ active: true, id: 'new', completed: 1, remaining: 1 });
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ path: '/generated/新目录' });
  await nextTurn();
  assert.equal(h.get('#progress-directory').textContent, '新目录');
  h.requests[0].resolve({ path: '/generated/旧目录' });
  await nextTurn();
  assert.equal(h.get('#progress-directory').textContent, '新目录');
  h.online({ active: true, id: 'late', remaining: 1 });
  h.online({ active: false, remaining: 0, completed: 3 });
  h.requests[2].resolve({ path: '/generated/完成后返回' });
  await nextTurn();
  h.flushTimers(300);
  assert.equal(h.get('#progress-title').textContent, '作品检索完成');
  assert.equal(h.get('#progress-directory').hidden, true);
  assert.equal(h.timerCount(), 1);
});

test('online directory resolution never replaces the scanner current directory', async () => {
  const h = harness();
  h.scan({ active: true, current: '/generated/扫描目录', images: 8, folders: 2 });
  h.online({ active: true, id: 'match', remaining: 2 });
  h.requests[0].resolve({ name: '匹配目录' });
  await nextTurn();
  assert.equal(h.get('#progress-directory').textContent, '扫描目录');
  h.scan({ active: false, images: 8, folders: 2 });
  assert.equal(h.get('#progress-directory').textContent, '匹配目录');
});

test('access pause and retry keep recovery messages and the correct accessible progress state', () => {
  const h = harness();
  h.online({ active: false, paused: 'access', remaining: 3, completed: 2 });
  assert.equal(h.get('#progress-title').textContent, '作品检索已暂停');
  assert.match(h.get('#progress-path').textContent, /Access Token/);
  assert.equal(h.get('#progress-panel').dataset.state, 'paused');
  assert.equal(h.get('#progress-panel').getAttribute('aria-busy'), 'false');
  assert.equal(h.timerCount(), 0);
  h.online({ active: false, paused: 'retry', retryAt: Date.now() + 1000, remaining: 3 });
  assert.match(h.get('#progress-path').textContent, /重试/);
  h.scan({ active: true, current: '/generated/仍在扫描', images: 9, folders: 3 });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#progress-panel').dataset.state, 'active');
  assert.equal(h.get('#cancel-import').hidden, false);
});

test('scan-only cancellation preserves skipped counts and reduced-motion never starts an animation', () => {
  const h = harness({ reducedMotion: true });
  h.scan({ active: true, current: '/generated/photo', images: 1, folders: 1 });
  assert.equal(h.animations.length, 0);
  assert.equal(h.get('#progress-bar').parentElement.getAttribute('aria-valuenow'), null);
  h.scan({ active: false, phase: '已取消导入', images: 12, folders: 4, errors: 3 });
  h.flushTimers(300);
  assert.equal(h.get('#progress-title').textContent, '导入已取消');
  assert.equal(h.get('#progress-percent').textContent, '已取消');
  assert.match(h.get('#progress-detail').textContent, /3 项跳过/);
  assert.equal(h.get('#progress-panel').getAttribute('aria-busy'), 'false');
  h.flushTimers();
  assert.equal(h.get('#progress-panel').hidden, true);
});

for (const cancelled of [false, true]) {
  test(`a later local-only ${cancelled ? 'cancelled' : 'completed'} import does not reuse the previous online batch summary`, () => {
    const h = harness();
    h.online({ active: true, completed: 0, remaining: 3 });
    h.online({ active: false, completed: 3, remaining: 0, total: 3 });
    h.scan({ active: true, current: '/generated/local', images: 22, folders: 4 });
    // A late idle snapshot from the worker still describes the earlier batch.
    h.online({ active: false, completed: 3, remaining: 0, total: 3 });
    h.scan({
      active: false,
      phase: cancelled ? '已取消导入' : '导入完成',
      images: 22,
      folders: 4,
      errors: 2
    });
    h.flushTimers(300);
    assert.equal(h.get('#progress-title').textContent, cancelled ? '导入已取消' : '导入完成');
    assert.match(h.get('#progress-detail').textContent, /22 个媒体项目 · 4 个目录 · 2 项跳过/);
    assert.doesNotMatch(h.get('#progress-detail').textContent, /3 \/ 3/);
    // The next real online batch must still replace the local completion.
    h.online({ active: true, completed: 0, remaining: 2, total: 2 });
    assert.match(h.get('#progress-detail').textContent, /0 \/ 2/);
    assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  });
}

test('repeated active snapshots do not rewrite unchanged progress text', () => {
  const h = harness();
  const snapshot = { active: true, id: 'same', completed: 2, remaining: 8, total: 10 };
  h.online(snapshot);
  const selectors = [
    '#progress-title',
    '#progress-detail',
    '#progress-path',
    '#progress-percent',
    '#footer-status'
  ];
  const counts = selectors.map((selector) => h.get(selector).textWrites);
  for (let i = 0; i < 100; i++) h.online({ ...snapshot });
  assert.deepEqual(
    selectors.map((selector) => h.get(selector).textWrites),
    counts
  );
  assert.equal(h.requests.length, 1);
});

test('completion settling accepts the latest idle totals without extending its deadline', () => {
  const h = harness();
  h.online({ active: true, completed: 2, remaining: 8, total: 10 });
  h.online({ active: false, completed: 9, remaining: 0, total: 10 });
  h.online({ active: false, completed: 10, remaining: 0, total: 10 });
  assert.equal(h.timerCount(), 1);
  h.flushTimers(300);
  assert.match(h.get('#progress-detail').textContent, /10 \/ 10/);
  assert.equal(h.get('#progress-percent').textContent, '100%');
  assert.equal(h.timerCount(), 1, 'only the final hide timer remains');
});

test('folder labels stay visible until the next lookup resolves and brief idle snapshots never flash completion', async () => {
  const h = harness();
  h.online({ active: true, id: 'first', completed: 0, remaining: 2 });
  h.requests[0].resolve({ name: '当前目录' });
  await nextTurn();
  h.online({ active: false, completed: 1, remaining: 0, total: 1 });
  assert.equal(h.get('#progress-panel').dataset.state, 'active');
  h.online({ active: true, id: 'second', completed: 1, remaining: 1 });
  assert.equal(h.get('#progress-directory').textContent, '当前目录');
  assert.equal(h.get('#progress-directory').hidden, false);
  h.flushTimers(300);
  assert.equal(h.get('#progress-panel').dataset.state, 'active');
  h.requests[1].resolve({ name: '下个目录' });
  await nextTurn();
  assert.equal(h.get('#progress-directory').textContent, '下个目录');
  h.online({ active: false, completed: 2, remaining: 0 });
  h.flushTimers(300);
  assert.equal(h.get('#progress-panel').dataset.state, 'complete');
  assert.equal(h.timerCount(), 1);
  h.flushTimers();
  assert.equal(h.get('#progress-panel').hidden, true);
  h.online({ active: false, completed: 2, remaining: 0 });
  assert.equal(
    h.get('#progress-panel').hidden,
    true,
    'late idle snapshots must not reopen completion'
  );
  assert.equal(h.timerCount(), 0);
});

test('reimport waiting on removed index cleanup exposes the cleanup stage without a second panel', () => {
  const h = harness();
  h.scan({ active: true, phase: '正在清理旧分类', name: '旧分类', images: 0, folders: 0 });
  assert.equal(h.get('#progress-title').textContent, '正在清理旧分类');
  assert.match(h.get('#progress-path').textContent, /完成后继续导入/);
  assert.equal(h.get('#cancel-import').hidden, false);
  h.scan({ active: true, phase: '正在扫描', name: '旧分类', images: 1, folders: 1 });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
});

test('indeterminate motion restarts after pause and other maintenance progress clears the directory label', () => {
  const h = harness();
  h.online({ active: true, discovering: true, remaining: 2 });
  assert.equal(h.animations.length, 1);
  h.online({ active: false, paused: 'access', remaining: 2 });
  assert.equal(h.animations[0].cancelled, true);
  h.online({ active: true, discovering: true, remaining: 2 });
  assert.equal(h.animations.length, 2);
  h.context.paintProgress({
    title: '正在整理文件名称排序',
    detail: '已整理 3 项',
    current: '升级一次',
    active: true,
    label: '整理中…'
  });
  assert.equal(h.get('#progress-title').textContent, '正在整理文件名称排序');
  assert.equal(h.get('#progress-directory').hidden, true);
  assert.equal(h.get('#progress-path').textContent, '升级一次');
});
