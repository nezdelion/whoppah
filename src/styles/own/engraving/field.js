// Direction field of the "Engraving" style: where the lines go. Pure functions in image px, no DOM.
//
// structureField — the smoothed structure tensor of the image brightness: per pixel the isophote orientation (the direction
// of equal tone, across the gradient) as a doubled-angle unit vector (cos 2θ, sin 2θ) — an orientation has no sign, the
// doubled angle makes θ and θ + 180° the same vector, so orientations can be averaged and interpolated —, the coherence
// (how one-directional the local structure is, 0..1) and the energy (how fast the brightness changes: the root mean square
// gradient in the smoothing window times scalePx — the brightness change over 1 cm on paper in the style, 0..1). It depends only on the brightness and the smoothing: tone parameters (contrast, gamma, inversion)
// do not change it.
//
// directionField — the final orientation: the isophote rotated by fieldRotation, blended with the base angle by a weight
// that falls to 0 in flat (weak gradient) or isotropic (low coherence) areas. Angles: 0° along +x, positive — clockwise on
// screen (y down), as in kit/lines.js.
import { boxBlur } from '../../tone.js';
import { smoothstep } from '../kit/stroke.js';

const RAD = Math.PI / 180;
const EPS = 1e-9;

/** The box radius r whose three passes approximate a gaussian of sigma: three boxes of width 2r+1 give σ² = ((2r+1)² − 1)/4. */
export const boxRadiusForSigma = (sigma) => Math.max(0, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));

/** Three box passes of radius r (≈ a gaussian), the cost does not depend on r. */
function gauss3(src, w, h, r) {
  if (!(r > 0)) return src;
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}

/**
 * The structure tensor of the brightness, as a generator (yields {} between the heavy passes so a driver can cut slices).
 * @param gray brightness 0..255 (Float32Array w·h)
 * @param opts { sigmaPx — tensor smoothing (gaussian σ in px), scalePx — the energy is the brightness change (0..1) over this
 *   distance at the root mean square gradient of the window (default 40 px) }
 * @returns { w, h, c2, s2, coherence, energy }: c2/s2 — the isophote orientation as a doubled-angle unit vector
 */
export function* structureFieldSteps(gray, w, h, { sigmaPx, scalePx = 40 }) {
  const n = w * h;
  // 1. pre-smoothing: three passes of radius 1 (≈ gaussian σ ≈ 1), on brightness 0..1
  const g0 = new Float32Array(n);
  for (let i = 0; i < n; i++) g0[i] = gray[i] / 255;
  const g = gauss3(g0, w, h, 1);
  // 2. Sobel gradient (edges repeated)
  const j11 = new Float32Array(n), j12 = new Float32Array(n), j22 = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
      const gx = (g[ym + xp] + 2 * g[y0 + xp] + g[yp + xp]) - (g[ym + xm] + 2 * g[y0 + xm] + g[yp + xm]);
      const gy = (g[yp + xm] + 2 * g[yp + x] + g[yp + xp]) - (g[ym + xm] + 2 * g[ym + x] + g[ym + xp]);
      const i = y0 + x;
      j11[i] = gx * gx; j12[i] = gx * gy; j22[i] = gy * gy;
    }
  }
  yield {};
  // 3. the tensor smoothed by a gaussian of sigmaPx (three boxes)
  const r = boxRadiusForSigma(sigmaPx);
  const a = gauss3(j11, w, h, r); yield {};
  const b = gauss3(j12, w, h, r); yield {};
  const c = gauss3(j22, w, h, r); yield {};
  // 4. eigen-analysis: λ1,2 = (a + c)/2 ± sqrt(((a − c)/2)² + b²); the gradient orientation in doubled angle is
  //    (a − c, 2b)/(λ1 − λ2); the isophote is perpendicular: the opposite doubled-angle vector
  // energy: scalePx·rms|∇g| (Sobel gives 8× the derivative), clamped to 0..1 — an absolute measure that does not depend
  // on the smoothing: a gentle shading gradient beside a hard edge is not "flat"
  const c2 = new Float32Array(n), s2 = new Float32Array(n), coherence = new Float32Array(n), energy = new Float32Array(n);
  const k = scalePx / 8;
  for (let i = 0; i < n; i++) {
    const dx = a[i] - c[i], dy = 2 * b[i];
    const diff = Math.sqrt(dx * dx + dy * dy); // λ1 − λ2
    const sum = a[i] + c[i];                   // λ1 + λ2
    if (diff > EPS) { c2[i] = -dx / diff; s2[i] = -dy / diff; } else { c2[i] = 1; s2[i] = 0; }
    const q = diff / (sum + EPS);
    coherence[i] = q * q;
    energy[i] = Math.min(1, k * Math.sqrt(Math.max(0, sum)));
  }
  return { w, h, c2, s2, coherence, energy };
}

