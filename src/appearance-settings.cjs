'use strict';
// Pure settings contract, shared by the worker and classic renderer scripts.
(function (root) {
  const ranges = Object.freeze({
    liquidTransparency: { min: 0, max: 90, default: 18 },
    frostTransparency: { min: 0, max: 90, default: 8 },
    cardRadius: { min: 0, max: 36, default: 16 },
    density: { min: 120, max: 360, default: 166 }
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
  function cardPresets(viewportWidth = 3840) {
    // CSS pixels already account for OS scaling and browser zoom. Physical
    // screen pixels would make a scaled 4K desktop select oversized targets.
    const width = Number(viewportWidth),
      progress = Math.max(
        0,
        Math.min(1, ((Number.isFinite(width) && width > 0 ? width : 3840) - 1920) / 1920)
      );
    return [120, 155, 191].map((compact, index) =>
      Math.round(compact + ([128, 166, 195][index] - compact) * progress)
    );
  }
  const spec = Object.freeze({ ranges, defaults, valid, normalize, cardPresets });
  if (typeof module === 'object' && module.exports) module.exports = spec;
  else root.albumAppearanceSpec = spec;
})(typeof window === 'object' ? window : globalThis);
