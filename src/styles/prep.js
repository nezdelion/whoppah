// Image preprocessing before any style (the same for all layers of the Photo tab): cropping and "Fade background"
// (a vignette toward white). Pure functions over RGBA images { width, height, data: Uint8ClampedArray }, no DOM.
// The fade changes tone only: own styles get it as a mask (toneFade) and multiply their darkness after tone mapping, so the
// direction fields and other geometry are computed from the un-faded image; styles that take only an image (plotterfun)
// get it baked in (applyVignette).

/** A copy of the rect { x, y, w, h } (whole px, clamped to the image) of an RGBA image. */
export function cropImage(img, rect) {
  const x = Math.max(0, Math.min(img.width - 1, Math.round(rect.x))), y = Math.max(0, Math.min(img.height - 1, Math.round(rect.y)));
  const w = Math.max(1, Math.min(img.width - x, Math.round(rect.w))), h = Math.max(1, Math.min(img.height - y, Math.round(rect.h)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * img.width + x) * 4;
    data.set(img.data.subarray(from, from + w * 4), row * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * "Fade background": strength 0..100 % (0 — off), size of the ellipse in % of the image (100 — inscribed), softness — the
 * width of the transition inside the ellipse edge in % of its radius. cx, cy — the centre in fractions of the image.
 */
export const VIGNETTE_DEFAULTS = Object.freeze({ strength: 0, size: 100, softness: 40, cx: 0.5, cy: 0.5 });
export const VIGNETTE_RANGES = Object.freeze({ strength: [0, 100], size: [30, 150], softness: [0, 100], cx: [0, 1], cy: [0, 1] });

/** A valid vignette: unknown keys dropped, missing or invalid values — defaults, numbers clamped to the ranges. */
export function normalizeVignette(v) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(VIGNETTE_RANGES)) {
    const x = v && v[k];
    out[k] = typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : VIGNETTE_DEFAULTS[k];
  }
  return out;
}

/** Mask at a normalized ellipse distance d (1 — on the ellipse): 1 inside, 0 outside, smoothstep over the softness. */
function maskOf(d, soft) {
  if (d >= 1) return 0;
  if (d <= 1 - soft) return 1;
  const s = (1 - d) / soft;
  return s * s * (3 - 2 * s);
}

/** Calls fn(index, mask) for every pixel (mask 1 — the image is kept, 0 — fully faded). */
function eachMask(w, h, v, fn) {
  const { size, softness, cx, cy } = normalizeVignette(v);
  const rx = (size / 100) * 0.5 * w, ry = (size / 100) * 0.5 * h;
  const soft = softness / 100, ox = cx * w, oy = cy * h;
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5 - oy) / ry, fy2 = fy * fy;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5 - ox) / rx;
      fn(y * w + x, maskOf(Math.sqrt(fx * fx + fy2), soft));
    }
  }
}

/** The vignette mask w×h: Float32Array, 1 — keep, 0 — fade. */
export function vignetteMask(w, h, v = {}) {
  const out = new Float32Array(w * h);
  eachMask(w, h, v, (i, m) => { out[i] = m; });
  return out;
}

/**
 * "Fade background" as a tone mask for own styles: keep factor per pixel, 1 − strength·(1 − mask) (1 — the tone is kept,
 * 1 − strength — outside the ellipse). Multiplying the darkness after tone mapping by it is the same tone as applyVignette,
 * but the image the style analyses (its gradients, direction field) stays un-faded. null — off.
 */
export function toneFade(w, h, v) {
  const k = normalizeVignette(v).strength / 100;
  if (!(k > 0)) return null;
  const out = new Float32Array(w * h);
  eachMask(w, h, v, (i, m) => { out[i] = 1 - k * (1 - m); });
  return out;
}

/** Darkness (0..1, w*h) faded toward white by a toneFade mask; null mask — the same array. */
export function applyFade(dark, fade) {
  if (!fade) return dark;
  const out = new Float32Array(dark.length);
  for (let i = 0; i < dark.length; i++) out[i] = dark[i] * fade[i];
  return out;
}

/**
 * The image faded toward white outside the ellipse (baked in: for styles that take only an image — plotterfun — and for
 * the photo underlay): v' = v + (255 − v)·strength·(1 − mask) for R, G, B; alpha is kept.
 * strength 0 returns the same object (no copy).
 */
export function applyVignette(img, v) {
  const k = normalizeVignette(v).strength / 100;
  if (!(k > 0)) return img;
  const src = img.data, data = new Uint8ClampedArray(src);
  eachMask(img.width, img.height, v, (i, m) => {
    const f = k * (1 - m);
    if (f <= 0) return;
    const p = i * 4;
    data[p] = src[p] + (255 - src[p]) * f;
    data[p + 1] = src[p + 1] + (255 - src[p + 1]) * f;
    data[p + 2] = src[p + 2] + (255 - src[p + 2]) * f;
  });
  return { width: img.width, height: img.height, data };
}
