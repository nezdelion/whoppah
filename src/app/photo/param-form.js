// The layer parameter form built only from the style parameter description.
import { h } from '../ui/dom.js';

const decimals = (step) => (String(step).split('.')[1] || '').length;

/**
 * @param descs  [{key,label,type,min,max,step,options,default,live}]
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
        d.options.map((o) => h('option', { value: o, selected: o === values[d.key] }, o)));
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
