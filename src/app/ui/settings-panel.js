// Settings in two areas: "Print" (every time: readiness, job; folded optimization and calibration values) and "Printer"
// (folded, rarely: machine profiles, pen area, profile fields, connection, export/import via file).
import { h, button } from './dom.js';
import { renderForm } from './form.js';
import { createPoint } from './point.js';
import { fold } from './collapsible.js';
import { createAreaEditor } from './area-editor.js';
import { createReadinessCard } from './readiness-card.js';
import { connectionSchema } from './connection-form.js';
import { SCHEMAS } from '../../core/profile.js';
import { serializeSettings, parseSettings, applySettings, SettingsFileError, SECTION_LABELS } from '../../storage/settings-file.js';
import { downloadText } from '../download.js';
import { createConnectionIndicator } from './connection-indicator.js';
import { createFeedIndicator } from './feed-indicator.js';
import { t, getLocale } from '../../i18n/index.js';

export function importMessage(applied, skipped) {
  const names = (keys) => keys.map((k) => t(SECTION_LABELS[k])).join(', ');
  let m = t('settings.imported', { names: names(applied) || t('settings.importedNothing') });
  if (skipped.length) m += t('settings.skipped', { list: skipped.map((x) => `${t(SECTION_LABELS[x.key])} (${x.reason})`).join(', ') });
  return m;
}

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleString(getLocale()) : t('settings.dateNone'));

export function calibrationSummary(cal) {
  return t('settings.calibrationSummary', { x: cal.cornerX, y: cal.cornerY, z: cal.zTouch, date: formatDate(cal.updatedAt) });
}

// the sheet corner is set by the "Point" control, not by the generic form
const CALIBRATION_FORM = () => SCHEMAS.calibration.filter((f) => f.key !== 'cornerX' && f.key !== 'cornerY');
const JOB_MAIN = () => SCHEMAS.job.filter((f) => f.groupId !== 'optimize');
const JOB_OPTIMIZE = () => SCHEMAS.job.filter((f) => f.groupId === 'optimize');

/**
 * ui.hideConnection — hide the address and key (plugin mode);
 * ui.connectionMonitor — the connection monitor: in the "Connection" section an indicator is shown;
 * ui.feed — the printer connection feed (standalone): its state is shown next to the indicator;
 * ui.needs(section) — the "permission required …" text for a section without write permission, or null (the section is then read-only);
 * ui.calibrator — capture, jog ("Go to"), the Home guard (null — no capture and "Go to" buttons);
 * ui.cornerOffset() — the pen offset from the sheet corner for "Use current position" of the corner;
 * ui.configured() — the printer connection is configured;
 * ui.openWizard(stepId?) — opens the setup wizard (the readiness card is shown only with it).
 * @returns {{ destroy() }} removes the subscriptions (state, calibration, indicators): the panel can be built again (language switch)
 */
