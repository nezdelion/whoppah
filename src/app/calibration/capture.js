// Calibration capture scenarios from the head position: corner, touch, confirming a part.
// Each result is { ok, message }; the calibration changes only after a successful write on the server.
import { cornerFromPosition, touchFromPosition } from '../../core/calibration.js';
import { t } from '../../i18n/index.js';

/** guard — (part) => {ok, message}: the "Not homed" guard (standalone); by default forbids nothing. */
export function createCalibrationCapture({ state, positionSource, monitor, guard = () => ({ ok: true, message: '' }) }) {
  let unsupported = false;
  const blocked = (part) => { const g = guard(part); return g.ok ? null : { ok: false, message: g.message }; };

  const fail = (e) => {
    if (e && e.kind === 'unsupported') unsupported = true;
    return { ok: false, message: e && e.message ? e.message : String(e) };
  };

  async function apply(doc, message) {
    state.adoptCalibration(doc);
    await monitor.refresh();
    return { ok: true, message };
  }

  return {
    /** The capture buttons are disabled when the server reported that the firmware does not know M118. */
    get unsupported() { return unsupported; },

    /** offset — pen offset relative to the sheet corner, mm (pen left of/below the corner is negative). */
    async captureCorner(offset = { x: 0, y: 0 }) {
      try {
        const b = blocked('xy'); if (b) return b;
        const pos = await positionSource.read();
        const { cornerX, cornerY } = cornerFromPosition(pos, offset);
        const doc = await positionSource.saveCorner({ x: cornerX, y: cornerY, epoch: pos.epochXY });
        return await apply(doc, t('calibration.captured.corner', { x: cornerX, y: cornerY }));
      } catch (e) { return fail(e); }
    },

    async captureTouch() {
      try {
        const b = blocked('z'); if (b) return b;
        const pos = await positionSource.read();
        const touch = touchFromPosition(pos);
        if (touch.error) return { ok: false, message: touch.error };
        const doc = await positionSource.saveTouch({ zTouch: touch.zTouch, epoch: pos.epochZ });
        return await apply(doc, t('calibration.captured.touch', { z: touch.zTouch }));
      } catch (e) { return fail(e); }
    },

    async confirm(part) {
      try {
        const b = blocked(part); if (b) return b;
        const doc = await positionSource.confirm(part);
        return await apply(doc, t(part === 'xy' ? 'calibration.confirmed.xy' : 'calibration.confirmed.z'));
      } catch (e) { return fail(e); }
    },
  };
}
