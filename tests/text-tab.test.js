// "Text" tab: the user font library (accept/reject, where it is stored), the model (presets, variation, "To print"),
// the view on a fake DOM (typing updates the preview, "To print" emits once, remount keeps the model).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './helpers/fake-dom.js';
import { setLocale, t, dictionaries } from '../src/i18n/index.js';
import { parseSvgFont } from '../src/core/stroke-font.js';
import { createUserFonts, FONTS_SECTION } from '../src/app/text/user-fonts.js';
import { createTextModel } from '../src/app/text/text-model.js';
import { createFontLoader, BUILTIN_FONTS } from '../src/app/text/font-loader.js';
import { TEXT_PARAMS, TEXT_PRESETS, normalizeTextParams, defaultTextParams } from '../src/app/text/text-params.js';
import { TINY_JHF, TINY_SVG_FONT, OUTLINE_SVG_FONT, fakeFile } from './helpers/fonts.js';
import { sameData } from './helpers/same.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let createTextSource;
const saved = {};
before(async () => {
  installFakeDom();
  for (const k of ['window', 'requestAnimationFrame', 'getComputedStyle']) saved[k] = globalThis[k];
  const media = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => media, devicePixelRatio: 1, confirm: () => true };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; }; // draw at once
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  ({ createTextSource } = await import('../src/app/tabs/text-tab.js'));
});
after(() => { for (const [k, v] of Object.entries(saved)) globalThis[k] = v; setLocale('en'); });
beforeEach(() => setLocale('en'));

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const memStorage = () => {
  const data = {};
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, data };
};
/** A SettingsStore with one section ("fonts"); failNext makes the next save fail. */
const memServer = () => {
  const s = {
    data: {}, saves: 0, failNext: null,
    load: async (k) => (k in s.data ? structuredClone(s.data[k]) : null),
    save: async (k, v) => { if (s.failNext) { const e = s.failNext; s.failNext = null; throw e; } s.saves++; s.data[k] = structuredClone(v); },
  };
  return s;
};
let idn = 0;
const ids = () => `u${++idn}`;

// built-in fonts read from disk instead of fetch
const loadFont = createFontLoader({ getJson: async (url) => JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) });

