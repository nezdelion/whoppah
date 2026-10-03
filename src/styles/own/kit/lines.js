// Line families and polyline measures for own styles. Pure functions in image px, no DOM.
// A polyline is a flat array [x0, y0, x1, y1, ...] (Float64Array or a plain array).

/**
 * The part of the line p + t*d inside [0,w]x[0,h] (Liang–Barsky).
 * @returns [t0, t1] with t0 < t1, or null if the line misses the rectangle
 */
export function clipLine(px, py, dx, dy, w, h) {
  let t0 = -Infinity, t1 = Infinity;
  for (const [p, d, lo, hi] of [[px, dx, 0, w], [py, dy, 0, h]]) {
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return null;
    } else {
      let a = (lo - p) / d, b = (hi - p) / d;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
  }
  return t0 < t1 ? [t0, t1] : null;
}

/**
 * A family of parallel lines through the image with step spacingPx at angleDeg (0 — along +x, positive — clockwise on screen,
 * y down). Line j passes through the image centre shifted by j*spacingPx along the normal n = (-sin, cos); j runs from -J to J
 * (lines that miss the rectangle are skipped), in increasing order.
 * @returns [{ j, ox, oy, dx, dy, nx, ny, t0, t1 }]: the line is (ox, oy) + t*(dx, dy), t in [t0, t1] lies inside the image
 */
export function lineFamily(w, h, angleDeg, spacingPx) {
  const s = Math.max(spacingPx, 1e-3);
  const th = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
  const cx = w / 2, cy = h / 2;
  const J = Math.floor(Math.hypot(w, h) / 2 / s);
  const out = [];
  for (let j = -J; j <= J; j++) {
    const ox = cx + nx * j * s, oy = cy + ny * j * s;
    const range = clipLine(ox, oy, dx, dy, w, h);
    if (range) out.push({ j, ox, oy, dx, dy, nx, ny, t0: range[0], t1: range[1] });
  }
  return out;
}

/** Cumulative arc length at each point: out[0] = 0, out[n-1] = the polyline length. */
export function arcLengths(pts) {
  const n = pts.length >> 1;
  const out = new Float64Array(n);
  for (let i = 1; i < n; i++) out[i] = out[i - 1] + Math.hypot(pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1]);
  return out;
}

/** The polyline length. */
export function polylineLength(pts) {
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return len;
}

/** Strokes at least minPx long (by arc length); the order is kept. */
export function dropShort(strokes, minPx) {
  if (!(minPx > 0)) return strokes.slice();
  return strokes.filter((s) => s.length >= 4 && polylineLength(s) >= minPx);
}
