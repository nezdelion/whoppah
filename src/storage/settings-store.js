// SettingsStore interface: { load(key): Promise<obj|null>, save(key, obj, op?): Promise<void|obj> }.
// The "profiles" key holds the machine profiles collection; op says what changed in it (a server store sends just that),
// local stores write the whole document. "profile" is the single profile of earlier versions: read once by the migration, kept.

export const SECTIONS = Object.freeze(['profiles', 'calibration', 'job', 'presets']);
export const LEGACY_KEY = 'neptune-plotter.settings';

export class LocalStorageStore {
  constructor(storage = globalThis.localStorage, prefix = 'neptune-plotter.v2.') {
    this.storage = storage;
    this.prefix = prefix;
  }

  async load(key) {
    try {
      const raw = this.storage.getItem(this.prefix + key);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  async save(key, obj) {
    try {
      this.storage.setItem(this.prefix + key, JSON.stringify(obj));
    } catch (e) { /* storage unavailable or full: work without saving */ }
  }
}

export class MemoryStore {
  constructor(initial = {}) { this.data = new Map(Object.entries(initial)); }
  async load(key) { return this.data.has(key) ? structuredClone(this.data.get(key)) : null; }
  async save(key, obj) { this.data.set(key, structuredClone(obj)); }
}

const LEGACY_Z_TOUCH = 8; // the old version had no touch; the working calibration is 8.0

const pick = (src, map) => {
  const out = {};
  for (const [from, to] of Object.entries(map)) if (src[from] !== undefined) out[to] = src[from];
  return out;
};

/** Old flat settings object -> sections of the new format. A pure function. */
export function convertLegacySettings(old) {
  const round = (v) => Math.round(v * 1000) / 1000;
  const offset = (abs) => (typeof abs === 'number' ? round(abs - LEGACY_Z_TOUCH) : undefined);
  const profile = {
    ...pick(old, { fDraw: 'fDraw', fTravel: 'fTravel', fZUp: 'fZUp', fZDown: 'fZDown',
      limX0: 'limX0', limX1: 'limX1', limY0: 'limY0', limY1: 'limY1', home: 'home', motorsOff: 'motorsOff' }),
    zDownOffset: offset(old.zDown), zUpOffset: offset(old.zUp),
    zStartOffset: offset(old.zStart), zEndOffset: offset(old.zEnd),
  };
  for (const k of Object.keys(profile)) if (profile[k] === undefined) delete profile[k];

  const calibration = { ...pick(old, { cornerX: 'cornerX', cornerY: 'cornerY' }), zTouch: LEGACY_Z_TOUCH, updatedAt: null };

  // simplification is off so that the G-code stays the same
  const job = { ...pick(old, { margin: 'marginMm', halign: 'halign', valign: 'valign', rotate: 'rotate', mergeTol: 'mergeTolMm' }), simplifyTolMm: 0 };
  if (old.fieldW > 0 && old.fieldH > 0) {
    // storage does not know core, so the standard own format is duplicated here
    const formats = [{ id: 'work', name: 'Work area', w: 180, h: 180 }];
    let selected = formats.find((f) => f.w === old.fieldW && f.h === old.fieldH);
    if (!selected) {
      selected = { id: 'migrated', name: 'Migrated', w: old.fieldW, h: old.fieldH };
      formats.push(selected);
    }
    job.customFormats = formats;
    job.paperId = selected.id;
    job.orientation = old.fieldW > old.fieldH ? 'landscape' : 'portrait';
  }
  const connection = pick(old, { opUrl: 'url', opKey: 'key' });
  return { profile, calibration, job, connection };
}

/**
 * One-time migration of the old page settings; the old key is removed.
 * Already existing sections of the new format are not overwritten.
 * @returns true if old settings were found
 */
export async function migrateLegacy(storage, store) {
  let raw;
  try { raw = storage.getItem(LEGACY_KEY); } catch (e) { return false; }
  if (raw === null) return false;
  try {
    const old = JSON.parse(raw);
    if (old && typeof old === 'object') {
      const sections = convertLegacySettings(old);
      for (const [key, value] of Object.entries(sections)) {
        if (await store.load(key) === null) await store.save(key, value);
      }
    }
  } catch (e) { /* a corrupted old key is simply removed */ }
  try { storage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
  return true;
}

/**
 * One-time migration of the single machine profile into the profiles collection (standalone; the plugin server does it itself).
 * build(profileValues | null) → collection (core fromLegacy: one active profile "Neptune 3 Pro", the bed not measured).
 * Idempotent; the old "profile" key stays (rollback). The stored calibration gets the created profile id on both parts,
 * so the upgrade does not report "the profile changed".
 * @returns true if the collection was created
 */
export async function migrateProfiles(store, build) {
  const existing = await store.load('profiles');
  if (existing && typeof existing === 'object' && Array.isArray(existing.items) && existing.items.length) return false;
  const col = build(await store.load('profile'));
  await store.save('profiles', col);
  const cal = await store.load('calibration');
  if (cal && typeof cal === 'object' && (cal.profileXY == null || cal.profileZ == null)) {
    await store.save('calibration', { ...cal, profileXY: cal.profileXY ?? col.activeId, profileZ: cal.profileZ ?? col.activeId });
  }
  return true;
}