/** Timers run by hand: flush() fires every pending one. */
function manualTimers() {
  const pending = new Map();
  let n = 0;
  return {
    setTimeout: (f) => { pending.set(++n, f); return n; },
    clearTimeout: (id) => pending.delete(id),
    flush() { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
    get size() { return pending.size; },
  };
}

function fakeCtx(presetValue = null) {
  const ctx = {
    emitted: [], presetLoads: 0, presetSaves: [], subs: 0,
    emit: (d) => ctx.emitted.push(d),
    ownsDrawing: () => true,
    presets: { load: async () => { ctx.presetLoads++; return structuredClone(presetValue); }, save: async (o) => { ctx.presetSaves.push(structuredClone(o)); } },
    printParams: { get: () => ({ fieldMm: { w: 210, h: 297 }, marginMm: 10, rotate: false, penWidthMm: 0.5 }), subscribe: () => { ctx.subs++; return () => { ctx.subs--; }; } },
  };
  return ctx;
}

const newModel = (opts = {}) => {
  const timers = manualTimers();
  const model = createTextModel({ loadFont, userFonts: createUserFonts({ storage: memStorage(), makeId: ids }), timers, newSeed: () => 99, ...opts });
  return { model, timers };
};

// --- i18n of the parameters

test('text parameters: every label, option and preset name is in en and ru; stored values are clamped', () => {
  const keys = [...TEXT_PARAMS.map((d) => `text.param.${d.key}`), ...TEXT_PARAMS.filter((d) => d.type === 'select').flatMap((d) => d.options.map((o) => `text.${d.key}.${o}`)),
    ...TEXT_PRESETS.map((p) => `text.preset.${p.id}`), 'tab.text'];
  for (const k of keys) { assert.ok(k in dictionaries.en, `en: ${k}`); assert.ok(k in dictionaries.ru, `ru: ${k}`); }
  assert.deepEqual(normalizeTextParams({ sizeMm: 1000, align: 'justify', variation: 'x', slant: -5 }), { ...defaultTextParams(), sizeMm: 100, slant: -5 });
});

// --- user fonts

test('user fonts (standalone): a JHF and an SVG font are added to this browser, survive a reload, can be removed', async () => {
  const storage = memStorage();
  const lib = createUserFonts({ storage, makeId: ids });
  const a = await lib.add(fakeFile('hand.jhf', TINY_JHF));
  assert.equal(a.where, 'browser');
  assert.equal(a.glyphs, 5);
  assert.equal(a.note(), t('texttab.fontLocal.standalone'));
  const b = await lib.add(fakeFile('tiny.svg', TINY_SVG_FONT));
  assert.equal(b.name, 'Tiny Hand');
  // a fresh library on the same storage (page reload)
  const again = createUserFonts({ storage });
  assert.deepEqual((await again.list()).map((f) => [f.name, f.where]), [['hand', 'browser'], ['Tiny Hand', 'browser']]);
  const font = await again.font(b.id);
  const orig = parseSvgFont(TINY_SVG_FONT).font;
  assert.equal(font.capHeight, orig.capHeight);
  sameData(font.glyphs.get(0x49).lines, orig.glyphs.get(0x49).lines.map((l) => l.map((v) => Math.round(v * 10) / 10 + 0)));
  assert.equal(await again.remove(a.id), true);
  assert.deepEqual((await createUserFonts({ storage }).list()).map((f) => f.name), ['Tiny Hand']);
  assert.equal(await again.remove('nope'), false);
});

test('user fonts: outline fonts, TTF and other files are refused with a message and not stored', async () => {
  const storage = memStorage();
  const lib = createUserFonts({ storage, makeId: ids });
  await assert.rejects(lib.add(fakeFile('fat.svg', OUTLINE_SVG_FONT)), /outline font; single-line fonts only for now/);
  await assert.rejects(lib.add(fakeFile('font.ttf', 'binary')), /TTF\/OTF\/WOFF/);
  await assert.rejects(lib.add(fakeFile('a.txt', 'hello')), /unknown file/);
  assert.deepEqual(await lib.list(), []);
  assert.deepEqual(storage.data, {});
});

test('user fonts (plugin): on the server while the section fits, otherwise or on a server failure in this browser, with the reason', async () => {
  const server = memServer(), storage = memStorage();
  const lib = createUserFonts({ server, storage, localKey: 'k', makeId: ids, budget: 6000 });
  const a = await lib.add(fakeFile('a.svg', TINY_SVG_FONT));
  assert.equal(a.where, 'server');
  assert.equal(a.note(), '');
  assert.equal(server.data[FONTS_SECTION].fonts.length, 1);
  const b = await lib.add(fakeFile('b.svg', TINY_SVG_FONT));
  assert.equal(b.where, 'local', 'two fonts are over the small budget');
  assert.equal(b.note(), t('texttab.fontLocal.tooBig', { kb: 6 }));
  assert.equal(server.data[FONTS_SECTION].fonts.length, 1);
  assert.equal(JSON.parse(storage.data.k).fonts.length, 1);
  await lib.remove(a.id);
  server.failNext = new Error('403: permission required');
  const c = await lib.add(fakeFile('c.jhf', TINY_JHF));
  assert.equal(c.where, 'local');
  setLocale('ru');
  assert.match(c.note(), /только в этом браузере: сервер его не сохранил \(403: permission required\)/);
  const list = await createUserFonts({ server, storage, localKey: 'k' }).list();
  assert.deepEqual(list.map((f) => f.where), ['local', 'local']);
});

test('user fonts: a full browser storage is an error and the font is not added', async () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
  const lib = createUserFonts({ storage, makeId: ids });
  await assert.rejects(lib.add(fakeFile('a.jhf', TINY_JHF)), /Could not save the fonts: QuotaExceededError/);
  assert.deepEqual(await lib.list(), []);
});

// --- the model

