// "Wave lines" on synthetic images: density vs tone, amplitude/frequency modulation, thickness passes, the amplitude cap,
// light breaks with hysteresis, angle and serpentine, mm on paper, determinism, presets, performance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waves, waveLine, geometry, PARAMS, PRESETS, defaultParams, MODES, HYSTERESIS } from '../src/styles/own/waves.js';
import { lineFamily } from '../src/styles/own/kit/lines.js';
import { presetValues, matchPreset } from '../src/styles/own/kit/params.js';
import { normalizeParams } from '../src/app/photo/layer-stack.js';
import { pointSegmentDistance } from '../src/core/geometry.js';
import './helpers/ru.js';

const PAPER = { mmPerPx: 0.25, penWidthMm: 0.5 }; // pen 2 px
const field = (w, h, f) => { const g = new Float32Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y); return g; };
// white (255) on the left to black (0) on the right
const gradient = (w, h) => field(w, h, (x) => 255 * (1 - x / (w - 1)));
const pointsOf = (l) => { const out = []; for (let i = 0; i < l.length; i += 2) out.push([l[i], l[i + 1]]); return out; };
const allPoints = (lines) => lines.flatMap(pointsOf);

/** Lines at angle 0 grouped by family line j: centre y = h/2 + j·s (j from the mean y of the line). */
function byFamily(lines, h, s) {
  const m = new Map();
  for (const l of lines) {
    let sy = 0; for (let i = 1; i < l.length; i += 2) sy += l[i];
    const j = Math.round((sy / (l.length / 2) - h / 2) / s);
    if (!m.has(j)) m.set(j, []);
    m.get(j).push(l);
  }
  return m;
}
/** Polyline crossings with the vertical x = X: the y values. */
function crossX(l, X) {
  const ys = [];
  for (let i = 2; i < l.length; i += 2) {
    const x0 = l[i - 2], x1 = l[i];
    if ((x0 - X) * (x1 - X) < 0) ys.push(l[i - 1] + ((X - x0) / (x1 - x0)) * (l[i + 1] - l[i - 1]));
  }
  return ys.sort((a, b) => a - b);
}

// --- tone -> amplitude, frequency

test('amplitude mode: no lines at the white edge, the deviation grows with darkness to A_max, the period stays', () => {
  const w = 400, h = 160;
  const params = { mode: 'amplitude', maxPasses: 1, spacing: 2, amplitude: 0.3, threshold: 8 };
  const g = geometry(params, PAPER);
  assert.equal(g.s, 8);
  assert.ok(Math.abs(g.aMax - 2.4) < 1e-9, `aMax ${g.aMax}`);
  const lines = waves(gradient(w, h), w, h, params, PAPER);
  assert.ok(lines.length > 0);
  const pts = allPoints(lines);
  const minX = Math.min(...pts.map((p) => p[0]));
  assert.ok(minX > 0.05 * w, `no lines at the white edge: leftmost x=${minX}`);
  // mean |deviation| from the line's straight centre in x bands: grows monotonically
  const fam = byFamily(lines, h, g.s);
  const bands = [], band = 40;
  for (let x0 = 40; x0 + band <= w; x0 += band) {
    let sum = 0, n = 0;
    for (const [j, ls] of fam) {
      const yc = h / 2 + j * g.s;
      if (yc < g.s || yc > h - g.s) continue; // edge lines may be clamped
      for (const l of ls) for (const [x, y] of pointsOf(l)) if (x >= x0 && x < x0 + band) { sum += Math.abs(y - yc); n++; }
    }
    bands.push(n ? sum / n : 0);
  }
  for (let i = 1; i < bands.length; i++) assert.ok(bands[i] > bands[i - 1], `bands grow: ${bands.map((b) => b.toFixed(2))}`);
  // at the black edge the crest deviation is A_max ± 10 %
  let maxDev = 0;
  for (const [j, ls] of fam) {
    const yc = h / 2 + j * g.s;
    if (yc < g.s || yc > h - g.s) continue;
    for (const l of ls) for (const [x, y] of pointsOf(l)) if (x > w - 20) maxDev = Math.max(maxDev, Math.abs(y - yc));
  }
  assert.ok(Math.abs(maxDev - g.aMax) <= 0.1 * g.aMax, `crest ${maxDev} vs A_max ${g.aMax}`);
});

