// Calibration freshness: polling the printer's coordinate epoch while the page is visible, and checking on demand.
// Part epochs (epochXY/epochZ) live in the calibration (written by the plugin server); here they are only compared with the current ones (the corner and touch have separate counters).
import { calibrationFreshness, staleMessage } from '../../core/calibration.js';

export const POLL_MS = 5000;

/**
 * @param loadCalibration () => Promise<doc|null> — a fresh document from the server (epochs could have changed by a capture in another tab)
 * @param timers          { setInterval, clearInterval } — replaced in tests
 * @param visibility      { visible(): boolean, subscribe(fn): unsubscribe } — page visibility
 */
export function createCalibrationMonitor({
  state, positionSource, loadCalibration,
  timers = { setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (id) => globalThis.clearInterval(id) },
  visibility = { visible: () => true, subscribe: () => () => {} },
}) {
  let epochs = null; // current coordinate epochs { xy, z } from the last successful poll
  let timer = null, unsubscribe = () => {}, offState = () => {}, running = false, inflight = null;
  const listeners = new Set();

  const status = (calibration = state.get('calibration')) => {
    if (epochs === null) return { known: false, xy: true, z: true, stale: [], message: '' };
    const f = calibrationFreshness(calibration, epochs);
    return { known: true, ...f, message: staleMessage(f.stale) };
  };
  const emit = () => { const s = status(); for (const fn of [...listeners]) fn(s); };

  async function doRefresh() {
    try {
      const [next, doc] = await Promise.all([positionSource.epoch(), loadCalibration ? loadCalibration().catch(() => null) : null]);
      if (doc) state.adoptCalibration(doc, { merge: true });
      epochs = next;
    } catch (e) {
      // no connection: the previous state stays, no warning is invented
    }
    emit();
    return status();
  }

  // Concurrent requests share one poll.
  const refresh = () => (inflight ||= doRefresh().finally(() => { inflight = null; }));

  const onChange = () => {
    if (visibility.visible()) { refresh(); arm(); } else disarm();
  };
  function arm() { if (running && !timer) timer = timers.setInterval(refresh, POLL_MS); }
  function disarm() { if (timer) { timers.clearInterval(timer); timer = null; } }

  return {
    /** calibration — the snapshot to evaluate freshness against (the current calibration by default). */
    status,
    /** The calibration in the state now (after a poll) — to compare with the snapshot the plan was built from. */
    currentCalibration: () => state.get('calibration'),
    /** A fresh check before sending: first the request, then the state. */
    refresh,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      if (running) return;
      running = true;
      unsubscribe = visibility.subscribe(onChange);
      if (visibility.visible()) { refresh(); arm(); }
      // calibration changes (input, capture, confirmation) also change the freshness state
      offState = state.subscribe((e) => {
        if (e.type === 'saved' && e.section === 'calibration') refresh();
        else if (e.type === 'settings' && (e.section === 'calibration' || e.section === '*')) emit();
      });
    },
    stop() {
      running = false;
      disarm();
      unsubscribe();
      offState();
    },
  };
}
