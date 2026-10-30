'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');

// Pure CSS contract tests: use the real HTML load order and parser, with small
// element fixtures. This checks selector specificity, inheritance and source
// order; it deliberately makes no claim about browser layout or rasterization.
const ui = path.resolve(__dirname, '../src/ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const sheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(([, name]) => ({
  name,
  tree: parsers.css.parse(fs.readFileSync(path.join(ui, name), 'utf8'))
}));
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const add = (a, b) => a.map((n, i) => n + b[i]);
function specificity(nodes) {
  return nodes.reduce(
    (sum, node) => {
      if (node.type === 'selector-id') return add(sum, [1, 0, 0]);
      if (['selector-class', 'selector-attribute'].includes(node.type)) return add(sum, [0, 1, 0]);
      if (node.type === 'selector-tag' || node.value?.startsWith('::')) return add(sum, [0, 0, 1]);
      if (node.type !== 'selector-pseudo' || node.value === ':where') return sum;
      if ([':is', ':not', ':has'].includes(node.value)) {
        const largest = node.nodes
          .map((n) => specificity(n.nodes))
          .sort(compare)
          .at(-1);
        return add(sum, largest || [0, 0, 0]);
      }
      return add(sum, [0, 1, 0]);
    },
    [0, 0, 0]
  );
}
function element(tag, parent = null, attributes = {}, states = []) {
  return { tag, parent, attributes, states: new Set(states) };
}
function fixture(theme = 'light') {
  const root = element('html', null, { 'data-theme': theme, 'data-liquid-glass': 'on' });
  const body = element('body', root);
  return { root, body };
}
function simpleMatch(node, el, pseudo) {
  if (node.type === 'selector-universal') return true;
  if (node.type === 'selector-tag') return el.tag === node.value;
  if (node.type === 'selector-id') return el.attributes.id === node.value;
  if (node.type === 'selector-class')
    return (el.attributes.class || '').split(/\s+/).includes(node.value);
  if (node.type === 'selector-attribute') {
    const value = el.attributes[node.attribute],
      expected = node.raws?.unquoted ?? node.value;
    if (!node.operator) return value !== undefined;
    if (node.operator === '=') return value === expected;
    if (node.operator === '^=') return value?.startsWith(expected);
    if (node.operator === '$=') return value?.endsWith(expected);
    if (node.operator === '*=') return value?.includes(expected);
    return false;
  }
  if (node.type !== 'selector-pseudo') return false;
  if (node.value.startsWith('::')) return node.value === pseudo;
  if (node.value === ':root') return !el.parent;
  if ([':is', ':where', ':not'].includes(node.value)) {
    const any = node.nodes.some((n) => matches(n.nodes, el, pseudo));
    return node.value === ':not' ? !any : any;
  }
  if (node.value === ':enabled') return el.attributes.disabled === undefined;
  if (node.value === ':disabled') return el.attributes.disabled !== undefined;
  // Unsupported structural/interaction states are absent from these fixtures.
  return el.states.has(node.value.slice(1));
}
function matches(nodes, el, pseudo = '') {
  if (!el) return false;
  const split = nodes.findLastIndex((node) => node.type === 'selector-combinator');
  const compound = nodes.slice(split + 1);
  if (!compound.every((node) => simpleMatch(node, el, pseudo))) return false;
  if (split < 0) return true;
  const left = nodes.slice(0, split);
  if (nodes[split].value.trim() === '>') return matches(left, el.parent);
  if (nodes[split].value.trim()) return false; // Siblings are not used by the fixtures.
  for (let ancestor = el.parent; ancestor; ancestor = ancestor.parent) {
    if (matches(left, ancestor)) return true;
  }
  return false;
}
function rules(forcedColors) {
  const result = [];
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === 'css-rule') result.push(node);
      else if (node.type === 'css-atrule' && node.nodes) {
        // Other media queries do not alter the properties covered here. Keep
        // forced-colors explicit so accessibility behavior cannot pass by luck.
        if (node.name === 'media' && node.raws.params === '(forced-colors: active)' && forcedColors)
          visit(node.nodes);
      }
    }
  }
  for (const sheet of sheets) visit(sheet.tree.nodes);
  return result;
}
function style(el, { pseudo = '', forcedColors = false } = {}) {
  const winners = new Map();
  let order = 0;
  for (const rule of rules(forcedColors)) {
    const candidates = rule.selector.nodes.filter((selector) => {
      const hasPseudo = selector.nodes.some((node) => node.value?.startsWith('::'));
      return hasPseudo === Boolean(pseudo) && matches(selector.nodes, el, pseudo);
    });
    if (!candidates.length) continue;
    const spec = candidates
      .map((n) => specificity(n.nodes))
      .sort(compare)
      .at(-1);
    for (const decl of rule.nodes.filter((n) => n.type === 'css-decl')) {
      const value = decl.value.text;
      const properties = decl.prop === 'overflow' ? ['overflow-x', 'overflow-y'] : [decl.prop];
      for (const property of properties) {
        const rank = [Number(Boolean(decl.important)), ...spec, order++];
        const previous = winners.get(property);
        const difference = previous && rank.map((n, i) => n - previous.rank[i]).find((n) => n);
        if (!previous || difference > 0) winners.set(property, { rank, value });
      }
    }
  }
  return {
    raw: (property) => winners.get(property)?.value,
    value(property) {
      const own = winners.get(property)?.value;
      if (own !== undefined && own !== 'inherit') return resolve(own);
      if (pseudo) return style(el, { forcedColors }).value(property);
      if (el.parent) return style(el.parent, { forcedColors }).value(property);
      return undefined;
    }
  };
  function resolve(value) {
    // Resolve innermost vars first, including the editor/viewer accent fallback.
    const resolved = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name, fallback) => {
      let ancestor = el;
      while (ancestor) {
        const token = style(ancestor, { forcedColors }).raw(name);
        if (token !== undefined) return resolve(token);
        ancestor = ancestor.parent;
      }
      return fallback || `var(${name})`;
    });
    return resolved === value ? resolved : resolve(resolved);
  }
}
function focusIsContained(el, label) {
  const css = style(el);
  const outline = css.raw('outline');
  assert.match(outline, /^2px solid /, `${label}: visible two-pixel keyboard ring`);
  assert.ok(
    parseFloat(css.raw('outline-offset')) + parseFloat(outline) <= 0,
    `${label}: no part of the outline extends beyond the border box`
  );
}

