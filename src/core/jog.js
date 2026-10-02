// Pen jog panel: computing one step clamped to the limits. Pure functions, no DOM or transport.
import { axisLimits, absoluteZ } from './profile.js';
import { bedRect, printArea, insideRect } from './bed.js';
import { meshLines } from './gcode.js';
import { t } from '../i18n/index.js';

export const JOG_STEPS = Object.freeze([0.1, 1, 10]);
/** How far below the touch (zTouch) the nozzle may be lowered by jog steps, mm: a margin for touch inaccuracy, no more. */
export const JOG_Z_MARGIN = 2;
/** Z ceiling for the jog panel, mm (same as the max of the zTouch field in the calibration). */
export const JOG_Z_MAX = 300;

const EPS = 0.0005; // finer than the G-code precision (3 digits): such a shift is not sent
const round3 = (v) => Math.round(v * 1000) / 1000;
const fz = (v) => String(Number(v.toFixed(3)));

const touchOf = (calibration) => (Number.isFinite(calibration && calibration.zTouch) ? calibration.zTouch : 0);

/** The pen may be down: Z unknown or below touch + clearance. */
export const penMayBeDown = (position, profile, calibration) =>
  !Number.isFinite(position && position.z) || position.z < touchOf(calibration) + profile.zClearanceMm - EPS;

/**
 * Allowed axis range [lo, hi]: X/Y — the profile limits; Z — from max(0, zTouch − JOG_Z_MARGIN) to JOG_Z_MAX.
 * The lower Z bound is tied to the touch from the calibration regardless of its "freshness": lower — only by editing the touch itself.
 * With a measured bed (position — the read head position): X/Y are clamped by the print area while the pen may be down,
 * and over a point off the bed Z stays at touch + clearance or higher.
 */
export function jogRange(axis, profile, calibration, position = null) {
  const l = axisLimits(profile);
  const bed = bedRect(profile);
  if (axis === 'x' || axis === 'y') {
    const r = bed && penMayBeDown(position, profile, calibration) ? printArea(profile) : l;
    return axis === 'x' ? [r.x0, r.x1] : [r.y0, r.y1];
  }
  if (axis === 'z') {
    const zt = touchOf(calibration);
    const offBed = bed && position && Number.isFinite(position.x) && Number.isFinite(position.y) && !insideRect(position, bed);
    return [offBed ? round3(zt + profile.zClearanceMm) : Math.max(0, zt - JOG_Z_MARGIN), JOG_Z_MAX];
  }
  throw new Error(`unknown axis: ${axis}`);
}

/**
 * One step from the read position.
 * dir ±1, step mm (> 0). The shift is shortened to the limit; if the head is already at or beyond the limit and the step leads further — refuse.
 * The shift magnitude is at most the step and always in the pressed direction (we do not go outward because of a limit; we return toward the limit by a step as usual).
 * @returns {{ok: true, delta: number, target: number, clamped: boolean} | {ok: false, message: string}}
 */
export function planJog({ axis, dir, step, position, profile, calibration }) {
  const pos = position && position[axis];
  if (!Number.isFinite(pos)) return { ok: false, message: t('jog.err.position') };
  if (!(step > 0) || (dir !== 1 && dir !== -1)) return { ok: false, message: t('jog.err.step') };
  const [lo, hi] = jogRange(axis, profile, calibration, position);
  const want = pos + dir * step;
  const target = dir > 0 ? Math.min(want, hi) : Math.max(want, lo);
  const delta = round3(target - pos);
  if (delta * dir < EPS) return { ok: false, message: t('jog.err.limit', { axis: axis.toUpperCase() }) };
  return { ok: true, delta, target: round3(target), clamped: Math.abs(delta) < step - EPS };
}

/**
 * "Go to": brings the pen over a point to check it by eye. The point is in nozzle coordinates, only within the axis limits.
 * G90 (+ mesh), a lift to the start height if Z is below it or unknown, X/Y at fTravel, and with a fresh touch
 * lowering to touch + clearance (never lower).
 * @param touchFresh the touch part is set and fresh (by epoch and by profile)
 * @returns {{ok: true, lines: string[]} | {ok: false, message: string}}
 */
export function planGoTo({ point, position, profile, calibration, touchFresh }) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, message: t('bed.err.point') };
  const l = axisLimits(profile);
  if (point.x < l.x0 - EPS || point.x > l.x1 + EPS || point.y < l.y0 - EPS || point.y > l.y1 + EPS) return { ok: false, message: t('goto.err.outOfLimits') };
  const z = absoluteZ(profile, calibration);
  const lines = ['G90', ...meshLines(profile)];
  if (!Number.isFinite(position && position.z) || position.z < z.start - EPS) lines.push(`G0 Z${fz(z.start)} F${profile.fZUp}`);
  lines.push(`G0 X${fz(point.x)} Y${fz(point.y)} F${profile.fTravel}`);
  if (touchFresh) lines.push(`G0 Z${fz(z.clearance)} F${profile.fZDown}`);
  return { ok: true, lines };
}
