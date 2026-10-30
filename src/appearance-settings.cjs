'use strict';
// Pure settings contract, shared by the worker and classic renderer scripts.
(function (root) {
  const ranges = Object.freeze({
    liquidTransparency: { min: 0, max: 90, default: 18 },
    frostTransparency: { min: 0, max: 90, default: 8 },
    cardRadius: { min: 0, max: 36, default: 16 },
    density: { min: 120, max: 360, default: 222 }
  });
  const defaults = Object.freeze({
    textShadow: false,
    ...Object.fromEntries(Object.entries(ranges).map(([key, spec]) => [key, spec.default]))
  });
  function valid(key, value) {
    if (key === 'textShadow') return typeof value === 'boolean';
    const spec = ranges[key];
    return (
      !!spec &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= spec.min &&
      value <= spec.max
    );
  }
  function normalize(settings = {}) {
    return Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [
        key,
        valid(key, settings[key]) ? settings[key] : value
      ])
    );
  }
  const spec = Object.freeze({ ranges, defaults, valid, normalize });
  if (typeof module === 'object' && module.exports) module.exports = spec;
  else root.albumAppearanceSpec = spec;
})(typeof window === 'object' ? window : globalThis);
