'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parsers } = require('prettier/plugins/postcss');
const ui = path.join(__dirname, '../src/ui');
const index = fs.readFileSync(path.join(ui, 'index.html'), 'utf8');
const sheets = [...index.matchAll(/rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
const rules = [];
function visit(node, conditions = [], sheet) {
  if (node.type === 'css-rule') rules.push({ node, conditions, sheet });
  for (const child of node.nodes || [])
    visit(
      child,
      node.type === 'css-atrule'
        ? [...conditions, `${node.name} ${node.raws.params || ''}`]
        : conditions,
      sheet
    );
}
for (const sheet of sheets)
  visit(parsers.css.parse(fs.readFileSync(path.join(ui, sheet), 'utf8')), [], sheet);
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
function element(parent, classes = '', attrs = {}, tag = 'div') {
  const el = { parent, classes: classes.split(' '), attrs, tag, children: [], states: new Set() };
  parent?.children.push(el);
  return el;
}
// Source-level cascade checks: real stylesheet order, selectors, inheritance and
// variable substitution. This is not a browser layout or rendered blur assertion.
function matches(nodes, el) {
  if (!el) return false;
  const split = nodes.findLastIndex((n) => n.type === 'selector-combinator');
  if (split < 0) return nodes.every((node) => simple(node, el));
  if (!matches(nodes.slice(split + 1), el)) return false;
  const left = nodes.slice(0, split);
  if (nodes[split].value.trim() === '>') return matches(left, el.parent);
  if (nodes[split].value.trim()) return false;
  for (let ancestor = el.parent; ancestor; ancestor = ancestor.parent)
    if (matches(left, ancestor)) return true;
  return false;
}
function simple(node, el) {
  if (node.type === 'selector-universal') return true;
  if (node.type === 'selector-class') return el.classes.includes(node.value);
  if (node.type === 'selector-id') return el.attrs.id === node.value;
  if (node.type === 'selector-tag') return el.tag === node.value;
  if (node.type === 'selector-attribute')
    return node.operator
      ? node.operator === '=' && el.attrs[node.attribute] === (node.raws.unquoted ?? node.value)
      : Object.hasOwn(el.attrs, node.attribute);
  if (node.type !== 'selector-pseudo') return false;
  if ([':is', ':where'].includes(node.value)) return node.nodes.some((n) => matches(n.nodes, el));
  if (node.value === ':not') return !node.nodes.some((n) => matches(n.nodes, el));
  if (node.value === ':root') return !el.parent;
  if (node.value === ':first-child') return el.parent?.children[0] === el;
  if (node.value === ':enabled') return !Object.hasOwn(el.attrs, 'disabled');
  if (node.value === ':has')
    return node.nodes.some((n) => {
      const direct = n.nodes[0]?.type === 'selector-combinator' && n.nodes[0].value === '>';
      const candidates = direct ? el.children : descendants(el);
      return candidates.some((child) => matches(direct ? n.nodes.slice(1) : n.nodes, child));
    });
  return el.states.has(node.value.slice(1));
}
function descendants(el) {
  return el.children.flatMap((child) => [child, ...descendants(child)]);
}
function enabled(condition, env) {
  if (condition.startsWith('supports')) {
    if (condition.includes('backdrop-filter'))
      return condition.startsWith('supports not') ? !env.backdrop : env.backdrop;
    return true;
  }
  if (condition.startsWith('media'))
    return condition.split(',').some((part) => {
      if (part.includes('prefers-reduced-transparency')) return env.reducedTransparency;
      if (part.includes('forced-colors')) return env.forcedColors;
      if (part.includes('prefers-reduced-motion')) return env.reducedMotion;
      if (part.includes('max-width')) return false;
      return part.includes('min-width');
    });
  return true;
}
function cascade(env) {
  const cache = new Map();
  return function style(el) {
    if (cache.has(el)) return cache.get(el);
    const inherited = el.parent && style(el.parent);
    const chosen = new Map();
    for (const { node, conditions } of rules) {
      if (!conditions.every((c) => enabled(c, env))) continue;
      for (const selector of node.selector.nodes) {
        if (!matches(selector.nodes, el)) continue;
        const weight = specificity(selector);
        for (const decl of node.nodes.filter((n) => n.type === 'css-decl')) {
          const previous = chosen.get(decl.prop);
          const priority = Number(Boolean(decl.important));
          if (
            !previous ||
            priority > previous.priority ||
            (priority === previous.priority && compare(weight, previous.weight) >= 0)
          )
            chosen.set(decl.prop, {
              value: decl.value.text,
              weight,
              priority,
              selector: node.raws.selector,
              conditions
            });
        }
      }
    }
    for (const [name, value] of Object.entries(el.inline || {})) chosen.set(name, { value });
    const variables = new Map();
    function resolve(value) {
      if (value === undefined) return undefined;
      return value.replace(
        /var\((--[\w-]+)(?:,\s*([^()]*))?\)/g,
        (_, name, fallback) => variable(name) ?? fallback ?? `var(${name})`
      );
    }
    function variable(name) {
      if (!variables.has(name))
        variables.set(
          name,
          chosen.has(name) ? resolve(chosen.get(name).value) : inherited?.variable(name)
        );
      return variables.get(name);
    }
    const result = {
      get: (name) => resolve(chosen.get(name)?.value),
      variable,
      rule: (name) => chosen.get(name)
    };
    cache.set(el, result);
    return result;
  };
}
const railClasses = [
  'settings-tabs',
  'appearance-subtabs',
  'wallpaper-gallery-tabs',
  'settings-nav',
  'filter-tabs',
  'future-tabs'
];
function fixture(options = {}) {
  const env = { backdrop: true, ...options };
  const root = element(
    null,
    '',
    {
      'data-theme': options.theme || 'light',
      'data-liquid-glass': options.mode || 'on',
      'data-motion': options.reducedMotion ? 'low' : 'high',
      'data-floating-transparent': options.floatingTransparent ? 'on' : 'off',
      'data-dialog-transparent': options.dialogTransparent ? 'on' : 'off'
    },
    'html'
  );
  root.inline = {
    '--liquid-floating-opacity': options.floating ?? '0.72',
    '--frost-floating-opacity': options.floating ?? '0.72',
    '--liquid-dialog-opacity': options.dialog ?? '0.31',
    '--frost-dialog-opacity': options.dialog ?? '0.31'
  };
  const body = element(root, '', {}, 'body');
  const floating = element(body, 'toast');
  const modal = element(body, 'modal settings-dialog');
  const shell = element(modal, '', { id: 'settings-shell' });
  const viewport = element(shell, 'settings-viewport');
  const panel = element(viewport, 'settings-panel');
  const page = element(panel, 'appearance-page');
  const rails = railClasses.map((name) => {
    const parent = name === 'settings-tabs' ? shell : name === 'appearance-subtabs' ? panel : page;
    const rail = element(parent, name, { role: 'tablist' });
    const selected = element(rail, 'active', { 'aria-selected': 'true' }, 'button');
    const unselected = element(rail, '', { 'aria-selected': 'false' }, 'button');
    const indicator =
      ['settings-tabs', 'appearance-subtabs'].includes(name) &&
      element(rail, 'settings-tab-indicator');
    return { name, rail, selected, unselected, indicator };
  });
  const card = element(page, 'settings-card');
  const crop = element(page, 'wallpaper-crop-ranges');
  const range = element(crop, 'appearance-range-row');
  const style = cascade(env);
  return { root, modal, floating, viewport, panel, page, rails, card, crop, range, style };
}
const compact = (value) => value?.replace(/\s+/g, ' ').trim();
const material = (value) => compact(value)?.replace(/^none,\s*/, '');

for (const theme of ['light', 'dark'])
  for (const mode of ['on', 'off'])
    test(`${theme}/${mode}: every modal rail uses the floating material while cards stay light`, () => {
      const f = fixture({ theme, mode });
      for (const { name, rail } of f.rails) {
        const style = f.style(rail);
        assert.equal(
          compact(style.get('backdrop-filter')),
          compact(f.style(f.floating).get('backdrop-filter')),
          `${name}: ${JSON.stringify(style.rule('backdrop-filter'))}; token=${style.variable('--settings-rail-filter')}`
        );
        assert.equal(
          material(style.get('background')),
          material(f.style(f.floating).get('background')),
          name
        );
        assert.equal(style.variable('--settings-rail-opacity'), '0.72', name);
        assert.equal(style.variable('--settings-glass-opacity'), 'calc(0.31 * 0.18)', name);
        assert.equal(style.get('opacity'), undefined, `${name}: foreground alpha unchanged`);
        assert.equal(style.get('filter'), undefined, `${name}: foreground is not blurred`);
      }
      assert.equal(f.style(f.card).get('backdrop-filter'), 'none');
      assert.equal(f.style(f.card).variable('--settings-rail-opacity'), undefined);
      assert.match(f.style(f.card).get('background'), /calc\(0\.31 \* 0\.18\)/);
      assert.equal(f.style(f.range).get('background'), 'transparent');
      assert.equal(f.style(f.range).get('backdrop-filter'), 'none');
      assert.equal(f.style(f.panel).get('backdrop-filter'), undefined);
      assert.equal(f.style(f.page).get('filter'), undefined);
    });

test('rail material responds to floating controls and survives the independent dialog endpoint', () => {
  for (const theme of ['light', 'dark'])
    for (const mode of ['on', 'off']) {
      for (const dialog of ['0', '1']) {
        const f = fixture({
          theme,
          mode,
          floating: '1',
          dialog,
          dialogTransparent: dialog === '0'
        });
        for (const { rail } of f.rails) {
          assert.equal(
            compact(f.style(rail).get('backdrop-filter')),
            compact(f.style(f.floating).get('backdrop-filter'))
          );
          assert.equal(
            material(f.style(rail).get('background')),
            material(f.style(f.floating).get('background'))
          );
          assert.match(
            f.style(rail).get('backdrop-filter'),
            mode === 'on' ? /18px\s*\*\s*1/ : /24px\s*\*\s*1/
          );
        }
      }
      for (const dialogTransparent of [false, true]) {
        const f = fixture({
          theme,
          mode,
          floating: '0',
          floatingTransparent: true,
          dialogTransparent
        });
        for (const { rail, selected, unselected, indicator } of f.rails) {
          for (const prop of ['background', 'border-color'])
            assert.equal(f.style(rail).get(prop), 'transparent');
          for (const prop of ['backdrop-filter', 'box-shadow'])
            assert.equal(f.style(rail).get(prop), 'none');
          for (const button of [selected, unselected, indicator].filter(Boolean)) {
            assert.equal(f.style(button).get('background'), 'transparent');
            assert.equal(f.style(button).get('backdrop-filter'), 'none');
            assert.equal(f.style(button).get('box-shadow'), 'none');
          }
          assert.match(f.style(indicator || selected).get('outline'), /^1px solid /);
        }
        assert.equal(f.style(f.card).get('background') === 'transparent', dialogTransparent);
      }
    }
});

test('only the rail blurs, and both settings levels paint selection on the moving indicator once', () => {
  const f = fixture();
  for (const { selected, unselected, indicator } of f.rails) {
    for (const child of [selected, unselected, indicator].filter(Boolean)) {
      assert.equal(f.style(child).get('backdrop-filter'), 'none');
      assert.equal(f.style(child).get('filter'), undefined);
      assert.equal(f.style(child).get('opacity'), undefined);
    }
    assert.notEqual(f.style(indicator || selected).get('background'), 'transparent');
    assert.equal(f.style(unselected).get('background'), 'transparent');
    if (indicator) {
      assert.equal(f.style(selected).get('background'), 'transparent');
      assert.equal(f.style(indicator).get('z-index'), '0');
      assert.equal(f.style(selected).get('z-index'), '1');
      assert.equal(f.style(selected).get('outline'), undefined);
      assert.equal(f.style(indicator).get('pointer-events'), 'none');
    }
  }
});

for (const preference of ['backdrop', 'reducedTransparency', 'forcedColors'])
  test(`${preference}: accessibility and unsupported-backdrop fallbacks override transparent rails`, () => {
    for (const theme of ['light', 'dark'])
      for (const mode of ['on', 'off']) {
        const f = fixture({
          theme,
          mode,
          floating: '0',
          floatingTransparent: true,
          dialogTransparent: true,
          [preference]: preference !== 'backdrop'
        });
        for (const { rail, selected, indicator } of f.rails) {
          const forced = preference === 'forcedColors';
          assert.equal(
            f.style(rail).get('background'),
            forced ? 'Canvas' : f.style(rail).variable('--surface-solid')
          );
          assert.equal(
            f.style(rail).get('border-color'),
            forced ? 'CanvasText' : f.style(rail).variable('--line')
          );
          assert.equal(f.style(rail).get('backdrop-filter'), 'none');
          assert.equal(f.style(rail).get('box-shadow'), 'none');
          assert.equal(
            f.style(indicator || selected).get('background'),
            f.style(rail).get('background')
          );
          if (forced)
            assert.equal(f.style(indicator || selected).get('outline'), '1px solid Highlight');
        }
      }
  });

test('keyboard focus and reduced motion retain component behavior and sticky clearance', () => {
  for (const reducedMotion of [false, true]) {
    const f = fixture({ reducedMotion });
    for (const { selected } of f.rails) selected.states.add('focus-visible');
    for (const { name, selected } of f.rails) {
      assert.match(f.style(selected).get('outline'), /^2px solid /, name);
      assert.notEqual(f.style(selected).get('outline-offset'), '-1px', name);
    }
    const sticky = f.rails.find((r) => r.name === 'appearance-subtabs').rail;
    assert.equal(f.style(sticky).get('position'), 'sticky');
    assert.equal(f.style(sticky).get('top'), '0');
    assert.equal(f.style(f.panel).get('overflow'), 'auto');
    assert.equal(f.style(f.panel).get('scroll-padding-top'), '58px');
    for (const ancestor of [f.viewport, f.panel, f.page]) {
      assert.equal(f.style(ancestor).get('filter'), undefined);
      assert.equal(f.style(ancestor).get('backdrop-filter'), undefined);
      assert.equal(f.style(ancestor).get('opacity'), undefined);
    }
    if (reducedMotion) assert.equal(f.style(f.rails[1].selected).get('transition'), 'none');
  }
});

test('global filter tabs reuse their floating parent without adding a nested dialog rail', () => {
  const f = fixture();
  const topbar = element(f.root, 'topbar');
  const navigation = element(topbar, 'navigation');
  const filter = element(navigation, 'filter-tabs', { role: 'tablist' });
  assert.equal(f.style(filter).variable('--settings-rail-opacity'), undefined);
  assert.match(f.style(navigation).get('backdrop-filter'), /blur\(/);
});

test('both settings rails use tight pill geometry without changing the material', () => {
  const f = fixture();
  for (const { rail, selected, indicator } of f.rails.filter((rail) => rail.indicator)) {
    assert.equal(f.style(rail).get('padding'), '2px');
    assert.equal(f.style(rail).get('gap'), '2px');
    for (const el of [rail, selected, indicator])
      assert.equal(f.style(el).get('border-radius'), '999px');
  }
});

test('settings indicator retargets from its painted position and snaps for reduced motion, resize and disposal', () => {
  const source = fs.readFileSync(path.join(ui, 'app.js'), 'utf8');
  const helper = source.slice(
    source.indexOf('  const placeIndicator = ('),
    source.indexOf('  const dispose = () => {', source.indexOf('async function settingsModal'))
  );
  const motion = { matches: false };
  const S = { settings: { motionLevel: 'high' } };
  let connected = true;
  const events = [];
  const indicator = {
    style: {},
    dataset: {},
    painted: 'none',
    animations: [],
    getAnimations() {
      return this.animations;
    },
    animate(frames, options) {
      events.push({ frames, options });
      this.animations = [
        {
          cancel: () => {
            events.push('cancel');
            this.animations = [];
          }
        }
      ];
    }
  };
  const button = { offsetLeft: 2, offsetTop: 2, offsetWidth: 100, offsetHeight: 40 };
  const rail = {
    querySelector: (selector) => (selector.startsWith('button') ? button : indicator)
  };
  const place = new Function(
    'alive',
    'topRail',
    'getComputedStyle',
    'motion',
    'S',
    helper + '\nreturn placeIndicator;'
  )(
    () => connected,
    rail,
    () => ({ transform: indicator.painted }),
    motion,
    S
  );
  place();
  assert.equal(events.length, 0, 'initial geometry is static');
  button.offsetLeft = 104;
  indicator.painted = 'matrix(1, 0, 0, 1, 2, 2)';
  place();
  assert.equal(events[0].options.easing, 'cubic-bezier(.45,0,.25,1)');
  indicator.painted = 'matrix(1, 0, 0, 1, 48, 2)';
  button.offsetLeft = 206;
  place();
  assert.equal(events[1], 'cancel');
  assert.equal(
    events[2].frames[0].transform,
    indicator.painted,
    'rapid switching begins at current painted position'
  );
  assert.equal(
    indicator.style.transform,
    'translate(206px, 2px)',
    'underlying style always holds final position'
  );
  for (const preference of ['system', 'low', 'resize']) {
    motion.matches = preference === 'system';
    S.settings.motionLevel = preference === 'low' ? 'low' : 'high';
    button.offsetLeft += 1;
    place(rail, preference !== 'resize');
    assert.equal(events.filter((event) => typeof event === 'object').length, 2, preference);
    assert.equal(indicator.animations.length, 0, preference);
    assert.equal(indicator.style.transform, `translate(${button.offsetLeft}px, 2px)`);
  }
  const settled = indicator.style.transform;
  connected = false;
  button.offsetLeft = 999;
  place();
  assert.equal(indicator.style.transform, settled, 'disposed shells are untouched');
  connected = true;
  button.offsetWidth = 0;
  place();
  assert.equal(indicator.style.transform, settled, 'hidden retained rails wait for layout');
});
