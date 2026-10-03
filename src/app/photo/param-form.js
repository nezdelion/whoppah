// The layer parameter form built only from the style parameter description.
import { h } from '../ui/dom.js';
import { optionText, matchPreset } from '../../styles/own/kit/params.js';
import { t } from '../../i18n/index.js';

const decimals = (step) => (String(step).split('.')[1] || '').length;

/**
 * @param descs  [{key,label,type,min,max,step,options,optionLabel?,default,live}]; select options are shown by optionLabel(value)
 * @param values current values (key -> value)
 * @param onChange (key, value) => void
 */
export function buildParamForm(descs, values, onChange) {
  const rows = descs.map((d) => {
    if (d.type === 'bool') {
      const box = h('input', { type: 'checkbox', checked: !!values[d.key], onchange: () => onChange(d.key, box.checked) });
      return h('label', { class: 'check' }, box, d.label);
    }
    if (d.type === 'select') {
      const sel = h('select', { onchange: () => onChange(d.key, sel.value) },
        d.options.map((o) => h('option', { value: o, selected: o === values[d.key] }, optionText(d, o))));
      return h('label', {}, d.label, sel);
    }
    const step = d.step || 1;
    const range = h('input', { type: 'range', min: d.min, max: d.max, step, value: values[d.key] });
    const num = h('input', { type: 'number', min: d.min, max: d.max, step, value: values[d.key], inputMode: 'decimal' });
    const commit = (raw) => {
      const v = Number(raw);
      if (!Number.isFinite(v) || raw === '') { num.classList.add('invalid'); return; }
      num.classList.remove('invalid');
      const clamped = Math.min(d.max, Math.max(d.min, v));
      const fixed = Number(clamped.toFixed(Math.max(decimals(step), 0)));
      range.value = String(fixed);
      if (document.activeElement !== num) num.value = String(fixed);
      onChange(d.key, fixed);
    };
    range.addEventListener('input', () => { num.value = range.value; commit(range.value); });
    num.addEventListener('input', () => commit(num.value));
    num.addEventListener('change', () => { num.value = range.value; num.classList.remove('invalid'); });
    return h('label', { class: 'param' }, d.label, h('div', { class: 'param-inputs' }, range, num));
  });
  return h('div', { class: 'grid param-grid' }, rows);
}

/**
 * The "Preset" row of a layer card: "—" and the style presets (descriptor presets). The preset whose values (defaults
 * overlaid with the preset) equal the current ones is shown selected, otherwise "—".
 * @param onPick (presetId) => void — called when a preset is chosen ("—" does nothing)
 * @returns { el, select, sync(values) } — sync after any parameter change
 */
export function buildPresetPicker(descs, presets, values, onPick) {
  const select = h('select', { onchange: () => { if (select.value) onPick(select.value); } },
    h('option', { value: '' }, t('photo.stylePreset.none')),
    presets.map((p) => h('option', { value: p.id }, p.label)));
  const sync = (v) => { select.value = matchPreset(descs, presets, v); };
  sync(values);
  return { el: h('label', { class: 'preset' }, t('photo.stylePreset'), select), select, sync };
}
