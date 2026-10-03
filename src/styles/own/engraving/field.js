// Direction field of the "Engraving" style: where the lines go. Pure functions in image px, no DOM.
//
// structureField — the smoothed structure tensor of the image brightness at two scales: per pixel the isophote orientation
// (the direction of equal tone, across the gradient) as a doubled-angle unit vector (cos 2θ, sin 2θ) — an orientation has
// no sign, the doubled angle makes θ and θ + 180° the same vector, so orientations can be averaged and interpolated —
// and the coherence (how one-directional the local structure is, 0..1):
//   - the form scale: the gradient of the image blurred by half the smoothing, its tensor smoothed by the smoothing —
//     large shapes (the oval of a face, a fold), texture and small features averaged out;
//   - the detail scale: the tensor of the fine gradient smoothed by a third of it — eyes, nose, hair strands.
// Gradients steeper than GRADIENT_CAP enter the tensors capped (a hard edge does not drag the field around it). Also the
// energy (how fast the brightness changes: the root mean square gradient in the detail window times scalePx — the
// brightness change over 1 cm on paper in the style, 0..1) and the purity (form vs texture, see structureFieldSteps). It
// depends only on the brightness and the scales: tone parameters (contrast, gamma, inversion) do not change it.
//
// directionField — the final orientation: the form isophote bent toward the detail one by a share ("Fine detail"),
// rotated by fieldRotation, blended with the base angle by a weight that falls to 0 in flat (weak gradient), isotropic
// (low coherence) or textured (low purity, "Simplify background") areas; the weight map is blurred so the lines turn to
// the base angle gradually. Angles: 0° along +x, positive — clockwise on screen (y down), as in kit/lines.js.
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

/** Gradient cap (brightness change per scalePx, 0..1): a pixel whose gradient is steeper adds to the tensor about as much as
 *  this gradient — a hard edge (a silhouette, a hair line) does not outweigh the gentle shading of the form around it, and
 *  lines beside an edge do not all run along it for a long distance. */
export const GRADIENT_CAP = 0.2;

/** Doubled-angle orientation of the isophote and coherence of a smoothed tensor (a, b, c) = (J11, J12, J22), in place. */
function eigen(a, b, c, n) {
  const c2 = new Float32Array(n), s2 = new Float32Array(n), coherence = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dx = a[i] - c[i], dy = 2 * b[i];
    const diff = Math.sqrt(dx * dx + dy * dy); // λ1 − λ2
    const sum = a[i] + c[i];                   // λ1 + λ2
    if (diff > EPS) { c2[i] = -dx / diff; s2[i] = -dy / diff; } else { c2[i] = 1; s2[i] = 0; }
    const q = diff / (sum + EPS);
    coherence[i] = q * q;
  }
  return { c2, s2, coherence };
}

/**
 * The structure tensor of the brightness at two scales, as a generator (yields {} between the heavy passes so a driver can
 * cut slices).
 * @param gray brightness 0..255 (Float32Array w·h)
 * @param opts { sigmaPx — the form scale (gaussian σ in px of the tensor smoothing), detailSigmaPx — the detail scale
 *   (default sigmaPx), puritySigmaPx — the window of the purity (default sigmaPx), scalePx — the energy is the brightness
 *   change (0..1) over this distance at the root mean square gradient of the detail window (default 40 px); the gradient
 *   cap GRADIENT_CAP is per scalePx as well }
 * @returns { w, h, sigmaPx, c2, s2, coherence, purity, dc2, ds2, dcoherence, energy }: c2/s2 — the isophote orientation of
 *   the form scale as a doubled-angle unit vector, coherence — its coherence 0..1; dc2/ds2/dcoherence — the same at the
 *   detail scale; purity, energy 0..1
 */
