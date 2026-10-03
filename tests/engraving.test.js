// "Engraving" on synthetic images: the direction field (isophotes, base angle in flat areas, rotation, independence from
// tone parameters), evenly spaced streamlines with the separation by tone, closing and singular points, light breaks,
// length limits, the cross layer, thickness, order, the stage cache, determinism, the point limit, performance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  engraving, engravingSteps, geometry, PARAMS, PRESETS, defaultParams, PROGRESS, drawnRuns, SIMPLIFY_MM,
} from '../src/styles/own/engraving.js';
import { structureField, directionField, fieldSampler, orientationDeg, boxRadiusForSigma } from '../src/styles/own/engraving/field.js';
import { streamlines, separation, DTEST } from '../src/styles/own/engraving/streamlines.js';
import { createCache, runToEnd } from '../src/styles/own/kit/stages.js';
import { polylineLength } from '../src/styles/own/kit/lines.js';
import { presetValues, matchPreset } from '../src/styles/own/kit/params.js';
import { normalizeParams } from '../src/app/photo/layer-stack.js';
import { getStyle, GROUPS } from '../src/styles/registry.js';
import { pointSegmentDistance } from '../src/core/geometry.js';
import './helpers/ru.js';

const PAPER = { mmPerPx: 0.25, penWidthMm: 0.5 }; // pen 2 px
const RAD = Math.PI / 180;
const field = (w, h, f) => { const g = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x + 0.5, y + 0.5); return g; };
/** Difference of two orientations (lines without a sign), degrees 0..90. */
const angDiff = (a, b) => { const d = (((a - b) % 180) + 180) % 180; return Math.min(d, 180 - d); };
const segAngle = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax) / RAD;
/** A constant field at angleDeg. */
const constField = (w, h, angleDeg) => ({ w, h, c2: new Float32Array(w * h).fill(Math.cos(2 * angleDeg * RAD)), s2: new Float32Array(w * h).fill(Math.sin(2 * angleDeg * RAD)) });
const segments = function* (lines) { for (const l of lines) for (let i = 2; i < l.length; i += 2) yield [l[i - 2], l[i - 1], l[i], l[i + 1]]; };
/** The value of a stage after a run with a given cache. */
const stageOf = (cache, name) => cache.get(name).value;
const run = (gray, w, h, params, paper = PAPER, cache = createCache(), extra = {}) => runToEnd(engravingSteps({ gray, w, h, params, paper, cache, ...extra }));

// --- 1. the direction field

test('field: a horizontal gradient gives vertical isophotes; a rotation of 90° — horizontal lines', () => {
  const w = 120, h = 80;
  const raw = structureField(field(w, h, (x) => 255 * (1 - x / w)), w, h, { sigmaPx: 4 });
  for (const [rot, want] of [[0, 90], [90, 0]]) {
    const f = directionField(raw, { fieldRotation: rot, baseAngle: 30 });
    let worst = 0;
    for (let y = 10; y < h - 10; y++) for (let x = 10; x < w - 10; x++) worst = Math.max(worst, angDiff(orientationDeg(f, y * w + x), want));
    assert.ok(worst <= 2, `rotation ${rot}: worst ${worst}°`);
  }
});

test('field: a radial gradient gives circles (perpendicular to the radius) outside the centre', () => {
  const w = 240, h = 240, sigma = 4, cx = w / 2, cy = h / 2;
  const raw = structureField(field(w, h, (x, y) => Math.min(255, 255 * Math.hypot(x - cx, y - cy) / 110)), w, h, { sigmaPx: sigma });
  const f = directionField(raw, { baseAngle: 30 });
  let n = 0, ok = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (r < 3 * sigma || r > 100) continue;
    n++;
    if (angDiff(orientationDeg(f, y * w + x), segAngle(cx, cy, x + 0.5, y + 0.5) + 90) <= 5) ok++;
  }
  assert.ok(ok / n >= 0.95, `${(100 * ok / n).toFixed(1)}% tangential`);
});

