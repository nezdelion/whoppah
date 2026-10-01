// OctoPrint connection indicator: a colored dot (and, with text: true, a short label). Colors are --conn-* tokens in app.css.
import { h } from './dom.js';
import { t, getLocale } from '../../i18n/index.js';
import { STATUS_LABELS } from '../connection-monitor.js';

const time = (ms) => new Date(ms).toLocaleTimeString(getLocale());

/** Hint text and aria-label: the state label, details, and for failures the time of the last response. */
export function describeStatus(s) {
  if (s.status === 'ok' || s.status === 'printer-off' || s.status === 'checking' || s.status === 'unconfigured') return s.detail;
  let text = `OctoPrint: ${s.detail}`;
  if ((s.status === 'error' || s.status === 'auth') && s.lastOk) text += '; ' + t('conn.lastReply', { time: time(s.lastOk) });
  return text;
}

/**
 * @param monitor createConnectionMonitor
 * @param text    true — next to the dot a state label and a details line ("Connection" section)
 * @returns { element, destroy }
 */
export function createConnectionIndicator(monitor, { text = false } = {}) {
  const dot = h('span', { class: 'conn-dot', 'aria-hidden': 'true' });
  const label = text ? h('span', { class: 'conn-label' }) : null;
  const detail = text ? h('div', { class: 'conn-detail' }) : null;
  const badge = h('span', { class: `conn${text ? ' conn-full' : ''}`, role: text ? null : 'img' }, dot, label);
  const element = text ? h('div', { class: 'conn-block', role: 'status' }, badge, detail) : badge;

  const render = (s) => {
    const full = describeStatus(s);
    badge.dataset.status = s.status;
    badge.title = full;
    if (text) {
      label.textContent = STATUS_LABELS[s.status];
      detail.textContent = s.detail;
      element.setAttribute('aria-label', full);
    } else badge.setAttribute('aria-label', full);
  };
  render(monitor.status());
  const off = monitor.subscribe(render);
  return { element, destroy: off };
}
