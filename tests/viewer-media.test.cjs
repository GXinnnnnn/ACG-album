'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '../src/ui/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const viewerStart = appSource.indexOf('const V = {');
const viewerEnd = appSource.indexOf('let latestOnlineProgress = null', viewerStart);
assert.ok(viewerStart >= 0 && viewerEnd > viewerStart, 'real viewer handlers must be present');
// Keep the real image callbacks, navigation and close handler together; do not mirror them.
const viewerScript = new vm.Script(
  appSource.slice(viewerStart, viewerEnd) + '\n({ V, displayOriginalImage });',
  { filename: appPath, lineOffset: appSource.slice(0, viewerStart).split('\n').length - 1 }
);
const mediaPath = path.join(__dirname, '../src/ui/media-ui.js');
const mediaScript = new vm.Script(fs.readFileSync(mediaPath, 'utf8'), { filename: mediaPath });
const html = fs.readFileSync(path.join(__dirname, '../src/ui/index.html'), 'utf8');
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function element(tagName = 'div', attributes = '') {
  const listeners = new Map();
  const classes = new Set(/\bclass="([^"]*)"/.exec(attributes)?.[1].split(/\s+/) || []);
  return {
    tagName: tagName.toUpperCase(),
    textContent: '',
    hidden: /(?:^|\s)hidden(?:\s|$)/.test(attributes),
    disabled: false,
    open: false,
    src: '',
    style: {},
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name)
    },
    append(child) {
      child.parentElement = this;
      this.children.push(child);
    },
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    addEventListener(type, listener) {
      const handlers = listeners.get(type) || [];
      handlers.push(listener);
      listeners.set(type, handlers);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ target: this });
    },
    close() {
      this.open = false;
      this.dispatch('close');
    },
    pauseCalls: 0,
    loadCalls: 0,
    pause() {
      this.pauseCalls++;
    },
    load() {
      this.loadCalls++;
    }
  };
}

function harness(apiImplementation = async () => ({})) {
  const elements = new Map();
  // IDs and initial visibility come from shipped markup, so a missing hint is not invented.
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const id = /(?:^|\s)id="([^"]+)"/.exec(match[2])?.[1];
    if (!id) continue;
    const node = element(match[1], match[2]);
    node.textContent = html
      .slice(match.index + match[0].length)
      .split('<', 1)[0]
      .trim();
    elements.set('#' + id, node);
  }
  const bottomMarkup = /<div class="viewer-bottom">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(bottomMarkup, 'the real viewer footer must exist');
  const bottom = element();
  for (const [, id] of bottomMarkup[1].matchAll(/<span\s+id="([^"]+)"/g))
    bottom.append(elements.get('#' + id));
  const canvas = element('canvas');
  canvas.className = 'liquid-glass-canvas';
  bottom.append(canvas);
  function $(selector) {
    if (selector === '.viewer-bottom') return bottom;
    // CSS :last-child sees the GL canvas, even though the preceding element is a span.
    if (selector === '.viewer-bottom span:last-child') {
      const last = bottom.children.at(-1);
      return last?.tagName === 'SPAN' ? last : null;
    }
    return elements.get(selector) || null;
  }
  assert.ok($('#viewer-hint'), 'index.html must contain the stable viewer hint ID');
  $('#viewer').open = true;
  const calls = [],
    timers = new Map(),
    cleared = new Set();
  let timerId = 0;
  const context = vm.createContext({
    $,
    document: { createElement: element },
    window: { album: { onEvent() {} } },
    S: { view: 'grid' },
    fmt: (value) => String(value),
    hideContext() {},
    api(command, args) {
      calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
      return apiImplementation(command, args);
    },
    setTimeout(callback, delay) {
      const timer = { id: ++timerId, callback, delay };
      timers.set(timer.id, timer);
      return timer.id;
    },
    clearTimeout(id) {
      if (timers.delete(id)) cleared.add(id);
    }
  });
  const { V } = viewerScript.runInContext(context);
  V.index = 1;
  V.total = 3;
  mediaScript.runInContext(context);
  return {
    get: $,
    V,
    calls,
    timers,
    cleared,
    bottom,
    canvas,
    display: (node) => context.displayImage(node),
    fire(timer) {
      assert.equal(timers.delete(timer.id), true, 'only a pending timer can expire');
      timer.callback();
    }
  };
}

