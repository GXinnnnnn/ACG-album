'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute the real handler without loading the application or reproducing its logic.
const appPath = path.join(__dirname, '../src/ui/app.js');
const source = fs.readFileSync(appPath, 'utf8');
const start = source.indexOf('function bindModal(n) {');
assert.ok(start >= 0, 'bindModal must exist in app.js');
const nextFunction = /^(?:async )?function /m.exec(source.slice(start + 1));
assert.ok(nextFunction, 'bindModal must have a following top-level function');
const bindSource = source.slice(start, start + 1 + nextFunction.index);
const bindScript = new vm.Script(`${bindSource}\nbindModal;`, { filename: appPath });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function harness(apiImplementation) {
  const elements = new Map();
  const calls = [];
  const ui = { open: false, closes: 0, reloads: [], toasts: [] };
  const album = { id: 'album-test', name: '测试作品', search_type: 2 };
  let context;
  function element() {
    let value = '';
    return {
      get value() {
        return value;
      },
      set value(input) {
        value = String(input);
      },
      textContent: '',
      innerHTML: '',
      disabled: false,
      isConnected: true,
      focus() {},
      replaceChildren() {
        this.innerHTML = '';
      },
      querySelectorAll() {
        return [];
      }
    };
  }
  function openModal(title, html) {
    for (const node of elements.values()) node.isConnected = false;
    elements.clear();
    // Only the ids consumed by bindModal are represented; no app-wide DOM shim.
    for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set('#' + id, element());
    elements.get('#subject-keyword').value = album.name;
    ui.open = true;
    ui.title = title;
    context.modalGeneration++;
    return { classList: { add() {} } };
  }
  context = vm.createContext({
    modalGeneration: 0,
    $: (selector) => elements.get(selector) || null,
    $$: () => [],
    esc: (value) => String(value),
    svg: () => '<svg></svg>',
    openModal,
    closeModal() {
      ui.open = false;
      ui.closes++;
      context.modalGeneration++;
      for (const node of elements.values()) node.isConnected = false;
      elements.clear();
    },
    async loadPage(force) {
      ui.reloads.push(force);
    },
    toast(message) {
      ui.toasts.push(message);
    },
    api(command, args = {}) {
      // This independent read is outside the patch/match/bind ordering under test.
      if (command === 'tokenStatus') return Promise.resolve({ saved: false, encrypted: true });
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      return apiImplementation(command, args);
    }
  });
  const bindModal = bindScript.runInContext(context);
  bindModal(album);
  return {
    replaceDialog: () => bindModal(album),
    ui,
    album,
    calls,
    get: (selector) => elements.get(selector),
    commands: () => calls.map(({ command }) => command),
    selectType(value) {
      const select = elements.get('#subject-type');
      select.value = value;
      select.onchange({ target: select });
    },
    match: () => elements.get('#auto-match').onclick()
  };
}

function assertDialogRetained(h) {
  assert.equal(h.ui.open, true);
  assert.equal(h.ui.closes, 0);
  assert.deepEqual(h.ui.reloads, []);
  assert.deepEqual(h.ui.toasts, []);
  assert.equal(h.get('#auto-match').disabled, false);
}

test('bindModal awaits the selected type patch before starting the actual match', async () => {
  const patch = deferred();
  const match = deferred();
  let storedType = 2;
  let matchedType;
  const h = harness(async (command, args) => {
    if (command === 'patch') {
      await patch.promise;
      storedType = args.changes.search_type;
      return {};
    }
    assert.equal(command, 'match');
    matchedType = storedType;
    return match.promise;
  });
  h.selectType(4);
  const pending = h.match();
  await nextTurn();
  assert.deepEqual(h.commands(), ['patch']);
  assert.equal(h.album.search_type, 2);
  assert.equal(h.get('#auto-match').disabled, true);
  patch.resolve();
  await nextTurn();
  assert.deepEqual(h.commands(), ['patch', 'match']);
  assert.equal(matchedType, 4);
  assert.equal(h.album.search_type, 4);
  assert.deepEqual(h.calls[1].args, { id: 'album-test', keyword: '测试作品' });
  match.resolve({ needs_selection: true, candidates: [] });
  await pending;
  assertDialogRetained(h);
});

test('bindModal serializes rapid type patches and requires a fresh search for the latest type', async () => {
  const first = deferred();
  const second = deferred();
  let storedType = 2;
  let matchedType;
  const h = harness(async (command, args) => {
    if (command === 'patch') {
      await (args.changes.search_type === 4 ? first.promise : second.promise);
      storedType = args.changes.search_type;
      return {};
    }
    matchedType = storedType;
    return null;
  });
  h.selectType(4);
  const pending = h.match();
  await nextTurn();
  h.selectType(1);
  assert.deepEqual(h.commands(), ['patch']);
  first.resolve();
  await nextTurn();
  assert.deepEqual(h.commands(), ['patch', 'patch']);
  assert.equal(storedType, 4);
  second.resolve();
  await pending;
  assert.deepEqual(h.commands(), ['patch', 'patch']);
  assert.equal(matchedType, undefined);
  assert.equal(h.album.search_type, 1);
  assertDialogRetained(h);
  assert.match(h.get('#candidate-status').textContent, /重新检索/);
  await h.match();
  assert.deepEqual(h.commands(), ['patch', 'patch', 'match']);
  assert.equal(matchedType, 1);
  assertDialogRetained(h);
});

