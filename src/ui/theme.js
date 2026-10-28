'use strict';

let requestedTheme = null;
let themeChangeTask = null;

// Coalesce rapid clicks to the final requested theme; never overlap snapshots or writes.
function changeTheme(theme) {
  if (theme !== 'light' && theme !== 'dark') return Promise.resolve();
  requestedTheme = theme;
  if (!themeChangeTask) {
    themeChangeTask = Promise.resolve()
      .then(async () => {
        while (requestedTheme !== S.settings.theme) await revealTheme(requestedTheme);
      })
      .finally(() => {
        requestedTheme = null;
        themeChangeTask = null;
      });
  }
  return themeChangeTask;
}
function toggleTheme() {
  return changeTheme((requestedTheme || S.settings.theme) === 'dark' ? 'light' : 'dark');
}
async function revealTheme(theme) {
  const root = document.documentElement;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const simple = () => motion.matches || root.dataset.motion === 'low' || document.hidden;
  const persist = async () => {
    await saveSetting('theme', theme);
    // A view-transition snapshot must include optical edges in the new palette.
    window.albumLiquidGlass?.refresh({ immediate: true });
  };
  if (!document.startViewTransition || simple()) {
    await persist();
    return;
  }
  const rect = document.querySelector('#theme-button').getBoundingClientRect();
  const x = rect.left + rect.width / 2,
    y = rect.top + rect.height / 2;
  let transition;
  root.classList.add('theme-revealing');
  window.albumLiquidGlass?.suspend(true);
  try {
    transition = document.startViewTransition(persist);
    try {
      await transition.ready;
    } catch {
      // A skipped snapshot still runs its update callback; preserve any save error.
      await transition.updateCallbackDone;
      return;
    }
    if (simple()) {
      transition.skipTransition();
      return;
    }
    const radius =
      Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))) + 2;
    const animation = root.animate(
      {
        clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]
      },
      {
        duration: root.dataset.motion === 'high' ? 340 : 280,
        easing: 'cubic-bezier(.2,0,.2,1)',
        fill: 'both',
        pseudoElement: '::view-transition-new(root)'
      }
    );
    const stop = () => {
      if (simple()) {
        animation.cancel();
        transition.skipTransition();
      }
    };
    const resize = () => {
      animation.cancel();
      transition.skipTransition();
    };
    motion.addEventListener('change', stop);
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('album-effects-change', stop);
    window.addEventListener('resize', resize, { once: true });
    try {
      await animation.finished.catch(() => {});
    } finally {
      motion.removeEventListener('change', stop);
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('album-effects-change', stop);
      window.removeEventListener('resize', resize);
      animation.cancel();
    }
  } finally {
    if (transition) {
      transition.skipTransition();
      await transition.finished.catch(() => {});
    }
    root.classList.remove('theme-revealing');
    window.albumLiquidGlass?.suspend(false);
  }
}
