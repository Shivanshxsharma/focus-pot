/**
 * media.js — the pill's music face, media cards and the volume slider
 * ============================================================================
 * Shows every media session Windows knows about (Spotify, each browser tab,
 * Media Player…) with album art, app icon, title, artist, a seekable
 * timeline and play/pause/next/previous for EACH session.
 *
 *   Taskbar pill  → the music face: art, title and ⏮ ⏯ ⏭ for the most
 *                   relevant session (swap to it with the › button)
 *   Media tab     → one card per session + the volume slider + media keys
 *
 * Data comes from the Rust backend (src-tauri/src/media.rs). How often we
 * ask depends on what's visible:
 *   Media tab open      → every second (timelines move smoothly)
 *   otherwise           → every 2.5 s, only if "Music in the pill" is on
 */

'use strict';

const Media = (() => {
  let el = null;
  let latest = { ok: true, sessions: [], volume: null, muted: false };
  let pollTimer = null;
  let pollEvery = 0;
  let polling = false;

  const cards = new Map(); // session id -> card component
  let pillSession = null;

  // The volume you're dragging wins over what the last poll reported.
  const local = { volume: 0, muted: false, touchedAt: 0 };
  let volumeBusy = false;
  let pendingVolume = null;

  // ── Polling ──

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const state = await window.nb.media.state();
      if (state) render(state);
    } catch (err) {
      render({ ok: false, message: String(err?.message || err), sessions: [], volume: null, muted: false });
    } finally {
      polling = false;
    }
  }

  // Why: picks the polling speed for what's on screen right now.
  function updatePolling() {
    const showingMedia = Shell.isOpen() && Shell.page() === 'media';
    const every = showingMedia ? 1000 : Store.data.settings.miniPlayer ? 2500 : 0;
    if (every === pollEvery) return;
    clearInterval(pollTimer);
    pollTimer = null;
    pollEvery = every;
    if (every) {
      poll();
      pollTimer = setInterval(poll, every);
    }
  }

  // Why: playing sessions first, then the one Windows calls "current".
  function sortSessions(list) {
    const rank = (s) => (s.status === 'Playing' ? 0 : s.isCurrent ? 1 : 2);
    return [...list].sort((a, b) => rank(a) - rank(b));
  }

  // Why: shared by cards and the pill.
  async function control(session, action) {
    if (!session) return;
    const result = await window.nb.media.control(session.id, action);
    if (result && !result.ok) setStatus(el.status, result.message, true);
    setTimeout(poll, 300);
  }

  // Why: Windows reports the position as of `updatedAt`; while playing we
  // add the time since then. Browsers sometimes report no timeline at all.
  function positionOf(s) {
    const elapsed = s.status === 'Playing' && s.updatedAt ? (Date.now() - s.updatedAt) / 1000 : 0;
    return Math.min(s.duration, Math.max(0, s.position + elapsed));
  }

  // ── One media card ──

  // Why a small "component": cards update in place every second, so we keep
  // references to their parts and only touch what changed (no flicker, hover
  // states survive, images aren't re-decoded). The same markup is laid out
  // differently by each theme (CSS grid areas in theme-*.css).
  function createCard() {
    let session = null;
    let seeking = null; // { fraction } while you drag the progress bar
    const shown = { icon: undefined, art: undefined };

    const bgImage = h('img', { alt: '' });
    const bg = h('div', { class: 'mc-bg', 'aria-hidden': 'true' }, bgImage);
    const iconSlot = h('span', { class: 'mc-app-icon' });
    const appName = h('span', { class: 'mc-app' });
    const title = h('div', { class: 'mc-title' });
    const artist = h('div', { class: 'mc-artist' });
    const thumb = h('div', { class: 'mc-thumb' });
    const position = h('span', { class: 'mc-pos' });
    const fill = h('div', { class: 'mc-bar-fill' });
    const bar = h('div', { class: 'mc-bar' }, fill);
    const seekArea = h('div', { class: 'mc-seek', role: 'slider', 'aria-label': 'Position', tabindex: '0' }, bar);
    const duration = h('span', { class: 'mc-dur' });
    const time = h('div', { class: 'mc-time' }, position, seekArea, duration);
    const toggleIcon = icon('play');

    const toggle = h('button', { class: 'btn-icon mc-play', title: 'Play', 'aria-label': 'Play or pause' }, toggleIcon);
    const prev = h('button', { class: 'btn-icon mc-prev', title: 'Previous', 'aria-label': 'Previous' }, icon('prev'));
    const next = h('button', { class: 'btn-icon mc-next', title: 'Next', 'aria-label': 'Next' }, icon('next'));

    toggle.addEventListener('click', () => {
      // Optimistic: flip the icon now; the next poll confirms it.
      session.status = session.status === 'Playing' ? 'Paused' : 'Playing';
      paint();
      control(session, 'toggle');
    });
    prev.addEventListener('click', () => control(session, 'prev'));
    next.addEventListener('click', () => control(session, 'next'));

    // ── Seeking: click or drag the bar; arrow keys jump 5 s ──
    const canSeek = () => session && session.canSeek && session.duration > 0;
    const fractionAt = (event) => {
      const r = bar.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
    };
    const showSeek = (fraction) => {
      bar.style.setProperty('--pct', `${fraction * 100}%`);
      position.textContent = formatDuration(fraction * session.duration);
    };
    async function seekTo(seconds) {
      // Pretend we're already there so the bar doesn't jump back before the
      // next poll confirms it.
      session.position = seconds;
      session.updatedAt = Date.now();
      paint();
      const result = await window.nb.media.seek(session.id, seconds);
      if (result && !result.ok) setStatus(el.status, result.message, true);
      setTimeout(poll, 400);
    }
    seekArea.addEventListener('pointerdown', (event) => {
      if (!canSeek()) return;
      seekArea.setPointerCapture(event.pointerId);
      seeking = { fraction: fractionAt(event) };
      root.classList.add('dragging');
      showSeek(seeking.fraction);
    });
    seekArea.addEventListener('pointermove', (event) => {
      if (!seeking) return;
      seeking.fraction = fractionAt(event);
      showSeek(seeking.fraction);
    });
    const endSeek = () => {
      if (!seeking) return;
      const seconds = seeking.fraction * session.duration;
      seeking = null;
      root.classList.remove('dragging');
      seekTo(seconds);
    };
    seekArea.addEventListener('pointerup', endSeek);
    seekArea.addEventListener('pointercancel', () => {
      seeking = null;
      root.classList.remove('dragging');
      paint();
    });
    seekArea.addEventListener('keydown', (event) => {
      if (!canSeek() || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      const step = event.key === 'ArrowRight' ? 5 : -5;
      seekTo(Math.min(session.duration, Math.max(0, positionOf(session) + step)));
      event.preventDefault();
    });

    const root = h(
      'article',
      { class: 'media-card' },
      bg,
      h('div', { class: 'mc-head' }, iconSlot, appName),
      h('div', { class: 'mc-text' }, title, artist),
      thumb,
      time,
      prev,
      toggle,
      next,
    );

    // Why: updates only the parts whose data changed since the last paint.
    function paint() {
      const s = session;
      const playing = s.status === 'Playing';
      root.classList.toggle('playing', playing);
      root.classList.toggle('no-art', !s.art);
      root.classList.toggle('seekable', canSeek());
      if (s.artColor) root.style.setProperty('--art-color', s.artColor);

      appName.textContent = s.appName;
      title.textContent = s.title || 'Unknown title';
      title.title = s.title;
      artist.textContent = s.artist || s.album || (playing ? 'Playing' : s.status);

      if (shown.icon !== s.icon) {
        shown.icon = s.icon;
        iconSlot.replaceChildren(s.icon ? h('img', { src: s.icon, alt: '' }) : icon('music-note'));
      }
      if (shown.art !== s.art) {
        shown.art = s.art;
        bg.hidden = !s.art;
        if (s.art) bgImage.src = s.art;
        thumb.replaceChildren(s.art ? h('img', { src: s.art, alt: '' }) : icon('music-note'));
      }

      time.hidden = !(s.duration > 0);
      if (s.duration > 0 && !seeking) {
        const pos = positionOf(s);
        position.textContent = formatDuration(pos);
        duration.textContent = formatDuration(s.duration);
        bar.style.setProperty('--pct', `${(pos / s.duration) * 100}%`);
        seekArea.setAttribute('aria-valuenow', String(Math.round(pos)));
        seekArea.setAttribute('aria-valuemax', String(Math.round(s.duration)));
      }

      prev.disabled = !s.canPrev;
      next.disabled = !s.canNext;
      toggle.disabled = !s.canToggle;
      setIcon(toggleIcon, playing ? 'pause' : 'play');
      toggle.title = playing ? 'Pause' : 'Play';
    }

    return {
      root,
      update(s) {
        session = s;
        paint();
      },
    };
  }

  // ── The pill's music face ──

  function renderPill(session) {
    pillSession = session;
    Shell.setMediaAvailable(!!session);
    if (!session) return;

    const playing = session.status === 'Playing';
    if (el.mini.dataset.art !== (session.art || '')) {
      el.mini.dataset.art = session.art || '';
      el.miniArt.replaceChildren(session.art ? h('img', { src: session.art, alt: '' }) : icon('music-note'));
    }
    el.miniTitle.textContent = session.title || session.appName;
    el.miniArtist.textContent = session.artist || session.appName;
    el.miniOpen.title = `${session.title || session.appName} · ${session.appName}`;
    el.miniPrev.disabled = !session.canPrev;
    el.miniNext.disabled = !session.canNext;
    el.miniToggle.disabled = !session.canToggle;
    setIcon(el.miniToggleIcon, playing ? 'pause' : 'play');
    el.miniToggle.title = playing ? 'Pause' : 'Play';
  }

  // ── Rendering ──

  function render(state) {
    latest = state;
    const sessions = sortSessions(state.sessions || []);

    // One card per session, matched by id so cards persist between polls.
    const seen = new Set();
    for (const s of sessions) {
      let card = cards.get(s.id);
      if (!card) {
        card = createCard();
        cards.set(s.id, card);
      }
      card.update(s);
      seen.add(s.id);
    }
    for (const [id, card] of cards) {
      if (!seen.has(id)) {
        card.root.remove();
        cards.delete(id);
      }
    }
    const ordered = sessions.map((s) => cards.get(s.id).root);
    const sameOrder = ordered.length === el.list.children.length && ordered.every((node, i) => el.list.children[i] === node);
    if (!sameOrder) el.list.replaceChildren(...ordered);

    el.empty.hidden = !state.ok || sessions.length > 0;
    if (!state.ok && state.message) setStatus(el.status, state.message, true);

    renderPill(sessions[0] || null);
    renderVolume(state);
  }

  // ── Volume ──

  function renderVolume(state) {
    const available = typeof state.volume === 'number';
    el.volume.disabled = !available;
    el.muteBtn.disabled = !available;
    if (!available) {
      el.volumeValue.textContent = '–';
      return;
    }
    if (Date.now() - local.touchedAt > 1500) {
      local.volume = state.volume;
      local.muted = state.muted;
    }
    paintVolume();
  }

  function paintVolume() {
    el.volume.value = String(local.volume);
    el.volume.style.setProperty('--pct', `${local.volume}%`);
    el.volumeValue.textContent = String(local.volume);
    setIcon(el.volumeIcon, local.muted || local.volume === 0 ? 'volume-x' : local.volume < 34 ? 'volume-low' : 'volume');
    el.muteBtn.title = local.muted ? 'Unmute' : 'Mute';
    el.muteBtn.setAttribute('aria-label', el.muteBtn.title);
  }

  // Why: dragging fires dozens of input events per second. We send one value
  // at a time, always the newest, so Windows never falls behind.
  async function queueVolume(value) {
    pendingVolume = value;
    if (volumeBusy) return;
    volumeBusy = true;
    while (pendingVolume !== null) {
      const next = pendingVolume;
      pendingVolume = null;
      await window.nb.media.setVolume(next);
    }
    volumeBusy = false;
  }

  function wire() {
    el.volume.addEventListener('input', () => {
      local.volume = Number(el.volume.value);
      local.touchedAt = Date.now();
      paintVolume();
      queueVolume(local.volume);
    });
    el.muteBtn.addEventListener('click', async () => {
      local.muted = !local.muted;
      local.touchedAt = Date.now();
      paintVolume();
      const result = await window.nb.media.setMute(local.muted);
      if (result && !result.ok) setStatus(el.status, result.message, true);
    });

    // The pill's buttons act on the session it shows.
    el.miniToggle.addEventListener('click', () => {
      if (!pillSession) return;
      pillSession.status = pillSession.status === 'Playing' ? 'Paused' : 'Playing';
      renderPill(pillSession);
      control(pillSession, 'toggle');
    });
    el.miniPrev.addEventListener('click', () => control(pillSession, 'prev'));
    el.miniNext.addEventListener('click', () => control(pillSession, 'next'));
    // Art / title opens the panel on the Media tab.
    el.miniOpen.addEventListener('click', Shell.openMedia);

    // "Other players": raw media keys for apps without a media session.
    for (const button of document.querySelectorAll('[data-key]')) {
      button.addEventListener('click', async () => {
        const result = await window.nb.media.key(button.dataset.key);
        if (result && !result.ok) setStatus(el.status, result.message, true);
        setTimeout(poll, 400);
      });
    }

    Shell.onChange(updatePolling);
  }

  // Why: called by Settings when "Music in the pill" is switched on or off.
  function onMiniPlayerSetting() {
    Shell.refreshFace();
    updatePolling();
  }

  function init() {
    el = {
      list: $('mediaList'),
      empty: $('mediaEmpty'),
      status: $('mediaStatus'),
      volume: $('volume'),
      volumeValue: $('volumeValue'),
      volumeIcon: $('volumeIcon'),
      muteBtn: $('muteBtn'),
      mini: $('mini'),
      miniOpen: $('miniOpen'),
      miniArt: $('miniArt'),
      miniTitle: $('miniTitle'),
      miniArtist: $('miniArtist'),
      miniPrev: $('miniPrev'),
      miniToggle: $('miniToggle'),
      miniToggleIcon: $('miniToggleIcon'),
      miniNext: $('miniNext'),
    };
    wire();
    renderVolume(latest);
    updatePolling();
  }

  return { init, onMiniPlayerSetting };
})();
