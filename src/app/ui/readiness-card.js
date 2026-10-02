// "Ready to print": one row per item (connection in standalone, pen area, sheet corner, touch) with a state and "Set up".
import { h, button } from './dom.js';
import { readiness } from '../../core/readiness.js';
import { t, fmtNumber } from '../../i18n/index.js';

const fmt1 = (v) => fmtNumber(Math.round(v * 10) / 10); // 204 × 230, 204,5 × 230

function valueText(item) {
  const v = item.value;
  if (!v) return '';
  if (item.id === 'area') return v.mode === 'none' ? '' : t('ready.areaValue', { w: fmt1(v.w), h: fmt1(v.h) });
  if (item.id === 'corner') return t('ready.cornerValue', { x: v.x, y: v.y });
  if (item.id === 'touch') return t('ready.touchValue', { z: v.z });
  return '';
}

/**
 * @param state       settings state
 * @param calibrator  { monitor } or null (freshness unknown)
 * @param connection  the connection monitor (standalone) or null (plugin: the item is not shown)
 * @param onSetup     (stepId | undefined) => void — opens the wizard
 * @returns {{ element, refresh(), destroy() }}
 */
export function createReadinessCard({ state, calibrator = null, connection = null, onSetup }) {
  const rows = h('div', { class: 'readiness' });
  const run = button({ label: t('ready.run'), hint: 'ready.run.hint', class: 'primary', onclick: () => onSetup() });
  const element = h('div', { class: 'card ready-card' }, h('h2', {}, t('ready.title')), rows, h('div', { class: 'row' }, run));
  const off = [];

  function compute() {
    const s = state.settings();
    let fresh = null;
    if (calibrator && calibrator.monitor) { const m = calibrator.monitor.status(); fresh = m.known ? { xy: m.xy, z: m.z } : null; }
    const connected = connection ? ['ok', 'printer-off'].includes(connection.status().status) : null;
    return readiness({ profile: s.profile, calibration: s.calibration, fresh, connected });
  }

  function refresh() {
    const r = compute();
    rows.replaceChildren(...r.items.map((item) => h('div', { class: 'ready-row', 'data-state': item.state, 'data-item': item.id },
      h('span', { class: 'ready-mark', 'aria-hidden': 'true' }, item.state === 'ok' ? '✓' : item.state === 'stale' ? '!' : '○'),
      h('span', { class: 'ready-label' }, t(`ready.${item.id}`)),
      h('span', { class: 'ready-value' }, valueText(item) || t(`ready.state.${item.state}`)),
      button({ label: t('ready.setup'), hint: 'ready.setup.hint', class: 'small', onclick: () => onSetup(item.id) }))));
    element.dataset.ready = r.ready ? '1' : '';
  }

  refresh();
  off.push(state.subscribe((e) => { if (e.type === 'settings') refresh(); }));
  if (calibrator && calibrator.monitor) off.push(calibrator.monitor.subscribe(refresh));
  if (connection) off.push(connection.subscribe(refresh));
  return { element, refresh, destroy() { for (const fn of off.splice(0)) fn(); } };
}
