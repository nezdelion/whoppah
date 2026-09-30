// Calibration capture and jog panel assembly: exists only when a position source is present (plugin or standalone feed).
import { createCalibrationMonitor } from './monitor.js';
import { createCalibrationCapture } from './capture.js';
import { createJog } from './jog.js';
import { createGuard, guardState, guardHint } from './guard.js';
import { calibrationFreshCheck } from '../print/checks.js';

/**
 * @param standalone true — the app stores the calibration (own storage), a fresh document is not requested from the server
 * @param transport  for the jog panel (command); without it there is no jog panel
 * @returns null without a position source; otherwise { calibrator: { monitor, capture, jog, guard, link }, check, beforePlan }
 *   guard(part) — the "Not homed" guard check; link() — { xy, z, hint } for the buttons and hint, subscribeLink(fn) — their updates
 */
export function setupCalibration({ positionSource, state, store, visibility, timers, standalone = false, transport = null }) {
  if (!positionSource) return null;
  const guard = createGuard(positionSource);
  const monitor = createCalibrationMonitor({
    state, positionSource, loadCalibration: standalone ? null : () => store.load('calibration'), visibility, timers,
  });
  const capture = createCalibrationCapture({ state, positionSource, monitor, guard });
  const jog = transport ? createJog({ state, positionSource, transport, guard }) : null;
  const link = () => { const g = guardState(positionSource.link ? positionSource.link() : null); return { xy: g.xy, z: g.z, hint: guardHint(g), homeMissing: g.homeMissing }; };
  monitor.start();
  // beforePlan: refresh the calibration before building the plan; check compares the already obtained epoch with the plan snapshot
  return {
    calibrator: { monitor, capture, jog, guard, link, markHomed: positionSource.markHomed ? () => positionSource.markHomed() : null, subscribeLink: (fn) => (positionSource.onChange ? positionSource.onChange(fn) : () => {}) },
    check: calibrationFreshCheck(monitor), beforePlan: monitor.refresh,
  };
}
