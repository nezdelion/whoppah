// A form from the field schema (core/profile.js): a grid of cards by group, range checks, paper format choice.
import { h, button, disclosure } from './dom.js';
import { PAPER_FORMATS, paperLabel } from '../../core/layout.js';
import { t } from '../../i18n/index.js';

const labelText = (f) => (f.unit ? `${f.label}, ${f.unit}` : f.label);

function numberField(f, values, onChange) {
  const input = h('input', { type: 'number', step: 'any', value: values[f.key] });
  if (f.min !== undefined) input.min = f.min;
  if (f.max !== undefined) input.max = f.max;
  input.addEventListener('input', () => {
    const v = parseFloat(input.value);
    const valid = Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    input.classList.toggle('invalid', !valid);
    input.title = valid ? '' : t('form.range', { label: f.label, min: f.min ?? '−∞', max: f.max ?? '∞' });
    if (valid) onChange({ [f.key]: v });
  });
  return {
    element: h('label', {}, labelText(f), input),
    set(v) { if (document.activeElement !== input) { input.value = v[f.key]; input.classList.remove('invalid'); } },
  };
}

function boolField(f, values, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!values[f.key], onchange: () => onChange({ [f.key]: input.checked }) });
  // warn — the ⚠ sign: details on hover, and on tap (phone) as text under the checkbox; tapping does not toggle the checkbox
  let warn = null, text = null;
  if (f.warn) ({ icon: warn, text } = disclosure('⚠', f.warn, { iconClass: 'warn-icon', textClass: 'warn-text' }));
  const body = warn ? [h('span', { class: 'check-text' }, f.label, ' ', warn), text] : [f.label];
  return { element: h('label', { class: 'check wide' + (warn ? ' has-warn' : '') }, input, ...body), set(v) { input.checked = !!v[f.key]; } };
}

function enumField(f, values, onChange) {
  const select = h('select', { onchange: () => onChange({ [f.key]: select.value }) },
    Object.entries(f.options).map(([v, text]) => h('option', { value: v }, text)));
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
  const removeBtn = button({ label: t('form.paper.remove'), hint: 'form.paper.remove.hint', onclick: () => remove() });
  const nameIn = h('input', { placeholder: t('form.paper.name') });
  const wIn = h('input', { type: 'number', step: 'any', min: 1, placeholder: t('form.paper.width') });
  const hIn = h('input', { type: 'number', step: 'any', min: 1, placeholder: t('form.paper.height') });
  const errorEl = h('div', { class: 'warn' });
  const editor = h('div', { class: 'paper-editor', hidden: true },
    h('div', { class: 'grid' }, h('label', { class: 'wide' }, t('form.paper.name'), nameIn), h('label', {}, t('form.paper.width'), wIn), h('label', {}, t('form.paper.height'), hIn)),
    errorEl,
    h('div', { class: 'row' },
      button({ label: t('form.paper.add'), hint: 'form.paper.add.hint', class: 'primary', onclick: () => add() }),
      button({ label: t('common.cancel'), hint: 'form.paper.cancel.hint', onclick: () => { editor.hidden = true; } })));

  function add() {
    const w = parseFloat(wIn.value), hh = parseFloat(hIn.value), name = nameIn.value.trim();
    if (!name || !(w > 0) || !(hh > 0)) { errorEl.textContent = t('form.paper.invalid'); return; }
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
      h('optgroup', { label: t('form.paper.standard') }, PAPER_FORMATS.map((p) => h('option', { value: p.id }, `${paperLabel(p)} (${p.w}×${p.h})`))),
      v.customFormats.length ? h('optgroup', { label: t('form.paper.custom') }, v.customFormats.map((p) => h('option', { value: p.id }, `${paperLabel(p)} (${p.w}×${p.h})`))) : null);
    select.value = v.paperId;
    removeBtn.hidden = !v.customFormats.some((x) => x.id === v.paperId);
  }
  set(values);

  const element = h('div', { class: 'wide paper' },
    h('label', {}, f.label, select),
    h('div', { class: 'row' }, button({ label: t('form.paper.new'), hint: 'form.paper.new.hint', onclick: () => { editor.hidden = !editor.hidden; } }), removeBtn),
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
