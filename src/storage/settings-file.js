// Settings file {format, version, sections}: transfer between devices and modes.
// Version 2: the machine profiles collection ("profiles") instead of the single profile; version 1 files are not read.
import { SECTIONS } from './settings-store.js';
import { t } from '../i18n/index.js';

export const FILE_FORMAT = 'neptune-plotter-settings';
export const FILE_VERSION = 2;
const MAX_PROFILES = 20;

export class SettingsFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsFileError';
  }
}

export const SECTION_LABELS = Object.freeze({
  profiles: 'file.section.profiles', calibration: 'file.section.calibration', job: 'file.section.job', presets: 'file.section.presets',
});

/** @param sections { profiles, calibration, job, presets? } */
export function serializeSettings(sections) {
  const out = {};
  for (const key of SECTIONS) if (sections[key] != null) out[key] = sections[key];
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, sections: out }, null, 2);
}

/** The profiles collection shape (the values are checked by the app and the server on write). */
function profilesShape(v) {
  const items = v.items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_PROFILES) return false;
  const ok = items.every((p) => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string' && p.name.trim()
    && p.values && typeof p.values === 'object' && !Array.isArray(p.values));
  return ok && new Set(items.map((p) => p.id)).size === items.length && items.some((p) => p.id === v.activeId);
}

/** Parsing and structure validation; returns { sections } with known sections only. */
export function parseSettings(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new SettingsFileError(t('file.err.notJson')); }
  if (!data || data.format !== FILE_FORMAT) throw new SettingsFileError(t('file.err.notOurs'));
  if (!Number.isInteger(data.version) || data.version < 1) throw new SettingsFileError(t('file.err.noVersion'));
  if (data.version < FILE_VERSION) throw new SettingsFileError(t('file.err.oldVersion'));
  if (data.version > FILE_VERSION) throw new SettingsFileError(t('file.err.newer', { version: data.version, supported: FILE_VERSION }));
  if (!data.sections || typeof data.sections !== 'object' || Array.isArray(data.sections)) throw new SettingsFileError(t('file.err.noSections'));
  const sections = {};
  for (const key of SECTIONS) {
    const v = data.sections[key];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v) || (key === 'profiles' && !profilesShape(v))) {
      throw new SettingsFileError(t('file.err.broken', { section: t(SECTION_LABELS[key]) }));
    }
    sections[key] = v;
  }
  if (!Object.keys(sections).length) throw new SettingsFileError(t('file.err.noKnown'));
  return { sections };
}

/**
 * Writes the chosen sections; parsing has already passed, so on a parse error the storage is not touched.
 * needs(key) -> a string with the missing permission or null: such a section is skipped. A storage failure also skips the section.
 * @returns { applied: string[], skipped: { key, reason }[] }
 */
export async function applySettings(store, parsed, selected = Object.keys(parsed.sections), { needs = () => null } = {}) {
  const applied = [], skipped = [];
  for (const key of selected) {
    if (parsed.sections[key] === undefined) continue;
    const need = needs(key);
    if (need) { skipped.push({ key, reason: need }); continue; }
    try {
      await store.save(key, parsed.sections[key]);
      applied.push(key);
    } catch (e) {
      skipped.push({ key, reason: e.message });
    }
  }
  return { applied, skipped };
}