test('field: a uniform gray image and followForm 0 give the base angle everywhere', () => {
  const w = 80, h = 60;
  const flat = directionField(structureField(field(w, h, () => 128), w, h, { sigmaPx: 3 }), { baseAngle: -40 });
  for (let i = 0; i < w * h; i++) assert.ok(angDiff(orientationDeg(flat, i), -40) <= 0.5);
  const busy = structureField(field(w, h, (x, y) => 128 + 100 * Math.sin(x / 5) * Math.cos(y / 7)), w, h, { sigmaPx: 3 });
  const off = directionField(busy, { baseAngle: 17, followForm: 0 });
  for (let i = 0; i < w * h; i++) assert.ok(angDiff(orientationDeg(off, i), 17) <= 0.5);
});

test('field: the angle changes smoothly at a flat/gradient border', () => {
  // left half flat, right half a gradient that grows from zero (isophotes vertical, 60° from the base angle)
  const w = 200, h = 100;
  const raw = structureField(field(w, h, (x) => (x < 100 ? 200 : 200 - 40 * ((x - 100) / 100) ** 2)), w, h, { sigmaPx: 6 });
  const f = directionField(raw, { baseAngle: 30 });
  let worst = 0;
  for (let y = 5; y < h - 5; y++) for (let x = 1; x < w; x++) worst = Math.max(worst, angDiff(orientationDeg(f, y * w + x), orientationDeg(f, y * w + x - 1)));
  assert.ok(worst <= 10, `neighbouring pixels differ by ${worst}°`);
  assert.ok(angDiff(orientationDeg(f, 50 * w + 20), 30) < 1, 'flat side: the base angle');
  assert.ok(angDiff(orientationDeg(f, 50 * w + 180), 90) < 2, 'gradient side: the isophotes');
});

test('field: does not depend on contrast, gamma and inversion (the stage is reused, equal to a fresh one)', () => {
  const w = 90, h = 70;
  const gray = field(w, h, (x, y) => 128 + 90 * Math.sin(x / 9 + y / 13));
  const cache = createCache();
  run(gray, w, h, {}, PAPER, cache);
  const f1 = stageOf(cache, 'field');
  run(gray, w, h, { contrast: 40, gamma: 1.8, invert: true, brightness: -20 }, PAPER, cache);
  assert.equal(stageOf(cache, 'field'), f1, 'not recomputed');
  const fresh = createCache();
  run(gray, w, h, { contrast: 40, gamma: 1.8, invert: true }, PAPER, fresh);
  assert.deepEqual(Array.from(stageOf(fresh, 'field').c2), Array.from(f1.c2));
  assert.deepEqual(Array.from(stageOf(fresh, 'field').s2), Array.from(f1.s2));
  assert.equal(boxRadiusForSigma(16), 16);
});

test('field sampling: walking around a circle the direction sign never flips', () => {
  const w = 200, h = 200;
  const f = directionField(structureField(field(w, h, (x, y) => Math.min(255, 255 * Math.hypot(x - 100, y - 100) / 90)), w, h, { sigmaPx: 3 }), {});
  const at = fieldSampler(f);
  const out = [0, 0];
  let px = 0, py = 1, turned = 0, x = 160, y = 100;
  for (let i = 0; i < 400; i++) {
    at(x, y, px, py, out);
    assert.ok(out[0] * px + out[1] * py > 0.9, `step ${i}: the direction flipped`);
    turned += Math.asin(Math.max(-1, Math.min(1, px * out[1] - py * out[0])));
    px = out[0]; py = out[1];
    x += px; y += py;
  }
  assert.ok(Math.abs(turned) > 5, 'it really went around');
});

// --- 2. streamlines

