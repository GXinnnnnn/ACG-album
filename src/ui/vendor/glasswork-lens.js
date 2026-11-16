/*
 * Native backdrop rim lens adapted from kubai087/glasswork lens.js (MIT).
 * Copyright (c) 2026 Kubai087. See glasswork-LICENSE.
 * Source: https://github.com/kubai087/glasswork/blob/4f0b6744b898b3a9b98fbd913ab24fdb83c53162/lens.js
 * Local changes: bounded geometry/data-URL LRU, caller-driven fitting (no RAF
 * or observer), and cancellation/error handling for asynchronous tile decode.
 * Only backdrop-filter uses the SVG: foreground content is never filtered.
 */
'use strict';
((scope, factory) => {
  const kit = factory();
  if (typeof module === 'object' && module.exports) module.exports = kit;
  else scope.albumGlassworkLens = kit;
})(typeof window === 'undefined' ? null : window, () => {
const SVG = 'http://www.w3.org/2000/svg';
const ROUND_CORNER = 2;
const LENS_DEFAULTS = Object.freeze({ rim: 12, edge: 0.4, power: 2.6, dispersion: 0 });
function isLensSupported(win) {
  return !!win?.CSS?.supports?.('backdrop-filter', 'url(#a)') &&
    /Chrome\//.test(win.navigator?.userAgent || '') && !/Firefox\//.test(win.navigator?.userAgent || '');
}
const bound = (value, fallback, low, high) => {
  const n = Number(value);
  return Math.min(high, Math.max(low, Number.isFinite(n) ? n : fallback));
};
function lensGeometry(options = {}) {
  const width = Math.round(bound(options.width, 0, 0, 100000));
  const height = Math.round(bound(options.height, 0, 0, 100000));
  return {
    width, height,
    enabled: options.enabled !== false && width >= 32 && height >= 32 &&
      width <= 1600 && height <= 1200 && width * height <= 1100000,
    radius: Math.round(bound(options.radius, 0, 0, Math.min(64, width / 2, height / 2))),
    bezel: Math.round(bound(options.rim, LENS_DEFAULTS.rim, 4, Math.min(24, Math.max(4, Math.min(width, height) / 3.5)))),
    corner: bound(options.corner, ROUND_CORNER, 2, 8),
    power: bound(options.power, LENS_DEFAULTS.power, 1, 5),
    edge: bound(options.edge, LENS_DEFAULTS.edge, 0, 1),
    dispersion: bound(options.dispersion, LENS_DEFAULTS.dispersion, 0, 0.1)
  };
}
// The superellipse exponent of a computed CSS corner-shape. round is a
// circle and squircle is superellipse(2); anything else reads as round.
function cornerExponent(shape) {
  const value = String(shape || '').trim();
  if (value === 'squircle') return 4;
  const match = /^superellipse\(\s*([^)\s]+)\s*\)$/.exec(value);
  const k = match ? Number(match[1]) : Number.NaN;
  return Number.isFinite(k) && k >= 0 ? 2 ** k : ROUND_CORNER;
}

// ---------- The map ----------

// How much of the rim's bend a point keeps, `depth` of the way across it.
function rimStrength(depth, power) {
  return depth >= 1 ? 0 : (1 - Math.max(0, depth)) ** power;
}

// The rim's contours run from the outline (depth 0) to the rim's inner edge
// (depth 1), each the outline inset by that share of the rim. A corner
// tighter than the rim widens its inner contours toward one as wide as the
// rim, so the bend turns the corner smoothly instead of snapping along the
// diagonal (a seam the color split would light).
function contourRadius(depth, radius, bezel) {
  if (radius >= bezel) return radius - depth * bezel;
  return (1 - depth) * (radius + (bezel - radius) * depth * (2 - depth));
}

function isWithinContour(x, y, depth, radius, bezel, corner) {
  const inset = depth * bezel;
  if (x < inset || y < inset) return false;
  const curve = contourRadius(depth, radius, bezel);
  const center = inset + curve;
  if (x >= center || y >= center) return true;
  return ((center - x) / curve) ** corner + ((center - y) / curve) ** corner <= 1;
}

// The inward bend at a point `x` and `y` from a corner's two edges.
function bendNearCorner(x, y, radius, bezel, corner, power) {
  if (isWithinContour(x, y, 1, radius, bezel, corner)) return [0, 0];
  let depth = 0;
  if (isWithinContour(x, y, 0, radius, bezel, corner)) {
    // The contours are nested, so the depth a point lies at is found by halving.
    let low = 0;
    let high = 1;
    // 14 halvings place a point within 1/16000 of the rim: finer than a pixel.
    for (let step = 0; step < 14; step += 1) {
      const middle = (low + high) / 2;
      if (isWithinContour(x, y, middle, radius, bezel, corner)) low = middle;
      else high = middle;
    }
    depth = low;
  }
  const strength = rimStrength(depth, power);
  const curve = contourRadius(depth, radius, bezel);
  const center = depth * bezel + curve;
  if (x < center && y < center && curve > 0) {
    // Across the corner's curve: along its normal.
    const nx = Math.max(0, (center - x) / curve) ** (corner - 1);
    const ny = Math.max(0, (center - y) / curve) ** (corner - 1);
    const length = Math.hypot(nx, ny) || 1;
    return [(nx / length) * strength, (ny / length) * strength];
  }
  return x < y ? [strength, 0] : [0, strength];
}

// Inward offset at a point: unit direction times strength (1 at the rim's
// outer edge, 0 in the flat middle).
function rimDisplacement(x, y, width, height, { bezel, radius, corner = ROUND_CORNER, power = LENS_DEFAULTS.power }) {
  const rim = Math.min(bezel, height / 2, width / 2);
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const [inwardX, inwardY] = bendNearCorner(Math.min(x, width - x), Math.min(y, height - y), r, rim, corner, power);
  if (inwardX === 0 && inwardY === 0) return [0, 0];
  return [x < width / 2 ? inwardX : -inwardX, y < height / 2 ? inwardY : -inwardY];
}

// Where each tile sits on a surface of this size: corners (top left, top
// right, bottom left, bottom right) then edges (top, bottom, left, right).
function lensLayout(width, height, size) {
  const across = Math.max(1, width - size * 2);
  const down = Math.max(1, height - size * 2);
  return [
    [0, 0, size, size],
    [width - size, 0, size, size],
    [0, height - size, size, size],
    [width - size, height - size, size, size],
    [size, 0, across, size],
    [size, height - size, across, size],
    [0, size, size, down],
    [width - size, size, size, down],
  ];
}

// The tiles' pixels, read off a probe surface one pixel wider than two
// tiles. Red is the sideways bend and green the vertical one, 128 none.
function tilePixels(radius, bezel, corner, power) {
  const size = Math.max(1, Math.ceil(Math.max(radius, bezel)));
  const probe = size * 2 + 1;
  const geometry = { bezel, radius, corner, power };
  return {
    size,
    tiles: lensLayout(probe, probe, size).map(([left, top, w, h]) => {
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const [dx, dy] = rimDisplacement(left + x + 0.5, top + y + 0.5, probe, probe, geometry);
          const i = (y * w + x) * 4;
          data[i] = Math.round(128 + dx * 127);
          data[i + 1] = Math.round(128 + dy * 127);
          data[i + 2] = 128;
          data[i + 3] = 255;
        }
      }
      return { width: w, height: h, data };
    }),
  };
}


