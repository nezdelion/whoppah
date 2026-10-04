// "Engraving": lines that follow the form of the image (a two-scale direction field, engraving/field.js), evenly spaced
// with a separation by tone (engraving/streamlines.js): dark — dense, light — sparse, very light — the line breaks. The tone
// of a real photo is prepared first: auto levels (percentile stretch) and local contrast (CLAHE), so a washed-out face gets
// its mid-tones. The field follows the large form, fine detail only bends it, textured background (foliage, noise) falls
// back to the base angle. Lines shorter than a few separations are not drawn (no clutter of short strokes). In dark areas
// the line gets thicker by 3 or 5 merging passes with thin ends, like a burin cut (kit/stroke.js), but never wider than
// darkCap % of the distance to its neighbour (shadows keep white lines); in the deepest shadows a second, cross family of
// lines at an angle to the first one. Size parameters are in mm on paper (descriptor usesPaper). A pure deterministic staged
// generator: thickness sliders recompute only the last stage, cross layer sliders do not recompute the direction field and
// the main lines.
import { toDarkness, boxBlur, autoLevels, localContrast } from '../tone.js';
import { applyFade } from '../prep.js';
import { simplifyLine } from '../../core/optimize.js';
import { paramFactory, presetFactory } from './kit/params.js';
import { paperOf } from './kit/paper.js';
import { arcLengths } from './kit/lines.js';
import { thicknessProfile, thicken, oddPasses } from './kit/stroke.js';
import { orientGroups } from './kit/order.js';
import { createCache, stage, stageGen, runToEnd, progressOf } from './kit/stages.js';
import { structureFieldSteps, directionField, rotateField } from './engraving/field.js';
import { placeStreamlines, separation, neighbourGaps, MAX_POINTS } from './engraving/streamlines.js';

export const PROGRESS = Object.freeze({
  field: 'styles.progress.engraving.field',
  lines: 'styles.progress.engraving.lines',
  cross: 'styles.progress.engraving.cross',
  finish: 'styles.progress.engraving.finish',
  limit: 'styles.progress.engraving.limit',
});
/** Hysteresis of the light break: a drawn part starts at tone ≥ τ and ends below τ − HYSTERESIS. */
export const HYSTERESIS = 0.02;
/** The flat area threshold (flatThreshold, %) is the brightness change over this distance on paper, mm. */
export const FLAT_SCALE_MM = 10;
/** Simplification tolerance of the output polylines, mm on paper. */
export const SIMPLIFY_MM = 0.02;
/** The cross layer separation is never below CROSS_MIN_SEP·dMin (the cross family must not fill the shadow solid). */
export const CROSS_MIN_SEP = 1.2;
/** Cross strokes shorter than CROSS_MIN_LEN·(cross minimum separation) are dropped (no short ticks at the shadow edge). */
export const CROSS_MIN_LEN = 8;
/** Lines and strokes shorter than FRAGMENT_SEPS separations (the mean separation along them) are dropped: no clutter of short
 *  strokes in textured or converging areas, no lone ticks in light areas. */
export const FRAGMENT_SEPS = 3;
/** The detail scale of the direction field is the form scale (smoothing) divided by this. */
export const DETAIL_RATIO = 3;
/** Tiles of the local contrast (CLAHE) along the long side of the image. */
export const LOCAL_TILES = 8;
/** The scale of the background simplification (texture vs form, see engraving/field.js purity), mm on paper. */
export const PURITY_MM = 4;
/** A lens is not drawn where the dark cap leaves its outermost pass less than this share of the pass pitch (the passes would
 *  only lie on top of each other). */
export const MIN_LENS = 0.25;

const param = paramFactory('engraving');
const preset = presetFactory('engraving');

