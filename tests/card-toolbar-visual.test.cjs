'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');

// Test the actual stylesheet order, specificity, media rules and inherited
// tokens without launching Electron. This proves CSS contracts, not rasterized
// glyph alignment; optical alignment still needs the Lead's visual acceptance.
const ui = path.resolve(__dirname, '../src/ui');
const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const sheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(([, name]) =>
  parsers.css.parse(fs.readFileSync(path.join(ui, name), 'utf8'))
);
const compare = (a, b) => a.map((n, i) => n - b[i]).find((n) => n) || 0;
const add = (a, b) => a.map((n, i) => n + b[i]);
function specificity(nodes) {
  return nodes.reduce(
    (sum, node) => {
      if (node.type === 'selector-id') return add(sum, [1, 0, 0]);
      if (['selector-class', 'selector-attribute'].includes(node.type)) return add(sum, [0, 1, 0]);
      if (node.type === 'selector-tag' || node.value?.startsWith('::')) return add(sum, [0, 0, 1]);
      if (node.type !== 'selector-pseudo' || node.value === ':where') return sum;
      if ([':is', ':not', ':has'].includes(node.value))
        return add(
          sum,
          node.nodes
            .map((n) => specificity(n.nodes))
            .sort(compare)
            .at(-1) || [0, 0, 0]
        );
      return add(sum, [0, 1, 0]);
    },
    [0, 0, 0]
  );
}
function element(tag, parent = null, attributes = {}, tokens = {}) {
  return { tag, parent, attributes, tokens };
}
function simpleMatch(node, el) {
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
    return false;
  }
  if (node.type !== 'selector-pseudo') return false;
  if (node.value === ':root') return !el.parent;
  if ([':is', ':where', ':not'].includes(node.value)) {
    const any = node.nodes.some((n) => matches(n.nodes, el));
    return node.value === ':not' ? !any : any;
  }
  if (node.value === ':enabled') return el.attributes.disabled === undefined;
  if (node.value === ':disabled') return el.attributes.disabled !== undefined;
  return false;
}
function matches(nodes, el) {
  if (!el) return false;
  const split = nodes.findLastIndex((node) => node.type === 'selector-combinator');
  if (!nodes.slice(split + 1).every((node) => simpleMatch(node, el))) return false;
  if (split < 0) return true;
  const left = nodes.slice(0, split),
    relation = nodes[split].value.trim();
  if (relation === '>') return matches(left, el.parent);
  if (relation) return false;
  for (let ancestor = el.parent; ancestor; ancestor = ancestor.parent)
    if (matches(left, ancestor)) return true;
  return false;
}
function rules(width) {
  const result = [];
  function visit(nodes) {
    for (const node of nodes) {
      if (node.type === 'css-rule') result.push(node);
      else if (node.type === 'css-atrule' && node.name === 'media' && node.nodes) {
        const query = node.raws.params;
        const bounds = [...query.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
        if (
          bounds.length &&
          bounds.every(([, kind, size]) =>
            kind === 'min' ? width >= Number(size) : width <= Number(size)
          )
        )
          visit(node.nodes);
      }
    }
  }
  sheets.forEach((sheet) => visit(sheet.nodes));
  return result;
}
function lengths(value) {
  const parts = [];
  let depth = 0,
    part = '';
  for (const char of value) {
    if (/\s/.test(char) && depth === 0) {
      if (part) parts.push(part);
      part = '';
    } else part += char;
    if (char === '(') depth++;
    if (char === ')') depth--;
  }
  if (part) parts.push(part);
  return parts;
}
function expanded(prop, value) {
  // Resolve the logical/physical margin competition in the LTR toolbar.
  if (prop === 'margin-inline') {
    const [left, right = left] = lengths(value);
    return [
      ['margin-left', left],
      ['margin-right', right]
    ];
  }
  if (prop === 'padding-block') {
    const [top, bottom = top] = lengths(value);
    return [
      ['padding-top', top],
      ['padding-bottom', bottom]
    ];
  }
  if (prop === 'margin' || prop === 'padding') {
    const [top, right = top, bottom = top, left = right] = lengths(value);
    return [
      [prop, value],
      ...['top', 'right', 'bottom', 'left'].map((side, i) => [
        `${prop}-${side}`,
        [top, right, bottom, left][i]
      ])
    ];
  }
  return [[prop, value]];
}
function cascade(width) {
  const active = rules(width),
    cache = new WeakMap();
  return function style(el) {
    if (cache.has(el)) return cache.get(el);
    const winners = new Map();
    let order = 0;
    for (const rule of active) {
      const selectors = rule.selector.nodes.filter((n) => matches(n.nodes, el));
      if (!selectors.length) continue;
      const spec = selectors
        .map((n) => specificity(n.nodes))
        .sort(compare)
        .at(-1);
      for (const declaration of rule.nodes.filter((n) => n.type === 'css-decl')) {
        const rank = [Number(Boolean(declaration.important)), ...spec, order++];
        for (const [prop, value] of expanded(declaration.prop, declaration.value.text)) {
          const previous = winners.get(prop);
          if (!previous || compare(rank, previous.rank) > 0) winners.set(prop, { value, rank });
        }
      }
    }
    const result = {
      raw: (prop) => el.tokens[prop] ?? winners.get(prop)?.value,
      value(prop) {
        const own = result.raw(prop);
        if (own === undefined || own === 'inherit')
          return el.parent ? style(el.parent).value(prop) : undefined;
        return resolve(own);
      }
    };
    cache.set(el, result);
    return result;
    function resolve(value) {
      const next = value.replace(/var\((--[\w-]+)(?:,\s*([^()]+))?\)/g, (_, name, fallback) => {
        for (let ancestor = el; ancestor; ancestor = ancestor.parent) {
          const token = style(ancestor).raw(name);
          if (token !== undefined) return resolve(token);
        }
        return fallback || `var(${name})`;
      });
      return next === value ? next : resolve(next);
    }
  };
}
function fixture({
  width = 1920,
  base = 155,
  density = base,
  size = 'standard',
  theme = 'light',
  tokens = true
} = {}) {
  const root = element(
    'html',
    null,
    { 'data-theme': theme, 'data-card-size': size },
    tokens
      ? {
          '--card-scale': String(density / base),
          '--card-base-size': `${base}px`
        }
      : {}
  );
  const body = element('body', root),
    viewport = element('div', body, { id: 'viewport' });
  const overview = element('section', viewport, { class: 'category-overview' });
  const tile = element('article', overview, { class: 'collection-tile expanded' });
  const preview = element('div', tile, { class: 'collection-preview' });
  function card(parent, media = false) {
    const album = element('button', parent, { class: `album-card${media ? ' media-card' : ''}` });
    const shell = element('div', album, { class: 'cover-shell' });
    const footer = element('div', shell, { class: 'card-bottom-overlay' });
    const count = element('span', footer, { class: 'card-count' });
    return {
      footer,
      count,
      icon: element('svg', footer),
      value: element('span', count, { class: 'card-count-value' }),
      unit: element('span', count, { class: 'card-count-unit' }),
      rating: element('span', footer, { class: 'card-rating' })
    };
  }
  return {
    root,
    viewport,
    preview,
    more: element('button', preview, { class: 'collection-more' }),
    folder: card(viewport),
    media: card(viewport, true),
    previewCard: card(preview),
    style: cascade(width)
  };
}
function pixels(value) {
  const plain = value?.match(/^(-?[\d.]+)px$/);
  if (plain) return Number(plain[1]);
  const product = value?.match(/^calc\((-?[\d.]+)px\s*\*\s*([\d.e+-]+)\)$/);
  assert.ok(product, `Expected a pixel length or scalar pixel product, got ${value}`);
  return Number(product[1]) * Number(product[2]);
}
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test('footer text, icons and ratings scale continuously from each responsive medium, including compact and previews', () => {
  for (const [width, base] of [
    [1920, 155],
    [3840, 166]
  ]) {
    for (const density of [120, base, 195, 267, 360]) {
      for (const theme of ['light', 'dark']) {
        const f = fixture({
          width,
          base,
          density,
          theme,
          size: density === 120 ? 'compact' : density === 195 ? 'large' : 'standard'
        });
        const scale = density / base;
        for (const card of [f.folder, f.previewCard]) {
          near(pixels(f.style(card.footer).value('font-size')), 17 * scale);
          near(pixels(f.style(card.icon).value('width')), 20 * scale);
          near(pixels(f.style(card.icon).value('height')), 20 * scale);
          near(pixels(f.style(card.rating).value('font-size')), 11 * scale);
          near(pixels(f.style(card.rating).value('padding-top')), 3 * scale);
          near(pixels(f.style(card.rating).value('padding-right')), 6 * scale);
          near(pixels(f.style(card.footer).value('gap')), 6 * scale);
          assert.equal(f.style(card.count).value('transform'), 'translateY(1px)');
          assert.equal(f.style(card.value).value('text-overflow'), 'ellipsis');
          assert.equal(f.style(card.unit).value('flex-shrink'), '0');
        }
        near(pixels(f.style(f.media.footer).value('font-size')), 10 * scale);
        near(pixels(f.style(f.media.icon).value('width')), 14 * scale);
        near(pixels(f.style(f.media.rating).value('font-size')), 10 * scale);
      }
    }
  }
});

test('missing display tokens retain medium footer sizes and do not scale the one-pixel optical correction', () => {
  const f = fixture({ tokens: false });
  near(pixels(f.style(f.folder.footer).value('font-size')), 17);
  near(pixels(f.style(f.folder.icon).value('width')), 20);
  near(pixels(f.style(f.folder.rating).value('font-size')), 11);
  assert.equal(f.style(f.folder.count).value('transform'), 'translateY(1px)');
});

test('toolbar shares centered text line boxes and icons without per-label offsets after later sheets', () => {
  for (const width of [3840, 2560, 1920, 1230, 1200, 980]) {
    const f = fixture({ width }),
      toolbar = element('div', f.viewport, { id: 'toolbar', class: 'toolbar' });
    const right = element('div', toolbar, { class: 'toolbar-right glass' });
    const actions = ['details-toggle', 'density-button', 'refresh-button'].map((id) =>
      element('button', right, {
        id,
        class: id === 'details-toggle' ? 'detail-toggle' : 'small-icon'
      })
    );
    const gap = pixels(f.style(right).value('gap'));
    const adjacent = (left, next) =>
      gap +
      Number.parseFloat(f.style(left).value('margin-right') || 0) +
      Number.parseFloat(f.style(next).value('margin-left') || 0);
    assert.equal(adjacent(actions[0], actions[1]), adjacent(actions[1], actions[2]));
    assert.equal(gap, width <= 1200 ? 6 : 7);
    const label = element('label', right, { class: 'sort-label' });
    const wrapper = element('span', label, { class: 'album-select' });
    const button = element('button', wrapper, { class: 'album-select-button' });
    const text = element('span', button, { class: 'album-select-value' });
    const chevron = element('svg', button);
    const sortIcon = element('svg', element('span', label, { 'data-icon': 'sort' }));
    const direction = element('button', right, { id: 'sort-direction', class: 'small-icon' });
    const directionIcon = element('svg', direction);
    const divider = element('span', right, { class: 'toolbar-divider' });
    const sizeLabel = element('span', right, { class: 'card-size-label' });
    const sizeControls = element('div', right, { class: 'card-size-controls' });
    const sizeButtons = [128, 166, 195].map((density) =>
      element('button', sizeControls, { 'data-density': String(density) })
    );
    const actionIcons = actions.slice(1).map((action) => element('svg', action));
    assert.equal(f.style(right).value('align-items'), 'center');
    assert.equal(f.style(button).value('height'), '30px');
    assert.equal(f.style(button).value('min-height'), '30px');
    assert.equal(f.style(button).value('justify-content'), 'space-between');
    for (const control of [button, ...sizeButtons, actions[0]]) {
      assert.equal(f.style(control).value('display'), 'inline-flex');
      assert.equal(f.style(control).value('padding-top'), '0');
      assert.equal(f.style(control).value('padding-bottom'), '0');
      assert.equal(f.style(control).value('align-items'), 'center');
      assert.equal(f.style(control).value('line-height'), '20px');
    }
    assert.equal(f.style(text).value('display'), 'inline-flex');
    assert.equal(f.style(text).value('align-items'), 'center');
    assert.equal(f.style(text).value('min-height'), '20px');
    for (const content of [text, sizeLabel, ...sizeButtons, actions[0]])
      assert.equal(f.style(content).value('line-height'), '20px');
    for (const icon of [sortIcon, chevron, directionIcon, ...actionIcons])
      assert.equal(f.style(icon).value('display'), 'block');
    // Keep the compact-label breakpoint and the existing outer control sizes.
    assert.equal(f.style(sizeLabel).raw('display'), width <= 1200 ? 'none' : undefined);
    assert.equal(f.style(sizeButtons[0]).value('height'), '26px');
    assert.equal(f.style(actions[0]).value('height'), '27px');
    assert.equal(f.style(actions[1]).value('height'), '30px');
    const native = element('select', label, { id: 'sort' });
    assert.equal(f.style(native).value('height'), '30px');
    assert.equal(f.style(native).value('padding-top'), '0');
    assert.equal(f.style(native).value('padding-bottom'), '0');
    assert.equal(f.style(native).value('line-height'), '20px');
    for (const content of [
      button,
      text,
      native,
      label,
      wrapper,
      sizeLabel,
      sizeControls,
      ...sizeButtons,
      ...actions,
      sortIcon,
      chevron,
      direction,
      directionIcon,
      divider,
      ...actionIcons
    ]) {
      for (const property of ['transform', 'translate', 'top', 'bottom'])
        assert.ok(
          [undefined, 'none', 'auto', '0'].includes(f.style(content).raw(property)),
          `${property} must not shift one toolbar item: ${JSON.stringify(content.attributes)}`
        );
      assert.equal(
        f.style(content).raw('margin-top') || '0',
        f.style(content).raw('margin-bottom') || '0'
      );
      assert.equal(
        f.style(content).raw('padding-top') || '0',
        f.style(content).raw('padding-bottom') || '0'
      );
    }
  }
});

test('category previews center fixed-width columns while their more control still spans the full row', () => {
  const f = fixture();
  assert.equal(f.style(f.preview).value('justify-content'), 'center');
  assert.match(
    f.style(f.preview).raw('grid-template-columns'),
    /auto-fill, minmax\(0, min\(100%, var\(--card-width\)\)\)/
  );
  assert.equal(f.style(f.more).value('grid-column').replace(/\s/g, ''), '1/-1');
  assert.equal(f.style(f.more).value('justify-self'), 'center');
});
