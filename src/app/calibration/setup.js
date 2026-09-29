// Calibration capture assembly: exists only when a position source is present (plugin mode).
import { createCalibrationMonitor } from './monitor.js';
import { createCalibrationCapture } from './capture.js';
import { calibrationFreshCheck } from '../print/checks.js';

/** @returns null without a position source; otherwise { calibrator: { monitor, capture }, check } — check is added to the print checks */
export function setupCalibration({ positionSource, state, store, visibility, timers }) {
  if (!positionSource) return null;
  const monitor = createCalibrationMonitor({ state, positionSource, loadCalibration: () => store.load('calibration'), visibility, timers });
  const capture = createCalibrationCapture({ state, positionSource, monitor });
  monitor.start();
  return { calibrator: { monitor, capture }, check: calibrationFreshCheck(monitor) };
}