test('streamlines: a constant field gives parallel lines dsep apart; no two lines closer than dsep/2 (all pairs)', () => {
  const w = 200, h = 200, sep = 4, angle = 30;
  const tone = new Float32Array(w * h).fill(0.5);
  const { lines } = streamlines({ w, h, field: constField(w, h, angle), tone, dsep: () => sep, dMin: sep, dMax: sep, tau: 0.1, maxLen: 1e9, minLen: 2 });
  assert.ok(lines.length > 40);
  // straight and along the angle
  for (const { pts } of lines) assert.ok(angDiff(segAngle(pts[0], pts[1], pts.at(-2), pts.at(-1)), angle) < 0.5);
  // offsets along the normal
  const nx = -Math.sin(angle * RAD), ny = Math.cos(angle * RAD);
  const offs = lines.map(({ pts }) => { let s = 0; for (let i = 0; i < pts.length; i += 2) s += pts[i] * nx + pts[i + 1] * ny; return s / (pts.length / 2); }).sort((a, b) => a - b);
  const gaps = offs.slice(1).map((o, i) => o - offs[i]);
  for (const g of gaps) assert.ok(Math.abs(g - sep) <= 0.15 * sep, `gap ${g.toFixed(2)} vs ${sep}`);
  // brute force over all point pairs of different lines
  const P = [];
  lines.forEach(({ pts }, k) => { for (let i = 0; i < pts.length; i += 2) P.push(pts[i], pts[i + 1], k); });
  let min = Infinity;
  for (let a = 0; a < P.length; a += 3) for (let b = a + 3; b < P.length; b += 3) {
    if (P[a + 2] === P[b + 2]) continue;
    const d = (P[a] - P[b]) ** 2 + (P[a + 1] - P[b + 1]) ** 2;
    if (d < min) min = d;
  }
  assert.ok(Math.sqrt(min) >= DTEST * sep - 1e-6, `closest pair ${Math.sqrt(min)}`);
  // converging lines (a fan toward a point on the right): they stop before coming closer than dsep/2
  const fan = { w, h, c2: new Float32Array(w * h), s2: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = 2 * Math.atan2(100 - (y + 0.5), 230 - (x + 0.5));
    fan.c2[y * w + x] = Math.cos(a); fan.s2[y * w + x] = Math.sin(a);
  }
  const conv = streamlines({ w, h, field: fan, tone, dsep: () => sep, dMin: sep, dMax: sep, tau: 0.1, maxLen: 1e9, minLen: 2 }).lines;
  const Q = [];
  conv.forEach(({ pts }, k) => { for (let i = 0; i < pts.length; i += 2) Q.push(pts[i], pts[i + 1], k); });
  let qmin = Infinity;
  for (let a = 0; a < Q.length; a += 3) for (let b = a + 3; b < Q.length; b += 3) {
    if (Q[a + 2] === Q[b + 2]) continue;
    const d = (Q[a] - Q[b]) ** 2 + (Q[a + 1] - Q[b + 1]) ** 2;
    if (d < qmin) qmin = d;
  }
  assert.ok(conv.length > 20 && Math.sqrt(qmin) >= DTEST * sep - 1e-6, `converging: closest pair ${Math.sqrt(qmin)}`);
});

test('streamlines: the separation follows the tone — denser toward the dark edge, no lines at the white edge', () => {
  const w = 400, h = 120, dMin = 3, dMax = 10, tau = 0.1;
  const tone = field(w, h, (x) => x / w); // white on the left, black on the right
  const dsep = (u) => separation(u, dMin, dMax);
  const { lines } = streamlines({ w, h, field: constField(w, h, 90), tone, dsep, dMin, dMax, tau, maxLen: 1e9, minLen: 2 });
  // crossings of the middle row
  const xs = [];
  for (const { pts } of lines) for (let i = 2; i < pts.length; i += 2) if ((pts[i - 1] - h / 2 - 0.123) * (pts[i + 1] - h / 2 - 0.123) < 0) xs.push(pts[i]);
  xs.sort((a, b) => a - b);
  assert.ok(xs[0] >= tau * w - 1, `no lines at the white edge: leftmost ${xs[0]}`);
  const bands = [];
  for (let x0 = 60; x0 + 80 <= w; x0 += 80) {
    const inside = xs.filter((x) => x >= x0 && x < x0 + 80);
    const gaps = inside.slice(1).map((x, i) => x - inside[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const want = dsep((x0 + 40) / w);
    assert.ok(Math.abs(mean - want) <= 0.2 * want, `band ${x0}: ${mean.toFixed(2)} vs dsep ${want.toFixed(2)}`);
    bands.push(mean);
  }
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i] < bands[i - 1], `denser to the dark: ${bands.map((b) => b.toFixed(2))}`);
});

