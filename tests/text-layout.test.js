// Single-stroke fonts (parsers, outline detection, compact JSON), the text layout, "like by hand", the Drawing; the
// built-in fonts (Cyrillic coverage, regenerated JSON equals the committed one).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseJhf, parseJhfRecords, parseSvgFont, parseFontFile, looksLikeOutline, fontToJson, fontFromJson, FontError, missingChars,
} from '../src/core/stroke-font.js';
import { layoutText, textDrawing, createRandom } from '../src/core/text-layout.js';
import { layout } from '../src/core/layout.js';
import { bbox } from '../src/core/drawing.js';
import { setLocale, t } from '../src/i18n/index.js';
import { sameData } from './helpers/same.js';
import { TINY_JHF, TINY_SVG_FONT, OUTLINE_SVG_FONT } from './helpers/fonts.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

const cp = (ch) => ch.codePointAt(0);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const svgFont = () => parseSvgFont(TINY_SVG_FONT, { id: 'tiny' }).font;
const builtin = (id) => fontFromJson(JSON.parse(readFileSync(join(root, 'src/app/text/fonts', `${id}.json`), 'utf8')));

// --- parsers

test('JHF: code points from 32 in file order, origin at the left bearing and the baseline, pen up, continued records', () => {
  const recs = parseJhfRecords(TINY_JHF);
  assert.equal(recs.length, 5);
  assert.deepEqual(recs.map((r) => r.id), [12345, 12346, 12347, 12348, 12349]);
  const font = parseJhf(TINY_JHF, { id: 'j', name: 'J' });
  assert.equal(font.capHeight, 21, 'no H to measure: the Hershey standard');
  assert.deepEqual([...font.glyphs.keys()], [32, 33, 34, 35, 36]);
  assert.deepEqual(font.glyphs.get(32), { advance: 16, lines: [] });
  assert.deepEqual(font.glyphs.get(33), { advance: 10, lines: [[5, -21, 5, 0]] });
  assert.deepEqual(font.glyphs.get(34).lines, [[4, -21, 4, -17], [12, -21, 12, -17]], 'pen up splits the strokes');
  assert.deepEqual(font.glyphs.get(35).lines, [[1, -21, 15, -21, 8, 0]], 'a record continued on the next line');
  assert.equal(font.glyphs.get(36).lines.length, 3);
});

test('JHF: a file that is not JHF is a FontError with a message', () => {
  for (const bad of ['hello world', '12345  9JZ', '']) {
    assert.throws(() => parseJhf(bad), (e) => e instanceof FontError && e.message === t('text.font.err.jhf'));
  }
});

test('SVG font: Y flipped to Y down, advances, entities, the default advance; ligatures and comments skipped; cap height measured', () => {
  const { font, skipped } = parseSvgFont(TINY_SVG_FONT, { id: 'tiny' });
  assert.equal(skipped, 0);
  assert.equal(font.name, 'Tiny Hand');
  assert.equal(font.capHeight, 700, 'measured on I');
  assert.equal(font.xHeight, 400, 'measured on x');
  assert.deepEqual(font.glyphs.get(cp('I')), { advance: 400, lines: [[200, -0, 200, -700]] });
  assert.equal(font.glyphs.get(0x41f).advance, 600, 'unicode given as an entity');
  assert.equal(font.glyphs.get(cp('x')).advance, 500, 'the font default advance');
  assert.equal(font.glyphs.get(cp('"')).lines.length, 2);
  assert.ok(!font.glyphs.has(cp('Z')), 'a glyph inside a comment is not read');
  assert.equal(font.glyphs.size, 7, 'the ligature "fi" is skipped');
  const o = font.glyphs.get(cp('o')).lines[0];
  assert.ok(o.length > 20, 'curves are flattened');
});

