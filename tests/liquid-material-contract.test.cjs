'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');

// Parsed stylesheet contracts only; actual computed styles are checked by the
// separate GUI acceptance runner. Keep the global preference independent of
// image overlap, component classes, liquid mode and WebGL availability.
const ui = path.resolve(__dirname, '../src/ui');
const tree = parsers.css.parse(fs.readFileSync(path.join(ui, 'liquid-glass.css'), 'utf8'));
const rules = tree.nodes.filter((n) => n.type === 'css-rule');
const declarations = (rule) => rule.nodes.filter((n) => n.type === 'css-decl');

for (const on of [true, false]) {
  const prefix = on ? ":root[data-text-shadow='on']" : ":root:not([data-text-shadow='on'])";
  test(`global text shadow ${on ? 'on' : 'off'} covers ordinary titles, settings text and viewer text directly`, () => {
    const rule = rules.find((n) => n.raws.selector.startsWith(prefix + ','));
    assert.ok(rule, 'A global preference rule must exist outside image-overlap selectors');
    const ordinary = rule.selector.nodes.find(({ nodes }) => {
      const split = nodes.findIndex((n) => n.type === 'selector-combinator');
      return (
        split > 0 &&
        nodes.length === split + 2 &&
        nodes[split].value === ' ' &&
        nodes[split + 1].type === 'selector-universal'
      );
    });
    assert.ok(
      ordinary,
      'An unrestricted descendant selector covers .card-title, settings descriptions and #viewer text'
    );
    assert.equal(ordinary.nodes[0].value, ':root');
    const state = ordinary.nodes[1];
    if (on) {
      assert.equal(state.attribute, 'data-text-shadow');
      assert.equal(state.raws.unquoted, 'on');
    } else {
      assert.equal(state.value, ':not');
      assert.equal(state.nodes[0].nodes[0].attribute, 'data-text-shadow');
      assert.equal(state.nodes[0].nodes[0].raws.unquoted, 'on');
    }
    const decls = declarations(rule);
    assert.deepEqual(
      decls.map((d) => d.prop),
      ['text-shadow'],
      'Do not change icon filters, foreground or placeholder colors'
    );
    assert.equal(decls[0].value.text, on ? '0 1px 2px var(--glass-ink-shadow)' : 'none');
    assert.equal(
      decls[0].important,
      true,
      'Override ordinary component resets, including #viewer text-shadow:none'
    );
    for (const suffix of [' *::before', ' *::after', ' :is(input, textarea)::placeholder'])
      assert.ok(
        rule.raws.selector.includes(prefix + suffix),
        'Include generated and placeholder text: ' + suffix
      );
  });
}

test('global on uses one faint downward shadow in both themes, without glow or stroke', () => {
  const token = (selector) =>
    rules
      .filter((n) => n.raws.selector === selector)
      .flatMap(declarations)
      .find((n) => n.prop === '--glass-ink-shadow');
  const light = rules
    .filter((n) => n.raws.selector === ':root')
    .flatMap(declarations)
    .find((n) => n.prop === '--glass-ink-shadow');
  assert.equal(light.value.text, 'rgba(25, 20, 37, 0.2)');
  assert.equal(token(":root[data-theme='dark']").value.text, 'rgba(0, 0, 0, 0.3)');
  const html = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
  for (const [, name] of html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)) {
    const sheet = parsers.css.parse(fs.readFileSync(path.join(ui, name), 'utf8'));
    function visit(nodes) {
      for (const node of nodes) {
        if (node.type === 'css-rule') {
          for (const decl of declarations(node))
            if (decl.prop === 'text-shadow' && decl.important) {
              assert.equal(
                name,
                'liquid-glass.css',
                'A component must not defeat the global preference'
              );
              assert.ok(node.raws.selector.includes('data-text-shadow'));
            }
        } else if (node.nodes) visit(node.nodes);
      }
    }
    visit(sheet.nodes);
  }
});
