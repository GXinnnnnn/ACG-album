'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ui = path.join(__dirname, '..', 'src', 'ui');
const source = fs.readFileSync(path.join(ui, 'liquid-glass.js'), 'utf8');
const materialCss = fs.readFileSync(path.join(ui, 'liquid-glass.css'), 'utf8');
const effectsCss = fs.readFileSync(path.join(ui, 'effects.css'), 'utf8');
const viewerCss = fs.readFileSync(path.join(ui, 'viewer-frame.css'), 'utf8');
const rules = (css) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/@charset\s+[^;]+;/g, '')
      .matchAll(/([^{}]+)\{([^{}]*)\}/g)
  ].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const declarations = (body) =>
  Object.fromEntries(
    [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])
  );
const shared = (rule) =>
  rule.selector.includes('.sidebar-shell') && rule.selector.includes('.modal:not(.viewer)');

test('sidebar and nonviewer dialogs use full-surface background tokens, with an independent denser window material', () => {
  const all = rules(materialCss),
    background = all.filter((rule) => shared(rule) && declarations(rule.body).background);
  assert.equal(background.length, 2, 'Base tint fallback plus enhanced full-surface gradient');
  assert.equal(declarations(background[0].body).background, 'var(--glass-base-tint)');
  assert.match(declarations(background[1].body).background, /linear-gradient\(/);
  assert.match(declarations(background[1].body).background, /var\(--glass-base-tint\)/);
  const defaults = declarations(all.find((rule) => rule.selector === ':root').body);
  assert.equal(Number(defaults['--liquid-opacity']), 0.82);
  assert.equal(Number(defaults['--frost-opacity']), 0.92);
  const window = declarations(
    all.find((rule) => rule.selector === ':root[data-theme] .modal:not(.viewer)').body
  );
  assert.equal(window['--glass-base-tint'], 'var(--frost-body-tint)');
  assert.equal(window['--glass-material-opacity'], 'var(--frost-opacity)');
  assert.match(
    window['backdrop-filter'],
    /blur\(calc\(18px \* var\(--frost-opacity\) \/ 0\.92\)\)/
  );
  assert.ok(
    rules(effectsCss).some(
      (rule) => shared(rule) && /blur\(/.test(declarations(rule.body)['backdrop-filter'] || '')
    ),
    'Real DOM backdrop remains available'
  );
  assert.doesNotMatch(
    materialCss,
    /--dialog-frost|mask-image|clip-path/,
    'No central material seam'
  );
});

test('one shared shader has no central mask, frost uniform, SVG image or geometry helper', () => {
  assert.match(source, /compile\(gl\.FRAGMENT_SHADER,\s*fragment\)/);
  assert.equal((source.match(/const fragment\s*=/g) || []).length, 1);
  assert.match(source, /uniform\s+vec4\s+material\s*;/);
  assert.doesNotMatch(
    source,
    /\b(?:dialogFrostBounds|frostMask|measureDialogFrost|applyDialogFrost)\b|--dialog-frost|uniform\s+\w+\s+frost\b|\b(?:options|row|uniforms)\.frost\b|data:image\/svg\+xml/i
  );
  assert.doesNotMatch(materialCss, /--dialog-frost|data:image\/svg\+xml/i);
});

test('light and dark themes supply distinct translucent shared body and backdrop tint tokens', () => {
  for (const [css, token] of [
    [materialCss, '--liquid-body-tint'],
    [effectsCss, '--liquid-tint']
  ]) {
    const all = rules(css);
    const light = declarations(all.find((rule) => rule.selector === ':root').body)[token];
    const dark = declarations(
      all.find((rule) => /^:root\[data-theme=['"]dark['"]\]$/.test(rule.selector)).body
    )[token];
    assert.notEqual(light, dark, token + ' follows the theme');
    for (const value of [light, dark]) {
      assert.match(value, /^rgba\(/);
      if (token === '--liquid-body-tint')
        assert.match(
          value,
          /,\s*var\(--liquid-opacity\)\)$/,
          'Adjustable alpha remains a background token'
        );
      else {
        const alpha = Number(value.match(/,\s*([\d.]+)\s*\)$/)?.[1]);
        assert.ok(alpha > 0 && alpha < 1, token + ' leaves the real backdrop visible');
      }
    }
  }
  assert.match(source, /uniform\s+float\s+dark\s*;/);
});

test('viewer remains excluded from shared optical hosts and retains its own material', () => {
  const hosts = source.match(/const surfaces\s*=\s*['"]([^'"]+)['"]/)[1].split(',');
  assert.ok(hosts.includes('.sidebar-shell'));
  assert.ok(hosts.includes('.modal:not(.viewer)'));
  assert.ok(
    hosts.every((selector) => !/viewer/.test(selector) || selector === '.modal:not(.viewer)')
  );
  for (const rule of rules(materialCss + effectsCss).filter(shared))
    assert.doesNotMatch(rule.selector, /\.modal(?!:not\(\.viewer\))/);
  const viewer = rules(viewerCss).find((rule) => rule.selector === '#viewer');
  assert.equal(declarations(viewer.body).background, 'var(--viewer-background)');
  assert.equal(declarations(viewer.body)['backdrop-filter'], 'none');
});
