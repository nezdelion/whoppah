// Live language switch without a page reload: the language control, the tab host rebuild, and remounting the source views
// (SVG, Photo) keeps their models (file, image, layers, running computations) and does not duplicate subscriptions.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.js';
import { parseXml } from './helpers/xml.js';
import { setLocale, getLocale, t } from '../src/i18n/index.js';
import { createLanguageControl, LANG_KEY } from '../src/app/lang.js';
import { createState } from '../src/app/state.js';
import { getStyle } from '../src/styles/registry.js';

let createTabHost, createSvgSource, createPhotoSource, createPhotoModel, createLanguageSwitch;
const saved = {};
before(async () => {
  installFakeDom();
  for (const k of ['window', 'requestAnimationFrame', 'getComputedStyle']) saved[k] = globalThis[k];
  const media = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => media, devicePixelRatio: 1, confirm: () => true };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  ({ createTabHost } = await import('../src/app/ui/tab-host.js'));
  ({ createSvgSource } = await import('../src/app/tabs/svg-tab.js'));
  ({ createPhotoSource } = await import('../src/app/tabs/photo-tab.js'));
  ({ createPhotoModel } = await import('../src/app/photo/photo-model.js'));
  ({ createLanguageSwitch } = await import('../src/app/ui/lang-switch.js'));
});
after(() => { for (const [k, v] of Object.entries(saved)) globalThis[k] = v; setLocale('en'); });
beforeEach(() => setLocale('en'));

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const memStorage = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
};
const fakeRoot = () => {
  const el = { dataset: { i18n: 'app.subtitle' }, textContent: '' };
  return { el, documentElement: { lang: '' }, querySelectorAll: () => [el] };
};

/** A source context like createSourceContext, with counters: active print-parameter subscriptions, emitted drawings, preset reads. */
function fakeCtx() {
  let params = createState({ store: { load: async () => null, save: async () => {} } }).printParams();
  const subs = new Set();
  const ctx = {
    subs, emitted: [], presetLoads: 0, presetSaves: [],
    emit: (d) => ctx.emitted.push(d),
    ownsDrawing: () => true,
    presets: { load: async () => { ctx.presetLoads++; return null; }, save: async (o) => { ctx.presetSaves.push(o); } },
    printParams: {
      get: () => structuredClone(params),
      subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    },
    setParams(next) { params = { ...params, ...next }; for (const fn of [...subs]) fn(structuredClone(params)); },
  };
  return ctx;
}

// --- the language control

test('language control: switching enables the language, translates the markup, saves the choice and rebuilds — no reload', () => {
  const storage = memStorage(), root = fakeRoot();
  let rebuilds = 0;
  setLocale('en');
  const lang = createLanguageControl({ env: {}, storage, nav: { languages: ['en-US'] }, root, choice: 'auto', rebuild: () => rebuilds++ });
  assert.equal(lang.get(), 'auto');
  assert.equal(lang.set('ru'), 'ru');
  assert.equal(getLocale(), 'ru');
  assert.equal(storage.data[LANG_KEY], 'ru');
  assert.equal(lang.get(), 'ru');
  assert.equal(root.documentElement.lang, 'ru');
  assert.equal(root.el.textContent, 'рисунок → G-code → OctoPrint');
  assert.equal(rebuilds, 1);
  // the same language again (ru → ru): nothing to rebuild
  lang.set('ru');
  assert.equal(rebuilds, 1);
  // auto with an English browser: the choice is erased, the UI is rebuilt in English
  assert.equal(lang.set('auto'), 'en');
  assert.equal(LANG_KEY in storage.data, false);
  assert.equal(rebuilds, 2);
  // en after auto=en: the language did not change, the choice is saved, no rebuild
  lang.set('en');
  assert.equal(storage.data[LANG_KEY], 'en');
  assert.equal(rebuilds, 2);
  assert.equal(typeof globalThis.location, 'undefined', 'no page reload is possible here at all');
});

test('language control: auto follows the OctoPrint language; unavailable storage still switches (in memory)', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  let rebuilds = 0;
  const lang = createLanguageControl({ env: { language: 'ru' }, storage: broken, nav: { languages: ['en'] }, root: fakeRoot(), choice: 'en', rebuild: () => rebuilds++ });
  assert.equal(lang.set('auto'), 'ru');
  assert.equal(rebuilds, 1);
  assert.equal(lang.set('en'), 'en');
  assert.equal(lang.get(), 'en');
  assert.equal(rebuilds, 2);
  assert.equal(lang.set('klingon'), 'ru', 'a foreign value is auto');
  assert.equal(lang.get(), 'auto');
});

