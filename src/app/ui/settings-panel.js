// Settings sections: job, calibration, machine profile, connection; export/import via file.
import { h } from './dom.js';
import { renderForm } from './form.js';
import { SCHEMAS } from '../../core/profile.js';
import { serializeSettings, parseSettings, applySettings, SettingsFileError, SECTION_LABELS } from '../../storage/settings-file.js';
import { downloadText } from '../download.js';
import { createConnectionIndicator } from './connection-indicator.js';
import { createFeedIndicator } from './feed-indicator.js';
import { t, getLocale } from '../../i18n/index.js';

const connectionSchema = () => [
  { key: 'url', label: t('settings.connection.url'), type: 'text', group: 'OctoPrint', placeholder: 'http://localhost:5000' },
  { key: 'key', label: t('settings.connection.key'), type: 'password', group: 'OctoPrint' },
];

const LANG_CHOICES = [['auto', () => t('lang.auto')], ['en', () => 'English'], ['ru', () => 'Русский']];

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

/**
 * ui.hideConnection — hide the address and key (plugin mode);
 * ui.connectionMonitor — the connection monitor: in the "Connection" section an indicator is shown;
 * ui.feed — the printer connection feed (standalone): its state is shown next to the indicator;
 * ui.language — { get(): 'auto'|'en'|'ru', set(value) }: the language switch (set saves the choice and reloads the page);
 * ui.needs(section) — the "permission required …" text for a section without write permission, or null (the section is then read-only).
 */
export function mountSettingsPanel(host, { state, store, notify, ui = {} }) {
  const needs = ui.needs || (() => null);
  const forms = {};
  const sections = [
    { id: 'job', title: t('settings.section.job'), schema: SCHEMAS.job },
    { id: 'calibration', title: t('settings.section.calibration'), schema: SCHEMAS.calibration },
    { id: 'profile', title: t('settings.section.profile'), schema: SCHEMAS.profile },
    ...(ui.hideConnection ? [] : [{ id: 'connection', title: t('settings.section.connection'), schema: connectionSchema() }]),
  ];
  const calibrationNote = h('div', { class: 'note' });

  for (const s of sections) {
    const form = renderForm({ schema: s.schema, values: state.get(s.id), onChange: (changes) => state.patch(s.id, changes) });
    forms[s.id] = form;
    const reset = h('button', {
      type: 'button',
      onclick: () => { if (confirm(t('settings.resetConfirm', { title: s.title }))) state.reset(s.id); },
    }, t('settings.reset'));
    const need = needs(s.id);
    if (need) reset.disabled = true;
    // fieldset disabled disables all form fields at once, including dynamic ones
    const body = need ? h('fieldset', { disabled: true, class: 'readonly' }, form.element) : form.element;
    host.append(h('section', { class: 'settings-section' },
      h('h3', {}, s.title),
      s.id === 'connection' && ui.connectionMonitor ? createConnectionIndicator(ui.connectionMonitor, { text: true }).element : null,
      s.id === 'connection' && ui.feed ? createFeedIndicator(ui.feed, {
        getProfile: () => state.get('profile'), getCalibration: () => state.get('calibration'),
        firmware: ui.firmware, patchProfile: (changes) => state.patch('profile', changes), confirm: (m) => window.confirm(m),
        onProfile: (fn) => state.subscribe((e) => { if (e.type === 'settings') fn(); }),
      }).element : null,
      need ? h('div', { class: 'note' }, t('settings.readOnly', { need })) : null,
      body, s.id === 'calibration' ? calibrationNote : null, h('div', { class: 'row' }, reset)));
  }

  const refresh = () => {
    for (const s of sections) forms[s.id].setValues(state.get(s.id));
    calibrationNote.textContent = calibrationSummary(state.get('calibration'));
  };
  refresh();
  state.subscribe((e) => { if (e.type === 'settings') refresh(); });

  host.append(mountTransfer({ state, store, notify, needs }));
  if (ui.language) host.append(mountLanguage(ui.language));
}

function mountLanguage(language) {
  const select = h('select', { onchange: () => language.set(select.value) },
    LANG_CHOICES.map(([v, name]) => h('option', { value: v, selected: v === language.get() }, name())));
  return h('section', { class: 'settings-section' },
    h('h3', {}, t('lang.title')),
    h('label', {}, t('lang.label'), select),
    h('div', { class: 'note' }, t('lang.note')));
}

function mountTransfer({ state, store, notify, needs }) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const list = h('div', { class: 'choices' });
  const message = h('div', { class: 'warn' });
  const apply = h('button', { type: 'submit', class: 'primary' }, t('settings.import.apply'));
  let parsed = null;
  const dialog = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: onApply },
      h('h3', {}, t('settings.import.title')), h('p', {}, t('settings.import.lead')), list, message,
      h('div', { class: 'row' }, apply, h('button', { type: 'button', onclick: () => dialog.close() }, t('common.cancel')))));

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
    downloadText('neptune-plotter-settings.json', serializeSettings({ ...s, presets }), 'application/json');
  }

  return h('section', { class: 'settings-section' },
    h('h3', {}, t('settings.transfer.title')),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: onExport }, t('settings.transfer.export')),
      h('button', { type: 'button', onclick: () => fileInput.click() }, t('settings.transfer.import'))),
    h('div', { class: 'note' }, t('settings.transfer.note')),
    fileInput, dialog);
}
