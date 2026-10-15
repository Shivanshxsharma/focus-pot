/**
 * settings.js — the Settings tab
 * ============================================================================
 * Theme (Windows / Material / macOS Glass, plus how tinted the glass is),
 * mini player, reminder interval and dock position. Focus and break lengths live on the Focus tab itself.
 * Every change is saved immediately; dock changes make the backend move the
 * window (store.rs apply_from_ui → dock.rs relayout).
 */

'use strict';

const Settings = (() => {
  // Where people find updates, the source code and the issue tracker.
  const PROJECT_URL = 'https://github.com/Shivanshxsharma/focus-pot';

  // Why: number boxes save on every valid keystroke, ignore half-typed values
  // (like an empty box), and snap back to the last good value on leaving.
  function bindNumber(input, key, min, max, eventName = 'input') {
    input.value = Store.data.settings[key];
    input.addEventListener(eventName, () => {
      const n = Number(input.value);
      if (input.value === '' || !Number.isInteger(n) || n < min || n > max) return;
      if (Store.data.settings[key] === n) return;
      Store.data.settings[key] = n;
      Store.persist('settings');
    });
    input.addEventListener('change', () => {
      input.value = Store.data.settings[key];
    });
  }

  // Why: the theme tiles behave like a radio group.
  function renderThemePicker() {
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.setAttribute('aria-checked', String(button.dataset.themeChoice === Store.data.settings.theme));
    }
  }

  function setTheme(theme) {
    if (Store.data.settings.theme === theme) return;
    Store.data.settings.theme = theme;
    Store.persist('settings');
    Shell.applyTheme(theme);
    renderThemePicker();
    // The dial's look (gap, stroke) differs per theme; redraw it next frame.
    requestAnimationFrame(() => Timer.render());
    Shell.refreshFace();
  }

  function init() {
    for (const button of document.querySelectorAll('[data-theme-choice]')) {
      button.addEventListener('click', () => setTheme(button.dataset.themeChoice));
    }
    renderThemePicker();

    // Clear ↔ Tinted (macOS theme): live while dragging, saved on release.
    const glass = $('setGlass');
    const paintGlass = () => glass.style.setProperty('--pct', `${glass.value}%`);
    glass.value = Store.data.settings.glassTint;
    paintGlass();
    glass.addEventListener('input', () => {
      paintGlass();
      Store.data.settings.glassTint = Number(glass.value);
      Glass.setLook(glass.value);
    });
    glass.addEventListener('change', () => Store.persist('settings'));

    const mini = $('setMini');
    mini.checked = Store.data.settings.miniPlayer;
    mini.addEventListener('change', () => {
      Store.data.settings.miniPlayer = mini.checked;
      Store.persist('settings');
      Media.onMiniPlayerSetting();
    });

    // About: the version comes from the app itself (tauri.conf.json).
    window.__TAURI__.app
      .getVersion()
      .then((version) => {
        $('aboutVersion').textContent = `Version ${version} · Grow your focus.`;
      })
      .catch(() => {});
    $('aboutRepo').addEventListener('click', () => window.nb.openUrl(PROJECT_URL));

    bindNumber($('setRemind'), 'remindMin', 0, 240);
    // The offset moves the window, so apply it on Enter/blur, not per keystroke.
    bindNumber($('setOffset'), 'dockOffset', 0, 4000, 'change');

    // A themed dropdown instead of a native <select> (see Dropdown in dom.js).
    const dock = Dropdown.create({
      label: 'Dock position',
      value: Store.data.settings.dock,
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'taskbar', label: 'On taskbar' },
        { value: 'above', label: 'Above taskbar' },
      ],
      onChange: (value) => {
        Store.data.settings.dock = value;
        Store.persist('settings'); // the backend moves the window
      },
    });
    $('setDock').replaceWith(dock.root);
  }

  return { init };
})();