test('streamlines: on a radial gradient lines follow circles, do not spiral, no short lines in the centre', () => {
  const w = 300, h = 300, cx = 150, cy = 150;
  const gray = field(w, h, (x, y) => Math.min(255, 255 * Math.hypot(x - cx, y - cy) / 140));
  const params = { maxPasses: 1, cross: false, smoothing: 3 };
  const g = geometry(params, PAPER);
  const cache = createCache();
  const lines = run(gray, w, h, params, PAPER, cache);
  let n = 0, ok = 0;
  for (const [ax, ay, bx, by] of segments(lines)) {
    const r = Math.hypot((ax + bx) / 2 - cx, (ay + by) / 2 - cy);
    if (r < 3 * g.sigmaPx || Math.hypot(bx - ax, by - ay) < 0.5) continue;
    n++;
    if (angDiff(segAngle(ax, ay, bx, by), segAngle(cx, cy, (ax + bx) / 2, (ay + by) / 2) + 90) <= 10) ok++;
  }
  assert.ok(ok / n >= 0.9, `${(100 * ok / n).toFixed(1)}% of segments along circles`);
  // no spirals: the total turn of every placed line is at most one full turn plus 30°
  for (const { pts } of stageOf(cache, 'streams').lines) {
    let turn = 0;
    for (let i = 4; i < pts.length; i += 2) {
      const a = Math.atan2(pts[i - 1] - pts[i - 3], pts[i - 2] - pts[i - 4]), b = Math.atan2(pts[i + 1] - pts[i - 1], pts[i] - pts[i - 2]);
      let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
    }
    assert.ok(Math.abs(turn) <= 390 * RAD, `a line turns by ${(Math.abs(turn) / RAD).toFixed(0)}°`);
  }
  // no strokes shorter than the minimum length (centre lines; simplification only shortens by its tolerance)
  for (const l of lines) assert.ok(polylineLength(l) >= g.minPx - 2 * g.tolPx, `stroke ${polylineLength(l)} < ${g.minPx}`);
});

test('streamlines: a dark circle on white — lines along its edge, the base angle inside the flat circle', () => {
  const w = 320, h = 320, cx = 160, cy = 160, R = 140;
  const gray = field(w, h, (x, y) => (Math.hypot(x - cx, y - cy) < R ? 80 : 255));
  const params = { maxPasses: 1, cross: false, smoothing: 2, baseAngle: 30 };
  const g = geometry(params, PAPER);
  const lines = run(gray, w, h, params, PAPER);
  // segment lengths (px) by zone: [all, in the expected direction]; long straight segments are split into 2 px pieces
  const edge = [0, 0], inner = [0, 0];
  for (const [ax, ay, bx, by] of segments(lines)) {
    const len = Math.hypot(bx - ax, by - ay), a = segAngle(ax, ay, bx, by), k = Math.max(1, Math.ceil(len / 2));
    for (let j = 0; j < k; j++) {
      const mx = ax + (bx - ax) * (j + 0.5) / k, my = ay + (by - ay) * (j + 0.5) / k, r = Math.hypot(mx - cx, my - cy);
      if (r > R - 0.75 * g.sigmaPx && r < R - 1) { edge[0] += len / k; if (angDiff(a, segAngle(cx, cy, mx, my) + 90) <= 15) edge[1] += len / k; }
      if (r < R - 5 * g.sigmaPx) { inner[0] += len / k; if (angDiff(a, 30) <= 5) inner[1] += len / k; }
    }
  }
  assert.ok(edge[0] > 200 && edge[1] / edge[0] >= 0.8, `edge: ${edge[1].toFixed(0)}/${edge[0].toFixed(0)} px concentric`);
  assert.ok(inner[0] > 1000 && inner[1] / inner[0] >= 0.9, `inside: ${inner[1].toFixed(0)}/${inner[0].toFixed(0)} px at the base angle`);
  for (const [x, y] of segments(lines)) assert.ok(Math.hypot(x - cx, y - cy) <= R + 2, 'no lines on white');
});

