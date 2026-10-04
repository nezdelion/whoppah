// Single-stroke (centre-line) fonts: the StrokeFont model, parsers of SVG fonts and Hershey JHF, the compact JSON form.
// Pure: used by the app (built-in and user fonts) and by tools/build_fonts.js (node).
//
// StrokeFont — the one interface every font source produces (built-in JSON, SVG font, JHF; later TTF/OTF centre lines):
//   { id, name, capHeight, xHeight, glyphs: Map<codepoint, { advance, lines }>, info? }
//   Font units, the baseline at y = 0, Y DOWN (as document coordinates: the cap top is at y = -capHeight), the pen origin
//   of a glyph at x = 0, `advance` — the step to the next glyph; `lines` — polylines as flat arrays [x0, y0, x1, y1, ...]
//   in the font's stroke order (each one is drawn with the pen down). layoutText scales capHeight to the requested size.
import { t } from '../i18n/index.js';
import { pathToLines } from './svg-import.js';

export const FONT_FORMAT = 'plotter-stroke-font/1';
/** The largest font file a user may add (the parsed font is much smaller). */
export const MAX_FONT_FILE_BYTES = 4 * 1024 * 1024;

export class FontError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FontError';
  }
}

const round = (v, k) => Math.round(v * k) / k;

function bboxOf(glyph) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of glyph.lines) {
    for (let i = 0; i < l.length; i += 2) {
      if (l[i] < x0) x0 = l[i];
      if (l[i] > x1) x1 = l[i];
      if (l[i + 1] < y0) y0 = l[i + 1];
      if (l[i + 1] > y1) y1 = l[i + 1];
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1 };
}

/** The height of a glyph above the baseline (font units), or 0. */
const heightOf = (glyphs, ch) => {
  const g = glyphs.get(ch.codePointAt(0));
  const b = g && bboxOf(g);
  return b && b.y0 < 0 ? -b.y0 : 0;
};

/** Cap height and x-height measured on H/x (or Cyrillic EN/PE when the font has no Latin). */
function measure(glyphs, fallbackCap) {
  const cap = ['H', 'I', 'E', '\u041D', '\u041F'].map((c) => heightOf(glyphs, c)).find((v) => v > 0) || fallbackCap;
  const x = ['x', 'z', '\u043D', '\u043F'].map((c) => heightOf(glyphs, c)).find((v) => v > 0) || cap * 0.65;
  return { capHeight: cap, xHeight: x };
}

/** A StrokeFont from parts; checks that it has at least one drawable glyph. */
export function makeFont({ id = '', name = '', glyphs, capHeight = 0, xHeight = 0, info = null, defaultCap = 1 }) {
  let drawable = 0;
  for (const g of glyphs.values()) if (g.lines.length) drawable++;
  if (!drawable) throw new FontError(t('text.font.err.empty'));
  const m = measure(glyphs, capHeight || defaultCap);
  return { id, name, capHeight: capHeight > 0 ? capHeight : m.capHeight, xHeight: xHeight > 0 ? xHeight : m.xHeight, glyphs, info };
}

// --- Hershey JHF

/**
 * Hershey-encoded glyph data (the pairs after the JHF header: left/right, then points, " R" — pen up; coordinates are
 * character codes relative to 'R') -> { left, right, lines }. NewStroke uses the same encoding.
 */
export function decodeHershey(data) {
  const R = 82; // 'R'
  const left = data.charCodeAt(0) - R, right = data.charCodeAt(1) - R;
  const lines = [];
  let cur = [];
  for (let k = 2; k + 1 < data.length; k += 2) {
    if (data[k] === ' ' && data[k + 1] === 'R') {
      if (cur.length >= 4) lines.push(cur);
      cur = [];
      continue;
    }
    cur.push(data.charCodeAt(k) - R, data.charCodeAt(k + 1) - R);
  }
  if (cur.length >= 4) lines.push(cur);
  return { left, right, lines };
}

/**
 * Hershey JHF text -> glyph records in file order: { id, left, right, lines } (Hershey units, Y down, origin at the glyph
 * centre). A record is "nnnnn" id, "ccc" pair count, then the pairs (left/right first, " R" — pen up); a record may continue
 * on the next lines.
 */
