/**
 * dom.js — small helpers shared by every other script
 * ============================================================================
 * Loaded first (see the <script> list at the bottom of index.html). Defines
 * plain global functions; the feature scripts use them freely.
 */

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Why: shorter than document.getElementById everywhere.
const $ = (id) => document.getElementById(id);

// Why: builds DOM with createElement + text nodes, so task names, link names
// and song titles are always shown as TEXT. Building HTML strings from such
// input (innerHTML) would let a title like "<img onerror=…>" run code.
//   h('button', { class: 'btn', onclick: fn }, 'Save')
function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node) node[key] = value; // DOM properties: value, checked, title, type, src…
    else node.setAttribute(key, value === true ? '' : String(value)); // e.g. aria-label
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child)); // strings become text nodes, never HTML
  }
  return node;
}

// Why: icons are <symbol>s in index.html's sprite; this makes a reusable
// <svg class="icon"><use href="#i-NAME"/></svg>.
function icon(name, extraClass = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${extraClass}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// Why: swaps an existing icon (e.g. play ↔ pause) without rebuilding it.
function setIcon(svg, name) {
  const use = svg && svg.querySelector('use');
  if (use && use.getAttribute('href') !== `#i-${name}`) use.setAttribute('href', `#i-${name}`);
}

// Why: "5" -> "05" for clocks and dates.
function pad2(n) {
  return String(n).padStart(2, '0');
}

// Why: a countdown shows 25:00 at the start and 00:01 in its last second,
// which is what rounding UP gives you.
function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  return `${pad2(Math.floor(totalSec / 60))}:${pad2(totalSec % 60)}`;
}

// Why: song positions read "3:07" or "1:02:03", like media players show them.
function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${pad2(mins)}:${pad2(s % 60)}` : `${mins}:${pad2(s % 60)}`;
}

// Why: clipboard items read "just now", "5 min ago", "2 h ago", "yesterday".
function timeAgo(ms) {
  const seconds = Math.max(0, (Date.now() - Number(ms)) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return seconds < 172800 ? 'yesterday' : `${Math.round(seconds / 86400)} days ago`;
}

// Why: local calendar date as yyyy-mm-dd, used to reset "sessions today".
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Why: tasks and links need stable ids so clicks find the right item after re-sorting.
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Why: guards every number that comes from storage or a text box.
function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

// Why: "https://www.github.com/x" -> "github.com", a friendlier subtitle.
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Why: short dates for gallery cards, in the user's own locale.
function formatShotDate(ms) {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// Why: small inline messages ("Saved 14-03-22.png") that clear themselves,
// so the UI never fills up with stale text.
const statusTimers = new Map();
function setStatus(node, text, isError = false) {
  clearTimeout(statusTimers.get(node));
  node.textContent = text || '';
  node.classList.toggle('error', Boolean(text) && isError);
  if (text) {
    statusTimers.set(
      node,
      setTimeout(() => {
        node.textContent = '';
        node.classList.remove('error');
      }, 4000),
    );
  }
}

/**
 * Dropdown — a themed replacement for <select>
 * ----------------------------------------------------------------------------
 * Why not a native <select>? Windows draws its list as a separate popup
 * window, and Focus Pot keeps lifting itself above other windows (so the
 * taskbar can't cover the pill), which dismissed that popup. This menu is part of the
 * page instead (placed in #popupLayer so the flyout can't clip it), styled
 * by each theme, and works with the keyboard (↑ ↓ Enter Esc).
 *
 *   const dd = Dropdown.create({ options: [{ value, label }], value, onChange })
 *   container.append(dd.root)
 *
 * Opening/closing fires a 'popupchange' event so Shell can tell the backend
 * that the menu's rectangle is clickable.
 */
const Dropdown = (() => {
  let openMenu = null; // { menu, close } of the menu that is open right now

  function announce() {
    window.dispatchEvent(new Event('popupchange'));
  }

  function create({ options, value, onChange, small = false, label = null }) {
    let current = value;
    const valueText = h('span', { class: 'dropdown-value' });
    const button = h(
      'button',
      { type: 'button', class: `dropdown-btn${small ? ' small' : ''}`, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': label },
      valueText,
      icon('chevron-down'),
    );
    const root = h('div', { class: 'dropdown' }, button);
    const labelOf = (v) => (options.find((o) => o.value === v) || options[0]).label;
    const render = () => {
      valueText.textContent = labelOf(current);
    };

    function choose(next) {
      if (openMenu) openMenu.close();
      button.focus();
      if (next === current) return;
      current = next;
      render();
      onChange(next);
    }

    function open() {
      if (openMenu) openMenu.close();
      const items = options.map((o) =>
        h(
          'div',
          { class: 'menu-item', role: 'option', tabindex: '-1', 'aria-selected': String(o.value === current), onclick: () => choose(o.value) },
          icon('check'),
          h('span', null, o.label),
        ),
      );
      const menu = h('div', { class: 'menu', role: 'listbox' }, items);
      $('popupLayer').append(menu);

      // Below the button if it fits inside the page area (so it never covers
      // the footer or spills onto the taskbar), otherwise above it.
      const r = button.getBoundingClientRect();
      const width = Math.max(r.width, 160);
      menu.style.minWidth = `${width}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      const area = button.closest('.pager');
      const floor = area ? area.getBoundingClientRect().bottom : window.innerHeight;
      const fitsBelow = r.bottom + 4 + menu.offsetHeight <= floor - 6;
      menu.style.top = `${fitsBelow ? r.bottom + 4 : r.top - 4 - menu.offsetHeight}px`;

      button.setAttribute('aria-expanded', 'true');
      (items.find((i) => i.getAttribute('aria-selected') === 'true') || items[0]).focus();

      menu.addEventListener('keydown', (event) => {
        const index = items.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          items[(index + step + items.length) % items.length].focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
          if (index >= 0) choose(options[index].value);
        } else if (event.key === 'Escape' || event.key === 'Tab') {
          openMenu.close();
          button.focus();
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation(); // Esc closes the menu, not the whole flyout
      });

      openMenu = {
        menu,
        close() {
          menu.remove();
          button.setAttribute('aria-expanded', 'false');
          openMenu = null;
          announce();
        },
      };
      announce();
    }

    button.addEventListener('click', () => {
      if (button.getAttribute('aria-expanded') === 'true') openMenu?.close();
      else open();
    });
    render();

    return {
      root,
      setValue(next) {
        current = next;
        render();
      },
    };
  }

  // A click anywhere else, or scrolling, closes the open menu.
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (openMenu && !openMenu.menu.contains(event.target) && !event.target.closest('.dropdown-btn')) openMenu.close();
    },
    true,
  );
  document.addEventListener('scroll', () => openMenu?.close(), true);

  return {
    create,
    isOpen: () => !!openMenu,
    closeAll: () => openMenu?.close(),
  };
})();