test('streamlines: a narrow highlight breaks the lines which continue on the same track; a wide one ends them', () => {
  const w = 160, h = 200, sep = 6, dMin = 6, dMax = 6, tau = 0.2;
  const opts = (tone) => ({ w, h, field: constField(w, h, 90), tone, dsep: () => sep, dMin, dMax, tau, maxLen: 1e9, minLen: 2 });
  // a horizontal white stripe across vertical lines: 8 px (< 2·dMax) and 40 px wide
  const stripe = (hw) => field(w, h, (x, y) => (Math.abs(y - 100) < hw / 2 ? 0 : 0.6));
  const narrow = streamlines(opts(stripe(8))).lines;
  const spanning = narrow.filter(({ pts }) => { const ys = pts.filter((_, i) => i & 1); return Math.min(...ys) < 90 && Math.max(...ys) > 110; });
  assert.ok(spanning.length >= 0.8 * narrow.length, `${spanning.length} of ${narrow.length} lines cross the highlight`);
  for (const line of spanning) {
    const runs = drawnRuns(line, tau);
    assert.equal(runs.length, 2, 'the line is broken on the highlight');
    const xa = line.pts[2 * runs[0][1]], xb = line.pts[2 * runs[1][0]];
    assert.ok(Math.abs(xa - xb) <= 0.2 * sep, `the track continues: ${xa} → ${xb}`);
  }
  const wide = streamlines(opts(stripe(40))).lines;
  assert.ok(wide.length > 10);
  for (const { pts } of wide) {
    const ys = pts.filter((_, i) => i & 1);
    assert.ok(!(Math.min(...ys) < 80 && Math.max(...ys) > 120), 'a wide highlight ends the line');
  }
});

test('streamlines: no line longer than maxLength (both directions together)', () => {
  const w = 300, h = 200, maxLen = 80;
  const { lines } = streamlines({ w, h, field: constField(w, h, 10), tone: new Float32Array(w * h).fill(0.5), dsep: () => 5, dMin: 5, dMax: 5, tau: 0.1, maxLen, minLen: 0 });
  assert.ok(lines.length > 10);
  let longest = 0;
  for (const { pts } of lines) longest = Math.max(longest, polylineLength(pts));
  assert.ok(longest <= maxLen + 1e-3 && longest > 0.9 * maxLen, `longest ${longest}`);
  // and in the style, in mm: maxLength 20 mm
  const gray = field(w, h, () => 100);
  const cache = createCache();
  run(gray, w, h, { maxLength: 20, cross: false }, PAPER, cache);
  for (const { pts } of stageOf(cache, 'streams').lines) assert.ok(polylineLength(pts) * PAPER.mmPerPx <= 20 + 1e-3);
});

// --- 3. cross layer, thickness, output

/** Horizontal gradient: white (left) to black (right). */
const hGradient = (w, h) => field(w, h, (x) => 255 * (1 - x / w));

test('cross layer: only in the darkest tones, at crossAngle to the main lines; off — none; its threshold keeps the main lines', () => {
  const w = 400, h = 160;
  const gray = hGradient(w, h);
  const base = { maxPasses: 1, smoothing: 2, crossAngle: 60, crossThreshold: 70 };
  const mainOnly = run(gray, w, h, { ...base, cross: false });
  const withCross = run(gray, w, h, { ...base, cross: true });
  assert.ok(withCross.length > mainOnly.length);
  const n = mainOnly.length;
  assert.deepEqual(withCross.slice(0, n).map((l) => Array.from(l)), mainOnly.map((l) => Array.from(l)), 'the main lines come first, unchanged');
  const crossLines = withCross.slice(n);
  const g = geometry(base, PAPER);
  for (const l of crossLines) {
    for (let i = 0; i < l.length; i += 2) assert.ok(l[i] / w >= 0.7 - 0.03, `a cross point at darkness ${(l[i] / w).toFixed(2)}`);
    if (polylineLength(l) > 4 * g.dMin) assert.ok(angDiff(segAngle(l[0], l[1], l.at(-2), l.at(-1)), 90 + 60) <= 5, 'at 60° to the vertical main lines');
  }
  // another threshold: the main lines are bit-identical
  const other = run(gray, w, h, { ...base, cross: true, crossThreshold: 85 });
  assert.deepEqual(other.slice(0, n).map((l) => Array.from(l)), mainOnly.map((l) => Array.from(l)));
  assert.ok(other.length - n < crossLines.length, 'a higher threshold — fewer cross lines');
});

