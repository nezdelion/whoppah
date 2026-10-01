// Drawing -> SVG string. Printer coordinates do not go into the file: Y axis down, origin at the top left of the bounds.
import { SPACE, DrawingError, assertSpace, bbox } from './drawing.js';
import { t } from '../i18n/index.js';

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"';

const num = (v) => String(Number((Math.round(v * 10000) / 10000).toFixed(4)));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// (x, y) -> (x + ox, sy * y + oy)
function layerXml(layer, i, ox, oy, sy) {
  const paths = layer.lines.map((l) => {
    let d = '';
    for (let k = 0; k < l.length; k += 2) d += `${k ? 'L' : 'M'}${num(l[k] + ox)} ${num(sy * l[k + 1] + oy)}`;
    return `    <path d="${d}" fill="none" stroke="#000000" stroke-width="0.3"/>`;
  });
  const id = layer.id ? esc(layer.id) : `layer-${i + 1}`;
  return `  <g id="${id}" inkscape:groupmode="layer" inkscape:label="${esc(layer.name)}">\n${paths.join('\n')}\n  </g>`;
}

function svgDocument({ width, height, w, h, layers, ox, oy, sy }) {
  const body = layers.map((l, i) => layerXml(l, i, ox, oy, sy)).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg ${NS} width="${width}" height="${height}" viewBox="0 0 ${num(w)} ${num(h)}">\n${body}\n</svg>\n`;
}

/** SVG by drawing bounds; width/height in mm if the physical size is known. */
export function exportSvg(drawing) {
  const b = bbox(drawing);
  if (!b) throw new DrawingError(t('err.nothingToExport'));
  const machine = drawing.space === SPACE.MACHINE;
  const unitMm = machine ? 1 : drawing.meta.unitMm;
  const known = machine || unitMm > 0;
  const sy = machine ? -1 : 1;
  // after the flip the top of the bounds: machine — -y1, document — y0
  const top = machine ? -b.y1 : b.y0;
  return svgDocument({
    width: known ? `${num(b.w * unitMm)}mm` : num(b.w),
    height: known ? `${num(b.h * unitMm)}mm` : num(b.h),
    w: b.w, h: b.h, layers: drawing.layers, ox: -b.x0, oy: -top, sy,
  });
}

/** "As on paper" SVG: sheet size in mm, the drawing in its place; drawing — in machine coordinates. */
export function exportOnPaper(drawing, { field, corner }) {
  assertSpace(drawing, SPACE.MACHINE, 'SVG "as on paper" needs a layout to the field');
  return svgDocument({
    width: `${num(field.w)}mm`, height: `${num(field.h)}mm`, w: field.w, h: field.h,
    layers: drawing.layers, ox: -corner.x, oy: field.h + corner.y, sy: -1,
  });
}
