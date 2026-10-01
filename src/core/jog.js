// Pen jog panel: computing one step clamped to the limits. Pure functions, no DOM or transport.
import { axisLimits } from './profile.js';
import { t } from '../i18n/index.js';

export const JOG_STEPS = Object.freeze([0.1, 1, 10]);
/** How far below the touch (zTouch) the nozzle may be lowered by jog steps, mm: a margin for touch inaccuracy, no more. */
export const JOG_Z_MARGIN = 2;
/** Z ceiling for the jog panel, mm (same as the max of the zTouch field in the calibration). */
export const JOG_Z_MAX = 300;

const EPS = 0.0005; // finer than the G-code precision (3 digits): such a shift is not sent
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Allowed axis range [lo, hi]: X/Y — the profile limits; Z — from max(0, zTouch − JOG_Z_MARGIN) to JOG_Z_MAX.
 * The lower Z bound is tied to the touch from the calibration regardless of its "freshness": lower — only by editing the touch itself.
 */
export function jogRange(axis, profile, calibration) {
  const l = axisLimits(profile);
  if (axis === 'x') return [l.x0, l.x1];
  if (axis === 'y') return [l.y0, l.y1];
  if (axis === 'z') {
    const zt = Number.isFinite(calibration && calibration.zTouch) ? calibration.zTouch : 0;
    return [Math.max(0, zt - JOG_Z_MARGIN), JOG_Z_MAX];
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
  const [lo, hi] = jogRange(axis, profile, calibration);
  const want = pos + dir * step;
  const target = dir > 0 ? Math.min(want, hi) : Math.max(want, lo);
  const delta = round3(target - pos);
  if (delta * dir < EPS) return { ok: false, message: t('jog.err.limit', { axis: axis.toUpperCase() }) };
  return { ok: true, delta, target: round3(target), clamped: Math.abs(delta) < step - EPS };
}
