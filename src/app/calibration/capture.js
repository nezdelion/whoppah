// Calibration capture scenarios from the head position: corner, touch, confirming a part.
// Each result is { ok, message }; the calibration changes only after a successful write on the server.
import { cornerFromPosition, touchFromPosition } from '../../core/calibration.js';

export function createCalibrationCapture({ state, positionSource, monitor }) {
  let unsupported = false;

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
        const pos = await positionSource.read();
        const { cornerX, cornerY } = cornerFromPosition(pos, offset);
        const doc = await positionSource.saveCorner({ x: cornerX, y: cornerY, epoch: pos.epoch });
        return await apply(doc, `Угол листа: X${cornerX} Y${cornerY}`);
      } catch (e) { return fail(e); }
    },

    async captureTouch() {
      try {
        const pos = await positionSource.read();
        const t = touchFromPosition(pos);
        if (t.error) return { ok: false, message: t.error };
        const doc = await positionSource.saveTouch({ zTouch: t.zTouch, epoch: pos.epoch });
        return await apply(doc, `Касание: Z${t.zTouch}`);
      } catch (e) { return fail(e); }
    },

    async confirm(part) {
      try {
        const doc = await positionSource.confirm(part);
        return await apply(doc, part === 'xy' ? 'Угол листа подтверждён' : 'Касание подтверждено');
      } catch (e) { return fail(e); }
    },
  };
}
