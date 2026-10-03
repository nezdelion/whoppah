// "Wave lines": a family of parallel lines; each line is a wave across its direction whose amplitude and/or frequency grow
// with the darkness of the band around it; in dark areas the line gets thicker by extra passes (kit/stroke.js), in light
// areas it breaks. Size parameters are in mm on paper (descriptor usesPaper). A pure deterministic staged generator.
import { toDarkness, boxBlur, sampleBilinear } from '../tone.js';
import { simplifyLine } from '../../core/optimize.js';
import { paramFactory, presetFactory } from './kit/params.js';
import { paperOf } from './kit/paper.js';
import { lineFamily, polylineLength } from './kit/lines.js';
import { thicknessProfile, thicken, oddPasses, smoothstep } from './kit/stroke.js';
import { orientGroups } from './kit/order.js';
import { createCache, stage, stageGen, runToEnd, progressOf } from './kit/stages.js';

export const MODES = Object.freeze(['amplitude', 'frequency', 'both']);
export const PROGRESS_KEY = 'styles.progress.waves';
/** Hysteresis of the light break: the pen goes down at darkness ≥ τ and lifts below τ − HYSTERESIS. */
export const HYSTERESIS = 0.02;
/** Simplification tolerance of the output polylines, mm on paper. */
export const SIMPLIFY_MM = 0.02;
/** Wavelength factor at the lightest tone in the frequency modes: λ(u) = wavelength / (LIGHT_FREQ + (1 − LIGHT_FREQ)·u). */
export const LIGHT_FREQ = 0.15;

const param = paramFactory('waves');
const preset = presetFactory('waves');

// all live: the stage cache decides what is actually recomputed
export const PARAMS = Object.freeze([
  param({ key: 'spacing', type: 'number', min: 0.3, max: 10, step: 0.05, default: 1.2, live: true }),
  param({ key: 'angle', type: 'number', min: -90, max: 90, step: 1, default: 0, live: true }),
  param({ key: 'amplitude', type: 'number', min: 0, max: 0.5, step: 0.01, default: 0.3, live: true }),
  param({ key: 'wavelength', type: 'number', min: 0.4, max: 20, step: 0.1, default: 1.6, live: true }),
  param({ key: 'mode', type: 'select', options: MODES, default: 'both', live: true }),
  param({ key: 'stagger', type: 'bool', default: false, live: true }),
  param({ key: 'maxPasses', type: 'number', min: 1, max: 5, step: 2, default: 3, live: true }),
  param({ key: 'passPitch', type: 'number', min: 0.3, max: 0.9, step: 0.05, default: 0.5, live: true }),
  param({ key: 'thickStart', type: 'number', min: 30, max: 100, step: 1, default: 60, live: true }),
  param({ key: 'threshold', type: 'number', min: 0, max: 50, step: 1, default: 8, live: true }),
  param({ key: 'minLength', type: 'number', min: 0, max: 20, step: 0.1, default: 1, live: true }),
  param({ key: 'invert', type: 'bool', default: false, live: true }),
  param({ key: 'brightness', type: 'number', min: -100, max: 100, step: 1, default: 0, live: true }),
  param({ key: 'contrast', type: 'number', min: -100, max: 100, step: 1, default: 0, live: true }),
  param({ key: 'gamma', type: 'number', min: 0.3, max: 3, step: 0.05, default: 1, live: true }),
]);

// Defaults are placeholders until the paper test (tasks 6.1–6.2).
export const PRESETS = Object.freeze([
  preset('fine', { spacing: 0.9, amplitude: 0.25, wavelength: 1, mode: 'both', maxPasses: 1 }),
  preset('classic', {}),
  preset('bold', { spacing: 2.5, amplitude: 0.4, wavelength: 3, mode: 'amplitude', maxPasses: 5, passPitch: 0.5 }),
]);

export const defaultParams = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

/** Line step in working image px (for the density check). */
export const spacingPx = (params, paper) => Math.max(1, (params.spacing ?? 1.2) / paperOf(paper).mmPerPx);

/**
 * Geometry in px from the parameters and the paper: line step s, pass pitch, the widest line wMax = pen + 2K·pitch and the
 * amplitude cap: aMax = min(amplitude·s, (s − wMax)/2) — crests of neighbouring lines at full thickness never touch, whatever
 * their phases; at wMax ≥ s the amplitude is 0.
 */
export function geometry(params, paper) {
  const p = { ...defaultParams(), ...params };
  const { mmPerPx, penWidthMm } = paperOf(paper);
  const s = spacingPx(p, paper);
  const passes = oddPasses(p.maxPasses);
  const K = (passes - 1) / 2;
  const penPx = penWidthMm / mmPerPx;
  const pitchPx = p.passPitch * penPx;
  const wMax = penPx + 2 * K * pitchPx;
  const aMax = Math.max(0, Math.min(p.amplitude * s, (s - wMax) / 2));
  const lambda = Math.max(p.wavelength / mmPerPx, 0.05);
  return { p, s, passes, K, penPx, pitchPx, wMax, aMax, lambda, mmPerPx };
}

const clampInto = (pts, w, h) => {
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < 0) pts[i] = 0; else if (pts[i] > w) pts[i] = w;
    if (pts[i + 1] < 0) pts[i + 1] = 0; else if (pts[i + 1] > h) pts[i + 1] = h;
  }
  return pts;
};

/**
 * Wave centre lines of one family line: strokes [{ pts, u }] in increasing t (u — the effective tone per point).
 * Exported for tests (phase continuity, breaks).
 */