test('model: presets round-trip (text, font, parameters, seed), saved after the delay', async () => {
  const { model, timers } = newModel();
  const ctx = fakeCtx();
  await model.attach(ctx);
  assert.equal(model.font().id, 'script');
  model.setText('Привет, world');
  model.setParams({ sizeMm: 12, variation: 30, align: 'center' });
  await model.setFont('felix');
  model.newVariation();
  assert.equal(ctx.presetSaves.length, 0, 'debounced');
  timers.flush();
  assert.equal(ctx.presetSaves.length, 1);
  const preset = ctx.presetSaves[0];
  assert.deepEqual(preset, { text: 'Привет, world', fontId: 'felix', params: { ...defaultTextParams(), sizeMm: 12, variation: 30, align: 'center' }, seed: 99 });

  const { model: m2 } = newModel();
  await m2.attach(fakeCtx(preset));
  assert.equal(m2.text(), preset.text);
  assert.equal(m2.fontId(), 'felix');
  assert.equal(m2.font().name, 'EMS Felix');
  assert.deepEqual(m2.params(), preset.params);
  assert.equal(m2.seed(), 99);
  sameData(m2.drawing().layers, model.drawing().layers, 'the same drawing after a restore');

  // an unknown font in a preset (a removed user font) falls back to the default
  const { model: m3 } = newModel();
  await m3.attach(fakeCtx({ ...preset, fontId: 'u-gone' }));
  assert.equal(m3.fontId(), 'script');
});

test('model: "To print" emits once per press; nothing to emit for an empty text; no print-parameter subscription', async () => {
  const { model } = newModel();
  const ctx = fakeCtx();
  await model.attach(ctx);
  assert.equal(model.sendToPrint(), false, 'empty text');
  model.setText('Hi');
  assert.equal(model.sendToPrint(), true);
  assert.equal(ctx.emitted.length, 1);
  const d = ctx.emitted[0];
  assert.equal(d.meta.source, 'text');
  assert.equal(d.meta.unitMm, 1);
  model.setParams({ sizeMm: 20 });
  assert.equal(ctx.emitted.length, 1, 'parameter changes do not emit');
  assert.equal(ctx.subs, 0);
  assert.match(model.message('info'), /^Sent to print: Hi, /);
});

test('model: a user font becomes current, a rejected one leaves a warning, removing it goes back to the default', async () => {
  const { model } = newModel();
  await model.attach(fakeCtx());
  const r = await model.addFontFile(fakeFile('fat.svg', OUTLINE_SVG_FONT));
  assert.equal(r.ok, false);
  assert.equal(model.message('warn'), t('texttab.fontRejected', { message: t('text.font.err.outline') }));
  const ok = await model.addFontFile(fakeFile('tiny.svg', TINY_SVG_FONT));
  assert.equal(ok.ok, true);
  const mine = model.fonts().find((f) => f.user);
  assert.equal(mine.name, 'Tiny Hand');
  assert.equal(model.fontId(), mine.id);
  model.setText('I Ж'); // the tiny font has no ZHE: taken from the fallback font with a note
  assert.deepEqual(model.drawing().meta.warnings, [t('text.warn.fallback', { chars: 'Ж', font: 'NewStroke' })]);
  assert.equal(await model.removeFont(mine.id), true);
  assert.equal(model.fontId(), 'script');
  assert.equal(model.fonts().filter((f) => f.user).length, 0);
});

test('font loader: every built-in font loads with its name; a failed fetch is retried', async () => {
  for (const f of BUILTIN_FONTS) {
    const font = await loadFont(f.id);
    assert.equal(font.name, f.name);
  }
  let calls = 0;
  const flaky = createFontLoader({ getJson: async () => { calls++; if (calls === 1) throw new Error('offline'); return fontFromJsonDoc(); } });
  await assert.rejects(flaky('script'), /offline/);
  assert.equal((await flaky('script')).id, 'script');
  await assert.rejects(flaky('nope'), /unknown font/);
});
const fontFromJsonDoc = () => JSON.parse(readFileSync(join(root, 'src/app/text/fonts/script.json'), 'utf8'));

// --- the view on a fake DOM

const find = (el, pred) => el.findAll(pred);
const byTag = (el, tag) => find(el, (n) => n.tagName === tag);
const buttonByText = (el, text) => find(el, (n) => n.tagName === 'BUTTON' && n.textContent === text)[0];