// zero crossings of a line around its centre in [x0, x1)
function zeroCrossings(ls, yc, x0, x1) {
  let n = 0;
  for (const l of ls) {
    for (let i = 2; i < l.length; i += 2) {
      const xa = l[i - 2], xb = l[i];
      if (Math.min(xa, xb) < x0 || Math.max(xa, xb) >= x1) continue;
      if ((l[i - 1] - yc) * (l[i + 1] - yc) < 0) n++;
    }
  }
  return n;
}

test('frequency mode: crossings per length grow with darkness, the period in black ≈ wavelength, the amplitude is constant', () => {
  const w = 480, h = 120, black = 360;
  const params = { mode: 'frequency', maxPasses: 1, spacing: 2, amplitude: 0.3, wavelength: 2, threshold: 8 };
  const g = geometry(params, PAPER);
  // white to black over the first 3/4, then black
  const lines = waves(field(w, h, (x) => 255 * Math.max(0, 1 - x / black)), w, h, params, PAPER);
  const fam = byFamily(lines, h, g.s);
  const rows = [...fam].filter(([j]) => Math.abs(j) <= 3);
  assert.ok(rows.length >= 5);
  const band = 80, density = [];
  for (let x0 = 40; x0 + band <= black; x0 += band) {
    let n = 0;
    for (const [j, ls] of rows) n += zeroCrossings(ls, h / 2 + j * g.s, x0, x0 + band);
    density.push(n / rows.length / band);
  }
  for (let i = 1; i < density.length; i++) assert.ok(density[i] > density[i - 1], `crossings grow: ${density.map((d) => d.toFixed(3))}`);
  // the black part (u = 1): period = 2·length / crossings
  let n = 0;
  for (const [j, ls] of rows) n += zeroCrossings(ls, h / 2 + j * g.s, black + 10, w - 10);
  const period = (2 * (w - 20 - black) * rows.length) / n;
  assert.ok(Math.abs(period - g.lambda) <= 0.1 * g.lambda, `period ${period} vs ${g.lambda}`);
  // amplitude: the crests are A_max in the darker half and in the lighter part above the threshold
  for (const [x0, x1] of [[w * 0.25, w * 0.4], [black, w]]) {
    let dev = 0;
    for (const [j, ls] of rows) for (const l of ls) for (const [x, y] of pointsOf(l)) if (x >= x0 && x < x1) dev = Math.max(dev, Math.abs(y - (h / 2 + j * g.s)));
    assert.ok(Math.abs(dev - g.aMax) <= 0.1 * g.aMax, `crest ${dev} in [${x0}, ${x1})`);
  }
  // one continuous stroke per line above the threshold
  for (const [, ls] of rows) assert.equal(ls.length, 1);
});

test('phase continuity: a frequency jump keeps the wave continuous (no step in the displacement)', () => {
  const w = 200, h = 20;
  // raw darkness (no blur): 0.3 on the left, 1 on the right — the frequency jumps at x = 100, the amplitude stays
  const dark = field(w, h, (x) => (x < 100 ? 0.3 : 1));
  const [line] = lineFamily(w, h, 0, 100).filter((l) => l.j === 0);
  const opts = { s: 8, aMax: 3, lambda: 6, mode: 'frequency', threshold: 0, stagger: false };
  const [stroke] = waveLine(line, dark, w, h, opts);
  const ds = Math.min(0.5, opts.lambda / 16);
  const maxSlope = (opts.aMax * 2 * Math.PI) / opts.lambda; // |dy/dt| of the densest wave
  let jump = 0;
  for (let i = 2; i < stroke.pts.length; i += 2) jump = Math.max(jump, Math.abs(stroke.pts[i + 1] - stroke.pts[i - 1]));
  assert.ok(jump <= maxSlope * ds * 1.05, `largest step ${jump} vs ${maxSlope * ds}`);
  // the period differs on both sides
  const zc = (x0, x1) => {
    let n = 0;
    for (let i = 2; i < stroke.pts.length; i += 2) {
      if (stroke.pts[i] < x0 || stroke.pts[i] >= x1) continue;
      if ((stroke.pts[i - 1] - h / 2) * (stroke.pts[i + 1] - h / 2) < 0) n++;
    }
    return n;
  };
  assert.ok(zc(0, 95) * 2 < zc(105, 200), `denser on the dark side: ${zc(0, 95)} vs ${zc(105, 200)}`);
});