export function waveLine(line, dark, w, h, { s, aMax, lambda, mode, threshold, stagger }) {
  const { j, ox, oy, dx, dy, nx, ny, t0, t1 } = line;
  const tau = threshold / 100;
  const ds = Math.min(0.5, lambda / 16);
  const n = Math.max(2, Math.ceil((t1 - t0) / ds) + 1);
  const ts = new Float64Array(n), u = new Float32Array(n), on = new Uint8Array(n);
  let down = false;
  for (let i = 0; i < n; i++) {
    const t = i === n - 1 ? t1 : Math.min(t0 + i * ds, t1);
    ts[i] = t;
    const v = sampleBilinear(dark, w, h, ox + dx * t, oy + dy * t);
    down = down ? v >= tau - HYSTERESIS : v >= tau;
    on[i] = down ? 1 : 0;
    u[i] = tau < 1 ? Math.min(Math.max((v - tau) / (1 - tau), 0), 1) : 0;
  }
  // runs of "pen down", gaps shorter than one line step are closed (small highlights do not break the line)
  const runs = [];
  for (let i = 0; i < n;) {
    if (!on[i]) { i++; continue; }
    let k = i;
    while (k + 1 < n && on[k + 1]) k++;
    const last = runs[runs.length - 1];
    if (last && ts[i] - ts[last[1]] < s) last[1] = k; else runs.push([i, k]);
    i = k + 1;
  }
  if (!runs.length) return [];

  // the wave: the phase is the integral of 2π/λ(u) along the whole line from t0, starting from 2π·t0/λ(0) — it depends on
  // the position along the line, not on where a stroke begins; frequency changes keep the line continuous
  const freqMode = mode !== 'amplitude';
  const invLam = (uu) => (freqMode ? (LIGHT_FREQ + (1 - LIGHT_FREQ) * uu) / lambda : 1 / lambda);
  const amp = (uu) => (mode === 'frequency' ? aMax * smoothstep(0, 0.1, uu) : aMax * uu);
  const phase = new Float64Array(n);
  phase[0] = 2 * Math.PI * t0 * invLam(0) + (stagger && (Math.abs(j) & 1) ? Math.PI : 0);
  for (let i = 1; i < n; i++) phase[i] = phase[i - 1] + Math.PI * (ts[i] - ts[i - 1]) * (invLam(u[i - 1]) + invLam(u[i]));

  const strokes = [];
  for (const [a, b] of runs) {
    if (b <= a) continue;
    const m = b - a + 1;
    const pts = new Float64Array(2 * m), uu = new Float32Array(m);
    for (let i = a; i <= b; i++) {
      const y = amp(u[i]) * Math.sin(phase[i]);
      pts[2 * (i - a)] = ox + dx * ts[i] + nx * y;
      pts[2 * (i - a) + 1] = oy + dy * ts[i] + ny * y;
      uu[i - a] = u[i];
    }
    strokes.push({ pts: clampInto(pts, w, h), u: uu });
  }
  return strokes;
}

/**
 * The style as a staged generator (see kit/stages.js): stages tone → centres → finish (thickness, minimum length,
 * simplification, serpentine order). Returns Float64Array[] in image px.
 */
export function* wavesSteps({ gray, w, h, params, paper, cache }) {
  const g = geometry(params, paper);
  const { p, s, K, pitchPx, aMax, lambda, mmPerPx } = g;
  const blurR = Math.round(s / 2);

  // 1. tone: each line sees the mean tone of its band
  const dark = stage(cache, 'tone', [!!p.invert, p.brightness, p.contrast, p.gamma, blurR],
    () => boxBlur(toDarkness(gray, { invert: !!p.invert, brightness: p.brightness, contrast: p.contrast, gamma: p.gamma }), w, h, blurR));

  // 2. wave centre lines (grouped by family line, in increasing j)
  const wave = { s, aMax, lambda, mode: p.mode, threshold: p.threshold, stagger: !!p.stagger };
  const centres = yield* stageGen(cache, 'centres', [dark, s, p.angle, aMax, lambda, p.mode, p.threshold, !!p.stagger], function* () {
    const fam = lineFamily(w, h, p.angle, s);
    const groups = [];
    for (let i = 0; i < fam.length; i++) {
      groups.push(waveLine(fam[i], dark, w, h, wave));
      yield progressOf(PROGRESS_KEY, (0.5 * (i + 1)) / fam.length);
    }
    return groups;
  });

  // 3. thickness, minimum length, simplification, order
  const minPx = p.minLength / mmPerPx, tolPx = SIMPLIFY_MM / mmPerPx;
  const opts = { maxPasses: g.passes, startTone: p.thickStart / 100 };
  return yield* stageGen(cache, 'finish', [centres, K, pitchPx, p.thickStart, minPx, tolPx], function* () {
    const groups = [];
    for (let i = 0; i < centres.length; i++) {
      const list = [];
      for (const { pts, u } of centres[i]) {
        if (polylineLength(pts) < minPx) continue;
        let line = pts;
        if (K) {
          const level = new Float64Array(u.length);
          for (let k = 0; k < u.length; k++) level[k] = thicknessProfile(u[k], opts);
          line = clampInto(thicken(pts, level, { pitchPx, taperPx: s, endTaperPx: 0 }), w, h);
        }
        list.push(simplifyLine(line, tolPx));
      }
      groups.push(list);
      yield progressOf(PROGRESS_KEY, 0.5 + (0.5 * (i + 1)) / centres.length);
    }
    return orientGroups(groups);
  });
}

/** Synchronous call (tests): the same result as the driver. */
export function waves(gray, w, h, params = {}, paper = null) {
  return runToEnd(wavesSteps({ gray, w, h, params, paper, cache: createCache() }));
}