const image = (id = 'picture') => ({
  id,
  kind: 'image',
  name: id + '.tiff',
  path: 'C:\\素材\\' + id
});
const video = (id = 'clip') => ({ id, kind: 'video', name: id + '.mkv', path: 'C:\\素材\\' + id });

function viewState(h) {
  return {
    node: h.V.node.id,
    open: h.get('#viewer').open,
    image: h.get('#viewer-image').src,
    imageHidden: h.get('#viewer-image').hidden,
    video: h.get('#viewer-video').src,
    videoHidden: h.get('#viewer-video').hidden,
    loading: h.get('#viewer-loading').textContent,
    loadingHidden: h.get('#viewer-loading').hidden,
    position: h.get('#viewer-position').textContent,
    hint: h.get('#viewer-hint').textContent
  };
}

async function leaveViewer(h, transition) {
  if (transition === 'next image') await h.display(image('next-picture'));
  else if (transition === 'next video') await h.display(video('next-clip'));
  else if (transition === 'close button') h.get('#viewer-close').onclick();
  else h.get('#viewer').close();
}

function onlyVideoTimer(h) {
  assert.equal(h.timers.size, 1);
  const timer = [...h.timers.values()][0];
  assert.equal(timer.delay, 10000);
  return timer;
}

function assertHandOff(h, id = 'clip') {
  assert.deepEqual(h.calls, [{ command: 'openMedia', args: { id } }]);
}

for (const kind of ['image', 'video']) {
  test(`a queued previous close event cannot clear the reopened ${kind} session`, async () => {
    const h = harness();
    await h.display(image('previous'));
    h.get('#viewer').open = false;
    h.get('#viewer').open = true;
    await h.display(kind === 'image' ? image('reopened') : video('reopened'));
    const before = viewState(h);
    const serial = h.V.serial;
    const pending = [...h.timers.keys()];
    h.get('#viewer').dispatch('close');
    assert.deepEqual(viewState(h), before);
    assert.equal(h.V.serial, serial);
    assert.deepEqual([...h.timers.keys()], pending);
    assert.deepEqual(h.calls, []);
  });
}

test('the stable viewer hint updates after GL appends a canvas to the real footer', async () => {
  const h = harness();
  assert.equal(h.bottom.children.at(-1), h.canvas);
  assert.equal(h.get('.viewer-bottom span:last-child'), null);
  await h.display(video());
  assert.match(h.get('#viewer-hint').textContent, /原生播放控件/);
  assert.equal(h.get('#viewer-copy').hidden, true);
  assert.equal(h.get('#viewer-fit').hidden, true);
  assert.equal(h.get('#viewer-edit').hidden, true);
  await h.display(image());
  assert.match(h.get('#viewer-hint').textContent, /滚轮缩放.*Ctrl C/);
  assert.equal(h.get('#viewer-path').textContent, image().path);
  assert.equal(h.get('#viewer-copy').hidden, false);
  assert.equal(h.get('#viewer-fit').hidden, false);
  assert.equal(h.get('#viewer-edit').hidden, false);
  assert.equal(h.canvas.textContent, '');
  assert.deepEqual(h.calls, []);
});

