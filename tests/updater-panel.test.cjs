'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
// Exercise the real panel controller with a small DOM adapter, without launching
// Electron or an installer. Existing dialog tests cover mount/focus/lifetime.
function harness({ edition = 'full', assets, failure = false } = {}) {
  const calls = [],
    listeners = [],
    nodes = new Map();
  const signal = new AbortController().signal;
  function node(selector) {
    if (nodes.has(selector)) return nodes.get(selector);
    const children = new Map();
    const value = {
      value: '',
      disabled: false,
      textContent: '',
      listeners: {},
      addEventListener: (type, handler) => {
        value.listeners[type] = handler;
      },
      setAttribute() {},
      removeAttribute() {},
      focus() {},
      replaceChildren() {
        value.innerHTML = '';
      },
      querySelector(key) {
        if (!children.has(key)) children.set(key, node(selector + ' ' + key));
        return children.get(key);
      }
    };
    let html = '';
    Object.defineProperty(value, 'innerHTML', {
      get: () => html,
      set(next) {
        html = next;
        if (selector === '[data-update-assets]' && next) {
          const select = value.querySelector('select');
          const selected = /<option value="([^"]+)" selected/.exec(next);
          select.value = selected?.[1] || 'standard';
        }
      }
    });
    Object.defineProperty(value, 'selectedIndex', {
      set(index) {
        if (index === -1) value.value = '';
      }
    });
    nodes.set(selector, value);
    return value;
  }
  const context = { find: node, signal, alive: () => true, dialog: { querySelector: () => null } };
  const repo = 'custom-owner/custom-repo';
  const latest = {
    status: 'available',
    repository: repo,
    latestVersion: '2.0.0',
    url: `https://github.com/${repo}/releases/tag/v2.0.0`,
    assets:
      assets ||
      ['standard', 'lite', 'full'].map((edition) => ({ edition, size: 12345, verifiable: true }))
  };
  const api = async (method, args) => {
    calls.push([method, args]);
    if (method === 'appInfo') return { version: '1.1.1', repository: repo };
    if (method === 'updateInfo')
      return {
        currentEdition: edition,
        canInstall: true,
        installationDirectory: 'C:\\Program Files\\相册',
        dataDirectory: 'D:\\Library',
        userDataDirectory: 'D:\\Profile'
      };
    if (method === 'updateStatus') return { phase: 'idle' };
    if (method === 'checkUpdate') {
      if (failure) throw new Error('offline');
      return latest;
    }
    if (method === 'downloadUpdate') {
      for (const handler of listeners)
        handler({
          type: 'update',
          data: { phase: 'ready', repository: repo, version: '2.0.0', edition: args.edition }
        });
    }
  };
  const window = {
    album: {
      onEvent: (handler) => {
        listeners.push(handler);
        return () => {};
      }
    },
    addEventListener() {}
  };
  const filename = path.resolve(__dirname, '../src/ui/about.js');
  const source = fs
    .readFileSync(filename, 'utf8')
    .replace(
      /function mount\(title, html, width = 760\) \{[\s\S]*?\n  function renderCredits/,
      'function mount() { return testContext; }\n  function renderCredits'
    );
  vm.runInNewContext(
    source,
    {
      window,
      URL,
      testContext: context,
      document: { activeElement: {} },
      esc: (value) =>
        String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
      svg: () => '',
      api,
      saveSetting: async (...args) => calls.push(['saveSetting', args])
    },
    { filename }
  );
  const click = async (selector, action) =>
    node(selector).listeners.click({
      target: { closest: (target) => (target === action ? {} : null) }
    });
  return { window, calls, node, click };
}

test('opening updates auto-checks custom repository, defaults to current edition, and never downloads or installs', async () => {
  const h = harness();
  await h.window.showUpdates();
  assert.equal(h.calls.filter(([method]) => method === 'checkUpdate').length, 1);
  assert.equal(
    h.calls.some(([method]) => ['saveSetting', 'downloadUpdate', 'installUpdate'].includes(method)),
    false
  );
  assert.equal(h.node('[data-update-assets]').querySelector('select').value, 'full');
  assert.match(h.node('[data-update-assets]').innerHTML, /Standard/);
  assert.match(h.node('[data-update-assets]').innerHTML, /Lite/);
  assert.match(h.node('[data-update-assets]').innerHTML, /Full/);
  assert.match(h.node('[data-update-assets]').innerHTML, /自定义来源 custom-owner\/custom-repo/);
  await h.click('[data-update-assets]', '[data-update-download]');
  assert.equal(h.calls.find(([method]) => method === 'downloadUpdate')[1].edition, 'full');
  assert.equal(
    h.calls.some(([method]) => method === 'installUpdate'),
    false
  );
  assert.match(h.node('[data-update-transfer]').innerHTML, /保留资料/);
  assert.match(h.node('[data-update-transfer]').innerHTML, /退出并安装 Full 2.0.0/);
  await h.click('[data-update-transfer]', '[data-update-install]');
  assert.equal(h.calls.find(([method]) => method === 'installUpdate')[1].confirm, true);
});

test('missing current edition cannot silently pick another installer and missing verification disables download', async () => {
  const h = harness({
    assets: [
      { edition: 'standard', size: 123, verifiable: true },
      { edition: 'full', size: 456, verifiable: false }
    ]
  });
  await h.window.showUpdates();
  assert.equal(h.node('[data-update-assets]').querySelector('select').value, '');
  assert.equal(
    h.node('[data-update-assets]').querySelector('[data-update-download]').disabled,
    true
  );
  await h.click('[data-update-assets]', '[data-update-download]');
  assert.equal(
    h.calls.some(([method]) => method === 'downloadUpdate'),
    false
  );
});

test('automatic metadata failure leaves a retryable error and a release-page link', async () => {
  const h = harness({ failure: true });
  await h.window.showUpdates();
  assert.match(h.node('#album-update-error').textContent, /offline/);
  assert.match(h.node('[data-update-result]').innerHTML, /custom-owner\/custom-repo\/releases/);
  assert.equal(h.node('[data-update-check]').disabled, false);
});
