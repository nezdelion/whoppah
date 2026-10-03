// Model of the "Photo" tab style-layer stack: no DOM and no workers.
// Layer: { uid, styleId, name, visible, params, status: idle|running|partial|done|error, progress, reason, message, note, lines }
// note — a remark of the style that stays with its result (own styles, e.g. "too many lines"), shown like progress
import { createDrawing, SPACE } from '../../core/drawing.js';
import { t, hasKey, fmtNumber } from '../../i18n/index.js';

/** The "intermediate" reason from a style: a dictionary key reason.* is translated, anything else (plotterfun texts) as is. */
export const reasonText = (r) => (typeof r === 'string' && r.startsWith('reason.') ? t(r) : r || '');

/**
 * Style progress in the current language: { key, params } — t(key, params) with numbers formatted for the locale
 * (count stays a number for the plural choice); a string — a dictionary key (own styles) or a plotterfun text as is.
 */
export function progressText(p) {
  if (p && typeof p === 'object' && typeof p.key === 'string') {
    const params = {};
    for (const [k, v] of Object.entries(p.params || {})) params[k] = typeof v === 'number' && k !== 'count' ? fmtNumber(v, { maxFrac: 1 }) : v;
    return t(p.key, params);
  }
  if (typeof p !== 'string') return '';
  return hasKey(p, 'en') ? t(p) : p;
}

export const PRESET_VERSION = 1;
export const SIZE_RANGE = Object.freeze({ min: 200, max: 2000, default: 800 });

export const clampSize = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(SIZE_RANGE.max, Math.max(SIZE_RANGE.min, n)) : SIZE_RANGE.default;
};

/** Parameter values per description: unknown keys are dropped, wrong types and out-of-range values are replaced by the default. */
export function normalizeParams(descs, values = {}) {
  const out = {};
  for (const d of descs) {
    const v = values ? values[d.key] : undefined;
    if (d.type === 'bool') out[d.key] = typeof v === 'boolean' ? v : !!d.default;
    else if (d.type === 'select') out[d.key] = d.options.includes(v) ? v : d.default;
    else out[d.key] = typeof v === 'number' && Number.isFinite(v) && v >= d.min && v <= d.max ? v : d.default;
  }
  return out;
}

export function createLayerStack({ getStyle, uid = (() => { let n = 0; return () => `L${++n}`; })() }) {
  let layers = [];
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  const find = (id) => layers.find((l) => l.uid === id);
  const nameFor = (styleId) => {
    const base = (getStyle(styleId) || { name: styleId }).name;
    const used = new Set(layers.map((l) => l.name));
    let name = base, n = 1;
    while (used.has(name)) name = `${base} ${++n}`;
    return name;
  };

  const api = {
    get layers() { return layers; },
    find,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    add(styleId, { params = {}, name, visible = true } = {}) {
      const layer = { uid: uid(), styleId, name: name || nameFor(styleId), visible, params: { ...params },
        status: 'idle', progress: '', reason: '', message: '', note: '', lines: [] };
      layers = [...layers, layer];
      emit({ type: 'structure', uid: layer.uid });
      return layer;
    },
    remove(id) {
      if (!find(id)) return;
      layers = layers.filter((l) => l.uid !== id);
      emit({ type: 'structure', uid: id });
    },
    /** delta: -1 up (earlier in the drawing), +1 down */
    move(id, delta) {
      const i = layers.findIndex((l) => l.uid === id), j = i + delta;
      if (i < 0 || j < 0 || j >= layers.length) return false;
      const next = [...layers];
      [next[i], next[j]] = [next[j], next[i]];
      layers = next;
      emit({ type: 'structure', uid: id });
      return true;
    },
    rename(id, name) {
      const l = find(id);
      if (!l) return;
      l.name = String(name).trim() || l.name;
      emit({ type: 'meta', uid: id });
    },
    setVisible(id, visible) {
      const l = find(id);
      if (!l || l.visible === !!visible) return;
      l.visible = !!visible;
      emit({ type: 'visibility', uid: id });
    },
    setParams(id, changes) {
      const l = find(id);
      if (!l) return;
      l.params = { ...l.params, ...changes };
      emit({ type: 'params', uid: id, keys: Object.keys(changes) });
    },
    setStyle(id, styleId) {
      const l = find(id);
      if (!l) return;
      l.styleId = styleId; l.params = {};
      api.reset(id);
      emit({ type: 'style', uid: id });
    },
    /** The result is reset: the layer waits for a new computation. */
    reset(id) {
      const l = find(id);
      if (!l) return;
      Object.assign(l, { status: 'idle', progress: '', reason: '', message: '', note: '', lines: [] });
      emit({ type: 'result', uid: id });
    },
    /** State from the runner: {status, progress, lines, reason, message, note} */
    applyResult(id, state) {
      const l = find(id);
      if (!l) return;
      Object.assign(l, { status: state.status, progress: state.progress || '', reason: state.reason || '', message: state.message || '', note: state.note || '', lines: state.lines || [] });
      emit({ type: 'result', uid: id });
    },

    /** Visible layers that are not in the "done" status: [{uid, name, status, reason}] */
    pending() {
      return layers.filter((l) => l.visible && l.status !== 'done')
        .map((l) => ({ uid: l.uid, name: l.name, status: l.status, reason: reasonText(l.reason) || (l.status === 'idle' ? t('photo.layer.notFinishedReason') : l.status === 'error' ? l.message : '') }));
    },

    /** Visible layers with a result -> Drawing (image coordinates). null if there are no lines. */
    toDrawing({ name = '' } = {}) {
      const shown = layers.filter((l) => l.visible && l.lines.length);
      if (!shown.length) return null;
      const reasons = layers.filter((l) => l.visible && l.status !== 'done')
        .map((l) => t('photo.layer.notFinished', { name: l.name }) + (l.reason ? ` (${reasonText(l.reason)})` : l.status === 'error' ? ` (${t('photo.layer.error', { message: l.message })})` : ''));
      const meta = { source: 'photo', name };
      if (reasons.length) meta.partial = { reasons };
      return createDrawing({
        space: SPACE.DOCUMENT,
        layers: shown.map((l) => ({ id: l.uid, name: l.name, lines: l.lines })),
        meta,
      });
    },

    toPreset(workingSize) {
      return { version: PRESET_VERSION, workingSize: clampSize(workingSize),
        layers: layers.map((l) => ({ styleId: l.styleId, name: l.name, visible: l.visible, params: structuredClone(l.params) })) };
    },

    /** Replacing the stack with the preset layers. Returns {workingSize, skipped:[styleId...]}; an invalid preset throws. */
    loadPreset(preset) {
      if (!preset || typeof preset !== 'object' || preset.version !== PRESET_VERSION || !Array.isArray(preset.layers)) {
        throw new Error(t('photo.err.badPreset'));
      }
      const skipped = [];
      layers = [];
      for (const p of preset.layers) {
        if (!p || !getStyle(p.styleId)) { skipped.push(p && p.styleId); continue; }
        api.add(p.styleId, { params: p.params && typeof p.params === 'object' ? p.params : {}, name: typeof p.name === 'string' ? p.name : undefined, visible: p.visible !== false });
      }
      emit({ type: 'structure' });
      return { workingSize: clampSize(preset.workingSize), skipped };
    },
  };
  return api;
}
