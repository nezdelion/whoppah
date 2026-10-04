// "Text" tab parameters: descriptors for buildParamForm (labels t('text.param.<key>'), options t('text.<key>.<value>'))
// and the handwriting presets. The values are layoutText options (src/core/text-layout.js).
import { paramFactory, presetFactory, presetValues } from '../../styles/own/kit/params.js';
import { TEXT_DEFAULTS, ALIGNS } from '../../core/text-layout.js';

const param = paramFactory('text');
const preset = presetFactory('text');

export const TEXT_PARAMS = Object.freeze([
  param({ key: 'sizeMm', type: 'number', min: 1, max: 100, step: 0.5, default: TEXT_DEFAULTS.sizeMm }),
  param({ key: 'letterSpacing', type: 'number', min: -30, max: 100, step: 1, default: TEXT_DEFAULTS.letterSpacing }),
  param({ key: 'lineSpacing', type: 'number', min: 1, max: 4, step: 0.05, default: TEXT_DEFAULTS.lineSpacing }),
  param({ key: 'slant', type: 'number', min: -20, max: 40, step: 1, default: TEXT_DEFAULTS.slant }),
  param({ key: 'variation', type: 'number', min: 0, max: 100, step: 1, default: TEXT_DEFAULTS.variation }),
  param({ key: 'align', type: 'select', options: [...ALIGNS], default: TEXT_DEFAULTS.align }),
  param({ key: 'wrapMm', type: 'number', min: 0, max: 1000, step: 5, default: TEXT_DEFAULTS.wrapMm }),
]);

/** The "handwriting" parameters the presets set (size, lines and alignment stay as they are). */
export const HAND_PARAMS = Object.freeze(TEXT_PARAMS.filter((d) => ['letterSpacing', 'slant', 'variation'].includes(d.key)));

export const TEXT_PRESETS = Object.freeze([
  preset('neat', { variation: 0 }),
  preset('natural', { variation: 40 }),
  preset('hasty', { variation: 80, slant: 6, letterSpacing: -4 }),
]);

export const defaultTextParams = () => Object.fromEntries(TEXT_PARAMS.map((d) => [d.key, d.default]));

/** Stored values -> valid parameters: numbers clamped to their range, unknown select values -> the default. */
export function normalizeTextParams(values) {
  const out = defaultTextParams();
  for (const d of TEXT_PARAMS) {
    const v = values ? values[d.key] : undefined;
    if (d.type === 'select') { if (d.options.includes(v)) out[d.key] = v; continue; }
    if (typeof v === 'number' && Number.isFinite(v)) out[d.key] = Math.min(d.max, Math.max(d.min, v));
  }
  return out;
}

/** The handwriting values of a preset (the other parameters are not part of a preset). */
export function handPresetValues(id) {
  const p = TEXT_PRESETS.find((x) => x.id === id);
  return p ? presetValues(HAND_PARAMS, p) : null;
}
