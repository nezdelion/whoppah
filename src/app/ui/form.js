// A form from the field schema (core/profile.js): a grid of cards by group, range checks, paper format choice.
import { h } from './dom.js';
import { PAPER_FORMATS } from '../../core/layout.js';

const labelText = (f) => (f.unit ? `${f.label}, ${f.unit}` : f.label);

function numberField(f, values, onChange) {
  const input = h('input', { type: 'number', step: 'any', value: values[f.key] });
  if (f.min !== undefined) input.min = f.min;
  if (f.max !== undefined) input.max = f.max;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    const valid = Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    input.classList.toggle('invalid', !valid);
    input.title = valid ? '' : `${f.label}: допустимо ${f.min ?? '−∞'} … ${f.max ?? '∞'}`;
    if (valid) onChange({ [f.key]: v });
  });
  return {
    element: h('label', {}, labelText(f), input),
    set(v) { if (document.activeElement !== input) { input.value = v[f.key]; input.classList.remove('invalid'); } },
  };
}

function boolField(f, values, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!values[f.key], onchange: () => onChange({ [f.key]: input.checked }) });
  return { element: h('label', { class: 'check wide' }, input, f.label), set(v) { input.checked = !!v[f.key]; } };
}

function enumField(f, values, onChange) {
  const select = h('select', { onchange: () => onChange({ [f.key]: select.value }) },
    Object.entries(f.options).map(([v, t]) => h('option', { value: v }, t)));
  select.value = values[f.key];
  return { element: h('label', {}, f.label, select), set(v) { select.value = v[f.key]; } };
}

function textField(f, values, onChange) {
  const input = h('input', { type: f.type === 'password' ? 'password' : 'text', autocomplete: 'off', placeholder: f.placeholder || '', value: values[f.key] ?? '' });
  input.addEventListener('input', () => onChange({ [f.key]: input.value.trim() }));
  return { element: h('label', { class: 'wide' }, f.label, input), set(v) { if (document.activeElement !== input) input.value = v[f.key] ?? ''; } };
}

// --- paper format: built-in and custom, creating and deleting a custom one

function paperField(f, values, onChange) {
  let current = values;
  const select = h('select', { onchange: () => onChange({ paperId: select.value }) });
  const removeBtn = h('button', { type: 'button', onclick: () => remove() }, 'Удалить формат');
  const nameIn = h('input', { placeholder: 'Название' });
  const wIn = h('input', { type: 'number', step: 'any', min: 1, placeholder: 'Ширина, мм' });
  const hIn = h('input', { type: 'number', step: 'any', min: 1, placeholder: 'Высота, мм' });
  const errorEl = h('div', { class: 'warn' });
  const editor = h('div', { class: 'paper-editor', hidden: true },
    h('div', { class: 'grid' }, h('label', { class: 'wide' }, 'Название', nameIn), h('label', {}, 'Ширина, мм', wIn), h('label', {}, 'Высота, мм', hIn)),
    errorEl,
    h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => add() }, 'Добавить'), h('button', { type: 'button', onclick: () => { editor.hidden = true; } }, 'Отмена')));

  function add() {
    const w = parseFloat(wIn.value), hh = parseFloat(hIn.value), name = nameIn.value.trim();
    if (!name || !(w > 0) || !(hh > 0)) { errorEl.textContent = 'Укажите название и размеры в мм'; return; }
    const id = 'c' + Date.now().toString(36);
    editor.hidden = true;
    nameIn.value = wIn.value = hIn.value = '';
    errorEl.textContent = '';
    onChange({ customFormats: [...current.customFormats, { id, name, w, h: hh }], paperId: id });
  }

  function remove() {
    const rest = current.customFormats.filter((x) => x.id !== current.paperId);
    onChange({ customFormats: rest, paperId: rest[0] ? rest[0].id : PAPER_FORMATS[0].id });
  }

  function set(v) {
    current = v;
    select.replaceChildren(
      h('optgroup', { label: 'Стандартные' }, PAPER_FORMATS.map((p) => h('option', { value: p.id }, `${p.name} (${p.w}×${p.h})`))),
      v.customFormats.length ? h('optgroup', { label: 'Свои' }, v.customFormats.map((p) => h('option', { value: p.id }, `${p.name} (${p.w}×${p.h})`))) : null);
    select.value = v.paperId;
    removeBtn.hidden = !v.customFormats.some((x) => x.id === v.paperId);
  }
  set(values);

  const element = h('div', { class: 'wide paper' },
    h('label', {}, f.label, select),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => { editor.hidden = !editor.hidden; } }, 'Свой формат…'), removeBtn),
    editor);
  return { element, set };
}

const BUILDERS = { number: numberField, bool: boolField, enum: enumField, text: textField, password: textField, paper: paperField };

/**
 * @param schema   fields {key, label, type, group, ...}; hidden are skipped
 * @returns { element, setValues(values) }
 */
export function renderForm({ schema, values, onChange }) {
  const fields = [];
  const groups = new Map();
  for (const f of schema) {
    if (f.hidden) continue;
    const built = BUILDERS[f.type](f, values, onChange);
    fields.push(built);
    const g = f.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(built.element);
  }
  const element = h('div', { class: 'form' },
    [...groups].map(([title, els]) => h('div', { class: 'card' }, title ? h('h2', {}, title) : null, h('div', { class: 'grid' }, els))));
  return { element, setValues: (v) => fields.forEach((f) => f.set(v)) };
}
