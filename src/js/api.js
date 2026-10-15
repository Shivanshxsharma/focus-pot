/**
 * api.js — the bridge between this page and the Rust backend (loaded first)
 * ============================================================================
 * Tauri gives the page two tools (window.__TAURI__, enabled by
 * "withGlobalTauri" in tauri.conf.json):
 *
 *   invoke('command_name', { args })  → calls a #[tauri::command] in
 *                                        src-tauri/src/commands.rs, returns a promise
 *   listen('event', handler)          → receives events the backend emits
 *
 * This file wraps them in one small object, `window.nb`, so the rest of the
 * UI never talks to Tauri directly. Every command used here exists in
 * commands.rs (and is listed in lib.rs → generate_handler!). Argument names
 * are camelCase here and snake_case in Rust; Tauri converts between them.
 */

'use strict';

(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // Events the backend may push. Anything else is refused.
  const EVENT_CHANNELS = ['toggle-pin', 'toggle-timer', 'shots-changed', 'layout', 'look', 'outside-click'];

  window.nb = {
    // ── Window & app ──
    // The page tells Rust which rectangles are "solid" (clickable); Rust
    // makes everything else click-through and reports a mouse press anywhere
    // else (the 'outside-click' event).
    setHitRegions: (regions) => invoke('set_hit_regions', { regions }),
    quit: () => invoke('quit'),
    notify: (title, body) => invoke('notify', { title: String(title), body: String(body ?? '') }),
    // macOS theme: a blurred picture of what's behind the window (data: URL).
    glassSnapshot: () => invoke('glass_snapshot'),

    // ── State ──
    loadState: () => invoke('load_state'),
    saveState: (partial) => invoke('save_state', { partial }),

    // ── Media ──
    media: {
      state: () => invoke('media_state'),
      control: (sessionId, action) => invoke('media_control', { sessionId: String(sessionId), action: String(action) }),
      seek: (sessionId, seconds) => invoke('media_seek', { sessionId: String(sessionId), seconds: Number(seconds) }),
      setVolume: (value) => invoke('media_volume', { value: Number(value) }),
      setMute: (muted) => invoke('media_mute', { muted: Boolean(muted) }),
      key: (name) => invoke('media_key', { name: String(name) }),
    },

    // ── Links ──
    openUrl: (url) => invoke('open_url', { url: String(url) }),

    // ── Screenshots ──
    shots: {
      capture: () => invoke('shots_capture'),
      paste: () => invoke('shots_paste'),
      importWindows: () => invoke('shots_import'),
      openFolder: () => invoke('shots_open_folder'),
      list: (category) => invoke('shots_list', { category: String(category) }),
      thumb: (file) => invoke('shots_thumb', { file: String(file) }),
      open: (file) => invoke('shots_open', { file: String(file) }),
      copy: (file) => invoke('shots_copy', { file: String(file) }),
      remove: (file) => invoke('shots_delete', { file: String(file) }),
      setCategory: (file, category) => invoke('shots_set_category', { file: String(file), category: String(category) }),
    },

    // ── Events from the backend ──
    // Returns an "unsubscribe" function.
    on: (channel, callback) => {
      if (!EVENT_CHANNELS.includes(channel) || typeof callback !== 'function') return () => {};
      const pending = listen(channel, (event) => callback(event.payload));
      return () => pending.then((unlisten) => unlisten());
    },
  };
})();
