'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');
const ui = path.join(__dirname, '../src/ui');
const parse = (name) => parsers.css.parse(fs.readFileSync(path.join(ui, name), 'utf8'));
const glass = parse('liquid-glass.css');
const rules = [];
function visit(node, conditions = []) {
  if (node.type === 'css-rule') rules.push({ node, conditions });
  for (const child of node.nodes || [])
    visit(
      child,
      node.type === 'css-atrule'
        ? [...conditions, `${node.name} ${node.raws.params || ''}`]
        : conditions
    );
}
visit(glass);
const declarations = (node) =>
  Object.fromEntries(
    (node.nodes || [])
      .filter((child) => child.type === 'css-decl')
      .map((d) => [d.prop, d.value.text])
  );
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
function specificity(node) {
  if (node.type === 'selector-id') return [1, 0, 0];
  if (['selector-class', 'selector-attribute'].includes(node.type)) return [0, 1, 0];
  if (node.type === 'selector-tag') return [0, 0, 1];
  if (node.type === 'selector-pseudo') {
    if (node.value === ':where') return [0, 0, 0];
    if ([':is', ':not', ':has'].includes(node.value))
      return (node.nodes || []).map(specificity).sort(compare).at(-1) || [0, 0, 0];
    return node.value.startsWith('::') ? [0, 0, 1] : [0, 1, 0];
  }
  return (node.nodes || []).map(specificity).reduce((a, b) => a.map((n, i) => n + b[i]), [0, 0, 0]);
}
const materialRule = rules.find(
  ({ node }) => declarations(node).background === 'var(--settings-glass-fill)'
).node;
const materialSelectors = materialRule.raws.selector;

test('dialog surfaces outrank their actual component rules, including later-loaded sheets', () => {
  const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  assert.ok(index.indexOf('liquid-glass.css') < index.indexOf('appearance.css'));
  assert.ok(index.indexOf('liquid-glass.css') < index.indexOf('wallpaper.css'));
  const surfaces = [
    ['.album-select-button', 'controls.css', '.album-select-button'],
    ['.field-input', 'floating.css', '.field-input'],
    ['.cache-location', 'cache-settings.css', '.cache-location'],
    ['.cache-path', 'cache-settings.css', '.cache-location .cache-path'],
    ['.cache-card', 'styles.css', '.cache-card'],
    ['.appearance-subtabs', 'appearance.css', '.appearance-subtabs'],
    ['.appearance-range-row', 'appearance.css', '.appearance-page .appearance-range-row'],
    ['.wallpaper-gallery-tabs', 'wallpaper.css', '.wallpaper-gallery-tabs'],
    ['.wallpaper-card', 'wallpaper.css', '.wallpaper-card'],
    ['.wallpaper-upload', 'wallpaper.css', '.wallpaper-upload'],
    ['.wallpaper-selected-mark', 'wallpaper.css', '.wallpaper-selected-mark'],
    ['.wallpaper-card-actions button', 'wallpaper.css', '.wallpaper-card-actions button'],
    ['.wallpaper-editor-close', 'wallpaper.css', '.wallpaper-editor-close'],
    ['.wallpaper-options', 'wallpaper.css', '.wallpaper-options'],
    ['.wallpaper-crop-ranges', 'wallpaper.css', '.wallpaper-crop-ranges']
  ];
  const materialWeight = specificity(materialRule.selector.nodes[0]);
  for (const [surface, sheet, baseline] of surfaces) {
    assert.ok(materialSelectors.includes(surface), `${surface} is covered`);
    const original = parse(sheet)
      .nodes.filter((n) => n.type === 'css-rule')
      .flatMap((n) =>
        n.selector.nodes.map((selector) => ({ selector, declaration: declarations(n) }))
      )
      .find(({ selector, declaration }) => {
        const words = [];
        function text(n) {
          if (n.value) words.push(n.value);
          for (const child of n.nodes || []) text(child);
        }
        text(selector);
        const wanted = baseline.split(' ').map((part) => part.replace(/^\./, ''));
        return wanted.every((word) => words.includes(word)) && declaration.background;
      });
    assert.ok(original, `${baseline} baseline exists in ${sheet}`);
    assert.ok(
      compare(materialWeight, specificity(original.selector)) > 0,
      `${surface} wins source order`
    );
  }
  for (const excluded of ['.wallpaper-card-art', '.wallpaper-crop-preview', 'img', '.primary'])
    assert.ok(!materialSelectors.includes(excluded), `${excluded} content is excluded`);
});

test('transparent endpoint clears every optical channel while accessibility can restore solid material', () => {
  const endpoint = rules.find(
    ({ node }) =>
      node.raws.selector.includes("data-dialog-transparent='on'") &&
      declarations(node)['--settings-glass-fill']
  );
  assert.ok(endpoint);
  const values = declarations(endpoint.node);
  for (const channel of ['fill', 'state-fill', 'checked-fill', 'edge', 'state-edge'])
    assert.equal(values[`--settings-glass-${channel}`], 'transparent', channel);
  for (const channel of ['filter', 'rim'])
    assert.equal(values[`--settings-glass-${channel}`], 'none', channel);
  const fallback = rules.filter(
    ({ node, conditions }) => conditions.length && declarations(node)['--settings-glass-fill']
  );
  for (const condition of ['supports not', 'prefers-reduced-transparency', 'forced-colors']) {
    const rule = fallback.find(({ conditions }) => conditions.some((c) => c.includes(condition)));
    assert.ok(rule, `${condition} has a material fallback`);
    assert.ok(rules.indexOf(rule) > rules.indexOf(endpoint), `${condition} overrides transparency`);
    assert.equal(declarations(rule.node)['--settings-glass-filter'], 'none');
  }
  const forced = fallback.find(
    ({ node }) => declarations(node)['--settings-glass-fill'] === 'Canvas'
  );
  assert.ok(forced);
  assert.equal(declarations(forced.node)['--settings-glass-edge'], 'CanvasText');
  assert.equal(declarations(forced.node)['--settings-glass-state-outline'], 'Highlight');
});

test('inner material changes only optical paint and semantic boundaries, with no foreground opacity', () => {
  const innerRules = rules.filter(({ node }) => node.raws.selector.includes('.settings-panel'));
  const allowed = new Set([
    'background',
    'backdrop-filter',
    'border-color',
    'box-shadow',
    'outline',
    'outline-offset'
  ]);
  for (const { node } of innerRules)
    for (const property of Object.keys(declarations(node)))
      assert.ok(
        property.startsWith('--settings-glass-') || allowed.has(property),
        `${property} changes no layout/content`
      );
  const liquid = innerRules.find(({ node }) =>
    declarations(node)['--settings-glass-sheen']?.includes('linear-gradient')
  );
  assert.ok(liquid.node.raws.selector.includes("data-liquid-glass='on'"));
  assert.ok(liquid.conditions.some((condition) => condition.startsWith('supports')));
  const shared = innerRules.find(({ node }) => declarations(node)['--settings-glass-state']);
  assert.match(
    declarations(shared.node)['--settings-glass-state'],
    /var\(--settings-glass-opacity\)/
  );
  assert.match(
    declarations(shared.node)['--settings-glass-tint'],
    /var\(--settings-glass-opacity\)/
  );
  assert.equal(declarations(shared.node)['--settings-glass-filter'], 'none');
  const root = rules.find(
    ({ node }) => node.raws.selector === ':root' && declarations(node)['--liquid-dialog-opacity']
  );
  assert.equal(declarations(root.node)['--liquid-dialog-opacity'], '0.55');
});