test('native image error prepares size 8192 and loads the real preview protocol once', async () => {
  const preview = deferred();
  const h = harness(() => preview.promise);
  await h.display(image());
  const node = h.get('#viewer-image');
  assert.equal(node.src, 'acg-image://original/picture');
  assert.equal(node.hidden, true);
  node.onerror();
  assert.deepEqual(h.calls, [
    { command: 'prepareImagePreview', args: { id: 'picture', size: 8192 } }
  ]);
  assert.equal(h.get('#viewer-loading').hidden, false);
  assert.match(h.get('#viewer-loading').textContent, /兼容解码/);
  preview.resolve({ width: 8192, height: 4096 });
  await nextTurn();
  assert.equal(node.src, 'acg-image://preview/picture?size=8192');
  assert.match(h.get('#viewer-position').textContent, /2 \/ 3.*SDR 静态预览.*8192 × 4096/);
  node.onload();
  assert.equal(node.hidden, false);
  assert.equal(h.get('#viewer-loading').hidden, true);
  node.onerror();
  await nextTurn();
  assert.equal(h.calls.length, 1, 'a broken preview must not request itself again');
  assert.equal(h.get('#viewer-loading').hidden, false);
  assert.match(h.get('#viewer-loading').textContent, /预览图片读取失败.*系统打开/);
});

test('a preview API failure keeps its actual reason visible with a recovery action', async () => {
  const h = harness(async () => {
    throw new Error('TIFF 解码失败：文件尾部损坏');
  });
  await h.display(image());
  h.get('#viewer-image').onerror();
  await nextTurn();
  assert.deepEqual(h.calls, [
    { command: 'prepareImagePreview', args: { id: 'picture', size: 8192 } }
  ]);
  assert.equal(h.get('#viewer-loading').hidden, false);
  assert.match(h.get('#viewer-loading').textContent, /TIFF 解码失败：文件尾部损坏.*系统打开/);
});

for (const transition of ['next image', 'next video', 'close button']) {
  for (const outcome of ['success', 'rejection']) {
    test(`a pending image preview ${outcome} cannot overwrite the viewer after ${transition}`, async () => {
      const preview = deferred();
      const h = harness(() => preview.promise);
      await h.display(image());
      const oldError = h.get('#viewer-image').onerror;
      const oldLoad = h.get('#viewer-image').onload;
      oldError();
      assert.equal(h.calls.length, 1);
      await leaveViewer(h, transition);
      const expected = viewState(h);
      oldError();
      oldLoad();
      if (outcome === 'success') preview.resolve({ width: 8000, height: 4000 });
      else preview.reject(new Error('旧预览失败，不应显示'));
      await nextTurn();
      assert.deepEqual(viewState(h), expected);
      assert.equal(h.calls.length, 1);
      if (transition === 'close button') {
        assert.equal(h.get('#viewer-image').onerror, null);
        assert.equal(h.get('#viewer-image').onload, null);
        assert.equal(h.get('#viewer-image').src, '');
      }
    });
  }
}

for (const code of [3, 4]) {
  test(`video error code ${code} hands off exactly once, including repeated callbacks and timeout`, async () => {
    const shell = deferred();
    const h = harness(() => shell.promise);
    await h.display(video());
    const player = h.get('#viewer-video');
    const timer = onlyVideoTimer(h);
    const oldError = player.onerror;
    assert.equal(player.src, 'acg-image://original/clip');
    player.error = { code };
    oldError();
    oldError();
    timer.callback();
    assertHandOff(h);
    assert.equal(h.timers.size, 0);
    assert.equal(h.cleared.has(timer.id), true);
    assert.equal(player.onerror, null);
    assert.equal(player.onloadeddata, null);
    assert.equal(player.hidden, true);
    assert.equal(player.src, '');
    assert.ok(player.pauseCalls >= 2);
    assert.match(h.get('#viewer-loading').textContent, /正在交给系统默认播放器/);
    shell.resolve();
    await nextTurn();
    assertHandOff(h);
    assert.equal(h.get('#viewer-loading').hidden, false);
    assert.match(h.get('#viewer-loading').textContent, /已交给系统默认播放器/);
    assert.match(h.get('#viewer-position').textContent, /系统默认播放器/);
  });
}

