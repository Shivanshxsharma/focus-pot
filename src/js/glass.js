/**
 * glass.js — the macOS theme's frosted "Liquid Glass" panel
 * ============================================================================
 * Real glass shows what's behind it. A web page can blur its own content
 * (CSS backdrop-filter) but not the desktop behind its window, so the Rust
 * side takes a small, already-blurred picture of whatever is behind
 * Focus Pot (dock::snapshot_behind; Focus Pot itself is left out of it).
 * Here we paint that picture inside the panel, lined up with the screen.
 * theme-mac.css adds the tint, the darkened edge and the specular rim.
 *
 * What this file does, following Apple's rules for the material:
 *   • Legibility first. Glass adapts: "larger elements become more opaque
 *     to preserve legibility". Each picture is measured, and the tint is
 *     made just dark enough that the secondary text keeps 4.5 : 1 contrast
 *     over the brightest part behind the panel. Over a dark desktop the
 *     glass stays clear; over a white page it frosts up.
 *   • The Clear ↔ Tinted setting (like iOS 27's slider) sets how tinted the
 *     glass is at least. Windows' "Transparency effects" off makes it
 *     frostier (more tint, more blur), as Reduce Transparency does on a Mac.
 *   • A lens edge: near the rounded edge the picture is bent outwards, like
 *     the rim of a thick lens (an SVG displacement map drawn here).
 *   • Glass doesn't fade in, it "materializes": as the panel grows out of
 *     the pill, the lens bends strongly and settles.
 *   • Alive on touch: pressing the pill gathers light where you pressed.
 *
 * Only the macOS theme takes pictures: when the theme is chosen, when the
 * panel opens, and every few seconds while it stays open (what's behind it
 * may change). They stay in memory as a data: URL and are never saved.
 */

'use strict';

