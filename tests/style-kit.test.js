// Shared pure helpers of own styles (src/styles/own/kit): line families, paper scale, thickness by passes, output order,
// staged cache, translated parameter descriptions and presets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineFamily, clipLine, arcLengths, dropShort, polylineLength } from '../src/styles/own/kit/lines.js';
import { DEFAULT_PAPER, paperOf, mmToPx, pxToMm, samePaper } from '../src/styles/own/kit/paper.js';
import { thicknessProfile, thicken, smoothstep, oddPasses, normalsAndRadii } from '../src/styles/own/kit/stroke.js';
import { orientChain, orientGroups, reversePolyline } from '../src/styles/own/kit/order.js';
import { createCache, stage, stageGen, runToEnd, progressOf } from '../src/styles/own/kit/stages.js';
import { paramFactory, presetFactory, optionText, presetValues, matchPreset } from '../src/styles/own/kit/params.js';
import { setLocale } from '../src/i18n/index.js';
import { dictionaries } from '../src/i18n/index.js';
import { sameData } from './helpers/same.js';

const near = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);

// --- lines.js, paper.js

test('lineFamily: 0°/45°/90° cover the rectangle with step s, segments inside the image', () => {
  const w = 120, h = 80, s = 5;
  for (const angle of [0, 45, 90, -30]) {
    const fam = lineFamily(w, h, angle, s);
    const diag = Math.hypot(w, h);
    // the extent of the rectangle across the lines
    const th = (angle * Math.PI) / 180;
    const across = Math.abs(w * Math.sin(th)) + Math.abs(h * Math.cos(th));
    assert.ok(Math.abs(fam.length - across / s) <= 1.01, `${angle}°: ${fam.length} lines for ${across / s}`);
    assert.ok(fam.length <= Math.floor(diag / s) + 1);
    for (let i = 1; i < fam.length; i++) assert.equal(fam[i].j, fam[i - 1].j + 1, 'consecutive j');
    for (const l of fam) {
      for (const t of [l.t0, l.t1]) {
        const x = l.ox + l.dx * t, y = l.oy + l.dy * t;
        assert.ok(x >= -1e-6 && x <= w + 1e-6 && y >= -1e-6 && y <= h + 1e-6, `${angle}°: (${x}, ${y}) inside`);
      }
      near(Math.hypot(l.dx, l.dy), 1);
      near(l.dx * l.nx + l.dy * l.ny, 0);
    }
    // the step between neighbours along the normal is s
    if (fam.length > 1) {
      const a = fam[0], b = fam[1];
      near((b.ox - a.ox) * a.nx + (b.oy - a.oy) * a.ny, s);
    }
  }
  assert.equal(lineFamily(100, 100, 0, 10).length, 11, 'horizontals at y = 50 ± 10k inside [0, 100], ends included');
  assert.equal(clipLine(-5, 5, 0, 1, 10, 10), null, 'a vertical outside the rectangle misses it');
});

test('arcLengths, polylineLength, dropShort', () => {
  const l = Float64Array.of(0, 0, 3, 4, 3, 10);
  assert.deepEqual(Array.from(arcLengths(l)), [0, 5, 11]);
  assert.equal(polylineLength(l), 11);
  const short = Float64Array.of(0, 0, 1, 0);
  assert.deepEqual(dropShort([l, short], 2), [l]);
  assert.deepEqual(dropShort([l, short], 0), [l, short]);
});

test('paper: defaults, mm <-> px, comparison', () => {
  assert.deepEqual({ ...DEFAULT_PAPER }, { mmPerPx: 0.25, penWidthMm: 0.5 });
  assert.equal(mmToPx(1, undefined), 4);
  assert.equal(mmToPx(1, { mmPerPx: 0.5, penWidthMm: 0.3 }), 2);
  assert.equal(pxToMm(8, null), 2);
  assert.deepEqual(paperOf({ mmPerPx: -1, penWidthMm: 0.8 }), { mmPerPx: 0.25, penWidthMm: 0.8 });
  assert.equal(samePaper({ mmPerPx: 0.25, penWidthMm: 0.5 }, { mmPerPx: 0.25 * (1 + 1e-9), penWidthMm: 0.5 }), true);
  assert.equal(samePaper({ mmPerPx: 0.25, penWidthMm: 0.5 }, { mmPerPx: 0.2501, penWidthMm: 0.5 }), false);
  assert.equal(samePaper({ mmPerPx: 0.25, penWidthMm: 0.5 }, { mmPerPx: 0.25, penWidthMm: 0.8 }), false);
});

