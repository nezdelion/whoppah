// Text -> polylines in millimetres with a single-stroke font (StrokeFont, see stroke-font.js), and the "like by hand"
// variation. Pure: document coordinates, Y down, the first baseline at y = 0 (the letters go up to y = -size).
import { t } from '../i18n/index.js';
import { createDrawing, SPACE } from './drawing.js';

export const TEXT_DEFAULTS = Object.freeze({
  sizeMm: 8, letterSpacing: 0, lineSpacing: 1.8, align: 'left', wrapMm: 0, slant: 0, variation: 0, seed: 1,
});
export const ALIGNS = Object.freeze(['left', 'center', 'right']);

// Typographic characters a font often lacks: drawn with plainer ones (no warning) before falling back to "?".
const SUBSTITUTES = {
  '\u00ab': '"', '\u00bb': '"', '\u201e': '"', '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'", '\u201a': ',',
  '\u2014': '-', '\u2013': '-', '\u2012': '-', '\u2010': '-', '\u2011': '-', '\u2026': '...', '\u00a0': ' ', '\u2116': 'No',
  '\u0451': '\u0435', '\u0401': '\u0415',
};

/** Seeded PRNG (mulberry32): the same seed gives the same sequence. */
export function createRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** A soft random number in [-1, 1] (more often near 0). */
const soft = (rnd) => (rnd() + rnd() + rnd()) / 1.5 - 1;

// "Like by hand" at strength 100: the largest per-glyph deviations (sizes as fractions of the cap height)
const HAND = { scale: 0.14, slantDeg: 8, rotateDeg: 5, dx: 0.05, dy: 0.08, spacing: 0.12, wobble: 0.1, tiltDeg: 1.2 };

/**
 * One character -> the glyph to draw: from the font, from the fallback font, through a plainer substitute, or "?".
 * Returns a list (a substitute may be several characters) of { glyph, k, space } with k — font units -> mm.
 */
function resolver(font, fallback, sizeMm, report) {
  const kOf = (f) => sizeMm / f.capHeight;
  const spaceAdv = () => {
    const g = font.glyphs.get(32);
    return g ? g.advance * kOf(font) : sizeMm * 0.4;
  };
  const direct = (cp) => {
    if (font.glyphs.has(cp)) return { glyph: font.glyphs.get(cp), k: kOf(font) };
    if (fallback && fallback.glyphs.has(cp)) return { glyph: fallback.glyphs.get(cp), k: kOf(fallback), fallback: true };
    return null;
  };
  return (ch) => {
    if (ch === ' ') return [{ space: true, advance: spaceAdv() }];
    const cp = ch.codePointAt(0);
    const d = direct(cp);
    if (d) { if (d.fallback) report.fallback(ch); return [d]; }
    const sub = SUBSTITUTES[ch];
    if (sub) {
      const parts = [...sub].map((c) => (c === ' ' ? { space: true, advance: spaceAdv() } : direct(c.codePointAt(0))));
      if (parts.every(Boolean)) return parts;
    }
    report.missing(ch);
    const q = direct(63);
    return q ? [q] : [{ space: true, advance: spaceAdv() }];
  };
}

const advanceOf = (item) => (item.space ? item.advance : item.glyph.advance * item.k);

/** Splits a paragraph into rows no wider than wrapMm (greedy by words; a longer word is broken between characters). */
function wrapRows(items, wrapMm, gap) {
  if (!(wrapMm > 0)) return [items];
  const widthOf = (list) => list.reduce((s, it, i) => s + advanceOf(it) + (i ? gap : 0), 0);
  const tokens = [];
  for (const it of items) {
    const last = tokens[tokens.length - 1];
    if (last && last.space === !!it.space) last.items.push(it); else tokens.push({ space: !!it.space, items: [it] });
  }
  const rows = [];
  let row = [], pending = [];
  for (const tok of tokens) {
    if (tok.space) { if (row.length) pending = tok.items; continue; }
    const word = tok.items;
    if (row.length && widthOf([...row, ...pending, ...word]) > wrapMm + 1e-9) { rows.push(row); row = []; }
    if (!row.length && widthOf(word) > wrapMm + 1e-9) {
      // a word longer than the row: broken between characters
      for (const it of word) {
        if (row.length && widthOf([...row, it]) > wrapMm + 1e-9) { rows.push(row); row = []; }
        row.push(it);
      }
    } else row = row.length ? [...row, ...pending, ...word] : [...word];
    pending = [];
  }
  rows.push(row);
  return rows;
}

/**
 * Text -> { lines, warnings, width, height, rows }: polylines in mm (document coordinates, Y down, first baseline at 0).
 * @param font     StrokeFont
 * @param opts     { sizeMm (cap height, mm), letterSpacing (% of the size, added between letters), lineSpacing (baseline
 *   step in sizes), align ('left'|'center'|'right'), wrapMm (0 — no wrapping), slant (degrees, to the right),
 *   variation (0..100, "like by hand"), seed, fallback (StrokeFont for characters the font lacks) }
 * Variation 0 draws the font exactly; the same seed gives the same text; every character takes the same random numbers
 * whatever the strength, so the strength scales one fixed "handwriting" instead of drawing a new one.
 */