test('header language switch: Auto / English / Русский, the hint, set on change', () => {
  const chosen = [];
  const { element, select } = createLanguageSwitch({ get: () => 'ru', set: (v) => chosen.push(v) });
  const options = select.findAll((n) => n.tagName === 'OPTION');
  assert.deepEqual(options.map((o) => o.value), ['auto', 'en', 'ru']);
  assert.deepEqual(options.map((o) => o.textContent), [t('lang.auto'), 'English', 'Русский']);
  assert.equal(options[2].getAttribute('selected'), '');
  assert.equal(select.title, t('lang.hint'));
  assert.equal(select.getAttribute('aria-label'), t('lang.label'));
  assert.ok(element.findAll((n) => n.className === 'hint-icon').length, 'a "?" for touch screens');
  select.value = 'en';
  select.dispatch('change');
  assert.deepEqual(chosen, ['en']);
});

// --- the tab host

test('tab host: rebuild unmounts and mounts every view once, keeps the active tab, re-reads the titles', () => {
  const doc = installFakeDom();
  const nav = doc.createElement('nav'), panels = doc.createElement('main');
  const log = [];
  const tab = (id) => ({ id, get title() { return `${id}:${getLocale()}`; }, mount: (v) => { log.push(`mount ${id}`); v.append(id); }, unmount: () => log.push(`unmount ${id}`) });
  const host = createTabHost({ nav, panels, tabs: [tab('a'), tab('b')] });
  host.mount();
  host.mount(); // idempotent
  assert.deepEqual(log, ['mount a', 'mount b']);
  assert.equal(nav.children.length, 2);
  assert.equal(panels.children.length, 2);
  host.show('b');
  setLocale('ru');
  host.rebuild();
  assert.deepEqual(log, ['mount a', 'mount b', 'unmount a', 'unmount b', 'mount a', 'mount b']);
  assert.equal(nav.children.length, 2, 'no duplicate buttons');
  assert.equal(panels.children.length, 2, 'no duplicate panels');
  assert.equal(host.active(), 'b');
  assert.deepEqual(panels.children.map((p) => p.hidden), [true, false]);
  assert.equal(nav.children[1].button.getAttribute('aria-selected'), 'true');
  assert.equal(nav.children[0].button.textContent, 'a:ru');
  host.show('nope');
  assert.equal(host.active(), 'b');
});

// --- SVG source

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"><path d="M0 0 L100 50 L0 50"/></svg>';
const svgFile = (name = 'star.svg') => ({ name, text: async () => SVG });

test('SVG source: a remount keeps the loaded file, does not re-emit or double-subscribe, shows the info in the new language', async () => {
  const doc = installFakeDom();
  const source = createSvgSource({ parse: parseXml });
  const ctx = fakeCtx();
  const el1 = doc.createElement('div');
  source.mount(el1, ctx);
  await source.load(svgFile());
  assert.equal(ctx.emitted.length, 1);
  assert.match(el1.textContent, /star: 1 line, 3 points/);
  assert.equal(ctx.subs.size, 1);

  source.unmount();
  assert.equal(ctx.subs.size, 0);
  setLocale('ru');
  const el2 = doc.createElement('div');
  source.mount(el2, ctx);
  assert.equal(source.loadedName(), 'star');
  assert.equal(ctx.emitted.length, 1, 'a remount does not emit the drawing again');
  assert.equal(ctx.subs.size, 1, 'one print-parameter subscription');
  assert.match(el2.textContent, /star: 1 линия, 3 точки/);

  // the file is still there: a field change re-imports it once
  ctx.setParams({ marginMm: ctx.printParams.get().marginMm + 5 });
  assert.equal(ctx.emitted.length, 2);
  // the old view is not updated anymore
  assert.match(el1.textContent, /star: 1 line/);
});

// --- Photo source

function fakeRunner() {
  const r = {
    runs: [], disposed: 0, cancelled: [],
    probe: async () => [],
    run(uid, style, input, onState) { r.runs.push({ uid, input, onState }); },
    cancel(uid) { r.cancelled.push(uid); },
    live: () => false,
    dispose() { r.disposed++; },
  };
  return r;
}

/** The real model with a fake runner and image decoding; subscriptions of the views to the model and the stack are counted. */
function countedModel(runner) {
  const model = createPhotoModel({
    getStyle, loadRunner: async () => runner,
    decodeImage: async () => ({ width: 400, height: 200, bitmap: { close() {} } }),
    rasterize: (d, size) => ({ width: size, height: size / 2, data: new Uint8ClampedArray(4) }),
    paramDelay: 0, saveDelay: 0,
  });
  const views = { stack: new Set(), model: new Set() };
  const wrap = (target, set) => {
    const orig = target.subscribe.bind(target);
    target.subscribe = (fn) => { const off = orig(fn); set.add(fn); return () => { set.delete(fn); off(); }; };
  };
  wrap(model.stack, views.stack);
  wrap(model, views.model);
  return { model, views };
}