test('SVG font: unreadable glyph data is skipped and counted; no <font> is a FontError', () => {
  const text = TINY_SVG_FONT.replace('d="M 0 0 L 300 400 M 0 400 L 300 0"', 'd="M 0 0 L 300 X"');
  const { font, skipped } = parseSvgFont(text);
  assert.equal(skipped, 1);
  assert.ok(!font.glyphs.has(cp('x')));
  assert.throws(() => parseSvgFont('<svg><path d="M0 0L1 1"/></svg>'), (e) => e instanceof FontError && e.message === t('text.font.err.notSvgFont'));
});

test('outline detection: a single-line font passes, an outline font is refused with a clear message', () => {
  assert.equal(looksLikeOutline(svgFont()), false);
  assert.equal(looksLikeOutline(parseSvgFont(OUTLINE_SVG_FONT).font), true);
  for (const id of ['script', 'newstroke', 'allure', 'felix']) assert.equal(looksLikeOutline(builtin(id)), false, id);
  assert.throws(() => parseFontFile(OUTLINE_SVG_FONT, 'fat.svg'), (e) => e instanceof FontError && /outline font; single-line fonts only/.test(e.message));
});

test('user font files: SVG font and JHF accepted (by content too), TTF and unknown files refused', () => {
  const svg = parseFontFile(TINY_SVG_FONT, 'C:\\fonts\\my-hand.svg', { id: 'u1' });
  assert.equal(svg.font.id, 'u1');
  assert.equal(svg.font.name, 'Tiny Hand');
  assert.deepEqual(svg.warnings, []);
  const jhf = parseFontFile(TINY_JHF, 'futural.jhf');
  assert.equal(jhf.font.name, 'futural');
  assert.equal(parseFontFile(TINY_JHF, 'renamed.txt').font.glyphs.size, 5, 'JHF recognised by content');
  assert.throws(() => parseFontFile('xx', 'a.ttf'), (e) => e instanceof FontError && e.message === t('text.font.err.ttf'));
  assert.throws(() => parseFontFile('just some text', 'notes.txt'), (e) => e instanceof FontError && e.message === t('text.font.err.unknown'));
  assert.throws(() => parseFontFile('<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="E"><glyph unicode=" "/></font></defs></svg>', 'e.svg'),
    (e) => e instanceof FontError && e.message === t('text.font.err.empty'));
});

test('compact JSON: a round trip keeps glyphs and metrics; a damaged document is a FontError', () => {
  const font = svgFont();
  const json = JSON.parse(JSON.stringify(fontToJson(font, { precision: 2 })));
  assert.equal(json.format, 'plotter-stroke-font/1');
  const back = fontFromJson(json);
  assert.equal(back.capHeight, font.capHeight);
  assert.equal(back.xHeight, font.xHeight);
  sameData([...back.glyphs.keys()], [...font.glyphs.keys()].sort((a, b) => a - b));
  for (const [k, g] of font.glyphs) {
    const b = back.glyphs.get(k);
    assert.equal(b.advance, g.advance);
    sameData(b.lines.map((l) => l.map((v) => Math.round(v * 100) / 100)), g.lines.map((l) => l.map((v) => Math.round(v * 100) / 100 + 0)));
  }
  assert.throws(() => fontFromJson({ format: 'other', glyphs: {} }), FontError);
  assert.throws(() => fontFromJson(null), FontError);
});

// --- layout

test('layout: the cap height is the size in mm, glyphs advance by their width plus the letter spacing', () => {
  const font = svgFont(); // I: 700 high, advance 400
  const r = layoutText('II', font, { sizeMm: 7, letterSpacing: 10 });
  const k = 7 / 700;
  assert.equal(r.lines.length, 2);
  const [a, b] = r.lines;
  close(a[1] - a[3], 7);
  close(a[0], 200 * k);
  close(b[0] - a[0], 400 * k + 0.7, 1e-12); // advance + 10 % of 7 mm
  close(r.width, 2 * 400 * k + 0.7);
  close(r.height, 7);
  assert.equal(r.rows, 1);
});

