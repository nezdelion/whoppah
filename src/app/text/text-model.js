// Model of the "Text" tab: the text, the font, the parameters and the variation seed, the fonts (built-in and the user's),
// the drawing, presets, messages. No DOM: the view (tabs/text-tab.js) can be unmounted and mounted again (a live language
// switch) while everything here stays.
//
// Emitting: the drawing goes to the "Print" tab only on "To print" (every emit switches to Print). The text drawing is in
// millimetres and does not depend on the print parameters, so there is no automatic re-emit on their change.
//
// Events of subscribe(fn): { type: 'fonts' } — the font list changed; 'font' — the current font changed or loaded;
// 'drawing' — the text, the parameters or the seed changed; 'state' — values replaced at once (restored preset);
// 'message' — info/warn changed.
import { textDrawing, layoutText } from '../../core/text-layout.js';
import { stats } from '../../core/drawing.js';
import { createFontLoader, BUILTIN_FONTS, DEFAULT_FONT, FALLBACK_FONT } from './font-loader.js';
import { createUserFonts } from './user-fonts.js';
import { normalizeTextParams, defaultTextParams, handPresetValues } from './text-params.js';
import { fmtNumber, t } from '../../i18n/index.js';

export const SAVE_DEBOUNCE_MS = 400;
export const SAMPLE_TEXT = 'Hamburgefonstiv';

const randomSeed = () => 1 + Math.floor(Math.random() * 0x7ffffffe);
const mm = (v) => fmtNumber(v, { maxFrac: 1 });

/**
 * @param loadFont  (id) => Promise<StrokeFont> for the built-in fonts
 * @param userFonts the user font library (user-fonts.js)
 * @param timers    { setTimeout, clearTimeout } — replaced in tests; saveDelay — preset write delay
 * @param newSeed   () => seed for "New variation"
 */
