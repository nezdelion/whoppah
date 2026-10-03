// Parameter descriptions and style presets of own styles with translated, lazily computed labels (the language can change
// at any time without rebuilding the descriptors). Pure, no DOM.
//
// Keys: the parameter label is t(`${prefix}.param.${key}`), the option label of a select is t(`${prefix}.${key}.${value}`),
// the preset name is t(`${prefix}.preset.${id}`). Every key must exist in en.js and ru.js (tests/own-styles.test.js checks it).
import { t } from '../../../i18n/index.js';

/**
 * @returns (def) => descriptor: def = { key, type: 'number'|'bool'|'select', min, max, step, options, default, live }
 *   plus the lazy label and, for a select, optionLabel(value)
 */
export function paramFactory(prefix) {
  return (def) => {
    const d = Object.defineProperty({ ...def }, 'label', { get: () => t(`${prefix}.param.${def.key}`), enumerable: true });
    if (def.type === 'select' && !def.optionLabel) d.optionLabel = (value) => t(`${prefix}.${def.key}.${value}`);
    return d;
  };
}

/** @returns (id, params) => { id, label (lazy), params: partial values over the defaults } */
export function presetFactory(prefix) {
  return (id, params) => Object.defineProperty({ id, params: Object.freeze({ ...params }) }, 'label', { get: () => t(`${prefix}.preset.${id}`), enumerable: true });
}

/** The shown text of a select option: optionLabel(value) if the description has it, otherwise the value as is. */
export const optionText = (desc, value) => (desc && typeof desc.optionLabel === 'function' ? desc.optionLabel(value) : String(value));

/** The full parameter values of a preset: the defaults of every parameter overlaid with the preset values. */
export function presetValues(descs, preset) {
  const out = Object.fromEntries(descs.map((d) => [d.key, d.default]));
  for (const [k, v] of Object.entries((preset && preset.params) || {})) if (k in out) out[k] = v;
  return out;
}

const equalValue = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

/** The id of the preset whose full values equal the current ones, or '' (none — shown as "—"). */
export function matchPreset(descs, presets, values) {
  for (const p of presets || []) {
    const full = presetValues(descs, p);
    if (descs.every((d) => equalValue(full[d.key], values[d.key]))) return p.id;
  }
  return '';
}