export function parseJhfRecords(text) {
  const src = String(text).replace(/\r/g, '');
  const records = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && src[i] === '\n') i++;
    if (i >= src.length) break;
    const head = src.slice(i, i + 8);
    if (!/^[ \d]{5}[ \d]{3}$/.test(head) || !/\d/.test(head.slice(5))) throw new FontError(t('text.font.err.jhf'));
    const id = Number(head.slice(0, 5)) || 0, count = Number(head.slice(5));
    i += 8;
    let data = '';
    while (data.length < count * 2 && i < src.length) {
      if (src[i] !== '\n') data += src[i];
      i++;
    }
    if (data.length < count * 2 || count < 1) throw new FontError(t('text.font.err.jhf'));
    records.push({ id, ...decodeHershey(data) });
    // the rest of the line (normally nothing) is ignored
    while (i < src.length && src[i] !== '\n') i++;
  }
  if (!records.length) throw new FontError(t('text.font.err.jhf'));
  return records;
}

/** The Hershey baseline: 9 units below the glyph centre in the standard fonts; capitals are 21 units high. */
export const HERSHEY_BASELINE = 9;
export const HERSHEY_CAP = 21;

/** One JHF record as a glyph: the origin moved to the left edge and the baseline; optional slant (x += -y * slant). */
export function jhfGlyph(rec, { baseline = HERSHEY_BASELINE, slant = 0 } = {}) {
  const lines = rec.lines.map((l) => {
    const out = new Array(l.length);
    for (let k = 0; k < l.length; k += 2) {
      const y = l[k + 1] - baseline;
      out[k] = l[k] - rec.left - y * slant;
      out[k + 1] = y;
    }
    return out;
  });
  return { advance: rec.right - rec.left, lines };
}

/**
 * A JHF font: the records map to code points 32, 33, … in file order (the usual layout of the .jhf font files), or by
 * `map` (index -> code point, for files laid out otherwise).
 */
export function parseJhf(text, { id = '', name = '', map = null } = {}) {
  const records = parseJhfRecords(text);
  const glyphs = new Map();
  records.forEach((rec, index) => {
    const cp = map ? map(index, rec) : 32 + index;
    if (cp == null || glyphs.has(cp)) return;
    glyphs.set(cp, jhfGlyph(rec));
  });
  return makeFont({ id, name, glyphs, defaultCap: HERSHEY_CAP });
}

// --- SVG fonts

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e];
  const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
});

