/**
 * shell.js — the taskbar pill, opening/closing the panel, tabs, themes
 * ============================================================================
 * Behaviour: tap to open, like Windows 11's own taskbar flyouts.
 *   • tap the timer face of the pill → the panel opens; tap it again → closes
 *   • tap the art/title on the music face → the panel opens on Media
 *   • the music face's ⏮ ⏯ ⏭ work right there, without opening anything
 *   • the › button swaps the pill between timer and music
 *   • a tap anywhere outside, or Esc, closes it, unless it's pinned (the pin
 *     in the footer, or Ctrl+Alt+F)
 * Hovering only highlights, it never opens or closes anything.
 *
 * Click-through: the window is a big transparent rectangle. We send the
 * backend the rectangles that are "solid" (the pill, the open panel, an
 * open menu); Rust makes everything else click-through, and sends an
 * 'outside-click' event when a mouse button goes down anywhere else (the
 * page can't see those clicks itself: they go to the app underneath).
 *
 * Tabs: the indicator slides under (or, in the macOS theme, behind) the
 * selected tab and the pages, side by side in .pager-track, slide sideways.
 *
 * Themes: <html data-ui="windows|material|mac"> switches the CSS; each theme
 * also has its own icon set, copied from a <template> into the live sprite.
 */

'use strict';