export function createTextModel({
  loadFont = createFontLoader(), userFonts = createUserFonts(),
  timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  saveDelay = SAVE_DEBOUNCE_MS, newSeed = randomSeed,
} = {}) {
  let text = '', fontId = DEFAULT_FONT, params = defaultTextParams(), seed = 1;
  let font = null, fallback = null, fontLoading = 0, userList = [];
  let ctx = null, saveTimer = 0, disposed = false, memo = { key: '', drawing: null };
  const messages = { info: null, warn: null };
  const listeners = new Set();
  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  const say = (name, fn) => { messages[name] = fn; emit({ type: 'message', name }); };

  const isBuiltin = (id) => BUILTIN_FONTS.some((f) => f.id === id);
  const fontOf = (id) => (isBuiltin(id) ? loadFont(id) : userFonts.font(id));

  const toPreset = () => ({ text, fontId, params: { ...params }, seed });
  function persist() {
    if (!ctx) return;
    timers.clearTimeout(saveTimer);
    saveTimer = timers.setTimeout(() => { if (ctx && !disposed) ctx.presets.save(toPreset()); }, saveDelay);
  }

  /** Loads the font of fontId; a newer request wins; a failure goes back to the default font. */
  async function useFont(id) {
    const token = ++fontLoading;
    fontId = id;
    emit({ type: 'font' });
    try {
      const [next, fb] = await Promise.all([fontOf(id), fallback || loadFont(FALLBACK_FONT).catch(() => null)]);
      if (token !== fontLoading || disposed) return;
      font = next;
      fallback = fb;
      emit({ type: 'font' });
      emit({ type: 'drawing' });
    } catch (e) {
      if (token !== fontLoading || disposed) return;
      const message = e.message;
      say('warn', () => t('texttab.fontLoadFailed', { message }));
      if (id !== DEFAULT_FONT) await useFont(DEFAULT_FONT);
    }
  }

  async function refreshFonts() {
    try { userList = await userFonts.list(); } catch (e) { userList = []; }
    if (!disposed) emit({ type: 'fonts' });
  }

  const layoutOpts = () => ({ ...params, seed, fallback: fallback && fallback !== font ? fallback : null });

  const model = {
    text: () => text,
    fontId: () => fontId,
    params: () => ({ ...params }),
    seed: () => seed,
    /** The current font (null while the first one loads). */
    font: () => (font && font.id === fontId ? font : null),
    /** [{ id, name, user: boolean, where? }] — built-in first, then the user's. */
    fonts: () => [
      ...BUILTIN_FONTS.map((f) => ({ id: f.id, name: f.name, user: false })),
      ...userList.map((f) => ({ id: f.id, name: f.name, user: true, where: f.where })),
    ],
    message: (name) => (messages[name] ? messages[name]() : ''),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /** Binding to the source context; the first call restores the saved preset and the font list, later calls change nothing. */
    attach(next) {
      if (disposed || next === ctx) return Promise.resolve();
      const first = !ctx;
      ctx = next;
      if (!first) return Promise.resolve();
      return (async () => {
        let saved = null;
        try { saved = await ctx.presets.load(); } catch (e) { saved = null; }
        await refreshFonts();
        if (saved && typeof saved === 'object' && !disposed) {
          if (typeof saved.text === 'string') text = saved.text;
          params = normalizeTextParams(saved.params);
          if (Number.isInteger(saved.seed) && saved.seed > 0) seed = saved.seed;
          emit({ type: 'state' });
          const known = model.fonts().some((f) => f.id === saved.fontId);
          await useFont(known ? saved.fontId : DEFAULT_FONT);
        } else await useFont(fontId);
      })();
    },

    setText(value) {
      if (value === text) return;
      text = String(value);
      emit({ type: 'drawing' });
      persist();
    },

    setFont(id) {
      if (!model.fonts().some((f) => f.id === id)) return Promise.resolve();
      persist();
      say('warn', null);
      return useFont(id);
    },

    setParams(changes) {
      params = normalizeTextParams({ ...params, ...changes });
      emit({ type: 'drawing' });
      persist();
    },

    /** A handwriting preset: letter spacing, slant and "like by hand" (size, lines and alignment stay). */
    applyPreset(id) {
      const values = handPresetValues(id);
      if (!values) return false;
      model.setParams(values);
      return true;
    },

    /** Another random handwriting for the same text. */
    newVariation() {
      let next = newSeed();
      if (next === seed) next = seed + 1;
      seed = next;
      emit({ type: 'drawing' });
      persist();
    },

    /** The drawing of the current text (memoized), or null while no font is loaded. */
    drawing() {
      const f = model.font();
      if (!f) return null;
      const key = JSON.stringify([text, fontId, params, seed, !!fallback]);
      if (memo.key !== key || memo.font !== f) memo = { key, font: f, drawing: textDrawing(text, f, layoutOpts()) };
      return memo.drawing;
    },

    /** The font sample lines (mm, cap height 5) of a font that is loaded, or null. */
    sample() {
      const f = model.font();
      return f ? layoutText(SAMPLE_TEXT, f, { sizeMm: 5, fallback: fallback && fallback !== f ? fallback : null }).lines : null;
    },

    /** "To print": emits the drawing once. Returns true if emitted. */
    sendToPrint() {
      const d = model.drawing();
      if (!d || !ctx || !stats(d).lines) return false;
      const { w, h } = d.meta.physicalSize, name = d.meta.name;
      say('info', () => t('texttab.sent', { name, w: mm(w), h: mm(h) }));
      ctx.emit(d);
      return true;
    },

    /** Adds a font file; on success it becomes the current font. Returns { ok, message }. */
    async addFontFile(file) {
      if (!file) return { ok: false, message: '' };
      let r;
      try { r = await userFonts.add(file); } catch (e) {
        const message = e.message;
        say('warn', () => t('texttab.fontRejected', { message }));
        return { ok: false, message: model.message('warn') };
      }
      say('warn', r.warnings.length ? () => r.warnings.join('\n') : null);
      say('info', () => [t('texttab.fontAdded', { name: r.name, count: r.glyphs }), r.note()].filter(Boolean).join(' '));
      await refreshFonts();
      persist();
      await useFont(r.id);
      return { ok: true, message: model.message('info') };
    },

    /** Removes a user font; the default font becomes current if it was the current one. */
    async removeFont(id) {
      const entry = userList.find((f) => f.id === id);
      if (!entry) return false;
      try { await userFonts.remove(id); } catch (e) {
        const message = e.message;
        say('warn', () => t('texttab.storageFailed', { message }));
        return false;
      }
      say('info', () => t('texttab.fontRemoved', { name: entry.name }));
      await refreshFonts();
      if (fontId === id) { persist(); await useFont(DEFAULT_FONT); }
      return true;
    },

    toPreset,

    dispose() {
      disposed = true;
      timers.clearTimeout(saveTimer);
      listeners.clear();
    },
  };
  return model;
}