// all live: the stage cache decides what is actually recomputed
export const PARAMS = Object.freeze([
  param({ key: 'spacing', type: 'number', min: 0.4, max: 5, step: 0.05, default: 1, live: true }),
  param({ key: 'sepDark', type: 'number', min: 0.3, max: 1, step: 0.05, default: 0.7, live: true }),
  param({ key: 'sepLight', type: 'number', min: 1, max: 4, step: 0.1, default: 3, live: true }),
  param({ key: 'lightBreak', type: 'number', min: 0, max: 50, step: 1, default: 10, live: true }),
  param({ key: 'smoothing', type: 'number', min: 0.5, max: 20, step: 0.5, default: 4, live: true }),
  param({ key: 'detail', type: 'number', min: 0, max: 100, step: 1, default: 30, live: true }),
  param({ key: 'simplify', type: 'number', min: 0, max: 100, step: 1, default: 70, live: true }),
  param({ key: 'followForm', type: 'number', min: 0, max: 100, step: 1, default: 100, live: true }),
  param({ key: 'flatThreshold', type: 'number', min: 0, max: 100, step: 1, default: 5, live: true }),
  param({ key: 'baseAngle', type: 'number', min: -90, max: 90, step: 1, default: 30, live: true }),
  param({ key: 'fieldRotation', type: 'number', min: -90, max: 90, step: 1, default: 0, live: true }),
  param({ key: 'maxPasses', type: 'number', min: 1, max: 5, step: 2, default: 3, live: true }),
  param({ key: 'passPitch', type: 'number', min: 0.3, max: 0.9, step: 0.05, default: 0.4, live: true }),
  param({ key: 'thickStart', type: 'number', min: 30, max: 100, step: 1, default: 60, live: true }),
  param({ key: 'darkCap', type: 'number', min: 50, max: 100, step: 1, default: 85, live: true }),
  param({ key: 'thinEnds', type: 'bool', default: true, live: true }),
  param({ key: 'cross', type: 'bool', default: true, live: true }),
  param({ key: 'crossThreshold', type: 'number', min: 40, max: 100, step: 1, default: 80, live: true }),
  param({ key: 'crossAngle', type: 'number', min: 15, max: 90, step: 1, default: 60, live: true }),
  param({ key: 'minLength', type: 'number', min: 0, max: 20, step: 0.1, default: 1.5, live: true }),
  param({ key: 'maxLength', type: 'number', min: 5, max: 1000, step: 5, default: 200, live: true }),
  param({ key: 'autoLevels', type: 'bool', default: true, live: true }),
  param({ key: 'levelsClip', type: 'number', min: 0, max: 10, step: 0.1, default: 0.5, live: true }),
  param({ key: 'localContrast', type: 'number', min: 0, max: 100, step: 1, default: 40, live: true }),
  param({ key: 'invert', type: 'bool', default: false, live: true }),
  param({ key: 'brightness', type: 'number', min: -100, max: 100, step: 1, default: 0, live: true }),
  param({ key: 'contrast', type: 'number', min: -100, max: 100, step: 1, default: 0, live: true }),
  param({ key: 'gamma', type: 'number', min: 0.3, max: 3, step: 0.05, default: 1, live: true }),
]);

// Defaults and presets are placeholders until the paper test (tasks 6.1–6.2).
export const PRESETS = Object.freeze([
  preset('portrait', {}),
  // dense, almost even long lines, the tone mostly by swelling; no cross layer
  preset('banknote', { spacing: 1, sepDark: 1, sepLight: 1.8, lightBreak: 6, smoothing: 5, detail: 15, simplify: 90, maxPasses: 3, passPitch: 0.6, thickStart: 35, cross: false, maxLength: 400 }),
  // sparse short single-pass lines, loosely following the form, the cross layer in shadows
  preset('sketch', { spacing: 1.4, sepDark: 0.5, sepLight: 2.5, lightBreak: 12, smoothing: 6, detail: 50, simplify: 50, followForm: 70, maxPasses: 1, cross: true, crossThreshold: 85, minLength: 3, maxLength: 60 }),
]);

export const defaultParams = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

/**
 * Geometry in px from the parameters and the paper: the base step s0, the separations dMin (darkest) and dMax (lightest),
 * both at least 1 px, passes and their pitch, tapers, lengths.
 */
export function geometry(params, paper) {
  const p = { ...defaultParams(), ...params };
  const { mmPerPx, penWidthMm } = paperOf(paper);
  const s0 = Math.max(1, p.spacing / mmPerPx);
  const dMin = Math.max(1, p.sepDark * s0);
  const dMax = Math.max(dMin, p.sepLight * s0);
  const passes = oddPasses(p.maxPasses);
  const K = (passes - 1) / 2;
  const penPx = penWidthMm / mmPerPx;
  const pitchPx = p.passPitch * penPx;
  const taperPx = Math.max(2 * dMin, 1 / mmPerPx);
  return {
    p, s0, dMin, dMax, passes, K, penPx, pitchPx, taperPx, mmPerPx,
    tau: p.lightBreak / 100,
    sigmaPx: p.smoothing / mmPerPx,
    detailSigmaPx: Math.max(0.5, p.smoothing / DETAIL_RATIO / mmPerPx),
    puritySigmaPx: PURITY_MM / mmPerPx,
    scalePx: FLAT_SCALE_MM / mmPerPx,
    minPx: p.minLength / mmPerPx,
    maxPx: p.maxLength / mmPerPx,
    tolPx: SIMPLIFY_MM / mmPerPx,
  };
}

/** The smallest line separation in working image px (for the density check). */
export const spacingPx = (params, paper) => geometry(params, paper).dMin;

