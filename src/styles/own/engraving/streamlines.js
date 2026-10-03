// Evenly spaced streamlines with a tone-driven separation (Jobard–Lefer) for the "Engraving" style. Pure, image px, no DOM.
//
// A streamline follows the direction field (engraving/field.js) from a seed in both directions (RK2, the midpoint method).
// The separation dsep(u) depends on the tone u at the point (dark — dense, light — sparse). A new line is seeded only where
// no other line is closer than dsep; a line being traced may come closer, down to dtest = DTEST·dsep (lines converge but
// never merge). Seeds are placed beside accepted lines, breadth first from the first seed (neighbouring lines come out one
// after another — a good output order), then a row-by-row sweep fills the areas the first flow did not reach.
// Everything is deterministic: no randomness, a fixed order.
//
// Hot path without allocations: points in flat typed arrays, the spatial grid is "cell head / next point" index lists.
import { sampleBilinear } from '../../tone.js';
import { fieldSampler } from './field.js';

/** A line being traced may come this close to other lines (fraction of dsep at the point). */
export const DTEST = 0.5;
/** A seed must be this far from other lines (fraction of dsep): the candidate is placed at ≈ dsep, the tolerance absorbs
 *  the curvature of the parent line and rounding. */
export const SEED_FREE = 0.9;
/** Points of the same line are ignored by the proximity check when they are closer than SELF_ARC·dsep along the line. */
export const SELF_ARC = 3;
/** The largest turn of the direction in one integration step: a sharper turn is a singular point of the field (centre of a
 *  circle, a saddle) — the line stops there. */
export const MAX_TURN_DEG = 30;
/** A line goes on through a light area (tone below the break) for at most LIGHT_RUN·dMax, then stops. */
export const LIGHT_RUN = 2;
/** The total point limit: beyond it the placement stops with what it has (result.limited). */
export const MAX_POINTS = 4_000_000;
/** How many integration steps between progress reports. */
const PROGRESS_STEPS = 2000;

/** The separation for the tone u: harmonic interpolation 1/dsep = (1 − u)/dMax + u/dMin (coverage linear in u). */
export function separation(u, dMin, dMax) {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  return 1 / ((1 - t) / dMax + t / dMin);
}

/** The integration step for the smallest separation: 0.4·dMin within [0.5, 2] px. */
export const stepFor = (dMin) => Math.min(2, Math.max(0.5, 0.4 * dMin));

/**
 * The streamline placement as a generator: yields progress fractions { coverage } every PROGRESS_STEPS integration steps,
 * returns { lines, limited }.
 * @param opts {
 *   w, h, field — the direction field (field.js), tone — darkness 0..1 (Float32Array w·h, already blurred),
 *   dsep(u) — separation in px for the tone u, dMin, dMax — its range (the grid cell, the light run, the coverage cells),
 *   tau — the light break: points with u < tau are not drawn, seeds need u ≥ tau,
 *   maxLen, minLen — px: the longest line (both directions together) and the shortest drawn length of an accepted line,
 *   maxPoints — the point limit (default MAX_POINTS)
 * }
 * @returns { lines: [{ pts: Float64Array [x0,y0,...], u: Float32Array per point, sep: Float32Array dsep per point }],
 *            limited: boolean }
 */
