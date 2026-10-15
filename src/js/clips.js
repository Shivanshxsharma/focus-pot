/**
 * clips.js — the Clipboard view of the Shots tab
 * ============================================================================
 * What you copied lately, text and images, newest first, one click away
 * again. The history itself lives in the backend (src-tauri/src/clipboard.rs):
 *   • it's off until you switch it on here, and switching it off forgets it;
 *   • it's kept in memory only, never written to disk;
 *   • copies that password managers mark as private are never recorded.
 *
 * Click an item to copy it again. Images can also be saved into Shots.
 * The page only ever receives previews (a few hundred characters, small
 * thumbnails), never the full text or image.
 */

'use strict';

const Clips = (() => {
  let el = null;
  let visible = false;
  let renderId = 0; // an older refresh stops when a newer one has started

  async function act(promise) {
    const result = await promise;
    if (result && result.message) setStatus(el.status, result.message, !result.ok);
    return result;
  }

  // Why: one card per copy. The big left part copies it again; the small
  // buttons on the right save (images) or forget it.
  function card(item) {
    const isImage = item.kind === 'image';
    const when = timeAgo(item.atMs);
    const preview = isImage
      ? h('img', { class: 'clip-thumb', alt: '' })
      : h('span', { class: 'clip-snippet' }, item.text || '');
    if (isImage && typeof item.thumb === 'string' && item.thumb.startsWith('data:image/')) preview.src = item.thumb;

    const meta = isImage
      ? `Image · ${item.width} × ${item.height} · ${when}`
      : `${item.chars} ${item.chars === 1 ? 'character' : 'characters'} · ${when}`;

    const main = h(
      'button',
      {
        class: `clip-main${isImage ? ' is-image' : ''}`,
        title: 'Copy again',
        onclick: () => act(window.nb.clips.copy(item.id)),
      },
      preview,
      h('span', { class: 'clip-meta' }, meta),
    );

    const actions = h(
      'div',
      { class: 'clip-actions' },
      h('button', { class: 'btn-icon', title: 'Copy again', 'aria-label': 'Copy again', onclick: () => act(window.nb.clips.copy(item.id)) }, icon('copy')),
      isImage
        ? h(
            'button',
            {
              class: 'btn-icon',
              title: 'Save to Shots',
              'aria-label': 'Save to Shots',
              onclick: async () => {
                await act(window.nb.clips.save(item.id));
                Shots.refresh(); // it's a screenshot now
              },
            },
            icon('import'),
          )
        : null,
      h(
        'button',
        {
          class: 'btn-icon',
          title: 'Forget this one',
          'aria-label': 'Forget this one',
          onclick: async () => {
            await window.nb.clips.remove(item.id);
            refresh();
          },
        },
        icon('x'),
      ),
    );

    return h('article', { class: `clip-card${isImage ? ' image' : ''}` }, main, actions);
  }

  async function refresh() {
    const id = ++renderId;
    let list = { enabled: false, items: [] };
    try {
      list = (await window.nb.clips.list()) || list;
    } catch {
      // keep the empty list
    }
    if (id !== renderId) return;

    const items = Array.isArray(list.items) ? list.items : [];
    el.enabled.checked = Boolean(list.enabled);
    el.list.replaceChildren(...items.map(card));
    el.count.textContent = items.length ? `${items.length} recent ${items.length === 1 ? 'copy' : 'copies'}` : '';
    el.clear.hidden = items.length === 0;
    el.empty.hidden = items.length > 0;
    el.emptyTitle.textContent = list.enabled ? 'Nothing copied yet' : 'Clipboard history is off';
    el.emptyText.textContent = list.enabled
      ? 'Copy some text or an image (a Win+Shift+S snip too) and it shows up here.'
      : 'Turn it on to keep what you copy, text and images, a click away.';
  }

  // Why: the setting lives with the others in state.json; saving it is what
  // switches the backend's watcher on or off.
  function setEnabled(on) {
    Store.data.settings.clipHistory = on;
    Store.persist('settings');
    // Switching on records what's on the clipboard now (the watcher looks
    // twice a second); switching off empties the list right away.
    setTimeout(refresh, on ? 700 : 0);
  }

  // Why: the backend says "something new was copied"; only redraw if the
  // Clipboard view is actually on screen.
  function onChanged() {
    if (visible) refresh();
  }

  function setVisible(show) {
    visible = show;
    if (show) refresh();
  }

  function init() {
    el = {
      enabled: $('clipEnabled'),
      list: $('clipList'),
      count: $('clipCount'),
      clear: $('clipClear'),
      status: $('clipStatus'),
      empty: $('clipEmpty'),
      emptyTitle: $('clipEmptyTitle'),
      emptyText: $('clipEmptyText'),
    };
    el.enabled.checked = Boolean(Store.data.settings.clipHistory);
    el.enabled.addEventListener('change', () => setEnabled(el.enabled.checked));
    el.clear.addEventListener('click', async () => {
      await window.nb.clips.clear();
      setStatus(el.status, 'History cleared');
      refresh();
    });
  }

  return { init, refresh, onChanged, setVisible };
})();