test('a null stale match result retains the dialog and gives an actionable retry message', async () => {
  const h = harness(async (command) => {
    assert.equal(command, 'match');
    return null;
  });
  await h.match();
  assertDialogRetained(h);
  assert.equal(h.get('#bind-error').textContent, '');
  assert.match(h.get('#candidate-status').textContent, /重新检索|重试/);
  assert.match(h.get('#candidate-status').textContent, /条件|取消|过期/);
});

for (const [label, result] of [
  ['null', null],
  ['a returned subject_id', { subject_id: 413741 }]
]) {
  test(`changing selection during a delayed match suppresses stale success for ${label}`, async () => {
    const match = deferred();
    const h = harness(async (command) => (command === 'match' ? match.promise : {}));
    const pending = h.match();
    await nextTurn();
    assert.deepEqual(h.commands(), ['match']);
    h.selectType(4);
    await nextTurn();
    assert.deepEqual(h.commands(), ['match', 'patch']);
    match.resolve(result);
    await pending;
    assertDialogRetained(h);
    assert.equal(h.get('#candidate-list').innerHTML, '');
  });
}

test('a failed type patch prevents matching the previously stored type and remains retryable', async () => {
  const patch = deferred();
  const h = harness(async (command) => {
    assert.equal(command, 'patch', 'a failed patch must never fall through to an old-type match');
    return patch.promise;
  });
  h.selectType(4);
  const pending = h.match();
  await nextTurn();
  patch.reject(new Error('保存检索类型失败，请重试'));
  await pending;
  assert.deepEqual(h.commands(), ['patch']);
  assert.equal(h.album.search_type, 2);
  assertDialogRetained(h);
  assert.match(h.get('#bind-error').textContent, /保存检索类型失败/);
});

for (const outcome of ['success', 'rejection']) {
  test(`a replaced dialog is untouched by a delayed old match ${outcome}`, async () => {
    const match = deferred();
    const h = harness(async (command) => {
      assert.equal(command, 'match');
      return match.promise;
    });
    const pending = h.match();
    await nextTurn();
    h.replaceDialog();
    const replacementError = h.get('#bind-error');
    replacementError.textContent = '新对话框的提示';
    if (outcome === 'success') match.resolve({ subject_id: 413741 });
    else match.reject(new Error('旧对话框请求失败'));
    await pending;
    assertDialogRetained(h);
    assert.equal(h.get('#bind-error'), replacementError);
    assert.equal(replacementError.textContent, '新对话框的提示');
  });
}

test('replacing the dialog while a type patch is pending cancels the old match start', async () => {
  const patch = deferred();
  const h = harness(async (command) => {
    assert.equal(command, 'patch');
    return patch.promise;
  });
  h.selectType(4);
  const pending = h.match();
  await nextTurn();
  h.replaceDialog();
  patch.resolve();
  await pending;
  assert.deepEqual(h.commands(), ['patch']);
  assertDialogRetained(h);
  assert.equal(h.get('#bind-error').textContent, '');
});

test('a returned subject_id alone cannot automatically save or close a manual search', async () => {
  const h = harness(async (command) => {
    assert.equal(command, 'match');
    return { subject_id: 413741 };
  });
  await h.match();
  assertDialogRetained(h);
  assert.deepEqual(h.commands(), ['match']);
  assert.equal(h.get('#subject-url').value, '');
  assert.match(h.get('#candidate-status').textContent, /重新检索/);
});

test('manual candidates retain the dialog and explicit repeated Save submits only once', async () => {
  const h = harness(async (command, args) => {
    if (command === 'match')
      return {
        needs_selection: true,
        candidates: [{ id: 413741, type: 2, name: '测试作品', date: '2023-10-09', match: 1 }]
      };
    assert.equal(command, 'bind');
    assert.deepEqual(JSON.parse(JSON.stringify(args)), {
      id: 'album-test',
      url: 'https://bgm.tv/subject/413741'
    });
    return { subject_id: 413741 };
  });
  await h.match();
  assertDialogRetained(h);
  assert.deepEqual(h.commands(), ['match']);
  assert.equal(h.get('#subject-url').value, '');
  assert.match(h.get('#candidate-list').innerHTML, /data-subject="413741"/);
  assert.match(h.get('#candidate-status').textContent, /尚未更改/);
  // Pasting a candidate URL is supported; real candidate click/aria behavior is
  // verified separately against Chromium in check-manual-navigation.cjs.
  h.get('#subject-url').value = 'https://bgm.tv/subject/413741';
  const save = h.get('#bind-save').onclick;
  await Promise.all([save(), save()]);
  assert.deepEqual(h.commands(), ['match', 'bind']);
  assert.equal(h.ui.open, false);
  assert.equal(h.ui.closes, 1);
  assert.deepEqual(h.ui.reloads, [true]);
  assert.equal(h.ui.toasts.length, 1);
  assert.match(h.ui.toasts[0], /关联已保存/);
});