export function* placeStreamlines(opts) {
  const { w, h, field, tone, dsep, dMin, dMax, tau, maxLen, minLen = 0, maxPoints = MAX_POINTS } = opts;
  const dirAt = fieldSampler(field);
  const stepPx = stepFor(dMin);
  const cosTurn = Math.cos((MAX_TURN_DEG * Math.PI) / 180);
  const lightMax = LIGHT_RUN * dMax;
  const toneAt = (x, y) => sampleBilinear(tone, w, h, x, y);

  // --- points and the spatial grid
  const cell = Math.max(1, dMin);
  const gw = Math.max(1, Math.ceil(w / cell)), gh = Math.max(1, Math.ceil(h / cell));
  const head = new Int32Array(gw * gh).fill(-1);
  let cap = 1 << 14;
  let PX = new Float32Array(cap), PY = new Float32Array(cap), PA = new Float32Array(cap), PU = new Float32Array(cap);
  let PL = new Int32Array(cap), NX = new Int32Array(cap), PC = new Int32Array(cap);
  let n = 0;
  const cellOf = (x, y) => {
    let cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    cx = cx < 0 ? 0 : cx >= gw ? gw - 1 : cx;
    cy = cy < 0 ? 0 : cy >= gh ? gh - 1 : cy;
    return cy * gw + cx;
  };
  function grow() {
    cap *= 2;
    const g = (A, T) => { const B = new T(cap); B.set(A); return B; };
    PX = g(PX, Float32Array); PY = g(PY, Float32Array); PA = g(PA, Float32Array); PU = g(PU, Float32Array);
    PL = g(PL, Int32Array); NX = g(NX, Int32Array); PC = g(PC, Int32Array);
  }
  function addPoint(x, y, arc, u, line) {
    if (n === cap) grow();
    const i = n++;
    PX[i] = x; PY[i] = y; PA[i] = arc; PU[i] = u; PL[i] = line;
    const c = cellOf(x, y);
    PC[i] = c; NX[i] = head[c]; head[c] = i;
    return i;
  }
  // points are removed in reverse order of addition: each one is then the head of its cell (the cell is stored: the
  // float32 coordinates may round across a cell border)
  function popTo(m) {
    while (n > m) { const i = --n; head[PC[i]] = NX[i]; }
  }
  /** No point closer than r, except points of `line` closer than selfArc along it to arc `arc`. */
  function free(x, y, r, line, arc, selfArc) {
    const r2 = r * r;
    let cx0 = Math.floor((x - r) / cell), cx1 = Math.floor((x + r) / cell);
    let cy0 = Math.floor((y - r) / cell), cy1 = Math.floor((y + r) / cell);
    if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0;
    if (cx1 >= gw) cx1 = gw - 1; if (cy1 >= gh) cy1 = gh - 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let i = head[cy * gw + cx]; i >= 0; i = NX[i]) {
          const dx = PX[i] - x, dy = PY[i] - y;
          if (dx * dx + dy * dy >= r2) continue;
          if (PL[i] === line && Math.abs(PA[i] - arc) < selfArc) continue;
          return false;
        }
      }
    }
    return true;
  }

  // --- coverage progress: coarse cells of dMax; a cell is closed when it is light or holds a line point
  const pc = Math.max(1, dMax);
  const pw = Math.max(1, Math.ceil(w / pc)), ph = Math.max(1, Math.ceil(h / pc));
  const closed = new Uint8Array(pw * ph);
  let closedCount = 0;
  for (let cy = 0; cy < ph; cy++) for (let cx = 0; cx < pw; cx++) {
    if (toneAt(Math.min(w, (cx + 0.5) * pc), Math.min(h, (cy + 0.5) * pc)) < tau) { closed[cy * pw + cx] = 1; closedCount++; }
  }
  const coverage = () => closedCount / (pw * ph);
  let steps = 0, lastReport = 0;

  // --- tracing
  const d0 = new Float64Array(2), d1 = new Float64Array(2);
  const lines = [];
  let limited = false;

  /** Traces from the last added point (index `from`, at x, y) in direction sign; returns the length traced. */
  function traceDir(line, x, y, px, py, sign, budget) {
    let len = 0, light = 0, lastDark = n; // n — the count after the last point that was dark (for trimming the light tail)
    for (;;) {
      if (len + stepPx > budget + 1e-9) break;
      dirAt(x, y, px, py, d0);
      const mx = x + 0.5 * stepPx * d0[0], my = y + 0.5 * stepPx * d0[1];
      if (mx < 0 || my < 0 || mx > w || my > h) break;
      dirAt(mx, my, d0[0], d0[1], d1);
      if (d1[0] * px + d1[1] * py < cosTurn) break;
      const nx = x + stepPx * d1[0], ny = y + stepPx * d1[1];
      if (nx < 0 || ny < 0 || nx > w || ny > h) break;
      const u = toneAt(nx, ny);
      const sep = dsep(u);
      const arc = sign * (len + stepPx);
      steps++;
      if (!free(nx, ny, DTEST * sep, line, arc, SELF_ARC * sep)) break;
      if (u < tau) { light += stepPx; if (light > lightMax) break; } else light = 0;
      addPoint(nx, ny, arc, u, line);
      if (u >= tau) lastDark = n;
      len += stepPx;
      x = nx; y = ny; px = d1[0]; py = d1[1];
    }
    popTo(lastDark); // the light tail only blocks neighbours: drop it
    return n;
  }

  /** Traces a line from a seed; accepted — its index in `lines`, rejected — -1 (its points are removed). */
  function trace(sx, sy) {
    const line = lines.length;
    const start = n;
    const u0 = toneAt(sx, sy);
    addPoint(sx, sy, 0, u0, line);
    dirAt(sx, sy, 1, 0, d0);
    const fx = d0[0], fy = d0[1];
    traceDir(line, sx, sy, fx, fy, 1, maxLen / 2);
    const mid = n;
    const fwdLen = (mid - start - 1) * stepPx;
    traceDir(line, sx, sy, -fx, -fy, -1, maxLen - fwdLen);
    const end = n;
    // the polyline: the backward half reversed, the seed, the forward half
    const count = end - start;
    if (count < 2) { popTo(start); return -1; }
    const pts = new Float64Array(2 * count), u = new Float32Array(count);
    let k = 0;
    for (let i = end - 1; i >= mid; i--, k++) { pts[2 * k] = PX[i]; pts[2 * k + 1] = PY[i]; u[k] = PU[i]; }
    for (let i = start; i < mid; i++, k++) { pts[2 * k] = PX[i]; pts[2 * k + 1] = PY[i]; u[k] = PU[i]; }
    let drawn = 0;
    for (let i = 1; i < count; i++) if (u[i] >= tau && u[i - 1] >= tau) drawn += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
    if (!(drawn > 0) || drawn < minLen) { popTo(start); return -1; }
    const sep = new Float32Array(count);
    for (let i = 0; i < count; i++) sep[i] = dsep(u[i]);
    lines.push({ pts, u, sep });
    for (let i = start; i < end; i++) {
      const c = Math.min(ph - 1, Math.floor(PY[i] / pc)) * pw + Math.min(pw - 1, Math.floor(PX[i] / pc));
      if (!closed[c]) { closed[c] = 1; closedCount++; }
    }
    return line;
  }

  const report = () => { lastReport = steps; return { coverage: coverage() }; };
  const over = () => { if (n >= maxPoints) limited = true; return limited; };

  /** A seed candidate: inside, dark enough, free; traced — the new line index or -1. */
  function trySeed(x, y) {
    if (x < 0 || y < 0 || x > w || y > h) return -1;
    const u = toneAt(x, y);
    if (u < tau) return -1;
    if (!free(x, y, SEED_FREE * dsep(u), -1, 0, 0)) return -1;
    return trace(x, y);
  }

  /** Breadth-first seeding beside the lines from index `first` on (a FIFO of accepted lines). */
  function* spread(first) {
    for (let q = first; q < lines.length; q++) {
      const { pts, u } = lines[q];
      const count = pts.length >> 1;
      let next = 0, arc = 0;
      for (let i = 0; i < count; i++) {
        if (i > 0) arc += Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
        if (arc < next) continue;
        const sepP = dsep(u[i]);
        next = arc + 0.5 * sepP;
        // the local tangent from the neighbouring points, the normal to its left
        const a = i > 0 ? i - 1 : i, b = i < count - 1 ? i + 1 : i;
        let tx = pts[2 * b] - pts[2 * a], ty = pts[2 * b + 1] - pts[2 * a + 1];
        const tl = Math.hypot(tx, ty);
        if (!(tl > 0)) continue;
        tx /= tl; ty /= tl;
        const x = pts[2 * i], y = pts[2 * i + 1];
        for (const side of [1, -1]) {
          const nx = -ty * side, ny = tx * side;
          // one refinement for the variable separation: the mean of dsep here and at the first guess
          const sepQ = dsep(toneAt(x + nx * sepP, y + ny * sepP));
          const delta = 0.5 * (sepP + sepQ);
          trySeed(x + nx * delta, y + ny * delta);
          if (over()) return;
          if (steps - lastReport >= PROGRESS_STEPS) yield report();
        }
      }
    }
  }

  // 1. the first seed: the image centre if it is dark enough, otherwise the darkest point (the smallest index on a tie)
  let first = -1;
  if (toneAt(w / 2, h / 2) >= tau) first = trace(w / 2, h / 2);
  if (first < 0) {
    let best = -1, bi = -1;
    for (let i = 0; i < tone.length; i++) if (tone[i] > best) { best = tone[i]; bi = i; }
    if (bi >= 0 && best >= tau) trace((bi % w) + 0.5, Math.floor(bi / w) + 0.5);
  }
  yield* spread(0);
  // 2. the sweep: a lattice of dMin, row by row; a free dark point seeds a new flow
  const lat = Math.max(1, dMin);
  for (let y = lat / 2; y < h && !limited; y += lat) {
    for (let x = lat / 2; x < w && !limited; x += lat) {
      const before = lines.length;
      if (trySeed(x, y) >= 0) yield* spread(before);
      over();
      if (steps - lastReport >= PROGRESS_STEPS) yield report();
    }
  }
  return { lines, limited };
}

/** Runs placeStreamlines to the end (tests). */
export function streamlines(opts) {
  const gen = placeStreamlines(opts);
  for (;;) { const r = gen.next(); if (r.done) return r.value; }
}
