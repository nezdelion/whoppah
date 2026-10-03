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

/** Auto levels leave an image whose percentile range is narrower than this (0..255) as is: a flat image is not blown up. */
export const LEVELS_MIN_RANGE = 8;

/**
 * The brightness percentiles [lo, hi] = [P(clipPct), P(100 − clipPct)] of an image 0..255 (a 256-bin histogram, integer
 * bins: lo — the first bin where more than clipPct % of pixels are at or below it, hi — the same from the top).
 */
export function levelsRange(gray, clipPct = 1) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) { const v = gray[i]; hist[v <= 0 ? 0 : v >= 255 ? 255 : v | 0]++; }
  const cut = (Math.min(Math.max(clipPct, 0), 49) / 100) * gray.length;
  let lo = 0, hi = 255;
  for (let acc = 0; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
  for (let acc = 0; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
  return [lo, Math.max(lo, hi)];
}

/**
 * Auto levels: the brightness range [P(clipPct), P(100 − clipPct)] stretched to 0..255 (beyond it clamped). A range
 * narrower than LEVELS_MIN_RANGE — the image unchanged (a copy).
 */
export function autoLevels(gray, clipPct = 1) {
  const [lo, hi] = levelsRange(gray, clipPct);
  if (hi - lo < LEVELS_MIN_RANGE) return Float32Array.from(gray);
  const k = 255 / (hi - lo);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) { const v = (gray[i] - lo) * k; out[i] = v < 0 ? 0 : v > 255 ? 255 : v; }
  return out;
}

/**
 * Local contrast: contrast-limited adaptive histogram equalisation (CLAHE) on a grid of tiles, mixed with the image.
 * Every tile gets its own tone curve (the cumulative histogram, every bin clipped at clip × the mean bin and the excess
 * spread over all bins — flat areas are not blown up); a pixel takes the bilinear mix of the curves of the four nearest
 * tile centres. Cost: one pass over the image plus 256 per tile.
 * @param opts { amount 0..1 — the share of the equalised image, tiles — tiles along the long side (default 8),
 *   clip — the clip limit (default 2.5) }
 * @returns brightness 0..255 (a new array; amount 0 — a copy)
 */
export function localContrast(gray, w, h, { amount = 0.5, tiles = 8, clip = 2.5 } = {}) {
  const a = Math.min(1, Math.max(0, amount));
  if (!(a > 0)) return Float32Array.from(gray);
  const side = Math.max(w, h) / Math.max(1, tiles);
  const nx = Math.max(1, Math.round(w / side)), ny = Math.max(1, Math.round(h / side));
  const tw = w / nx, th = h / ny;
  const maps = new Float32Array(nx * ny * 256);
  const hist = new Float64Array(256);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    hist.fill(0);
    const x0 = Math.floor(tx * tw), x1 = Math.floor((tx + 1) * tw), y0 = Math.floor(ty * th), y1 = Math.floor((ty + 1) * th);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = gray[y * w + x]; hist[v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)]++; }
    const count = (x1 - x0) * (y1 - y0);
    if (!count) continue;
    const limit = Math.max(1, (clip * count) / 256);
    let excess = 0;
    for (let k = 0; k < 256; k++) if (hist[k] > limit) { excess += hist[k] - limit; hist[k] = limit; }
    const add = excess / 256;
    // the curve at bin k: the share of pixels below k plus half of bin k (a flat tile maps to itself)
    const base = (ty * nx + tx) * 256;
    let acc = 0;
    for (let k = 0; k < 256; k++) {
      const hk = hist[k] + add;
      maps[base + k] = (255 * (acc + hk / 2)) / count;
      acc += hk;
    }
  }
  const out = new Float32Array(gray.length);
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) / th - 0.5;
    fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
    const ty0 = Math.floor(fy), ty1 = Math.min(ny - 1, ty0 + 1), ay = fy - ty0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) / tw - 0.5;
      fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
      const tx0 = Math.floor(fx), tx1 = Math.min(nx - 1, tx0 + 1), ax = fx - tx0;
      const i = y * w + x, v = gray[i];
      const c = v <= 0 ? 0 : v >= 255 ? 255 : v;
      const k0 = Math.min(254, Math.floor(c)), t = c - k0;
      const at = (tx, ty) => { const b = (ty * nx + tx) * 256 + k0; return maps[b] + (maps[b + 1] - maps[b]) * t; };
      const top = at(tx0, ty0) + (at(tx1, ty0) - at(tx0, ty0)) * ax;
      const bot = at(tx0, ty1) + (at(tx1, ty1) - at(tx0, ty1)) * ax;
      const eq = top + (bot - top) * ay;
      out[i] = v + a * (eq - v);
    }
  }
  return out;
}
