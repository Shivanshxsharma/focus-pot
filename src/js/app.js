/**
 * app.js — startup (loaded last)
 * ============================================================================
 * Loads your saved data from the Rust backend first, so the very first paint
 * already shows your theme, task and settings; then starts every module and
 * subscribes to the events the backend pushes.
 */

'use strict';

(async function startFocusPot() {
  try {
    const loaded = (await window.nb.loadState()) || {};
    Store.load(loaded.data, loaded.categories);

    Shell.init();
    Glass.init(); // before the theme, so it hears about the macOS theme
    Shell.applyLayout(loaded.layout);
    Shell.applyLook(loaded.look);
    Shell.applyTheme(Store.data.settings.theme);

    Timer.init();
    Tasks.init();
    Media.init();
    Links.init();
    Shots.init();
    Settings.init();
    Shell.selectTab('focus', false);

    // Pushed by the backend (see EVENT_CHANNELS in api.js).
    window.nb.on('outside-click', Shell.onOutsideClick);
    window.nb.on('layout', Shell.applyLayout);
    window.nb.on('look', Shell.applyLook);
    window.nb.on('toggle-pin', Shell.togglePin);
    window.nb.on('toggle-timer', Timer.toggle);
    window.nb.on('shots-changed', Shots.onExternalChange);
  } catch (err) {
    console.error('[Focus Pot] startup failed:', err);
  }
})();
