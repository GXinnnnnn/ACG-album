'use strict';

// Delegate once for virtual and overview cards. Only the hovered card owns
// transient styles; pointer events schedule at most one frame, never a loop.
(() => {
  const root = document.documentElement,
    reduced = window.matchMedia('(prefers-reduced-motion: reduce)'),
    fine = window.matchMedia('(any-hover: hover) and (any-pointer: fine)'),
    selector = '.album-card:not(.card-skeleton), .collection-tile:not(.expanded)';
  let active = null,
    bounds = null,
    frame = 0,
    x = 0,
    y = 0;

  function clear() {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    if (active) {
      active.classList.remove('effects-active');
      active.style.removeProperty('--effect-rx');
      active.style.removeProperty('--effect-ry');
    }
    active = bounds = null;
  }
  function enabled(event) {
    return (
      root.dataset.motion === 'high' &&
      !reduced.matches &&
      fine.matches &&
      !document.hidden &&
      event.pointerType === 'mouse' &&
      !event.buttons
    );
  }
  function paint() {
    frame = 0;
    if (!active?.isConnected || document.hidden || reduced.matches || !fine.matches) {
      clear();
      return;
    }
    const clamp = (v) => Math.max(-1, Math.min(1, v)),
      dx = clamp(((x - bounds.left) / Math.max(1, bounds.width) - 0.5) * 2),
      dy = clamp(((y - bounds.top) / Math.max(1, bounds.height) - 0.5) * 2);
    active.style.setProperty('--effect-rx', (-dy * 2).toFixed(2) + 'deg');
    active.style.setProperty('--effect-ry', (dx * 2).toFixed(2) + 'deg');
  }
  function follow(event) {
    if (!enabled(event)) {
      clear();
      return;
    }
    const card = event.target?.closest?.(selector);
    if (!card || !card.isConnected) {
      clear();
      return;
    }
    if (card !== active) {
      clear();
      bounds = card.getBoundingClientRect();
      active = card;
      active.classList.add('effects-active');
    }
    x = event.clientX;
    y = event.clientY;
    if (!frame) frame = window.requestAnimationFrame(paint);
  }
  function leave(event) {
    if (active?.contains(event.target) && !active.contains(event.relatedTarget)) clear();
  }
  function apply(settings = {}) {
    const glass = settings.liquidGlass !== false ? 'on' : 'off',
      motion = ['low', 'medium', 'high'].includes(settings.motionLevel)
        ? settings.motionLevel
        : 'medium',
      changed = root.dataset.liquidGlass !== glass || root.dataset.motion !== motion;
    clear();
    root.dataset.liquidGlass = glass;
    root.dataset.motion = motion;
    if (changed) window.dispatchEvent(new Event('album-effects-change'));
  }

  document.addEventListener('pointerover', follow, { passive: true });
  document.addEventListener('pointermove', follow, { passive: true });
  document.addEventListener('pointerout', leave, { passive: true });
  document.addEventListener('pointercancel', clear, { passive: true });
  document.addEventListener('pointerdown', clear, { passive: true });
  document.addEventListener('keydown', clear);
  document.addEventListener('scroll', clear, { capture: true, passive: true });
  document.addEventListener('visibilitychange', clear);
  window.addEventListener('resize', clear, { passive: true });
  window.addEventListener('blur', clear);
  window.addEventListener('pagehide', clear);
  reduced.addEventListener('change', clear);
  fine.addEventListener('change', clear);
  window.album?.onEvent((event) => {
    if (event.type === 'window' && event.data?.inactive) clear();
  });
  window.albumEffects = Object.freeze({ apply });
  apply({
    liquidGlass: root.dataset.liquidGlass !== 'off',
    motionLevel: root.dataset.motion
  });
})();