export function layoutText(text, font, opts = {}) {
  const o = { ...TEXT_DEFAULTS, ...opts };
  const size = Math.max(0.1, Number(o.sizeMm) || TEXT_DEFAULTS.sizeMm);
  const f = Math.min(100, Math.max(0, Number(o.variation) || 0)) / 100;
  const gap = (Number(o.letterSpacing) || 0) / 100 * size;
  const lineStep = Math.max(0.5, Number(o.lineSpacing) || TEXT_DEFAULTS.lineSpacing) * size;
  const align = ALIGNS.includes(o.align) ? o.align : 'left';
  const baseSlant = (Number(o.slant) || 0) * Math.PI / 180;
  const missing = [], fallbackChars = [];
  const report = {
    missing: (ch) => { if (!missing.includes(ch)) missing.push(ch); },
    fallback: (ch) => { if (!fallbackChars.includes(ch)) fallbackChars.push(ch); },
  };
  const resolve = resolver(font, o.fallback || null, size, report);

  const paragraphs = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  const rows = [];
  for (const p of paragraphs) {
    const items = [...p].flatMap(resolve);
    rows.push(...wrapRows(items, o.wrapMm, gap));
  }

  const rnd = createRandom(o.seed);
  const placed = []; // per row: { glyphs: [{ item, x, tf }], width }
  for (const row of rows) {
    // row-level randoms: baseline wave length and phase, a slight tilt
    const waveLen = size * (5 + 4 * rnd()), phase = rnd() * 2 * Math.PI, tilt = soft(rnd) * HAND.tiltDeg * Math.PI / 180 * f;
    let x = 0;
    const glyphs = [];
    row.forEach((item, i) => {
      const r = [soft(rnd), soft(rnd), soft(rnd), soft(rnd), soft(rnd), soft(rnd)];
      if (i) x += gap;
      const adv = advanceOf(item);
      if (!item.space) {
        const s = 1 + f * HAND.scale * r[0];
        const slant = Math.tan(baseSlant + f * HAND.slantDeg * Math.PI / 180 * r[1]);
        const rot = f * HAND.rotateDeg * Math.PI / 180 * r[2];
        const cx = x + adv / 2;
        const wobble = f * HAND.wobble * size * Math.sin((2 * Math.PI * cx) / waveLen + phase) + cx * Math.tan(tilt);
        glyphs.push({ item, x: x + f * HAND.dx * size * r[3], dy: f * HAND.dy * size * r[4] + wobble, s, slant, rot, adv });
      }
      x += Math.max(adv * 0.3, adv + f * HAND.spacing * size * r[5] * (item.space ? 2 : 1));
    });
    placed.push({ glyphs, width: glyphs.length ? Math.max(...glyphs.map((g) => g.x + g.adv)) : 0 });
  }

  const maxWidth = o.wrapMm > 0 ? o.wrapMm : Math.max(0, ...placed.map((r) => r.width));
  const lines = [];
  placed.forEach((row, ri) => {
    const off = align === 'center' ? (maxWidth - row.width) / 2 : align === 'right' ? maxWidth - row.width : 0;
    const base = ri * lineStep;
    for (const g of row.glyphs) {
      const { glyph, k } = g.item;
      const cos = Math.cos(g.rot), sin = Math.sin(g.rot);
      const pcx = g.adv / 2, pcy = -size / 2; // rotation about the middle of the glyph box
      for (const l of glyph.lines) {
        const out = new Array(l.length);
        for (let i = 0; i < l.length; i += 2) {
          const v = l[i + 1] * k * g.s;
          let u = l[i] * k * g.s - v * g.slant;
          let w = v;
          if (g.rot) {
            const du = u - pcx, dv = w - pcy;
            u = pcx + du * cos - dv * sin;
            w = pcy + du * sin + dv * cos;
          }
          out[i] = off + g.x + u;
          out[i + 1] = base + g.dy + w;
        }
        lines.push(out);
      }
    }
  });

  const warnings = [];
  if (missing.length) warnings.push(t('text.warn.missing', { chars: missing.join(' ') }));
  if (fallbackChars.length && o.fallback) warnings.push(t('text.warn.fallback', { chars: fallbackChars.join(' '), font: o.fallback.name }));
  return { lines, warnings, width: maxWidth, height: rows.length ? (rows.length - 1) * lineStep + size : 0, rows: rows.length };
}

/** A short drawing name from the text: its first line, at most 40 characters. */
export function textName(text) {
  const first = String(text ?? '').trim().split(/\r?\n/)[0].trim();
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}

/**
 * Text -> Drawing in document coordinates (mm): one layer, meta { source: 'text', name, warnings, unitMm: 1,
 * physicalSize: { w, h } of the drawn lines } — "As is in mm" prints at the set size.
 */
export function textDrawing(text, font, opts = {}) {
  const r = layoutText(text, font, opts);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of r.lines) {
    for (let i = 0; i < l.length; i += 2) {
      if (l[i] < x0) x0 = l[i];
      if (l[i] > x1) x1 = l[i];
      if (l[i + 1] < y0) y0 = l[i + 1];
      if (l[i + 1] > y1) y1 = l[i + 1];
    }
  }
  const physicalSize = x0 === Infinity ? { w: 0, h: 0 } : { w: x1 - x0, h: y1 - y0 };
  return createDrawing({
    space: SPACE.DOCUMENT,
    layers: [{ id: 'text', name: t('text.layerName'), lines: r.lines }],
    meta: { source: 'text', name: textName(text) || t('text.layerName'), warnings: r.warnings, unitMm: 1, physicalSize, font: font.name },
  });
}