/** The structure tensor at once (tests). */
export function structureField(gray, w, h, opts) {
  const gen = structureFieldSteps(gray, w, h, opts);
  for (;;) { const r = gen.next(); if (r.done) return r.value; }
}

/** The blend weight of the image orientation: followForm · smoothstep(T/2, T, energy) · smoothstep(0.05, 0.3, coherence). */
export function formWeight(energy, coherence, { followForm = 100, flatThreshold = 5 } = {}) {
  const T = flatThreshold / 100;
  return (followForm / 100) * smoothstep(T / 2, T, energy) * smoothstep(0.05, 0.3, coherence);
}

/**
 * The final orientation field: a = wgt·(isophote rotated by fieldRotation) + (1 − wgt)·(base angle), in doubled angles,
 * normalised (where the blend cancels out — the base angle).
 * @param raw  structureField result
 * @param opts { baseAngle, fieldRotation, followForm (0..100), flatThreshold (0..100) } — degrees and percents
 * @returns { w, h, c2, s2 } — unit doubled-angle vectors; orientation θ = ½·atan2(s2, c2)
 */
export function directionField(raw, { baseAngle = 30, fieldRotation = 0, followForm = 100, flatThreshold = 5 } = {}) {
  const { w, h } = raw;
  const n = w * h;
  const bc = Math.cos(2 * baseAngle * RAD), bs = Math.sin(2 * baseAngle * RAD);
  const rc = Math.cos(2 * fieldRotation * RAD), rs = Math.sin(2 * fieldRotation * RAD);
  const c2 = new Float32Array(n), s2 = new Float32Array(n);
  const opts = { followForm, flatThreshold };
  for (let i = 0; i < n; i++) {
    const wgt = followForm > 0 ? formWeight(raw.energy[i], raw.coherence[i], opts) : 0;
    const ic = raw.c2[i] * rc - raw.s2[i] * rs, is = raw.c2[i] * rs + raw.s2[i] * rc;
    const x = wgt * ic + (1 - wgt) * bc, y = wgt * is + (1 - wgt) * bs;
    const l = Math.sqrt(x * x + y * y);
    if (l > 1e-6) { c2[i] = x / l; s2[i] = y / l; } else { c2[i] = bc; s2[i] = bs; }
  }
  return { w, h, c2, s2 };
}

/** The field rotated by angleDeg everywhere (the cross layer). */
export function rotateField(f, angleDeg) {
  const rc = Math.cos(2 * angleDeg * RAD), rs = Math.sin(2 * angleDeg * RAD);
  const n = f.w * f.h;
  const c2 = new Float32Array(n), s2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { c2[i] = f.c2[i] * rc - f.s2[i] * rs; s2[i] = f.c2[i] * rs + f.s2[i] * rc; }
  return { w: f.w, h: f.h, c2, s2 };
}

/** The orientation of pixel i in degrees, (−90, 90]. */
export const orientationDeg = (f, i) => (0.5 * Math.atan2(f.s2[i], f.c2[i])) / RAD;

/**
 * A sampler of the field at any point: bilinear over the doubled angle (no sign problem), then the half angle;
 * the direction sign is chosen so that the dot product with (px, py) is ≥ 0.
 * @returns (x, y, px, py, out) => out — out[0], out[1] the unit direction
 */
export function fieldSampler(f) {
  const { w, h, c2, s2 } = f;
  return (x, y, px, py, out) => {
    let fx = x - 0.5, fy = y - 0.5;
    fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
    fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
    const x0 = fx | 0, y0 = fy | 0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
    const ax = fx - x0, ay = fy - y0;
    const i00 = y0 * w + x0, i01 = y0 * w + x1, i10 = y1 * w + x0, i11 = y1 * w + x1;
    const w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay), w10 = (1 - ax) * ay, w11 = ax * ay;
    let c = c2[i00] * w00 + c2[i01] * w01 + c2[i10] * w10 + c2[i11] * w11;
    let s = s2[i00] * w00 + s2[i01] * w01 + s2[i10] * w10 + s2[i11] * w11;
    const l = Math.sqrt(c * c + s * s);
    if (l > 1e-9) { c /= l; s /= l; } else { c = 1; s = 0; }
    // half angle: cos θ = sqrt((1 + c)/2), sin θ = sign(s)·sqrt((1 − c)/2)
    let dx = Math.sqrt(Math.max(0, (1 + c) / 2));
    let dy = Math.sqrt(Math.max(0, (1 - c) / 2));
    if (s < 0) dy = -dy;
    if (dx * px + dy * py < 0) { dx = -dx; dy = -dy; }
    out[0] = dx; out[1] = dy;
    return out;
  };
}
