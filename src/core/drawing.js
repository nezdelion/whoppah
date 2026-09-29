// Drawing model. A line is a flat array [x0, y0, x1, y1, ...].
// All operations return a new drawing and do not modify the input.

export const SPACE = Object.freeze({ DOCUMENT: 'document', MACHINE: 'machine' });

const EPS = 1e-9;

export class DrawingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DrawingError';
  }
}

export const pointCount = (line) => line.length >> 1;

export function forEachSegment(line, fn) {
  for (let i = 2; i < line.length; i += 2) fn(line[i - 2], line[i - 1], line[i], line[i + 1]);
}

export function lineLength(line) {
  let sum = 0;
  for (let i = 2; i < line.length; i += 2) sum += Math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]);
  return sum;
}

// Removes consecutive coincident points; null if fewer than two points remain.
export function cleanLine(pts) {
  if (!pts || pts.length < 2) return null;
  const out = [pts[0], pts[1]];
  for (let i = 2; i + 1 < pts.length; i += 2) {
    const n = out.length;
    if (Math.hypot(pts[i] - out[n - 2], pts[i + 1] - out[n - 1]) > EPS) out.push(pts[i], pts[i + 1]);
  }
  return out.length >= 4 ? out : null;
}

export function createDrawing({ space = SPACE.DOCUMENT, layers = [], meta = {} } = {}) {
  let dropped = meta.dropped || 0;
  const out = layers.map((layer) => {
    const lines = [];
    for (const raw of layer.lines) {
      const line = cleanLine(raw);
      if (line) lines.push(line); else dropped++;
    }
    return { id: layer.id, name: layer.name, lines };
  });
  return { space, layers: out, meta: { source: '', name: '', warnings: [], ...meta, dropped } };
}

// A new drawing based on the old one: other layers/space, metadata is preserved.
export function derive(drawing, { space = drawing.space, layers = drawing.layers, meta = {} } = {}) {
  return { space, layers, meta: { ...drawing.meta, ...meta } };
}

export function assertSpace(drawing, space, message) {
  if (drawing.space !== space) throw new DrawingError(message);
}

export function allLines(drawing) {
  return drawing.layers.flatMap((layer) => layer.lines);
}

export function bbox(drawing) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const layer of drawing.layers) {
    for (const l of layer.lines) {
      for (let i = 0; i < l.length; i += 2) {
        const x = l[i], y = l[i + 1];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x0 === Infinity ? null : { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function stats(drawing) {
  let lines = 0, points = 0, length = 0;
  for (const layer of drawing.layers) {
    for (const l of layer.lines) {
      lines++;
      points += pointCount(l);
      length += lineLength(l);
    }
  }
  return { lines, points, length, bbox: bbox(drawing) };
}

export const isPartial = (drawing) => !!drawing.meta.partial;
export const partialReasons = (drawing) => (drawing.meta.partial ? drawing.meta.partial.reasons : []);
