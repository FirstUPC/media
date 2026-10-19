/* Page-level controls; browser chrome and OS accessibility remain user-controlled. */
(() => {
  'use strict';
  const prevent = event => { if (event.cancelable) event.preventDefault(); };
  const active = { passive: false, capture: true };

  // Safari gesture events cover touchscreens and trackpads.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, prevent, active);
  }
  for (const type of ['touchstart', 'touchmove']) {
    document.addEventListener(type, event => {
      if (event.touches.length > 1) prevent(event);
    }, active);
  }
  document.addEventListener('wheel', event => {
    // Trackpad pinch also arrives as a Ctrl+wheel event in Chromium/Firefox.
    if (event.ctrlKey) prevent(event);
  }, active);
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey &&
        ['+', '=', '-', '_'].includes(event.key)) prevent(event);
  }, active);

  let locking = false;
  async function preferPortrait() {
    const orientation = window.screen?.orientation;
    if (locking || document.visibilityState === 'hidden' ||
        !window.matchMedia('(pointer: coarse)').matches ||
        typeof orientation?.lock !== 'function') return;
    locking = true;
    try {
      await orientation.lock('portrait-primary');
    } catch {
      // Safari/normal browser tabs may deny locking. Keep MediaShare usable.
    } finally {
      locking = false;
    }
  }
  preferPortrait();
  document.addEventListener('pointerup', preferPortrait, { once: true });
  document.addEventListener('fullscreenchange', preferPortrait);
  document.addEventListener('visibilitychange', preferPortrait);
  window.addEventListener('pageshow', preferPortrait);
})();
