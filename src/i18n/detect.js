// Interface language choice. A pure function, no DOM or storage.
// Priority: the user's explicit choice (stored: a supported code; 'auto' or empty — not chosen) → OctoPrint language (server, plugin only)
// → browser languages (navigator.languages). The first supported candidate is taken; nothing fits — English.

export const SUPPORTED = Object.freeze(['en', 'ru', 'es', 'de', 'fr']);
export const FALLBACK = 'en';

/** 'ru-RU' / 'ru_RU' / 'RU' → 'ru', 'de-AT' → 'de'; unsupported or not a string → null. */
export function normalizeLang(tag) {
  if (typeof tag !== 'string') return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED.includes(primary) ? primary : null;
}

/** @param {{stored?: string|null, server?: string|null, browser?: string[]|string|null}} sources */
export function detectLanguage({ stored, server, browser } = {}) {
  const forced = normalizeLang(stored);
  if (forced) return forced;
  const list = Array.isArray(browser) ? browser : browser ? [browser] : [];
  for (const tag of [server, ...list]) {
    const lang = normalizeLang(tag);
    if (lang) return lang;
  }
  return FALLBACK;
}