test('layout: lines, line spacing and alignment left/centre/right against the widest row', () => {
  const font = svgFont();
  const k = 10 / 700;
  const firstX = (r, row) => Math.min(...r.lines.filter((l) => Math.abs(l[3] - row * 15) < 1e-9 || Math.abs(l[1] - row * 15) < 1e-9).map((l) => l[0]));
  const text = 'IIII\nI';
  const left = layoutText(text, font, { sizeMm: 10, lineSpacing: 1.5, align: 'left' });
  assert.equal(left.rows, 2);
  close(left.height, 25);
  const second = left.lines.at(-1);
  close(second[1], 15, 1e-9); // baseline of row 2 at 1.5 × 10 mm
  close(second[0], 200 * k);
  const centre = layoutText(text, font, { sizeMm: 10, lineSpacing: 1.5, align: 'center' });
  close(centre.lines.at(-1)[0] - 200 * k, (1600 * k - 400 * k) / 2);
  const right = layoutText(text, font, { sizeMm: 10, lineSpacing: 1.5, align: 'right' });
  close(right.lines.at(-1)[0] - 200 * k, 1600 * k - 400 * k);
  close(firstX(right, 0), 200 * k, 1e-9);
});

test('layout: word wrap by words, a word longer than the row is broken; slant leans the tops to the right', () => {
  const font = svgFont();
  const k = 7 / 700, adv = 400 * k, space = 300 * k;
  // "II II II": each word 2 adv wide; the row holds two words
  const r = layoutText('II II II', font, { sizeMm: 7, wrapMm: 4 * adv + space + 1e-6 });
  assert.equal(r.rows, 2);
  const rowsOf = (res) => new Set(res.lines.map((l) => Math.round(l[1] / (1.8 * 7) + 0.5))).size;
  assert.equal(rowsOf(r), 2);
  const long = layoutText('IIIIII', font, { sizeMm: 7, wrapMm: 2.5 * adv });
  assert.equal(long.rows, 3, 'six letters, two per row');
  const none = layoutText('II II II', font, { sizeMm: 7, wrapMm: 0 });
  assert.equal(none.rows, 1);
  const slanted = layoutText('I', font, { sizeMm: 7, slant: 45 });
  close(slanted.lines[0][2] - slanted.lines[0][0], 7, 1e-9); // the top is 7 mm to the right of the foot at 45°
});

test('layout: a missing glyph is drawn as "?" with a warning; typographic characters fall back to plainer ones silently', () => {
  const font = svgFont();
  const r = layoutText('I\u00e9\u00e9 I', font, { sizeMm: 7 });
  assert.deepEqual(r.warnings, [t('text.warn.missing', { chars: '\u00e9' })]);
  assert.equal(r.lines.length, 2 + 2 * 2, 'two I and two "?" of two strokes');
  const quotes = layoutText('\u00abI\u00bb', font, { sizeMm: 7 });
  assert.deepEqual(quotes.warnings, [], '« » drawn as "');
  assert.equal(quotes.lines.length, 5);
  setLocale('ru');
  assert.match(layoutText('\u00e9b', font).warnings[0], /^в шрифте нет знаков: /);
  assert.deepEqual(missingChars(font, 'I x \u00e9\u00e9b'), ['\u00e9', 'b']);
});

test('layout: characters the font lacks come from the fallback font at the same cap height, with a note', () => {
  const font = svgFont();
  const jhf = parseJhf(TINY_JHF, { name: 'Tiny JHF' });
  const r = layoutText('I!', font, { sizeMm: 7, fallback: jhf });
  assert.equal(r.lines.length, 2);
  const bang = r.lines[1];
  close(bang[3] - bang[1], 7, 1e-9); // "!" is 21 Hershey units = the cap height
  assert.deepEqual(r.warnings, [t('text.warn.fallback', { chars: '!', font: 'Tiny JHF' })]);
});

// --- "like by hand"

