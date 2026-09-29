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
