// Image tone: gray, brightness/contrast/inversion, range clamping, blur. Pure functions, core-compatible only.
// Darkness is a number 0..1 (0 — white, 1 — black), a one-dimensional Float32Array w*h.

/** RGBA (Uint8ClampedArray) -> brightness 0..255 (ITU-R 601), transparency counts as white. */
export function toGray(rgba, w, h) {
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    const a = rgba[p + 3] / 255;
    const y = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    gray[i] = y * a + 255 * (1 - a);
  }
  return gray;
}

/**
 * Brightness 0..255 -> darkness 0..1.
 * @param opts { invert, brightness (-100..100), contrast (-100..100), min (0..255), max (0..255), gamma (0.3..3, default 1) }
 *   The formulas match pixelProcessor from plotterfun: contrast around 128, brightness is additive, min/max clamp the range.
 *   gamma: after brightness/contrast/inversion the brightness L = b/255 becomes L^(1/gamma) (gamma > 1 lightens the midtones —
 *   fewer lines, < 1 darkens them); gamma = 1 (the default) is exactly the old computation.
 */
export function toDarkness(gray, opts = {}) {
  const { invert = false, brightness = 0, contrast = 0, min = 0, max = 255, gamma = 1 } = opts;
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const span = Math.max(max, 1);
  const g = Number.isFinite(gamma) && gamma > 0 && gamma !== 1 ? 1 / gamma : 0;
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let b = contrast !== 0 ? factor * (gray[i] - 128) + 128 + brightness : gray[i] + brightness;
    b = Math.min(Math.max(b, 0), 255);
    if (invert) b = 255 - b;
    if (g) b = 255 * Math.pow(b / 255, g);
    b = Math.max(min, b);
    out[i] = Math.min(Math.max((max - b) / span, 0), 1);
  }
  return out;
}

/**
 * Bilinear sample of a w*h field at (x, y) in px, the centre of pixel i is i + 0.5; beyond the edge the edge value repeats.
 * At pixel centres it returns the pixel value exactly, between two centres — the linear mix.
 */
export function sampleBilinear(field, w, h, x, y) {
  let fx = x - 0.5, fy = y - 0.5;
  fx = fx < 0 ? 0 : fx > w - 1 ? w - 1 : fx;
  fy = fy < 0 ? 0 : fy > h - 1 ? h - 1 : fy;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
  const ax = fx - x0, ay = fy - y0;
  const r0 = y0 * w, r1 = y1 * w;
  const top = field[r0 + x0] + (field[r0 + x1] - field[r0 + x0]) * ax;
  const bot = field[r1 + x0] + (field[r1 + x1] - field[r1 + x0]) * ax;
  return top + (bot - top) * ay;
}

/** Box-window blur (radius in pixels), separable, edges repeated. radius <= 0 — a copy. */
export function boxBlur(src, w, h, radius) {
  const r = Math.floor(radius);
  if (!(r > 0)) return Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + Math.min(Math.max(k, 0), w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / n;
      sum += src[row + Math.min(x + r + 1, w - 1)] - src[row + Math.max(x - r, 0)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[Math.min(Math.max(k, 0), h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      sum += tmp[Math.min(y + r + 1, h - 1) * w + x] - tmp[Math.max(y - r, 0) * w + x];
    }
  }
  return out;
}
