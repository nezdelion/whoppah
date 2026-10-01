// Firmware settings (M503, see parseFirmwareSettings in marlin-replies.js) and the profile: acceleration proposal,
// warnings and parameters for the time estimate. Pure functions, no DOM or network.
import { t } from '../i18n/index.js';

const min = (...v) => { const a = v.filter(Number.isFinite); return a.length ? Math.min(...a) : null; };
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Profile accelerations from firmware settings: moves without E use the travel acceleration (M204 T), each axis is limited by M201.
 * accelXY = min(T, X, Y), accelZ = min(T, Z); what is absent from the response is ignored; with no numbers at all — no field.
 * @returns {accelXY?: number, accelZ?: number} (at least 1, as in the profile)
 */
export function firmwareAccelSuggestion(fw) {
  const out = {};
  if (!fw) return out;
  const t = fw.accel ? fw.accel.travel : null, m = fw.maxAccel;
  const xy = min(t, m && m.x, m && m.y), z = min(t, m && m.z);
  if (xy !== null) out.accelXY = Math.max(1, round3(xy));
  if (z !== null) out.accelZ = Math.max(1, round3(z));
  return out;
}

/**
 * Warnings about the profile, calibration and firmware settings (non-blocking):
 * - feed: the profile feed is above the firmware M203 limit (XY — the smaller of X and Y, Z — M203 Z; mm/s × 60 = mm/min): the firmware will clamp it,
 *   the time estimate uses the limit feed;
 * - mesh: a mesh fade height is set (M420 Z > 0), "bed mesh at any height" is off, and the touch is above it — no compensation at the pen height.
 * @returns [{kind: 'feed'|'mesh', text}]
 */
export function firmwareWarnings(profile, calibration, fw) {
  if (!fw) return [];
  const out = [];
  const capXY = min(fw.maxFeed && fw.maxFeed.x, fw.maxFeed && fw.maxFeed.y), capZ = fw.maxFeed ? fw.maxFeed.z : null;
  const over = [];
  if (capXY !== null) {
    for (const key of ['fDraw', 'fTravel']) {
      if (profile[key] > capXY * 60 + 1e-6) over.push(t('firmware.overFeed', { name: t(`firmware.feed.${key}`), value: profile[key], axes: 'XY', cap: capXY, capMin: round3(capXY * 60) }));
    }
  }
  if (Number.isFinite(capZ)) {
    for (const key of ['fZUp', 'fZDown']) {
      if (profile[key] > capZ * 60 + 1e-6) over.push(t('firmware.overFeed', { name: t(`firmware.feed.${key}`), value: profile[key], axes: 'Z', cap: capZ, capMin: round3(capZ * 60) }));
    }
  }
  if (over.length) out.push({ kind: 'feed', text: t('firmware.feedWarning', { list: over.join('; ') }) });
  const fade = fw.meshFade, touch = calibration ? calibration.zTouch : null;
  if (Number.isFinite(fade) && fade > 0 && !profile.meshNoFade && Number.isFinite(touch) && touch > fade) {
    out.push({ kind: 'mesh', text: t('firmware.meshWarning', { fade, touch }) });
  }
  return out;
}

/**
 * estimateTime parameters from firmware settings; without settings — an empty object (the estimate is unchanged).
 * For XY the smaller of X and Y is taken (conservative), for Z — Z.
 */
export function firmwareEstimateOptions(fw) {
  const out = {};
  if (!fw) return out;
  const set = (key, v) => { if (v !== null && Number.isFinite(v)) out[key] = v; };
  if (fw.maxFeed) { set('maxFeedXY', min(fw.maxFeed.x, fw.maxFeed.y)); set('maxFeedZ', fw.maxFeed.z); }
  if (fw.jerk) { set('jerkXY', min(fw.jerk.x, fw.jerk.y)); set('jerkZ', fw.jerk.z); }
  return out;
}
