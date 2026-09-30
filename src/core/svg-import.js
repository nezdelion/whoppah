// SVG tree {tag, attrs, children} -> Drawing (document coordinates).
import { SPACE, createDrawing, cleanLine } from './drawing.js';
import { IDENTITY, multiply, applyMatrix, parseNumbers, parseTransform, arcToCubics, flattenSubpath } from './geometry.js';

export class SvgImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SvgImportError';
  }
}

const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'style',
  'script', 'title', 'desc', 'metadata', 'text', 'image', 'linearGradient', 'radialGradient',
  'filter', 'foreignObject']);

const DEFAULT_CHORD_MM = 0.3;
const PX_MM = 25.4 / 96;
const UNIT_MM = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: PX_MM };

// --- parsing path data -> subpaths

function parsePath(d) {
  const subs = [];
  const s = String(d || '');
  const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;
  let i = 0;
  const ws = () => { while (i < s.length && /[\s,]/.test(s[i])) i++; };
  const num = () => {
    ws(); NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (!m) throw new SvgImportError('не удалось прочитать SVG: ошибка в данных path');
    i = NUM.lastIndex;
    return +m[0];
  };
  const flag = () => {
    ws();
    const c = s[i++];
    if (c !== '0' && c !== '1') throw new SvgImportError('не удалось прочитать SVG: ошибка флага дуги');
    return c === '1';
  };
  let cur = null, cx = 0, cy = 0, sx = 0, sy = 0, lcx = 0, lcy = 0, lastCmd = '';
  const sub = () => { if (!cur) { cur = { x: cx, y: cy, segs: [] }; subs.push(cur); } return cur; };
  for (;;) {
    ws();
    if (i >= s.length) break;
    const start = i; // loop protection: each iteration must advance the position
    let cmd = s[i];
    if (/[a-zA-Z]/.test(cmd)) i++;
    else if (lastCmd && 'Zz'.includes(lastCmd)) throw new SvgImportError('не удалось прочитать SVG: после Z данные без команды');
    else if (lastCmd) cmd = lastCmd === 'M' ? 'L' : lastCmd === 'm' ? 'l' : lastCmd;
    else throw new SvgImportError('не удалось прочитать SVG: path начинается не с команды');
    const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    let smooth = false;
    switch (C) {
      case 'M': cx = ox + num(); cy = oy + num(); sx = cx; sy = cy; cur = null; sub(); break;
      case 'L': cx = ox + num(); cy = oy + num(); sub().segs.push(['L', cx, cy]); break;
      case 'H': cx = ox + num(); sub().segs.push(['L', cx, cy]); break;
      case 'V': cy = oy + num(); sub().segs.push(['L', cx, cy]); break;
      case 'C': case 'S': {
        let x1, y1;
        if (C === 'C') { x1 = ox + num(); y1 = oy + num(); }
        else if ('CcSs'.includes(lastCmd)) { x1 = 2 * cx - lcx; y1 = 2 * cy - lcy; }
        else { x1 = cx; y1 = cy; }
        const x2 = ox + num(), y2 = oy + num(), x = ox + num(), y = oy + num();
        sub().segs.push(['C', x1, y1, x2, y2, x, y]);
        lcx = x2; lcy = y2; cx = x; cy = y; smooth = true;
        break;
      }
      case 'Q': case 'T': {
        let qx, qy;
        if (C === 'Q') { qx = ox + num(); qy = oy + num(); }
        else if ('QqTt'.includes(lastCmd)) { qx = 2 * cx - lcx; qy = 2 * cy - lcy; }
        else { qx = cx; qy = cy; }
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
      default: throw new SvgImportError('не удалось прочитать SVG: неизвестная команда path ' + cmd);
    }
    if (!smooth) { lcx = cx; lcy = cy; }
    if (i <= start) throw new SvgImportError('не удалось прочитать SVG: ошибка в данных path');
    lastCmd = cmd;
  }
  return subs;
}

/** The d attribute data -> polylines (flat arrays), curve chord no longer than step units. For styles that return a path as a string. */
export function pathToLines(d, step) {
  return parsePath(d).map((sp) => cleanLine(flattenSubpath(sp, step))).filter(Boolean);
}

// --- shapes -> subpaths

function poly(pts, closed) {
  if (!pts.length) return [];
  const segs = pts.slice(1).map((p) => ['L', p[0], p[1]]);
  if (closed) segs.push(['L', pts[0][0], pts[0][1]]);
  return [{ x: pts[0][0], y: pts[0][1], segs }];
}

function ellipse(cx, cy, rx, ry) {
  if (!(rx > 0 && ry > 0)) return [];
  const k = 0.5522847498;
  return [{
    x: cx + rx, y: cy,
    segs: [
      ['C', cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry],
      ['C', cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy],
      ['C', cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry],
      ['C', cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy],
    ],
  }];
}

function roundedRect(x, y, w, h, rx, ry) {
  const segs = [];
  const arc = (x1, y1, x2, y2) => segs.push(...arcToCubics(x1, y1, rx, ry, 0, false, true, x2, y2));
  segs.push(['L', x + w - rx, y]);
  arc(x + w - rx, y, x + w, y + ry);
  segs.push(['L', x + w, y + h - ry]);
  arc(x + w, y + h - ry, x + w - rx, y + h);
  segs.push(['L', x + rx, y + h]);
  arc(x + rx, y + h, x, y + h - ry);
  segs.push(['L', x, y + ry]);
  arc(x, y + ry, x + rx, y);
  return [{ x: x + rx, y, segs }];
}

function rectSubs(a) {
  const f = (k) => parseFloat(a[k]) || 0;
  const x = f('x'), y = f('y'), w = f('width'), h = f('height');
  if (!(w > 0 && h > 0)) return [];
  const hasRx = a.rx !== undefined, hasRy = a.ry !== undefined;
  let rx = hasRx ? f('rx') : f('ry'), ry = hasRy ? f('ry') : f('rx');
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  if (!(rx > 0 && ry > 0)) return poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true);
  return roundedRect(x, y, w, h, rx, ry);
}

