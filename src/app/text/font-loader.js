// The built-in single-stroke fonts of the "Text" tab: the list and loading of their JSON (src/app/text/fonts/, made by
// tools/build_fonts.js from vendor/). Fetching lives here because core does not touch the network.
import { fontFromJson } from '../../core/stroke-font.js';

/** id, shown name (a proper name, not translated) and file. All of them cover Latin and Cyrillic. */
export const BUILTIN_FONTS = Object.freeze([
  { id: 'script', name: 'Hershey Script', file: 'script.json' },
  { id: 'felix', name: 'EMS Felix', file: 'felix.json' },
  { id: 'allure', name: 'EMS Allure', file: 'allure.json' },
  { id: 'newstroke', name: 'NewStroke', file: 'newstroke.json' },
]);
export const DEFAULT_FONT = 'script';
/** Characters a font lacks are taken from this one (it has Latin, Latin-1, Cyrillic and typographic punctuation). */
export const FALLBACK_FONT = 'newstroke';

const fetchJson = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
};

/**
 * @param getJson (url) => Promise<object> — replaced in tests
 * @returns (id) => Promise<StrokeFont>; a font is fetched once, a failed fetch is retried on the next call
 */
export function createFontLoader({ getJson = fetchJson, base = new URL('./fonts/', import.meta.url).href } = {}) {
  const cache = new Map();
  return (id) => {
    const entry = BUILTIN_FONTS.find((f) => f.id === id);
    if (!entry) return Promise.reject(new Error(`unknown font: ${id}`));
    if (!cache.has(id)) {
      cache.set(id, getJson(new URL(entry.file, base).href).then((json) => {
        const font = fontFromJson(json);
        font.id = entry.id;
        font.name = entry.name;
        return font;
      }).catch((e) => { cache.delete(id); throw e; }));
    }
    return cache.get(id);
  };
}