const clampInto = (pts, w, h) => {
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < 0) pts[i] = 0; else if (pts[i] > w) pts[i] = w;
    if (pts[i + 1] < 0) pts[i + 1] = 0; else if (pts[i + 1] > h) pts[i + 1] = h;
  }
  return pts;
};

/**
 * The drawn parts of a placed line: index runs [a, b] where the tone is at or above tau (hysteresis HYSTERESIS), gaps
 * shorter than the separation at the gap are closed (a tiny highlight does not cut the line).
 */
export function drawnRuns({ pts, u, sep }, tau) {
  const n = u.length;
  const s = arcLengths(pts);
  const runs = [];
  let down = false, a = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && (down ? u[i] >= tau - HYSTERESIS : u[i] >= tau);
    if (on && !down) {
      const last = runs[runs.length - 1];
      if (last && s[i] - s[last[1]] < sep[last[1]]) { a = last[0]; runs.pop(); } else a = i;
    } else if (!on && down) runs.push([a, i - 1]);
    down = on;
  }
  return runs.filter(([c, d]) => d > c);
}

const slice = (pts, a, b) => pts.slice(2 * a, 2 * b + 2);

/** Main lines as groups of thin strokes (the intermediate result and the base of the finish). */
function strokeGroups(lines, tau, minPx, gaps = null) {
  const groups = [];
  for (const [li, line] of lines.entries()) {
    const list = [];
    for (const [a, b] of drawnRuns(line, tau)) {
      const pts = slice(line.pts, a, b);
      const s = arcLengths(pts);
      let sepSum = 0;
      for (let k = a; k <= b; k++) sepSum += line.sep[k];
      if (s[s.length - 1] < Math.max(minPx, (FRAGMENT_SEPS * sepSum) / (b - a + 1))) continue;
      list.push({ pts, u: line.u.slice(a, b + 1), room: (gaps ? gaps[li] : line.sep).slice(a, b + 1) });
    }
    if (list.length) groups.push(list);
  }
  return groups;
}

/**
 * The style as a staged generator (see kit/stages.js): stages levels → tensor → field → tone → streams → cross → gaps →
 * finish.
 * Returns Float64Array[] in image px: the main lines (in placement order, each stroke one polyline with its thickness
 * passes), then the cross layer. maxPoints — the point limit of each placement (tests lower it; the driver never passes it).
 * When it is reached the placement stops with what it has and the style yields the note PROGRESS.limit.
 */