function shapeSubs(tag, a) {
  const f = (k) => parseFloat(a[k]) || 0;
  switch (tag) {
    case 'path': return parsePath(a.d);
    case 'line': return poly([[f('x1'), f('y1')], [f('x2'), f('y2')]], false);
    case 'polyline': case 'polygon': {
      const v = parseNumbers(a.points), pts = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      return poly(pts, tag === 'polygon');
    }
    case 'rect': return rectSubs(a);
    case 'circle': return ellipse(f('cx'), f('cy'), f('r'), f('r'));
    case 'ellipse': return ellipse(f('cx'), f('cy'), f('rx'), f('ry'));
  }
  return null;
}

function isHidden(a) {
  const st = String(a.style || '').replace(/\s/g, '');
  return a.display === 'none' || a.visibility === 'hidden' ||
    /display:none/.test(st) || /visibility:hidden/.test(st);
}

const isLayerGroup = (a) => a['inkscape:groupmode'] === 'layer';

// Tree traversal: subpaths in document coordinates, grouped by Inkscape layers.
function collect(tree) {
  const ids = {};
  (function index(n) { if (n.attrs && n.attrs.id) ids[n.attrs.id] = n; (n.children || []).forEach(index); })(tree);
  const layers = new Map();
  const counts = { text: 0, image: 0 };
  const layerFor = (node) => {
    if (!layers.has(node)) layers.set(node, { node, subs: [] });
    return layers.get(node);
  };

  (function walk(n, m, depth, isRoot, layerNode) {
    const a = n.attrs || {};
    if (depth > 50 || isHidden(a) || SKIP.has(n.tag)) {
      if (n.tag === 'text' || n.tag === 'image') counts[n.tag]++;
      return;
    }
    let mm = multiply(m, parseTransform(a.transform));
    if (n.tag === 'svg' && !isRoot) mm = multiply(mm, [1, 0, 0, 1, parseFloat(a.x) || 0, parseFloat(a.y) || 0]);
    if (n.tag === 'g' && isLayerGroup(a)) layerNode = n;
    if (n.tag === 'use') {
      const ref = ids[String(a.href || a['xlink:href'] || '').replace(/^#/, '')];
      if (ref) walk(ref, multiply(mm, [1, 0, 0, 1, parseFloat(a.x) || 0, parseFloat(a.y) || 0]), depth + 1, false, layerNode);
      return;
    }
    const subs = shapeSubs(n.tag, a);
    if (subs) {
      if (!subs.length) return;
      const target = layerFor(layerNode || null);
      for (const sp of subs) {
        const [x, y] = applyMatrix(mm, sp.x, sp.y);
        target.subs.push({
          x, y,
          segs: sp.segs.map((sg) => {
            const r = [sg[0]];
            for (let k = 1; k < sg.length; k += 2) r.push(...applyMatrix(mm, sg[k], sg[k + 1]));
            return r;
          }),
        });
      }
      return;
    }
    (n.children || []).forEach((c) => walk(c, mm, depth + 1, false, layerNode));
  })(tree, IDENTITY, 0, true, null);

  return { layers: [...layers.values()], counts };
}

// --- physical size

function parseLength(v) {
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*(mm|cm|in|pt|pc|px)\s*$/.exec(String(v || ''));
  return m ? parseFloat(m[1]) * UNIT_MM[m[2]] : null;
}

function physicalInfo(attrs) {
  const w = parseLength(attrs.width), h = parseLength(attrs.height);
  if (!(w > 0 && h > 0)) return {};
  const vb = parseNumbers(attrs.viewBox);
  const unitMm = vb.length === 4 && vb[2] > 0 ? w / vb[2] : PX_MM;
  return { physicalSize: { w, h }, unitMm };
}

// --- assembly

function estimateChordStep(subs, fit, chordMm) {
  const aw = fit.fieldMm.w - 2 * fit.marginMm, ah = fit.fieldMm.h - 2 * fit.marginMm;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sp of subs) {
    const ends = [sp.x, sp.y];
    for (const sg of sp.segs) ends.push(sg[sg.length - 2], sg[sg.length - 1]);
    const line = cleanLine(ends);
    if (!line) continue;
    for (let i = 0; i < line.length; i += 2) {
      x0 = Math.min(x0, line[i]); x1 = Math.max(x1, line[i]);
      y0 = Math.min(y0, line[i + 1]); y1 = Math.max(y1, line[i + 1]);
    }
  }
  if (x0 === Infinity) return chordMm;
  const w = x1 - x0, h = y1 - y0;
  const est = Math.min(aw / Math.max(fit.rotate ? h : w, 1e-9), ah / Math.max(fit.rotate ? w : h, 1e-9));
  return est > 0 && Number.isFinite(est) ? chordMm / est : chordMm;
}

/**
 * @param tree  {tag, attrs, children}
 * @param opts  { name, chordMm = 0.3, fit?: {fieldMm:{w,h}, marginMm, rotate} }
 *   fit is needed so that the curve chord length is about chordMm on paper; without it a document unit = unitMm or 1 mm.
 */
export function importSvg(tree, opts = {}) {
  if (!tree || tree.tag !== 'svg') throw new SvgImportError('не удалось прочитать SVG');
  const chordMm = opts.chordMm || DEFAULT_CHORD_MM;
  const { layers, counts } = collect(tree);
  const info = physicalInfo(tree.attrs || {});

  const allSubs = layers.flatMap((l) => l.subs);
  const step = opts.fit
    ? estimateChordStep(allSubs, opts.fit, chordMm)
    : chordMm / (info.unitMm || 1);

  const warnings = [];
  if (counts.text) warnings.push(`пропущено текстовых элементов: ${counts.text}, переведите текст в кривые`);
  if (counts.image) warnings.push(`пропущено растровых изображений: ${counts.image}`);

  const drawingLayers = layers.map((layer, i) => {
    const attrs = layer.node ? layer.node.attrs : {};
    return {
      id: (layer.node && attrs.id) || `layer-${i + 1}`,
      name: (layer.node && (attrs['inkscape:label'] || attrs.id)) || `Слой ${i + 1}`,
      lines: layer.subs.map((sp) => flattenSubpath(sp, step)),
    };
  });
  if (!layers.some((l) => l.node)) {
    // without Inkscape layers — one layer for the whole document
    const merged = drawingLayers.flatMap((l) => l.lines);
    drawingLayers.length = 0;
    if (merged.length) drawingLayers.push({ id: 'layer-1', name: 'Рисунок', lines: merged });
  }

  return createDrawing({
    space: SPACE.DOCUMENT,
    layers: drawingLayers,
    meta: { source: 'svg', name: opts.name || '', warnings, ...info },
  });
}
