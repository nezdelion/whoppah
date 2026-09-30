// Pre-send checks (preflight). Check = (ctx) => Promise<{level: 'ok'|'confirm'|'block', message}>.
// ctx = { drawing, plan, settings }
import { isPartial, partialReasons } from '../../core/drawing.js';

const ok = { level: 'ok', message: '' };

export async function limitsCheck({ plan }) {
  if (!plan.outOfLimits) return ok;
  const parts = [];
  if (plan.outOfLimits.x > 1e-6) parts.push(`выход за X на ${plan.outOfLimits.x.toFixed(1)} мм`);
  if (plan.outOfLimits.y > 1e-6) parts.push(`выход за Y на ${plan.outOfLimits.y.toFixed(1)} мм`);
  return { level: 'confirm', message: `Рисунок выходит за пределы осей: ${parts.join(', ')}.` };
}

export async function partialCheck({ drawing }) {
  if (!isPartial(drawing)) return ok;
  const reasons = partialReasons(drawing);
  return { level: 'confirm', message: `Рисунок промежуточный${reasons.length ? ': ' + reasons.join('; ') : ''}.` };
}

/** Before sending the coordinate epoch is checked anew, not relying on the page poll. */
export function calibrationFreshCheck(monitor) {
  return async (ctx = {}) => {
    await monitor.refresh(); // coordinate epoch; the plan values are already fixed by the snapshot, the estimate uses it
    const snap = ctx.settings && ctx.settings.calibration;
    // the poll could have accepted new coordinates after the snapshot: a plan on old ones must not be sent
    const now = monitor.currentCalibration && monitor.currentCalibration();
    if (snap && now && ['cornerX', 'cornerY', 'zTouch'].some((k) => snap[k] !== now[k])) {
      return { level: 'block', message: 'Калибровка изменилась во время подготовки — отправьте ещё раз.' };
    }
    const s = monitor.status(snap);
    return s.known && s.stale.length ? { level: 'confirm', message: s.message } : ok;
  };
}
