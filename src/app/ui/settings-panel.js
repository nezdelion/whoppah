// Settings sections: job, calibration, machine profile, connection; export/import via file.
import { h } from './dom.js';
import { renderForm } from './form.js';
import { SCHEMAS } from '../../core/profile.js';
import { serializeSettings, parseSettings, applySettings, SettingsFileError, SECTION_LABELS } from '../../storage/settings-file.js';
import { downloadText } from '../download.js';
import { createConnectionIndicator } from './connection-indicator.js';

const CONNECTION_SCHEMA = [
  { key: 'url', label: 'Адрес', type: 'text', group: 'OctoPrint', placeholder: 'http://octopi.local' },
  { key: 'key', label: 'API-ключ', type: 'password', group: 'OctoPrint' },
];

export function importMessage(applied, skipped) {
  const names = (keys) => keys.map((k) => SECTION_LABELS[k]).join(', ');
  let m = `Настройки импортированы: ${names(applied) || 'ничего'}`;
  if (skipped.length) m += `. Пропущено: ${skipped.map((x) => `${SECTION_LABELS[x.key]} (${x.reason})`).join(', ')}`;
  return m;
}

export const formatDate = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU') : 'не задана');

export function calibrationSummary(cal) {
  return `Калибровка: угол X${cal.cornerX} Y${cal.cornerY}, касание Z${cal.zTouch}, изменена: ${formatDate(cal.updatedAt)}`;
}

/**
 * ui.hideConnection — hide the address and key (plugin mode);
 * ui.connectionMonitor — the connection monitor: in the "Connection" section an indicator is shown;
 * ui.needs(section) — the "permission required …" text for a section without write permission, or null (the section is then read-only).
 */
export function mountSettingsPanel(host, { state, store, notify, ui = {} }) {
  const needs = ui.needs || (() => null);
  const forms = {};
  const sections = [
    { id: 'job', title: 'Задание', schema: SCHEMAS.job },
    { id: 'calibration', title: 'Калибровка', schema: SCHEMAS.calibration },
    { id: 'profile', title: 'Профиль машины', schema: SCHEMAS.profile },
    ...(ui.hideConnection ? [] : [{ id: 'connection', title: 'Подключение', schema: CONNECTION_SCHEMA }]),
  ];
  const calibrationNote = h('div', { class: 'note' });

  for (const s of sections) {
    const form = renderForm({ schema: s.schema, values: state.get(s.id), onChange: (changes) => state.patch(s.id, changes) });
    forms[s.id] = form;
    const reset = h('button', {
      type: 'button',
      onclick: () => { if (confirm(`Сбросить «${s.title}» к значениям по умолчанию?`)) state.reset(s.id); },
    }, 'Сбросить к умолчанию');
    const need = needs(s.id);
    if (need) reset.disabled = true;
    // fieldset disabled disables all form fields at once, including dynamic ones
    const body = need ? h('fieldset', { disabled: true, class: 'readonly' }, form.element) : form.element;
    host.append(h('section', { class: 'settings-section' },
      h('h3', {}, s.title),
      s.id === 'connection' && ui.connectionMonitor ? createConnectionIndicator(ui.connectionMonitor, { text: true }).element : null,
      need ? h('div', { class: 'note' }, `Только чтение: ${need}`) : null,
      body, s.id === 'calibration' ? calibrationNote : null, h('div', { class: 'row' }, reset)));
  }

  const refresh = () => {
    for (const s of sections) forms[s.id].setValues(state.get(s.id));
    calibrationNote.textContent = calibrationSummary(state.get('calibration'));
  };
  refresh();
  state.subscribe((e) => { if (e.type === 'settings') refresh(); });

  host.append(mountTransfer({ state, store, notify, needs }));
}

function mountTransfer({ state, store, notify, needs }) {
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const list = h('div', { class: 'choices' });
  const message = h('div', { class: 'warn' });
  const apply = h('button', { type: 'submit', class: 'primary' }, 'Импортировать');
  let parsed = null;
  const dialog = h('dialog', {},
    h('form', { method: 'dialog', onsubmit: onApply },
      h('h3', {}, 'Импорт настроек'), h('p', {}, 'Будут заменены выбранные разделы:'), list, message,
      h('div', { class: 'row' }, apply, h('button', { type: 'button', onclick: () => dialog.close() }, 'Отмена'))));

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
      notify(e instanceof SettingsFileError ? `Импорт: ${e.message}` : 'Импорт: не удалось прочитать файл');
      return;
    }
    list.replaceChildren(...Object.keys(parsed.sections).map((k) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: true }),
        SECTION_LABELS[k] + (needs(k) ? ` (будет пропущен: ${needs(k)})` : ''))));
    message.textContent = '';
    dialog.showModal();
  });

  async function onExport() {
    const presets = await store.load('presets');
    const s = state.settings();
    downloadText('neptune-plotter-settings.json', serializeSettings({ ...s, presets }), 'application/json');
  }

  return h('section', { class: 'settings-section' },
    h('h3', {}, 'Перенос настроек'),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: onExport }, 'Экспорт в файл'),
      h('button', { type: 'button', onclick: () => fileInput.click() }, 'Импорт из файла…')),
    h('div', { class: 'note' }, 'В файл не попадают адрес и API-ключ OctoPrint.'),
    fileInput, dialog);
}
