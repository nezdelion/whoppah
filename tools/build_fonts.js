#!/usr/bin/env node
// Builds the built-in single-stroke fonts of the "Text" tab from the vendored originals (standard library only):
//
//   node tools/build_fonts.js            # writes src/app/text/fonts/<id>.json
//   node tools/build_fonts.js --check    # only compares: exit 1 if a committed JSON differs from a fresh build
//
// Sources (vendor/<font>/, unmodified, see each UPSTREAM): Hershey Script simplex (vendor/hershey/scripts.jhf), NewStroke
// (vendor/newstroke/newstroke_font.cpp, CC0), EMS Allure and EMS Felix (vendor/ems-fonts/*.svg, OFL). None of the
// handwriting fonts has Cyrillic, so their Cyrillic letters, Latin-1 letters and typographic punctuation are filled in
// from NewStroke: scaled to the font's cap height, lowercase fitted to its x-height (ascenders and descenders keep their
// length), slanted like the font. The glyph parsing is the app's own (src/core/stroke-font.js), so user fonts and
// built-in fonts go through the same code.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseJhf, parseSvgFont, decodeHershey, jhfGlyph, makeFont, fontToJson } from '../src/core/stroke-font.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src/app/text/fonts');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

const NEWSTROKE_RANGES = [[0x20, 0x7e], [0xa0, 0xff], [0x400, 0x45f], [0x2010, 0x2027], [0x2030, 0x2030], [0x2116, 0x2116], [0x20ac, 0x20ac]];
/** What the handwriting fonts take from NewStroke when they have no glyph of their own. */
const FILL_RANGES = [[0xa0, 0xff], [0x400, 0x45f], [0x2010, 0x2027], [0x2030, 0x2030], [0x2116, 0x2116], [0x20ac, 0x20ac]];
const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);
const LOWER = (cp) => (cp >= 0x430 && cp <= 0x45f) || (cp >= 0xdf && cp <= 0xff && cp !== 0xf7);

// NewStroke draws a box for every code point it has no glyph for
const PLACEHOLDER = 'F^K[KFYFY[K[';
/** Side bearing of a filled-in glyph, in cap heights (NewStroke's own bearings are too wide for handwriting). */
const FILL_BEARING = 0.1;

/** NewStroke: the C string table, one Hershey-encoded glyph per code point from U+0020. */
function loadNewStroke() {
  const glyphs = new Map();
  let index = 0;
  for (const line of read('vendor/newstroke/newstroke_font.cpp').split('\n')) {
    const m = /^\s*"((?:[^"\\]|\\.)*)",\s*(?:\/\*\s*U\+([0-9A-Fa-f]+))?/.exec(line);
    if (!m) continue;
    const cp = 0x20 + index++;
    if (m[2] && parseInt(m[2], 16) !== cp) throw new Error(`newstroke: U+${m[2]} at index of U+${cp.toString(16)}`);
    if (!inRanges(cp, NEWSTROKE_RANGES)) continue;
    const data = m[1].replace(/\\(.)/g, '$1');
    if (data.length < 2 || data === PLACEHOLDER) continue;
    glyphs.set(cp, jhfGlyph({ id: cp, ...decodeHershey(data) }));
  }
  return makeFont({
    id: 'newstroke', name: 'NewStroke', glyphs,
    info: { license: 'CC0-1.0', source: 'NewStroke by Vladimir Uryvaev (vovanium), vendor/newstroke' },
  });
}

