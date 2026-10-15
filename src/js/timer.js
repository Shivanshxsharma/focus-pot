/**
 * timer.js — the Pomodoro timer and its controls
 * ============================================================================
 * The timer stores WHEN the current phase ends (endAt), not how many ticks
 * are left. Every 500ms it recomputes the remaining time from Date.now(), so
 * it can't drift even if a tick arrives late.
 *
 * Drawn in three places: the taskbar button (time, task, a small progress
 * ring), the Focus tab (big dial, Start/Reset/Skip, presets and steppers to
 * change the session lengths) and the footer's "today" counter.
 */

'use strict';

const Timer = (() => {
  const t = {
    mode: 'focus', // 'focus' | 'break'
    running: false,
    endAt: 0,
    remainingMs: 25 * 60 * 1000,
    lastReminderAt: Date.now(),
  };

  // One-click session lengths (focus / break, in minutes).
  const PRESETS = [
    { name: 'Classic', focus: 25, rest: 5 },
    { name: 'Quick', focus: 15, rest: 3 },
    { name: 'Deep', focus: 50, rest: 10 },
    { name: 'Long', focus: 90, rest: 15 },
  ];
  const LIMITS = { focusMin: [5, 180], breakMin: [1, 60] };
  const DIAL_C = 2 * Math.PI * 88; // circumference of the big dial (r = 88)
  const RING_C = 2 * Math.PI * 14; // circumference of the taskbar ring (r = 14)

  let el = null;

  // Why: phase lengths always come from the current settings.
  function phaseMs(mode) {
    const s = Store.data.settings;
    return (mode === 'focus' ? s.focusMin : s.breakMin) * 60 * 1000;
  }

  function start() {
    if (t.running) return;
    if (t.remainingMs <= 0) t.remainingMs = phaseMs(t.mode);
    t.endAt = Date.now() + t.remainingMs;
    t.running = true;
    t.lastReminderAt = Date.now(); // starting counts as "I'm on it"
    render();
  }

  // Why: freezes the remaining time so Resume continues where you left off.
  function pause() {
    if (!t.running) return;
    t.remainingMs = Math.max(0, t.endAt - Date.now());
    t.running = false;
    render();
  }

  // Why: shared by the Start button and Ctrl+Alt+P.
  function toggle() {
    if (t.running) pause();
    else start();
  }

  // Why: back to a full phase of the CURRENT mode (focus stays focus).
  function reset() {
    t.running = false;
    t.remainingMs = phaseMs(t.mode);
    render();
  }

  // Why: jump straight to the other phase without counting a session
  // (e.g. you want your break now, or you're back early).
  function skip() {
    t.running = false;
    t.mode = t.mode === 'focus' ? 'break' : 'focus';
    t.remainingMs = phaseMs(t.mode);
    t.lastReminderAt = Date.now();
    render();
  }

  // Why: everything that happens when a countdown hits zero lives here.
  // The next phase is prepared but NOT started, so you decide when to go on.
  function finishPhase() {
    t.running = false;
    t.lastReminderAt = Date.now(); // don't stack a reminder on top of this toast
    const task = Tasks.active();

    if (t.mode === 'focus') {
      rollDateIfNeeded();
      Store.data.stats.pomos += 1;
      Store.persist('stats');
      Tasks.addPomodoro();
      renderToday();
      window.nb.notify('Focus Pot', `Focus session done – take a ${Store.data.settings.breakMin} min break`);
      t.mode = 'break';
    } else {
      window.nb.notify('Focus Pot', task ? `Break over – back to: ${task.text}` : 'Break over – back to focus');
      t.mode = 'focus';
    }
    t.remainingMs = phaseMs(t.mode);
    render();
    pulse();
  }

  // Why: a quick flash on the taskbar button (CSS runs it 3 times).
  function pulse() {
    el.triggerMain.classList.remove('pulse');
    void el.triggerMain.offsetWidth; // restart the animation
    el.triggerMain.classList.add('pulse');
  }

  // Why: "sessions today" must reset by itself after midnight.
  function rollDateIfNeeded() {
    const today = todayKey();
    if (Store.data.stats.date === today) return;
    Store.data.stats = { date: today, pomos: 0 };
    Store.persist('stats');
    renderToday();
  }

  // Why: a gentle "still on it?" nudge. Skipped during a running break and
  // when reminders are set to 0.
  function maybeRemind(now) {
    const minutes = Store.data.settings.remindMin;
    const task = Tasks.active();
    if (!minutes || !task) return;
    if (t.running && t.mode === 'break') return;
    if (now - t.lastReminderAt < minutes * 60 * 1000) return;
    t.lastReminderAt = now;
    window.nb.notify('Focus Pot', `Still on it: ${task.text}`);
  }

  // Why: the heartbeat, every 500ms.
  function tick() {
    const now = Date.now();
    rollDateIfNeeded();
    if (t.running) {
      t.remainingMs = Math.max(0, t.endAt - now);
      if (t.remainingMs === 0) finishPhase();
    }
    maybeRemind(now);
    renderClock();
  }

  // ── Changing the session lengths ──

  // Why: the − / + buttons. Changing the phase you're looking at while it
  // isn't running resets the display to the new length right away.
  function changeLength(key, delta) {
    const [min, max] = LIMITS[key];
    const current = Store.data.settings[key];
    const next = Math.min(max, Math.max(min, current + delta));
    if (next === current) return;
    Store.data.settings[key] = next;
    Store.persist('settings');
    onSettingsChanged(key === 'focusMin' ? 'focus' : 'break');
  }

  function applyPreset(preset) {
    Store.data.settings.focusMin = preset.focus;
    Store.data.settings.breakMin = preset.rest;
    Store.persist('settings');
    onSettingsChanged(t.mode);
  }

  // Why: never touches a running timer; an idle one shows the new length.
  function onSettingsChanged(mode) {
    if (mode && !t.running && t.mode === mode) t.remainingMs = phaseMs(mode);
    render();
  }

  // Why: picking a new active task counts as a fresh start for reminders.
  function resetReminderClock() {
    t.lastReminderAt = Date.now();
  }

  // ── Drawing ──

  // Why: the big dial is an SVG circle drawn with stroke-dasharray. Material
  // leaves a small gap between the coloured arc and the track (--dial-gap);
  // Windows draws the track as a full ring underneath.
  function drawProgress(p) {
    const progress = Math.min(1, Math.max(0, p));
    const fill = progress * DIAL_C;
    const gap = parseFloat(getComputedStyle(el.dial).getPropertyValue('--dial-gap')) || 0;
    el.dialFill.style.strokeDasharray = `${fill} ${DIAL_C}`;
    el.dialFill.style.opacity = fill < 1 ? '0' : '1';
    if (gap && fill >= 1) {
      const startAt = fill + gap;
      const length = Math.max(0, DIAL_C - fill - gap * 2);
      el.dialTrack.style.strokeDasharray = `0 ${startAt} ${length} ${DIAL_C}`;
    } else {
      el.dialTrack.style.strokeDasharray = '';
    }
    el.triggerRing.style.strokeDashoffset = String(RING_C * (1 - progress));
  }

  // Why: the parts that change every tick, kept small on purpose.
  function renderClock() {
    const text = formatClock(t.remainingMs);
    el.triggerTime.textContent = text;
    el.bigTime.textContent = text;
    drawProgress(1 - t.remainingMs / phaseMs(t.mode));
  }

  function renderToday() {
    el.todayText.textContent = `${Store.data.stats.pomos} today`;
  }

  function renderControls() {
    const s = Store.data.settings;
    el.focusValue.textContent = `${s.focusMin} min`;
    el.breakValue.textContent = `${s.breakMin} min`;
    for (const button of el.stepButtons) {
      const [min, max] = LIMITS[button.dataset.step];
      const delta = Number(button.dataset.delta);
      const value = s[button.dataset.step];
      button.disabled = delta < 0 ? value <= min : value >= max;
    }
    el.presets.replaceChildren(
      ...PRESETS.map((preset) => {
        const active = s.focusMin === preset.focus && s.breakMin === preset.rest;
        return h(
          'button',
          {
            class: `chip preset${active ? ' on' : ''}`,
            'aria-pressed': String(active),
            title: `${preset.focus} min focus, ${preset.rest} min break`,
            onclick: () => applyPreset(preset),
          },
          icon('check'),
          preset.name,
          h('small', null, `${preset.focus}/${preset.rest}`),
        );
      }),
    );
  }

  // Why: everything else; called when the timer starts/stops/switches mode,
  // when settings change, or when the active task changes.
  function render() {
    const task = Tasks.active();
    const state = t.running ? t.mode : 'idle';
    const s = Store.data.settings;

    // Taskbar button
    el.trigger.dataset.state = state;
    el.trigger.dataset.mode = t.mode;
    setIcon(el.triggerIcon, t.mode === 'break' ? 'coffee' : 'timer');
    el.triggerLabel.textContent = task
      ? task.text
      : t.running
        ? t.mode === 'focus' ? 'Focusing' : 'On a break'
        : t.mode === 'focus' ? 'Ready to focus' : 'Break is ready';
    el.triggerMain.title = task ? `Focus Pot · ${task.text}` : 'Focus Pot';

    // Focus tab
    el.timer.dataset.mode = t.mode;
    el.timer.classList.toggle('running', t.running);
    el.modeLabel.textContent = t.mode === 'focus' ? 'Focus' : 'Break';
    el.dialSub.textContent = `${t.mode === 'focus' ? s.focusMin : s.breakMin} min ${t.mode === 'focus' ? 'session' : 'break'}`;
    const untouched = t.remainingMs >= phaseMs(t.mode);
    el.startText.textContent = t.running ? 'Pause' : untouched ? 'Start' : 'Resume';
    setIcon(el.startIcon, t.running ? 'pause' : 'play');
    el.skipBtn.title = t.mode === 'focus' ? 'Skip to break' : 'Skip to focus';
    el.focusTask.replaceChildren(
      task ? h('span', null, 'Working on ', h('strong', null, task.text)) : 'No active task – star one in Tasks',
    );
    renderControls();

    // Jumps (reset, next phase) should snap the dial, not sweep backwards.
    el.dialFill.style.transition = 'none';
    el.triggerRing.style.transition = 'none';
    renderClock();
    void el.dialFill.getBoundingClientRect();
    el.dialFill.style.transition = '';
    el.triggerRing.style.transition = '';
  }

  function init() {
    el = {
      trigger: $('trigger'),
      triggerMain: $('triggerMain'),
      triggerIcon: $('triggerIcon'),
      triggerTime: $('triggerTime'),
      triggerLabel: $('triggerLabel'),
      triggerRing: $('triggerRing'),
      timer: $('timer'),
      dial: document.querySelector('.dial'),
      dialFill: $('dialFill'),
      dialTrack: $('dialTrack'),
      modeLabel: $('modeLabel'),
      bigTime: $('bigTime'),
      dialSub: $('dialSub'),
      focusTask: $('focusTask'),
      startText: $('startText'),
      startIcon: $('startIcon'),
      skipBtn: $('skipBtn'),
      presets: $('presets'),
      focusValue: $('focusValue'),
      breakValue: $('breakValue'),
      stepButtons: document.querySelectorAll('[data-step]'),
      todayText: $('todayText'),
    };

    $('startBtn').addEventListener('click', toggle);
    $('resetBtn').addEventListener('click', reset);
    el.skipBtn.addEventListener('click', skip);
    for (const button of el.stepButtons) {
      button.addEventListener('click', () => changeLength(button.dataset.step, Number(button.dataset.delta)));
    }
    el.triggerMain.addEventListener('animationend', (event) => {
      if (event.animationName === 'trigger-pulse') el.triggerMain.classList.remove('pulse');
    });

    t.remainingMs = phaseMs('focus');
    rollDateIfNeeded();
    renderToday();
    render();
    setInterval(tick, 500);
  }

  return { init, toggle, render, onSettingsChanged, resetReminderClock };
})();