// --- thickness

test('thickness: 3 and 5 passes in black at pass pitch, 1 pass in the light part, one polyline per stroke', () => {
  const w = 240, h = 80;
  for (const maxPasses of [3, 5]) {
    const params = { maxPasses, passPitch: 0.5, amplitude: 0, spacing: 4, threshold: 0, thickStart: 60 };
    const g = geometry(params, PAPER);
    const lines = waves(field(w, h, () => 0), w, h, params, PAPER);
    const fam = lineFamily(w, h, 0, g.s);
    assert.equal(lines.length, fam.length, 'one polyline per family line (no pen lifts)');
    for (const l of lines) {
      const ys = crossX(l, 120.3);
      if (Math.min(...ys) < 2 * g.pitchPx || Math.max(...ys) > h - 2 * g.pitchPx) continue; // clamped edge lines
      assert.equal(ys.length, maxPasses, `${maxPasses} passes: ${ys}`);
      for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] <= g.pitchPx + 1e-6, 'neighbouring passes ≤ pitch apart');
      assert.ok(g.pitchPx < g.penPx, 'pitch is smaller than the pen width: the passes merge');
    }
  }
  // the gradient: the light part has one pass, the black part five
  const params = { maxPasses: 5, passPitch: 0.5, amplitude: 0, spacing: 2, threshold: 0, thickStart: 50 };
  const lines = waves(gradient(w, h), w, h, params, PAPER);
  const mid = lines.filter((l) => Math.abs(l[1] - h / 2) < 1 || Math.abs(l.at(-1) - h / 2) < 1);
  assert.ok(mid.length >= 1);
  for (const l of mid) {
    assert.equal(crossX(l, 0.3 * w + 0.3).length, 1, 'light: 1 pass');
    assert.equal(crossX(l, w - 12.3).length, 5, 'black: 5 passes');
  }
});

test('amplitude cap: neighbouring lines at full thickness never touch, even in antiphase', () => {
  const w = 120, h = 64;
  const params = { maxPasses: 5, passPitch: 0.5, amplitude: 0.5, spacing: 3, mode: 'amplitude', stagger: true, threshold: 0, wavelength: 3 };
  const g = geometry(params, PAPER);
  assert.ok(g.aMax > 0 && g.aMax < 0.5 * g.s, `the cap works here: ${g.aMax} < ${0.5 * g.s}`);
  assert.ok(Math.abs(g.aMax - (g.s - g.wMax) / 2) < 1e-9);
  const lines = waves(field(w, h, () => 0), w, h, params, PAPER);
  const fam = byFamily(lines, h, g.s);
  const js = [...fam.keys()].sort((a, b) => a - b).filter((j) => Math.abs(h / 2 + j * g.s - h / 2) < h / 2 - g.s);
  let minGap = Infinity;
  for (let k = 1; k < js.length; k++) {
    const [a] = fam.get(js[k - 1]), [b] = fam.get(js[k]);
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] < 10 || a[i] > w - 10) continue;
      for (let m = 2; m < b.length; m += 2) {
        if (Math.abs(b[m] - a[i]) > 4) continue;
        minGap = Math.min(minGap, pointSegmentDistance(a[i], a[i + 1], b[m - 2], b[m - 1], b[m], b[m + 1]));
      }
    }
  }
  // the outermost passes are K·pitch from the centre lines; their ink edges (pen/2 each) must not overlap
  assert.ok(minGap >= g.penPx - 0.05, `outer passes ${minGap} px apart, pen ${g.penPx} px`);
  // and a wider pen or more passes reduce the amplitude down to 0
  assert.equal(geometry({ ...params, spacing: 1.2 }, { mmPerPx: 0.25, penWidthMm: 1 }).aMax, 0);
});