export function* structureFieldSteps(gray, w, h, { sigmaPx, detailSigmaPx = sigmaPx, puritySigmaPx = sigmaPx, scalePx = 40 }) {
  const n = w * h;
  // 1. pre-smoothing: three passes of radius 1 (≈ gaussian σ ≈ 1), on brightness 0..1
  const g0 = new Float32Array(n);
  for (let i = 0; i < n; i++) g0[i] = gray[i] / 255;
  const g = gauss3(g0, w, h, 1);
  const cap = (8 * GRADIENT_CAP) / scalePx;
  // 2. the detail scale: the tensor of the fine gradient smoothed by detailSigmaPx; energy from its uncapped trace
  const fine = gradientTensor(g, w, h, cap);
  yield {};
  const rd = boxRadiusForSigma(detailSigmaPx), rf = boxRadiusForSigma(sigmaPx);
  const detail = eigen(gauss3(fine.j11, w, h, rd), gauss3(fine.j12, w, h, rd), gauss3(fine.j22, w, h, rd), n);
  yield {};
  const tr = gauss3(fine.m2, w, h, rd);
  const energy = new Float32Array(n);
  const k = scalePx / 8;
  for (let i = 0; i < n; i++) energy[i] = Math.min(1, k * Math.sqrt(Math.max(0, tr[i])));
  yield {};
  // 3. the form scale: the gradient of the image blurred by sigmaPx/2 (texture and small features averaged out), its
  //    tensor smoothed by sigmaPx
  const gb = gauss3(g, w, h, boxRadiusForSigma(sigmaPx / 2));
  const big = gradientTensor(gb, w, h, cap);
  yield {};
  const form = eigen(gauss3(big.j11, w, h, rf), gauss3(big.j12, w, h, rf), gauss3(big.j22, w, h, rf), n);
  yield {};
  // 4. purity — how much the structure around a point (window puritySigmaPx, its own scale, so the form scale does not move
  //    the simplification) is a form rather than a texture: the larger of
  //    - the share of the gradient energy that survives a blur of puritySigmaPx/2 (shading of a form — near 1, texture of
  //      small details — near 0) and
  //    - the coherence of the fine gradient over the window (one edge or parallel strokes — near 1, foliage and noise with
  //      gradients in all directions — near 0: a clean silhouette is a form even though it does not survive the blur)
  const rp = boxRadiusForSigma(puritySigmaPx);
  const pb = rp === rf ? big : gradientTensor(gauss3(g, w, h, boxRadiusForSigma(puritySigmaPx / 2)), w, h, cap);
  const eb = gauss3(pb.m2, w, h, rp), ef = gauss3(fine.m2, w, h, rp);
  yield {};
  const pc = eigen(gauss3(fine.j11, w, h, rp), gauss3(fine.j12, w, h, rp), gauss3(fine.j22, w, h, rp), n).coherence;
  const purity = new Float32Array(n);
  for (let i = 0; i < n; i++) purity[i] = Math.max(Math.min(1, eb[i] / (ef[i] + 1e-12)), pc[i]);
  return { w, h, sigmaPx, c2: form.c2, s2: form.s2, coherence: form.coherence, purity, dc2: detail.c2, ds2: detail.s2, dcoherence: detail.coherence, energy };
}

/** Sobel gradient (edges repeated) of g: the tensor terms with the gradient cap — g·gᵀ·cap²/(|g|² + cap²): up to the cap
 *  as is, beyond it the contribution levels off at cap² —, and the uncapped |g|² (m2). Sobel gives 8× the derivative. */
function gradientTensor(g, w, h, cap) {
  const n = w * h, cap2 = cap * cap;
  const j11 = new Float32Array(n), j12 = new Float32Array(n), j22 = new Float32Array(n), m2 = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const ym = (y > 0 ? y - 1 : 0) * w, y0 = y * w, yp = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : x;
      const gx = (g[ym + xp] + 2 * g[y0 + xp] + g[yp + xp]) - (g[ym + xm] + 2 * g[y0 + xm] + g[yp + xm]);
      const gy = (g[yp + xm] + 2 * g[yp + x] + g[yp + xp]) - (g[ym + xm] + 2 * g[ym + x] + g[ym + xp]);
      const i = y0 + x;
      const q = gx * gx + gy * gy;
      const kk = cap2 / (q + cap2);
      j11[i] = gx * gx * kk; j12[i] = gx * gy * kk; j22[i] = gy * gy * kk; m2[i] = q;
    }
  }
  return { j11, j12, j22, m2 };
}

