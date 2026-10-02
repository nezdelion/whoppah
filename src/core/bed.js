// Bed rectangle and print area in nozzle coordinates. Pure functions, no DOM or transport.
// The bed corners are nozzle positions with the pen at the bed corner, so the pen offset is already inside them.
import { axisLimits, bedErrors } from './profile.js';
import { t, fmtNumber } from '../i18n/index.js';

/** How far a measured size may differ from the nominal one without a hint, mm. */
export const BED_HINT_MM = 5;

const round3 = (v) => Math.round(v * 1000) / 1000;
const fmtMm = (v) => fmtNumber(Math.round(v * 10) / 10, { minFrac: 1 });

export const bedNominal = (p) => ({ w: p.bedW, h: p.bedH });

/**
 * The measured bed {x0, y0, x1, y1} or null (not measured or invalid).
 * With bedUrNominal the upper right corner follows "lower left + nominal size" (a nominal edit moves it too).
 */
export function bedRect(p) {
  if (!p || p.bedX0 === null || p.bedX0 === undefined || bedErrors(p).length) return null;
  if (p.bedUrNominal) return { x0: p.bedX0, y0: p.bedY0, x1: round3(p.bedX0 + p.bedW), y1: round3(p.bedY0 + p.bedH) };
  return { x0: p.bedX0, y0: p.bedY0, x1: p.bedX1, y1: p.bedY1 };
}

/** Print area = axis limits ∩ bed; the bed not measured — the axis limits, bedMeasured false. */
export function printArea(p) {
  const l = axisLimits(p);
  const b = bedRect(p);
  if (!b) return { ...l, bedMeasured: false };
  return { x0: Math.max(l.x0, b.x0), y0: Math.max(l.y0, b.y0), x1: Math.min(l.x1, b.x1), y1: Math.min(l.y1, b.y1), bedMeasured: true };
}

/** How far rect goes beyond area on each side, mm (≥ 0). */
export function rectOverflow(rect, area) {
  return {
    left: Math.max(0, area.x0 - rect.x0),
    right: Math.max(0, rect.x1 - area.x1),
    bottom: Math.max(0, area.y0 - rect.y0),
    top: Math.max(0, rect.y1 - area.y1),
  };
}

export const SIDES = Object.freeze(['left', 'right', 'bottom', 'top']);
export const anyOver = (o) => !!o && SIDES.some((s) => o[s] > 1e-6);
export const sideText = (side) => t(`side.${side}`);
export { fmtMm };

export const insideRect = (pt, r) => pt.x >= r.x0 - 1e-9 && pt.x <= r.x1 + 1e-9 && pt.y >= r.y0 - 1e-9 && pt.y <= r.y1 + 1e-9;

/**
 * The bed from its points: the lower left corner is required; without the upper right one it is "lower left + nominal".
 * @returns {{ok: true, bed: {x0, y0, x1, y1}, urNominal: boolean} | {ok: false, message: string}}
 */
export function bedFromPoints(ll, ur, nominal) {
  if (!ll) return { ok: false, message: t('bed.err.llFirst') };
  const nominalUr = !ur;
  const x1 = nominalUr ? round3(ll.x + nominal.w) : ur.x, y1 = nominalUr ? round3(ll.y + nominal.h) : ur.y;
  const bed = { x0: ll.x, y0: ll.y, x1, y1 };
  if (!(bed.x0 < bed.x1 && bed.y0 < bed.y1)) return { ok: false, message: t('bed.err.degenerate') };
  return { ok: true, bed, urNominal: nominalUr };
}

/**
 * What the two bed points show: measured values, or the nominal prefill (X0 Y0 and X bedW Y bedH; lower left + nominal for the upper right).
 * @returns {{ measured: boolean, ll: {x, y, nominal}, ur: {x, y, nominal} }}
 */
export function bedPoints(p) {
  const b = bedRect(p);
  if (!b) return { measured: false, ll: { x: 0, y: 0, nominal: true }, ur: { x: p.bedW, y: p.bedH, nominal: true } };
  return { measured: true, ll: { x: b.x0, y: b.y0, nominal: false }, ur: { x: b.x1, y: b.y1, nominal: !!p.bedUrNominal } };
}

/**
 * Profile changes after setting one bed point ('ll' | 'ur'): the lower left keeps a measured upper right corner,
 * otherwise the upper right is nominal; the upper right needs the lower left first.
 * @returns {{ok: true, changes} | {ok: false, message}}
 */
export function applyBedPoint(p, which, point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, message: t('bed.err.point') };
  const cur = bedRect(p);
  const pt = { x: round3(point.x), y: round3(point.y) };
  let r;
  if (which === 'll') {
    const keepUr = cur && !p.bedUrNominal ? { x: cur.x1, y: cur.y1 } : null;
    r = bedFromPoints(pt, keepUr, bedNominal(p));
  } else if (which === 'ur') {
    r = cur ? bedFromPoints({ x: cur.x0, y: cur.y0 }, pt, bedNominal(p)) : bedFromPoints(null, pt, bedNominal(p));
  } else throw new Error(`unknown bed point: ${which}`);
  if (!r.ok) return r;
  return { ok: true, changes: { bedX0: r.bed.x0, bedY0: r.bed.y0, bedX1: r.bed.x1, bedY1: r.bed.y1, bedUrNominal: r.urNominal } };
}

/** Bed not measured: all four corner fields cleared. */
export const clearedBed = () => ({ bedX0: null, bedY0: null, bedX1: null, bedY1: null, bedUrNominal: false });

/**
 * Hints when the measured bed is larger than the nominal one by more than tol mm (the pen may leave the bed);
 * a smaller bed is just a cautious area and gives no hint. [] for a nominal upper right corner.
 */
export function bedHint(bed, nominal, tol = BED_HINT_MM, { urNominal = false } = {}) {
  if (!bed || urNominal) return [];
  const out = [];
  const dw = (bed.x1 - bed.x0) - nominal.w, dh = (bed.y1 - bed.y0) - nominal.h;
  if (dw > tol + 1e-9) out.push(t('bed.hint.width', { mm: fmtMm(dw) }));
  if (dh > tol + 1e-9) out.push(t('bed.hint.height', { mm: fmtMm(dh) }));
  return out;
}
