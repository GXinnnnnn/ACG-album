'use strict';

// Application actions live in Settings. Retain the native edit-menu copy bridge.
(() => {
  document
    .querySelector('#sidebar-about')
    ?.addEventListener('click', () => attempt(() => window.showAbout()));
  window.album.onEvent((event) => {
    if (
      event?.type === 'application' &&
      event.data?.action === 'copy' &&
      document.querySelector('#viewer').open
    )
      document.querySelector('#viewer-copy').click();
  });
})();
