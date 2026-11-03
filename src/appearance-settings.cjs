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
    const value = Number(viewportWidth),
      width = Number.isFinite(value) && value > 0 ? value : 3840,
      stops = [
        { width: 1920, sizes: [120, 155, 191] },
        { width: 2560, sizes: [124, 150, 188] },
        { width: 3840, sizes: [135, 165, 192] }
      ],
      upper = stops.findIndex((stop) => width <= stop.width);
    if (upper === 0) return [...stops[0].sizes];
    if (upper === -1) return [...stops[stops.length - 1].sizes];
    const from = stops[upper - 1],
      to = stops[upper],
      progress = (width - from.width) / (to.width - from.width);
    return from.sizes.map((size, index) => Math.round(size + (to.sizes[index] - size) * progress));
  }
  const spec = Object.freeze({ ranges, defaults, valid, normalize, cardPresets });
  if (typeof module === 'object' && module.exports) module.exports = spec;
  else root.albumAppearanceSpec = spec;
})(typeof window === 'object' ? window : globalThis);
