// Crop frame geometry of the "Photo" tab: pure functions, no DOM. A rect is { x, y, w, h } in px of the decoded (source)
// image, img is { width, height }; null means "the whole image". aspect is width / height of the frame (null — free).

/** The smallest frame side in source px (or the image side if it is smaller). */
export const MIN_CROP = 16;

export const fullRect = (img) => ({ x: 0, y: 0, w: img.width, h: img.height });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (r) => r && [r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v));

/** The frame covers the whole image. */
export const isFull = (rect, img) => !rect || (rect.x <= 0 && rect.y <= 0 && rect.x + rect.w >= img.width && rect.y + rect.h >= img.height);

/**
 * A valid stored frame: whole px, inside the image, at least the minimum size; the whole image (or an invalid rect) -> null.
 */
export function normalizeCrop(rect, img, minSize = MIN_CROP) {
  if (!img || !(img.width > 0 && img.height > 0) || !finite(rect)) return null;
  const minW = Math.min(minSize, img.width), minH = Math.min(minSize, img.height);
  const w = clamp(Math.round(rect.w), minW, img.width), h = clamp(Math.round(rect.h), minH, img.height);
  const x = clamp(Math.round(rect.x), 0, img.width - w), y = clamp(Math.round(rect.y), 0, img.height - h);
  const out = { x, y, w, h };
  return isFull(out, img) ? null : out;
}

/**
 * Width / height of the drawing field (field minus margins); rotated — the inverse, as in scaleToPaper: the rotated image has
 * to fit the field. null — no valid field.
 */
export function fieldAspect(printParams) {
  if (!printParams || !printParams.fieldMm) return null;
  const aw = printParams.fieldMm.w - 2 * (printParams.marginMm || 0), ah = printParams.fieldMm.h - 2 * (printParams.marginMm || 0);
  if (!(aw > 0 && ah > 0)) return null;
  return printParams.rotate ? ah / aw : aw / ah;
}

/** The largest rect of the given aspect with the same centre inside rect (null rect — the whole image). */
export function fitAspect(rect, img, aspect) {
  const r = rect || fullRect(img);
  if (!(aspect > 0)) return { ...r };
  let w = r.w, h = r.h;
  if (w / h > aspect) w = h * aspect; else h = w / aspect;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/**
 * Which part of the frame is under the point (source px): 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | null.
 * tol — the grab distance in source px (a corner wins over a side); on a small frame the grab zones shrink to a third of
 * its side so that the inside can still be dragged.
 */
export function hitTest(rect, x, y, tol) {
  const l = rect.x, t = rect.y, r = rect.x + rect.w, b = rect.y + rect.h;
  const tx = Math.min(tol, rect.w / 3), ty = Math.min(tol, rect.h / 3);
  const dl = Math.abs(x - l), dr = Math.abs(x - r), dt = Math.abs(y - t), db = Math.abs(y - b);
  const hs = dl <= tx || dr <= tx ? (dl <= dr ? 'w' : 'e') : '';
  const vs = dt <= ty || db <= ty ? (dt <= db ? 'n' : 's') : '';
  const inX = x >= l - tx && x <= r + tx, inY = y >= t - ty && y <= b + ty;
  if (hs && vs) return vs + hs;
  if (hs && inY) return hs;
  if (vs && inX) return vs;
  if (x > l && x < r && y > t && y < b) return 'move';
  return null;
}

/**
 * The frame after dragging a handle of start by (dx, dy) source px. The result stays inside the image and is at least
 * minSize; with an aspect a corner keeps the opposite corner in place (the size follows the larger of the two moves) and a
 * side keeps the opposite side in place and grows the other axis symmetrically about the centre. 'move' keeps the size and
 * stops at the image edge. Fractional values (rounded by normalizeCrop on commit).
 */
export function dragRect(start, handle, dx, dy, img, { aspect = null, minSize = MIN_CROP } = {}) {
  const W = img.width, H = img.height;
  const min = Math.min(minSize, W, H);
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (handle === 'move') {
    const x = clamp(l + dx, 0, W - start.w), y = clamp(t + dy, 0, H - start.h);
    return { x, y, w: start.w, h: start.h };
  }
  const hasW = handle.includes('w'), hasE = handle.includes('e'), hasN = handle.includes('n'), hasS = handle.includes('s');
  if (!(aspect > 0)) {
    if (hasW) l = clamp(l + dx, 0, r - min);
    if (hasE) r = clamp(r + dx, l + min, W);
    if (hasN) t = clamp(t + dy, 0, b - min);
    if (hasS) b = clamp(b + dy, t + min, H);
    return { x: l, y: t, w: r - l, h: b - t };
  }
  const a = aspect;
  const wMin = Math.max(min, min * a);
  const horiz = hasW || hasE, vert = hasN || hasS;
  if (horiz && vert) { // corner: the opposite corner is the anchor
    const sx = hasE ? 1 : -1, sy = hasS ? 1 : -1;
    const ax = hasE ? l : r, ay = hasS ? t : b;
    const mx = hasE ? r : l, my = hasS ? b : t;
    let w = Math.max(sx * (mx + dx - ax), sy * (my + dy - ay) * a);
    const maxW = Math.min(sx > 0 ? W - ax : ax, (sy > 0 ? H - ay : ay) * a);
    w = Math.min(Math.max(w, wMin), maxW);
    const h = w / a;
    return { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
  }
  if (horiz) { // side: the opposite side is the anchor, the height grows about the centre
    const sx = hasE ? 1 : -1, ax = hasE ? l : r, mx = hasE ? r : l, cy = (t + b) / 2;
    let w = sx * (mx + dx - ax);
    const maxW = Math.min(sx > 0 ? W - ax : ax, 2 * Math.min(cy, H - cy) * a);
    w = Math.min(Math.max(w, wMin), Math.max(maxW, 0));
    const h = w / a;
    return { x: sx > 0 ? ax : ax - w, y: clamp(cy - h / 2, 0, Math.max(0, H - h)), w, h };
  }
  const sy = hasS ? 1 : -1, ay = hasS ? t : b, my = hasS ? b : t, cx = (l + r) / 2;
  let h = sy * (my + dy - ay);
  const maxH = Math.min(sy > 0 ? H - ay : ay, (2 * Math.min(cx, W - cx)) / a);
  h = Math.min(Math.max(h, wMin / a), Math.max(maxH, 0));
  const w = h * a;
  return { x: clamp(cx - w / 2, 0, Math.max(0, W - w)), y: sy > 0 ? ay : ay - h, w, h };
}
