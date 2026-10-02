// Setup wizard: a modal dialog with steps — connection (standalone), pen area, sheet, touch, check.
// Every change is saved at once through the state; the dialog can be closed on any step.
import { h, button } from './dom.js';
import { renderForm } from './form.js';
import { createPoint } from './point.js';
import { createJogPad } from './jog-pad.js';
import { createAreaEditor } from './area-editor.js';
import { createReadinessCard } from './readiness-card.js';
import { createConnectionIndicator } from './connection-indicator.js';
import { connectionSchema } from './connection-form.js';
import { SCHEMAS } from '../../core/profile.js';
import { printArea } from '../../core/bed.js';
import { t } from '../../i18n/index.js';

/** The pen offset from the sheet corner for "Sheet corner here" when the pen cannot stand at the corner (kept in the browser). */
export const OFFSET_KEY = 'neptune-plotter.capture-offset';
export const readCornerOffset = () => {
  try { const o = JSON.parse(localStorage.getItem(OFFSET_KEY)); if (Number.isFinite(o.x) && Number.isFinite(o.y)) return o; } catch (e) { /* nothing saved */ }
  return { x: 0, y: 0 };
};
const saveCornerOffset = (o) => { try { localStorage.setItem(OFFSET_KEY, JSON.stringify(o)); } catch (e) { /* without saving */ } };

/** readiness item ids that map onto a step with another name */
const STEP_OF = { corner: 'sheet' };
const stepFor = (id) => STEP_OF[id] || id;

const num = (el) => (Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : 0);

/**
 * @param host        where the <dialog> is appended
 * @param state       settings state
 * @param notify      (text) => void — the log
 * @param ui          { needs(section), hideConnection, connectionMonitor, feed, firmware, limits }
 * @param calibrator  { capture, jog, link, subscribeLink, monitor, markHomed } or null
 * @param transport   { configured() }
 * @param service     print service: manual(id), frame(drawing)
 * @param jogStep     { get(), set(v) } — the jog step shared with the Print tab
 * @returns {{ open(stepId?), close(), destroy(), isOpen() }}
 */
