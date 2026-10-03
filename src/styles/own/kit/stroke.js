// Line thickness imitation by close passes: a pen draws a fixed width W; a thicker line is the same line drawn again
// beside itself with an offset (pitch) smaller than W, so the passes merge on paper. Pure functions in image px, no DOM.
//
// The thick line stays ONE continuous polyline (no pen lift): every run of points that needs k extra half-widths is
// replaced by a "lens" — a pass at +k·pitch forward, a pass at −k·pitch back, then the centre again forward (with nested
// lenses of level k+1). The pass offset tapers smoothly to 0 at both lens ends, so all transitions are continuous.
// In the middle of a level-K lens the line has 2K+1 passes at offsets 0, ±pitch, …, ±K·pitch (an odd count: a continuous
// path that ends at the other end of a segment crosses it an odd number of times).
import { arcLengths } from './lines.js';

/** Hermite smoothstep 0..1; a degenerate edge (e1 <= e0) is a step that is 0 at x = e0. */
export function smoothstep(e0, e1, x) {
  if (!(e1 > e0)) return x > e0 ? 1 : 0;
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** A pass count rounded to an odd number 1..max (max is odd too). */
export function oddPasses(v, max = 5) {
  const m = Math.max(1, 2 * Math.floor((Math.round(max) - 1) / 2) + 1);
  const n = 2 * Math.round((Number(v) - 1) / 2) + 1;
  return Number.isFinite(n) ? Math.min(m, Math.max(1, n)) : 1;
}

/**
 * Thickness level from the effective tone u (0 — light, 1 — black): level = K·smoothstep(startTone, 1, u), K = (maxPasses − 1)/2.
 * The level is real; the pass count at a point is 1 + 2·round(level).
 * @param opts { maxPasses: 1|3|5, startTone: 0..1 — the tone where thickening starts }
 */
export function thicknessProfile(u, { maxPasses = 1, startTone = 0.6 } = {}) {
  const K = (oddPasses(maxPasses) - 1) / 2;
  return K ? K * smoothstep(startTone, 1, u) : 0;
}

/**
 * Per-vertex unit normals (left of the direction of travel, the normalised sum of the adjacent segment normals) and the
 * local curvature radius (from the turning angle and the adjacent segment lengths; Infinity on a straight part).
 */
export function normalsAndRadii(pts) {
  const n = pts.length >> 1;
  const nx = new Float64Array(n), ny = new Float64Array(n), R = new Float64Array(n).fill(Infinity);
  let px = 0, py = 0, pl = 0; // previous segment unit direction and length
  for (let i = 0; i < n; i++) {
    let tx = 0, ty = 0, tl = 0;
    if (i < n - 1) {
      const ax = pts[2 * i + 2] - pts[2 * i], ay = pts[2 * i + 3] - pts[2 * i + 1];
      tl = Math.hypot(ax, ay);
      if (tl > 0) { tx = ax / tl; ty = ay / tl; }
    }
    let sx = -(py + ty), sy = px + tx;
    let sl = Math.hypot(sx, sy);
    if (sl < 1e-9) { sx = -ty || -py; sy = tx || px; sl = Math.hypot(sx, sy) || 1; }
    nx[i] = sx / sl; ny[i] = sy / sl;
    if (pl > 0 && tl > 0) {
      const cos = Math.min(1, Math.max(-1, px * tx + py * ty));
      const theta = Math.acos(cos);
      if (theta > 1e-9) R[i] = ((pl + tl) / 2) / (2 * Math.sin(theta / 2));
    }
    if (tl > 0) { px = tx; py = ty; pl = tl; }
  }
  return { nx, ny, R };
}

/**
 * The thick line as one continuous polyline.
 * @param center polyline [x0,y0,...] (n points)
 * @param level  per-point extra half-width level ≥ 0 (see thicknessProfile); runs where level ≥ k − 0.5 get the k-th lens
 * @param opts {
 *   pitchPx     — offset between neighbouring passes (a fraction of the pen width, less than it);
 *   taperPx     — length over which a pass offset grows from 0 to full at each lens end; runs shorter than 2·taperPx are
 *                 dropped (no "drops"); 0 — the offset jumps right after the lens end;
 *   endTaperPx  — the level is scaled by min(1, s/endTaperPx, (S − s)/endTaperPx): thin stroke ends, like a burin; 0 — off;
 *   radiusLimit — a pass offset is limited by radiusLimit·R (local curvature radius), so the inner side of a tight curve
 *                 does not loop (default 0.9)
 * }
 * @returns Float64Array: starts at the first and ends at the last centre point; level 0 everywhere — a copy of the centre
 */
export function thicken(center, level, { pitchPx, taperPx = 0, endTaperPx = 0, radiusLimit = 0.9 } = {}) {
  const n = center.length >> 1;
  if (n < 2 || !(pitchPx > 0)) return Float64Array.from(center);
  const s = arcLengths(center), S = s[n - 1];
  const lv = new Float64Array(n);
  let top = 0;
  for (let i = 0; i < n; i++) {
    let v = Math.max(0, +level[i] || 0);
    if (endTaperPx > 0) v *= Math.min(1, s[i] / endTaperPx, (S - s[i]) / endTaperPx);
    lv[i] = v;
    if (v > top) top = v;
  }
  const K = Math.floor(top + 0.5);
  if (!K) return Float64Array.from(center);
  const { nx, ny, R } = normalsAndRadii(center);
  const minRun = 2 * Math.max(taperPx, 0);

  const out = [];
  let lx = NaN, ly = NaN;
  const push = (x, y) => { if (x !== lx || y !== ly) { out.push(x, y); lx = x; ly = y; } };

  // maximal index runs [c, d] inside [a, b] where lv >= k - 0.5, at least minRun long (and at least one segment)
  function runsOf(k, a, b) {
    const runs = [];
    let c = -1;
    for (let i = a; i <= b + 1; i++) {
      const on = i <= b && lv[i] >= k - 0.5;
      if (on && c < 0) c = i;
      else if (!on && c >= 0) {
        const d = i - 1;
        if (d > c && s[d] - s[c] >= minRun) runs.push([c, d]);
        c = -1;
      }
    }
    return runs;
  }

  function pass(k, sign, from, to) {
    const c = Math.min(from, to), d = Math.max(from, to), step = from <= to ? 1 : -1;
    for (let i = from; ; i += step) {
      const tau = smoothstep(0, taperPx, s[i] - s[c]) * smoothstep(0, taperPx, s[d] - s[i]);
      const off = sign * Math.min(k * pitchPx * tau, radiusLimit * R[i]);
      push(center[2 * i] + nx[i] * off, center[2 * i + 1] + ny[i] * off);
      if (i === to) break;
    }
  }

  function span(k, a, b) {
    let i = a;
    if (k <= K) {
      for (const [c, d] of runsOf(k, a, b)) {
        for (; i <= c; i++) push(center[2 * i], center[2 * i + 1]);
        pass(k, 1, c, d);
        pass(k, -1, d, c);
        span(k + 1, c, d);
        i = d + 1;
      }
    }
    for (; i <= b; i++) push(center[2 * i], center[2 * i + 1]);
  }

  span(1, 0, n - 1);
  return Float64Array.from(out);
}
