/**
 * links.js — one-click web shortcuts
 * ============================================================================
 * Opening a URL is an OS action, so it goes through the backend
 * (commands.rs → open_url), which only allows http:// and https:// addresses.
 */

'use strict';

const Links = (() => {
  let el = null;

  // Why: people type "github.com", not "https://github.com/". We add the
  // scheme when it's missing and accept only http/https (main checks again).
  function normalizeUrl(input) {
    let text = input.trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
    try {
      const url = new URL(text);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  async function open(url) {
    const result = await window.nb.openUrl(url);
    if (result && !result.ok) setStatus(el.status, result.message, true);
  }

  function remove(id) {
    Store.data.links = Store.data.links.filter((link) => link.id !== id);
    Store.persist('links');
    render();
  }

  // Why: a tile = letter badge (tinted with your accent), name, host, × on hover.
  function tile(link) {
    const letter = (Array.from(link.name.trim())[0] || '?').toUpperCase();
    return h(
      'div',
      { class: 'link-tile' },
      h(
        'button',
        { class: 'link-open', title: link.url, onclick: () => open(link.url) },
        h('span', { class: 'link-badge', 'aria-hidden': 'true' }, letter),
        h('span', { class: 'link-text' }, h('span', { class: 'link-name' }, link.name), h('span', { class: 'link-host' }, hostOf(link.url))),
      ),
      h(
        'button',
        { class: 'btn-icon link-x', title: `Remove ${link.name}`, 'aria-label': `Remove ${link.name}`, onclick: () => remove(link.id) },
        icon('x'),
      ),
    );
  }

  function render() {
    el.grid.replaceChildren(...Store.data.links.map(tile));
    el.empty.hidden = Store.data.links.length > 0;
  }

  // Why: validates before saving so a broken link never reaches the grid.
  function onSubmit(event) {
    event.preventDefault();
    const url = normalizeUrl(el.url.value);
    if (!url) {
      setStatus(el.status, 'That does not look like a web address.', true);
      return;
    }
    const name = (el.name.value.trim() || hostOf(url)).slice(0, 40);
    Store.data.links.push({ id: newId(), name, url });
    Store.persist('links');
    render();
    el.name.value = '';
    el.url.value = '';
    el.name.focus();
    setStatus(el.status, `Added ${name}`);
  }

  function init() {
    el = {
      grid: $('linkGrid'),
      empty: $('linkEmpty'),
      form: $('linkForm'),
      name: $('linkName'),
      url: $('linkUrl'),
      status: $('linkStatus'),
    };
    el.form.addEventListener('submit', onSubmit);
    render();
  }

  return { init, normalizeUrl };
})();