test('Photo source: a remount keeps the image, layers, parameters and the running computation; old subscriptions are removed', async () => {
  const doc = installFakeDom();
  const runner = fakeRunner();
  const { model, views } = countedModel(runner);
  const source = createPhotoSource({ createModel: () => model });
  const ctx = fakeCtx();

  const el1 = doc.createElement('div');
  source.mount(el1, ctx);
  await model.loadFile({ name: 'cat.jpg' });
  await tick();
  assert.equal(runner.runs.length, 1, 'the default layer started');
  const layer = model.stack.layers[0];
  const desc = getStyle('own:crosshatch').params.find((d) => d.type !== 'bool' && d.type !== 'select');
  const value = desc.default === desc.max ? desc.min : desc.max;
  model.changeParam(layer.uid, getStyle('own:crosshatch').params, desc.key, value);
  await tick();
  const runsBefore = runner.runs.length;
  const decoded = model.image().decoded;
  assert.equal(views.stack.size, 1);
  assert.equal(views.model.size, 1);
  assert.match(el1.textContent, /cat: 400×200, working 800×400/);

  source.unmount();
  assert.equal(views.stack.size, 0, 'the old view unsubscribed from the stack');
  assert.equal(views.model.size, 0, 'the old view unsubscribed from the model');
  setLocale('ru');
  const el2 = doc.createElement('div');
  source.mount(el2, ctx);
  assert.equal(views.stack.size, 1, 'one view subscription, not two');
  assert.equal(views.model.size, 1);
  assert.equal(ctx.subs.size, 1, 'the model keeps one print-parameter subscription');
  assert.equal(ctx.presetLoads, 1, 'the saved stack is restored only on the first mount');

  // the model survived: the image, the layer with its parameters, the working size; the run was not restarted or killed
  assert.equal(model.image().decoded, decoded);
  assert.equal(model.stack.layers[0], layer);
  assert.equal(layer.params[desc.key], value);
  assert.equal(model.workingSize(), 800);
  assert.equal(runner.runs.length, runsBefore, 'no restart on remount');
  assert.equal(runner.disposed, 0, 'the workers are not disposed by a remount');
  assert.match(el2.textContent, /cat: 400×200, рабочее 800×400/);

  // the running computation finishes after the remount: the new view shows it, the old one is not touched
  const old1 = el1.textContent;
  runner.runs.at(-1).onState({ status: 'done', lines: [[0, 0, 10, 10, 20, 0]] });
  assert.match(el2.textContent, /1 линия, 3 точки/);
  assert.equal(el1.textContent, old1);

  // "To print" from the new view emits the drawing
  assert.equal(model.sendToPrint(() => true), true);
  assert.equal(ctx.emitted.length, 1);

  source.dispose();
  assert.equal(runner.disposed, 1);
  assert.equal(ctx.subs.size, 0);
});

test('Photo source: the canvas listeners of an unmounted view are removed', () => {
  const doc = installFakeDom();
  const { model } = countedModel(fakeRunner());
  const source = createPhotoSource({ createModel: () => model });
  const el = doc.createElement('div');
  source.mount(el, fakeCtx());
  const canvas = el.findAll((n) => n.tagName === 'CANVAS')[0];
  assert.ok(canvas.listenerCount() > 0);
  source.unmount();
  assert.equal(canvas.listenerCount(), 0);
});

// --- Print tab settings panel

test('settings panel: destroy removes the state, calibration and indicator subscriptions (the panel is rebuilt on a switch)', async () => {
  const doc = installFakeDom();
  const { mountSettingsPanel } = await import('../src/app/ui/settings-panel.js');
  const store = { load: async () => null, save: async () => {} };
  const state = createState({ store });
  const active = new Set();
  const counted = (fn) => { const token = { fn }; active.add(token); return () => active.delete(token); };
  const origSubscribe = state.subscribe;
  state.subscribe = (fn) => { const off = origSubscribe(fn); const offCount = counted(fn); return () => { off(); offCount(); }; };
  const monitor = { status: () => ({ status: 'unconfigured', detail: '' }), subscribe: counted };
  const calibrator = {
    link: () => ({ xy: { ok: true }, z: { ok: true }, hint: '' }), subscribeLink: counted,
    monitor: { subscribe: counted, status: () => ({ message: '' }) }, capture: { unsupported: false }, jog: null,
  };
  const panel = mountSettingsPanel(doc.createElement('div'), { state, store, notify: () => {}, ui: { connectionMonitor: monitor, calibrator, configured: () => true } });
  assert.equal(active.size, 4, 'state, connection indicator, Home guard, calibration monitor');
  panel.destroy();
  assert.equal(active.size, 0);
});
