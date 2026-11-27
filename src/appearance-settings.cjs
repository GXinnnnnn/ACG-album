'use strict';
// Pure settings contract, shared by the worker and classic renderer scripts.
(function (root) {
  const ranges = Object.freeze({
    // Deprecated keys remain readable, but never override the independent defaults.
    liquidTransparency: { min: 0, max: 100, default: 18 },
    frostTransparency: { min: 0, max: 100, default: 8 },
    liquidFloatingTransparency: { min: 0, max: 100, default: 50 },
    liquidDialogTransparency: { min: 0, max: 100, default: 45 },
    frostFloatingTransparency: { min: 0, max: 100, default: 50 },
    frostDialogTransparency: { min: 0, max: 100, default: 40 },
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
  function interpolateCardSizes(viewportWidth, stops) {
    // CSS pixels already account for OS scaling and browser zoom.
    const value = Number(viewportWidth),
      width = Number.isFinite(value) && value > 0 ? value : 3840,
      upper = stops.findIndex((stop) => width <= stop.width);
    if (upper === 0) return [...stops[0].sizes];
    if (upper === -1) return [...stops[stops.length - 1].sizes];
    const from = stops[upper - 1],
      to = stops[upper],
      progress = (width - from.width) / (to.width - from.width);
    return from.sizes.map((size, index) => Math.round(size + (to.sizes[index] - size) * progress));
  }
  function cardPresets(viewportWidth = 3840) {
    return interpolateCardSizes(viewportWidth, [
      { width: 1920, sizes: [120, 155, 191] },
      { width: 2560, sizes: [124, 150, 188] },
      { width: 3840, sizes: [120, 155, 196] }
    ]);
  }
  // Preserve the old slider's typography and style at a numeric width. Updating
  // toolbar targets must not also rescale the contents of that same-width card.
  function legacyCardPresets(viewportWidth = 3840) {
    return interpolateCardSizes(viewportWidth, [
      { width: 1920, sizes: [120, 155, 191] },
      { width: 2560, sizes: [124, 150, 188] },
      { width: 3840, sizes: [135, 165, 192] }
    ]);
  }
  function cardScaleBase(viewportWidth = 3840) {
    return legacyCardPresets(viewportWidth)[1];
  }
  const spec = Object.freeze({
    ranges, defaults, valid, normalize, cardPresets, legacyCardPresets, cardScaleBase
  });
  if (typeof module === 'object' && module.exports) module.exports = spec;
  else root.albumAppearanceSpec = spec;
})(typeof window === 'object' ? window : globalThis);
