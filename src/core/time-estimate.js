// Print time estimate with acceleration. A pure function: a list of moves -> {min, max} seconds.

/** A turn at a junction of drawing segments no larger than this — the chain does not stop (the "min" estimate), deg. */
export const MERGE_ANGLE_DEG = 45;
const COS_MERGE = Math.cos((MERGE_ANGLE_DEG * Math.PI) / 180) - 1e-9;

/**
 * Time of one move of length len mm at feed feed mm/min and acceleration accel mm/s², from rest to a stop.
 * Trapezoid (len >= v²/a): len/v + v/a; triangle (the feed is not reached): 2·sqrt(len/a).
 */
export function moveSeconds(len, feed, accel) {
  if (!(len > 0)) return 0;
  const v = feed / 60;
  return len >= (v * v) / accel ? len / v + v / accel : 2 * Math.sqrt(len / accel);
}

/** Lengths of polyline segment chains pts=[x0,y0,x1,y1,…]: zero segments are skipped, a sharp turn breaks the chain. */
export function chainLengths(pts) {
  const out = [];
  let cur = 0, dx0 = 0, dy0 = 0, len0 = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2], dy = pts[i + 1] - pts[i - 1], len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    if (len0 > 0 && (dx0 * dx + dy0 * dy) / (len0 * len) < COS_MERGE) { out.push(cur); cur = 0; }
    cur += len; dx0 = dx; dy0 = dy; len0 = len;
  }
  if (cur > 0) out.push(cur);
  return out;
}

/**
 * @param moves [{ kind: 'z'|'travel', len, feed } | { kind: 'draw', pts, feed }], feed mm/min; draw — the pen polyline
 * @param accel { accelXY, accelZ } mm/s²
 * @returns { min, max } seconds: max — every segment with a stop, min — smooth junctions up to MERGE_ANGLE_DEG
 */
export function estimateTime(moves, { accelXY, accelZ }) {
  let min = 0, max = 0;
  for (const m of moves) {
    if (m.kind === 'draw') {
      for (let i = 2; i < m.pts.length; i += 2) max += moveSeconds(Math.hypot(m.pts[i] - m.pts[i - 2], m.pts[i + 1] - m.pts[i - 1]), m.feed, accelXY);
      for (const len of chainLengths(m.pts)) min += moveSeconds(len, m.feed, accelXY);
    } else {
      const t = moveSeconds(m.len, m.feed, m.kind === 'z' ? accelZ : accelXY);
      min += t; max += t;
    }
  }
  return { min, max };
}

/** Time without accelerations (the lower bound for min). */
export function idealTime(moves) {
  let s = 0;
  for (const m of moves) {
    const len = m.kind === 'draw' ? chainLengths(m.pts).reduce((a, b) => a + b, 0) : m.len;
    s += len / (m.feed / 60);
  }
  return s;
}
