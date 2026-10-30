'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');

// Read real styles in HTML order. These are cascade/contrast contracts, not a
// browser: no layout, screenshot, platform scrollbar or rasterization claims.
const ui = path.resolve(__dirname, '../src/ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const sheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(([, name]) => ({
  name,
  tree: parsers.css.parse(fs.readFileSync(path.join(ui, name), 'utf8'))
}));
const compare = (a, b) => a.map((n, i) => n - b[i]).find((n) => n) || 0;
const add = (a, b) => a.map((n, i) => n + b[i]);
function specificity(nodes) {
  return nodes.reduce(
    (sum, n) => {
      if (n.type === 'selector-id') return add(sum, [1, 0, 0]);
      if (['selector-class', 'selector-attribute'].includes(n.type)) return add(sum, [0, 1, 0]);
      if (n.type === 'selector-tag' || n.value?.startsWith('::')) return add(sum, [0, 0, 1]);
      if (n.type !== 'selector-pseudo' || n.value === ':where') return sum;
      if ([':is', ':not', ':has'].includes(n.value)) {
        return add(
          sum,
          n.nodes
            .map((v) => specificity(v.nodes))
            .sort(compare)
            .at(-1) || [0, 0, 0]
        );
      }
      return add(sum, [0, 1, 0]);
    },
    [0, 0, 0]
  );
}
function element(tag, parent = null, attributes = {}, states = []) {
  return { tag, parent, attributes, states: new Set(states) };
}
function fixture(theme) {
  const root = element('html', null, { 'data-theme': theme, 'data-liquid-glass': 'on' });
  return { root, body: element('body', root) };
}
function simple(n, el, pseudo) {
  if (n.type === 'selector-universal') return true;
  if (n.type === 'selector-tag') return el.tag === n.value;
  if (n.type === 'selector-id') return el.attributes.id === n.value;
  if (n.type === 'selector-class')
    return (el.attributes.class || '').split(/\s+/).includes(n.value);
  if (n.type === 'selector-attribute') {
    const value = el.attributes[n.attribute];
    const expected = n.raws?.unquoted ?? n.value;
    if (!n.operator) return value !== undefined;
    if (n.operator === '=') return value === expected;
    if (n.operator === '^=') return value?.startsWith(expected);
    if (n.operator === '$=') return value?.endsWith(expected);
    if (n.operator === '*=') return value?.includes(expected);
    return false;
  }
  if (n.type !== 'selector-pseudo') return false;
  if (n.value.startsWith('::')) return n.value === pseudo;
  if (n.value === ':root') return !el.parent;
  if ([':is', ':where', ':not'].includes(n.value)) {
    const any = n.nodes.some((s) => matches(s.nodes, el, pseudo));
    return n.value === ':not' ? !any : any;
  }
  if (n.value === ':enabled') return el.attributes.disabled === undefined;
  if (n.value === ':disabled') return el.attributes.disabled !== undefined;
  return el.states.has(n.value.slice(1));
}
function matches(nodes, el, pseudo = '') {
  if (!el) return false;
  const split = nodes.findLastIndex((n) => n.type === 'selector-combinator');
  if (!nodes.slice(split + 1).every((n) => simple(n, el, pseudo))) return false;
  if (split < 0) return true;
  const left = nodes.slice(0, split);
  if (nodes[split].value.trim() === '>') return matches(left, el.parent);
  if (nodes[split].value.trim()) return false;
  for (let p = el.parent; p; p = p.parent) if (matches(left, p)) return true;
  return false;
}
function collect(nodes, env, result = []) {
  for (const n of nodes) {
    if (n.type === 'css-rule') result.push(n);
    else if (n.type === 'css-atrule' && n.nodes) {
      if (n.name === 'supports' && n.raws.params === 'selector(::-webkit-scrollbar)' && env.webkit)
        collect(n.nodes, env, result);
      if (n.name === 'media' && n.raws.params === '(forced-colors: active)' && env.forcedColors)
        collect(n.nodes, env, result);
    }
  }
  return result;
}
function style(el, env = {}, pseudo = '') {
  const winners = new Map();
  let order = 0;
  for (const sheet of sheets)
    for (const rule of collect(sheet.tree.nodes, env)) {
      const candidates = rule.selector.nodes.filter(
        (s) =>
          s.nodes.some((n) => n.value?.startsWith('::')) === Boolean(pseudo) &&
          matches(s.nodes, el, pseudo)
      );
      if (!candidates.length) continue;
      const spec = candidates
        .map((s) => specificity(s.nodes))
        .sort(compare)
        .at(-1);
      for (const d of rule.nodes.filter((n) => n.type === 'css-decl')) {
        const rank = [Number(Boolean(d.important)), ...spec, order++];
        if (!winners.has(d.prop) || compare(rank, winners.get(d.prop).rank) > 0)
          winners.set(d.prop, { rank, value: d.value.text });
      }
    }
  const raw = (p) => winners.get(p)?.value;
  function value(p) {
    const own = raw(p);
    if (own === undefined || own === 'inherit' || own === 'currentColor')
      return pseudo ? style(el, env).value(p) : el.parent && style(el.parent, env).value(p);
    return resolve(own);
  }
  function resolve(text) {
    const next = text.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, token, fallback) => {
      for (let p = el; p; p = p.parent) {
        const found = style(p, env).raw(token);
        if (found !== undefined) return resolve(found);
      }
      return fallback || `var(${token})`;
    });
    return next === text ? next : resolve(next);
  }
  return { raw, value };
}
function luminance(hex) {
  const channels = hex
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return channels.reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [dark, light] = [luminance(a), luminance(b)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
}

for (const theme of ['light', 'dark']) {
  test(`${theme}: text is stronger than icons and placeholders in actual floating controls`, () => {
    const { root, body } = fixture(theme);
    const tokens = style(root);
    const bg = theme === 'light' ? '#ffffff' : '#181821';
    const iconContrast = contrast(tokens.raw('--floating-icon'), bg);
    for (const name of ['--text', '--soft', '--muted']) {
      assert.ok(contrast(tokens.raw(name), bg) > iconContrast, `${name} is stronger than icons`);
      assert.ok(contrast(tokens.raw(name), bg) >= 7, `${name} retains high text contrast`);
    }
    assert.ok(iconContrast >= 4.5, 'neutral icon ink remains readable');
    for (const hostClass of [
      'topbar',
      'sidebar-shell',
      'toolbar-right',
      'progress-panel',
      'modal',
      'context-menu',
      'album-select-list'
    ]) {
      const host = element('div', body, { class: hostClass });
      const control = element('button', host, { class: 'subtle-button' });
      assert.equal(
        style(element('svg', control)).value('color'),
        tokens.raw('--floating-icon'),
        hostClass
      );
    }
    const topbar = element('header', body, { class: 'topbar' });
    const search = element('div', topbar, { class: 'search-wrap' });
    const profile = element('button', topbar, { class: 'profile-button' });
    const select = element('button', topbar, { class: 'album-select-button' });
    for (const parent of [search, profile, select])
      assert.equal(style(element('svg', parent)).value('color'), tokens.raw('--floating-icon'));

    const modal = element('dialog', body, { class: 'modal binding-modal' });
    for (const field of [
      element('input', search, { id: 'search', type: 'search' }),
      element('input', modal, { id: 'subject-url', class: 'field-input' }),
      element('input', modal, { id: 'character-url', class: 'field-input' }),
      element('textarea', modal, { class: 'field-input' })
    ]) {
      const placeholder = style(field, {}, '::placeholder').value('color');
      assert.equal(placeholder, theme === 'light' ? '#726f79' : '#9893a0');
      assert.ok(contrast(style(field).value('color'), bg) > contrast(placeholder, bg));
    }
  });

  test(`${theme}: semantic icons follow selected, danger, primary, link and fixed viewer ink`, () => {
    const { body } = fixture(theme);
    const modal = element('dialog', body, { class: 'modal' });
    const menu = element('div', body, { class: 'context-menu' });
    const select = element('div', body, { class: 'album-select-list' });
    const sidebar = element('aside', body, { class: 'sidebar-shell' });
    const cases = [
      element('button', modal, { class: 'primary' }),
      element('button', modal, { class: 'text-button danger' }),
      element('button', sidebar, { class: 'import-button' }),
      element('button', sidebar, { class: 'nav-item active' }),
      element('button', select, { class: 'album-select-option selected', 'aria-selected': 'true' }),
      element('button', select, { class: 'album-select-option is-active' }),
      element('button', menu, { class: 'danger' }),
      element('span', menu, { class: 'menu-check' }),
      element('a', modal, { class: 'about-inline-link', href: '#' }),
      element('span', modal, { class: 'updates-symbol' })
    ];
    for (const parent of cases) {
      const expected = style(parent).value('color');
      assert.ok(expected, parent.attributes.class);
      assert.equal(style(element('svg', parent)).value('color'), expected, parent.attributes.class);
    }
    const viewer = element('dialog', body, { id: 'viewer', class: 'modal viewer' });
    const arrow = element('button', viewer, { class: 'viewer-arrow' });
    assert.equal(
      style(element('svg', arrow)).value('color'),
      theme === 'light' ? '#202020' : '#f0f0f0'
    );
    const qr = element('div', modal, { class: 'about-qr-card' });
    assert.equal(style(element('span', qr)).value('color'), '#454251');
    const importButton = element('button', sidebar, { class: 'import-button' });
    const importGlyph = element('span', importButton, {}, ['first-child']);
    assert.equal(
      style(element('svg', importGlyph)).value('color'),
      style(body).value('--on-accent')
    );
    const editor = element('dialog', body, { id: 'media-editor', class: 'modal' });
    const exportButton = element('button', editor, { class: 'me-primary' });
    assert.equal(
      style(element('svg', exportButton)).value('color'),
      style(exportButton).value('color')
    );
    const card = element('div', body, { class: 'card-bottom-overlay' });
    assert.equal(style(element('svg', card)).value('color'), 'white');
  });
}

test('popup scrollbars have four painted pink pixels without a new glass gutter in either engine branch', () => {
  for (const theme of ['light', 'dark'])
    for (const webkit of [false, true]) {
      const { body } = fixture(theme);
      const modal = element('dialog', body, { class: 'modal' });
      for (const el of [
        modal,
        element('div', modal, { class: 'binding-scroll' }),
        element('div', body, { class: 'context-menu' }),
        element('div', body, { class: 'album-select-list' })
      ]) {
        const env = { webkit };
        const base = style(el, env);
        const bar = style(el, env, '::-webkit-scrollbar');
        const thumb = style(el, env, '::-webkit-scrollbar-thumb');
        assert.equal(base.raw('scrollbar-width'), webkit ? 'auto' : 'thin');
        assert.equal(
          webkit ? base.raw('scrollbar-color') : base.value('scrollbar-color'),
          webkit ? 'auto' : `${theme === 'light' ? '#c982a6' : '#b879a0'} transparent`
        );
        assert.equal(parseFloat(bar.raw('width')) - 2 * parseFloat(thumb.raw('border')), 4);
        assert.ok(parseFloat(bar.raw('width')) <= 6, 'smaller visible and reserved scrollbar');
        assert.equal(thumb.raw('background-clip'), 'padding-box');
        assert.equal(
          style(el, env, '::-webkit-scrollbar-track').value('background'),
          'transparent'
        );
        assert.equal(
          style(el, env, '::-webkit-scrollbar-corner').value('background'),
          'transparent'
        );
        const [r, g, b] = thumb
          .value('background')
          .slice(1)
          .match(/../g)
          .map((v) => parseInt(v, 16));
        assert.ok(r > b && b > g, 'pink thumb rather than a grey or purple track');
        assert.equal(style(el, { ...env, forcedColors: true }).raw('scrollbar-color'), 'auto');
      }
      assert.equal(style(modal).raw('scrollbar-gutter'), 'auto');
      assert.equal(
        style(element('div', modal, { class: 'binding-scroll' })).raw('scrollbar-gutter'),
        'stable'
      );
    }
});

test('readability icon selectors only change color, never SVG shape or dimensions', () => {
  const sheet = sheets.find((s) => s.name === 'readability.css');
  for (const rule of collect(sheet.tree.nodes, {})) {
    if (
      !rule.selector.nodes.some(
        (s) =>
          JSON.stringify(s.nodes).includes('selector-tag') &&
          JSON.stringify(s.nodes).includes('svg')
      )
    )
      continue;
    assert.deepEqual(
      rule.nodes.filter((n) => n.type === 'css-decl').map((d) => d.prop),
      ['color']
    );
  }
});
