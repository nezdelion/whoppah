// Calibration from the head position: the sheet corner from the position and pen offset, part freshness by coordinate epoch.
import { CALIBRATION_SCHEMA, validate } from './profile.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

/** Calibration parts, each with its own printer coordinate epoch. */
export const CALIBRATION_PARTS = Object.freeze({
  xy: { epochKey: 'epochXY', label: 'угол листа' },
  z: { epochKey: 'epochZ', label: 'касание' },
});

/**
 * Sheet corner = head position − pen offset relative to the corner.
 * Pen at X−15 Y40 with offset −10/−10 (pen outside the sheet) gives corner X−5 Y50.
 */
export function cornerFromPosition(position, offset = { x: 0, y: 0 }) {
  return { cornerX: round3(position.x - offset.x), cornerY: round3(position.y - offset.y) };
}

/** Check of the captured touch against the calibration schema: { zTouch } or { error }. */
export function touchFromPosition(position) {
  const zTouch = round3(position.z);
  const errors = validate(CALIBRATION_SCHEMA.filter((f) => f.key === 'zTouch'), { zTouch });
  return errors.length ? { error: `Z${zTouch} вне допустимого диапазона калибровки` } : { zTouch };
}

/**
 * Part freshness: a part is fresh if its epoch equals the current printer coordinate epoch.
 * A calibration without an epoch (entered before capture existed) is considered outdated.
 * @returns { xy: boolean, z: boolean, stale: string[] (labels of the outdated parts) }
 */
export function calibrationFreshness(calibration, currentEpoch) {
  const out = { stale: [] };
  for (const [part, { epochKey, label }] of Object.entries(CALIBRATION_PARTS)) {
    out[part] = Number.isInteger(calibration[epochKey]) && calibration[epochKey] === currentEpoch;
    if (!out[part]) out.stale.push(label);
  }
  return out;
}

export function staleMessage(stale) {
  return stale.length ? `Калибровка могла устареть: ${stale.join(', ')} (после хоминга или переподключения принтера).` : '';
}
