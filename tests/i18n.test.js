import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, setLocale, getLocale, hasKey, fmtNumber, dictionaries, LOCALES, DEFAULT_LOCALE } from '../src/i18n/index.js';
import { detectLanguage, normalizeLang, SUPPORTED } from '../src/i18n/detect.js';
import { applyLanguage, readLanguageChoice, saveLanguageChoice, LANG_KEY } from '../src/app/lang.js';
import { resolveEnv } from '../src/app/env.js';
import { PROFILE_SCHEMA, JOB_SCHEMA, validate } from '../src/core/profile.js';
import { PAPER_FORMATS, paperLabel } from '../src/core/layout.js';
import { PARAMS as CROSSHATCH_PARAMS } from '../src/styles/own/crosshatch.js';
import { importSvg, SvgImportError } from '../src/core/svg-import.js';
import { STYLES } from '../src/styles/registry.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { en } = dictionaries;

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

const params = (text) => [...new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const variants = (v) => (typeof v === 'string' ? { _: v } : v);

// --- dictionaries

const OTHERS = LOCALES.filter((l) => l !== DEFAULT_LOCALE);
const categories = (loc) => new Intl.PluralRules(loc).resolvedOptions().pluralCategories;

test('every locale has the same key set as en', () => {
  for (const loc of OTHERS) {
    const d = dictionaries[loc];
    assert.ok(d, `dictionary ${loc}`);
    assert.deepEqual(Object.keys(en).filter((k) => !(k in d)), [], `in en, missing in ${loc}`);
    assert.deepEqual(Object.keys(d).filter((k) => !(k in en)), [], `in ${loc}, missing in en`);
  }
});

test('every locale: each key has the same {name} parameters as en, no empty texts', () => {
  const bad = [];
  for (const loc of LOCALES) {
    for (const key of Object.keys(en)) {
      const want = new Set(Object.values(variants(en[key])).map((x) => params(x).join(',')));
      for (const text of Object.values(variants(dictionaries[loc][key]))) {
        if (typeof text !== 'string' || !text) { bad.push(`${loc} ${key}: empty or not a string`); continue; }
        if (!want.has(params(text).join(','))) bad.push(`${loc} ${key}: parameters differ (${params(text)} vs ${[...want].join(' | ')})`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('every locale: plural entries have every form Intl.PluralRules can return, and only those', () => {
  assert.deepEqual(categories('en'), ['one', 'other']);
  const bad = [];
  for (const loc of LOCALES) {
    const cats = categories(loc);
    // every category select() really returns over a range of counts is listed in pluralCategories
    for (const n of [0, 1, 2, 3, 5, 11, 21, 100, 101, 1000, 1e6, 2e6, 1.5]) assert.ok(cats.includes(new Intl.PluralRules(loc).select(n)), `${loc} ${n}`);
    for (const [key, v] of Object.entries(dictionaries[loc])) {
      if (typeof v !== 'object') continue;
      for (const f of cats) if (!v[f]) bad.push(`${loc} ${key}: no form ${f}`);
      for (const f of Object.keys(v)) if (!cats.includes(f)) bad.push(`${loc} ${key}: extra form ${f}`);
      if (!/\{count\}/.test(v.other)) bad.push(`${loc} ${key}: the plural has no {count}`);
    }
  }
  assert.deepEqual(bad, []);
});

// Heuristic for forgotten translations: a sentence-like value (3+ words of 3+ letters, beyond units, G-code and product names)
// left identical to English. Short labels that are the same word in the language (Photo, Gamma, Standard) do not count.
const KEEP = /\b(?:OctoPrint|Neptune|Plotter|Whoppah|plotterfun|Hershey|G-code|SVG|JSON|CORS|API|WebSocket|TTF|OTF|WOFF|mm|min|max)\b|\b[GM]\d+\b/g;
const sentenceLike = (text) => (text.replace(/\{\w+\}/g, ' ').replace(KEEP, ' ').match(/\p{L}{3,}/gu) || []).length >= 3;

test('non-English dictionaries: no sentence left in English', () => {
  for (const loc of OTHERS) {
    const same = Object.keys(en).filter((k) => {
      const a = variants(en[k]), b = variants(dictionaries[loc][k]);
      return Object.entries(b).some(([f, x]) => x === a[f] && sentenceLike(x));
    });
    if (same.length) console.log(`# ${loc}: ${same.length} sentence(s) identical to en: ${same.join(', ')}`);
    assert.ok(same.length <= 2, `${loc}: ${same.length} untranslated sentences: ${same.join(', ')}`);
  }
});

test('the language names in the switcher are each language\'s own name; SUPPORTED matches LOCALES', async () => {
  const { LANG_CHOICES } = await import('../src/app/ui/lang-switch.js');
  assert.deepEqual(LANG_CHOICES.map(([v, name]) => (v === 'auto' ? v : `${v}:${name()}`)),
    ['auto', 'en:English', 'ru:Русский', 'es:Español', 'de:Deutsch', 'fr:Français']);
  assert.deepEqual([...SUPPORTED], [...LOCALES]);
  for (const loc of LOCALES) assert.equal(dictionaries[loc]['app.langCode'], loc);
});

test('all t(\'…\') keys from src are in every dictionary', () => {
  const missing = [];
  for (const file of walk(srcDir)) {
    if (file.includes('/i18n/')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w]+(?:\.[\w]+)+)'/g)) {
      for (const loc of LOCALES) if (!(m[1] in dictionaries[loc])) missing.push(`${loc} ${file.slice(srcDir.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('Cyrillic in src only in the dictionaries and in the language name Russian', () => {
  const found = [];
  for (const file of walk(srcDir)) {
    if (file.includes('/i18n/')) continue;
    let inBlock = false;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      let s = line;
      if (inBlock) { if (!s.includes('*/')) return; s = s.split('*/')[1]; inBlock = false; }
      s = s.replace(/\/\*.*?\*\//g, '');
      if (s.includes('/*')) { s = s.split('/*')[0]; inBlock = true; }
      let out = '', q = null;
      for (let k = 0; k < s.length; k++) {
        const c = s[k];
        if (q) { out += c; if (c === '\\') { out += s[++k] || ''; } else if (c === q) q = null; continue; }
        if (c === '\'' || c === '"' || c === '`') { q = c; out += c; continue; }
        if (c === '/' && s[k + 1] === '/' && s[k - 1] !== ':') break;
        out += c;
      }
      if (/[а-яё]/i.test(out) && !/'Русский'/.test(out)) found.push(`${file.slice(srcDir.length + 1)}:${i + 1}`);
    });
  }
  assert.deepEqual(found, []);
});

// --- t()

test('t: parameter substitution, an unknown parameter stays a placeholder, without params the string as is', () => {
  assert.equal(t('jog.err.limit', { axis: 'X' }), 'X axis limit reached');
  assert.equal(t('jog.err.limit'), '{axis} axis limit reached');
  assert.equal(t('jog.err.limit', { other: 1 }), '{axis} axis limit reached');
  assert.equal(t('jog.err.step'), 'invalid step');
  setLocale('ru');
  assert.equal(t('jog.err.limit', { axis: 'Y' }), 'предел оси Y');
});

test('t: English plurals (one/other)', () => {
  assert.equal(t('svgtab.lines', { count: 1 }), '1 line');
  assert.equal(t('svgtab.lines', { count: 0 }), '0 lines');
  assert.equal(t('svgtab.lines', { count: 2 }), '2 lines');
});

test('t: Russian plurals (one/few/many)', () => {
  setLocale('ru');
  const f = (n) => t('svgtab.lines', { count: n });
  assert.equal(f(1), '1 линия');
  assert.equal(f(2), '2 линии');
  assert.equal(f(4), '4 линии');
  assert.equal(f(5), '5 линий');
  assert.equal(f(11), '11 линий');
  assert.equal(f(12), '12 линий');
  assert.equal(f(21), '21 линия');
  assert.equal(f(22), '22 линии');
  assert.equal(f(25), '25 линий');
  assert.equal(f(100), '100 линий');
  assert.equal(f(101), '101 линия');
  assert.equal(f(0), '0 линий');
});

test('t: fallback order — locale, then en, then the key itself', () => {
  en['test.only.en'] = 'English only';
  en['test.plural.en'] = { one: '{count} thing', other: '{count} things' };
  try {
    setLocale('ru');
    assert.equal(hasKey('test.only.en'), false);
    assert.equal(t('test.only.en'), 'English only', 'missing in ru: en is used');
    assert.equal(t('test.plural.en', { count: 2 }), '2 things', 'en form by en rules');
    assert.equal(t('test.nowhere.at.all'), 'test.nowhere.at.all', 'missing everywhere: the key');
    setLocale('en');
    assert.equal(t('test.nowhere.at.all', { a: 1 }), 'test.nowhere.at.all');
  } finally { delete en['test.only.en']; delete en['test.plural.en']; }
});

test('t: Spanish, German and French plurals', () => {
  const f = (loc, n) => { setLocale(loc); return t('svgtab.lines', { count: n }); };
  assert.deepEqual([0, 1, 2, 5].map((n) => f('de', n)), ['0 Linien', '1 Linie', '2 Linien', '5 Linien']);
  assert.deepEqual([0, 1, 2, 1000000].map((n) => f('es', n)), ['0 líneas', '1 línea', '2 líneas', '1000000 de líneas']);
  // French: 0 and 1 take the singular; a million takes "de"
  assert.deepEqual([0, 1, 2, 1000000].map((n) => f('fr', n)), ['0 ligne', '1 ligne', '2 lignes', '1000000 de lignes']);
  setLocale('de');
  assert.equal(t('texttab.fontAdded', { name: 'X', count: 1 }), 'Schrift „X“ hinzugefügt: 1 Glyphe.');
});

test('setLocale: an unknown locale — en; getLocale', () => {
  assert.deepEqual([...LOCALES], ['en', 'ru', 'es', 'de', 'fr']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(setLocale('ru'), 'ru');
  assert.equal(getLocale(), 'ru');
  for (const loc of ['es', 'de', 'fr']) assert.equal(setLocale(loc), loc);
  assert.equal(setLocale('it'), 'en');
  assert.equal(setLocale(undefined), 'en');
});

test('fmtNumber: the decimal mark by locale', () => {
  assert.equal(fmtNumber(1.5, { minFrac: 1 }), '1.5');
  assert.equal(fmtNumber(12, { minFrac: 1 }), '12.0');
  setLocale('ru');
  assert.equal(fmtNumber(1.5, { minFrac: 1 }), '1,5');
  assert.equal(fmtNumber(12, { minFrac: 1 }), '12,0');
  assert.equal(fmtNumber(0.855, { maxFrac: 2 }), '0,86');
  for (const loc of ['es', 'de', 'fr']) {
    setLocale(loc);
    assert.equal(fmtNumber(1.5, { minFrac: 1 }), '1,5', loc);
    assert.equal(fmtNumber(0.855, { maxFrac: 2 }), '0,86', loc);
  }
  assert.equal(fmtNumber(NaN), 'NaN');
});

test('schema, format and style texts follow the language', () => {
  assert.equal(PROFILE_SCHEMA[0].label, 'Pen width');
  assert.equal(PROFILE_SCHEMA[0].unit, 'mm');
  assert.equal(PROFILE_SCHEMA[0].group, 'Pen');
  assert.equal(JOB_SCHEMA.find((f) => f.key === 'orientation').options.portrait, 'portrait');
  assert.equal(paperLabel({ id: 'work', name: 'whatever', w: 1, h: 1 }), 'Work area');
  assert.equal(paperLabel(PAPER_FORMATS[2]), 'A4');
  assert.equal(CROSSHATCH_PARAMS[0].label, 'Hatch levels');
  setLocale('ru');
  assert.equal(PROFILE_SCHEMA[0].label, 'Ширина пера');
  assert.equal(PROFILE_SCHEMA[0].unit, 'мм');
  assert.equal(PROFILE_SCHEMA[0].group, 'Перо');
  assert.equal(JOB_SCHEMA.find((f) => f.key === 'orientation').options.portrait, 'книжная');
  assert.equal(paperLabel({ id: 'work', name: 'whatever', w: 1, h: 1 }), 'Рабочее поле');
  assert.equal(CROSSHATCH_PARAMS[0].label, 'Уровней штриховки');
  const bad = validate(PROFILE_SCHEMA, { penWidthMm: 99 });
  assert.match(bad.find((e) => e.key === 'penWidthMm').message, /Ширина пера: число от 0.05 до 5/);
});

test('core errors in the current language', () => {
  assert.throws(() => importSvg({ tag: 'html' }), (e) => e instanceof SvgImportError && e.message === 'could not read the SVG');
  setLocale('ru');
  assert.throws(() => importSvg({ tag: 'html' }), /не удалось прочитать SVG/);
});

// --- language choice

test('detectLanguage: the user choice beats everything', () => {
  assert.equal(detectLanguage({ stored: 'ru', server: 'en', browser: ['en-US'] }), 'ru');
  assert.equal(detectLanguage({ stored: 'en', server: 'ru', browser: ['ru-RU'] }), 'en');
});

test('detectLanguage: auto → OctoPrint language → browser language → en', () => {
  assert.equal(detectLanguage({ stored: 'auto', server: 'ru', browser: ['en-US'] }), 'ru');
  assert.equal(detectLanguage({ server: 'en', browser: ['ru'] }), 'en');
  assert.equal(detectLanguage({ browser: ['ru-RU', 'en'] }), 'ru');
  assert.equal(detectLanguage({ browser: ['en-GB', 'ru'] }), 'en');
  assert.equal(detectLanguage({ browser: ['uk', 'ru'] }), 'ru', 'first supported one from the list');
  assert.equal(detectLanguage({ server: 'ru_RU' }), 'ru');
  assert.equal(detectLanguage({ server: 'RU' }), 'ru');
});

test('detectLanguage: Spanish, German, French from any source and region', () => {
  assert.equal(detectLanguage({ browser: ['de-AT', 'en'] }), 'de');
  assert.equal(detectLanguage({ browser: ['de-CH'] }), 'de');
  assert.equal(detectLanguage({ browser: ['es-MX', 'en'] }), 'es');
  assert.equal(detectLanguage({ browser: ['fr-CA'] }), 'fr');
  assert.equal(detectLanguage({ browser: ['it', 'fr-BE', 'en'] }), 'fr', 'first supported one from the list');
  assert.equal(detectLanguage({ server: 'de', browser: ['fr', 'de-DE'] }), 'de', 'the OctoPrint language beats the browser');
  assert.equal(detectLanguage({ server: 'es_ES', browser: ['en'] }), 'es');
  assert.equal(detectLanguage({ stored: 'fr', server: 'de', browser: ['es'] }), 'fr', 'the explicit choice beats everything');
  assert.equal(normalizeLang('de-AT'), 'de');
  assert.equal(normalizeLang('FR_ca'), 'fr');
});

test('detectLanguage: unknown and empty → en', () => {
  assert.equal(detectLanguage({ server: 'it', browser: ['pt-BR', 'nl'] }), 'en');
  assert.equal(detectLanguage({ stored: 'xx', server: 12, browser: [null, undefined, ''] }), 'en');
  assert.equal(detectLanguage({ server: 'it', browser: ['ru'] }), 'ru', 'unsupported OctoPrint language is skipped');
  assert.equal(detectLanguage({}), 'en');
  assert.equal(detectLanguage(), 'en');
  assert.equal(detectLanguage({ browser: 'ru-RU' }), 'ru');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('it'), null);
  assert.equal(normalizeLang(5), null);
});

const memStorage = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
};
const fakeDoc = () => {
  const el = { dataset: { i18n: 'app.subtitle' }, textContent: '' };
  return { el, documentElement: { lang: '' }, querySelectorAll: () => [el] };
};

test('applyLanguage: sets the language, translates the static markup and lang', () => {
  const doc = fakeDoc();
  const r = applyLanguage({ env: { mode: 'standalone' }, storage: memStorage(), nav: { languages: ['ru-RU', 'en'] }, root: doc });
  assert.deepEqual(r, { locale: 'ru', choice: 'auto' });
  assert.equal(getLocale(), 'ru');
  assert.equal(doc.documentElement.lang, 'ru');
  assert.equal(doc.el.textContent, 'рисунок → G-code → OctoPrint');
});

test('applyLanguage: German from OctoPrint, French from the browser', () => {
  const doc = fakeDoc();
  assert.equal(applyLanguage({ env: { language: 'de' }, storage: memStorage(), nav: { languages: ['en-US'] }, root: doc }).locale, 'de');
  assert.equal(doc.documentElement.lang, 'de');
  assert.equal(doc.el.textContent, 'Zeichnung → G-code → OctoPrint');
  assert.equal(applyLanguage({ env: {}, storage: memStorage(), nav: { languages: ['fr-FR', 'en'] }, root: doc }).locale, 'fr');
  assert.equal(doc.documentElement.lang, 'fr');
  assert.equal(applyLanguage({ env: {}, storage: memStorage({ [LANG_KEY]: 'es' }), nav: { languages: ['fr-FR'] }, root: doc }).locale, 'es');
  assert.equal(doc.el.textContent, 'dibujo → G-code → OctoPrint');
});

test('applyLanguage: a manual choice overrides auto; the OctoPrint language from env', () => {
  const doc = fakeDoc();
  assert.equal(applyLanguage({ env: { language: 'ru' }, storage: memStorage(), nav: { languages: ['en-US'] }, root: doc }).locale, 'ru');
  assert.equal(applyLanguage({ env: { language: 'ru' }, storage: memStorage({ [LANG_KEY]: 'en' }), nav: { languages: ['ru'] }, root: doc }).locale, 'en');
  assert.equal(doc.documentElement.lang, 'en');
  assert.equal(doc.el.textContent, 'drawing → G-code → OctoPrint');
});

test('language in storage: read, write, auto erases; unavailable storage does not break', () => {
  const s = memStorage();
  assert.equal(readLanguageChoice(s), 'auto');
  saveLanguageChoice('ru', s);
  assert.equal(readLanguageChoice(s), 'ru');
  saveLanguageChoice('en', s);
  assert.equal(readLanguageChoice(s), 'en');
  for (const loc of ['es', 'de', 'fr']) {
    saveLanguageChoice(loc, s);
    assert.equal(readLanguageChoice(s), loc);
  }
  saveLanguageChoice('auto', s);
  assert.equal(LANG_KEY in s.data, false);
  saveLanguageChoice('it', s);
  assert.equal(LANG_KEY in s.data, false);
  s.data[LANG_KEY] = 'de-AT';
  assert.equal(readLanguageChoice(s), 'auto', 'only an exact code is a stored choice');
  s.data[LANG_KEY] = 'klingon';
  assert.equal(readLanguageChoice(s), 'auto');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readLanguageChoice(broken), 'auto');
  assert.doesNotThrow(() => saveLanguageChoice('ru', broken));
  assert.equal(readLanguageChoice(null), 'auto');
  const doc = fakeDoc();
  assert.equal(applyLanguage({ env: {}, storage: broken, nav: { language: 'ru' }, root: doc }).locale, 'ru');
});

test('env.json: the OctoPrint language passes into env, empty and non-string — null', () => {
  const base = { mode: 'plugin', baseUrl: '/o', settingsUrl: '/o/s', octoprintUrl: '/o/', csrfCookie: 'c' };
  assert.equal(resolveEnv({ ...base, language: 'ru' }, 'http://h').language, 'ru');
  assert.equal(resolveEnv({ ...base, language: 'de' }, 'http://h').language, 'de');
  assert.equal(resolveEnv({ ...base, language: '' }, 'http://h').language, null);
  assert.equal(resolveEnv({ ...base, language: 5 }, 'http://h').language, null);
  assert.equal(resolveEnv(base, 'http://h').language, null);
});

// --- own styles: dynamic keys (t(`${prefix}.param.${key}`) etc.) are not seen by the literal scan above

// every own style and its dictionary prefix; a new own style must be added here
const OWN_PREFIX = { 'own:crosshatch': 'crosshatch', 'own:waves': 'waves', 'own:engraving': 'engraving' };

test('own styles: every parameter, select option, preset and the style name have labels in every locale', () => {
  const own = STYLES.filter((s) => s.origin === 'own');
  assert.deepEqual(own.map((s) => s.id).sort(), Object.keys(OWN_PREFIX).sort(), 'all own styles are listed');
  const missing = [];
  for (const style of own) {
    const prefix = OWN_PREFIX[style.id];
    const keys = style.params.map((d) => `${prefix}.param.${d.key}`);
    for (const d of style.params) if (d.type === 'select') for (const o of d.options) keys.push(`${prefix}.${d.key}.${o}`);
    for (const p of style.presets || []) keys.push(`${prefix}.preset.${p.id}`);
    if (style.id === 'own:waves') keys.push('style.name.waves', 'styles.progress.waves', 'photo.stylePreset', 'photo.stylePreset.none');
    if (style.id === 'own:engraving') keys.push('style.name.engraving', ...['field', 'lines', 'cross', 'finish', 'limit'].map((k) => `styles.progress.engraving.${k}`));
    for (const k of keys) for (const loc of LOCALES) if (!hasKey(k, loc)) missing.push(`${loc}: ${k}`);
  }
  assert.deepEqual(missing, []);
});

test('own styles: labels, option labels, preset names and the style name switch language live', () => {
  const waves = STYLES.find((s) => s.id === 'own:waves');
  const mode = waves.params.find((d) => d.key === 'mode');
  const bold = waves.presets.find((p) => p.id === 'bold');
  setLocale('en');
  assert.deepEqual([waves.name, mode.label, mode.optionLabel('both'), bold.label], ['Wave lines', 'Modulation', 'Both', 'Bold']);
  assert.equal(waves.params.find((d) => d.key === 'spacing').label, 'Line spacing, mm');
  setLocale('ru');
  assert.deepEqual([waves.name, mode.label, mode.optionLabel('both'), bold.label], ['Волнистые линии', 'Модуляция', 'Обе', 'Крупно']);
  assert.equal(waves.params.find((d) => d.key === 'stagger').label, 'Сдвигать каждую вторую линию на полпериода');
  assert.equal(mode.default, 'both', 'the value does not depend on the language');
});
