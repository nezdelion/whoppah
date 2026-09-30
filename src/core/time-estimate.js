// Print time estimate with acceleration. A pure function: a list of moves -> {min, max} seconds.

/** A turn at a junction of drawing segments no larger than this — the chain does not stop (the "min" estimate), deg. */
export const MERGE_ANGLE_DEG = 45;
const COS_MERGE = Math.cos((MERGE_ANGLE_DEG * Math.PI) / 180) - 1e-9;

/**
 * Time of one move of length len mm at feed feed mm/min and acceleration accel mm/s².
 * Without opts — from rest to a stop: trapezoid (len >= v²/a): len/v + v/a; triangle (the feed is not reached): 2·sqrt(len/a).
 * @param opts.maxFeed mm/s — the firmware limit (M203): a feed above it is clamped (no limit by default)
 * @param opts.jerk mm/s — the initial and final speed of a move min(jerk, v) instead of 0 (the firmware classic jerk; default 0)
 * With initial speed v0: acceleration and braking by (v² − v0²)/(2a), a plateau between them; if v is not reached — peak sqrt(a·len + v0²).
 */
export function moveSeconds(len, feed, accel, { maxFeed = Infinity, jerk = 0 } = {}) {
  if (!(len > 0)) return 0;
  const v = Math.min(feed / 60, maxFeed);
  const v0 = Math.min(Math.max(jerk, 0), v);
  const ramp = (v * v - v0 * v0) / (2 * accel); // the distance of one acceleration (equal to that of braking)
  if (len >= 2 * ramp) return (2 * (v - v0)) / accel + (len - 2 * ramp) / v;
  return (2 * (Math.sqrt(accel * len + v0 * v0) - v0)) / accel;
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
 * @param accel { accelXY, accelZ } mm/s²; optionally firmware limits (per XY and Z axes, mm/s), without them the estimate is unchanged:
 *   maxFeedXY, maxFeedZ — feed clamp (M203); jerkXY, jerkZ — speed at move ends (M205). For the XY axis pair the smaller
 *   of X and Y is taken (conservative: a diagonal move is clamped by the weakest axis); see firmwareEstimateOptions in firmware-settings.js
 * @returns { min, max } seconds: max — every segment with a stop, min — smooth junctions up to MERGE_ANGLE_DEG
 */
export function estimateTime(moves, { accelXY, accelZ, maxFeedXY, maxFeedZ, jerkXY, jerkZ }) {
  const xy = { maxFeed: maxFeedXY ?? Infinity, jerk: jerkXY ?? 0 }, zz = { maxFeed: maxFeedZ ?? Infinity, jerk: jerkZ ?? 0 };
  let min = 0, max = 0;
  for (const m of moves) {
    if (m.kind === 'draw') {
      for (let i = 2; i < m.pts.length; i += 2) max += moveSeconds(Math.hypot(m.pts[i] - m.pts[i - 2], m.pts[i + 1] - m.pts[i - 1]), m.feed, accelXY, xy);
      for (const len of chainLengths(m.pts)) min += moveSeconds(len, m.feed, accelXY, xy);
    } else {
      const t = m.kind === 'z' ? moveSeconds(m.len, m.feed, accelZ, zz) : moveSeconds(m.len, m.feed, accelXY, xy);
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