/** The structure tensor at once (tests). */
export function structureField(gray, w, h, opts) {
  const gen = structureFieldSteps(gray, w, h, opts);
  for (;;) { const r = gen.next(); if (r.done) return r.value; }
}

/** How far "Simplify background" 100 % moves the purity window up: the weight is 0 below PURITY_SPAN·s and full above
 *  2.5 times that (s = simplify/100). */
export const PURITY_SPAN = 0.17;

/** The purity window [lo, hi] of the form weight for "Simplify background" (0..100). */
export function purityWindow(simplify = 50) {
  const s = Math.min(1, Math.max(0, simplify / 100));
  const lo = PURITY_SPAN * s;
  return [lo, 2.5 * lo];
}

/**
 * The blend weight of the image orientation:
 *   followForm · smoothstep(T/2, T, energy) · smoothstep(0.05, 0.3, coherence) · smoothstep(purityWindow(simplify), purity)
 * (purity — the share of the gradient energy left after the form blur: chaotic texture — foliage, noise — has a low one and
 * falls back to the base angle; without purity — 1).
 */
export function formWeight(energy, coherence, { followForm = 100, flatThreshold = 5, simplify = 50 } = {}, purity = 1) {
  const T = flatThreshold / 100;
  const [lo, hi] = purityWindow(simplify);
  return (followForm / 100) * smoothstep(T / 2, T, energy) * smoothstep(0.05, 0.3, coherence) * (hi > 0 ? smoothstep(lo, hi, purity) : 1);
}

/**
 * The final orientation field. The image orientation is the form-scale isophote bent toward the detail-scale one by the
 * share detail/100 of the angle between them (only where the detail is coherent): fine detail bends the lines, the form
 * leads them. It is rotated by fieldRotation and blended with the base angle: a = wgt·image + (1 − wgt)·base, in doubled
 * angles, normalised (where the blend cancels out — the base angle).
 * @param raw  structureField result
 * @param opts { baseAngle, fieldRotation, followForm (0..100), flatThreshold (0..100), detail (0..100), simplify (0..100) }
 * @returns { w, h, c2, s2 } — unit doubled-angle vectors; orientation θ = ½·atan2(s2, c2)
 */
export function directionField(raw, { baseAngle = 30, fieldRotation = 0, followForm = 100, flatThreshold = 5, detail = 0, simplify = 50 } = {}) {
  const { w, h } = raw;
  const n = w * h;
  const bc = Math.cos(2 * baseAngle * RAD), bs = Math.sin(2 * baseAngle * RAD);
  const rc = Math.cos(2 * fieldRotation * RAD), rs = Math.sin(2 * fieldRotation * RAD);
  const c2 = new Float32Array(n), s2 = new Float32Array(n);
  const opts = { followForm, flatThreshold, simplify };
  const kd = Math.min(1, Math.max(0, detail / 100));
  const hasDetail = kd > 0 && raw.dc2 && raw.dc2 !== raw.c2;
  // the weight map, blurred by half the form scale: no seams of the base angle along thin low-coherence lines, the lines
  // turn from the form to the base angle gradually
  let wmap = new Float32Array(n);
  if (followForm > 0) {
    for (let i = 0; i < n; i++) wmap[i] = formWeight(raw.energy[i], raw.coherence[i], opts, raw.purity ? raw.purity[i] : 1);
    if (raw.sigmaPx > 0) wmap = gauss3(wmap, w, h, boxRadiusForSigma(raw.sigmaPx / 2));
  }
  for (let i = 0; i < n; i++) {
    const wgt = wmap[i];
    let fc = raw.c2[i], fs = raw.s2[i];
    if (hasDetail && wgt > 0) {
      // the doubled-angle difference detail − form, a share of it applied to the form orientation
      const dc = raw.dc2[i], ds = raw.ds2[i];
      const b = kd * smoothstep(0.05, 0.3, raw.dcoherence[i]) * Math.atan2(fc * ds - fs * dc, fc * dc + fs * ds);
      if (b !== 0) { const cb = Math.cos(b), sb = Math.sin(b); const t = fc * cb - fs * sb; fs = fc * sb + fs * cb; fc = t; }
    }
    const ic = fc * rc - fs * rs, is = fc * rs + fs * rc;
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