// --- stroke.js

const straight = (len = 100, ds = 0.5) => {
  const n = Math.round(len / ds) + 1;
  const pts = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) pts[2 * i] = i * ds;
  return pts;
};
// the y values where the polyline crosses the vertical x = X (with multiplicity)
function crossings(pts, X) {
  const ys = [];
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2], x1 = pts[i];
    if ((x0 - X) * (x1 - X) < 0 || (x1 === X && x0 !== X)) {
      const t = (X - x0) / (x1 - x0);
      ys.push(pts[i - 1] + t * (pts[i + 1] - pts[i - 1]));
    }
  }
  return ys.sort((a, b) => a - b);
}
const step = (n, from, to, value) => Float64Array.from({ length: n }, (_, i) => (i >= from && i <= to ? value : 0));

test('thicknessProfile: odd pass counts, smooth growth from startTone, 1 pass gives no thickening', () => {
  assert.equal(thicknessProfile(1, { maxPasses: 1 }), 0);
  assert.equal(thicknessProfile(1, { maxPasses: 3, startTone: 0.6 }), 1);
  assert.equal(thicknessProfile(1, { maxPasses: 5, startTone: 0.6 }), 2);
  assert.equal(thicknessProfile(0.6, { maxPasses: 5, startTone: 0.6 }), 0);
  assert.equal(thicknessProfile(0.3, { maxPasses: 5, startTone: 0.6 }), 0);
  let prev = -1;
  for (let u = 0; u <= 1.0001; u += 0.01) { const v = thicknessProfile(u, { maxPasses: 5, startTone: 0.4 }); assert.ok(v >= prev - 1e-12); prev = v; }
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map((v) => oddPasses(v)), [1, 1, 3, 3, 5, 5, 5, 5]);
  assert.equal(smoothstep(0, 0, 0), 0);
  assert.equal(smoothstep(0, 2, 1), 0.5);
});

test('thicken: level 0 gives the source line', () => {
  const c = straight();
  assert.deepEqual(Array.from(thicken(c, new Float64Array(c.length / 2), { pitchPx: 1, taperPx: 5 })), Array.from(c));
});

test('thicken: a level-1 step in the middle — one polyline, same ends, 3 passes at 0 and ±pitch, smooth tapering', () => {
  const c = straight(100, 0.5), n = c.length / 2, pitch = 1.2, taper = 5;
  const out = thicken(c, step(n, 60, 140, 1), { pitchPx: pitch, taperPx: taper });
  assert.deepEqual([out[0], out[1]], [0, 0], 'starts at the centre start');
  assert.deepEqual([out.at(-2), out.at(-1)], [100, 0], 'ends at the centre end');
  const mid = crossings(out, 50.25);
  assert.equal(mid.length, 3, `three passes in the middle: ${mid}`);
  mid.forEach((y, i) => near(y, (i - 1) * pitch, 1e-9));
  assert.equal(crossings(out, 10.25).length, 1, 'one pass outside the step');
  assert.equal(crossings(out, 90.25).length, 1);
  // neighbouring passes are at most pitch apart (pitch < the pen width -> they merge)
  for (let i = 1; i < mid.length; i++) assert.ok(mid[i] - mid[i - 1] <= pitch + 1e-9);
  // at the lens ends the offset goes to 0: right after the start the pass is close to the centre
  const nearEnd = crossings(out, 30.25);
  assert.ok(Math.max(...nearEnd.map(Math.abs)) < 0.1 * pitch, `taper start ${nearEnd}`);
  // no jumps between neighbouring points: at most 2 sample steps
  for (let i = 2; i < out.length; i += 2) assert.ok(Math.hypot(out[i] - out[i - 2], out[i + 1] - out[i - 1]) <= 2 * 0.5 + 1e-9, `jump at ${i}`);
});