// Small PNG maps encode displacement only; no DOM/image capture and no blob URLs.
// Rejected entries are evicted so a later mount can retry without a poisoned LRU.
function createTileCache(limit = 16) {
  const entries = new Map();
  const cap = Math.round(bound(limit, 16, 1, 48));
  return {
    get(key, build) {
      if (entries.has(key)) {
        const hit = entries.get(key);
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const entry = Promise.resolve().then(build);
      entries.set(key, entry);
      while (entries.size > cap) entries.delete(entries.keys().next().value);
      entry.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
      return entry;
    },
    size: () => entries.size
  };
}
const tileCaches = new WeakMap();
function lensTiles(doc, radius, bezel, corner, power) {
  let cache = tileCaches.get(doc);
  if (!cache) tileCaches.set(doc, cache = createTileCache());
  const key = [radius, bezel, corner.toFixed(3), power.toFixed(3)].join(':');
  return cache.get(key, async () => {
    const { size, tiles } = tilePixels(radius, bezel, corner, power);
    const urls = await Promise.all(tiles.map(async (tile) => {
      const canvas = doc.createElement('canvas');
      canvas.width = tile.width;
      canvas.height = tile.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Lens map canvas unavailable');
      const image = context.createImageData(tile.width, tile.height);
      image.data.set(tile.data);
      context.putImageData(image, 0, 0);
      const url = canvas.toDataURL('image/png');
      const decoded = new doc.defaultView.Image();
      decoded.src = url;
      await decoded.decode();
      return url;
    }));
    return { size, urls };
  });
}
function node(doc, tag, attrs, parent) {
  const el = doc.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  parent?.append(el);
  return el;
}

let filterCount = 0;

// The lens tiles over a flat flood make the map; the backdrop is displaced
// by it once, or once per color channel by its own share of the bend, the
// three added back together (screen on single channels is a sum). Each
// filter gets an <svg> of its own: adding one to an <svg> that holds others
// can make Chrome reload all their images, and a backdrop naming a filter
// whose images are reloading drops its blur.
function buildFilter(doc, width, height, tiles, split) {
  const id = `liquid-glass-lens-${++filterCount}`;
  const host = node(doc, 'svg', {
    'aria-hidden': 'true', 'data-glasswork-lens-defs': '', width: 0, height: 0,
    style: 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none',
  });
  const filter = node(doc, 'filter', {
    id, filterUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB', x: 0, y: 0, width, height,
  }, host);
  node(doc, 'feFlood', { 'flood-color': 'rgb(128,128,128)', result: 'flat' }, filter);
  const rects = lensLayout(width, height, tiles.size);
  const pieces = rects.map(([x, y, w, h], index) => node(doc, 'feImage', {
    href: tiles.urls[index], preserveAspectRatio: 'none', x, y, width: w, height: h, result: `t${index}`,
  }, filter));
  const merge = node(doc, 'feMerge', { result: 'map' }, filter);
  node(doc, 'feMergeNode', { in: 'flat' }, merge);
  rects.forEach((_, index) => node(doc, 'feMergeNode', { in: `t${index}` }, merge));
  const passes = [];
  const pass = () => {
    passes.push({
      el: node(doc, 'feDisplacementMap', { in: 'SourceGraphic', in2: 'map', xChannelSelector: 'R', yChannelSelector: 'G', scale: 0 }, filter),
    });
  };
  if (split) {
    ['r', 'g', 'b'].forEach((name, channel) => {
      pass();
      // Keeps this channel and alpha: a 1 on the 4x5 matrix's diagonal.
      const keep = Array.from({ length: 20 }, (_, cell) => Number(cell === channel * 6 || cell === 18)).join(' ');
      node(doc, 'feColorMatrix', { type: 'matrix', values: keep, result: name }, filter);
    });
    node(doc, 'feBlend', { in: 'r', in2: 'g', mode: 'screen' }, filter);
    node(doc, 'feBlend', { in2: 'b', mode: 'screen' }, filter);
  } else {
    pass();
  }
  doc.body.append(host);
  return { id, host, filter, pieces, passes, tiles };
}

function placeFilter(lens, width, height) {
  lens.filter.setAttribute('width', width);
  lens.filter.setAttribute('height', height);
  lensLayout(width, height, lens.tiles.size).forEach(([x, y, w, h], index) => {
    const piece = lens.pieces[index];
    piece.setAttribute('x', x);
    piece.setAttribute('y', y);
    piece.setAttribute('width', w);
    piece.setAttribute('height', h);
  });
}


// Geometry is supplied by the existing mount/discover scheduler. No second RAF,
// resize observer, timers, or perpetual work is installed by an individual lens.
function createLens(el, options = {}) {
  const doc = el.ownerDocument;
  const win = options.win || doc.defaultView;
  const supported = isLensSupported(win);
  const property = '--glass-lens';
  let current = null, token = 0, destroyed = false, pendingKey = '', pending = null;
  let state = 'idle', error = '';
  const notify = () => options.onChange?.();
  const clear = () => {
    token++;
    pendingKey = '';
    pending = null;
    el.style.removeProperty(property);
    current?.lens.host.remove();
    current = null;
  };
  const setScale = (lens, geometry) => {
    lens.passes.forEach((pass, channel) => {
      const share = lens.passes.length > 1 ? 1 + (1 - channel) * geometry.dispersion : 1;
      pass.el.setAttribute('scale', (2 * geometry.edge * geometry.bezel * share).toFixed(1));
    });
  };
  return {
    supported,
    update(next = {}) {
      if (destroyed) return Promise.resolve(false);
      const g = lensGeometry(next);
      if (!supported || !g.enabled || !el.isConnected) {
        clear();
        state = 'disabled';
        notify();
        return Promise.resolve(false);
      }
      const key = [g.radius, g.bezel, g.corner.toFixed(3), g.power.toFixed(3), g.dispersion > 0].join(':');
      const fitKey = [key, g.width, g.height, g.edge, g.dispersion].join(':');
      if (pendingKey === fitKey) return pending;
      const mine = ++token;
      pendingKey = '';
      if (current?.key === key) {
        if (current.width !== g.width || current.height !== g.height) {
          placeFilter(current.lens, g.width, g.height);
          current.width = g.width;
          current.height = g.height;
        }
        setScale(current.lens, g);
        state = 'ready';
        return Promise.resolve(true);
      }
      state = 'pending';
      pendingKey = fitKey;
      pending = lensTiles(doc, g.radius, g.bezel, g.corner, g.power).then((tiles) => {
        if (destroyed || mine !== token || !el.isConnected || options.isEnabled?.() === false) return false;
        const lens = buildFilter(doc, g.width, g.height, tiles, g.dispersion > 0);
        try {
          setScale(lens, g);
          el.style.setProperty(property, 'url(#' + lens.id + ')');
        } catch (failure) {
          lens.host.remove();
          throw failure;
        }
        current?.lens.host.remove();
        current = { key, lens, width: g.width, height: g.height };
        pendingKey = '';
        state = 'ready';
        error = '';
        notify();
        return true;
      }).catch((failure) => {
        if (destroyed || mine !== token) return false;
        clear();
        state = 'css-fallback';
        error = String(failure?.message || failure);
        notify();
        return false;
      });
      return pending;
    },
    cancelPending() {
      if (destroyed || state !== 'pending') return;
      token++;
      pendingKey = '';
      pending = null;
      state = current ? 'ready' : 'idle';
    },
    stats: () => ({ state, error, applied: !!current, supported }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clear();
      state = 'destroyed';
    }
  };
}
return { LENS_DEFAULTS, isLensSupported, lensGeometry, rimDisplacement, createTileCache, createLens };
});
