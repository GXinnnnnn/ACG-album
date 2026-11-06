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
const busyStart = source.indexOf('let importBusyHeld = false'),
  busyEnd = source.indexOf('async function enterPendingImport', busyStart);
assert.ok(busyStart >= 0 && busyEnd > busyStart, 'real import controls must be present');
const script = new vm.Script(source.slice(busyStart, busyEnd) + source.slice(start, end), {
  filename
});
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function harness({ reducedMotion = false } = {}) {
  const elements = new Map();
  const timers = new Map();
  const requests = [];
  const cancellations = [];
  const animations = [];
  const dateActions = { invalidations: 0, refreshes: 0 };
  let timerId = 0,
    mutations = 0,
    created = 0;
  function element() {
    const attributes = new Map();
    let text = '',
      hidden = false,
      disabled = false,
      title = '';
    return {
      get disabled() {
        return disabled;
      },
      set disabled(value) {
        disabled = value;
        mutations++;
      },
      get hidden() {
        return hidden;
      },
      set hidden(value) {
        hidden = value;
        mutations++;
      },
      textWrites: 0,
      get textContent() {
        return text;
      },
      set textContent(value) {
        text = String(value);
        this.textWrites++;
        mutations++;
      },
      get title() {
        return title;
      },
      set title(value) {
        title = value;
        mutations++;
      },
      dataset: new Proxy(
        {},
        {
          set(target, key, value) {
            target[key] = value;
            mutations++;
            return true;
          }
        }
      ),
      style: new Proxy(
        {},
        {
          set(target, key, value) {
            target[key] = value;
            mutations++;
            return true;
          }
        }
      ),
      setAttribute(name, value) {
        attributes.set(name, String(value));
        mutations++;
      },
      removeAttribute(name) {
        attributes.delete(name);
        mutations++;
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      after(child) {
        child.insertedAfter = this;
        elements.set('#' + child.id, child);
        mutations++;
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
    '.progress-details',
    '#progress-path',
    '#progress-percent',
    '#progress-bar',
    '#cancel-import',
    '.progress-spinner',
    '#footer-status',
    '#import-sidebar',
    '#empty-import',
    '#demo-import'
  ])
    elements.set(selector, element());
  elements.get('#progress-bar').parentElement = element();
  const context = vm.createContext({
    $: (selector) => elements.get(selector) || null,
    $$: (selectors) =>
      selectors
        .split(',')
        .map((selector) => elements.get(selector))
        .filter(Boolean),
    document: {
      createElement() {
        created++;
        return element();
      }
    },
    scanActive: false,
    S: { sort: 'contentDate' },
    grid: {
      invalidateNavigationCache() {
        dateActions.invalidations++;
      }
    },
    scheduleGrowingRefresh() {
      dateActions.refreshes++;
    },
    pendingImport: null,
    progressHideTimer: null,
    updateRefreshBusy() {},
    fmt: (value) => String(value || 0),
    matchMedia: () => ({ matches: reducedMotion }),
    clearTimeout: (id) => timers.delete(id),
    setTimeout(action, delay = 0) {
      const id = ++timerId;
      timers.set(id, { action, delay });
      return id;
    },
    api(method, args) {
      if (method === 'cancel')
        return new Promise((resolve, reject) => cancellations.push({ resolve, reject }));
      assert.equal(method, 'get');
      return new Promise((resolve, reject) => requests.push({ id: args.id, resolve, reject }));
    }
  });
  script.runInContext(context);
  return {
    context,
    requests,
    cancellations,
    animations,
    dateActions,
    date: (value) => context.showDateMigration(value),
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
    timerCount: () => timers.size,
    mutationCount: () => mutations,
    createdCount: () => created
  };
}

test('scan and matching events keep one title, preserve counts and leave cancel available through the batch', () => {
  const h = harness();
  h.context.pendingImport = {};
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
  assert.equal(h.get('#progress-detail').textContent, '已处理 3 项 | 待处理 4 项');
  assert.equal(h.get('#progress-directory').insertedAfter, h.get('.progress-details'));
  assert.equal(h.get('#progress-bar').parentElement.getAttribute('aria-valuenow'), '42');
  assert.equal(h.get('#progress-path').textContent, '作品简介在后台检索，可继续浏览相册');
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#progress-directory').textContent, '相册A');
  assert.equal(h.get('#cancel-import').hidden, false);
  h.scan({ active: true, current: 'C:\\生成目录\\相册B', images: 70, folders: 11 });
  assert.equal(h.get('#progress-directory').textContent, '相册B');
  h.scan({ active: false, current: 'C:\\生成目录\\相册B', images: 70, folders: 11 });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  assert.equal(h.get('#cancel-import').hidden, false);
  assert.equal(h.get('#import-sidebar').disabled, true);
  assert.equal(h.timerCount(), 0, 'must not hide while matching continues');
});

test('discovery and scanning snapshots use only completed plus remaining for the determinate progress', () => {
  const h = harness();
  h.scan({ active: true, images: 80, folders: 12, current: '/generated/current' });
  const track = h.get('#progress-bar').parentElement;
  assert.equal(
    track.getAttribute('aria-valuenow'),
    null,
    'scan counts do not predict a match total'
  );
  h.online({ active: true, discovering: true, completed: 2, remaining: 6, total: 999 });
  assert.equal(track.getAttribute('aria-valuenow'), '25');
  assert.equal(h.get('#progress-bar').style.width, '25%');
  assert.equal(h.get('#progress-detail').textContent, '已处理 2 项 | 待处理 6 项');
  h.online({ active: true, discovering: true, completed: 3, remaining: 17, total: 999 });
  assert.equal(
    track.getAttribute('aria-valuenow'),
    '15',
    'newly discovered work updates the true denominator'
  );
  h.scan({ active: false, images: 80, folders: 12 });
  h.online({ active: true, discovering: false, completed: 11, remaining: 9, total: 3 });
  assert.equal(track.getAttribute('aria-valuenow'), '55');
  assert.equal(h.get('#progress-percent').textContent, '55%');
  assert.equal(h.animations.filter((animation) => !animation.cancelled).length, 0);
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

test('scan-only cancellation never invents matching totals and reduced-motion never starts an animation', () => {
  const h = harness({ reducedMotion: true });
  h.scan({ active: true, current: '/generated/photo', images: 1, folders: 1 });
  assert.equal(h.animations.length, 0);
  assert.equal(h.get('#progress-bar').parentElement.getAttribute('aria-valuenow'), null);
  h.scan({ active: false, phase: '已取消导入', images: 12, folders: 4, errors: 3 });
  h.flushTimers(300);
  assert.equal(h.get('#progress-title').textContent, '导入已取消');
  assert.equal(h.get('#progress-percent').textContent, '已取消');
  assert.equal(h.get('#progress-detail').textContent, '已处理 0 项 | 待处理 0 项');
  assert.match(h.get('#progress-path').textContent, /导入跳过 3 项/);
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
    assert.equal(h.get('#progress-detail').textContent, '已处理 0 项 | 待处理 0 项');
    // The next real online batch must still replace the local completion.
    h.online({ active: true, completed: 0, remaining: 2, total: 2 });
    assert.equal(h.get('#progress-detail').textContent, '已处理 0 项 | 待处理 2 项');
    assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  });
}

test('repeated active snapshots keep progress nodes and do not rewrite unchanged text, attributes or styles', () => {
  const h = harness();
  const snapshot = { active: true, id: 'same', completed: 2, remaining: 8, total: 10 };
  h.online(snapshot);
  const selectors = [
    '#progress-title',
    '#progress-detail',
    '.progress-details',
    '#progress-path',
    '#progress-percent',
    '#footer-status'
  ];
  const counts = selectors.map((selector) => h.get(selector).textWrites),
    mutations = h.mutationCount(),
    directory = h.get('#progress-directory');
  for (let i = 0; i < 100; i++) h.online({ ...snapshot });
  assert.deepEqual(
    selectors.map((selector) => h.get(selector).textWrites),
    counts
  );
  assert.equal(h.requests.length, 1);
  assert.equal(
    h.mutationCount(),
    mutations,
    'unchanged snapshots must not mutate text, styles or attributes'
  );
  assert.equal(h.get('#progress-directory'), directory, 'the directory slot stays connected');
  assert.equal(h.createdCount(), 1, 'only the initial directory slot is created');
});

test('completion settling accepts the latest idle totals without extending its deadline', () => {
  const h = harness();
  h.online({ active: true, completed: 2, remaining: 8, total: 10 });
  h.online({ active: false, completed: 9, remaining: 0, total: 10 });
  h.online({ active: false, completed: 10, remaining: 0, total: 10 });
  assert.equal(
    h.timerCount(),
    2,
    'control release and progress completion each retain their first idle deadline'
  );
  h.flushTimers(300);
  assert.equal(h.get('#import-sidebar').disabled, false);
  assert.equal(h.get('#progress-detail').textContent, '已处理 10 项 | 待处理 0 项');
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

test('unknown workload motion restarts after pause and other maintenance progress clears the directory label', () => {
  const h = harness();
  h.online({ active: true, discovering: true, remaining: 0 });
  assert.equal(h.animations.length, 1);
  h.online({ active: false, paused: 'access', remaining: 2 });
  assert.equal(h.animations[0].cancelled, true);
  h.online({ active: true, discovering: true, remaining: 0 });
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

test('scanner reservation, cancellation draining and online hand-off keep controls stable across transient idle', () => {
  const h = harness();
  h.scan({ active: false, busy: true, phase: '正在准备导入' });
  for (const selector of ['#import-sidebar', '#empty-import', '#demo-import']) {
    assert.equal(h.get(selector).disabled, true);
    assert.equal(h.get(selector).getAttribute('aria-busy'), 'true');
  }
  assert.equal(h.get('#cancel-import').hidden, false);
  assert.equal(h.get('#cancel-import').disabled, false);
  assert.equal(h.get('#progress-panel').dataset.state, 'active');
  const writes = h.mutationCount();
  for (let i = 0; i < 100; i++) h.scan({ active: false, busy: true, phase: '正在准备导入' });
  assert.equal(h.mutationCount(), writes, 'unchanged reservation snapshots never rewrite controls');
  h.scan({ active: false, busy: false });
  assert.equal(h.get('#import-sidebar').disabled, true);
  assert.equal(h.get('#cancel-import').hidden, false);
  h.online({ active: true, remaining: 4 });
  h.flushTimers(300);
  assert.equal(h.get('#import-sidebar').disabled, true);
  assert.equal(h.get('#cancel-import').hidden, false);
  h.scan({ active: false, busy: false, cancelling: true });
  h.online({ active: false, remaining: 0 });
  h.flushTimers(300);
  assert.equal(h.get('#progress-title').textContent, '正在取消导入');
  assert.equal(h.get('#cancel-import').disabled, false);
  h.scan({ active: false, busy: false, cancelling: false, phase: '已取消导入' });
  h.flushTimers(300);
  assert.equal(h.get('#import-sidebar').disabled, false);
  assert.equal(h.get('#cancel-import').hidden, true);
});

test('cancel stays available while one request drains, ignores double clicks, and resets for the next batch', async () => {
  const h = harness();
  h.scan({ active: true, busy: true });
  const cancel = h.context.cancelImport();
  await h.context.cancelImport();
  assert.equal(h.cancellations.length, 1);
  assert.equal(h.get('#cancel-import').hidden, false);
  assert.equal(h.get('#cancel-import').disabled, false);
  assert.equal(h.get('#cancel-import').textContent, '正在取消…');
  h.cancellations[0].resolve(true);
  await cancel;
  h.scan({ active: false, busy: true, cancelling: true });
  h.flushTimers(300);
  assert.equal(
    h.get('#import-sidebar').disabled,
    true,
    'cancel acknowledgement is not worker completion'
  );
  assert.equal(h.get('#cancel-import').hidden, false);
  h.scan({ active: false, busy: false, phase: '已取消导入' });
  h.flushTimers(300);
  assert.equal(h.get('#import-sidebar').disabled, false);
  h.scan({ active: true, busy: true });
  const again = h.context.cancelImport();
  assert.equal(h.cancellations.length, 2);
  h.cancellations[1].resolve(true);
  await again;
});

test('cancel rejection restores retry while queued paused work remains cancellable and empty pause unlocks', async () => {
  const h = harness();
  h.online({ active: false, paused: 'access', remaining: 2 });
  assert.equal(h.get('#import-sidebar').disabled, true);
  assert.equal(h.get('#cancel-import').hidden, false);
  const cancel = h.context.cancelImport();
  h.cancellations[0].reject(new Error('generated failure'));
  await assert.rejects(cancel, /generated failure/);
  assert.equal(h.get('#cancel-import').textContent, '取消');
  const retry = h.context.cancelImport();
  assert.equal(h.cancellations.length, 2);
  h.cancellations[1].resolve(true);
  await retry;
  h.online({ active: false, paused: 'access', remaining: 0, discovering: false });
  h.flushTimers(300);
  assert.equal(
    h.get('#import-sidebar').disabled,
    false,
    'a stale pause reason cannot lock importing'
  );
  assert.equal(h.get('#cancel-import').hidden, true);
});

test('date cache progress counts only committed rows, keeps index work indeterminate and rejects stale init snapshots', () => {
  const h = harness(),
    track = h.get('#progress-bar').parentElement;
  h.date({ revision: 1, active: true, ready: false, stage: 'counting', processed: 0, total: null });
  assert.equal(h.get('#progress-title').textContent, '正在准备日期排序');
  assert.equal(track.getAttribute('aria-valuenow'), null);
  h.date({
    revision: 2,
    active: true,
    ready: false,
    stage: 'backfill',
    processed: 512,
    total: 1000
  });
  assert.equal(track.getAttribute('aria-valuenow'), '51');
  assert.match(h.get('#progress-detail').textContent, /512.*1000/);
  h.date({
    revision: 3,
    active: true,
    ready: false,
    stage: 'index',
    processed: 1000,
    total: 1000,
    indexesCompleted: 1,
    indexesTotal: 2
  });
  assert.equal(
    track.getAttribute('aria-valuenow'),
    null,
    'backfill completion is not overall completion'
  );
  assert.match(h.get('#progress-percent').textContent, /1\/2/);
  h.date({ revision: 4, active: false, ready: true, stage: 'ready' });
  assert.equal(track.getAttribute('aria-valuenow'), '100');
  assert.deepEqual(h.dateActions, { invalidations: 1, refreshes: 1 });
  h.date({ revision: 1, active: true, ready: false, stage: 'backfill', processed: 1, total: 1000 });
  assert.equal(h.get('#progress-title').textContent, '日期缓存已准备好');
  assert.deepEqual(h.dateActions, { invalidations: 1, refreshes: 1 });
});
test('date progress yields to real scans and matching, and readiness never replaces an explicit name sort', () => {
  const h = harness();
  h.context.S.sort = 'name';
  h.scan({ active: true, images: 4, folders: 1 });
  const scanningTitle = h.get('#progress-title').textContent;
  h.date({ revision: 1, active: true, stage: 'backfill', processed: 10, total: 100 });
  assert.equal(h.get('#progress-title').textContent, scanningTitle);
  h.context.scanActive = false;
  h.online({ active: true, completed: 2, remaining: 3 });
  h.date({ revision: 2, active: true, stage: 'index', indexesCompleted: 0, indexesTotal: 2 });
  assert.equal(h.get('#progress-title').textContent, '正在检索作品简介');
  h.date({ revision: 3, active: false, ready: true, stage: 'ready' });
  assert.deepEqual(h.dateActions, { invalidations: 1, refreshes: 0 });
  assert.equal(h.context.S.sort, 'name');
});
test('picker cancellation releases busy and isolated bind or removal changes cannot invent a batch', () => {
  const h = harness();
  h.context.pendingImport = { sawProgress: false };
  h.context.updateImportBusy();
  assert.equal(h.get('#import-sidebar').disabled, true);
  assert.equal(
    h.get('#cancel-import').hidden,
    true,
    'native picker is not a cancellable worker task'
  );
  h.context.pendingImport = null;
  h.context.updateImportBusy();
  h.flushTimers(300);
  assert.equal(h.get('#import-sidebar').disabled, false);
  h.context.updateImportBusy(); // A single-item association or independent removal has no progress/online queue.
  assert.equal(h.get('#import-sidebar').disabled, false);
  assert.equal(h.get('#cancel-import').hidden, true);
});
