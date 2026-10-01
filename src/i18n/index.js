// Minimal localization with no dependencies: t(key, params), {name} interpolation, plurals via Intl.PluralRules.
// The i18n layer imports nothing (except its own dictionaries), so it can be used from any layer.
// A dictionary entry is a flat object "key → string" or "key → { one, few, many, other }" (the form is chosen by params.count).
import en from './en.js';
import ru from './ru.js';

export const LOCALES = Object.freeze(['en', 'ru']);
export const DEFAULT_LOCALE = 'en';

const DICTS = { en, ru };
let current = DEFAULT_LOCALE;
const rules = new Map();

const pluralRules = (locale) => {
  if (!rules.has(locale)) rules.set(locale, new Intl.PluralRules(locale));
  return rules.get(locale);
};

export const isLocale = (v) => LOCALES.includes(v);
export const getLocale = () => current;

/** An unknown locale is replaced with English. */
export function setLocale(locale) {
  current = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return current;
}

const PLACEHOLDER = /\{(\w+)\}/g;

function pick(entry, locale, params) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return undefined;
  const n = params && Number(params.count);
  const form = Number.isFinite(n) ? pluralRules(locale).select(n) : 'other';
  return entry[form] ?? entry.other;
}

/** Translation: current locale → English → the key itself. Parameters are substituted into {name}; without a parameter the placeholder stays as is. */
export function t(key, params) {
  let text = pick(DICTS[current][key], current, params);
  if (text === undefined && current !== DEFAULT_LOCALE) text = pick(DICTS[DEFAULT_LOCALE][key], DEFAULT_LOCALE, params);
  if (text === undefined) return key;
  if (!params) return text;
  return text.replace(PLACEHOLDER, (m, name) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}

/** Whether the key exists in the locale (without the English fallback). */
export const hasKey = (key, locale = current) => Object.hasOwn(DICTS[locale] || {}, key);

/** A number in the locale style (decimal mark, separators). For UI text, not for G-code or input fields. */
export function fmtNumber(value, { maxFrac = 1, minFrac = 0 } = {}) {
  if (!Number.isFinite(value)) return String(value);
  return new Intl.NumberFormat(current, { maximumFractionDigits: maxFrac, minimumFractionDigits: minFrac }).format(value);
}

/** For tests: the dictionaries as is. */
export const dictionaries = DICTS;