test('thicken: level 2 — 5 passes, the level-2 lens is nested in the level-1 lens', () => {
  const c = straight(100, 0.5), n = c.length / 2, pitch = 1;
  const lv = Float64Array.from({ length: n }, (_, i) => (i >= 80 && i <= 120 ? 2 : i >= 40 && i <= 160 ? 1 : 0));
  const out = thicken(c, lv, { pitchPx: pitch, taperPx: 4 });
  const mid = crossings(out, 50.25);
  assert.deepEqual(mid.map((y) => Math.round(y * 1e6) / 1e6), [-2, -1, 0, 1, 2]);
  assert.equal(crossings(out, 30.25).length, 3, 'only level 1 there');
  assert.equal(crossings(out, 10.25).length, 1);
  assert.equal(Math.max(...Array.from(out).filter((_, i) => i % 2 === 1).map(Math.abs)) <= 2 * pitch + 1e-9, true);
});

test('thicken: a run shorter than 2·taper makes no lens; endTaper thins the stroke ends', () => {
  const c = straight(100, 0.5), n = c.length / 2;
  const out = thicken(c, step(n, 100, 115, 1), { pitchPx: 1, taperPx: 5 }); // 7.5 px < 10
  sameData(Array.from(out), Array.from(c));
  const full = thicken(c, new Float64Array(n).fill(2), { pitchPx: 1, taperPx: 2, endTaperPx: 30 });
  // near the ends the level is scaled down: only 1 pass at x=5 (level 2·5/30 < 0.5), 5 in the middle
  assert.equal(crossings(full, 5.25).length, 1);
  assert.equal(crossings(full, 50.25).length, 5);
  assert.ok(crossings(full, 20.25).length === 3, `${crossings(full, 20.25)}`);
});

test('thicken: on a sine with a tight crest the offset stays within 0.9·R', () => {
  const pts = [];
  for (let x = 0; x <= 60; x += 0.25) pts.push(x, 3 * Math.sin(x)); // crest radius 1/3
  const c = Float64Array.from(pts), n = c.length / 2;
  const { R } = normalsAndRadii(c);
  const minR = Math.min(...R);
  assert.ok(minR > 0.3 && minR < 0.4, `crest radius ${minR}`);
  const pitch = 1;
  const out = thicken(c, new Float64Array(n).fill(1), { pitchPx: pitch, taperPx: 2 });
  // every output point lies within its centre point's offset bound: distance to the centre line ≤ min(pitch, 0.9·R) at the crest
  let crestOffsets = 0;
  for (let i = 0; i < out.length; i += 2) {
    const x = out[i], y = out[i + 1];
    // nearest centre vertex
    let best = Infinity, bi = 0;
    for (let k = 0; k < n; k++) { const d = Math.hypot(x - c[2 * k], y - c[2 * k + 1]); if (d < best) { best = d; bi = k; } }
    assert.ok(best <= Math.min(pitch, 0.9 * R[bi]) + 0.15, `offset ${best} > 0.9R=${0.9 * R[bi]}`);
    if (R[bi] < 0.5) crestOffsets++;
  }
  assert.ok(crestOffsets > 0);
});

// --- order.js

test('orientChain: order kept, each next stroke starts closer to the previous end; parallel segments alternate', () => {
  const segs = [0, 1, 2, 3, 4].map((y) => Float64Array.of(0, y, 10, y));
  const out = orientChain(segs);
  assert.equal(out.length, 5);
  out.forEach((s, i) => assert.equal(s[1], i, 'order kept'));
  const dirs = out.map((s) => Math.sign(s[2] - s[0]));
  assert.deepEqual(dirs, [1, -1, 1, -1, 1]);
  for (let i = 1; i < out.length; i++) {
    const p = out[i - 1], s = out[i];
    assert.ok(Math.hypot(s[0] - p[2], s[1] - p[3]) <= Math.hypot(s[2] - p[2], s[3] - p[3]));
  }
  assert.equal(out[0], segs[0], 'unreversed strokes are the same objects');
  assert.deepEqual(Array.from(orientChain([segs[0]], [10, 0])[0]), [10, 0, 0, 0], 'start point');
  assert.deepEqual(Array.from(reversePolyline(Float64Array.of(1, 2, 3, 4, 5, 6))), [5, 6, 3, 4, 1, 2]);
});

test('orientGroups: lines with gaps make a serpentine (the whole line is reversed)', () => {
  const line = (y) => [Float64Array.of(0, y, 3, y), Float64Array.of(5, y, 7, y), Float64Array.of(8, y, 10, y)];
  const out = orientGroups([line(0), line(1), [], line(2)]);
  assert.equal(out.length, 9);
  assert.deepEqual(out.slice(0, 3).map((s) => s[0]), [0, 5, 8]);
  assert.deepEqual(out.slice(3, 6).map((s) => [s[0], s[2]]), [[10, 8], [7, 5], [3, 0]]);
  assert.deepEqual(out.slice(6).map((s) => s[0]), [0, 5, 8]);
});