test('variation: deterministic per seed, another seed gives another text, strength 0 is the exact font', () => {
  const font = builtin('script');
  const text = 'Hello, \u043c\u0438\u0440!\nSecond line';
  const a = layoutText(text, font, { sizeMm: 6, variation: 60, seed: 42 });
  const b = layoutText(text, font, { sizeMm: 6, variation: 60, seed: 42 });
  sameData(a.lines, b.lines);
  const c = layoutText(text, font, { sizeMm: 6, variation: 60, seed: 43 });
  assert.throws(() => sameData(a.lines, c.lines), 'a new seed changes the lines');
  assert.equal(c.lines.length, a.lines.length, 'the same strokes');
  const exact = layoutText(text, font, { sizeMm: 6, variation: 0, seed: 1 });
  sameData(layoutText(text, font, { sizeMm: 6, variation: 0, seed: 777 }).lines, exact.lines, 'strength 0 does not depend on the seed');
  // strength 0 = the font glyphs scaled and placed one after another
  const g = font.glyphs.get(cp('H')), k = 6 / font.capHeight;
  const h = layoutText('H', font, { sizeMm: 6, variation: 0, seed: 5 });
  sameData(h.lines, g.lines.map((l) => l.map((v) => v * k)));
  // the variation stays small: no glyph moves more than about half a letter
  const deviation = Math.max(...a.lines.flatMap((l, i) => l.map((v, j) => Math.abs(v - exact.lines[i][j]))));
  assert.ok(deviation > 0.05 && deviation < 6, `deviation ${deviation}`);
});

test('variation: the random generator is seeded and in [0, 1)', () => {
  const r1 = createRandom(7), r2 = createRandom(7);
  const xs = Array.from({ length: 1000 }, () => r1());
  sameData(xs, Array.from({ length: 1000 }, () => r2()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notEqual(createRandom(8)(), xs[0]);
});

// --- Drawing

test('textDrawing: meta source text, unitMm 1, physical size of the lines; "As is in mm" keeps the size', () => {
  const font = svgFont();
  const d = textDrawing('  I x\nI  ', font, { sizeMm: 7 });
  assert.equal(d.space, 'document');
  assert.equal(d.meta.source, 'text');
  assert.equal(d.meta.unitMm, 1);
  assert.equal(d.meta.name, 'I x');
  assert.deepEqual(d.meta.warnings, []);
  assert.equal(d.layers.length, 1);
  assert.equal(d.layers[0].name, t('text.layerName'));
  const b = bbox(d);
  close(d.meta.physicalSize.w, b.w);
  close(d.meta.physicalSize.h, b.h);
  const placed = layout(d, { field: { w: 200, h: 200 }, marginMm: 10, corner: { x: 0, y: 0 }, asIs: true });
  close(placed.meta.layout.scale, 1);
  close(placed.meta.physicalSize.w, b.w);
  const empty = textDrawing('', font);
  assert.equal(empty.layers[0].lines.length, 0);
  assert.deepEqual(empty.meta.physicalSize, { w: 0, h: 0 });
  const long = textDrawing('x'.repeat(60), font);
  assert.equal(long.meta.name.length, 40);
});

// --- built-in fonts

const RU = Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x410 + i)).join('') + '\u0401'
  + Array.from({ length: 32 }, (_, i) => String.fromCodePoint(0x430 + i)).join('') + '\u0451';
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,:;!?-()"\'';

test('built-in fonts: Latin, digits, Russian with Yo and typographic punctuation are all covered', () => {
  for (const id of ['script', 'newstroke', 'allure', 'felix']) {
    const font = builtin(id);
    assert.deepEqual(missingChars(font, LATIN + RU + '\u00ab\u00bb\u2014\u2026'), [], id);
    for (const ch of RU + 'Hx') assert.ok(font.glyphs.get(cp(ch)).lines.length > 0, `${id}: ${ch} is drawn`);
    const r = layoutText('\u0421\u044a\u0435\u0448\u044c \u0436\u0435 \u0435\u0449\u0451', font, { sizeMm: 10 });
    assert.deepEqual(r.warnings, [], id);
    const top = Math.min(...layoutText('H', font, { sizeMm: 10 }).lines.flatMap((l) => l.filter((_, i) => i % 2)));
    close(top, -10, 0.3); // the cap height is the size
  }
});

test('built-in fonts: tools/build_fonts.js regenerates exactly the committed JSON', () => {
  const r = spawnSync(process.execPath, [join(root, 'tools/build_fonts.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