test('normal loadeddata reveals playback and clears the 10000ms timer without shell handoff', async () => {
  const h = harness();
  await h.display(video());
  const timer = onlyVideoTimer(h);
  h.get('#viewer-video').onloadeddata();
  await nextTurn();
  assert.equal(h.get('#viewer-loading').hidden, true);
  assert.equal(h.get('#viewer-video').hidden, false);
  assert.equal(h.timers.size, 0);
  assert.equal(h.cleared.has(timer.id), true);
  assert.deepEqual(h.calls, []);
});

test('video error code 1 abort does not request the system player', async () => {
  const h = harness();
  await h.display(video());
  const player = h.get('#viewer-video');
  player.error = { code: 1 };
  player.onerror();
  await nextTurn();
  assert.deepEqual(h.calls, []);
  assert.equal(player.hidden, false);
  assert.equal(player.src, 'acg-image://original/clip');
  player.onloadeddata();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.calls, []);
});

test('a video that never loads hands off when its actual 10000ms timer expires', async () => {
  const h = harness();
  await h.display(video());
  assert.deepEqual(h.calls, []);
  h.fire(onlyVideoTimer(h));
  await nextTurn();
  assertHandOff(h);
  assert.equal(h.timers.size, 0);
  assert.match(h.get('#viewer-loading').textContent, /已交给系统默认播放器/);
});

for (const transition of ['next image', 'next video', 'close button', 'native close']) {
  test(`video cleanup after ${transition} cancels the timer and makes old callbacks harmless`, async () => {
    const h = harness();
    await h.display(video());
    const player = h.get('#viewer-video');
    const timer = onlyVideoTimer(h);
    const oldError = player.onerror;
    const oldLoad = player.onloadeddata;
    await leaveViewer(h, transition);
    assert.equal(h.timers.has(timer.id), false);
    assert.equal(h.cleared.has(timer.id), true);
    const expected = viewState(h);
    const pendingTimers = [...h.timers.keys()];
    player.error = { code: 4 };
    oldError();
    oldLoad();
    timer.callback();
    await nextTurn();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(viewState(h), expected);
    assert.deepEqual([...h.timers.keys()], pendingTimers);
    if (transition === 'next video') onlyVideoTimer(h);
    else {
      assert.equal(h.timers.size, 0);
      assert.equal(player.onerror, null);
      assert.equal(player.onloadeddata, null);
      assert.equal(player.src, '');
      assert.equal(player.hidden, true);
    }
  });
}

test('a failed system-player launch leaves the actual shell error visible', async () => {
  const h = harness(async () => {
    throw new Error('没有关联可打开此 MKV 的应用');
  });
  await h.display(video());
  const player = h.get('#viewer-video');
  player.error = { code: 4 };
  player.onerror();
  await nextTurn();
  assertHandOff(h);
  assert.equal(h.get('#viewer-loading').hidden, false);
  assert.match(
    h.get('#viewer-loading').textContent,
    /系统播放器打开失败：没有关联可打开此 MKV 的应用.*重试/
  );
});

for (const transition of ['next image', 'next video', 'close button']) {
  for (const outcome of ['success', 'rejection']) {
    test(`an in-flight shell ${outcome} cannot overwrite the viewer after ${transition}`, async () => {
      const shell = deferred();
      const h = harness(() => shell.promise);
      await h.display(video());
      const player = h.get('#viewer-video');
      player.error = { code: 3 };
      player.onerror();
      assertHandOff(h);
      await leaveViewer(h, transition);
      const expected = viewState(h);
      if (outcome === 'success') shell.resolve();
      else shell.reject(new Error('旧系统播放器失败，不应显示'));
      await nextTurn();
      assertHandOff(h);
      assert.deepEqual(viewState(h), expected);
    });
  }
}