/** A NewStroke glyph moved into another font: cap height and x-height of the target, its slant. */
function fitted(glyph, cp, from, to, slant) {
  const k = to.capHeight / from.capHeight;
  const lower = LOWER(cp);
  const xs = to.xHeight / (from.xHeight * k); // x-height ratio after the uniform scale
  const sx = lower ? k * (0.6 + 0.4 * xs) : k; // lowercase narrows a bit with a smaller x-height
  const mapY = (y) => {
    if (!lower) return y * k;
    if (y >= 0) return y * k; // descender
    if (y >= -from.xHeight) return y * k * xs; // the x-height band
    return -to.xHeight + (y + from.xHeight) * k; // ascender keeps its length
  };
  // the glyph box with the font's own narrow bearings instead of NewStroke's
  let x0 = Infinity, x1 = -Infinity;
  for (const l of glyph.lines) for (let i = 0; i < l.length; i += 2) { x0 = Math.min(x0, l[i] * sx); x1 = Math.max(x1, l[i] * sx); }
  const bearing = FILL_BEARING * to.capHeight;
  const shift = x0 === Infinity ? 0 : bearing - x0;
  const lines = glyph.lines.map((l) => {
    const out = new Array(l.length);
    for (let i = 0; i < l.length; i += 2) {
      const y = mapY(l[i + 1]);
      out[i] = l[i] * sx + shift - y * slant;
      out[i + 1] = y;
    }
    return out;
  });
  return { advance: x0 === Infinity ? glyph.advance * sx : x1 - x0 + 2 * bearing, lines };
}

function withFill(base, fill, { slant, info, id, name }) {
  const glyphs = new Map(base.glyphs);
  for (const [cp, g] of fill.glyphs) {
    if (glyphs.has(cp) || !inRanges(cp, FILL_RANGES)) continue;
    glyphs.set(cp, fitted(g, cp, fill, base, slant));
  }
  return makeFont({ id, name, glyphs, capHeight: base.capHeight, xHeight: base.xHeight, info });
}

function build() {
  const newstroke = loadNewStroke();
  const script = parseJhf(read('vendor/hershey/scripts.jhf'));
  script.glyphs.delete(0x7f);
  const allure = parseSvgFont(read('vendor/ems-fonts/EMSAllure.svg')).font;
  const felix = parseSvgFont(read('vendor/ems-fonts/EMSFelix.svg')).font;
  const hershey = 'Hershey Script simplex (Dr. A. V. Hershey, U.S. National Bureau of Standards; data format by James Hurt, Cognition, Inc.), vendor/hershey';
  const ns = 'Cyrillic and punctuation: NewStroke (CC0), vendor/newstroke';
  return [
    { font: withFill(script, newstroke, { id: 'script', name: 'Hershey Script', slant: 0.3, info: { license: 'Hershey Fonts use restriction; CC0-1.0', source: `${hershey}. ${ns}` } }), precision: 2 },
    { font: newstroke, precision: 1 },
    { font: withFill(allure, newstroke, { id: 'allure', name: 'EMS Allure', slant: 0.35, info: { license: 'OFL-1.1', source: `EMS Allure by Sheldon B. Michaels (derivative of Allura by Rob Leuschke), SVG font by Windell H. Oskay, vendor/ems-fonts. ${ns}` } }), precision: 0 },
    { font: withFill(felix, newstroke, { id: 'felix', name: 'EMS Felix', slant: 0.12, info: { license: 'OFL-1.1', source: `EMS Felix by Sheldon B. Michaels (derivative of Felipa by Fontstage), SVG font by Windell H. Oskay, vendor/ems-fonts. ${ns}` } }), precision: 0 },
  ];
}

const check = process.argv.includes('--check');
let differs = 0;
for (const { font, precision } of build()) {
  const file = join(OUT, `${font.id}.json`);
  const text = `${JSON.stringify(fontToJson(font, { precision }))}\n`;
  if (check) {
    let old = '';
    try { old = readFileSync(file, 'utf8'); } catch (e) { /* missing */ }
    if (old !== text) { differs++; console.log(`differs: ${file}`); }
    continue;
  }
  writeFileSync(file, text);
  console.log(`${file}: ${font.glyphs.size} glyphs, ${(text.length / 1024).toFixed(0)} KB`);
}
if (differs) process.exit(1);
