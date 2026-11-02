'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const filename = path.resolve(__dirname, '../src/ui/local-search.js');
const source = fs.readFileSync(filename, 'utf8');

function settingsPanel({ hidden = false } = {}) {
  const children = [];
  let top = 0;
  const panel = {
    hidden,
    clientHeight: 400,
    children,
    writes: [],
    get scrollHeight() {
      return 449 + children.reduce((height, child) => height + child.height, 0);
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(value) {
      panel.writes.push(value);
      top = Math.max(0, Math.min(Number(value), panel.scrollHeight - panel.clientHeight));
    },
    clampAfterLayout() {
      top = Math.min(top, panel.scrollHeight - panel.clientHeight);
    },
    userScrollTo(value) {
      top = Math.max(0, Math.min(value, panel.scrollHeight - panel.clientHeight));
    }
  };
  return panel;
}

function statusElement(panel, height = 40) {
  let text = '正在读取索引状态…',
    nextHeight = height;
  const element = {
    height,
    resizeOnText(value) {
      nextHeight = value;
    },
    closest(selector) {
      assert.equal(selector, '.settings-panel');
      return panel;
    },
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value);
      // Model text reflow and the browser's scroll bounds, without automatic bottom anchoring.
      element.height = nextHeight;
      panel?.clampAfterLayout();
    }
  };
  panel?.children.push(element);
  return element;
}

function load(statuses) {
  const button = { onclick: null },
    window = {};
  const context = vm.createContext({
    window,
    document: {
      querySelector(selector) {
        assert.equal(selector, '#local-search-button');
        return button;
      },
      querySelectorAll(selector) {
        assert.equal(selector, '[data-local-index-status]');
        return statuses;
      }
    },
    api() {
      assert.fail('setStatus must update the existing DOM without an RPC');
    }
  });
  new vm.Script(source, { filename }).runInContext(context);
  assert.equal(typeof window.albumLocalSearch.setStatus, 'function');
  assert.equal(typeof button.onclick, 'function', 'load the entire classic script');
  return window.albumLocalSearch;
}

function fixture({ height = 40, gap = 0, hidden = false, settings = true } = {}) {
  const panel = settings ? settingsPanel({ hidden }) : null,
    status = statusElement(panel, height);
  if (panel) panel.userScrollTo(panel.scrollHeight - panel.clientHeight - gap);
  return { panel, status, search: load([status]) };
}

const unavailable = { available: false },
  available = { available: true, variant: 'full', dataVersion: '2026-11-02' };

function bottomGap(panel) {
  return panel.scrollHeight - panel.clientHeight - panel.scrollTop;
}

test('a status update keeps a visible settings panel at the bottom when its content grows by 61px', () => {
  const h = fixture();
  assert.equal(h.panel.scrollTop, 89);
  assert.equal(bottomGap(h.panel), 0);
  h.status.resizeOnText(101);
  assert.equal(h.search.setStatus(unavailable), unavailable);
  assert.match(h.status.textContent, /未安装本地检索索引/);
  assert.match(h.status.textContent, /资料库补全 \/ 下载/);
  assert.equal(h.panel.scrollHeight, 550);
  assert.equal(h.panel.scrollTop, 150);
  assert.equal(bottomGap(h.panel), 0);
  assert.equal(h.panel.writes.length, 1);
});

test('the existing one-pixel bottom tolerance also follows a growing status', () => {
  for (const gap of [0.5, 1]) {
    const h = fixture({ gap });
    assert.equal(bottomGap(h.panel), gap);
    h.status.resizeOnText(101);
    h.search.setStatus(unavailable);
    assert.equal(bottomGap(h.panel), 0, `preserve bottom attachment at gap ${gap}`);
    assert.equal(h.panel.writes.length, 1);
  }
});

test('a manually scrolled settings panel keeps its position instead of following the new bottom', () => {
  for (const gap of [1.01, 48]) {
    const h = fixture({ gap }),
      before = h.panel.scrollTop;
    h.status.resizeOnText(101);
    h.search.setStatus(available);
    assert.match(h.status.textContent, /完整检索/);
    assert.match(h.status.textContent, /2026-11-02/);
    assert.equal(h.panel.scrollTop, before);
    assert.equal(h.panel.writes.length, 0, `no programmatic scroll at gap ${gap}`);
    assert.ok(bottomGap(h.panel) > 61);
  }
});

test('a hidden settings panel receives the new status without a scroll write even if previously at the bottom', () => {
  const h = fixture({ hidden: true }),
    before = h.panel.scrollTop;
  assert.equal(bottomGap(h.panel), 0);
  h.status.resizeOnText(101);
  h.search.setStatus(unavailable);
  assert.match(h.status.textContent, /未安装本地检索索引/);
  assert.equal(h.panel.scrollTop, before);
  assert.equal(h.panel.writes.length, 0);
});

test('a status outside settings still updates its text and returns the cached status without throwing', () => {
  const h = fixture({ settings: false });
  assert.equal(h.panel, null);
  assert.doesNotThrow(() => assert.equal(h.search.setStatus(available), available));
  assert.match(h.status.textContent, /完整检索/);
  assert.match(h.status.textContent, /2026-11-02/);
  assert.doesNotThrow(() => h.search.setStatus(null));
  assert.match(h.status.textContent, /未安装本地检索索引/);
});

test('equal-height and shrinking status updates keep an attached panel at the bottom', () => {
  const h = fixture({ height: 101 });
  h.status.resizeOnText(101);
  h.search.setStatus(unavailable);
  assert.equal(h.panel.scrollTop, 150);
  assert.equal(bottomGap(h.panel), 0);
  h.status.resizeOnText(40);
  h.search.setStatus(available);
  assert.equal(h.panel.scrollTop, 89);
  assert.equal(bottomGap(h.panel), 0);
  assert.match(h.status.textContent, /完整检索/);
});

test('equal-height and shrinking status updates leave a manual position alone when it remains in range', () => {
  const h = fixture({ height: 101 });
  h.panel.userScrollTo(40);
  h.status.resizeOnText(101);
  h.search.setStatus(unavailable);
  assert.equal(h.panel.scrollTop, 40);
  h.status.resizeOnText(40);
  h.search.setStatus(available);
  assert.equal(h.panel.scrollTop, 40);
  assert.equal(h.panel.writes.length, 0);
});

test('one public update treats each visible, scrolled, hidden and non-settings status independently', () => {
  const pinned = settingsPanel(),
    scrolled = settingsPanel(),
    hidden = settingsPanel({ hidden: true });
  const statuses = [pinned, scrolled, hidden, null].map((panel) => statusElement(panel));
  pinned.userScrollTo(89);
  scrolled.userScrollTo(20);
  hidden.userScrollTo(89);
  const search = load(statuses);
  for (const status of statuses) status.resizeOnText(101);
  search.setStatus(unavailable);
  assert.equal(bottomGap(pinned), 0);
  assert.equal(scrolled.scrollTop, 20);
  assert.equal(scrolled.writes.length, 0);
  assert.equal(hidden.scrollTop, 89);
  assert.equal(hidden.writes.length, 0);
  for (const status of statuses) assert.match(status.textContent, /未安装本地检索索引/);
});
