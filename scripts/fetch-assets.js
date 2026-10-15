/**
 * scripts/fetch-assets.js — refresh the icon sets and fonts
 * ============================================================================
 * Focus Pot ships three looks, each with its own icons and type:
 *
 *   Windows theme  → Keyline Icons       (MIT)       https://github.com/keyline-icons/keyline-icons
 *                    Segoe UI Variable (built into Windows, nothing to download)
 *   Material theme → Material Symbols    (Apache-2)  https://fonts.google.com/icons
 *                    Google Sans Flex    (OFL 1.1)   https://fonts.google.com/specimen/Google+Sans+Flex
 *   macOS theme    → Framework7 Icons    (MIT)       https://github.com/framework7io/framework7-icons
 *                    Inter               (OFL 1.1)   https://fonts.google.com/specimen/Inter
 *                    (Apple's own SF Symbols / SF Pro may only be used on Apple
 *                    platforms; Framework7 and Inter are the open look-alikes.)
 *   Wordmark       → Geist SemiBold      (OFL 1.1)   only the letters of "Focus Pot"
 *
 * The UI refers to icons by a LOGICAL name (e.g. "play"). The table below maps
 * each logical name to one icon from each set. This script downloads them via
 * the Iconify API and writes three <template> sprites into src/index.html; at
 * runtime the active theme's sprite is copied into the page
 * (see Shell.applyTheme). Fonts go to src/fonts/, so the app never loads
 * anything from the internet.
 *
 * Usage:  npm run assets      (needs internet; Node 18+ for fetch)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// logical name: [Keyline Icons, Material Symbols, Framework7 Icons]
const ICONS = {
  timer: ['timer', 'timer-outline-rounded', 'timer'],
  'timer-reset': ['timer-reset', 'restart-alt-rounded', 'arrow-counterclockwise'],
  'skip-phase': ['skip-forward', 'fast-forward-rounded', 'forward-fill'],
  coffee: ['coffee', 'coffee-outline-rounded', 'wind'],
  bell: ['bell', 'notifications-outline-rounded', 'bell'],
  'list-todo': ['list-todo', 'checklist-rounded', 'list-bullet'],
  star: ['star', 'star-outline-rounded', 'star'],
  'star-fill': ['star-fill', 'star-rounded', 'star-fill'],
  bin: ['bin', 'delete-outline-rounded', 'trash'],
  'music-note': ['music-note', 'music-note-rounded', 'music-note'],
  play: ['play-fill', 'play-arrow-rounded', 'play-fill'],
  pause: ['pause-fill', 'pause-rounded', 'pause-fill'],
  prev: ['skip-back-fill', 'skip-previous-rounded', 'backward-end-fill'],
  next: ['skip-forward-fill', 'skip-next-rounded', 'forward-end-fill'],
  volume: ['volume', 'volume-up-rounded', 'speaker-3-fill'],
  'volume-low': ['volume-low', 'volume-down-rounded', 'speaker-1-fill'],
  'volume-x': ['volume-x', 'volume-off-rounded', 'speaker-slash-fill'],
  globe: ['globe', 'language', 'globe'],
  open: ['square-arrow-up-right', 'open-in-new-rounded', 'arrow-up-right-square'],
  scan: ['scan', 'screenshot-region-rounded', 'viewfinder'],
  paste: ['clipboard-paste', 'content-paste-rounded', 'doc-on-clipboard'],
  import: ['folder-arrow-down', 'move-to-inbox-outline-rounded', 'tray-arrow-down'],
  'folder-open': ['folder-open', 'folder-open-outline-rounded', 'folder'],
  images: ['images', 'photo-library-outline-rounded', 'photo-on-rectangle'],
  copy: ['copy', 'content-copy-outline-rounded', 'doc-on-doc'],
  monitor: ['monitor', 'desktop-windows-outline-rounded', 'desktopcomputer'],
  keyboard: ['keyboard', 'keyboard-outline-rounded', 'keyboard'],
  arrows: ['arrow-left-right', 'swap-horiz-rounded', 'arrow-right-arrow-left'],
  palette: ['palette', 'palette-outline', 'paintbrush'],
  'mini-player': ['picture-in-picture', 'picture-in-picture-alt-outline-rounded', 'rectangle-on-rectangle'],
  'chevron-down': ['chevron-down', 'keyboard-arrow-down-rounded', 'chevron-down'],
  'chevron-right': ['chevron-right', 'chevron-right-rounded', 'chevron-right'],
  pin: ['pin', 'keep-outline-rounded', 'pin'],
  'pin-fill': ['pin-fill', 'keep-rounded', 'pin-fill'],
  settings: ['settings', 'settings-outline-rounded', 'gear-alt'],
  power: ['power', 'power-settings-new-rounded', 'power'],
  x: ['x', 'close-rounded', 'xmark'],
  plus: ['plus', 'add-rounded', 'plus'],
  minus: ['minus', 'remove-rounded', 'minus'],
  check: ['check', 'check-rounded', 'checkmark'],
};

// Which column of ICONS feeds which <template> in index.html.
const SETS = [
  { prefix: 'keyline-icons', column: 0, marker: 'icons-windows' },
  { prefix: 'material-symbols', column: 1, marker: 'icons-material' },
  { prefix: 'f7', column: 2, marker: 'icons-mac' },
];

// Fonts to download: [family query, subsets to keep, file prefix]
const FONTS = [
  { query: 'Google+Sans+Flex:wght@400..700', subsets: ['latin', 'latin-ext'], prefix: 'google-sans-flex' },
  { query: 'Inter:opsz,wght@14..32,300..700', subsets: ['latin', 'latin-ext'], prefix: 'inter' },
];
// The wordmark only needs these letters, so Google Fonts can send a tiny file.
const BRAND_FONT = { query: 'Geist:wght@600', text: 'Focus Pot', file: 'brand-geist.woff2' };

const ROOT = path.join(__dirname, '..');
const HTML_FILE = path.join(ROOT, 'src', 'index.html');
const FONT_DIR = path.join(ROOT, 'src', 'fonts');
// Google Fonts picks the file format from the browser it thinks is asking.
const CHROME = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36' };

// Why: one request per icon set, then a check that every name exists.
async function fetchSet(prefix, names) {
  const response = await fetch(`https://api.iconify.design/${prefix}.json?icons=${names.join(',')}`);
  if (!response.ok) throw new Error(`Iconify answered ${response.status} for ${prefix}`);
  const set = await response.json();
  const missing = names.filter((name) => !set.icons || !set.icons[name]);
  if (missing.length) throw new Error(`${prefix}: unknown icon(s) ${missing.join(', ')}`);
  return set;
}

// Why: Keyline draws with stroke-width="2"; removing it lets CSS pick the
// weight (.icon { stroke-width }) so it can match Windows 11's lighter lines.
// (Material Symbols and Framework7 are filled shapes, so this changes nothing.)
function symbols(set, column) {
  return Object.entries(ICONS)
    .map(([logical, names]) => {
      const icon = set.icons[names[column]];
      const body = icon.body.replace(/\s*stroke-width="[^"]*"/g, '');
      const w = icon.width || set.width || 24;
      const hgt = icon.height || set.height || 24;
      return `        <symbol id="i-${logical}" viewBox="0 0 ${w} ${hgt}">${body}</symbol>`;
    })
    .join('\n');
}

// Why: rewrites only the text between two HTML comment markers.
function replaceBetween(html, name, content) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const a = html.indexOf(start);
  const b = html.indexOf(end);
  if (a < 0 || b < a) throw new Error(`markers for ${name} not found in index.html`);
  return `${html.slice(0, a + start.length)}\n${content}\n        ${html.slice(b)}`;
}

async function download(url, file) {
  const bytes = Buffer.from(await (await fetch(url, { headers: CHROME })).arrayBuffer());
  fs.writeFileSync(path.join(FONT_DIR, file), bytes);
  console.log(`Font: ${file} (${Math.max(1, Math.round(bytes.length / 1024))} KB)`);
}

// Why: Google Fonts serves one file per script subset; Focus Pot only needs
// Latin + Latin Extended (English and most European languages).
async function fetchFonts() {
  fs.mkdirSync(FONT_DIR, { recursive: true });
  for (const font of FONTS) {
    const css = await (await fetch(`https://fonts.googleapis.com/css2?family=${font.query}&display=swap`, { headers: CHROME })).text();
    for (const subset of font.subsets) {
      const match = new RegExp(`/\\* ${subset} \\*/[^}]*?url\\((https://[^)]+\\.woff2)\\)`).exec(css);
      if (!match) throw new Error(`${font.prefix}: no ${subset} subset found`);
      await download(match[1], `${font.prefix}-${subset}.woff2`);
    }
  }
  const css = await (
    await fetch(`https://fonts.googleapis.com/css2?family=${BRAND_FONT.query}&text=${encodeURIComponent(BRAND_FONT.text)}`, { headers: CHROME })
  ).text();
  const match = /url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/.exec(css);
  if (!match) throw new Error('brand font: no woff2 found');
  await download(match[1], BRAND_FONT.file);
}

async function main() {
  const names = Object.values(ICONS);
  const sets = await Promise.all(SETS.map((s) => fetchSet(s.prefix, names.map((n) => n[s.column]))));
  let html = fs.readFileSync(HTML_FILE, 'utf8');
  SETS.forEach((s, i) => {
    html = replaceBetween(html, s.marker, symbols(sets[i], s.column));
  });
  fs.writeFileSync(HTML_FILE, html, 'utf8');
  console.log(`Icons: ${names.length} logical icons × ${SETS.length} sets written into index.html`);
  await fetchFonts();
}

main().catch((err) => {
  console.error('fetch-assets failed:', err.message);
  process.exit(1);
});
