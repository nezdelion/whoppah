// Layout: drawing in document coordinates -> millimeters on paper -> printer coordinates.
import { SPACE, DrawingError, assertSpace, bbox, derive } from './drawing.js';
import { rectOverflow, SIDES, sideText } from './bed.js';
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

/**
 * Sheet against the print area (area — {x0, x1, y0, y1, bedMeasured?}; the bed not measured — the axis limits, per axis as before).
 * fitted — the drawing is fitted into the print area (the "Limit to print area" option): said once with the overflow.
 */
export function sheetWarnings(field, corner, area, { fitted = false } = {}) {
  const out = [];
  if (area.bedMeasured) {
    const o = rectOverflow({ x0: corner.x, y0: corner.y, x1: corner.x + field.w, y1: corner.y + field.h }, area);
    for (const side of SIDES) if (o[side] > 1e-6) out.push(t('warn.sheetOverArea', { side: sideText(side), mm: fmtMm(o[side]) }));
  } else {
    const o = sheetOverflow(field, corner, area);
    if (o.x > 1e-6) out.push(t('warn.sheetOverX', { mm: fmtMm(o.x) }));
    if (o.y > 1e-6) out.push(t('warn.sheetOverY', { mm: fmtMm(o.y) }));
  }
  if (out.length && fitted) out.push(t('warn.fittedToArea'));
  return out;
}

/** The margin rectangle in sheet coordinates (mm from the left near corner, Y up). */
export const marginRect = (field, margin) => ({ x0: margin, y0: margin, x1: field.w - margin, y1: field.h - margin });

/**
 * The fit rectangle: (field − margins) ∩ (area − corner), in sheet coordinates.
 * null — the area does not cut the margin rectangle (the layout is as without the option); {empty: true} — no intersection.
 */
export function fitRectFor(field, margin, corner, area) {
  const m = marginRect(field, margin);
  const r = {
    x0: Math.max(m.x0, area.x0 - corner.x), y0: Math.max(m.y0, area.y0 - corner.y),
    x1: Math.min(m.x1, area.x1 - corner.x), y1: Math.min(m.y1, area.y1 - corner.y),
  };
  if (r.x0 === m.x0 && r.y0 === m.y0 && r.x1 === m.x1 && r.y1 === m.y1) return null;
  if (!(r.x1 - r.x0 > 1e-6 && r.y1 - r.y0 > 1e-6)) return { empty: true };
  return r;
}

/**
 * @param opts { field:{w,h}, marginMm, halign, valign, rotate, asIs, corner:{x,y}, fitRect? }
 *   fitRect — the fit rectangle in sheet coordinates (mm from the left near corner, Y up) instead of the field minus margins;
 *   {empty: true} — the sheet field is outside the print area.
 * @returns Drawing in "machine" coordinates (mm, Y up); meta.layout stores the scale and parameters.
 */
export function layout(drawing, opts) {
  assertSpace(drawing, SPACE.DOCUMENT, 'layout expects a drawing in document coordinates');
  const b0 = bbox(drawing);
  if (!b0) throw new DrawingError(t('err.nothingToDraw'));
  const { field, marginMm: margin, corner, halign = 'center', valign = 'center', rotate = false, asIs = false, fitRect = null } = opts;
  if (!(field.w - 2 * margin > 0 && field.h - 2 * margin > 0)) throw new DrawingError(t('err.marginNoRoom'));
  if (fitRect && fitRect.empty) throw new DrawingError(t('err.fieldOutsideArea'));
  // without fitRect exactly the old arithmetic (G-code parity)
  const left = fitRect ? fitRect.x0 : margin, top = fitRect ? field.h - fitRect.y1 : margin;
  const aw = fitRect ? fitRect.x1 - fitRect.x0 : field.w - 2 * margin, ah = fitRect ? fitRect.y1 - fitRect.y0 : field.h - 2 * margin;

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
  const offX = left + (halign === 'left' ? 0 : halign === 'right' ? gx : gx / 2);
  const offTop = top + (valign === 'top' ? 0 : valign === 'bottom' ? gy : gy / 2);

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
      layout: { scale: s, sizeMm: size, field: { ...field }, marginMm: margin, corner: { ...corner }, fitRect: fitRect ? { ...fitRect } : null },
    },
  });
}
