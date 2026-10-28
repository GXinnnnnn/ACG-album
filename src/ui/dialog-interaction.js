'use strict';

// Shared policy for native dialogs, including dialogs created after startup.
(() => {
  if (window.albumDialogInteraction) return;
  const pointerMarker = 'data-dialog-focus-return';
  let pointerReturn = null;
  function clearPointerReturn() {
    pointerReturn?.removeAttribute(pointerMarker);
    pointerReturn = null;
  }
  function isBackdropClick(event) {
    const dialog = event.target;
    if (dialog?.tagName !== 'DIALOG' || !dialog.open) return false;
    const rect = dialog.getBoundingClientRect();
    return (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    );
  }
  document.addEventListener(
    'click',
    (event) => {
      if (!isBackdropClick(event)) return;
      // Stop legacy target-level light-dismiss listeners. Pointerdown, internal
      // controls, popovers and native cancel/Escape handling remain untouched.
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true
  );
  document.addEventListener('keydown', clearPointerReturn, true);
  document.addEventListener('pointerdown', clearPointerReturn, true);
  document.addEventListener(
    'focusout',
    (event) => {
      if (event.target === pointerReturn) clearPointerReturn();
    },
    true
  );
  function rememberFocus(element = document.activeElement) {
    return { element, keyboard: !!element?.matches?.(':focus-visible') };
  }
  function restoreFocus(snapshot) {
    clearPointerReturn();
    const element = snapshot?.element;
    if (!element?.isConnected || element.disabled || element.closest?.('[inert]')) return false;
    // Chromium versions differ in support for focusVisible:false. The marker
    // scopes that fallback to this pointer-origin return, until new input/blur.
    if (!snapshot.keyboard) {
      pointerReturn = element;
      element.setAttribute(pointerMarker, 'pointer');
    }
    element.focus({ preventScroll: true, focusVisible: !!snapshot.keyboard });
    if (document.activeElement !== element) {
      clearPointerReturn();
      return false;
    }
    return true;
  }
  window.albumDialogInteraction = { rememberFocus, restoreFocus, isBackdropClick };
})();
