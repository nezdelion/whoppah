// Pre-send checks (preflight). Check = (ctx) => Promise<{level: 'ok'|'confirm'|'block', message}>.
// ctx = { drawing, plan, settings }
import { isPartial, partialReasons } from '../../core/drawing.js';
import { t, fmtNumber } from '../../i18n/index.js';
import { reasonText } from '../photo/layer-stack.js';

const ok = { level: 'ok', message: '' };

export async function limitsCheck({ plan }) {
  if (!plan.outOfLimits) return ok;
  const parts = [];
  if (plan.outOfLimits.x > 1e-6) parts.push(t('warn.overX', { mm: fmtNumber(plan.outOfLimits.x, { minFrac: 1 }) }));
  if (plan.outOfLimits.y > 1e-6) parts.push(t('warn.overY', { mm: fmtNumber(plan.outOfLimits.y, { minFrac: 1 }) }));
  return { level: 'confirm', message: t('check.outOfLimits', { parts: parts.join(', ') }) };
}

export async function partialCheck({ drawing }) {
  if (!isPartial(drawing)) return ok;
  const reasons = partialReasons(drawing);
  return { level: 'confirm', message: reasons.length ? t('check.partialWith', { reasons: reasons.map(reasonText).join('; ') }) : t('check.partial') };
}

/** Before sending the coordinate epoch is checked anew, not relying on the page poll. */
export function calibrationFreshCheck(monitor) {
  return async (ctx = {}) => {
    await monitor.refresh(); // coordinate epoch; the plan values are already fixed by the snapshot, the estimate uses it
    const snap = ctx.settings && ctx.settings.calibration;
    // the poll could have accepted new coordinates after the snapshot: a plan on old ones must not be sent
    const now = monitor.currentCalibration && monitor.currentCalibration();
    if (snap && now && ['cornerX', 'cornerY', 'zTouch'].some((k) => snap[k] !== now[k])) {
      return { level: 'block', message: t('check.calibrationChanged') };
    }
    const s = monitor.status(snap);
    return s.known && s.stale.length ? { level: 'confirm', message: s.message } : ok;
  };
}
