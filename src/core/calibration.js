// Calibration from the head position: the sheet corner from the position and pen offset, part freshness by coordinate epoch.
import { CALIBRATION_SCHEMA, validate } from './profile.js';
import { t } from '../i18n/index.js';

const round3 = (v) => Math.round(v * 1000) / 1000;

/** Calibration parts, each with its own printer coordinate epoch and the machine profile it was taken with. */
export const CALIBRATION_PARTS = Object.freeze({
  xy: { epochKey: 'epochXY', profileKey: 'profileXY', get label() { return t('calibration.part.xy'); } },
  z: { epochKey: 'epochZ', profileKey: 'profileZ', get label() { return t('calibration.part.z'); } },
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
  return errors.length ? { error: t('calibration.err.touchRange', { z: zTouch }) } : { zTouch };
}

/**
 * Why each part is outdated: 'epoch' — its epoch differs from the current printer coordinate epoch for that part
 * (sheet corner — the xy counter, touch — the z counter; G28 X Y does not affect the touch, G28 Z does not affect the corner),
 * 'profile' — it was taken with another machine profile (the pen holder is part of the profile; activeProfileId null — not compared).
 * A calibration without an epoch (entered before capture existed) is considered outdated.
 * @returns { xy: string[], z: string[] }
 */
export function staleReasons(calibration, currentEpochs, activeProfileId = null) {
  const out = {};
  for (const [part, { epochKey, profileKey }] of Object.entries(CALIBRATION_PARTS)) {
    out[part] = [];
    if (!(Number.isInteger(calibration[epochKey]) && calibration[epochKey] === currentEpochs[part])) out[part].push('epoch');
    if (activeProfileId != null && !profileMatches(calibration[profileKey], activeProfileId)) out[part].push('profile');
  }
  return out;
}

/**
 * Part freshness by epoch and (with activeProfileId) by profile, see staleReasons.
 * @param currentEpochs { xy: number, z: number }
 * @returns { xy: boolean, z: boolean, stale: string[] (labels of the outdated parts) }
 */
export function calibrationFreshness(calibration, currentEpochs, activeProfileId = null) {
  const reasons = staleReasons(calibration, currentEpochs, activeProfileId);
  const out = { stale: [] };
  for (const [part, { label }] of Object.entries(CALIBRATION_PARTS)) {
    out[part] = !reasons[part].length;
    if (!out[part]) out.stale.push(label);
  }
  return out;
}

/**
 * The part was taken with this profile. A part without a profile was taken before profiles existed: it belongs to the
 * profile created by the migration (which also stamps it), so it is not outdated because of the profile.
 */
export const profileMatches = (partProfile, activeProfileId) => partProfile == null || partProfile === activeProfileId;

/** Warning text: parts outdated because of the profile change, and the others (homing or reconnect). */
export function staleMessage(stale, reasons = null) {
  if (!stale.length) return '';
  if (!reasons) return t('calibration.stale', { parts: stale.join(', ') });
  const byProfile = [], byEpoch = [];
  for (const [part, { label }] of Object.entries(CALIBRATION_PARTS)) {
    const r = reasons[part] || [];
    if (r.includes('profile')) byProfile.push(label);
    else if (r.includes('epoch')) byEpoch.push(label);
  }
  const out = [];
  if (byProfile.length) out.push(t('calibration.staleProfile', { parts: byProfile.join(', ') }));
  if (byEpoch.length) out.push(t('calibration.stale', { parts: byEpoch.join(', ') }));
  return out.join(' ');
}
