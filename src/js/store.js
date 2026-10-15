/**
 * store.js — the UI's copy of your saved data
 * ============================================================================
 * Store.data mirrors the keys the UI owns in state.json. Change it, then call
 * Store.persist('tasks') (etc.) and the backend writes the file right away.
 */

'use strict';

const Store = (() => {
  const data = {
    tasks: [], // { id, text, done, active, pomos, createdAt }
    links: [], // { id, name, url }
    settings: { focusMin: 25, breakMin: 5, remindMin: 15, dock: 'auto', dockOffset: 12, theme: 'windows', miniPlayer: true, pillFace: 'timer', glassTint: 40, clipHistory: false },
    stats: { date: '', pomos: 0 }, // focus sessions finished today
  };
  let categories = ['Uncategorized'];

  // Why: state.json may come from an older version or be hand-edited, so
  // every task is rebuilt with known fields and only ONE may be active.
  function normalizeTasks(list) {
    const tasks = (Array.isArray(list) ? list : [])
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => ({
        id: String(t.id || newId()),
        text: t.text.trim().slice(0, 200),
        done: Boolean(t.done),
        active: Boolean(t.active) && !t.done,
        pomos: clampInt(t.pomos, 0, 1e6, 0),
        createdAt: Number(t.createdAt) || 0,
      }));
    let seenActive = false;
    for (const task of tasks) {
      if (task.active && seenActive) task.active = false;
      if (task.active) seenActive = true;
    }
    return tasks;
  }

  // Why: same protection for links.
  function normalizeLinks(list) {
    return (Array.isArray(list) ? list : [])
      .filter((link) => link && typeof link.url === 'string' && link.url)
      .map((link) => ({
        id: String(link.id || newId()),
        name: String(link.name || hostOf(link.url)).slice(0, 40),
        url: link.url,
      }));
  }

  // Why: called once at startup with what the backend read from disk.
  function load(saved, savedCategories) {
    const s = saved || {};
    data.tasks = normalizeTasks(s.tasks);
    data.links = normalizeLinks(s.links);
    data.settings = { ...data.settings, ...(s.settings || {}) };
    data.stats = { date: String(s.stats?.date || ''), pomos: clampInt(s.stats?.pomos, 0, 1e6, 0) };
    if (Array.isArray(savedCategories) && savedCategories.length) categories = savedCategories;
  }

  // Why: the UI sends only what changed; the backend merges it into state.json.
  function persist(...keys) {
    const partial = {};
    for (const key of keys) partial[key] = data[key];
    window.nb.saveState(partial);
  }

  return { data, load, persist, categories: () => categories };
})();