test('thickness: 3 passes in black at passPitch·pen, thin stroke ends (a parameter), one polyline per stroke', () => {
  const w = 300, h = 80;
  const gray = field(w, h, () => 0);
  const params = { maxPasses: 3, passPitch: 0.5, followForm: 0, baseAngle: 0, cross: false, thickStart: 50 };
  const g = geometry(params, PAPER);
  const cache = createCache();
  const lines = run(gray, w, h, params, PAPER, cache);
  const placed = stageOf(cache, 'streams').lines;
  assert.equal(lines.length, placed.length, 'one polyline per placed line (no pen lifts)');
  const cross = (l, X) => { const ys = []; for (let i = 2; i < l.length; i += 2) { const a = l[i - 2], b = l[i]; if ((a - X) * (b - X) < 0) ys.push(l[i - 1] + ((X - a) / (b - a)) * (l[i + 1] - l[i - 1])); } return ys.sort((a, b) => a - b); };
  const inner = lines.filter((l) => l[1] > 3 * g.pitchPx && l[1] < h - 3 * g.pitchPx);
  assert.ok(inner.length > 5);
  for (const l of inner) {
    const ys = cross(l, w / 2 + 0.3);
    assert.equal(ys.length, 3, `3 passes: ${ys}`);
    for (let i = 1; i < 3; i++) assert.ok(Math.abs(ys[i] - ys[i - 1] - g.pitchPx) < 0.05, 'pitch apart');
    const x0 = Math.min(l[0], l.at(-2));
    assert.equal(cross(l, x0 + 0.2 * g.taperPx).length, 1, 'thin end: one pass near the end');
    assert.ok(Math.abs(l[1] - l.at(-1)) < 1e-6, 'starts and ends on the centre line');
  }
  // thin ends off: the lens starts right at the stroke end
  const blunt = run(gray, w, h, { ...params, thinEnds: false }).filter((l) => l[1] > 3 * g.pitchPx && l[1] < h - 3 * g.pitchPx);
  for (const l of blunt) assert.equal(cross(l, Math.min(l[0], l.at(-2)) + 0.2 * g.taperPx).length, 3);
});

test('output: no strokes shorter than minLength, short travels in placement order, simplification within 0.02 mm', () => {
  const w = 240, h = 180;
  const gray = field(w, h, (x, y) => 128 + 100 * Math.sin(x / 23) * Math.cos(y / 31));
  const params = { maxPasses: 1, minLength: 3, cross: false, smoothing: 3 };
  const g = geometry(params, PAPER);
  const cache = createCache();
  const lines = run(gray, w, h, params, PAPER, cache);
  assert.ok(lines.length > 30);
  for (const l of lines) assert.ok(polylineLength(l) >= g.minPx - 2 * g.tolPx, `stroke ${polylineLength(l)} < ${g.minPx}`);
  const travel = (ls) => ls.slice(1).reduce((s, l, i) => s + Math.hypot(l[0] - ls[i].at(-2), l[1] - ls[i].at(-1)), 0);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const shuffled = lines.slice();
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  assert.ok(travel(lines) < 0.5 * travel(shuffled), `travel ${travel(lines).toFixed(0)} vs random ${travel(shuffled).toFixed(0)}`);
  // every drawn centre point is within the simplification tolerance of the output
  const tol = SIMPLIFY_MM / PAPER.mmPerPx;
  const segs = [...segments(lines)];
  let worst = 0;
  for (const line of stageOf(cache, 'streams').lines) {
    for (const [a, b] of drawnRuns(line, g.tau)) {
      if (polylineLength(line.pts.slice(2 * a, 2 * b + 2)) < g.minPx) continue; // dropped as too short
      for (let i = a; i <= b; i++) {
        const x = line.pts[2 * i], y = line.pts[2 * i + 1];
        let best = Infinity;
        for (const sg of segs) if (Math.abs(sg[0] - x) < 40 || Math.abs(sg[2] - x) < 40) best = Math.min(best, pointSegmentDistance(x, y, ...sg));
        worst = Math.max(worst, best);
      }
    }
  }
  assert.ok(worst <= tol + 1e-3, `deviation ${worst} px > ${tol} px`);
});

