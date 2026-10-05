// Jog pad like OctoPrint's: step choice (radio segments), an XY cross (Y+ away from you, X+ right) and a Z column,
// the "Not homed" hint with "Already homed". Shared by the wizard and the Print tab.
import { h, button, disclosure } from './dom.js';
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
let padCount = 0;

export function createJogPad({ calibrator, allowed = () => true, log = () => {}, step, onBusy = () => {} }) {
  const $ = {};
  let busy = false;
  const off = [];
  const act = (text, fn) => async () => {
    busy = true; onBusy(true); sync();
    try { const r = await fn(); log(`${text}: ${r.message}`); } finally { busy = false; onBusy(false); sync(); }
  };
  $.homeHint = h('div', { class: 'warn', role: 'status' });
  $.home = button({
    label: t('jogpad.home'), hint: 'jogpad.home.hint', hidden: true,
    onclick: () => {
      if (!calibrator.jog.home || !confirm(t('jogpad.homeConfirm'))) return;
      act('G28', async () => {
        const r = await calibrator.jog.home();
        if (r.ok && calibrator.markHomed) calibrator.markHomed();
        return r;
      })();
    },
  });
  $.homeDone = button({
    label: t('print.homeDone'), hint: 'print.homeDone.hint', hidden: true,
    onclick: () => { if (confirm(t('print.homeConfirm'))) { calibrator.markHomed(); log(t('print.homeAccepted')); sync(); } },
  });
  // a radio group per pad: two pads on one page (Print tab and the wizard) must not share a group
  const group = `jog-step-${++padCount}`;
  const steps = JOG_STEPS.map((v) => h('input', {
    type: 'radio', name: group, value: v, checked: v === step.get(), 'aria-label': t('print.stepOption', { v }),
    onchange: () => step.set(v),
  }));
  const current = () => { const r = steps.find((x) => x.checked); return r ? Number(r.value) : step.get(); };
  const jogBtn = (axis, dir, area) => {
    const text = `${axis.toUpperCase()}${dir > 0 ? '+' : '−'}`;
    const b = button({ label: text, hint: 'print.jog.hint', class: 'jog-btn', onclick: act(text, () => calibrator.jog.move(axis, dir, current())) });
    b.style.gridArea = area;
    return ($[`jog${axis}${dir}`] = b);
  };
  const keys = ['x', 'y', 'z'].flatMap((a) => [`jog${a}-1`, `jog${a}1`]);
  const hint = disclosure('?', t('print.jog.hint'));
  const element = h('div', { class: 'jog-pad' },
    $.homeHint, h('div', { class: 'row' }, $.home, $.homeDone),
    h('div', { class: 'jog-steps', role: 'radiogroup', 'aria-label': t('print.stepLabel') },
      h('span', {}, t('jogpad.step')),
      steps.map((r, i) => h('label', { class: 'jog-step' }, r, h('span', {}, t('print.stepOption', { v: JOG_STEPS[i] })))),
      hint.icon),
    hint.text,
    h('div', { class: 'jog-grid' },
      jogBtn('y', 1, 'yp'), jogBtn('x', -1, 'xm'), jogBtn('x', 1, 'xp'), jogBtn('y', -1, 'ym'),
      jogBtn('z', 1, 'zp'), jogBtn('z', -1, 'zm')));

  function sync() {
    const link = calibrator.link();
    const base = !allowed();
    for (const k of keys) $[k].disabled = busy || base || !(k.startsWith('jogz') ? link.z.ok : link.xy.ok);
    $.homeHint.textContent = link.hint;
    $.homeDone.hidden = !(calibrator.markHomed && link.homeMissing);
    $.home.hidden = !(calibrator.jog.home && link.homeMissing);
    $.home.disabled = busy || base;
  }
  sync();
  off.push(calibrator.subscribeLink(sync));
  return { element, sync, get busy() { return busy; }, destroy() { for (const fn of off.splice(0)) fn(); } };
}
