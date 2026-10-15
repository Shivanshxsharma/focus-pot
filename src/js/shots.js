/**
 * shots.js — the Shots tab: screenshot tools and gallery
 * ============================================================================
 * The heavy lifting (capturing, saving, thumbnails, the Recycle Bin) happens
 * in the backend (src-tauri/src/screenshots.rs). This file draws the page
 * and calls it. A switch at the top flips between this gallery and the
 * clipboard history (clips.js).
 */

'use strict';

const Shots = (() => {
  let el = null;
  let filter = 'All';
  let view = 'shots'; // 'shots' | 'clips'
  let showing = false; // is the Shots tab on screen?
  let renderId = 0; // increases on every refresh; an older refresh stops when it sees a newer id

  // Why: filter chips are rebuilt each refresh so the selected one is always right.
  function renderFilters() {
    el.filters.replaceChildren(
      ...['All', ...Store.categories()].map((category) =>
        h(
          'button',
          {
            class: `chip${category === filter ? ' on' : ''}`,
            'aria-pressed': String(category === filter),
            onclick: () => {
              if (filter === category) return;
              filter = category;
              refresh();
            },
          },
          icon('check'),
          category,
        ),
      ),
    );
  }

  async function act(promise) {
    const result = await promise;
    if (result && result.message) setStatus(el.status, result.message, !result.ok);
    return result;
  }

  // Why: one card = thumbnail, name/date, category box, open/copy/delete.
  // Returns the <img> separately so thumbnails can be filled in afterwards.
  function card(item) {
    const img = h('img', { class: 'shot-thumb', alt: '' });
    img.addEventListener('load', () => img.classList.add('loaded'));

    const category = Dropdown.create({
      small: true,
      label: `Category for ${item.name}`,
      value: item.category,
      options: Store.categories().map((c) => ({ value: c, label: c })),
      onChange: async (value) => {
        await act(window.nb.shots.setCategory(item.path, value));
        if (filter !== 'All') refresh(); // it may no longer match the filter
      },
    });

    // Two-click delete: the first click arms the button for 2.5 seconds.
    const deleteBtn = h('button', { class: 'btn-icon delete', title: 'Move to the Recycle Bin', 'aria-label': 'Delete' }, icon('bin'));
    let armTimer = null;
    deleteBtn.addEventListener('click', async () => {
      if (!armTimer) {
        deleteBtn.classList.add('armed');
        deleteBtn.replaceChildren('Sure?');
        armTimer = setTimeout(() => {
          armTimer = null;
          deleteBtn.classList.remove('armed');
          deleteBtn.replaceChildren(icon('bin'));
        }, 2500);
        return;
      }
      clearTimeout(armTimer);
      armTimer = null;
      deleteBtn.disabled = true;
      await act(window.nb.shots.remove(item.path));
      refresh();
    });

    const node = h(
      'article',
      { class: 'shot-card' },
      h('button', { class: 'shot-thumb-btn', title: 'Open', 'aria-label': `Open ${item.name}`, onclick: () => act(window.nb.shots.open(item.path)) }, img),
      h(
        'div',
        { class: 'shot-body' },
        h('div', null, h('div', { class: 'shot-name', title: item.path }, item.name), h('div', { class: 'shot-date' }, formatShotDate(item.mtimeMs))),
        category.root,
        h(
          'div',
          { class: 'shot-actions' },
          h('button', { class: 'btn-icon', title: 'Open', 'aria-label': 'Open', onclick: () => act(window.nb.shots.open(item.path)) }, icon('open')),
          h('button', { class: 'btn-icon', title: 'Copy image', 'aria-label': 'Copy image', onclick: () => act(window.nb.shots.copy(item.path)) }, icon('copy')),
          deleteBtn,
        ),
      ),
    );
    return { item, img, node };
  }

  // Why: draws the cards immediately, then fetches thumbnails one at a time
  // so the page never freezes on 60 large PNGs.
  async function refresh() {
    const id = ++renderId;
    renderFilters();
    let items = [];
    try {
      items = await window.nb.shots.list(filter);
    } catch {
      items = [];
    }
    if (!Array.isArray(items)) items = [];
    if (id !== renderId) return;

    const cards = items.map(card);
    el.grid.replaceChildren(...cards.map((c) => c.node));
    el.empty.hidden = items.length > 0;
    el.emptyTitle.textContent = filter === 'All' ? 'No screenshots yet' : `Nothing in ${filter}`;
    el.emptyText.textContent =
      filter === 'All' ? 'Capture one, paste a Win+Shift+S snip, or import the Windows folder.' : 'Pick this category on a screenshot to see it here.';

    for (const { item, img } of cards) {
      if (id !== renderId) return;
      const url = await window.nb.shots.thumb(item.path);
      if (typeof url === 'string' && url.startsWith('data:image/')) img.src = url;
    }
  }

  // Why: the toolbar buttons share one flow: disable, run, report, refresh.
  function bindAction(button, action) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      setStatus(el.status, 'Working…');
      try {
        const result = await action();
        setStatus(el.status, result?.message || '', !result?.ok);
      } catch (err) {
        setStatus(el.status, String(err?.message || err), true);
      } finally {
        button.disabled = false;
      }
      refresh();
    });
  }

  // Why: Ctrl+Alt+S / Ctrl+Alt+V run in the backend; it tells us so we can refresh.
  function onExternalChange(result) {
    if (result && result.message) setStatus(el.status, result.message, !result.ok);
    if (Shell.isOpen() && Shell.page() === 'shots') refresh();
  }

  // Why: one switch shows either the gallery or the clipboard history, and
  // tells clips.js when its list is on screen (so it only redraws then).
  function setView(next) {
    view = next === 'clips' ? 'clips' : 'shots';
    for (const button of el.viewButtons) button.setAttribute('aria-checked', String(button.dataset.shotsView === view));
    el.shotsPane.hidden = view !== 'shots';
    el.clipsPane.hidden = view !== 'clips';
    Clips.setVisible(showing && view === 'clips');
    if (showing && view === 'shots') refresh();
  }

  function init() {
    el = {
      status: $('shotStatus'),
      filters: $('shotFilters'),
      grid: $('shotGrid'),
      empty: $('shotEmpty'),
      emptyTitle: $('shotEmptyTitle'),
      emptyText: $('shotEmptyText'),
      viewButtons: document.querySelectorAll('[data-shots-view]'),
      shotsPane: $('shotsPane'),
      clipsPane: $('clipsPane'),
    };
    for (const button of el.viewButtons) button.addEventListener('click', () => setView(button.dataset.shotsView));
    bindAction($('shotCapture'), () => window.nb.shots.capture());
    bindAction($('shotPaste'), () => window.nb.shots.paste());
    bindAction($('shotImport'), () => window.nb.shots.importWindows());
    bindAction($('shotFolder'), () => window.nb.shots.openFolder());

    // Refresh whichever view is chosen whenever the Shots tab comes into view.
    Shell.onChange(({ open, page }) => {
      const now = open && page === 'shots';
      if (now === showing) return;
      showing = now;
      if (view === 'shots') {
        if (showing) refresh();
      } else {
        Clips.setVisible(showing);
      }
    });
  }

  return { init, refresh, onExternalChange, setView };
})();