test('tab: typing updates the preview and the stats, "To print" emits once, the font select lists the fonts', async () => {
  const doc = installFakeDom();
  const { model } = newModel();
  const source = createTextSource({ createModel: () => model });
  assert.equal(source.title, 'Text');
  const ctx = fakeCtx();
  const el = doc.createElement('div');
  source.mount(el, ctx);
  await tick();
  const textarea = byTag(el, 'TEXTAREA')[0];
  const toPrint = buttonByText(el, t('texttab.toPrint'));
  const stats = find(el, (n) => n.className === 'stats')[0];
  assert.equal(stats.textContent, '');
  assert.equal(toPrint.disabled, true);
  textarea.value = 'Hello';
  textarea.dispatch('input');
  assert.match(stats.textContent, /^\d+ lines, [\d.]+ × [\d.]+ mm$/);
  assert.equal(toPrint.disabled, false);
  const first = stats.textContent;
  textarea.value = 'Hello, мир';
  textarea.dispatch('input');
  assert.notEqual(stats.textContent, first, 'the preview follows the text');
  toPrint.click();
  assert.equal(ctx.emitted.length, 1);
  assert.equal(ctx.emitted[0].meta.name, 'Hello, мир');
  const select = find(el, (n) => n.tagName === 'SELECT' && n.getAttribute('aria-label') === t('texttab.font'))[0];
  assert.deepEqual(find(select, (n) => n.tagName === 'OPTION').map((o) => o.value), BUILTIN_FONTS.map((f) => f.id));
  select.value = 'newstroke';
  select.dispatch('change');
  await tick();
  assert.equal(model.font().id, 'newstroke');
  // "New variation" is off at strength 0 and on above it
  const variation = buttonByText(el, t('texttab.newVariation'));
  assert.equal(variation.disabled, true);
  model.setParams({ variation: 50 });
  assert.equal(variation.disabled, false);
  source.dispose();
});

test('tab: a remount (language switch) keeps the model and leaves no old listeners; presets are read once', async () => {
  const doc = installFakeDom();
  const { model } = newModel();
  let created = 0;
  const source = createTextSource({ createModel: () => { created++; return model; } });
  const ctx = fakeCtx();
  const el1 = doc.createElement('div');
  source.mount(el1, ctx);
  await tick();
  model.setText('Keep me');
  model.setParams({ sizeMm: 15 });
  const textarea1 = byTag(el1, 'TEXTAREA')[0];
  const canvas1 = byTag(el1, 'CANVAS').find((c) => c.className.includes('text-preview'));
  assert.ok(canvas1.listenerCount() > 0);
  source.unmount();
  assert.equal(textarea1.listenerCount(), 0);
  assert.equal(canvas1.listenerCount(), 0);
  setLocale('ru');
  const el2 = doc.createElement('div');
  source.mount(el2, ctx);
  await tick();
  assert.equal(created, 1, 'one model');
  assert.equal(ctx.presetLoads, 1);
  assert.equal(byTag(el2, 'TEXTAREA')[0].value, 'Keep me');
  assert.equal(source.title, 'Текст');
  assert.ok(buttonByText(el2, t('texttab.toPrint')), 'the new view is in Russian');
  assert.equal(model.params().sizeMm, 15);
  // events after the remount reach only the new view
  const stats1 = find(el1, (n) => n.className === 'stats')[0].textContent;
  model.setText('Changed');
  assert.equal(find(el1, (n) => n.className === 'stats')[0].textContent, stats1);
  assert.match(find(el2, (n) => n.className === 'stats')[0].textContent, /мм$/);
  source.dispose();
});

test('tab: the presets picker sets the handwriting parameters only', async () => {
  const doc = installFakeDom();
  const { model } = newModel();
  const source = createTextSource({ createModel: () => model });
  const el = doc.createElement('div');
  source.mount(el, fakeCtx());
  await tick();
  model.setParams({ sizeMm: 20 });
  const picker = find(el, (n) => n.tagName === 'SELECT' && find(n, (o) => o.value === 'hasty').length)[0];
  picker.value = 'hasty';
  picker.dispatch('change');
  assert.equal(model.params().variation, 80);
  assert.equal(model.params().sizeMm, 20, 'the size stays');
  source.dispose();
});