test('every glass shell avoids an empty gutter, including generic/about/font/viewer dialogs', () => {
  const { body } = fixture();
  for (const className of [
    'modal',
    'modal settings-dialog',
    'modal binding-modal',
    'modal local-search-dialog',
    'modal album-info-dialog',
    'modal display-dialog',
    'modal font-picker',
    'modal viewer',
    'context-menu',
    'album-select-list',
    'sidebar-shell',
    'toolbar-right',
    'progress-panel',
    'toast',
    'back-to-top'
  ]) {
    assert.equal(
      style(element('div', body, { class: className })).raw('scrollbar-gutter'),
      'auto',
      className
    );
  }
  const topbar = element('header', body, { class: 'topbar' });
  assert.equal(style(element('div', topbar, { class: 'glass' })).raw('scrollbar-gutter'), 'auto');
});

test('real nested scroll owners retain stable gutters and scrolling; shell overflow stays intentional', () => {
  const { body } = fixture();
  const cases = [
    ['settings-dialog', 'settings-panel', '', 'auto'],
    ['binding-modal', 'binding-scroll', '', 'auto'],
    ['local-search-dialog', 'local-search-scroll', '', 'auto'],
    ['font-picker', '', 'font-options', 'auto']
  ];
  for (const [shell, className, id, overflow] of cases) {
    const modal = element('dialog', body, { class: `modal ${shell}`, open: '' });
    const scroll = element('div', modal, { class: className, id });
    assert.equal(style(scroll).raw('scrollbar-gutter'), 'stable', shell);
    assert.equal(style(scroll).raw('overflow-y'), overflow, shell);
    if (shell !== 'font-picker') assert.equal(style(modal).raw('overflow-y'), 'hidden', shell);
  }
  for (const attributes of [{ id: 'viewport' }, { class: 'category-nav' }]) {
    assert.equal(style(element('div', body, attributes)).raw('scrollbar-gutter'), 'stable');
  }
  for (const className of [
    'modal',
    'modal album-info-dialog',
    'modal display-dialog',
    'context-menu',
    'album-select-list'
  ]) {
    assert.equal(
      style(element('div', body, { class: className })).raw('overflow-y'),
      'auto',
      className
    );
  }
  const viewer = element('dialog', body, { id: 'viewer', class: 'modal viewer' });
  assert.equal(style(viewer).raw('overflow-y'), 'hidden');
  assert.equal(style(element('div', viewer, { class: 'viewer-stage' })).raw('overflow-y'), 'auto');
});

