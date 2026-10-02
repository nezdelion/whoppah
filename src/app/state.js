// A small store: settings, the current drawing, subscriptions. No DOM, works on top of SettingsStore.
import { SCHEMAS, defaultsOf, normalize } from '../core/profile.js';
import { fieldOf } from '../core/pipeline.js';
import {
  normalizeCollection, fromLegacy, activeProfile, findProfile, updateProfileValues,
  createProfile, duplicateProfile, renameProfile, removeProfile, selectProfile, uniqueName,
} from '../core/profiles.js';
import { applyBedPoint } from '../core/bed.js';
import { t } from '../i18n/index.js';

export const CONNECTION_DEFAULTS = Object.freeze({ url: 'http://localhost:5000', key: '' });

const clone = (v) => structuredClone(v);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/**
 * stampEdit — optional (changes) => extra: an addition to a calibration edit that is not in the edit itself
 * (standalone sets the current coordinate epoch and the active profile on a part at manual input; in the plugin the server does).
 *
 * Machine profiles: a collection with one active profile; get('profile') is the values of the active one.
 * The store writes the collection with save('profiles', collection, op), op — { kind: 'put'|'delete'|'active', id } or none (all);
 * a server store returns its collection (revisions), a 409 means another device changed the profile.
 */
export function createState({ store, now = () => new Date().toISOString(), stampEdit = null }) {
  const settings = {
    profile: defaultsOf(SCHEMAS.profile),
    calibration: defaultsOf(SCHEMAS.calibration),
    job: defaultsOf(SCHEMAS.job),
    connection: { ...CONNECTION_DEFAULTS },
  };
  let drawing = null;
  let sourceName = '';
  let drawingSource = null;
  let profiles = fromLegacy(null, { now: now(), id: 'p_00000000' });
  settings.profile = activeProfile(profiles).values;
  // Profile writes go one after another (revisions of the server); value edits of one profile are coalesced.
  let profileQueue = Promise.resolve();
  let profileBusy = 0;
  const valuesQueued = new Map();
  const listeners = new Set();
  // Counters of local edits and written edits per section: independent of merges with the server (adoptCalibration).
  // A section is unwritten while saved < edits (a write is in progress or failed).
  const edits = {}, saved = {};
  const unsaved = (section) => (saved[section] || 0) < (edits[section] || 0);

  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  const normalizeSection = (section, values) => (section === 'connection'
    ? { ...CONNECTION_DEFAULTS, ...(values || {}) }
    : normalize(SCHEMAS[section], values));

  // A storage failure (the server did not accept the write) must not break operation: the value stays in memory, the UI gets an event.
  const persist = async (section) => {
    const n = edits[section];
    try { await store.save(section, settings[section]); } catch (e) {
      emit({ type: 'save-error', section, message: e.message });
      return;
    }
    saved[section] = Math.max(saved[section] || 0, n);
    emit({ type: 'saved', section });
  };

  // A calibration part entered, captured or confirmed now belongs to the active profile (the server does the same in the plugin).
  const profileStamp = (changes) => {
    const out = {};
    if (['cornerX', 'cornerY', 'epochXY'].some((k) => k in changes) && !('profileXY' in changes)) out.profileXY = profiles.activeId;
    if (['zTouch', 'epochZ'].some((k) => k in changes) && !('profileZ' in changes)) out.profileZ = profiles.activeId;
    return out;
  };

  const syncActive = () => { settings.profile = activeProfile(profiles).values; };

  /** A collection document read from the store; without one — the single profile of earlier versions, in memory only. */
  async function readProfiles() {
    const col = normalizeCollection(await store.load('profiles'));
    return col || fromLegacy(await store.load('profile'), { now: now() });
  }

  function setProfiles(next) {
    const before = JSON.stringify(settings.profile);
    profiles = next;
    syncActive();
    emit({ type: 'settings', section: 'profiles' });
    if (JSON.stringify(settings.profile) !== before) emit({ type: 'settings', section: 'profile' });
  }

  const enqueue = (fn) => {
    profileBusy++;
    const run = profileQueue.then(fn).finally(() => { profileBusy--; });
    profileQueue = run.catch(() => {});
    return run;
  };

  /** The store's answer: revisions from the server; values of a profile with a queued edit stay local (they are newer). */
  function adoptStored(doc) {
    const col = normalizeCollection(doc);
    if (!col) return;
    col.items = col.items.map((p) => {
      const local = findProfile(profiles, p.id);
      return local && valuesQueued.has(p.id) ? { ...p, values: local.values } : p;
    });
    if (JSON.stringify(col) !== JSON.stringify(profiles)) setProfiles(col);
  }

  // A write of the profiles: { ok, message }. A failed value edit stays in memory (as for the other sections),
  // a failed structural change and a conflict reread the collection.
  async function writeProfiles(op, { revert = false } = {}) {
    const n = edits.profile || 0;
    try {
      adoptStored(await store.save('profiles', profiles, op));
    } catch (e) {
      const conflict = e && e.status === 409;
      if (conflict || revert) { try { setProfiles(await readProfiles()); } catch (e2) { /* keep the local collection */ } }
      const message = conflict ? t('profiles.conflict') : e.message;
      emit({ type: 'save-error', section: 'profile', message });
      return { ok: false, message };
    }
    saved.profile = Math.max(saved.profile || 0, n);
    emit({ type: 'saved', section: 'profile' });
    return { ok: true, message: '' };
  }

  function queueValues(id) {
    if (valuesQueued.has(id)) return valuesQueued.get(id);
    const run = enqueue(async () => {
      valuesQueued.delete(id);
      return findProfile(profiles, id) ? writeProfiles({ kind: 'put', id }) : { ok: true, message: '' };
    });
    valuesQueued.set(id, run);
    return run;
  }

  /** A structural change of the collection: computed by core, applied at once, written in turn. */
  const structural = (compute, op) => enqueue(async () => {
    const r = compute(profiles);
    if (!r.ok) return { ok: false, message: r.message };
    edits.profile = (edits.profile || 0) + 1;
    setProfiles(r.collection);
    const w = await writeProfiles(op(r), { revert: true });
    if (!w.ok) return w;
    return { ok: true, id: r.id, message: r.activeChanged ? t('profiles.nowActive', { name: r.activeName }) : '' };
  });

  async function patchProfile(changes) {
    const id = profiles.activeId;
    const r = updateProfileValues(profiles, id, changes, { now: now() });
    if (!r.ok) {
      emit({ type: 'save-error', section: 'profile', message: r.message });
      return { ok: false, message: r.message };
    }
    edits.profile = (edits.profile || 0) + 1;
    setProfiles(r.collection);
    return queueValues(id);
  }

  const api = {
    async load() {
      profiles = await readProfiles();
      syncActive();
      for (const section of ['calibration', 'job', 'connection']) settings[section] = normalizeSection(section, await store.load(section));
      emit({ type: 'settings', section: '*' });
    },

    /** The machine profiles collection and its active profile id. */
    profiles: () => profiles,
    activeProfileId: () => profiles.activeId,

    createProfile: (name) => structural((col) => createProfile(col, { name, now: now() }), (r) => ({ kind: 'put', id: r.id })),
    duplicateProfile: (id) => structural((col) => duplicateProfile(col, id, { now: now() }), (r) => ({ kind: 'put', id: r.id })),
    renameProfile: (id, name) => structural((col) => renameProfile(col, id, name, { now: now() }), () => ({ kind: 'put', id })),
    removeProfile: (id) => structural((col) => removeProfile(col, id), () => ({ kind: 'delete', id })),
    selectProfile: (id) => structural((col) => selectProfile(col, id), () => ({ kind: 'active', id })),
    /** A suggested unique name for a new profile. */
    suggestProfileName: (base) => uniqueName(base, profiles.items),

    /** One bed corner ('ll' | 'ur') of the active profile: { ok, message }. */
    async setBedPoint(which, point) {
      const r = applyBedPoint(settings.profile, which, point);
      if (!r.ok) return { ok: false, message: r.message };
      return patchProfile(r.changes);
    },

    /**
     * The collection from the server poll (another device changed a profile or the active one). Skipped while our own
     * write is queued or in progress: its answer brings the server collection anyway.
     */
    adoptProfiles(doc) {
      if (profileBusy > 0) return;
      const col = normalizeCollection(doc);
      if (!col || JSON.stringify(col) === JSON.stringify(profiles)) return;
      setProfiles(col);
    },

    get: (section) => settings[section],
    settings: () => ({ profile: settings.profile, calibration: settings.calibration, job: settings.job }),

    /** Merging a change into a section; the calibration gets a modification date; profile — the active machine profile ({ ok, message } for it). */
    async patch(section, changes) {
      if (section === 'profile') return patchProfile(changes);
      const next = { ...settings[section], ...changes };
      if (section === 'calibration') Object.assign(next, profileStamp(changes));
      if (section === 'calibration' && stampEdit) Object.assign(next, stampEdit(changes), pick(changes, ['epochXY', 'epochZ', 'profileXY', 'profileZ']));
      if (section === 'calibration' && !('updatedAt' in changes)) next.updatedAt = now();
      edits[section] = (edits[section] || 0) + 1;
      settings[section] = normalizeSection(section, next);
      emit({ type: 'settings', section });
      await persist(section);
    },

    async reset(section) {
      if (section === 'profile') { await patchProfile(defaultsOf(SCHEMAS.profile)); return; }
      edits[section] = (edits[section] || 0) + 1;
      settings[section] = normalizeSection(section, null);
      emit({ type: 'settings', section });
      await persist(section);
    },

    /**
     * Accept a calibration written or computed by the server (capture, confirmation, epochs), without writing it back.
     * merge: merging on poll. Values and their epoch are accepted together, per part (xy: corner + epochXY; z: touch + epochZ).
     * Edits are written to the server immediately, so a mismatch without an unwritten edit is a capture in another tab: take the server's.
     * If our own edit is not yet written (a write is in progress or failed), the local values stay, and the part epoch
     * is reset to null: the part is considered outdated, printing will warn instead of taking old coordinates for fresh ones.
     */
    adoptCalibration(doc, { merge = false } = {}) {
      const incoming = normalizeSection('calibration', doc);
      let next = incoming;
      if (merge) {
        const cur = settings.calibration;
        const parts = [[['cornerX', 'cornerY'], 'epochXY', 'profileXY'], [['zTouch'], 'epochZ', 'profileZ']];
        next = { ...cur };
        const keepLocal = unsaved('calibration');
        for (const [keys, epochKey, profileKey] of parts) {
          if (keys.every((k) => cur[k] === incoming[k])) { next[epochKey] = incoming[epochKey]; next[profileKey] = incoming[profileKey]; }
          else if (keepLocal) next[epochKey] = null;
          else { for (const k of keys) next[k] = incoming[k]; next[epochKey] = incoming[epochKey]; next[profileKey] = incoming[profileKey]; }
        }
      }
      if (JSON.stringify(next) === JSON.stringify(settings.calibration)) return;
      settings.calibration = next;
      emit({ type: 'settings', section: 'calibration' });
    },

    /** A report of a failed write from places that write to storage themselves (source presets). */
    saveFailed(section, message) { emit({ type: 'save-error', section, message }); },

    /** source — the id of the source tab that emitted the drawing: only it may recompute it automatically. */
    setDrawing(next, name = '', source = null) {
      drawing = next;
      drawingSource = source;
      sourceName = name || (next && next.meta.name) || '';
      emit({ type: 'drawing' });
    },
    drawing: () => drawing,
    drawingSource: () => drawingSource,
    sourceName: () => sourceName,

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Read-only: what a drawing source needs from the print parameters. */
    printParams() {
      const { job, profile } = settings;
      return { fieldMm: fieldOf(job), marginMm: job.marginMm, rotate: job.rotate, penWidthMm: profile.penWidthMm };
    },
  };
  return api;
}

/**
 * A narrow context for a drawing source: emitting a drawing, its own presets, reading print parameters.
 * A source sees neither the whole state, nor the storage, nor the transport.
 */
export function createSourceContext({ state, store, sourceId }) {
  return {
    emit: (drawing) => state.setDrawing(drawing, '', sourceId),
    /** The current drawing was emitted by this source (otherwise its auto-recompute would overwrite another tab's drawing). */
    ownsDrawing: () => state.drawingSource() === sourceId,
    presets: {
      async load() {
        const all = await store.load('presets');
        return all && all[sourceId] !== undefined ? clone(all[sourceId]) : null;
      },
      async save(obj) {
        const all = (await store.load('presets')) || {};
        all[sourceId] = clone(obj);
        try { await store.save('presets', all); } catch (e) { state.saveFailed('presets', e.message); }
      },
    },
    printParams: {
      get: () => clone(state.printParams()),
      subscribe(fn) {
        let last = JSON.stringify(state.printParams());
        return state.subscribe((event) => {
          if (event.type !== 'settings') return;
          const params = state.printParams();
          const key = JSON.stringify(params);
          if (key === last) return;
          last = key;
          fn(clone(params));
        });
      },
    },
  };
}