/** Start tags of the given element names with their attributes (namespace prefixes dropped), in document order. */
function startTags(text, names) {
  const out = [];
  const re = /<(?:[\w.-]+:)?([\w.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  let m;
  while ((m = re.exec(text))) {
    if (!names.has(m[1])) continue;
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
    out.push({ tag: m[1], attrs });
  }
  return out;
}

const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

/** An SVG font glyph path (Y up) -> polylines in font units, Y down. A failing path is skipped by the caller. */
function svgGlyphLines(d, step) {
  return pathToLines(d, step).map((l) => {
    const out = l.slice();
    for (let k = 1; k < out.length; k += 2) out[k] = -out[k];
    return out;
  });
}

/**
 * SVG font text (<font>, <font-face>, <glyph unicode d>) -> StrokeFont. Only single-character glyphs are taken
 * (ligatures are skipped). Curves are flattened to chords of about 1/250 em.
 * @returns { font, skipped } — skipped: glyphs with unreadable path data
 */
export function parseSvgFont(text, { id = '', name = '' } = {}) {
  const src = String(text).replace(/<!--[\s\S]*?-->/g, '');
  const tags = startTags(src, new Set(['font', 'font-face', 'glyph', 'missing-glyph']));
  const font = tags.find((x) => x.tag === 'font');
  if (!font || !tags.some((x) => x.tag === 'glyph')) throw new FontError(t('text.font.err.notSvgFont'));
  const face = (tags.find((x) => x.tag === 'font-face') || { attrs: {} }).attrs;
  const em = num(face['units-per-em'], 1000) || 1000;
  const defAdv = num(font.attrs['horiz-adv-x'], em / 2);
  const step = em / 250;
  const glyphs = new Map();
  let skipped = 0;
  for (const g of tags) {
    if (g.tag !== 'glyph') continue;
    const u = g.attrs.unicode;
    if (!u || [...u].length !== 1) continue;
    const cp = u.codePointAt(0);
    if (glyphs.has(cp)) continue;
    let lines = [];
    if (g.attrs.d) {
      try { lines = svgGlyphLines(g.attrs.d, step); } catch (e) { skipped++; continue; }
    }
    glyphs.set(cp, { advance: num(g.attrs['horiz-adv-x'], defAdv), lines });
  }
  const fam = face['font-family'] || font.attrs.id || '';
  const out = makeFont({ id, name: name || fam, glyphs, defaultCap: num(face['cap-height']) || em * 0.7 });
  return { font: out, skipped };
}

// --- outline detection: a single-line font draws most letters with open strokes

const isClosed = (l, tol) => Math.hypot(l[0] - l[l.length - 2], l[1] - l[l.length - 1]) <= tol;

/**
 * true when the font looks like an outline (filled) font: almost every glyph is made only of closed contours, including
 * letters that a pen draws with open strokes (I, l, L, T, 1, -).
 */
export function looksLikeOutline(font) {
  const tol = font.capHeight * 0.01;
  let drawn = 0, closedOnly = 0;
  for (const g of font.glyphs.values()) {
    if (!g.lines.length) continue;
    drawn++;
    if (g.lines.every((l) => isClosed(l, tol))) closedOnly++;
  }
  const openLetters = ['I', 'l', 'L', 'T', '1', '-', '\u0413', '\u0422'].map((c) => font.glyphs.get(c.codePointAt(0))).filter((g) => g && g.lines.length);
  const openLettersClosed = openLetters.length > 0 && openLetters.every((g) => g.lines.every((l) => isClosed(l, tol)));
  return drawn > 0 && (closedOnly / drawn > 0.85 || openLettersClosed);
}

// --- user font files

/**
 * A font file chosen by the user -> { font, warnings }. Accepts single-line SVG fonts and Hershey .jhf; outline fonts
 * and other files are refused with a FontError (a ready message). TTF/OTF are refused for now: a later change can add a
 * centre-line extractor producing the same StrokeFont.
 */
export function parseFontFile(text, fileName = '', { id = '' } = {}) {
  const base = String(fileName).replace(/^.*[\\/]/, '');
  const name = base.replace(/\.[^.]*$/, '') || 'font';
  const ext = (base.match(/\.([^.]*)$/) || [, ''])[1].toLowerCase();
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) throw new FontError(t('text.font.err.ttf'));
  if (text.length > MAX_FONT_FILE_BYTES) throw new FontError(t('text.font.err.tooBig', { mb: MAX_FONT_FILE_BYTES / 1024 / 1024 }));
  const warnings = [];
  let font;
  if (/<(?:[\w.-]+:)?font[\s>]/.test(text) || ext === 'svg') {
    const r = parseSvgFont(text, { id }); // the family name of the font, else the file name
    font = r.font;
    if (!font.name) font.name = name;
    if (r.skipped) warnings.push(t('text.font.warn.skipped', { count: r.skipped }));
    if (looksLikeOutline(font)) throw new FontError(t('text.font.err.outline'));
  } else if (ext === 'jhf' || /^[ \d]{5}[ \d]{3}[ -~]/.test(text)) {
    font = parseJhf(text, { id, name });
  } else {
    throw new FontError(t('text.font.err.unknown'));
  }
  return { font, warnings };
}

// --- compact JSON (the built-in fonts and the stored user fonts)

/**
 * StrokeFont -> JSON-ready object: { format, id, name, capHeight, xHeight, info, glyphs: { "<code point>": [advance,
 * [x, y, ...], ...] } }; coordinates are rounded to `precision` decimals.
 */
export function fontToJson(font, { precision = 1 } = {}) {
  const k = 10 ** precision;
  const glyphs = {};
  for (const cp of [...font.glyphs.keys()].sort((a, b) => a - b)) {
    const g = font.glyphs.get(cp);
    glyphs[cp] = [round(g.advance, k), ...g.lines.map((l) => l.map((v) => round(v, k)))];
  }
  return {
    format: FONT_FORMAT, id: font.id, name: font.name,
    capHeight: round(font.capHeight, k), xHeight: round(font.xHeight, k),
    ...(font.info ? { info: font.info } : {}), glyphs,
  };
}

/** The compact JSON -> StrokeFont. A malformed document is a FontError. */
export function fontFromJson(json) {
  if (!json || json.format !== FONT_FORMAT || !json.glyphs || typeof json.glyphs !== 'object') throw new FontError(t('text.font.err.format'));
  const glyphs = new Map();
  for (const [key, value] of Object.entries(json.glyphs)) {
    const cp = Number(key);
    if (!Number.isInteger(cp) || !Array.isArray(value) || !Number.isFinite(value[0])) continue;
    const lines = value.slice(1).filter((l) => Array.isArray(l) && l.length >= 4 && l.length % 2 === 0 && l.every(Number.isFinite));
    glyphs.set(cp, { advance: value[0], lines });
  }
  return makeFont({ id: json.id || '', name: json.name || '', glyphs, capHeight: json.capHeight, xHeight: json.xHeight, info: json.info || null });
}

/** The code points of a string that the font has no glyph for (unique, in order). */
export function missingChars(font, text) {
  const out = [];
  for (const ch of String(text)) {
    if (/\s/.test(ch)) continue;
    if (!font.glyphs.has(ch.codePointAt(0)) && !out.includes(ch)) out.push(ch);
  }
  return out;
}
