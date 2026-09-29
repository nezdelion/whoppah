// Settings file {format, version, sections}: transfer between devices and modes.
import { SECTIONS } from './settings-store.js';

export const FILE_FORMAT = 'neptune-plotter-settings';
export const FILE_VERSION = 1;

export class SettingsFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SettingsFileError';
  }
}

export const SECTION_LABELS = Object.freeze({
  profile: 'Профиль машины', calibration: 'Калибровка', job: 'Параметры задания', presets: 'Пресеты источников',
});

/** @param sections { profile, calibration, job, presets? } */
export function serializeSettings(sections) {
  const out = {};
  for (const key of SECTIONS) if (sections[key] != null) out[key] = sections[key];
  return JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION, sections: out }, null, 2);
}

/** Parsing and structure validation; returns { sections } with known sections only. */
export function parseSettings(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new SettingsFileError('файл настроек повреждён: это не JSON'); }
  if (!data || data.format !== FILE_FORMAT) throw new SettingsFileError('это не файл настроек Neptune Plotter');
  if (!Number.isInteger(data.version) || data.version < 1) throw new SettingsFileError('в файле нет версии формата');
  if (data.version > FILE_VERSION) throw new SettingsFileError(`версия формата ${data.version} новее поддерживаемой (${FILE_VERSION})`);
  if (!data.sections || typeof data.sections !== 'object' || Array.isArray(data.sections)) throw new SettingsFileError('в файле нет разделов настроек');
  const sections = {};
  for (const key of SECTIONS) {
    const v = data.sections[key];
    if (v === undefined) continue;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new SettingsFileError(`раздел «${SECTION_LABELS[key]}» повреждён`);
    sections[key] = v;
  }
  if (!Object.keys(sections).length) throw new SettingsFileError('в файле нет известных разделов');
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