test('stagger: off — neighbours in phase, on — every other line shifted by half a period', () => {
  const w = 160, h = 40;
  const base = { mode: 'amplitude', maxPasses: 1, amplitude: 0.2, spacing: 3, threshold: 0, wavelength: 3 };
  const sample = (lines, yc) => {
    const l = lines.find((q) => Math.abs(q[1] - yc) < 4);
    // y at x = 83 (a quarter period from the centre) by interpolation
    for (let i = 2; i < l.length; i += 2) {
      const x0 = l[i - 2], x1 = l[i];
      if ((x0 - 83) * (x1 - 83) <= 0 && x0 !== x1) return l[i - 1] + ((83 - x0) / (x1 - x0)) * (l[i + 1] - l[i - 1]) - yc;
    }
    return NaN;
  };
  const s = geometry(base, PAPER).s;
  const gray = field(w, h, () => 0);
  const inPhase = waves(gray, w, h, base, PAPER), shifted = waves(gray, w, h, { ...base, stagger: true }, PAPER);
  const d0 = sample(inPhase, h / 2), d1 = sample(inPhase, h / 2 + s);
  const e0 = sample(shifted, h / 2), e1 = sample(shifted, h / 2 + s);
  assert.ok(Math.abs(d0) > 0.3, `a visible displacement ${d0}`);
  assert.ok(Math.abs(d0 - d1) < 1e-6, `in phase: ${d0} ${d1}`);
  assert.ok(Math.abs(e0 - d0) < 1e-6, 'line 0 unchanged');
  assert.ok(Math.abs(e1 + d1) < 1e-6, `line 1 in antiphase: ${e1} vs ${-d1}`);
});

// --- breaks

test('dark circle on white: strokes only inside the circle; small specks and short strokes are dropped', () => {
  const w = 200, h = 160, R = 40;
  const lines = waves(field(w, h, (x, y) => (Math.hypot(x - 100, y - 80) < R ? 0 : 255)), w, h, {}, PAPER);
  const s = geometry({}, PAPER).s;
  assert.ok(lines.length > 10);
  for (const [x, y] of allPoints(lines)) assert.ok(Math.hypot(x - 100, y - 80) <= R + s, `(${x}, ${y}) outside the circle`);
  // specks: 3×3 dark blobs survive the blur as short strokes; a minimum length removes them
  const specks = field(w, h, (x, y) => ([[30, 30], [150, 40], [60, 120], [170, 130]].some(([cx, cy]) => Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1) ? 0 : 255));
  assert.ok(waves(specks, w, h, { minLength: 0 }, PAPER).length > 0, 'without a minimum length something remains');
  assert.equal(waves(specks, w, h, { minLength: 3 }, PAPER).length, 0);
  assert.equal(waves(field(w, h, () => 255), w, h, {}, PAPER).length, 0, 'white — no lines');
});

test('a highlight shorter than the line step does not break the line, a wide one does', () => {
  const w = 200, h = 60;
  const params = { threshold: 50, maxPasses: 1, spacing: 2 }; // s = 8 px, blur radius 4
  const stripe = (width) => field(w, h, (x) => (x >= 100 && x < 100 + width ? 255 : 0));
  const count = (lines) => byFamily(lines, h, 8);
  for (const [, ls] of count(waves(stripe(5), w, h, params, PAPER))) assert.equal(ls.length, 1, 'narrow highlight (still below the threshold after the blur): one stroke');
  for (const [, ls] of count(waves(stripe(30), w, h, params, PAPER))) assert.equal(ls.length, 2, 'wide highlight: two strokes');
});

