// Drawing (machine) + profile + calibration -> G-code, statistics, ready pen commands.
import { SPACE, DrawingError, assertSpace, bbox, allLines } from './drawing.js';
import { absoluteZ, axisLimits } from './profile.js';
import { estimateTime } from './time-estimate.js';

const f3 = (v) => (Math.round(v * 1000) / 1000).toFixed(3);
const fz = (v) => String(Number(v.toFixed(3)));

const defaultBeforeLayer = (layer) => [`; layer: ${String(layer.name).replace(/[\r\n]+/g, ' ')}`];

/** How far the drawing exceeds the axis limits, mm per axis (0 — does not exceed). */
export function overflow(bounds, limits) {
  return {
    x: Math.max(0, limits.x0 - bounds.x0, bounds.x1 - limits.x1),
    y: Math.max(0, limits.y0 - bounds.y0, bounds.y1 - limits.y1),
  };
}

/**
 * @param ctx { profile, calibration, beforeLayer?: (layer, index) => string[] }
 * @returns { gcode, stats, warnings, outOfLimits: null | {x, y} }
 */
export function generateGcode(drawing, { profile: p, calibration: cal, beforeLayer }) {
  assertSpace(drawing, SPACE.MACHINE, 'нужна раскладка на поле');
  const lines = allLines(drawing);
  const ob = bbox(drawing);
  if (!ob) throw new DrawingError('нечего рисовать');
  const z = absoluteZ(p, cal);
  const start = [cal.cornerX, cal.cornerY];
  const usedLayers = drawing.layers.filter((l) => l.lines.length);
  const hook = beforeLayer || (usedLayers.length > 1 ? defaultBeforeLayer : () => []);

  const g = ['G21', 'G90'];
  if (p.home) g.push('G28');
  g.push(...meshLines(p));
  g.push(`G0 Z${fz(z.start)} F${p.fZUp}`);
  let draw = 0, travel = 0, pos = start, zNow = z.start;
  const moves = []; // moves for the time estimate — the same as in the G-code (the first Z from an unknown height is not counted)
  const zMove = (to, feed) => { moves.push({ kind: 'z', len: Math.abs(to - zNow), feed }); zNow = to; };
  usedLayers.forEach((layer, index) => {
    g.push(...hook(layer, index));
    for (const l of layer.lines) {
      const tl = Math.hypot(l[0] - pos[0], l[1] - pos[1]);
      travel += tl;
      zMove(z.up, p.fZUp);
      moves.push({ kind: 'travel', len: tl, feed: p.fTravel });
      zMove(z.down, p.fZDown);
      moves.push({ kind: 'draw', pts: l, feed: p.fDraw });
      g.push(`G0 Z${fz(z.up)} F${p.fZUp}`, `G0 X${f3(l[0])} Y${f3(l[1])} F${p.fTravel}`, `G1 Z${fz(z.down)} F${p.fZDown}`);
      for (let i = 2; i < l.length; i += 2) {
        draw += Math.hypot(l[i] - l[i - 2], l[i + 1] - l[i - 1]);
        g.push(`G1 X${f3(l[i])} Y${f3(l[i + 1])}` + (i === 2 ? ` F${p.fDraw}` : ''));
      }
      pos = [l[l.length - 2], l[l.length - 1]];
    }
  });
  zMove(z.up, p.fZUp); zMove(z.end, p.fZUp);
  g.push(`G0 Z${fz(z.up)} F${p.fZUp}`, `G0 Z${fz(z.end)} F${p.fZUp}`);
  if (p.motorsOff) g.push('M84');

  const warnings = [...drawing.meta.warnings];
  const over = overflow(ob, axisLimits(p));
  const outOfLimits = over.x > 1e-6 || over.y > 1e-6 ? over : null;
  if (over.x > 1e-6) warnings.push(`выход за X на ${over.x.toFixed(1)} мм`);
  if (over.y > 1e-6) warnings.push(`выход за Y на ${over.y.toFixed(1)} мм`);

  const time = estimateTime(moves, { accelXY: p.accelXY, accelZ: p.accelZ });
  const layoutInfo = drawing.meta.layout;
  return {
    gcode: g.join('\n') + '\n',
    warnings,
    outOfLimits,
    stats: {
      lines: lines.length, draw, travel, time, bbox: ob,
      scale: layoutInfo ? layoutInfo.scale : null,
      size: [ob.w, ob.h],
    },
  };
}

// --- short pen programs: built by the core, the transport only passes them on

/** Full mesh compensation at any height: the touch, the outline and the drawing must be computed with the same compensation. */
export const meshLines = (p) => (p.meshNoFade ? ['M420 S1 Z0'] : []);

/** Raises the pen to the start height (above the lift height used while drawing). */
export function liftLines(p, cal) {
  const z = absoluteZ(p, cal);
  return ['G90', ...meshLines(p), `G0 Z${fz(z.start)} F${p.fZUp}`];
}

export function cornerLines(p, cal) {
  const z = absoluteZ(p, cal);
  return ['G90', ...meshLines(p), `G0 Z${fz(z.start)} F${p.fZUp}`, `G0 X${fz(cal.cornerX)} Y${fz(cal.cornerY)} F${p.fTravel}`];
}

export function touchLines(p, cal) {
  const z = absoluteZ(p, cal);
  return ['G90', ...meshLines(p), `G0 Z${fz(z.touch)} F${p.fZDown}`];
}

/**
 * A relative step along one axis (jog panel): G91 → step → G90. Feed: fTravel for X/Y, fZUp/fZDown for Z.
 * The bed mesh is enabled the same way as for the other short programs (the compensation must match the drawing).
 */
export function jogLines(p, axis, delta) {
  const a = String(axis).toUpperCase();
  const f = a === 'Z' ? (delta > 0 ? p.fZUp : p.fZDown) : p.fTravel;
  return ['G91', ...meshLines(p), `G0 ${a}${fz(delta)} F${f}`, 'G90'];
}

export const homeLines = () => ['G28'];
export const motorsOffLines = () => ['M84'];

/** Tracing the outline with the pen raised: no lower than the touch + clearance. */
export function frameLines(bounds, p, cal) {
  const z = absoluteZ(p, cal);
  const xy = (x, y) => `G0 X${f3(x)} Y${f3(y)} F${p.fTravel}`;
  return [
    'G90',
    ...meshLines(p),
    `G0 Z${fz(z.clearance)} F${p.fZUp}`,
    xy(bounds.x0, bounds.y0), xy(bounds.x1, bounds.y0), xy(bounds.x1, bounds.y1),
    xy(bounds.x0, bounds.y1), xy(bounds.x0, bounds.y0),
    `G0 Z${fz(z.end)} F${p.fZUp}`,
  ];
}
