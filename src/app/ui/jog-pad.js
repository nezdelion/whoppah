// Jog pad: step choice, X±/Y±/Z± buttons, the "Not homed" hint with "Already homed". Shared by the wizard and the Print tab.
import { h, button } from './dom.js';
import { JOG_STEPS } from '../../core/jog.js';
import { t } from '../../i18n/index.js';

/**
 * @param calibrator  { jog, link(), markHomed, subscribeLink } (jog required)
 * @param allowed     () => boolean: the connection is configured and the user may control the printer
 * @param log         (text) => void
 * @param step        { get(): number, set(v) } — the jog step kept by the owner across remounts
 * @param onBusy      (busy) => void — a step is in progress (the owner may disable its own buttons)
 * @returns {{ element, sync(), busy: boolean, destroy() }}
 */
export function createJogPad({ calibrator, allowed = () => true, log = () => {}, step, onBusy = () => {} }) {
  const $ = {};
  let busy = false;
  const off = [];
  const act = (text, fn) => async () => {
    busy = true; onBusy(true); sync();
    try { const r = await fn(); log(`${text}: ${r.message}`); } finally { busy = false; onBusy(false); sync(); }
  };
  $.homeHint = h('div', { class: 'warn', role: 'status' });
  $.homeDone = button({
    label: t('print.homeDone'), hint: 'print.homeDone.hint', hidden: true,
    onclick: () => { if (confirm(t('print.homeConfirm'))) { calibrator.markHomed(); log(t('print.homeAccepted')); sync(); } },
  });
  $.step = h('select', { 'aria-label': t('print.stepLabel'), onchange: () => step.set(Number($.step.value)) },
    JOG_STEPS.map((v) => h('option', { value: v, selected: v === step.get() }, t('print.stepOption', { v }))));
  const jogBtn = (axis, dir) => {
    const text = `${axis.toUpperCase()}${dir > 0 ? '+' : '−'}`;
    return ($[`jog${axis}${dir}`] = button({ label: text, hint: 'print.jog.hint', class: 'jog-btn', onclick: act(text, () => calibrator.jog.move(axis, dir, Number($.step.value))) }));
  };
  const keys = ['x', 'y', 'z'].flatMap((a) => [`jog${a}-1`, `jog${a}1`]);
  const element = h('div', { class: 'jog-pad' },
    $.homeHint, $.homeDone,
    h('div', { class: 'row' }, h('label', {}, t('jogpad.step'), $.step),
      ['x', 'y', 'z'].flatMap((a) => [jogBtn(a, -1), jogBtn(a, 1)])));

  function sync() {
    const link = calibrator.link();
    const base = !allowed();
    for (const k of keys) $[k].disabled = busy || base || !(k.startsWith('jogz') ? link.z.ok : link.xy.ok);
    $.homeHint.textContent = link.hint;
    $.homeDone.hidden = !(calibrator.markHomed && link.homeMissing);
  }
  sync();
  off.push(calibrator.subscribeLink(sync));
  return { element, sync, get busy() { return busy; }, destroy() { for (const fn of off.splice(0)) fn(); } };
}