export function createSetupWizard({ host, state, notify = () => {}, ui = {}, calibrator = null, transport, service = null, jogStep }) {
  const needs = ui.needs || (() => null);
  const online = () => transport.configured();
  const cal = calibrator;
  const stepIds = [...(ui.hideConnection ? [] : ['connection']), 'area', 'sheet', 'touch', 'check'];
  let index = 0, current = null; // current: { element, destroy }
  let busy = false;

  const title = h('h3', {}, t('wizard.title'));
  const stepOf = h('span', { class: 'wizard-step-of' });
  const tabs = h('div', { class: 'wizard-tabs' });
  const body = h('div', { class: 'wizard-body' });
  const back = button({ label: t('wizard.back'), hint: 'wizard.back.hint', onclick: () => go(index - 1) });
  const next = button({ label: t('wizard.next'), hint: 'wizard.next.hint', class: 'primary', onclick: () => go(index + 1) });
  const done = button({ label: t('wizard.done'), hint: 'wizard.done.hint', class: 'primary', onclick: () => close() });
  const closeBtn = button({ label: t('wizard.close'), hint: 'wizard.close.hint', onclick: () => close() });
  const dialog = h('dialog', { class: 'wizard' },
    h('div', { class: 'wizard-head' }, title, stepOf, closeBtn), tabs, body,
    h('div', { class: 'row wizard-foot' }, back, next, done));
  dialog.addEventListener('close', () => { if (current) { current.destroy(); current = null; } });
  host.append(dialog);
  function close() { if (dialog.open) dialog.close(); }

  // --- shared pieces for the steps that move the head
  const jogPad = cal && cal.jog ? createJogPad({
    calibrator: cal, step: jogStep, log: notify,
    allowed: () => online() && !needs('calibration'),
    onBusy: (b) => { busy = b; syncButtons(); },
  }) : null;
  const act = (text, fn) => async () => {
    busy = true; syncButtons();
    try { const r = await fn(); notify(`${text}: ${r.message}`); } finally { busy = false; syncButtons(); }
  };
  const captureOk = (part) => {
    if (!cal || !online() || needs('calibration') || cal.capture.unsupported || busy) return false;
    return cal.link()[part].ok;
  };
  const moveOk = () => !!(cal && cal.jog) && online() && !needs('calibration') && !busy && cal.link().xy.ok && cal.link().z.ok;
  let syncers = [];
  function syncButtons() { for (const fn of syncers) fn(); }

  const readOnly = (section) => { const n = needs(section); return n ? h('div', { class: 'warn' }, t('wizard.readOnly', { need: n })) : null; };
  const noMonitor = () => (cal ? null : h('div', { class: 'note' }, t('wizard.noMonitor')));
  const lockIf = (section, el) => (needs(section) ? h('fieldset', { disabled: true, class: 'readonly' }, el) : el);

  // --- steps
  const steps = {
    connection() {
      const form = renderForm({ schema: connectionSchema(), values: state.get('connection'), onChange: (c) => state.patch('connection', c) });
      const ind = ui.connectionMonitor ? createConnectionIndicator(ui.connectionMonitor, { text: true }) : null;
      const test = ui.connectionMonitor ? button({ label: t('print.test'), hint: 'print.test.hint', onclick: async () => { const s = await ui.connectionMonitor.checkNow(); notify(s.detail); } }) : null;
      const off = state.subscribe((e) => { if (e.type === 'settings') form.setValues(state.get('connection')); });
      return {
        element: h('div', {}, h('p', { class: 'note' }, t('wizard.connection.lead')), ind ? ind.element : null, form.element, test ? h('div', { class: 'row' }, test) : null),
        destroy() { off(); if (ind) ind.destroy(); },
      };
    },
    area() {
      const select = h('select', { 'aria-label': t('profiles.active'), disabled: !!needs('profiles'), onchange: () => state.selectProfile(select.value) });
      const fill = () => { const col = state.profiles(); select.replaceChildren(...col.items.map((p) => h('option', { value: p.id, selected: p.id === col.activeId }, p.name))); select.value = col.activeId; };
      fill();
      const editor = createAreaEditor({ state, calibrator: cal, need: () => needs('profiles'), online, control: () => !needs('calibration'), log: notify });
      const off = state.subscribe((e) => { if (e.type === 'settings') fill(); });
      return {
        element: h('div', {}, h('p', { class: 'note' }, t('wizard.area.lead')), readOnly('profiles'), noMonitor(),
          h('label', {}, t('profiles.active'), select), editor.element, jogPad ? jogPad.element : null),
        destroy() { off(); editor.destroy(); },
      };
    },
    sheet() {
      const schema = SCHEMAS.job.filter((f) => f.groupId === 'sheet');
      const form = renderForm({ schema, values: state.get('job'), onChange: (c) => state.patch('job', c) });
      const offX = h('input', { type: 'number', step: '0.1', value: readCornerOffset().x, 'aria-label': t('print.offX') });
      const offY = h('input', { type: 'number', step: '0.1', value: readCornerOffset().y, 'aria-label': t('print.offY') });
      const offset = () => ({ x: num(offX), y: num(offY) });
      offX.addEventListener('change', () => saveCornerOffset(offset()));
      offY.addEventListener('change', () => saveCornerOffset(offset()));
      const current = h('div', { class: 'note', role: 'status' });
      const goCorner = cal && cal.jog ? button({ label: t('wizard.sheet.goCorner'), hint: 'wizard.sheet.goCorner.hint', onclick: act(t('wizard.sheet.goCorner'), () => { const a = printArea(state.get('profile')); return cal.jog.goTo({ x: a.x0, y: a.y0 }); }) }) : null;
      const here = cal ? button({ label: t('wizard.sheet.cornerHere'), hint: 'wizard.sheet.cornerHere.hint', class: 'primary', onclick: act(t('wizard.sheet.cornerHere'), () => cal.capture.captureCorner(offset())) }) : null;
      const point = createPoint({
        label: t('point.corner'), value: { x: state.get('calibration').cornerX, y: state.get('calibration').cornerY }, log: notify,
        onSave: (v) => state.patch('calibration', { cornerX: v.x, cornerY: v.y }),
        onGoTo: cal && cal.jog ? (v) => cal.jog.goTo(v) : null,
      });
      const refresh = () => {
        const c = state.get('calibration');
        form.setValues(state.get('job'));
        point.set({ x: c.cornerX, y: c.cornerY });
        current.textContent = t('wizard.sheet.current', { x: c.cornerX, y: c.cornerY });
      };
      const sync = () => {
        if (goCorner) goCorner.disabled = !moveOk();
        if (here) here.disabled = !captureOk('xy');
        point.setEnabled({ edit: !needs('calibration'), capture: false, move: moveOk() });
      };
      syncers.push(sync);
      refresh(); sync();
      const off = state.subscribe((e) => { if (e.type === 'settings') refresh(); });
      const el = h('div', {}, readOnly('calibration'), noMonitor(),
        lockIf('job', form.element),
        h('p', { class: 'note' }, t('wizard.sheet.lead')),
        cal ? h('div', { class: 'note' }, t('wizard.sheet.way1'), h('br'), t('wizard.sheet.way2'), h('br'), t('wizard.sheet.then')) : null,
        cal ? h('div', { class: 'row' }, goCorner, here) : null,
        jogPad ? jogPad.element : null,
        current,
        h('details', { class: 'fold' }, h('summary', {}, t('wizard.sheet.farLead')),
          h('div', { class: 'note' }, t('wizard.sheet.farNote')),
          h('div', { class: 'row' }, h('label', {}, t('print.offX'), offX), h('label', {}, t('print.offY'), offY))),
        h('details', { class: 'fold' }, h('summary', {}, t('fold.calibration')), point.element));
      return { element: el, destroy() { off(); syncers = syncers.filter((f) => f !== sync); } };
    },
    touch() {
      const schema = SCHEMAS.profile.filter((f) => f.key === 'penWidthMm');
      const form = renderForm({ schema, values: state.get('profile'), onChange: (c) => state.patch('profile', c) });
      const current = h('div', { class: 'note', role: 'status' });
      const here = cal ? button({ label: t('wizard.touch.here'), hint: 'wizard.touch.here.hint', class: 'primary', onclick: act(t('wizard.touch.here'), () => cal.capture.captureTouch()) }) : null;
      const zForm = renderForm({ schema: SCHEMAS.calibration.filter((f) => f.key === 'zTouch'), values: state.get('calibration'), onChange: (c) => state.patch('calibration', c) });
      const refresh = () => { form.setValues(state.get('profile')); zForm.setValues(state.get('calibration')); current.textContent = t('wizard.touch.current', { z: state.get('calibration').zTouch }); };
      const sync = () => { if (here) here.disabled = !captureOk('z'); };
      syncers.push(sync);
      refresh(); sync();
      const off = state.subscribe((e) => { if (e.type === 'settings') refresh(); });
      const el = h('div', {}, readOnly('calibration'), noMonitor(),
        h('p', { class: 'note' }, t('wizard.touch.lead')),
        jogPad ? jogPad.element : null,
        cal ? h('div', { class: 'row' }, here) : null,
        current,
        h('details', { class: 'fold' }, h('summary', {}, t('fold.calibration')), lockIf('calibration', zForm.element)),
        lockIf('profile', form.element));
      return { element: el, destroy() { off(); syncers = syncers.filter((f) => f !== sync); } };
    },
    check() {
      const card = createReadinessCard({ state, calibrator: cal, connection: ui.hideConnection ? null : ui.connectionMonitor || null, onSetup: (id) => go(Math.max(0, stepIds.indexOf(stepFor(id)))) });
      const hasDrawing = !!state.drawing();
      const penUp = service ? button({ label: t('wizard.check.penUp'), hint: 'wizard.check.penUp.hint', onclick: act(t('wizard.check.penUp'), () => service.manual('up')) }) : null;
      const frame = service ? button({ label: t('wizard.check.frame'), hint: 'wizard.check.frame.hint', onclick: act(t('wizard.check.frame'), () => service.frame(state.drawing())) }) : null;
      const sync = () => { if (penUp) penUp.disabled = !online() || busy; if (frame) frame.disabled = !online() || busy || !state.drawing(); };
      syncers.push(sync); sync();
      return {
        element: h('div', {}, h('p', { class: 'note' }, t('wizard.check.lead')), card.element,
          hasDrawing ? null : h('div', { class: 'note' }, t('wizard.check.noDrawing')),
          service ? h('div', { class: 'row' }, penUp, frame) : null),
        destroy() { card.destroy(); syncers = syncers.filter((f) => f !== sync); },
      };
    },
  };

  function go(i) {
    if (i < 0 || i >= stepIds.length) return;
    if (current) current.destroy();
    index = i;
    const id = stepIds[i];
    current = steps[id]();
    body.replaceChildren(current.element);
    stepOf.textContent = t('wizard.stepOf', { n: i + 1, m: stepIds.length });
    tabs.replaceChildren(...stepIds.map((s, k) => h('span', { class: 'wizard-tab', 'data-active': k === i ? '1' : '', 'data-step': s }, t(`wizard.step.${s}`))));
    back.disabled = i === 0;
    next.hidden = i === stepIds.length - 1;
    done.hidden = i !== stepIds.length - 1;
    if (jogPad) jogPad.sync();
    dialog.dataset.step = id;
  }

  const offLink = cal ? [cal.subscribeLink(syncButtons), cal.monitor.subscribe(syncButtons)] : [];
  const offState = state.subscribe((e) => { if (e.type === 'settings' && e.section === 'connection') syncButtons(); });

  return {
    open(stepId) { go(Math.max(0, stepIds.indexOf(stepFor(stepId)))); if (!dialog.open) dialog.showModal(); },
    close,
    isOpen: () => !!dialog.open,
    step: () => stepIds[index],
    steps: () => [...stepIds],
    destroy() {
      if (dialog.open) dialog.close();
      if (current) { current.destroy(); current = null; }
      if (jogPad) jogPad.destroy();
      for (const fn of [...offLink, offState]) fn();
      dialog.remove && dialog.remove();
    },
  };
}