const Shell = (() => {
  const TABS = ['focus', 'tasks', 'media', 'links', 'shots', 'settings'];
  const THEMES = { windows: 'iconsWindows', material: 'iconsMaterial', mac: 'iconsMac' };
  const EASE = 'cubic-bezier(0.2, 0, 0, 1)';
  const ui = {
    open: false,
    pinned: false,
    tab: 'focus',
    theme: null,
    mediaAvailable: false,
    indicator: null, // where the tab indicator sits now: { x, width }
    regionsFrame: 0,
    lastRegions: '',
  };
  const listeners = [];
  let el = null;

  // Why: other modules (media polling, the gallery, the glass backdrop) react
  // to the panel opening/closing, the tab or the theme changing, without
  // Shell knowing about them.
  function onChange(listener) {
    listeners.push(listener);
  }

  function emitChange() {
    for (const listener of listeners) listener({ open: ui.open, page: ui.tab, theme: ui.theme });
  }

  // ── What the backend tells us ──

  // Why: Rust knows where the taskbar is; we turn its numbers into CSS variables.
  function applyLayout(layout) {
    if (!layout) return;
    const style = document.documentElement.style;
    style.setProperty('--left', `${layout.left}px`);
    style.setProperty('--trigger-h', `${layout.triggerHeight}px`);
    style.setProperty('--trigger-bottom', `${layout.triggerBottom}px`);
    style.setProperty('--flyout-bottom', `${layout.flyoutBottom}px`);
    document.body.dataset.dock = layout.mode;
    scheduleRegions();
    emitChange(); // the glass backdrop has to line up again
  }

  // Why: the taskbar's light/dark mode decides the pill's text colour, and
  // every theme is built from your Windows accent palette.
  function applyLook(look) {
    if (!look) return;
    const root = document.documentElement;
    root.dataset.taskbar = look.taskbarDark ? 'dark' : 'light';
    for (const [name, value] of Object.entries(look.accent || {})) {
      root.style.setProperty(`--accent-${name}`, value);
    }
  }

  // Why: switching theme = switching the CSS (data-ui) AND the icon set.
  // Every <use href="#i-…"> keeps its name; only the symbols behind it change.
  function applyTheme(name) {
    const theme = name in THEMES ? name : 'windows';
    if (theme === ui.theme) return;
    ui.theme = theme;
    document.documentElement.dataset.ui = theme;

    const source = $(THEMES[theme]).content.querySelector('svg');
    el.sprite.replaceChildren(...Array.from(source.children, (node) => node.cloneNode(true)));
    // Re-setting href makes every <use> look up its (new) symbol again.
    for (const use of document.querySelectorAll('use')) use.setAttribute('href', use.getAttribute('href'));

    requestAnimationFrame(() => {
      moveIndicator();
      scheduleRegions();
    });
    emitChange();
  }

  // ── Click-through regions ──

  // Why: offsetLeft/Top ignore CSS transforms, so the panel's slide-in
  // animation doesn't make the region jump around.
  function rectOf(node, pad = 2) {
    return { x: node.offsetLeft - pad, y: node.offsetTop - pad, width: node.offsetWidth + pad * 2, height: node.offsetHeight + pad * 2 };
  }

  // Why: batched to once per frame, and only sent when something changed.
  function scheduleRegions() {
    if (ui.regionsFrame) return;
    ui.regionsFrame = requestAnimationFrame(() => {
      ui.regionsFrame = 0;
      const regions = [rectOf(el.trigger)];
      if (ui.open) regions.push(rectOf(el.flyout, 0));
      for (const menu of el.popupLayer.children) regions.push(rectOf(menu));
      const key = JSON.stringify(regions);
      if (key === ui.lastRegions) return;
      ui.lastRegions = key;
      window.nb.setHitRegions(regions);
    });
  }

  // ── Open / close ──

  // Why: `tab` lets the music face open the panel straight on Media. The
  // tab only slides when the panel was already visible.
  function open(tab) {
    if (tab) selectTab(tab, ui.open);
    if (ui.open) return;
    ui.open = true;
    el.flyout.classList.add('open');
    el.triggerMain.setAttribute('aria-expanded', 'true');
    moveIndicator();
    scheduleRegions();
    emitChange();
  }

  // Why: also closes menus and drops keyboard focus, so a hidden text box
  // can't swallow keys.
  function close() {
    if (!ui.open) return;
    ui.open = false;
    Dropdown.closeAll();
    el.flyout.classList.remove('open');
    el.triggerMain.setAttribute('aria-expanded', 'false');
    const active = document.activeElement;
    if (active && el.flyout.contains(active)) active.blur();
    scheduleRegions();
    emitChange();
  }

  // Why: closing by hand (pill, Esc, Ctrl+Alt+F) also drops the pin, so the
  // next tap outside behaves normally again.
  function dismiss() {
    setPinned(false);
    close();
  }

  // Tap on the timer face: open, or close if it's already open.
  function onTriggerClick() {
    if (ui.open) dismiss();
    else open();
  }

  // Tap on the music face's art/title: the panel on Media (or close it if
  // that's exactly what's showing).
  function openMedia() {
    if (ui.open && ui.tab === 'media') dismiss();
    else open('media');
  }

  // Why: Rust saw a mouse button go down outside every solid region, i.e.
  // you clicked another app, the desktop or the taskbar.
  function onOutsideClick() {
    if (ui.open && !ui.pinned) close();
  }

  // ── Pinning ──

  function setPinned(pinned) {
    ui.pinned = pinned;
    el.pinBtn.classList.toggle('on', pinned);
    el.pinBtn.setAttribute('aria-pressed', String(pinned));
    el.pinBtn.title = pinned ? 'Unpin (Ctrl+Alt+F)' : 'Keep open (Ctrl+Alt+F)';
    setIcon(el.pinIcon, pinned ? 'pin-fill' : 'pin');
    if (pinned) open();
  }

  // Why: Ctrl+Alt+F: open and pin, or unpin and close.
  function togglePin() {
    if (ui.pinned) dismiss();
    else setPinned(true);
  }

  // ── The pill's two faces (timer ⇄ music) ──

  // Why: the music face only makes sense when something is playing and the
  // "Music in the pill" setting is on; otherwise it's always the timer.
  function wantedFace() {
    const s = Store.data.settings;
    return ui.mediaAvailable && s.miniPlayer ? s.pillFace : 'timer';
  }

  // Why: swapping animates the pill's width (it gets wider or narrower) and
  // slides the new content in, so the change feels deliberate, not jumpy.
  function renderFace(animate) {
    const next = wantedFace();
    const canSwap = ui.mediaAvailable && Store.data.settings.miniPlayer;
    el.faceSwap.hidden = !canSwap;
    el.faceSwap.title = next === 'timer' ? 'Show music' : 'Show timer';
    if (next !== el.trigger.dataset.face) {
      const before = el.trigger.offsetWidth;
      el.trigger.dataset.face = next;
      if (animate) {
        const after = el.trigger.offsetWidth;
        el.trigger.animate([{ width: `${before}px` }, { width: `${after}px` }], { duration: 300, easing: EASE });
        const shown = el.trigger.querySelector(next === 'media' ? '.face-media' : '.face-timer');
        shown.animate(
          [
            { opacity: 0, transform: `translateX(${next === 'media' ? 16 : -16}px)` },
            { opacity: 1, transform: 'none' },
          ],
          { duration: 300, easing: EASE },
        );
      }
    }
    scheduleRegions();
  }

  function swapFace() {
    Store.data.settings.pillFace = wantedFace() === 'timer' ? 'media' : 'timer';
    Store.persist('settings');
    renderFace(true);
  }

  // Why: Media calls this when sessions appear or disappear.
  function setMediaAvailable(available) {
    if (ui.mediaAvailable === available) return;
    ui.mediaAvailable = available;
    renderFace(true);
  }

  // ── Tabs ──

  // Why: each theme sizes the indicator its own way (--ind-size):
  //   a number → a fixed pill that wide (Windows: 16px)
  //   content  → as wide as the tab's label (Material)
  //   tab      → the whole tab, a capsule behind it (macOS)
  // and moves it its own way: CSS transitions, or (--ind-motion: liquid)
  // the drop-like motion of flowIndicator.
  function moveIndicator(animate = false) {
    const tab = el.tabBar.querySelector(`[data-tab="${ui.tab}"]`);
    if (!tab) return;
    const style = getComputedStyle(el.tabBar);
    const size = style.getPropertyValue('--ind-size').trim();
    const label = tab.querySelector('span');
    let width;
    if (size === 'tab') width = tab.offsetWidth;
    else if (size === 'content') width = Math.max(label ? label.offsetWidth : 0, 24);
    else width = parseFloat(size) || 16;
    const x = tab.offsetLeft + (tab.offsetWidth - width) / 2;
    if (animate && ui.indicator && style.getPropertyValue('--ind-motion').trim() === 'liquid') {
      flowIndicator(ui.indicator, { x, width });
    }
    el.indicator.style.setProperty('--ind-x', `${x}px`);
    el.indicator.style.setProperty('--ind-w', `${width}px`);
    ui.indicator = { x, width };
  }

  // Why: Liquid Glass selections move like a drop of liquid. The leading
  // edge races to the new tab while the trailing edge lags, so the thumb
  // stretches on the way and settles into place. With Windows' animation
  // effects off it simply slides.
  function flowIndicator(from, to) {
    if (from.x === to.x && from.width === to.width) return;
    const frame = (left, right) => ({ transform: `translateX(${left}px)`, width: `${right - left}px` });
    const fromRight = from.x + from.width;
    const toRight = to.x + to.width;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.indicator.animate([frame(from.x, fromRight), frame(to.x, toRight)], { duration: 200, easing: 'ease' });
      return;
    }
    const stretched =
      to.x > from.x
        ? frame(from.x + (to.x - from.x) * 0.2, toRight) // moving right: the right edge is already there
        : frame(to.x, fromRight + (toRight - fromRight) * 0.2); // moving left: the left edge is
    el.indicator.animate([frame(from.x, fromRight), { ...stretched, offset: 0.42 }, frame(to.x, toRight)], {
      duration: 480,
      easing: 'cubic-bezier(0.3, 0.8, 0.25, 1)',
    });
  }

  // Why: one function selects a tab everywhere: aria state, the sliding
  // indicator, the sliding pages, and `inert` so off-screen pages can't be
  // tabbed into.
  function selectTab(name, animate = true) {
    const index = TABS.indexOf(name);
    if (index < 0) return;
    ui.tab = name;
    Dropdown.closeAll();
    for (const tab of el.tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    for (const page of el.pages) page.inert = page.dataset.page !== name;

    if (!animate) {
      el.track.style.transition = 'none';
      el.indicator.style.transition = 'none';
    }
    el.track.style.setProperty('--page-index', String(index));
    moveIndicator(animate);
    if (!animate) {
      void el.track.offsetWidth; // apply without animation, then restore transitions
      el.track.style.transition = '';
      el.indicator.style.transition = '';
    }
    emitChange();
  }

  // Why: ← / → move between tabs, like any tab list.
  function onTabKeys(event) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = TABS[(TABS.indexOf(ui.tab) + step + TABS.length) % TABS.length];
    selectTab(next);
    el.tabBar.querySelector(`[data-tab="${next}"]`).focus();
    event.preventDefault();
  }

  // ── Wiring ──

  function wire() {
    el.triggerMain.addEventListener('click', onTriggerClick);
    el.faceSwap.addEventListener('click', swapFace);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (Dropdown.isOpen()) Dropdown.closeAll();
      else dismiss();
    });

    el.tabBar.addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (tab) selectTab(tab.dataset.tab);
    });
    el.tabBar.addEventListener('keydown', onTabKeys);

    el.pinBtn.addEventListener('click', () => setPinned(!ui.pinned));
    el.quitBtn.addEventListener('click', () => window.nb.quit());

    // Keep the click-through regions in sync with what's on screen.
    new ResizeObserver(scheduleRegions).observe(el.trigger);
    new ResizeObserver(scheduleRegions).observe(el.flyout);
    window.addEventListener('popupchange', scheduleRegions);
    window.addEventListener('resize', scheduleRegions);

    // Web fonts change label widths once they've loaded.
    document.fonts.ready.then(() => {
      moveIndicator();
      scheduleRegions();
    });
  }

  function init() {
    el = {
      sprite: $('sprite'),
      trigger: $('trigger'),
      triggerMain: $('triggerMain'),
      faceSwap: $('faceSwap'),
      flyout: $('flyout'),
      tabBar: $('tabs'),
      tabs: document.querySelectorAll('.tab'),
      indicator: $('tabIndicator'),
      track: $('pagerTrack'),
      pages: document.querySelectorAll('.page'),
      pinBtn: $('pinBtn'),
      pinIcon: $('pinIcon'),
      quitBtn: $('quitBtn'),
      popupLayer: $('popupLayer'),
    };
    wire();
    renderFace(false);
  }

  return {
    init,
    open,
    close,
    openMedia,
    selectTab,
    setPinned,
    togglePin,
    onChange,
    onOutsideClick,
    applyLayout,
    applyLook,
    applyTheme,
    setMediaAvailable,
    refreshFace: () => renderFace(true),
    isOpen: () => ui.open,
    page: () => ui.tab,
    theme: () => ui.theme,
  };
})();
