// The user's own single-stroke fonts of the "Text" tab: adding (SVG font or Hershey .jhf, parsed by core/stroke-font.js),
// storing, removing. Fonts are stored parsed, in the compact JSON form of the built-in fonts ({ format, glyphs, ... }), so
// any future font source (e.g. TTF/OTF centre lines) only has to produce a StrokeFont.
//
// Where: plugin mode — the user's server section "fonts" (per user, like the presets; a section is at most 1 MB), a font
// that does not fit together with the others, or that the server refuses, stays in this browser (localStorage) and the
// message says so; standalone — localStorage. Document: { version: 1, fonts: [{ id, name, addedAt, font }] }.
import { parseFontFile, fontToJson, fontFromJson, FontError } from '../../core/stroke-font.js';
import { t } from '../../i18n/index.js';

export const FONTS_SECTION = 'fonts';
export const SERVER_SECTION_BYTES = 1024 * 1024;
/** The server document budget: below the section limit, with room for the JSON envelope. */
export const SERVER_FONT_BUDGET = SERVER_SECTION_BYTES - 8 * 1024;

const utf8Bytes = (s) => new TextEncoder().encode(s).length;
const emptyDoc = () => ({ version: 1, fonts: [] });
const validDoc = (doc) => (doc && Array.isArray(doc.fonts) ? { version: 1, fonts: doc.fonts.filter((f) => f && typeof f.id === 'string' && f.font) } : emptyDoc());

/** localStorage-like storage that reports failures (a full or blocked storage is an Error with a clear message). */
function localDoc(storage, key) {
  return {
    load() {
      if (!storage) return emptyDoc();
      try { return validDoc(JSON.parse(storage.getItem(key) || 'null')); } catch (e) { return emptyDoc(); }
    },
    save(doc) {
      if (!storage) throw new Error(t('texttab.storageFailed', { message: 'no browser storage' }));
      try { storage.setItem(key, JSON.stringify(doc)); } catch (e) { throw new Error(t('texttab.storageFailed', { message: e.message })); }
    },
  };
}

/**
 * @param server   a SettingsStore ({ load(key), save(key, obj) }) holding the "fonts" section, or null (standalone)
 * @param storage  localStorage-like ({ getItem, setItem }) or null; localKey — its key (per user in plugin mode)
 * @param budget   the largest server document in bytes (tests make it small)
 * @param makeId   () => unique id; now () => ISO time
 */
export function createUserFonts({
  server = null, storage = null, localKey = 'whoppah.v2.fonts', budget = SERVER_FONT_BUDGET,
  makeId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, now = () => new Date().toISOString(),
} = {}) {
  const local = localDoc(storage, localKey);
  let docs = null; // { server, local }
  const parsed = new Map(); // id -> StrokeFont

  async function load() {
    if (docs) return docs;
    let serverDoc = emptyDoc();
    if (server) { try { serverDoc = validDoc(await server.load(FONTS_SECTION)); } catch (e) { serverDoc = emptyDoc(); } }
    docs = { server: serverDoc, local: local.load() };
    return docs;
  }

  const entries = (d) => [
    ...d.server.fonts.map((f) => ({ id: f.id, name: f.name, where: 'server' })),
    ...d.local.fonts.map((f) => ({ id: f.id, name: f.name, where: server ? 'local' : 'browser' })),
  ];

  const find = (d, id) => d.server.fonts.find((f) => f.id === id) || d.local.fonts.find((f) => f.id === id) || null;

  return {
    /** [{ id, name, where: 'server' | 'local' (plugin, this browser only) | 'browser' (standalone) }] */
    async list() { return entries(await load()); },

    /** The StrokeFont of a user font (parsed once). */
    async font(id) {
      if (parsed.has(id)) return parsed.get(id);
      const entry = find(await load(), id);
      if (!entry) throw new FontError(t('text.font.err.format'));
      const font = fontFromJson(entry.font);
      font.id = entry.id;
      font.name = entry.name;
      parsed.set(id, font);
      return font;
    },

    /**
     * Adds a font file. Refused files throw a FontError (a ready message). Returns { id, name, glyphs, where, note, warnings }:
     * note — a function giving the storage message in the current language.
     */
    async add(file) {
      const text = await file.text();
      const id = makeId();
      const { font, warnings } = parseFontFile(text, file.name, { id });
      const entry = { id, name: font.name, addedAt: now(), font: fontToJson(font, { precision: 1 }) };
      const d = await load();
      let where = 'browser', note = () => t('texttab.fontLocal.standalone');
      if (server) {
        const next = { version: 1, fonts: [...d.server.fonts, entry] };
        const bytes = utf8Bytes(JSON.stringify(next));
        if (bytes > budget) {
          where = 'local';
          const kb = Math.round(budget / 1024);
          note = () => t('texttab.fontLocal.tooBig', { kb });
        } else {
          try {
            await server.save(FONTS_SECTION, next);
            d.server = next;
            where = 'server';
            note = () => '';
          } catch (e) {
            where = 'local';
            const message = e.message;
            note = () => t('texttab.fontLocal.failed', { message });
          }
        }
      }
      if (where !== 'server') {
        const next = { version: 1, fonts: [...d.local.fonts, entry] };
        local.save(next); // a failure here is the error of add(): the font is not added
        d.local = next;
      }
      parsed.set(id, Object.assign(font, { id, name: entry.name }));
      return { id, name: entry.name, glyphs: font.glyphs.size, where: server ? where : 'browser', note, warnings };
    },

    /** Removes a font wherever it is stored. Returns false for an unknown id. */
    async remove(id) {
      const d = await load();
      parsed.delete(id);
      if (d.server.fonts.some((f) => f.id === id)) {
        const next = { version: 1, fonts: d.server.fonts.filter((f) => f.id !== id) };
        await server.save(FONTS_SECTION, next);
        d.server = next;
        return true;
      }
      if (d.local.fonts.some((f) => f.id === id)) {
        const next = { version: 1, fonts: d.local.fonts.filter((f) => f.id !== id) };
        local.save(next);
        d.local = next;
        return true;
      }
      return false;
    },
  };
}

/** window.localStorage or null when the browser blocks it. */
export function safeLocalStorage() {
  try { return globalThis.localStorage || null; } catch (e) { return null; }
}
