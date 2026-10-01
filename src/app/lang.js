// Interface language: the user's choice in browser storage, the OctoPrint language (plugin env.json), the browser language.
// The choice logic is the pure function detectLanguage (i18n/detect.js); here only reading the sources and applying to the page.
// Changing the language in settings saves the choice and reloads the page: the whole UI is then built anew in the new language.
import { setLocale, t } from '../i18n/index.js';
import { detectLanguage } from '../i18n/detect.js';

export const LANG_KEY = 'neptune-plotter.lang';

const storageOf = () => { try { return globalThis.localStorage || null; } catch (e) { return null; } };

/** 'en' | 'ru' | 'auto' — the user's explicit choice; unavailable storage or a foreign value — 'auto'. */
export function readLanguageChoice(storage = storageOf()) {
  try {
    const v = storage && storage.getItem(LANG_KEY);
    return v === 'en' || v === 'ru' ? v : 'auto';
  } catch (e) { return 'auto'; }
}

export function saveLanguageChoice(choice, storage = storageOf()) {
  try {
    if (!storage) return;
    if (choice === 'en' || choice === 'ru') storage.setItem(LANG_KEY, choice);
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
 * @returns { locale, choice } choice — the saved choice ('auto' | 'en' | 'ru')
 */
export function applyLanguage({ env = {}, storage = storageOf(), nav = globalThis.navigator, root = globalThis.document } = {}) {
  const choice = readLanguageChoice(storage);
  const browser = nav ? (nav.languages && nav.languages.length ? [...nav.languages] : [nav.language]) : [];
  const locale = setLocale(detectLanguage({ stored: choice, server: env.language, browser }));
  translateStatic(root);
  return { locale, choice };
}