export function* engravingSteps({ gray, w, h, params, paper, cache, fade = null, maxPoints = MAX_POINTS }) {
  const g = geometry(params, paper);
  const { p, dMin, dMax, tau } = g;
  const fieldProgress = progressOf(PROGRESS.field, 0);

  // 0. auto levels (the brightness range stretched by percentiles): the base of the field and the tone
  // from the un-faded image: "Fade background" is applied to the tone only (stage 2), the field must not follow the fade
  const levels = stage(cache, 'levels', [!!p.autoLevels, p.levelsClip], () => (p.autoLevels ? autoLevels(gray, p.levelsClip) : gray));

  // 1. the structure tensor (does not depend on tone parameters) and the direction field
  const tensor = yield* stageGen(cache, 'tensor', [levels, g.sigmaPx, g.detailSigmaPx, g.puritySigmaPx, g.scalePx], function* () {
    yield fieldProgress;
    const gen = structureFieldSteps(levels, w, h, { sigmaPx: g.sigmaPx, detailSigmaPx: g.detailSigmaPx, puritySigmaPx: g.puritySigmaPx, scalePx: g.scalePx });
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      yield fieldProgress;
    }
  });
  const field = stage(cache, 'field', [tensor, p.baseAngle, p.fieldRotation, p.followForm, p.flatThreshold, p.detail, p.simplify],
    () => directionField(tensor, p));

  // 2. tone: local contrast, darkness with gamma, "Fade background" (tone only: the field above never sees it), blurred twice by dMin/2
  const blurR = Math.round(dMin / 2);
  const tone = stage(cache, 'tone', [levels, p.localContrast, !!p.invert, p.brightness, p.contrast, p.gamma, blurR, fade], () => {
    const lc = p.localContrast > 0 ? localContrast(levels, w, h, { amount: p.localContrast / 100, tiles: LOCAL_TILES }) : levels;
    const d = applyFade(toDarkness(lc, { invert: !!p.invert, brightness: p.brightness, contrast: p.contrast, gamma: p.gamma }), fade);
    return boxBlur(boxBlur(d, w, h, blurR), w, h, blurR);
  });

  // 3. the main streamlines
  let placedNow = false;
  const streams = yield* stageGen(cache, 'streams', [field, tone, dMin, dMax, tau, g.maxPx, g.minPx], function* () {
    placedNow = true;
    const gen = placeStreamlines({ w, h, field, tone, dsep: (u) => separation(u, dMin, dMax), dMin, dMax, tau,
      maxLen: g.maxPx, minLen: g.minPx, minSeps: FRAGMENT_SEPS, maxPoints });
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      yield progressOf(PROGRESS.lines, r.value.coverage);
    }
  });
  // the point limit: the status text now, and a note that stays with the final result
  const limitNote = { progress: { key: PROGRESS.limit, params: {} }, note: { key: PROGRESS.limit, params: {} } };
  if (streams.limited) yield limitNote;
  if (placedNow) yield { partial: orientGroups(strokeGroups(streams.lines, tau, g.minPx).map((l) => l.map((s) => s.pts))) };

  // 4. the cross layer: the field turned by crossAngle, only where the tone reaches the cross threshold, its own grid
  //    (the cross lines do not repel the main ones); the separation ramps from dMax at the threshold to the cross minimum
  const tauC = p.crossThreshold / 100;
  const cMin = Math.max(dMin, CROSS_MIN_SEP * dMin);
  const crossOn = !!p.cross;
  const crossMinPx = Math.max(g.minPx, CROSS_MIN_LEN * cMin);
  const cross = yield* stageGen(cache, 'cross', [field, tone, dMin, dMax, crossOn, tauC, p.crossAngle, g.maxPx, crossMinPx], function* () {
    if (!crossOn) return { lines: [], limited: false };
    yield progressOf(PROGRESS.cross, 0);
    const turned = rotateField(field, p.crossAngle);
    const ramp = (u) => (tauC < 1 ? (u - tauC) / (1 - tauC) : 1);
    const gen = placeStreamlines({ w, h, field: turned, tone, dsep: (u) => separation(ramp(u), cMin, Math.max(cMin, dMax)),
      dMin: cMin, dMax: Math.max(cMin, dMax), tau: tauC, maxLen: g.maxPx, minLen: crossMinPx, minSeps: FRAGMENT_SEPS, maxPoints });
    for (;;) {
      const r = gen.next();
      if (r.done) return r.value;
      yield progressOf(PROGRESS.cross, r.value.coverage);
    }
  });
  if (cross.limited && !streams.limited) yield limitNote;

  // 5. thickness, minimum length, simplification, order
  const thin = !!p.thinEnds;
  // the dark cap: the stroke width (pen + both outermost pass offsets) at most darkCap % of the distance to the nearest
  // other line at the point (converging lines too); the distances are needed only when lines thicken
  const cap = p.darkCap / 100;
  const gaps = stage(cache, 'gaps', [streams, g.K > 0], () => (g.K > 0 ? neighbourGaps(streams.lines, w, h) : null));
  return yield* stageGen(cache, 'finish', [streams, gaps, cross, g.K, g.pitchPx, g.penPx, p.thickStart, cap, g.minPx, crossMinPx, thin, g.taperPx, g.tolPx], function* () {
    yield progressOf(PROGRESS.finish, 0);
    const opts = { maxPasses: g.passes, startTone: p.thickStart / 100 };
    const main = strokeGroups(streams.lines, tau, g.minPx, gaps).map((list) => list.map(({ pts, u, room }) => {
      let line = pts;
      if (g.K) {
        const level = new Float64Array(u.length), maxHalf = new Float64Array(u.length);
        for (let k = 0; k < u.length; k++) {
          const half = Math.max(0, (cap * room[k] - g.penPx) / 2);
          maxHalf[k] = half;
          level[k] = half < MIN_LENS * g.pitchPx ? 0 : thicknessProfile(u[k], opts);
        }
        line = clampInto(thicken(pts, level, { pitchPx: g.pitchPx, taperPx: g.taperPx, endTaperPx: thin ? g.taperPx : 0, maxHalf }), w, h);
      }
      return simplifyLine(line, g.tolPx);
    }));
    const ordered = orientGroups(main);
    const last = ordered[ordered.length - 1];
    const crossGroups = strokeGroups(cross.lines, tauC, crossMinPx).map((list) => list.map(({ pts }) => simplifyLine(pts, g.tolPx)));
    return ordered.concat(orientGroups(crossGroups, last ? [last[last.length - 2], last[last.length - 1]] : null));
  });
}

/** Synchronous call (tests): the same result as the driver. */
export function engraving(gray, w, h, params = {}, paper = null, fade = null) {
  return runToEnd(engravingSteps({ gray, w, h, params, paper, cache: createCache(), fade }));
}
