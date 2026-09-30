// Simplification (RDP) and line sorting/merging. All functions return a new drawing.
import { derive, stats, pointCount } from './drawing.js';
import { pointSegmentDistance } from './geometry.js';

const EPS = 1e-9;

// --- RDP, iterative (no recursion)

function rdpLine(line, tol) {
  const n = pointCount(line);
  if (n < 3) return line;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  while (stack.length) {
    const j = stack.pop(), i = stack.pop();
    let best = -1, dmax = tol;
    for (let k = i + 1; k < j; k++) {
      const d = pointSegmentDistance(line[2 * k], line[2 * k + 1], line[2 * i], line[2 * i + 1], line[2 * j], line[2 * j + 1]);
      if (d > dmax) { dmax = d; best = k; }
    }
    if (best >= 0) { keep[best] = 1; stack.push(i, best, best, j); }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(line[2 * k], line[2 * k + 1]);
  return out;
}

/** Tolerance in drawing units (mm for a drawing in machine coordinates); 0 — unchanged. */
export function simplify(drawing, tol) {
  if (!(tol > 0)) return drawing;
  const layers = drawing.layers.map((layer) => {
    const lines = [];
    for (const l of layer.lines) {
      const s = rdpLine(l, tol);
      const closedToPoint = s.length === 4 && Math.hypot(s[2] - s[0], s[3] - s[1]) <= EPS;
      if (!closedToPoint) lines.push(s);
    }
    return { ...layer, lines };
  });
  return derive(drawing, { layers });
}

// --- sorting and merging

function bounds(lines) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) {
    for (let i = 0; i < l.length; i += 2) {
      if (l[i] < x0) x0 = l[i];
      if (l[i] > x1) x1 = l[i];
      if (l[i + 1] < y0) y0 = l[i + 1];
      if (l[i + 1] > y1) y1 = l[i + 1];
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

function reversed(line) {
  const out = new Array(line.length);
  for (let i = 0; i < line.length; i += 2) {
    out[line.length - 2 - i] = line[i];
    out[line.length - 1 - i] = line[i + 1];
  }
  return out;
}

// Greedy nearest-end search (with reversal); lines abutting within tol are joined (the start of the next one is dropped),
// and within linkTol are connected by a stroke without lifting the pen: all points stay in place, the transition is drawn.
function sortMergeLines(lines, start, tol, linkTol) {
  const n = lines.length;
  if (!n) return [];
  const b = bounds(lines);
  // the lower cell bound protects against degenerate bounds (horizontal lines)
  const cell = Math.max(Math.sqrt(Math.max(b.w * b.h, 1e-6) / n), Math.max(b.w, b.h) / 1000, 1e-6);
  const grid = new Map();
  const key = (i, j) => i + ',' + j;
  const ci = (x) => Math.floor((x - b.x0) / cell), cj = (y) => Math.floor((y - b.y0) / cell);
  const endPoint = (l, end) => (end ? [l[l.length - 2], l[l.length - 1]] : [l[0], l[1]]);
  lines.forEach((l, li) => [0, 1].forEach((end) => {
    const p = endPoint(l, end), k = key(ci(p[0]), cj(p[1]));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push([li, end]);
  }));
  const maxR = Math.ceil(Math.max(b.w, b.h) / cell) + Math.ceil(Math.hypot(start[0] - b.x0, start[1] - b.y0) / cell) + 2;
  const used = new Uint8Array(n);
  const out = [];
  let p = start;
  for (let left = n; left > 0; left--) {
    const i0 = ci(p[0]), j0 = cj(p[1]);
    let best = null, bd = Infinity;
    for (let r = 0; r <= maxR; r++) {
      if (best && (r - 1) * cell > bd) break;
      for (let i = i0 - r; i <= i0 + r; i++) {
        const edgeRow = Math.abs(i - i0) === r;
        for (let j = j0 - r; j <= j0 + r; j += edgeRow || r === 0 ? 1 : 2 * r) {
          const c = grid.get(key(i, j));
          if (!c) continue;
          for (const [li, end] of c) {
            if (used[li]) continue;
            const q = endPoint(lines[li], end);
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < bd) { bd = d; best = [li, end]; }
          }
        }
      }
    }
    used[best[0]] = 1;
    const pts = best[1] ? reversed(lines[best[0]]) : lines[best[0]].slice();
    if (out.length && (bd <= tol || bd <= linkTol)) {
      const target = out[out.length - 1];
      for (let k = bd <= tol ? 2 : 0; k < pts.length; k++) target.push(pts[k]);
    } else out.push(pts);
    p = [pts[pts.length - 2], pts[pts.length - 1]];
  }
  return out;
}

/** Lines within a layer are reordered, the layer order is preserved; each layer starts where the previous one ended. */
export function sortMerge(drawing, { start = [0, 0], tol = 0.05, linkTol = 0 } = {}) {
  let p = start;
  const layers = drawing.layers.map((layer) => {
    const lines = sortMergeLines(layer.lines, p, tol, linkTol);
    if (lines.length) { const l = lines[lines.length - 1]; p = [l[l.length - 2], l[l.length - 1]]; }
    return { ...layer, lines };
  });
  return derive(drawing, { layers });
}

export function travelLength(drawing, start = [0, 0]) {
  let travel = 0, p = start;
  for (const layer of drawing.layers) {
    for (const l of layer.lines) {
      travel += Math.hypot(l[0] - p[0], l[1] - p[1]);
      p = [l[l.length - 2], l[l.length - 1]];
    }
  }
  return travel;
}

/** simplify -> sortMerge, plus a before/after report. */
export function optimize(drawing, { simplifyTolMm = 0, mergeTolMm = 0.05, linkTolMm = 0, start = [0, 0] } = {}) {
  const before = stats(drawing);
  const travelBefore = travelLength(drawing, start);
  const result = sortMerge(simplify(drawing, simplifyTolMm), { start, tol: mergeTolMm, linkTol: linkTolMm });
  const after = stats(result);
  return {
    drawing: result,
    report: {
      pointsBefore: before.points, pointsAfter: after.points,
      linesBefore: before.lines, linesAfter: after.lines,
      travelBefore, travelAfter: travelLength(result, start),
    },
  };
}
