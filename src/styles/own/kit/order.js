// Output order of own styles: keep the given stroke order, only choose each stroke's direction so that it starts at the
// end closer to where the previous one ended. For a family of parallel lines output by line index this is a serpentine;
// for strokes in placement order (engraving) — short pen-up travels between neighbours. Pure functions, no DOM.
// The print pipeline sorts again (core/optimize sortMerge), but a good initial order keeps neighbours together and lets
// linkTolMm join them deliberately.

/** A reversed copy of a polyline [x0,y0,...] (Float64Array). */
export function reversePolyline(pts) {
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    out[pts.length - 2 - i] = pts[i];
    out[pts.length - 1 - i] = pts[i + 1];
  }
  return out;
}

const d2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);

/**
 * @param strokes polylines in output order
 * @param start   [x, y] the first stroke starts at the end closer to it; null — the first stroke keeps its direction
 * @returns a new array: the same strokes in the same order, some reversed (copies); the others are the same objects
 */
export function orientChain(strokes, start = null) {
  const out = [];
  let ex = start ? start[0] : NaN, ey = start ? start[1] : NaN;
  for (const s of strokes) {
    const n = s.length;
    if (n < 2) continue;
    const flip = Number.isFinite(ex) && d2(ex, ey, s[n - 2], s[n - 1]) < d2(ex, ey, s[0], s[1]);
    const o = flip ? reversePolyline(s) : s;
    out.push(o);
    ex = o[n - 2]; ey = o[n - 1];
  }
  return out;
}

/**
 * Like orientChain, but over groups: a group is a chain of strokes along one line (in order along it) that is reversed as a
 * whole — the order of its strokes and each stroke — when its last end is closer to the previous end than its first start.
 * A family of lines with gaps (light breaks) becomes a serpentine: line j left to right, line j+1 right to left.
 * @param groups [[stroke, ...], ...]; empty groups are skipped
 * @returns a flat array of strokes
 */
export function orientGroups(groups, start = null) {
  const out = [];
  let ex = start ? start[0] : NaN, ey = start ? start[1] : NaN;
  for (const g of groups) {
    const list = g.filter((s) => s.length >= 2);
    if (!list.length) continue;
    const first = list[0], last = list[list.length - 1];
    const flip = Number.isFinite(ex) && d2(ex, ey, last[last.length - 2], last[last.length - 1]) < d2(ex, ey, first[0], first[1]);
    const ordered = flip ? list.slice().reverse().map(reversePolyline) : list;
    out.push(...ordered);
    const e = ordered[ordered.length - 1];
    ex = e[e.length - 2]; ey = e[e.length - 1];
  }
  return out;
}
