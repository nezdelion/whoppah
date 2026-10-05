// Interface language: the user's choice in browser storage, the OctoPrint language (plugin env.json), the browser language.
// The choice logic is the pure function detectLanguage (i18n/detect.js); here only reading the sources and applying to the page.
// Changing the language (the header switch) saves the choice and rebuilds the UI in place, without a page reload:
// the drawing, loaded files, settings and running computations stay (createLanguageControl).
import { setLocale, getLocale, t } from '../i18n/index.js';
import { detectLanguage, SUPPORTED } from '../i18n/detect.js';

export const LANG_KEY = 'whoppah.lang';

/** An explicit choice: a supported language code; anything else means 'auto'. */
const asChoice = (v) => (SUPPORTED.includes(v) ? v : 'auto');

const storageOf = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };

/** a supported code ('en', 'ru', 'es', 'de', 'fr') or 'auto' — the user's explicit choice; unavailable storage or a foreign value — 'auto'. */
export function readLanguageChoice(storage = storageOf()) {
  try {
    const v = storage && storage.getItem(LANG_KEY);
    return asChoice(v);
  } catch (e) { return 'auto'; }
}

export function saveLanguageChoice(choice, storage = storageOf()) {
  try {
    if (!storage) return;
    if (asChoice(choice) !== 'auto') storage.setItem(LANG_KEY, choice);
    else storage.removeItem(LANG_KEY);
  } catch (e) { /* storage unavailable: the choice will not be saved, auto-detection remains */ }
}

/** Labels of index.html elements with data-i18n and the lang attribute. */
export function translateStatic(root = globalThis.document) {
  if (!root) return;
  root.documentElement.lang = t('app.langCode');
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

/**
 * Detects the language, enables it and translates the static markup.
 * @param env  the loadEnv result (in the plugin — env.language from OctoPrint)
 * @returns { locale, choice } choice — the saved choice ('auto' or a supported code)
 */
export function applyLanguage({ env = {}, storage = storageOf(), nav = globalThis.navigator, root = globalThis.document } = {}) {
  const choice = readLanguageChoice(storage);
  return { locale: enable(choice, { env, nav, root }), choice };
}

function enable(choice, { env, nav, root }) {
  const browser = nav ? (nav.languages && nav.languages.length ? [...nav.languages] : [nav.language]) : [];
  const locale = setLocale(detectLanguage({ stored: choice, server: env.language, browser }));
  translateStatic(root);
  return locale;
}

/**
 * The live language switch: { get(), set(choice) }. set saves the choice, enables the language, translates the static markup
 * and, if the language changed, calls rebuild() — the views are built anew in place, no page reload.
 * The choice is also kept in memory: with unavailable storage the switch still works (until the page is reloaded).
 * @param choice  the choice at startup (applyLanguage result)
 * @param rebuild () => void — rebuilds the UI views
 */
export function createLanguageControl({ env = {}, storage = storageOf(), nav = globalThis.navigator, root = globalThis.document, choice = readLanguageChoice(storage), rebuild = () => {} } = {}) {
  let current = choice;
  return {
    get: () => current,
    set(next) {
      current = asChoice(next);
      saveLanguageChoice(current, storage);
      const before = getLocale();
      const locale = enable(current, { env, nav, root });
      if (locale !== before) rebuild();
      return locale;
    },
  };
}