test('stage cache: each parameter recomputes only its stages', () => {
  class Spy extends Map { constructor() { super(); this.log = []; } set(k, v) { this.log.push(k); return super.set(k, v); } }
  const w = 120, h = 90;
  const gray = field(w, h, (x, y) => 128 + 100 * Math.sin(x / 13 + y / 17));
  const cache = new Spy();
  let p = { ...defaultParams() };
  run(gray, w, h, p, PAPER, cache);
  assert.deepEqual(cache.log, ['tensor', 'field', 'tone', 'streams', 'cross', 'finish']);
  const step = (change, want) => {
    cache.log = [];
    p = { ...p, ...change };
    const lines = run(gray, w, h, p, PAPER, cache);
    assert.deepEqual(cache.log, want, JSON.stringify(change));
    assert.deepEqual(lines.map((l) => Array.from(l)), engraving(gray, w, h, p, PAPER).map((l) => Array.from(l)), 'equals a fresh run');
  };
  step({ maxPasses: 5 }, ['finish']);
  step({ thinEnds: false, thickStart: 40, passPitch: 0.6 }, ['finish']);
  step({ crossThreshold: 60 }, ['cross', 'finish']);
  step({ crossAngle: 45 }, ['cross', 'finish']);
  step({ baseAngle: -10 }, ['field', 'streams', 'cross', 'finish']);
  step({ contrast: 30 }, ['tone', 'streams', 'cross', 'finish']);
  step({ smoothing: 6 }, ['tensor', 'field', 'streams', 'cross', 'finish']);
  step({ smoothing: 6 }, []);
});

// --- determinism, presets, parameters

test('determinism: identical runs; a chain of live changes equals a fresh run; a snapshot of the placement', () => {
  const w = 160, h = 120;
  const gray = field(w, h, (x, y) => (Math.hypot(x - 70, y - 60) < 35 ? 40 : 230 - 150 * (x / w)) + 20 * Math.sin(y / 5));
  const arr = (ls) => ls.map((l) => Array.from(l));
  const a = engraving(gray, w, h, {}, PAPER);
  assert.deepEqual(arr(a), arr(engraving(gray, w, h, {}, PAPER)));
  const cache = createCache();
  const p1 = {}, p2 = { baseAngle: 70 }, p3 = { baseAngle: 70, crossThreshold: 60, maxPasses: 5 };
  for (const p of [p1, p2, p3]) run(gray, w, h, p, PAPER, cache);
  assert.deepEqual(arr(run(gray, w, h, p3, PAPER, cache)), arr(engraving(gray, w, h, p3, PAPER)));
  // the snapshot: any change of the seeding order shows up here (update deliberately)
  let len = 0;
  for (const l of a) len += polylineLength(l);
  assert.deepEqual([a.length, Math.round(len * 1e3) / 1e3], SNAPSHOT);
});
const SNAPSHOT = [55, 5907.287];

