// A small store: settings, the current drawing, subscriptions. No DOM, works on top of SettingsStore.
import { SCHEMAS, defaultsOf, normalize } from '../core/profile.js';
import { fieldOf } from '../core/pipeline.js';

export const CONNECTION_DEFAULTS = Object.freeze({ url: 'http://octopi.local', key: '' });

const clone = (v) => structuredClone(v);

export function createState({ store, now = () => new Date().toISOString() }) {
  const settings = {
    profile: defaultsOf(SCHEMAS.profile),
    calibration: defaultsOf(SCHEMAS.calibration),
    job: defaultsOf(SCHEMAS.job),
    connection: { ...CONNECTION_DEFAULTS },
  };
  let drawing = null;
  let sourceName = '';
  const listeners = new Set();

  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  const normalizeSection = (section, values) => (section === 'connection'
    ? { ...CONNECTION_DEFAULTS, ...(values || {}) }
    : normalize(SCHEMAS[section], values));

  // A storage failure (the server did not accept the write) must not break operation: the value stays in memory, the UI gets an event.
  const persist = async (section) => {
    try { await store.save(section, settings[section]); } catch (e) {
      emit({ type: 'save-error', section, message: e.message });
    }
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
      if (section === 'calibration' && !('updatedAt' in changes)) next.updatedAt = now();
      settings[section] = normalizeSection(section, next);
      emit({ type: 'settings', section });
      await persist(section);
    },

    async reset(section) {
      settings[section] = normalizeSection(section, null);
      emit({ type: 'settings', section });
      await persist(section);
    },

    /** A report of a failed write from places that write to storage themselves (source presets). */
    saveFailed(section, message) { emit({ type: 'save-error', section, message }); },

    setDrawing(next, name = '') {
      drawing = next;
      sourceName = name || (next && next.meta.name) || '';
      emit({ type: 'drawing' });
    },
    drawing: () => drawing,
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
    emit: (drawing) => state.setDrawing(drawing),
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
