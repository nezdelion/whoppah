// Mapping of the old core.js parameters (flat object) to the new settings sections. An implementation independent of the migration.
import { normalizeProfile, normalizeCalibration, normalizeJob } from '../../src/core/profile.js';

const Z_TOUCH = 8;

export function legacyToSettings(o = {}) {
  const L = { fieldW: 180, fieldH: 180, margin: 5, halign: 'center', valign: 'center', rotate: false,
    cornerX: -5, cornerY: 50, zDown: 7.3, zUp: 10, zStart: 15, zEnd: 25,
    fDraw: 3000, fTravel: 6000, fZUp: 1200, fZDown: 600, home: false, motorsOff: true, mergeTol: 0.05,
    limX0: -5, limX1: 230, limY0: 0, limY1: 230, ...o };
  const r = (v) => Math.round(v * 1000) / 1000;
  return {
    profile: normalizeProfile({
      zDownOffset: r(L.zDown - Z_TOUCH), zUpOffset: r(L.zUp - Z_TOUCH), zStartOffset: r(L.zStart - Z_TOUCH), zEndOffset: r(L.zEnd - Z_TOUCH),
      fDraw: L.fDraw, fTravel: L.fTravel, fZUp: L.fZUp, fZDown: L.fZDown, home: L.home, motorsOff: L.motorsOff,
      limX0: L.limX0, limX1: L.limX1, limY0: L.limY0, limY1: L.limY1,
    }),
    calibration: normalizeCalibration({ cornerX: L.cornerX, cornerY: L.cornerY, zTouch: Z_TOUCH }),
    job: normalizeJob({
      paperId: 'legacy', orientation: L.fieldW > L.fieldH ? 'landscape' : 'portrait',
      customFormats: [{ id: 'legacy', name: 'legacy', w: L.fieldW, h: L.fieldH }],
      marginMm: L.margin, halign: L.halign, valign: L.valign, rotate: L.rotate, mergeTolMm: L.mergeTol, simplifyTolMm: 0,
    }),
  };
}