test('parameters and presets: odd pass counts, all live, valid presets, portrait = defaults, registry descriptor', () => {
  const byKey = Object.fromEntries(PARAMS.map((d) => [d.key, d]));
  assert.deepEqual([byKey.maxPasses.min, byKey.maxPasses.max, byKey.maxPasses.step], [1, 5, 2]);
  assert.equal(byKey.thinEnds.default, true);
  assert.ok(PARAMS.every((d) => d.live), 'all parameters are live');
  assert.deepEqual(PRESETS.map((p) => p.id), ['portrait', 'banknote', 'sketch']);
  for (const p of PRESETS) {
    const values = presetValues(PARAMS, p);
    assert.deepEqual(normalizeParams(PARAMS, values), values, `${p.id}: values within the ranges`);
    assert.equal(matchPreset(PARAMS, PRESETS, values), p.id);
  }
  assert.deepEqual(presetValues(PARAMS, PRESETS[0]), defaultParams());
  assert.equal(geometry({ maxPasses: 4 }, PAPER).passes, 5);
  const d = getStyle('own:engraving');
  assert.equal(d.group, GROUPS.contour);
  assert.equal(d.usesPaper, true);
  assert.equal(d.presets, PRESETS);
  // the density check gets the smallest separation in px: spacing 1 mm × sepDark 0.7 at 0.25 mm/px
  assert.ok(Math.abs(d.spacing({ ...defaultParams() }, { width: 10, height: 10 }, PAPER) - 2.8) < 1e-9);
  assert.equal(geometry({ spacing: 0.4, sepDark: 0.3 }, PAPER).dMin, 1, 'at least 1 px');
});

// --- 4. limits and performance

test('point limit: the placement stops with what it has and the style yields the "too many lines" note', () => {
  const w = 200, h = 150;
  const gray = field(w, h, (x) => 255 * (1 - x / w));
  const gen = engravingSteps({ gray, w, h, params: {}, paper: PAPER, cache: createCache(), maxPoints: 3000 });
  const notes = [];
  let lines;
  for (;;) {
    const r = gen.next();
    if (r.done) { lines = r.value; break; }
    if (r.value.note) notes.push(r.value.note.key);
  }
  assert.deepEqual(notes, [PROGRESS.limit]);
  assert.ok(lines.length > 0, 'the placed lines are shown');
  assert.ok(lines.length < engraving(gray, w, h, {}, PAPER).length);
});

/** A synthetic "photo": gradients, circles, noise with a fixed seed. */
function photo(w, h) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  return field(w, h, (x, y) => {
    let v = 255 * (1 - x / w) * 0.6 + 255 * (y / h) * 0.4;
    for (const [cx, cy, r] of [[0.3, 0.4, 0.2], [0.7, 0.6, 0.15]]) {
      const d = Math.hypot(x / w - cx, y / h - cy) / r;
      if (d < 1) v *= 0.3 + 0.7 * d * d;
    }
    return Math.min(255, Math.max(0, v + (rnd() - 0.5) * 40));
  });
}

test('budget: 1000×750 synthetic photo, 180 mm field, ≤ 3 s under STYLE_PERF=1 (otherwise 400×300 with headroom)', () => {
  const strict = process.env.STYLE_PERF === '1';
  const [w, h] = strict ? [1000, 750] : [400, 300];
  const g = photo(w, h);
  const paper = { mmPerPx: 180 / w, penWidthMm: 0.5 };
  engraving(photo(100, 75), 100, 75, {}, { mmPerPx: 1.8, penWidthMm: 0.5 }); // warm-up
  const t0 = performance.now();
  const lines = engraving(g, w, h, {}, paper);
  const ms = performance.now() - t0;
  assert.ok(lines.length > 50);
  // the budget for 1000 px; 400×300 normally takes ≈ 0.1 s, the same limit is generous there
  assert.ok(ms <= 3000, `${w}×${h}: ${ms.toFixed(0)} ms > 3000 ms`);
});

test('point limit on a real size (STYLE_PERF=1): 2000 px at the smallest spacing finishes with the note', { skip: process.env.STYLE_PERF !== '1' }, () => {
  const w = 2000, h = 1500;
  const gen = engravingSteps({ gray: photo(w, h), w, h, params: { spacing: 0.4, sepDark: 0.3, sepLight: 1 }, paper: PAPER, cache: createCache() });
  const t0 = performance.now();
  let note = null, lines;
  for (;;) { const r = gen.next(); if (r.done) { lines = r.value; break; } if (r.value.note) note = r.value.note.key; }
  assert.equal(note, PROGRESS.limit);
  assert.ok(lines.length > 0);
  assert.ok(performance.now() - t0 < 15000);
});