test('modal, nested, context and select scrollbars have transparent tracks and draggable visible thumbs', () => {
  for (const theme of ['light', 'dark']) {
    const { body } = fixture(theme);
    const modal = element('dialog', body, { class: 'modal' });
    for (const scroll of [
      modal,
      element('div', modal, { class: 'binding-scroll' }),
      element('div', body, { class: 'context-menu' }),
      element('div', body, { class: 'album-select-list' })
    ]) {
      assert.equal(style(scroll).raw('scrollbar-width'), 'thin');
      assert.match(style(scroll).value('scrollbar-color'), /^#[\da-f]{6} transparent$/);
      assert.equal(
        style(scroll, { pseudo: '::-webkit-scrollbar-track' }).value('background'),
        'transparent'
      );
      assert.match(
        style(scroll, { pseudo: '::-webkit-scrollbar-thumb' }).value('background'),
        /^#[\da-f]{6}$/
      );
      assert.equal(style(scroll, { pseudo: '::-webkit-scrollbar' }).raw('width'), '6px');
    }
  }
});

test('subject URL, settings/search inputs and textarea rings remain inside clipped scroll edges', () => {
  const { body } = fixture();
  const modal = element('dialog', body, { class: 'modal binding-modal' });
  const scroll = element('div', modal, { class: 'binding-scroll' });
  const fields = [
    element('input', scroll, { id: 'subject-url', class: 'field-input' }, ['focus-visible']),
    element('input', scroll, { type: 'search', class: 'field-input' }, ['focus-visible']),
    element('input', scroll, { type: 'checkbox', class: 'switch' }, ['focus-visible']),
    element('input', scroll, { type: 'range' }, ['focus-visible']),
    element('textarea', scroll, { class: 'field-input' }, ['focus-visible']),
    element('select', scroll, {}, ['focus-visible']),
    element('button', scroll, { class: 'album-select-button' }, ['focus-visible'])
  ];
  for (const field of fields) focusIsContained(field, field.attributes.id || field.tag);
  const topbar = element('header', body, { class: 'topbar' });
  const search = element('div', topbar, { class: 'search-wrap glass' }, ['focus-within']);
  const input = element('input', search, { id: 'search', type: 'search' }, ['focus-visible']);
  assert.equal(style(search).raw('outline-offset'), '-2px');
  assert.match(style(search).raw('outline'), /^2px solid /);
  assert.equal(style(input).raw('outline'), 'none', 'search uses one complete wrapper ring');
});

test('keyboard rings cover popup options, modal controls and ID-specific editor/viewer rules', () => {
  const { body } = fixture();
  for (const className of [
    'modal',
    'context-menu',
    'album-select-list',
    'progress-panel',
    'toolbar-right'
  ]) {
    const host = element('div', body, { class: className });
    for (const [tag, attrs] of [
      ['button', {}],
      ['a', { href: '#' }],
      ['summary', {}],
      ['div', { tabindex: '0' }]
    ]) {
      focusIsContained(element(tag, host, attrs, ['focus-visible']), `${className} ${tag}`);
    }
  }
  for (const id of ['media-editor', 'viewer']) {
    const modal = element('dialog', body, { id, class: 'modal' });
    focusIsContained(element('button', modal, {}, ['focus-visible']), id);
    if (id === 'media-editor') focusIsContained(element('input', modal, {}, ['focus-visible']), id);
  }
});

test('placeholder token wins for URL/top search/editor, while values and help keep their ink', () => {
  for (const theme of ['light', 'dark']) {
    const { root, body } = fixture(theme);
    const modal = element('dialog', body, { class: 'modal' });
    const help = element('p', modal, { class: 'field-help' });
    const editor = element('dialog', body, { id: 'media-editor', class: 'modal' });
    const fields = [
      element('input', modal, { id: 'subject-url', class: 'field-input' }),
      element('input', body, { id: 'search', type: 'search' }),
      element('input', editor, { class: 'me-input' }),
      element('textarea', modal)
    ];
    const placeholder = style(root).raw('--placeholder');
    assert.notEqual(placeholder, style(root).raw('--muted'));
    for (const field of fields) {
      assert.equal(style(field, { pseudo: '::placeholder' }).value('color'), placeholder);
      assert.equal(style(field, { pseudo: '::placeholder' }).raw('opacity'), '1');
      assert.notEqual(
        style(field).value('color'),
        placeholder,
        'typed text does not use placeholder ink'
      );
    }
    assert.equal(style(help).value('color'), style(root).raw('--muted'));
  }
});

test('forced-colors restores system scrollbars and a visible system focus color', () => {
  const { root, body } = fixture();
  assert.equal(style(root, { forcedColors: true }).raw('--control-focus-color'), 'Highlight');
  for (const className of ['modal', 'context-menu', 'album-select-list']) {
    const host = element('div', body, { class: className });
    assert.equal(style(host, { forcedColors: true }).raw('scrollbar-color'), 'auto', className);
  }
  for (const id of ['', 'media-editor', 'viewer']) {
    const modal = element('dialog', body, { id, class: 'modal' });
    const button = element('button', modal, {}, ['focus-visible']);
    assert.match(style(button, { forcedColors: true }).value('outline'), /Highlight/);
  }
});
