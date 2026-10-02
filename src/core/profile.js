// Settings schemas: machine profile, calibration, job parameters. A single source for the form, defaults and validation.
// Schema field: { key, label, type: 'number'|'bool'|'enum'|'paper'|'formats'|'text', unit, min, max, default, group, options?, hidden?, nullable? }
// Texts (label, unit, group, warn, options labels) are computed on access via t(): keys schema.<section>.<key>, schema.group.<id>, unit.<id>.
import { t } from '../i18n/index.js';

/** A schema field with lazily translated texts. def.unit / def.group are identifiers, options is a list of identifiers, warn is a flag. */
function field(ns, def) {
  const f = { ...def };
  const text = (name, get) => Object.defineProperty(f, name, { get, enumerable: true, configurable: true });
  text('label', () => t(`schema.${ns}.${def.key}`));
  if (def.unit) text('unit', () => t(`unit.${def.unit}`));
  if (def.group) {
    text('group', () => t(`schema.group.${def.group}`));
    Object.defineProperty(f, 'groupId', { value: def.group, enumerable: false });
  }
  if (def.warn) text('warn', () => t(`schema.${ns}.${def.key}.warn`));
  if (def.options) text('options', () => Object.fromEntries(def.options.map((o) => [o, t(`schema.${ns}.${def.key}.${o}`)])));
  return f;
}

const num = (ns, key, def, extra = {}) => field(ns, { key, type: 'number', default: def, ...extra });

export const PROFILE_SCHEMA = Object.freeze([
  num('profile', 'penWidthMm', 0.5, { unit: 'mm', min: 0.05, max: 5, group: 'pen' }),
  num('profile', 'zDownOffset', -0.7, { unit: 'mm', min: -10, max: 10, group: 'penZ' }),
  num('profile', 'zUpOffset', 2, { unit: 'mm', min: 0, max: 50, group: 'penZ' }),
  num('profile', 'zStartOffset', 7, { unit: 'mm', min: 0, max: 100, group: 'penZ' }),
  num('profile', 'zEndOffset', 17, { unit: 'mm', min: 0, max: 100, group: 'penZ' }),
  num('profile', 'zClearanceMm', 1, { unit: 'mm', min: 0, max: 20, group: 'penZ' }),
  num('profile', 'fDraw', 3000, { unit: 'mmPerMin', min: 1, group: 'speeds' }),
  num('profile', 'fTravel', 6000, { unit: 'mmPerMin', min: 1, group: 'speeds' }),
  num('profile', 'fZUp', 1200, { unit: 'mmPerMin', min: 1, group: 'speeds' }),
  num('profile', 'fZDown', 600, { unit: 'mmPerMin', min: 1, group: 'speeds' }),
  num('profile', 'accelXY', 500, { unit: 'mmPerS2', min: 1, group: 'speeds' }),
  num('profile', 'accelZ', 100, { unit: 'mmPerS2', min: 1, group: 'speeds' }),
  num('profile', 'limX0', -4, { unit: 'mm', group: 'limits' }),
  num('profile', 'limX1', 234, { unit: 'mm', group: 'limits' }),
  num('profile', 'limY0', 1, { unit: 'mm', group: 'limits' }),
  num('profile', 'limY1', 231, { unit: 'mm', group: 'limits' }),
  field('profile', { key: 'home', type: 'bool', default: false, group: 'file', warn: true }),
  field('profile', { key: 'motorsOff', type: 'bool', default: true, group: 'file' }),
  // the mesh fade (Z10 on the Neptune 3 Pro) turns off compensation above the pen touch; Z0 — compensation at any height, until the printer reboots
  field('profile', { key: 'meshNoFade', type: 'bool', default: false, group: 'file', warn: true }),
  // bed rectangle in nozzle coordinates: the nozzle when the pen is at the lower left / upper right bed corner; null — not measured.
  // Set by the bed points (not by the general form); either all four or none, x0 < x1, y0 < y1 (bedErrors).
  ...['bedX0', 'bedY0', 'bedX1', 'bedY1'].map((key) => num('profile', key, null, { unit: 'mm', hidden: true, nullable: true })),
  // the upper right corner is "lower left + nominal size", not measured
  field('profile', { key: 'bedUrNominal', type: 'bool', default: false, hidden: true }),
  // nominal bed size: only prefills the bed points until they are measured
  num('profile', 'bedW', 235, { unit: 'mm', min: 10, max: 1000, group: 'bed' }),
  num('profile', 'bedH', 235, { unit: 'mm', min: 10, max: 1000, group: 'bed' }),
]);

export const CALIBRATION_SCHEMA = Object.freeze([
  num('calibration', 'cornerX', -5, { unit: 'mm', group: 'corner' }),
  num('calibration', 'cornerY', 50, { unit: 'mm', group: 'corner' }),
  num('calibration', 'zTouch', 8, { unit: 'mm', min: 0, max: 300, group: 'height' }),
  field('calibration', { key: 'updatedAt', type: 'text', default: null, hidden: true }),
  // printer coordinate epochs at which a calibration part was captured, entered or confirmed (written by the plugin server)
  field('calibration', { key: 'epochXY', type: 'number', default: null, hidden: true }),
  field('calibration', { key: 'epochZ', type: 'number', default: null, hidden: true }),
  // the active machine profile id at the last capture, input or confirmation of a part (the pen holder is part of the profile)
  field('calibration', { key: 'profileXY', type: 'text', default: null, hidden: true }),
  field('calibration', { key: 'profileZ', type: 'text', default: null, hidden: true }),
]);