export function mountSettingsPanel(host, { state, store, notify, ui = {} }) {
  const needs = ui.needs || (() => null);
  const cal = ui.calibrator || null;
  const forms = {};
  const refreshers = [];
  const off = [];

  function section(id, title, schema, extra = {}) {
    const form = renderForm({ schema, values: state.get(id), onChange: (changes) => state.patch(id, changes) });
    forms[id] = form;
    const need = needs(id);
    const reset = button({
      label: t('settings.reset'), hint: 'settings.reset.hint', disabled: !!need,
      onclick: () => { if (confirm(t('settings.resetConfirm', { title }))) state.reset(id); },
    });
    // fieldset disabled disables all form fields at once, including dynamic ones
    const body = need ? h('fieldset', { disabled: true, class: 'readonly' }, form.element) : form.element;
    return h('section', { class: 'settings-section' },
      h('h3', {}, title), extra.before || null,
      need ? h('div', { class: 'note' }, t('settings.readOnly', { need })) : null,
      body, extra.after || null, h('div', { class: 'row' }, reset));
  }

  // --- the sheet corner point (calibration) and the pen area editor (active profile)
  const goTo = cal && cal.jog ? (v) => cal.jog.goTo(v) : null;
  const corner = createPoint({
    label: t('point.corner'), value: { x: state.get('calibration').cornerX, y: state.get('calibration').cornerY }, log: notify,
    onSave: (v) => state.patch('calibration', { cornerX: v.x, cornerY: v.y }),
    onCapture: cal ? () => cal.capture.captureCorner(ui.cornerOffset ? ui.cornerOffset() : { x: 0, y: 0 }) : null,
    onGoTo: goTo,
  });
  const calibrationNote = h('div', { class: 'note' });
  const area = createAreaEditor({ state, calibrator: cal, need: () => needs('profiles'), online: () => (ui.configured ? ui.configured() : true), control: () => !needs('calibration'), log: notify });
  off.push(area.destroy);

  refreshers.push(() => {
    const c = state.get('calibration');
    corner.set({ x: c.cornerX, y: c.cornerY });
    calibrationNote.textContent = calibrationSummary(c);
  });

  // capture and "Go to" follow the connection, the Home guard and the permissions
  function syncPoints() {
    const link = cal ? cal.link() : null;
    const online = ui.configured ? ui.configured() : true;
    const canCal = !needs('calibration');
    const move = !!goTo && online && canCal && link.xy.ok && link.z.ok;
    const read = !!cal && online && canCal && link.xy.ok && !cal.capture.unsupported;
    corner.setEnabled({ edit: canCal, capture: read, move });
  }

  function indicator(made) { off.push(made.destroy); return made.element; }

  // --- "Print" area: readiness, the job, folded optimization and calibration values
  const ready = ui.openWizard ? createReadinessCard({ state, calibrator: cal, connection: ui.hideConnection ? null : ui.connectionMonitor || null, onSetup: ui.openWizard }) : null;
  if (ready) off.push(ready.destroy);
  const optimizeForm = renderForm({ schema: JOB_OPTIMIZE(), values: state.get('job'), onChange: (changes) => state.patch('job', changes) });
  forms.jobOptimize = { setValues: (v) => optimizeForm.setValues(v) };
  const printArea = h('div', { class: 'settings-area' }, h('h2', {}, t('settings.area.print')),
    ready ? ready.element : null,
    section('job', t('settings.section.job'), JOB_MAIN(), {
      after: fold({ id: 'optimize', title: t('fold.optimize') }, needs('job') ? h('fieldset', { disabled: true, class: 'readonly' }, optimizeForm.element) : optimizeForm.element),
    }),
    fold({ id: 'calibration', title: t('fold.calibration'), note: t('fold.calibration.note') },
      section('calibration', t('settings.section.calibration'), CALIBRATION_FORM(), { before: corner.element, after: calibrationNote })));

  // --- "Printer" area (folded): profiles, pen area, profile fields, connection, transfer
  const profilesBlock = mountProfiles({ state, notify, need: needs('profiles'), refreshers });
  const areaBlock = h('div', { class: 'card bed' }, h('h2', {}, t('area.title')), h('div', { class: 'note' }, t('bed.lead')), area.element);
  const printerArea = h('div', { class: 'settings-area' },
    fold({ id: 'printer', title: t('settings.area.printer'), note: t('fold.printer.note') },
      profilesBlock,
      section('profile', t('settings.section.profile'), SCHEMAS.profile, { before: areaBlock }),
      ui.hideConnection ? null : section('connection', t('settings.section.connection'), connectionSchema(), {
        before: h('div', {},
          ui.connectionMonitor ? indicator(createConnectionIndicator(ui.connectionMonitor, { text: true })) : null,
          ui.feed ? indicator(createFeedIndicator(ui.feed, {
            getProfile: () => state.get('profile'), getCalibration: () => state.get('calibration'),
            firmware: ui.firmware, limits: ui.limits, patchProfile: (changes) => state.patch('profile', changes), confirm: (m) => window.confirm(m),
            onProfile: (fn) => state.subscribe((e) => { if (e.type === 'settings') fn(); }),
          })) : null),
      }),
      mountTransfer({ state, store, notify, needs })));
  host.append(printArea, printerArea);

  const refresh = () => {
    for (const id of Object.keys(forms)) forms[id].setValues(state.get(id === 'jobOptimize' ? 'job' : id));
    for (const fn of refreshers) fn();
    syncPoints();
  };
  refresh();
  off.push(state.subscribe((e) => { if (e.type === 'settings') refresh(); }));
  if (cal) off.push(cal.subscribeLink(syncPoints), cal.monitor.subscribe(syncPoints));

  return { destroy() { for (const fn of off.splice(0)) if (typeof fn === 'function') fn(); } };
}

