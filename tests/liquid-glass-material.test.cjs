'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fragment, materialProfile } = require('../src/ui/liquid-glass.js');

// Evaluate the scalar envelope taken from the shipped shader, rather than a
// separately maintained copy of its coefficients. This is an optical-strength
// regression, not a GLSL compiler or a screenshot/contrast test.
const expressions = ['mask', 'bevel', 'shoulder', 'facing', 'fresnel', 'specular', 'alpha'].map(
  (name) => {
    const match = fragment.match(new RegExp(`float ${name} = ([^;]+);`));
    assert.ok(match, `Shader scalar ${name} must remain measurable`);
    const expression = match[1].replace(
      /dot\(normal, normalize\(light \+ vec2\(0\.0001\)\)\)/g,
      'incidence'
    );
    return [
      name,
      new Function(
        's',
        `const { d, incidence, opacity, dark, sheen, material, min, max, pow, mix, smoothstep,
          mask, bevel, shoulder, facing, fresnel, specular } = s;
         return (${expression});`
      )
    ];
  }
);
function envelope(width, height, inset, incidence, opacity = 0.35, dark = 0, sheen = 0.7) {
  const profile = materialProfile(width, height);
  const state = {
    d: -inset,
    incidence,
    opacity,
    dark,
    sheen,
    material: {
      x: profile.edgeWidth,
      y: profile.shoulderWidth,
      z: profile.bodyAlpha,
      w: profile.sheenAlpha
    },
    min: Math.min,
    max: Math.max,
    pow: Math.pow,
    mix: (a, b, t) => a * (1 - t) + b * t,
    smoothstep: (a, b, value) => {
      const t = Math.max(0, Math.min(1, (value - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }
  };
  for (const [name, evaluate] of expressions) state[name] = evaluate(state);
  return state.alpha;
}
const components = [
  [104, 58], // header action capsule
  [150, 740], // navigation rail
  [320, 210], // menu
  [840, 600] // large reading dialog
];

test('all component sizes keep bounded translucent edges at every supported saved opacity', () => {
  for (const [width, height] of components)
    for (const dark of [0, 1])
      for (const opacity of [0, 0.1, 0.4, 0.35, 0.92, 1])
        for (const incidence of [-1, -0.5, 0, 0.5, 1])
          for (const sheen of [0, 1])
            for (const inset of [0, 0.7, 1, 4, 10, 18, 40, Math.min(width, height) / 2]) {
              const alpha = envelope(width, height, inset, incidence, opacity, dark, sheen);
              assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= 0.42, `${alpha}`);
            }
});

test('unlit edges fade directionally in both themes, while the full interior stays optical', () => {
  for (const [width, height] of components)
    for (const dark of [0, 1]) {
      const lit = envelope(width, height, 1, 1, 0.35, dark);
      const unlit = envelope(width, height, 1, -1, 0.35, dark);
      assert.ok(
        lit - unlit > 0.08,
        'Light direction must change the edge, not form a uniform ring'
      );
      const center = Math.min(width, height) / 2;
      const body = envelope(width, height, center, 1, 0.35, dark);
      assert.ok(body > 0.08 && body < 0.18, 'A low, nonzero optical floor covers the center');
      assert.equal(body, envelope(width, height, center, -1, 0.35, dark));
      assert.ok(unlit - body < 0.06, 'The shadow-side rim should merge gently into the body');
    }
});

test('edge shoulders decay smoothly without an interior opacity seam', () => {
  for (const [width, height] of components)
    for (const dark of [0, 1])
      for (const incidence of [-1, 0, 1]) {
        let previous = envelope(width, height, 1, incidence, 0.35, dark);
        for (let inset = 1.5; inset <= Math.min(width, height) / 2; inset += 0.5) {
          const next = envelope(width, height, inset, incidence, 0.35, dark);
          assert.ok(next <= previous + 1e-12, 'No bright secondary ring inside the edge');
          assert.ok(previous - next < 0.025, 'No abrupt half-pixel shoulder transition');
          previous = next;
        }
      }
});

test('material endpoints clear the optical proxy and composite continuously toward an opaque tint', () => {
  for (const [width, height] of components)
    for (const dark of [0, 1])
      for (const incidence of [-1, 1])
        for (const inset of [1, 12, Math.min(width, height) / 2]) {
          assert.equal(envelope(width, height, inset, incidence, 0, dark), 0);
          assert.equal(envelope(width, height, inset, incidence, 1, dark), 0);
          const high = envelope(width, height, inset, incidence, 0.35, dark);
          const low = envelope(width, height, inset, incidence, 0.035, dark);
          assert.ok(Math.abs(low - high * 0.1) < 1e-12);
          let previous = 0;
          for (let step = 0; step <= 100; step++) {
            const opacity = step / 100;
            const optical = envelope(width, height, inset, incidence, opacity, dark);
            const composite = opacity + optical * (1 - opacity);
            assert.ok(
              composite >= previous - 1e-12,
              'Increasing transparency cannot add a material floor'
            );
            assert.ok(composite - previous < 0.025, 'No abrupt opacity step');
            previous = composite;
          }
          assert.equal(previous, 1);
        }
});