// --- stages.js

test('stages: equal deps — no recompute; a changed dep recomputes it and the next stages; runToEnd returns the value', () => {
  const calls = { a: 0, b: 0, c: 0 };
  function* steps(cache, p) {
    const a = stage(cache, 'a', [p.x], () => { calls.a++; return { v: p.x * 2 }; });
    yield { progress: 1 };
    const b = yield* stageGen(cache, 'b', [a, p.y], function* () { calls.b++; yield { progress: 2 }; return { v: a.v + p.y }; });
    const c = stage(cache, 'c', [b, p.z], () => { calls.c++; return b.v * p.z; });
    return c;
  }
  const cache = createCache();
  assert.equal(runToEnd(steps(cache, { x: 1, y: 2, z: 3 })), 12);
  assert.deepEqual(calls, { a: 1, b: 1, c: 1 });
  assert.equal(runToEnd(steps(cache, { x: 1, y: 2, z: 3 })), 12);
  assert.deepEqual(calls, { a: 1, b: 1, c: 1 }, 'all cached');
  assert.equal(runToEnd(steps(cache, { x: 1, y: 2, z: 4 })), 16);
  assert.deepEqual(calls, { a: 1, b: 1, c: 2 }, 'only the last stage');
  assert.equal(runToEnd(steps(cache, { x: 5, y: 2, z: 4 })), 48);
  assert.deepEqual(calls, { a: 2, b: 2, c: 3 }, 'the first stage invalidates the chain');
  // a dropped generator stores nothing for the unfinished stage
  const g = steps(cache, { x: 5, y: 7, z: 4 });
  g.next(); g.next(); // inside stage b
  assert.equal(runToEnd(steps(cache, { x: 5, y: 2, z: 4 })), 48);
  assert.deepEqual(calls, { a: 2, b: 3, c: 3 }, 'b with y=7 was not stored, y=2 still cached');
  assert.equal(stage(null, 'x', [NaN], () => 7), 7);
  assert.deepEqual(progressOf('k', 0.404), { progress: { key: 'k', params: { percent: 40 } } });
});

// --- params.js

test('params: labels, option labels and preset names follow the language without rebuilding the descriptor', () => {
  const { en, ru } = dictionaries;
  en['kit.test.param.mode'] = 'Mode'; ru['kit.test.param.mode'] = 'Режим';
  en['kit.test.mode.both'] = 'Both'; ru['kit.test.mode.both'] = 'Обе';
  en['kit.test.preset.bold'] = 'Bold'; ru['kit.test.preset.bold'] = 'Крупно';
  try {
    const param = paramFactory('kit.test'), preset = presetFactory('kit.test');
    const d = param({ key: 'mode', type: 'select', options: ['a', 'both'], default: 'both' });
    const n = param({ key: 'x', type: 'number', min: 0, max: 10, step: 1, default: 2 });
    const p = preset('bold', { x: 5 });
    setLocale('en');
    assert.equal(d.label, 'Mode');
    assert.equal(optionText(d, 'both'), 'Both');
    assert.equal(p.label, 'Bold');
    setLocale('ru');
    assert.equal(d.label, 'Режим');
    assert.equal(optionText(d, 'both'), 'Обе');
    assert.equal(p.label, 'Крупно');
    assert.equal(optionText({ options: ['x'] }, 'x'), 'x', 'no optionLabel — the value');
    assert.equal(n.optionLabel, undefined);
    assert.deepEqual(Object.keys(d).sort(), ['default', 'key', 'label', 'optionLabel', 'options', 'type']);
    // presets: defaults ⊕ preset values; matching
    const descs = [d, n];
    assert.deepEqual(presetValues(descs, p), { mode: 'both', x: 5 });
    assert.equal(matchPreset(descs, [p], { mode: 'both', x: 5 }), 'bold');
    assert.equal(matchPreset(descs, [p], { mode: 'both', x: 5 + 1e-12 }), 'bold');
    assert.equal(matchPreset(descs, [p], { mode: 'a', x: 5 }), '');
  } finally {
    setLocale('en');
    for (const k of ['kit.test.param.mode', 'kit.test.mode.both', 'kit.test.preset.bold']) { delete en[k]; delete ru[k]; }
  }
});