// The name of the built-in "work area" is taken from the dictionary (paper.work) for display, the stored name is a fallback.
export const DEFAULT_CUSTOM_FORMATS = Object.freeze([{ id: 'work', name: 'Work area', w: 180, h: 180 }]);

export const JOB_SCHEMA = Object.freeze([
  field('job', { key: 'paperId', type: 'paper', default: 'work', group: 'sheet' }),
  field('job', { key: 'orientation', type: 'enum', default: 'portrait', group: 'sheet', options: ['portrait', 'landscape'] }),
  num('job', 'marginMm', 5, { unit: 'mm', min: 0, group: 'sheet' }),
  field('job', { key: 'halign', type: 'enum', default: 'center', group: 'align', options: ['left', 'center', 'right'] }),
  field('job', { key: 'valign', type: 'enum', default: 'center', group: 'align', options: ['top', 'center', 'bottom'] }),
  field('job', { key: 'rotate', type: 'bool', default: false, group: 'align' }),
  field('job', { key: 'asIs', type: 'bool', default: false, group: 'align' }),
  // fit into (sheet field − margins) ∩ print area; risky is the "off" state, the warn text says so
  field('job', { key: 'fitPrintArea', type: 'bool', default: true, group: 'align', warn: true }),
  num('job', 'simplifyTolMm', 0.05, { unit: 'mm', min: 0, group: 'optimize' }),
  num('job', 'mergeTolMm', 0.05, { unit: 'mm', min: 0, group: 'optimize' }),
  // hatching: adjacent parallel strokes are joined by a drawn transition — without lifting and lowering the pen (Z is slow)
  // the transition is visible on paper (at the hatching edge it almost merges with the outline); set near the hatching step, 0 — off
  num('job', 'linkTolMm', 0, { unit: 'mm', min: 0, group: 'optimize' }),
  field('job', { key: 'customFormats', type: 'formats', default: DEFAULT_CUSTOM_FORMATS, hidden: true }),
]);

export const SCHEMAS = Object.freeze({ profile: PROFILE_SCHEMA, calibration: CALIBRATION_SCHEMA, job: JOB_SCHEMA });

const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

export function defaultsOf(schema) {
  return Object.fromEntries(schema.map((f) => [f.key, clone(f.default)]));
}

function validField(f, v) {
  if (v === null && f.nullable) return true;
  switch (f.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    case 'bool': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string' && Object.hasOwn(f.options, v);
    case 'paper': return typeof v === 'string' && v.length > 0;
    case 'formats':
      return Array.isArray(v) && v.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && x.w > 0 && x.h > 0);
    default: return true;
  }
}

/** List of errors [{key, message}]; empty — the values are valid. */
export function validate(schema, values) {
  const errors = [];
  for (const f of schema) {
    if (f.hidden && f.type !== 'formats') continue;
    const v = values[f.key];
    if (validField(f, v)) continue;
    let message = t('schema.err.invalid');
    if (f.type === 'number') {
      const range = f.min !== undefined ? (f.max !== undefined ? 'both' : 'min') : (f.max !== undefined ? 'max' : 'any');
      message = t(`schema.err.number.${range}`, { label: f.label, min: f.min, max: f.max });
    }
    errors.push({ key: f.key, message });
  }
  return errors;
}

/** Defaults + saved ones; invalid fields are replaced by the default value. */
export function normalize(schema, values) {
  const out = defaultsOf(schema);
  for (const f of schema) {
    if (values && f.key in values && validField(f, values[f.key])) out[f.key] = clone(values[f.key]);
  }
  return out;
}

const BED_KEYS = ['bedX0', 'bedY0', 'bedX1', 'bedY1'];

/** The bed rectangle is set entirely and is not degenerate, or not set at all: [] or [{key, message}]. */
export function bedErrors(values) {
  const v = BED_KEYS.map((k) => values[k]);
  if (v.every((x) => x === null || x === undefined)) return [];
  if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return [{ key: 'bed', message: t('bed.err.partial') }];
  if (!(v[0] < v[2] && v[1] < v[3])) return [{ key: 'bed', message: t('bed.err.degenerate') }];
  return [];
}

/** Profile check: field ranges plus the bed rectangle. */
export const validateProfile = (values) => [...validate(PROFILE_SCHEMA, values), ...bedErrors(values)];

/** A partial or degenerate bed is dropped (not measured): it never reaches the checks half-set. */
export function normalizeProfile(v) {
  const out = normalize(PROFILE_SCHEMA, v);
  if (bedErrors(out).length) { for (const k of BED_KEYS) out[k] = null; out.bedUrNominal = false; }
  return out;
}
export const normalizeCalibration = (v) => normalize(CALIBRATION_SCHEMA, v);
export const normalizeJob = (v) => normalize(JOB_SCHEMA, v);

const round3 = (v) => Math.round(v * 1000) / 1000;

/** Absolute Z: the profile offsets from the touch from the calibration. */
export function absoluteZ(profile, calibration) {
  const t = calibration.zTouch;
  return {
    touch: t,
    down: round3(t + profile.zDownOffset),
    up: round3(t + profile.zUpOffset),
    start: round3(t + profile.zStartOffset),
    end: round3(t + profile.zEndOffset),
    clearance: round3(t + profile.zClearanceMm),
  };
}

export const axisLimits = (p) => ({ x0: p.limX0, x1: p.limX1, y0: p.limY0, y1: p.limY1 });
