'use strict';
// Pure contract shared by the library worker and classic renderer scripts.
(function (root) {
  const builtinIds = Object.freeze(
    Array.from(
      { length: 7 },
      (_, index) => 'builtin-bilibili-' + String(index + 1).padStart(2, '0')
    )
  );
  const galleryLimit = 71; // Seven bundled and at most 64 managed custom images.
  const ranges = Object.freeze({
    wallpaperPositionX: Object.freeze({ min: 0, max: 100, default: 50 }),
    wallpaperPositionY: Object.freeze({ min: 0, max: 100, default: 50 }),
    wallpaperScale: Object.freeze({ min: 50, max: 300, default: 100 }),
    wallpaperMaskTransparency: Object.freeze({ min: 0, max: 100, default: 75 }),
    wallpaperBlurAmount: Object.freeze({ min: 0, max: 40, default: 14 })
  });
  const emptyTheme = () => ({ hidden: [], order: [], crops: {} });
  function freezeTheme() {
    const theme = emptyTheme();
    Object.values(theme).forEach(Object.freeze);
    return Object.freeze(theme);
  }
  const defaults = Object.freeze({
    wallpaperEnabled: false,
    wallpaperLight: 'builtin-bilibili-05',
    wallpaperDark: 'builtin-bilibili-07',
    wallpaperMask: true,
    wallpaperBlur: true,
    ...Object.fromEntries(Object.entries(ranges).map(([key, spec]) => [key, spec.default])),
    wallpaperGallery: Object.freeze({ version: 1, light: freezeTheme(), dark: freezeTheme() })
  });
  function isWallpaperId(value) {
    return (
      typeof value === 'string' &&
      (builtinIds.includes(value) || /^custom-[a-f0-9]{64}$/.test(value))
    );
  }
  function record(value, keys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    const own = Reflect.ownKeys(value);
    return (
      own.length === keys.length &&
      own.every(
        (key) =>
          keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
      )
    );
  }
  function idArray(value) {
    return (
      Array.isArray(value) &&
      Object.getPrototypeOf(value) === Array.prototype &&
      value.length <= galleryLimit &&
      Reflect.ownKeys(value).length === value.length + 1 &&
      Array.from(
        { length: value.length },
        (_, index) =>
          Object.hasOwn(value, index) &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, index), 'value') &&
          isWallpaperId(value[index])
      ).every(Boolean) &&
      new Set(value).size === value.length
    );
  }
  function inRange(value, range) {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= range.min &&
      value <= range.max
    );
  }
  function galleryValid(value) {
    if (!record(value, ['version', 'light', 'dark']) || value.version !== 1) return false;
    return ['light', 'dark'].every((theme) => {
      const entry = value[theme];
      if (
        !record(entry, ['hidden', 'order', 'crops']) ||
        !idArray(entry.hidden) ||
        !idArray(entry.order)
      )
        return false;
      const crops = entry.crops;
      if (!crops || typeof crops !== 'object' || Array.isArray(crops)) return false;
      const ids = Reflect.ownKeys(crops);
      if (ids.length > galleryLimit || !ids.every(isWallpaperId) || !record(crops, ids))
        return false;
      return ids.every((id) => {
        const crop = crops[id];
        return (
          record(crop, ['x', 'y', 'scale']) &&
          inRange(crop.x, ranges.wallpaperPositionX) &&
          inRange(crop.y, ranges.wallpaperPositionY) &&
          inRange(crop.scale, ranges.wallpaperScale)
        );
      });
    });
  }
  function cloneGallery(value) {
    return {
      version: 1,
      ...Object.fromEntries(
        ['light', 'dark'].map((theme) => [
          theme,
          {
            hidden: [...value[theme].hidden],
            order: [...value[theme].order],
            crops: Object.fromEntries(
              Object.entries(value[theme].crops).map(([id, crop]) => [
                id,
                {
                  x: crop.x,
                  y: crop.y,
                  scale: crop.scale
                }
              ])
            )
          }
        ])
      )
    };
  }
  function valid(key, value) {
    if (key === 'wallpaperGallery') {
      try {
        return galleryValid(value);
      } catch {
        return false;
      }
    }
    if (key === 'wallpaperLight' || key === 'wallpaperDark') return isWallpaperId(value);
    if (['wallpaperEnabled', 'wallpaperMask', 'wallpaperBlur'].includes(key))
      return typeof value === 'boolean';
    const range = Object.hasOwn(ranges, key) && ranges[key];
    return !!range && inRange(value, range);
  }
  function normalize(settings = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    return Object.fromEntries(
      Object.entries(defaults).map(([key, fallback]) => {
        const value = Object.hasOwn(source, key) ? source[key] : undefined;
        const normalized = valid(key, value) ? value : fallback;
        return [key, key === 'wallpaperGallery' ? cloneGallery(normalized) : normalized];
      })
    );
  }
  function cropFor(settings, theme, id) {
    const normalized = normalize(settings);
    const gallery = normalized.wallpaperGallery;
    if (
      (theme === 'light' || theme === 'dark') &&
      isWallpaperId(id) &&
      Object.hasOwn(gallery[theme].crops, id)
    )
      return { ...gallery[theme].crops[id] };
    // Missing per-image crops inherit the existing global values without rewriting them.
    return {
      x: normalized.wallpaperPositionX,
      y: normalized.wallpaperPositionY,
      scale: normalized.wallpaperScale
    };
  }
  const spec = Object.freeze({
    builtinIds,
    galleryLimit,
    ranges,
    defaults,
    isWallpaperId,
    valid,
    normalize,
    cropFor
  });
  if (typeof module === 'object' && module.exports) module.exports = spec;
  else root.albumWallpaperSpec = spec;
})(typeof window === 'object' ? window : globalThis);
