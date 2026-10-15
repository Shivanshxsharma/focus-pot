/**
 * scripts/make-icon.js — draws Focus Pot's icon and installer art (no image editor needed)
 * ============================================================================
 * The Focus Pot mark is three shapes on a 24-unit grid (the same numbers as
 * the SVG in src/index.html): a slim rim, a tapered pot, and one leaf.
 * This script draws it in code and writes
 *
 *   src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico
 *       the app icon: a warm-white mark on an ember tile, with a soft light
 *       from the top-left, a bright inner rim and a faint shadow under the mark
 *   src-tauri/icons/installer-sidebar.bmp (164×314), installer-header.bmp (150×57)
 *       the artwork the Windows installer shows (NSIS wants BMP files)
 *
 * Every shape is a signed distance function (negative = inside); turning a
 * distance into coverage (clamp(0.5 − distance in pixels)) gives smooth,
 * anti-aliased edges at every size for free. PNG, ICO and BMP are encoded by
 * hand (zlib from Node + a CRC32), so the script needs nothing but Node.
 *
 * Usage:  node scripts/make-icon.js   (or: npm run icon)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src-tauri', 'icons');

// ── Brand colours (the in-app mark uses the same, see .brand-mark in layout.css) ──
const EMBER_LIGHT = [255, 160, 96];
const EMBER = [236, 92, 52];
const EMBER_DEEP = [196, 52, 40];
const GLYPH = [255, 251, 246]; // warm white
const NIGHT_TOP = [24, 22, 26];
const NIGHT_BOTTOM = [12, 11, 14];

// ── Shapes ──
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// Any simple polygon (Inigo Quilez's formula).
function sdPolygon(px, py, pts) {
  let d = (px - pts[0][0]) ** 2 + (py - pts[0][1]) ** 2;
  let sign = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i++) {
    const ex = pts[j][0] - pts[i][0];
    const ey = pts[j][1] - pts[i][1];
    const wx = px - pts[i][0];
    const wy = py - pts[i][1];
    const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey));
    d = Math.min(d, (wx - ex * t) ** 2 + (wy - ey * t) ** 2);
    const a = py >= pts[i][1];
    const b = py < pts[j][1];
    const c = ex * wy > ey * wx;
    if ((a && b && c) || (!a && !b && !c)) sign = -sign;
  }
  return sign * Math.sqrt(d);
}

// A leaf: the overlap of two circles, pointed at both ends, from a to b
// and w wide on each side of the middle (in the SVG: two arcs).
function sdLeaf(px, py, ax, ay, bx, by, w) {
  const len = Math.hypot(bx - ax, by - ay);
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  const radius = (len * len) / 4 / (2 * w) + w / 2;
  const off = radius - w;
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const d1 = Math.hypot(px - (mx + nx * off), py - (my + ny * off)) - radius;
  const d2 = Math.hypot(px - (mx - nx * off), py - (my - ny * off)) - radius;
  return Math.max(d1, d2);
}

// The mark, on its 24-unit grid. The pot's body is a trapezoid 1.3 smaller
// all round; subtracting 1.3 grows it back with round corners (the SVG does
// the same with a 2.6-wide round-joined stroke).
const POT_BODY = [
  [7.2, 15.6],
  [16.8, 15.6],
  [14.49, 19.7],
  [9.51, 19.7],
];
function sdMark(x, y) {
  return Math.min(
    sdRoundRect(x, y, 4.75, 11, 19.25, 13.1, 1.05), // rim
    sdPolygon(x, y, POT_BODY) - 1.3, // pot
    sdLeaf(x, y, 12.1, 10.6, 18, 3.1, 1.95), // leaf
  );
}

// ── The app icon: the mark on an ember tile ──
// Small sizes get a bigger mark so it stays readable in a 16px tray.
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const unit = size / 256; // pixels per tile unit (the tile is designed on 256)
  const K = size <= 32 ? 7.6 : 6.7; // tile units per mark unit
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = ((x + 0.5) / size) * 256;
      const gy = ((y + 0.5) / size) * 256;
      const dTile = sdRoundRect(gx, gy, 0, 0, 256, 256, 58);

      // Diagonal three-stop gradient: light top-left, deep bottom-right.
      const t = clamp01((gx * 0.45 + gy) / 330);
      let c = t < 0.55 ? lerp(EMBER_LIGHT, EMBER, t / 0.55) : lerp(EMBER, EMBER_DEEP, (t - 0.55) / 0.45);
      // A soft light from the top-left and a bright inner rim along the top.
      c = lerp(c, [255, 255, 255], clamp01(1 - Math.hypot(gx - 70, gy - 10) / 210) * 0.16);
      const rim = clamp01(1 - Math.abs(dTile + 2.2) / 2.2) * clamp01((128 - gy) / 128);
      c = lerp(c, [255, 255, 255], rim * 0.35);

      // The mark, with a faint shadow just below it for depth.
      const mx = (gx - 128) / K + 12;
      const my = (gy - 128) / K + 12;
      const shadow = clamp01(0.5 - (sdMark(mx, my - 0.55) - 0.15) * K * unit * 0.6) * 0.22;
      c = lerp(c, [90, 20, 10], shadow);
      c = lerp(c, GLYPH, clamp01(0.5 - sdMark(mx, my) * K * unit));

      const i = (y * size + x) * 4;
      px[i] = Math.round(c[0]);
      px[i + 1] = Math.round(c[1]);
      px[i + 2] = Math.round(c[2]);
      px[i + 3] = Math.round(clamp01(0.5 - dTile * unit) * 255);
    }
  }
  return px;
}

// Draws a small icon tile into a bigger RGB canvas (for the installer art).
function stamp(canvas, width, icon, size, ox, oy) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = ((oy + y) * width + ox + x) * 3;
      const a = icon[s + 3] / 255;
      for (let ch = 0; ch < 3; ch++) canvas[d + ch] = Math.round(canvas[d + ch] * (1 - a) + icon[s + ch] * a);
    }
  }
}

// ── Installer art ──
// Sidebar (welcome and finish pages): night background, a warm glow, the icon.
function drawSidebar() {
  const width = 164;
  const height = 314;
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = lerp(NIGHT_TOP, NIGHT_BOTTOM, y / height);
      const glow = clamp01(1 - Math.hypot((x - 82) / 1.1, y - 118) / 120);
      c = lerp(c, EMBER, glow * glow * 0.45);
      const i = (y * width + x) * 3;
      rgb[i] = c[0];
      rgb[i + 1] = c[1];
      rgb[i + 2] = c[2];
    }
  }
  stamp(rgb, width, drawIcon(84), 84, 40, 76);
  return { width, height, rgb };
}

// Header (inner pages): the installer draws it on white, so: white + icon.
function drawHeader() {
  const width = 150;
  const height = 57;
  const rgb = Buffer.alloc(width * height * 3, 255);
  stamp(rgb, width, drawIcon(40), 40, 102, 8);
  return { width, height, rgb };
}

// ── Encoders ──

// Why: PNG chunks end with a CRC32 checksum; Node has no built-in for it.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Why: a PNG is a signature + IHDR (size, RGBA) + compressed rows + IEND.
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Why: an .ico is a small directory followed by the images; modern Windows
// accepts PNG data for each entry.
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, png }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // colour planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(png.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...images.map((im) => im.png)]);
}

// Why: the installer (NSIS) only reads plain 24-bit BMPs: a file header, an
// info header, then the rows bottom-up in BGR order, each padded to 4 bytes.
function encodeBmp({ width, height, rgb }) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixels = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      pixels[row + x * 3] = rgb[s + 2];
      pixels[row + x * 3 + 1] = rgb[s + 1];
      pixels[row + x * 3 + 2] = rgb[s];
    }
  }
  const header = Buffer.alloc(54);
  header.write('BM', 0, 'ascii');
  header.writeUInt32LE(54 + pixels.length, 2); // file size
  header.writeUInt32LE(54, 10); // where the pixels start
  header.writeUInt32LE(40, 14); // info header size
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(24, 28); // bits per pixel
  header.writeUInt32LE(pixels.length, 34);
  header.writeInt32LE(2835, 38); // 72 dpi
  header.writeInt32LE(2835, 42);
  return Buffer.concat([header, pixels]);
}

fs.mkdirSync(OUT, { recursive: true });
const files = { '32x32.png': 32, '128x128.png': 128, '128x128@2x.png': 256, 'icon.png': 512 };
for (const [name, size] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), encodePng(size, drawIcon(size)));
fs.writeFileSync(
  path.join(OUT, 'icon.ico'),
  encodeIco([16, 24, 32, 48, 64, 256].map((size) => ({ size, png: encodePng(size, drawIcon(size)) }))),
);
fs.writeFileSync(path.join(OUT, 'installer-sidebar.bmp'), encodeBmp(drawSidebar()));
fs.writeFileSync(path.join(OUT, 'installer-header.bmp'), encodeBmp(drawHeader()));
console.log(`Icons and installer art written to ${path.relative(process.cwd(), OUT)}`);
