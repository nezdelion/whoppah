// The printer connection feed state next to the connection indicator ("Connection", standalone only):
// a dot and state label, the reason, a button to read the firmware limits (M211) and a warning about the profile limits.
import { h } from './dom.js';
import { FEED_LABELS } from '../../transport/octoprint-feed.js';
import { createLimitsMemo } from './feed-limits.js';
import { limitsWarnings, limitsWarningText } from '../../core/marlin-replies.js';

// feed states → data-status values from app.css (--conn-*)
const DOT = { off: 'unconfigured', connecting: 'checking', live: 'ok', forbidden: 'auth', unavailable: 'error' };
const NEEDS_FEED = 'нужен поток связи с принтером (состояние «на связи»)';

const axisRange = (l, a) => `${a.toUpperCase()} ${l.min[a]}…${l.max[a]}`;

/**
 * @param feed        PrinterFeed
 * @param getProfile  () => machine profile (limits limX0…limY1)
 * @param onProfile   (fn) => unsubscribe — the profile changed
 * @returns { element, destroy }
 */
export function createFeedIndicator(feed, { getProfile, onProfile }) {
  const memo = createLimitsMemo(feed);
  let message = '', busy = false;
  const dot = h('span', { class: 'conn-dot', 'aria-hidden': 'true' });
  const label = h('span', { class: 'conn-label' });
  const badge = h('span', { class: 'conn conn-full' }, dot, label);
  const detail = h('div', { class: 'conn-detail' });
  const info = h('div', { class: 'conn-detail' });
  const warn = h('div', { class: 'warn', role: 'status' });
  const button = h('button', { type: 'button', onclick: readLimits }, 'Прочитать границы прошивки');
  const element = h('div', { class: 'conn-block feed-block', role: 'status' },
    h('div', { class: 'conn-detail' }, 'Поток связи с принтером'), badge, detail, h('div', { class: 'row' }, button), info, warn);

  async function readLimits() {
    busy = true; message = 'читаю границы прошивки (M211)…'; render();
    try {
      message = await memo.read() ? '' : 'Поток переподключился во время чтения — прочитайте границы снова';
    } catch (e) {
      message = `Не удалось прочитать границы: ${e.message}`;
    }
    busy = false;
    render();
  }

  function render() {
    const s = feed.state();
    const limits = memo.get(); // a stale result (drop, reconnect, address change) is reset
    badge.dataset.status = DOT[s];
    label.textContent = FEED_LABELS[s];
    detail.textContent = feed.detail();
    element.setAttribute('aria-label', `Поток связи с принтером: ${FEED_LABELS[s]}. ${feed.detail()}`);
    button.disabled = s !== 'live' || busy;
    button.title = s === 'live' ? '' : NEEDS_FEED;
    if (!limits) info.textContent = message;
    else info.textContent = `Границы прошивки: ${limits.enabled ? '' : 'выключены; '}${axisRange(limits, 'x')}, ${axisRange(limits, 'y')}, ${axisRange(limits, 'z')}`;
    warn.textContent = limits ? limitsWarningText(limitsWarnings(getProfile(), limits)) : '';
    warn.hidden = !warn.textContent;
  }
  render();
  const off = [feed.onChange(render), onProfile(render)];
  return { element, destroy: () => off.forEach((f) => f()) };
}
