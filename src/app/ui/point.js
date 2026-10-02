// The "Point" control: a point in nozzle coordinates (sheet corner, bed corners, future ones).
// X/Y fields, "Use current position", "Go to", a note ("by nominal"). The owner decides where and with which rights it is saved.
import { h, button } from './dom.js';
import { t } from '../../i18n/index.js';

const fmt = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '');
const done = { ok: true, message: '' };

/**
 * @param label     the point name
 * @param value     {x, y} — the initial value
 * @param note      a mark next to the point ("by nominal"), '' — none
 * @param onSave    ({x, y}) => Promise<{ok, message}|void> — manual input (both fields are numbers)
 * @param onCapture () => Promise<{ok, message, value?}> — "Use current position"; without it there is no button.
 *                  On failure the fields stay as they were; value — the captured point (otherwise the owner refreshes the point).
 * @param onGoTo    ({x, y}) => Promise<{ok, message}> — "Go to"; without it there is no button
 * @param log       (text) => void — the result goes to the log as well
 * @returns {{ element, set(value, note?), setEnabled({edit, capture, move}), value(): {x, y} }}
 */
export function createPoint({ label, value = { x: 0, y: 0 }, note = '', onSave = null, onCapture = null, onGoTo = null, log = () => {} }) {
  const x = h('input', { type: 'number', step: 'any', 'aria-label': `${label}: X` });
  const y = h('input', { type: 'number', step: 'any', 'aria-label': `${label}: Y` });
  const noteEl = h('span', { class: 'point-note' });
  const status = h('div', { class: 'note', role: 'status' });
  let busy = false, enabled = { edit: true, capture: true, move: true }, last = value;

  const read = () => ({ x: parseFloat(x.value), y: parseFloat(y.value) });
  const report = (r) => {
    status.textContent = r && r.message ? r.message : '';
    if (r && r.message) log(`${label}: ${r.message}`);
  };
  async function run(fn) {
    busy = true; sync();
    try { const r = (await fn()) || done; report(r); return r; } catch (e) { const r = { ok: false, message: e.message }; report(r); return r; } finally { busy = false; sync(); }
  }

  const capture = onCapture ? button({
    label: t('point.capture'), hint: 'point.capture.hint',
    onclick: () => run(async () => { const r = await onCapture(); if (r && r.ok && r.value) set(r.value); return r; }),
  }) : null;
  const goTo = onGoTo ? button({ label: t('point.goTo'), hint: 'point.goTo.hint', onclick: () => run(() => onGoTo(read())) }) : null;

  function save() {
    const v = read();
    if (!onSave || !Number.isFinite(v.x) || !Number.isFinite(v.y)) return;
    // a refused value (e.g. the upper right bed corner before the lower left one) does not stay in the fields
    run(() => onSave(v)).then((r) => { if (r && r.ok === false) { x.value = fmt(last.x); y.value = fmt(last.y); } });
  }
  x.addEventListener('change', save);
  y.addEventListener('change', save);

  function sync() {
    x.disabled = y.disabled = !enabled.edit;
    if (capture) capture.disabled = busy || !enabled.capture;
    if (goTo) goTo.disabled = busy || !enabled.move;
  }

  /** The shown value (a field being edited is not overwritten) and the note. */
  function set(v, n = noteEl.textContent) {
    last = v;
    const active = globalThis.document && document.activeElement;
    if (active !== x) x.value = fmt(v.x);
    if (active !== y) y.value = fmt(v.y);
    noteEl.textContent = n || '';
  }

  set(value, note);
  sync();
  const element = h('div', { class: 'point' },
    h('div', { class: 'point-head' }, h('span', { class: 'point-label' }, label), noteEl),
    h('div', { class: 'row' }, h('label', {}, 'X', x), h('label', {}, 'Y', y), capture, goTo),
    status);
  return {
    element, set, value: read,
    setEnabled(next) { enabled = { ...enabled, ...next }; sync(); },
  };
}
