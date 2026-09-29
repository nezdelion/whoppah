// SVG -> pen plotter G-code, like the vpype pipeline we used:
//   read file.svg linemerge linesort layout -m MARGIN WxH gwrite -p neptune
// No DOM needed: works on a plain {tag, attrs, children} tree, so it runs in node too.
(function (root) {
  'use strict';

  const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'style',
    'script', 'title', 'desc', 'metadata', 'text', 'image', 'linearGradient', 'radialGradient',
    'filter', 'foreignObject']);

  // --- affine matrices [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f
  const I = [1, 0, 0, 1, 0, 0];
  function mul(m, n) {
    return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  function nums(s) {
    return (String(s || '').match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) || []).map(Number);
  }

  function parseTransform(s) {
    let m = I;
    if (!s) return m;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
    let t;
    while ((t = re.exec(s))) {
      const v = nums(t[2]);
      let n = I;
      const rad = (v[0] || 0) * Math.PI / 180;
      switch (t[1]) {
        case 'matrix': if (v.length === 6) n = v; break;
        case 'translate': n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
        case 'scale': n = [v[0], 0, 0, v.length > 1 ? v[1] : v[0], 0, 0]; break;
        case 'rotate':
          n = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
          if (v.length > 2) n = mul(mul([1, 0, 0, 1, v[1], v[2]], n), [1, 0, 0, 1, -v[1], -v[2]]);
          break;
        case 'skewX': n = [1, 0, Math.tan(rad), 1, 0, 0]; break;
        case 'skewY': n = [1, Math.tan(rad), 0, 1, 0, 0]; break;
      }
      m = mul(m, n);
    }
    return m;
  }

  // --- geometry: subpath = {x, y, segs: [['L', x, y] | ['C', x1, y1, x2, y2, x, y]]}

  function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
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

  function parsePath(d) {
    const subs = [];
    const s = String(d || '');
    const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
    let i = 0;
    const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
    const hasNum = () => { ws(); return i < s.length && /[-+.\d]/.test(s[i]); };
    const num = () => {
      ws(); NUM.lastIndex = i;
      const m = NUM.exec(s);
      if (!m) throw new Error('bad path data at ' + i);
      i = NUM.lastIndex; return +m[0];
    };
    const flag = () => { ws(); const c = s[i++]; if (c !== '0' && c !== '1') throw new Error('bad arc flag'); return c === '1'; };
    let cur = null, cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lastCmd = '';
    const sub = () => { if (!cur) { cur = { x: cx, y: cy, segs: [] }; subs.push(cur); } return cur; };
    while (true) {
      ws();
      if (i >= s.length) break;
      let cmd = s[i];
      if (/[a-zA-Z]/.test(cmd)) i++;
      else if (lastCmd) cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
      else throw new Error('path must start with a command');
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      const ox = rel ? cx : 0, oy = rel ? cy : 0;
      let smooth = false;
      switch (C) {
        case 'M':
          cx = ox + num(); cy = oy + num(); sx = cx; sy = cy;
          cur = null; sub();
          break;
        case 'L': cx = ox + num(); cy = oy + num(); sub().segs.push(['L', cx, cy]); break;
        case 'H': cx = ox + num(); sub().segs.push(['L', cx, cy]); break;
        case 'V': cy = oy + num(); sub().segs.push(['L', cx, cy]); break;
        case 'C': case 'S': {
          let x1, y1;
          if (C === 'C') { x1 = ox + num(); y1 = oy + num(); } else if ('CcSs'.includes(lastCmd)) { x1 = 2 * cx - lcx; y1 = 2 * cy - lcy; } else { x1 = cx; y1 = cy; }
          const x2 = ox + num(), y2 = oy + num(), x = ox + num(), y = oy + num();
          sub().segs.push(['C', x1, y1, x2, y2, x, y]);
          lcx = x2; lcy = y2; cx = x; cy = y; smooth = true;
          break;
        }
        case 'Q': case 'T': {
          let qx, qy;
          if (C === 'Q') { qx = ox + num(); qy = oy + num(); } else if ('QqTt'.includes(lastCmd)) { qx = 2 * cx - lcx; qy = 2 * cy - lcy; } else { qx = cx; qy = cy; }
          const x = ox + num(), y = oy + num();
          sub().segs.push(['C', cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy),
            x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y]);
          lcx = qx; lcy = qy; cx = x; cy = y; smooth = true;
          break;
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag();
          const x = ox + num(), y = oy + num();
          sub().segs.push(...arcToCubics(cx, cy, rx, ry, rot, fa, fs, x, y));
          cx = x; cy = y;
          break;
        }
        case 'Z':
          if (cur) cur.segs.push(['L', sx, sy]);
          cx = sx; cy = sy; cur = null;
          break;
        default: throw new Error('unknown path command ' + cmd);
      }
      if (!smooth) { lcx = cx; lcy = cy; }
      lastCmd = cmd;
    }
    return subs;
  }

  function poly(pts, closed) {
    if (!pts.length) return [];
    const segs = pts.slice(1).map(p => ['L', p[0], p[1]]);
    if (closed) segs.push(['L', pts[0][0], pts[0][1]]);
    return [{ x: pts[0][0], y: pts[0][1], segs }];
  }

  function ellipse(cx, cy, rx, ry) {
    if (!(rx > 0 && ry > 0)) return [];
    const k = 0.5522847498;
    return [{ x: cx + rx, y: cy, segs: [
      ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
      ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
      ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
      ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy]] }];
  }

  function shapeSubs(tag, a) {
    const f = (k) => parseFloat(a[k]) || 0;
    switch (tag) {
      case 'path': return parsePath(a.d);
      case 'line': return poly([[f('x1'), f('y1')], [f('x2'), f('y2')]], false);
      case 'polyline': case 'polygon': {
        const v = nums(a.points), pts = [];
        for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
        return poly(pts, tag === 'polygon');
      }
      case 'rect': {
        const x = f('x'), y = f('y'), w = f('width'), h = f('height');
        return w > 0 && h > 0 ? poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true) : [];
      }
      case 'circle': return ellipse(f('cx'), f('cy'), f('r'), f('r'));
      case 'ellipse': return ellipse(f('cx'), f('cy'), f('rx'), f('ry'));
    }
    return null;
  }

  function hidden(a) {
    const st = String(a.style || '').replace(/\s/g, '');
    return a.display === 'none' || a.visibility === 'hidden' ||
      /display:none/.test(st) || /visibility:hidden/.test(st);
  }

  // Walk the tree, return transformed subpaths (SVG user units) + skipped element count.
  function collect(tree) {
    const ids = {};
    (function index(n) { if (n.attrs && n.attrs.id) ids[n.attrs.id] = n; (n.children || []).forEach(index); })(tree);
    const out = [];
    let skipped = 0;
    (function walk(n, m, depth, isRoot) {
      if (depth > 50 || hidden(n.attrs || {}) || SKIP.has(n.tag)) { if (n.tag === 'text' || n.tag === 'image') skipped++; return; }
      const a = n.attrs || {};
      let mm = mul(m, parseTransform(a.transform));
      if (n.tag === 'svg' && !isRoot) mm = mul(mm, [1, 0, 0, 1, parseFloat(a.x) || 0, parseFloat(a.y) || 0]);
      if (n.tag === 'use') {
        const ref = ids[String(a.href || a['xlink:href'] || '').replace(/^#/, '')];
        if (ref) walk(ref, mul(mm, [1, 0, 0, 1, parseFloat(a.x) || 0, parseFloat(a.y) || 0]), depth + 1, false);
        return;
      }
      const subs = shapeSubs(n.tag, a);
      if (subs) {
        for (const sp of subs) {
          const [x, y] = apply(mm, sp.x, sp.y);
          out.push({ x, y, segs: sp.segs.map(sg => {
            const r = [sg[0]];
            for (let k = 1; k < sg.length; k += 2) r.push(...apply(mm, sg[k], sg[k + 1]));
            return r;
          }) });
        }
        return;
      }
      (n.children || []).forEach(c => walk(c, mm, depth + 1, false));
    })(tree, I, 0, true);
    return { subs: out, skipped };
  }

  // Subpaths -> polylines, curves split into chords of about `step` units.
  function flatten(subs, step) {
    const lines = [];
    for (const sp of subs) {
      const pts = [[sp.x, sp.y]];
      let px = sp.x, py = sp.y;
      for (const sg of sp.segs) {
        if (sg[0] === 'L') { pts.push([sg[1], sg[2]]); px = sg[1]; py = sg[2]; continue; }
        const [, x1, y1, x2, y2, x, y] = sg;
        const len = Math.hypot(x1 - px, y1 - py) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
        const n = Math.min(500, Math.max(1, Math.ceil(len / step)));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          pts.push([u * u * u * px + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x,
            u * u * u * py + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y]);
        }
        px = x; py = y;
      }
      // drop repeated points
      const clean = [pts[0]];
      for (const p of pts) { const q = clean[clean.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) clean.push(p); }
      if (clean.length > 1) lines.push(clean);
    }
    return lines;
  }

  function bbox(lines) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of lines) for (const [x, y] of l) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
  }

  // Greedy nearest-neighbour order (either end), joins lines whose ends meet (<= tol).
  function sortMerge(lines, start, tol) {
    const n = lines.length;
    if (!n) return [];
    const b = bbox(lines);
    const cell = Math.max(Math.sqrt(Math.max(b.w * b.h, 1e-6) / n), 1e-6);
    const grid = new Map();
    const key = (i, j) => i + ',' + j;
    const ci = (x) => Math.floor((x - b.x0) / cell), cj = (y) => Math.floor((y - b.y0) / cell);
    lines.forEach((l, li) => [0, 1].forEach(end => {
      const p = end ? l[l.length - 1] : l[0], k = key(ci(p[0]), cj(p[1]));
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
        for (let i = i0 - r; i <= i0 + r; i++) for (let j = j0 - r; j <= j0 + r; j++) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r) continue;
          const c = grid.get(key(i, j));
          if (!c) continue;
          for (const [li, end] of c) {
            if (used[li]) continue;
            const q = end ? lines[li][lines[li].length - 1] : lines[li][0];
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d < bd) { bd = d; best = [li, end]; }
          }
        }
      }
      used[best[0]] = 1;
      const pts = best[1] ? lines[best[0]].slice().reverse() : lines[best[0]].slice();
      if (out.length && bd <= tol) out[out.length - 1].push(...pts.slice(1));
      else out.push(pts);
      p = pts[pts.length - 1];
    }
    return out;
  }

  const DEFAULTS = {
    fieldW: 180, fieldH: 180, margin: 5, halign: 'center', valign: 'center', rotate: false,
    cornerX: -5, cornerY: 50,           // nozzle position when the pen is on the paper corner
    zDown: 7.3, zUp: 10, zStart: 15, zEnd: 25,
    fDraw: 3000, fTravel: 6000, fZUp: 1200, fZDown: 600,
    home: false, motorsOff: true, mergeTol: 0.05,
    limX0: -5, limX1: 230, limY0: 0, limY1: 230,
  };

  // tree -> {lines (printer mm), gcode, stats, warnings}
  function plan(tree, opt) {
    const o = Object.assign({}, DEFAULTS, opt);
    const { subs, skipped } = collect(tree);
    const warnings = [];
    if (skipped) warnings.push(skipped + ' text/image elements skipped (convert text to paths)');
    // rough scale from control points, to pick a chord length of ~0.3 mm
    let raw = flatten(subs.map(s => ({ x: s.x, y: s.y, segs: s.segs.map(g => ['L', g[g.length - 2], g[g.length - 1]]) })), Infinity);
    if (!raw.length) return { lines: [], gcode: '', stats: null, warnings: warnings.concat('nothing to draw') };
    const aw = o.fieldW - 2 * o.margin, ah = o.fieldH - 2 * o.margin;
    let rb = bbox(raw);
    const rot = (l) => o.rotate ? l.map(([x, y]) => [-y, x]) : l;
    const est = Math.min(aw / Math.max(o.rotate ? rb.h : rb.w, 1e-9), ah / Math.max(o.rotate ? rb.w : rb.h, 1e-9));
    let lines = flatten(subs, 0.3 / est).map(rot);
    const b = bbox(lines);
    const s = Math.min(b.w > 0 ? aw / b.w : Infinity, b.h > 0 ? ah / b.h : Infinity);
    const gx = aw - b.w * s, gy = ah - b.h * s;       // free space in the field
    const offX = o.margin + (o.halign === 'left' ? 0 : o.halign === 'right' ? gx : gx / 2);
    const offTop = o.margin + (o.valign === 'top' ? 0 : o.valign === 'bottom' ? gy : gy / 2);
    // SVG y goes down; paper y goes up from the field bottom
    lines = lines.map(l => l.map(([x, y]) => [
      o.cornerX + offX + (x - b.x0) * s,
      o.cornerY + o.fieldH - (offTop + (y - b.y0) * s)]));
    lines = sortMerge(lines, [o.cornerX, o.cornerY], o.mergeTol);

    const f = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
    const g = ['G21', 'G90'];
    if (o.home) g.push('G28');
    g.push(`G0 Z${o.zStart} F${o.fZUp}`);
    let draw = 0, travel = 0, p = [o.cornerX, o.cornerY];
    for (const l of lines) {
      travel += Math.hypot(l[0][0] - p[0], l[0][1] - p[1]);
      g.push(`G0 Z${o.zUp} F${o.fZUp}`, `G0 X${f(l[0][0])} Y${f(l[0][1])} F${o.fTravel}`, `G1 Z${o.zDown} F${o.fZDown}`);
      for (let i = 1; i < l.length; i++) {
        draw += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
        g.push(`G1 X${f(l[i][0])} Y${f(l[i][1])}` + (i === 1 ? ` F${o.fDraw}` : ''));
      }
      p = l[l.length - 1];
    }
    g.push(`G0 Z${o.zUp} F${o.fZUp}`, `G0 Z${o.zEnd} F${o.fZUp}`);
    if (o.motorsOff) g.push('M84');

    const ob = bbox(lines);
    if (ob.x0 < o.limX0 - 1e-6 || ob.x1 > o.limX1 + 1e-6 || ob.y0 < o.limY0 - 1e-6 || ob.y1 > o.limY1 + 1e-6)
      warnings.push(`out of printer limits: X ${ob.x0.toFixed(1)}..${ob.x1.toFixed(1)}, Y ${ob.y0.toFixed(1)}..${ob.y1.toFixed(1)}`);
    const zt = lines.length * ((o.zUp - o.zDown) / (o.fZUp / 60) + (o.zUp - o.zDown) / (o.fZDown / 60));
    const seconds = draw / (o.fDraw / 60) + travel / (o.fTravel / 60) + zt;
    return {
      lines, gcode: g.join('\n') + '\n', warnings,
      stats: { lines: lines.length, draw, travel, seconds, bbox: ob, scale: s,
        size: [b.w * s, b.h * s] },
    };
  }

  const api = { parsePath, parseTransform, collect, flatten, sortMerge, plan, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PlotCore = api;
})(this);
