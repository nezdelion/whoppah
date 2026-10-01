// A small store: settings, the current drawing, subscriptions. No DOM, works on top of SettingsStore.
import { SCHEMAS, defaultsOf, normalize } from '../core/profile.js';
import { fieldOf } from '../core/pipeline.js';

export const CONNECTION_DEFAULTS = Object.freeze({ url: 'http://localhost:5000', key: '' });

const clone = (v) => structuredClone(v);
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));

/**
 * stampEdit — optional (changes) => extra: an addition to a calibration edit that is not in the edit itself
 * (standalone sets the current coordinate epoch on a part at manual input; in the plugin the server sets epochs).
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

  const api = {
    async load() {
      for (const section of Object.keys(settings)) settings[section] = normalizeSection(section, await store.load(section));
      emit({ type: 'settings', section: '*' });
    },

    get: (section) => settings[section],
    settings: () => ({ profile: settings.profile, calibration: settings.calibration, job: settings.job }),

    /** Merging a change into a section; the calibration gets a modification date. */
    async patch(section, changes) {
      const next = { ...settings[section], ...changes };
      if (section === 'calibration' && stampEdit) Object.assign(next, stampEdit(changes), pick(changes, ['epochXY', 'epochZ']));
      if (section === 'calibration' && !('updatedAt' in changes)) next.updatedAt = now();
      edits[section] = (edits[section] || 0) + 1;
      settings[section] = normalizeSection(section, next);
      emit({ type: 'settings', section });
      await persist(section);
    },

    async reset(section) {
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
        const parts = [[['cornerX', 'cornerY'], 'epochXY'], [['zTouch'], 'epochZ']];
        next = { ...cur };
        const keepLocal = unsaved('calibration');
        for (const [keys, epochKey] of parts) {
          if (keys.every((k) => cur[k] === incoming[k])) next[epochKey] = incoming[epochKey];
          else if (keepLocal) next[epochKey] = null;
          else { for (const k of keys) next[k] = incoming[k]; next[epochKey] = incoming[epochKey]; }
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