test('hysteresis: tone hovering just below the threshold does not lift a pen that is down, nor lower a lifted one', () => {
  const w = 300, h = 10, tau = 0.4;
  const [line] = lineFamily(w, h, 0, 100).filter((l) => l.j === 0);
  const opts = { s: 8, aMax: 0, lambda: 6, mode: 'amplitude', threshold: tau * 100, stagger: false };
  const below = tau - HYSTERESIS / 2;
  // on, hover just below, on again: one stroke over the whole width
  const hover = field(w, h, (x) => (x < 100 || x >= 200 ? tau + 0.01 : below));
  assert.equal(waveLine(line, hover, w, h, opts).length, 1);
  // well below (beyond the hysteresis) for longer than a step: two strokes
  const gap = field(w, h, (x) => (x < 100 || x >= 200 ? tau + 0.01 : tau - 2 * HYSTERESIS));
  assert.equal(waveLine(line, gap, w, h, opts).length, 2);
  // starting in the hysteresis band: the pen is up until the tone reaches the threshold
  const start = field(w, h, (x) => (x < 150 ? below : tau + 0.01));
  const [st] = waveLine(line, start, w, h, opts);
  assert.ok(st.pts[0] >= 149, `starts at the threshold: ${st.pts[0]}`);
});

// --- angle, serpentine, mm

test('angle 30° and serpentine on uniform gray: direction, alternation, short transitions', () => {
  const w = 300, h = 200;
  const params = { angle: 30, maxPasses: 1 };
  const g = geometry(params, PAPER);
  const lines = waves(field(w, h, () => 128), w, h, params, PAPER);
  assert.ok(lines.length > 20);
  const dirs = lines.map((l) => Math.atan2(l.at(-1) - l[1], l.at(-2) - l[0]) * 180 / Math.PI);
  const long = lines.map((l, i) => [l, dirs[i]]).filter(([l]) => Math.hypot(l.at(-2) - l[0], l.at(-1) - l[1]) > 50);
  for (const [, d] of long) {
    const a = ((d % 180) + 180) % 180;
    assert.ok(Math.abs(a - 30) <= 1, `direction ${d}`);
  }
  for (let i = 1; i < lines.length; i++) {
    const cos = Math.cos((dirs[i] - dirs[i - 1]) * Math.PI / 180);
    assert.ok(cos < -0.99, `neighbours run in opposite directions (${dirs[i - 1]}, ${dirs[i]})`);
    const p = lines[i - 1], q = lines[i];
    const gap = Math.hypot(q[0] - p.at(-2), q[1] - p.at(-1));
    // the ends of neighbouring lines on an image edge at 30° to them are s/sin 30° = 2s apart (1.15s on the 60° edges)
    assert.ok(gap <= g.s / Math.sin(Math.PI / 6) + 2 * g.aMax + 1e-6, `transition ${gap} > 2s`);
  }
  const gaps = lines.slice(1).map((q, i) => Math.hypot(q[0] - lines[i].at(-2), q[1] - lines[i].at(-1))).sort((a, b) => a - b);
  assert.ok(gaps[Math.floor(gaps.length / 2)] <= 1.5 * g.s + 2 * g.aMax, 'the typical transition is about one step');
});

test('mm on paper: the same picture at 200×150 / 0.8 mm/px and 400×300 / 0.4 mm/px gives the same lines on paper', () => {
  const pic = (w, h) => field(w, h, (x, y) => 60 + 120 * (x / w) + 40 * (y / h));
  const params = { spacing: 3, maxPasses: 3, amplitude: 0.5 };
  const runs = [[200, 150, 0.8], [400, 300, 0.4]].map(([w, h, k]) => {
    const paper = { mmPerPx: k, penWidthMm: 0.5 };
    const g = geometry(params, paper);
    const lines = waves(pic(w, h), w, h, params, paper);
    const fam = byFamily(lines, h, g.s);
    const js = [...fam.keys()].sort((a, b) => a - b);
    // spacing on paper from the mean y of neighbouring lines
    const meanY = (j) => { let s = 0, n = 0; for (const l of fam.get(j)) for (let i = 1; i < l.length; i += 2) { s += l[i]; n++; } return s / n; };
    const steps = js.slice(1).map((j, i) => (meanY(j) - meanY(js[i])) * k);
    // amplitude ≤ (step − max width)/2
    let dev = 0;
    for (const j of js) { const yc = h / 2 + j * g.s; if (Math.abs(yc - h / 2) < h / 2 - g.s) for (const l of fam.get(j)) for (let i = 1; i < l.length; i += 2) dev = Math.max(dev, Math.abs(l[i] - yc)); }
    return { count: js.length, step: steps.reduce((a, b) => a + b, 0) / steps.length, devMm: dev * k, g };
  });
  assert.ok(Math.abs(runs[0].count - runs[1].count) <= 1, `${runs[0].count} vs ${runs[1].count} lines`);
  for (const r of runs) assert.ok(Math.abs(r.step - 3) < 0.05, `step ${r.step} mm`);
  // centre-line deviation ≤ the cap, plus the outer passes (K·pitch) of the thick parts
  for (const r of runs) assert.ok(r.devMm <= ((r.g.s - r.g.wMax) / 2 + r.g.K * r.g.pitchPx) * r.g.mmPerPx + 1e-6, `deviation ${r.devMm} mm`);
});

