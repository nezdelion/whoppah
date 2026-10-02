// Readiness for printing: what is set, fresh or missing. Pure data in, items out; the UI shows them.
import { areaStatus } from './bed.js';

export const READY_ITEMS = Object.freeze(['connection', 'area', 'corner', 'touch']);

const partState = (set, fresh, part) => {
  if (!set) return 'todo';
  if (!fresh) return 'unknown';
  return fresh[part] === false ? 'stale' : 'ok';
};

/**
 * @param fresh     { xy: boolean, z: boolean } from the calibration monitor, or null (no position monitor: 'unknown')
 * @param connected true/false (standalone: the OctoPrint link), or null (plugin: the item is not shown)
 * @returns {{ items: Array<{id, state: 'ok'|'todo'|'stale'|'unknown', value}>, ready: boolean }}
 */
export function readiness({ profile, calibration, fresh = null, connected = null }) {
  const items = [];
  if (connected !== null) items.push({ id: 'connection', state: connected ? 'ok' : 'todo', value: null });
  const a = areaStatus(profile);
  items.push({ id: 'area', state: a.mode === 'none' ? 'todo' : a.empty ? 'stale' : 'ok', value: a });
  const set = !!(calibration && calibration.updatedAt);
  items.push({ id: 'corner', state: partState(set, fresh, 'xy'), value: set ? { x: calibration.cornerX, y: calibration.cornerY } : null });
  items.push({ id: 'touch', state: partState(set, fresh, 'z'), value: set ? { z: calibration.zTouch } : null });
  return { items, ready: items.every((i) => i.state === 'ok') };
}
