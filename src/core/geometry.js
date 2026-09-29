// Affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f; curves and arcs.

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function parseNumbers(s) {
  return (String(s || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
}

export function parseTransform(s) {
  let m = IDENTITY;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const v = parseNumbers(t[2]);
    let n = IDENTITY;
    const rad = (v[0] || 0) * Math.PI / 180;
    switch (t[1]) {
      case 'matrix': if (v.length === 6) n = v; break;
      case 'translate': n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': n = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0]; break;
      case 'rotate':
        n = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
        if (v.length > 2) n = multiply(multiply([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
        break;
      case 'skewX': n = [1, 0, Math.tan(rad), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan(rad), 0, 1, 0, 0]; break;
    }
    m = multiply(m, n);
  }
  return m;
}

// SVG arc (endpoint parameterization) -> list of cubic segments ['C', x1, y1, x2, y2, x, y].
export function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  if (!rx || !ry) return [['L', x2, y2]];
  const cp = Math.cos(phi * Math.PI / 180), sp = Math.sin(phi * Math.PI / 180);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (fa === fs) co = -co;
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9));
  const d = dt / n, k = 4 / 3 * Math.tan(d / 4);
  const pt = (t) => [cx + rx * Math.cos(t) * cp - ry * Math.sin(t) * sp,
    cy + rx * Math.cos(t) * sp + ry * Math.sin(t) * cp];
  const der = (t) => [-rx * Math.sin(t) * cp - ry * Math.cos(t) * sp,
    -rx * Math.sin(t) * sp + ry * Math.cos(t) * cp];
  const out = [];
  for (let i = 0, t = t1; i < n; i++, t += d) {
    const e1 = pt(t), e2 = i === n - 1 ? [x2, y2] : pt(t + d);
    const d1 = der(t), d2 = der(t + d);
    out.push(['C', e1[0] + k * d1[0], e1[1] + k * d1[1], e2[0] - k * d2[0], e2[1] - k * d2[1],
      e2[0], e2[1]]);
  }
  return out;
}

// Subpath {x, y, segs: [['L', x, y] | ['C', x1, y1, x2, y2, x, y]]} -> flat polyline,
// curves are cut into chords about step long (at most 500 per segment).
export function flattenSubpath(sp, step) {
  const pts = [sp.x, sp.y];
  let px = sp.x, py = sp.y;
  for (const sg of sp.segs) {
    if (sg[0] === 'L') { pts.push(sg[1], sg[2]); px = sg[1]; py = sg[2]; continue; }
    const [, x1, y1, x2, y2, x, y] = sg;
    const len = Math.hypot(x1 - px, y1 - py) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
    const n = Math.min(500, Math.max(1, Math.ceil(len / step)));
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push(u * u * u * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
        u * u * u * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y);
    }
    px = x; py = y;
  }
  return pts;
}

// Distance from a point to a segment.
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
