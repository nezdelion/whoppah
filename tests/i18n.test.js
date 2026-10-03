import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, setLocale, getLocale, hasKey, fmtNumber, dictionaries, LOCALES, DEFAULT_LOCALE } from '../src/i18n/index.js';
import { detectLanguage, normalizeLang } from '../src/i18n/detect.js';
import { applyLanguage, readLanguageChoice, saveLanguageChoice, LANG_KEY } from '../src/app/lang.js';
import { resolveEnv } from '../src/app/env.js';
import { PROFILE_SCHEMA, JOB_SCHEMA, validate } from '../src/core/profile.js';
import { PAPER_FORMATS, paperLabel } from '../src/core/layout.js';
import { PARAMS as CROSSHATCH_PARAMS } from '../src/styles/own/crosshatch.js';
import { importSvg, SvgImportError } from '../src/core/svg-import.js';
import { STYLES } from '../src/styles/registry.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const { en, ru } = dictionaries;

beforeEach(() => setLocale('en'));
afterEach(() => setLocale('en'));

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

const params = (text) => [...new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
const variants = (v) => (typeof v === 'string' ? { _: v } : v);

// --- dictionaries

test('en and ru: the same key sets', () => {
  const a = Object.keys(en).sort(), b = Object.keys(ru).sort();
  assert.deepEqual(a.filter((k) => !(k in ru)), [], 'in en, missing in ru');
  assert.deepEqual(b.filter((k) => !(k in en)), [], 'in ru, missing in en');
});

test('en and ru: every key has the same {name} parameters, plural forms are complete', () => {
  const bad = [];
  for (const key of Object.keys(en)) {
    const e = variants(en[key]), r = variants(ru[key]);
    if (typeof en[key] !== typeof ru[key] && !(typeof en[key] === 'object' || typeof ru[key] === 'object')) bad.push(`${key}: тип`);
    const all = new Set();
    for (const text of [...Object.values(e), ...Object.values(r)]) {
      if (typeof text !== 'string' || !text) bad.push(`${key}: пустая или не строка`);
      all.add(params(text).join(','));
    }
    if (all.size > 1) bad.push(`${key}: параметры различаются (${[...all].join(' | ')})`);
    if (typeof ru[key] === 'object') for (const f of ['one', 'few', 'many', 'other']) if (!ru[key][f]) bad.push(`${key}: в ru нет формы ${f}`);
    if (typeof en[key] === 'object') for (const f of ['one', 'other']) if (!en[key][f]) bad.push(`${key}: в en нет формы ${f}`);
    if (typeof ru[key] === 'object' && !/\{count\}/.test(ru[key].other)) bad.push(`${key}: у множественного числа нет {count}`);
  }
  assert.deepEqual(bad, []);
});

test('all t(\'…\') keys from src are in the dictionaries', () => {
  const missing = [];
  for (const file of walk(srcDir)) {
    if (file.includes('/i18n/')) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([\w]+(?:\.[\w]+)+)'/g)) {
      if (!(m[1] in en)) missing.push(`${file.slice(srcDir.length + 1)}: ${m[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('Cyrillic in src only in the ru dictionary and in the language name Russian', () => {
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

test('setLocale: an unknown locale — en; getLocale', () => {
  assert.deepEqual([...LOCALES], ['en', 'ru']);
  assert.equal(DEFAULT_LOCALE, 'en');
  assert.equal(setLocale('ru'), 'ru');
  assert.equal(getLocale(), 'ru');
  assert.equal(setLocale('de'), 'en');
  assert.equal(setLocale(undefined), 'en');
});

test('fmtNumber: the decimal mark by locale', () => {
  assert.equal(fmtNumber(1.5, { minFrac: 1 }), '1.5');
  assert.equal(fmtNumber(12, { minFrac: 1 }), '12.0');
  setLocale('ru');
  assert.equal(fmtNumber(1.5, { minFrac: 1 }), '1,5');
  assert.equal(fmtNumber(12, { minFrac: 1 }), '12,0');
  assert.equal(fmtNumber(0.855, { maxFrac: 2 }), '0,86');
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

test('detectLanguage: unknown and empty → en', () => {
  assert.equal(detectLanguage({ server: 'de', browser: ['fr', 'de-DE'] }), 'en');
  assert.equal(detectLanguage({ stored: 'xx', server: 12, browser: [null, undefined, ''] }), 'en');
  assert.equal(detectLanguage({ server: 'de', browser: ['ru'] }), 'ru', 'unsupported OctoPrint language is skipped');
  assert.equal(detectLanguage({}), 'en');
  assert.equal(detectLanguage(), 'en');
  assert.equal(detectLanguage({ browser: 'ru-RU' }), 'ru');
  assert.equal(normalizeLang('ru-RU'), 'ru');
  assert.equal(normalizeLang('de'), null);
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
  saveLanguageChoice('auto', s);
  assert.equal(LANG_KEY in s.data, false);
  saveLanguageChoice('de', s);
  assert.equal(LANG_KEY in s.data, false);
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

test('own styles: every parameter, select option, preset and the style name have labels in en and ru', () => {
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
    for (const k of keys) for (const loc of ['en', 'ru']) if (!hasKey(k, loc)) missing.push(`${loc}: ${k}`);
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
