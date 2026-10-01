// Layout: drawing in document coordinates -> millimeters on paper -> printer coordinates.
import { SPACE, DrawingError, assertSpace, bbox, derive } from './drawing.js';
import { t, fmtNumber } from '../i18n/index.js';

export const PAPER_FORMATS = Object.freeze([
  { id: 'a6', name: 'A6', w: 105, h: 148 },
  { id: 'a5', name: 'A5', w: 148, h: 210 },
  { id: 'a4', name: 'A4', w: 210, h: 297 },
  { id: 'letter', name: 'Letter', w: 215.9, h: 279.4 },
]);

export const DEFAULT_FIELD = Object.freeze({ w: 180, h: 180 });

/** Field sizes by format (built-in or custom) and orientation; an unknown format — the work area. */
export function resolveField({ paperId, orientation = 'portrait', customFormats = [] }) {
  const fmt = [...PAPER_FORMATS, ...customFormats].find((f) => f.id === paperId);
  if (!fmt) return { ...DEFAULT_FIELD };
  const lo = Math.min(fmt.w, fmt.h), hi = Math.max(fmt.w, fmt.h);
  return orientation === 'landscape' ? { w: hi, h: lo } : { w: lo, h: hi };
}

const fmtMm = (v) => fmtNumber(Math.round(v * 10) / 10, { minFrac: 1 });

/** Paper format label: the built-in "work area" and a transferred format are named from the dictionary, the others by name. */
export const paperLabel = (p) => (p.id === 'work' || p.id === 'migrated' ? t(`paper.${p.id}`) : p.name);

/** How far the sheet (left near corner at corner) exceeds the axis limits, mm; 0 — does not exceed. */
export function sheetOverflow(field, corner, limits) {
  return {
    x: Math.max(0, limits.x0 - corner.x, corner.x + field.w - limits.x1),
    y: Math.max(0, limits.y0 - corner.y, corner.y + field.h - limits.y1),
  };
}

export function sheetWarnings(field, corner, limits) {
  const o = sheetOverflow(field, corner, limits);
  const out = [];
  if (o.x > 1e-6) out.push(t('warn.sheetOverX', { mm: fmtMm(o.x) }));
  if (o.y > 1e-6) out.push(t('warn.sheetOverY', { mm: fmtMm(o.y) }));
  return out;
}

/**
 * @param opts { field:{w,h}, marginMm, halign, valign, rotate, asIs, corner:{x,y} }
 * @returns Drawing in "machine" coordinates (mm, Y up); meta.layout stores the scale and parameters.
 */
export function layout(drawing, opts) {
  assertSpace(drawing, SPACE.DOCUMENT, 'layout expects a drawing in document coordinates');
  const b0 = bbox(drawing);
  if (!b0) throw new DrawingError(t('err.nothingToDraw'));
  const { field, marginMm: margin, corner, halign = 'center', valign = 'center', rotate = false, asIs = false } = opts;
  const aw = field.w - 2 * margin, ah = field.h - 2 * margin;
  if (!(aw > 0 && ah > 0)) throw new DrawingError(t('err.marginNoRoom'));

  // rotation by 90°: (x, y) -> (-y, x)
  const b = rotate ? { x0: -b0.y1, y0: b0.x0, w: b0.h, h: b0.w } : b0;
  const warnings = [];
  let s;
  if (asIs) {
    s = drawing.meta.unitMm;
    if (!(s > 0)) throw new DrawingError(t('err.sizeUnknown'));
    if (b.w * s > aw + 1e-9 || b.h * s > ah + 1e-9) warnings.push(t('warn.drawingTooBig'));
  } else {
    s = Math.min(b.w > 0 ? aw / b.w : Infinity, b.h > 0 ? ah / b.h : Infinity);
  }

  const gx = aw - b.w * s, gy = ah - b.h * s;
  const offX = margin + (halign === 'left' ? 0 : halign === 'right' ? gx : gx / 2);
  const offTop = margin + (valign === 'top' ? 0 : valign === 'bottom' ? gy : gy / 2);

  const layers = drawing.layers.map((layer) => ({
    ...layer,
    lines: layer.lines.map((l) => {
      const out = new Array(l.length);
      for (let i = 0; i < l.length; i += 2) {
        const x = rotate ? -l[i + 1] : l[i], y = rotate ? l[i] : l[i + 1];
        out[i] = corner.x + offX + (x - b.x0) * s;
        out[i + 1] = corner.y + field.h - (offTop + (y - b.y0) * s);
      }
      return out;
    }),
  }));

  const size = [b.w * s, b.h * s];
  return derive(drawing, {
    space: SPACE.MACHINE,
    layers,
    meta: {
      unitMm: 1,
      physicalSize: { w: size[0], h: size[1] },
      warnings: [...drawing.meta.warnings, ...warnings],
      layout: { scale: s, sizeMm: size, field: { ...field }, marginMm: margin, corner: { ...corner } },
    },
  });
}