const Glass = (() => {
  const REFRESH_MS = 2500;
  const EDGE = 22; // px: how far in from the edge the glass starts to bend
  const BEND = 14; // px: how far the picture shifts right at the edge
  const TINT = [22, 22, 26]; // keep in sync with --glass-tint in theme-mac.css
  const SECONDARY_TEXT = 0.74; // white at 74%: --text-2
  const CARD_FILL = 0.07; // --fill-1, the lightest thing text sits on
  const TARGET = 4.5; // WCAG AA for normal-size text
  const state = { active: false, open: false, timer: 0, busy: false, mapKey: '', look: 40, needed: 0.5 };
  let el = null;

  const reduceTransparency = () => matchMedia('(prefers-reduced-transparency: reduce)').matches;
  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Legibility: how much tint does this picture need? ──

  // WCAG relative luminance of an sRGB colour (channels 0…1).
  function luminance([r, g, b]) {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Does secondary text, on a card, on the glass tinted at `alpha`, over
  // this backdrop pixel, reach the target contrast?
  function readable(pixel, alpha) {
    const ground = pixel.map((p, i) => {
      const glass = alpha * (TINT[i] / 255) + (1 - alpha) * p;
      return CARD_FILL + (1 - CARD_FILL) * glass;
    });
    const text = ground.map((g) => SECONDARY_TEXT + (1 - SECONDARY_TEXT) * g);
    return contrast(text, ground) >= TARGET;
  }

  // Why the brightest 10%: text can sit anywhere on the panel, so the
  // worst spots decide. A binary search finds the lightest tint that works.
  function neededTint(image) {
    const f = el.flyout;
    const k = image.naturalWidth / window.innerWidth; // picture px per CSS px
    const canvas = document.createElement('canvas');
    canvas.width = 24;
    canvas.height = 32;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, f.offsetLeft * k, f.offsetTop * k, f.offsetWidth * k, f.offsetHeight * k, 0, 0, 24, 32);
    const data = ctx.getImageData(0, 0, 24, 32).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) pixels.push([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
    pixels.sort((a, b) => luminance(b) - luminance(a));
    const brightest = pixels.slice(0, Math.max(1, Math.round(pixels.length * 0.1)));

    let low = 0;
    let high = 0.95;
    for (let step = 0; step < 12; step++) {
      const mid = (low + high) / 2;
      if (brightest.every((p) => readable(p, mid))) high = mid;
      else low = mid;
    }
    return high;
  }

  // Why max(): the setting decides how tinted the glass is AT LEAST; the
  // measurement only ever adds tint, for legibility. With Windows'
  // transparency effects off the glass gets frostier (Apple: "obscures more
  // of the content behind it"), but it stays glass.
  function applyTint() {
    const fromLook = 0.28 + 0.6 * (state.look / 100);
    const floor = reduceTransparency() ? 0.78 : 0;
    const alpha = Math.min(0.95, Math.max(fromLook, state.needed, floor));
    el.root.style.setProperty('--glass-alpha', alpha.toFixed(3));
  }

  // Why one picture at a time: a slow capture never queues up more.
  async function refresh() {
    if (state.busy || !state.active) return;
    state.busy = true;
    try {
      const url = await window.nb.glassSnapshot();
      if (!url || !state.active) return;
      const image = new Image();
      image.src = url;
      await image.decode();
      state.needed = neededTint(image);
      el.root.style.setProperty('--glass-image', `url("${url}")`);
      applyTint();
    } catch (err) {
      console.warn('[glass] snapshot failed:', err);
    } finally {
      state.busy = false;
    }
  }

  // Called by Settings while you drag the Clear ↔ Tinted slider.
  function setLook(value) {
    state.look = Math.min(100, Math.max(0, Number(value) || 0));
    applyTint();
  }

  // ── Lining up ──

  // Why: the picture covers the whole window, so the backdrop has to show
  // the part that is exactly behind the panel. offsetLeft/Top ignore the
  // panel's transform, so this stays put while it animates. The same
  // numbers tell CSS where the pill is, so the panel grows out of it.
  function align() {
    const { flyout, backdrop, trigger } = el;
    el.root.style.setProperty('--glass-w', `${window.innerWidth}px`);
    el.root.style.setProperty('--glass-h', `${window.innerHeight}px`);
    const x = flyout.offsetLeft + flyout.clientLeft + backdrop.offsetLeft;
    const y = flyout.offsetTop + flyout.clientTop + backdrop.offsetTop;
    backdrop.style.setProperty('--glass-x', `${-x}px`);
    backdrop.style.setProperty('--glass-y', `${-y}px`);
    const pillX = trigger.offsetLeft + trigger.offsetWidth / 2 - flyout.offsetLeft;
    const pillY = trigger.offsetTop + trigger.offsetHeight / 2 - flyout.offsetTop;
    flyout.style.setProperty('--origin-x', `${Math.round(pillX)}px`);
    flyout.style.setProperty('--origin-y', `${Math.round(pillY)}px`);
    drawLensMap();
  }

  // Why: the displacement map says, for every pixel, where to take the
  // picture from: red = sideways, green = up/down, 128 = "stay". Near the
  // panel's rounded edge it points outwards, so the rim shows a squeezed
  // view of what's just beyond the edge, as a thick lens would.
  // Drawn at half size (it's smooth, and the filter stretches it).
  function drawLensMap() {
    const box = el.backdrop;
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const radius = parseFloat(getComputedStyle(el.flyout).borderTopLeftRadius) || 0;
    const key = `${width}x${height}r${radius}`;
    if (!width || !height || key === state.mapKey) return;
    state.mapKey = key;

    const scale = 0.5;
    const w = Math.ceil(width * scale);
    const h = Math.ceil(height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(w, h);

    // The panel's own rectangle inside the (larger) backdrop.
    const inset = -box.offsetLeft;
    const cx = width / 2;
    const cy = height / 2;
    const hw = width / 2 - inset;
    const hh = height / 2 - inset;
    const r = Math.min(radius, hw, hh);

    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const px = (i + 0.5) / scale - cx;
        const py = (j + 0.5) / scale - cy;
        // Signed distance to the rounded rectangle (negative = inside) and
        // the outward direction at the nearest edge.
        const qx = Math.abs(px) - (hw - r);
        const qy = Math.abs(py) - (hh - r);
        let d;
        let nx;
        let ny;
        if (qx > 0 && qy > 0) {
          const len = Math.hypot(qx, qy) || 1;
          d = len - r;
          nx = (qx / len) * Math.sign(px);
          ny = (qy / len) * Math.sign(py);
        } else if (qx > qy) {
          d = qx - r;
          nx = Math.sign(px);
          ny = 0;
        } else {
          d = qy - r;
          nx = 0;
          ny = Math.sign(py);
        }
        // Strongest right at the edge, fading to nothing EDGE px inside.
        const t = d > 0 ? 0 : Math.max(0, 1 + d / EDGE);
        const strength = t * t;
        const k = (j * w + i) * 4;
        image.data[k] = 128 + Math.round(127 * nx * strength);
        image.data[k + 1] = 128 + Math.round(127 * ny * strength);
        image.data[k + 2] = 128;
        image.data[k + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    el.map.setAttribute('href', canvas.toDataURL('image/png'));
    setBend(BEND);
  }

  // A channel at 0 or 255 shifts by scale/2 px.
  function setBend(px) {
    el.shift.setAttribute('scale', String(Math.round(px * 2)));
  }

  // Why: Apple's glass "materializes by gradually modulating the light
  // bending" rather than fading. As the panel opens, the lens starts out
  // strong and settles to normal.
  function materialize() {
    if (reduceMotion()) return;
    const start = performance.now();
    const duration = 560;
    const frame = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const ease = 1 - (1 - t) ** 3;
      setBend(BEND * (3.2 - 2.2 * ease));
      if (t < 1 && state.open) requestAnimationFrame(frame);
      else setBend(BEND);
    };
    requestAnimationFrame(frame);
  }

  // Why: "alive on touch". Light gathers where you press the pill, then fades.
  function onPillPress(event) {
    if (!state.active || reduceMotion()) return;
    const r = el.trigger.getBoundingClientRect();
    el.trigger.style.setProperty('--px', `${event.clientX - r.left}px`);
    el.trigger.style.setProperty('--py', `${event.clientY - r.top}px`);
    el.trigger.classList.add('touched');
  }

  function onPillRelease() {
    el.trigger.classList.remove('touched');
  }

  function startRefreshing() {
    clearInterval(state.timer);
    state.timer = setInterval(refresh, REFRESH_MS);
  }

  function stopRefreshing() {
    clearInterval(state.timer);
    state.timer = 0;
  }

  // Why: reacts to the theme, the panel opening/closing and layout changes.
  function onShellChange({ open, theme }) {
    const active = theme === 'mac';
    if (active !== state.active) {
      state.active = active;
      if (!active) {
        stopRefreshing();
        el.root.style.removeProperty('--glass-image'); // free the picture
        state.open = false;
        return;
      }
      requestAnimationFrame(align);
      refresh(); // so the very first open already shows glass
    }
    if (!active) return;
    requestAnimationFrame(align);
    if (open && !state.open) {
      state.open = true;
      materialize();
      refresh();
      startRefreshing();
    } else if (!open && state.open) {
      state.open = false;
      stopRefreshing();
    }
  }

  function init() {
    el = {
      root: document.documentElement,
      flyout: $('flyout'),
      trigger: $('trigger'),
      backdrop: document.querySelector('.flyout-backdrop'),
      map: $('liquidMap'),
      shift: $('liquidShift'),
    };
    state.look = Store.data.settings.glassTint ?? state.look;
    applyTint();
    Shell.onChange(onShellChange);
    window.addEventListener('resize', () => {
      if (state.active) align();
    });
    el.trigger.addEventListener('pointerdown', onPillPress);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) el.trigger.addEventListener(type, onPillRelease);
    // Windows' "Transparency effects" can change while we run.
    matchMedia('(prefers-reduced-transparency: reduce)').addEventListener('change', applyTint);
  }

  return { init, refresh, setLook };
})();