// --- determinism, presets, parameters

test('determinism: two runs with the same parameters are identical', () => {
  const w = 120, h = 90;
  const g = field(w, h, (x, y) => (x * 7 + y * 13) % 256);
  const p = { ...defaultParams(), mode: 'both', maxPasses: 5, stagger: true, gamma: 1.4 };
  const a = waves(g, w, h, p, PAPER).map((l) => Array.from(l)), b = waves(g, w, h, p, PAPER).map((l) => Array.from(l));
  assert.ok(a.length > 0);
  assert.deepEqual(a, b);
});

test('parameters and presets: odd pass counts, valid preset values, classic = defaults, all live', () => {
  const byKey = Object.fromEntries(PARAMS.map((d) => [d.key, d]));
  assert.deepEqual([byKey.maxPasses.min, byKey.maxPasses.max, byKey.maxPasses.step], [1, 5, 2]);
  assert.deepEqual(byKey.mode.options, MODES);
  assert.equal(byKey.stagger.default, false, 'neighbours in phase by default');
  assert.ok(PARAMS.every((d) => d.live), 'all parameters are live');
  assert.deepEqual(PRESETS.map((p) => p.id), ['fine', 'classic', 'bold']);
  for (const p of PRESETS) {
    const values = presetValues(PARAMS, p);
    assert.deepEqual(normalizeParams(PARAMS, values), values, `${p.id}: values within the ranges`);
    assert.equal(matchPreset(PARAMS, PRESETS, values), p.id);
  }
  assert.deepEqual(presetValues(PARAMS, PRESETS[1]), defaultParams());
  assert.equal(matchPreset(PARAMS, PRESETS, { ...defaultParams(), spacing: 1.25 }), '');
  // an even pass count from an old preset file is rounded to odd
  assert.equal(geometry({ maxPasses: 4 }, PAPER).passes, 5);
  assert.equal(geometry({ maxPasses: 2 }, PAPER).passes, 3);
});

// --- performance

function photo(w, h) {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  return field(w, h, (x, y) => {
    let v = 255 * (1 - x / w) * 0.6 + 255 * (y / h) * 0.4;
    for (const [cx, cy, r] of [[0.3, 0.4, 0.2], [0.7, 0.6, 0.15]]) if (Math.hypot(x / w - cx, y / h - cy) < r) v *= 0.3;
    return Math.min(255, Math.max(0, v + (rnd() - 0.5) * 40));
  });
}

test('budget: 800×600 synthetic photo within 300 ms (×3 headroom unless STYLE_PERF=1)', () => {
  const w = 800, h = 600, g = photo(w, h);
  const paper = { mmPerPx: 190 / 800, penWidthMm: 0.5 };
  waves(photo(200, 150), 200, 150, {}, paper); // warm-up
  let best = Infinity;
  for (let i = 0; i < 2; i++) {
    const t0 = performance.now();
    const lines = waves(g, w, h, {}, paper);
    best = Math.min(best, performance.now() - t0);
    assert.ok(lines.length > 50);
  }
  const limit = process.env.STYLE_PERF === '1' ? 300 : 900;
  assert.ok(best <= limit, `800×600: ${best.toFixed(0)} ms > ${limit} ms`);
});
