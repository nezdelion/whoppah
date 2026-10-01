// Jog panel: one step = read position → clamped calculation (core/jog.js) → G91/G0/G90 through the transport.
// Result { ok, message }. The position is read before every step: someone could have moved the head bypassing the app,
// and M400 in the read waits for previous moves. If not read — we do not move.
import { planJog } from '../../core/jog.js';
import { jogLines } from '../../core/gcode.js';
import { t } from '../../i18n/index.js';

const fmt = (v) => String(Math.round(v * 1000) / 1000);

/**
 * @param state          settings (profile and calibration are read at the moment of the step)
 * @param positionSource read() → {x, y, z, ...}
 * @param transport      command(lines); in standalone — a feed wrapper so that our own commands are not counted as foreign
 * @param guard          (part: 'xy'|'z') => {ok, message}; the "Not homed" guard
 */
export function createJog({ state, positionSource, transport, guard = () => ({ ok: true, message: '' }) }) {
  return {
    async move(axis, dir, step) {
      try {
        const g = guard(axis === 'z' ? 'z' : 'xy');
        if (!g.ok) return { ok: false, message: g.message };
        const position = await positionSource.read();
        const { profile, calibration } = state.settings();
        const plan = planJog({ axis, dir, step, position, profile, calibration });
        if (!plan.ok) return { ok: false, message: plan.message };
        await transport.command(jogLines(profile, axis, plan.delta));
        const A = axis.toUpperCase();
        return { ok: true, message: `${A}${plan.delta > 0 ? '+' : ''}${fmt(plan.delta)} → ${A}${fmt(plan.target)}${plan.clamped ? t('jog.clamped') : ''}` };
      } catch (e) {
        return { ok: false, message: e && e.message ? e.message : String(e) };
      }
    },
  };
}
