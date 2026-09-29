// Crosshatch: parallel hatching layers by darkness thresholds. A pure deterministic function.
import { toDarkness, boxBlur } from '../tone.js';

export const DEFAULT_ANGLES = Object.freeze([45, 135, 0, 90]);
const SAMPLE_STEP = 0.5;

export const PARAMS = Object.freeze([
  { key: 'levels', label: 'Уровней штриховки', type: 'number', min: 1, max: 4, step: 1, default: 3 },
  { key: 'spacing', label: 'Шаг линий, px', type: 'number', min: 1, max: 30, step: 0.5, default: 4 },
  { key: 'angle', label: 'Базовый угол, °', type: 'number', min: -90, max: 90, step: 1, default: 0 },
  { key: 'minLength', label: 'Мин. длина отрезка, px', type: 'number', min: 0, max: 50, step: 0.5, default: 4 },
  { key: 'blur', label: 'Размытие, px', type: 'number', min: 0, max: 10, step: 1, default: 1 },
  { key: 'invert', label: 'Инверсия', type: 'bool', default: false },
  { key: 'brightness', label: 'Яркость', type: 'number', min: -100, max: 100, step: 1, default: 0 },
  { key: 'contrast', label: 'Контраст', type: 'number', min: -100, max: 100, step: 1, default: 0 },
]);

export const defaultParams = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.default]));

/** Darkness threshold of level k (1..levels): uniform over the tone range. */
export const thresholdOf = (k, levels) => k / (levels + 1);

// The part of the ray p0 + t*d inside [0,w]x[0,h] (Liang–Barsky); null if the ray misses.
function clip(px, py, dx, dy, w, h) {
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
 * @param gray brightness 0..255, length w*h (see toGray)
 * @returns Float64Array[] — segments [x0,y0,x1,y1]; levels go one after another, lines within a level in a zigzag
 */
export function crosshatch(gray, w, h, params = {}) {
  const p = { ...defaultParams(), ...params };
  const levels = Math.min(4, Math.max(1, Math.round(p.levels)));
  const spacing = Math.max(0.5, +p.spacing);
  const dark = boxBlur(toDarkness(gray, p), w, h, p.blur);
  const cx = w / 2, cy = h / 2, half = Math.hypot(w, h) / 2;
  const lines = [];

  for (let k = 1; k <= levels; k++) {
    const thr = thresholdOf(k, levels);
    const th = ((p.angle + DEFAULT_ANGLES[k - 1]) * Math.PI) / 180;
    const dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    const count = Math.floor(half / spacing);
    for (let j = -count; j <= count; j++) {
      const off = j * spacing;
      const ox = cx + nx * off, oy = cy + ny * off;
      const range = clip(ox, oy, dx, dy, w, h);
      if (!range) continue;
      const segs = [];
      let start = null, last = 0;
      const n = Math.ceil((range[1] - range[0]) / SAMPLE_STEP);
      for (let i = 0; i <= n; i++) {
        const t = Math.min(range[0] + i * SAMPLE_STEP, range[1]);
        const x = ox + dx * t, y = oy + dy * t;
        const ix = Math.min(Math.max(Math.floor(x), 0), w - 1), iy = Math.min(Math.max(Math.floor(y), 0), h - 1);
        const on = dark[iy * w + ix] >= thr;
        if (on) { if (start === null) start = t; last = t; }
        else if (start !== null) { segs.push([start, last]); start = null; }
      }
      if (start !== null) segs.push([start, last]);
      const kept = segs.filter(([a, b]) => b - a >= p.minLength && b > a);
      if (!kept.length) continue;
      const flip = ((j + count) & 1) === 1;
      const ordered = flip ? kept.reverse() : kept;
      for (const [a, b] of ordered) {
        const [s, e] = flip ? [b, a] : [a, b];
        lines.push(Float64Array.of(ox + dx * s, oy + dy * s, ox + dx * e, oy + dy * e));
      }
    }
  }
  return lines;
}