/** Choosing the active machine profile and the operations on profiles; read-only without the permission. */
function mountProfiles({ state, notify, need, refreshers }) {
  const message = h('div', { class: 'note', role: 'status' });
  const select = h('select', { 'aria-label': t('profiles.active'), disabled: !!need, onchange: () => act(() => state.selectProfile(select.value)) });
  const active = () => state.profiles().items.find((p) => p.id === state.activeProfileId());
  async function act(fn) {
    const r = await fn();
    message.textContent = r && r.message ? r.message : '';
    if (r && r.message) notify(r.message);
    refreshProfiles();
  }
  const ask = (text, value) => { const v = window.prompt(text, value); return v === null ? null : v; };
  const add = button({
    label: t('profiles.new'), hint: 'profiles.new.hint', disabled: !!need,
    onclick: () => { const name = ask(t('profiles.namePrompt'), state.suggestProfileName(t('profiles.newName'))); if (name !== null) act(() => state.createProfile(name)); },
  });
  const dup = button({ label: t('profiles.duplicate'), hint: 'profiles.duplicate.hint', disabled: !!need, onclick: () => act(() => state.duplicateProfile(state.activeProfileId())) });
  const rename = button({
    label: t('profiles.rename'), hint: 'profiles.rename.hint', disabled: !!need,
    onclick: () => { const name = ask(t('profiles.namePrompt'), active().name); if (name !== null) act(() => state.renameProfile(state.activeProfileId(), name)); },
  });
  const remove = button({
    label: t('profiles.remove'), hint: 'profiles.remove.hint', class: 'danger',
    onclick: () => { if (confirm(t('profiles.removeConfirm', { name: active().name }))) act(() => state.removeProfile(state.activeProfileId())); },
  });

  function refreshProfiles() {
    const col = state.profiles();
    select.replaceChildren(...col.items.map((p) => h('option', { value: p.id, selected: p.id === col.activeId }, p.name)));
    select.value = col.activeId;
    remove.disabled = !!need || col.items.length <= 1;
  }
  refreshers.push(refreshProfiles);

  return h('section', { class: 'settings-section profiles' },
    h('h3', {}, t('profiles.title')),
    need ? h('div', { class: 'note' }, t('settings.readOnly', { need })) : null,
    h('label', {}, t('profiles.active'), select),
    h('div', { class: 'row' }, add, dup, rename, remove),
    message);
}

function mountTransfer({ state, store, notify, needs }) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const list = h('div', { class: 'choices' });
  const message = h('div', { class: 'warn' });
  const apply = button({ label: t('settings.import.apply'), hint: 'settings.import.apply.hint', type: 'submit', class: 'primary' });
  let parsed = null;
  const dialog = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: onApply },
      h('h3', {}, t('settings.import.title')), h('p', {}, t('settings.import.lead')), list, message,
      h('div', { class: 'row' }, apply, button({ label: t('common.cancel'), hint: 'settings.import.cancel.hint', onclick: () => dialog.close() }))));

  async function onApply(ev) {
    const chosen = [...list.querySelectorAll('input:checked')].map((i) => i.value);
    ev.preventDefault();
    const { applied, skipped } = await applySettings(store, parsed, chosen, { needs });
    await state.load();
    dialog.close();
    notify(importMessage(applied, skipped));
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      fileInput.value = '';
      parsed = parseSettings(text);
    } catch (e) {
      notify(e instanceof SettingsFileError ? t('settings.import.error', { message: e.message }) : t('settings.import.readFailed'));
      return;
    }
    list.replaceChildren(...Object.keys(parsed.sections).map((k) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: true }),
        t(SECTION_LABELS[k]) + (needs(k) ? t('settings.import.willSkip', { need: needs(k) }) : ''))));
    message.textContent = '';
    dialog.showModal();
  });

  async function onExport() {
    const presets = await store.load('presets');
    const s = state.settings();
    downloadText('neptune-plotter-settings.json', serializeSettings({ profiles: state.profiles(), calibration: s.calibration, job: s.job, presets }), 'application/json');
  }

  return h('section', { class: 'settings-section' },
    h('h3', {}, t('settings.transfer.title')),
    h('div', { class: 'row' },
      button({ label: t('settings.transfer.export'), hint: 'settings.transfer.export.hint', onclick: onExport }),
      button({ label: t('settings.transfer.import'), hint: 'settings.transfer.import.hint', onclick: () => fileInput.click() })),
    h('div', { class: 'note' }, t('settings.transfer.note')),
    fileInput, dialog);
}
