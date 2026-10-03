// Photo model and tab helpers for styles with parameters in mm on paper: the paper scale in runs, restarts on print
// parameter changes, style presets, the density estimate and translated progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPhotoModel } from '../src/app/photo/photo-model.js';
import { progressText } from '../src/app/photo/layer-stack.js';
import { estimateSpacing, densityText } from '../src/app/photo/density.js';
import { getStyle } from '../src/styles/registry.js';
import { setLocale } from '../src/i18n/index.js';
import { presetValues } from '../src/styles/own/kit/params.js';
import { buildParamForm, buildPresetPicker } from '../src/app/photo/param-form.js';
import { installFakeDom } from './helpers/fake-dom.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeRunner() {
  const r = {
    runs: [], cancelled: [], lives: [],
    probe: async () => [],
    run(uid, style, input, onState) { r.runs.push({ uid, styleId: style.id, input, onState }); },
    cancel(uid) { r.cancelled.push(uid); },
    live(uid, params) { r.lives.push({ uid, params }); return true; },
    dispose() {},
  };
  return r;
}

/** Manual timers: run() fires everything due. */
function fakeTimers() {
  let id = 0;
  const due = new Map();
  return {
    setTimeout: (fn) => { due.set(++id, fn); return id; },
    clearTimeout: (k) => { due.delete(k); },
    run() { for (const [k, fn] of [...due]) { due.delete(k); fn(); } },
  };
}

function setup(print = {}) {
  const runner = fakeRunner(), timers = fakeTimers();
  let params = { fieldMm: { w: 200, h: 200 }, marginMm: 0, rotate: false, penWidthMm: 0.5, ...print };
  const subs = new Set();
  const ctx = {
    emit() {}, presets: { load: async () => null, save: async () => {} },
    printParams: { get: () => structuredClone(params), subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } },
    set(next) { params = { ...params, ...next }; for (const fn of [...subs]) fn(structuredClone(params)); },
  };
  const model = createPhotoModel({
    getStyle, loadRunner: async () => runner, timers,
    decodeImage: async () => ({ width: 800, height: 600, bitmap: { close() {} } }),
    rasterize: (d, size) => ({ width: size, height: (size * 3) / 4, data: new Uint8ClampedArray(4) }),
    defaultStyle: 'own:waves',
  });
  model.attach(ctx);
  return { model, runner, timers, ctx };
}

async function withLayers(env) {
  await env.model.loadFile({ name: 'p.jpg' });
  await env.model.addLayer('own:crosshatch');
  env.timers.run(); await tick();
  return env.model.stack.layers;
}

test('paper scale: 800×600 on a 200×200 field without margin -> 0.25 mm/px; it goes into the run', async () => {
  const env = setup();
  const [waves, hatch] = await withLayers(env);
  assert.equal(waves.styleId, 'own:waves');
  assert.equal(hatch.styleId, 'own:crosshatch');
  assert.deepEqual(env.model.paper(), { mmPerPx: 0.25, penWidthMm: 0.5 });
  const run = env.runner.runs.find((r) => r.uid === waves.uid);
  assert.deepEqual(run.input.paper, { mmPerPx: 0.25, penWidthMm: 0.5 });
  // a 1 mm step is 4 px in the working image
  assert.equal(getStyle('own:waves').spacing({ spacing: 1 }, run.input.image, run.input.paper), 4);
});

test('pen width change restarts the wave-lines layer with the new pen, crosshatch is not touched', async () => {
  const env = setup();
  const [waves, hatch] = await withLayers(env);
  const before = env.runner.runs.length;
  env.ctx.set({ penWidthMm: 0.8 });
  env.timers.run(); await tick();
  const fresh = env.runner.runs.slice(before);
  assert.deepEqual(fresh.map((r) => r.uid), [waves.uid]);
  assert.deepEqual(fresh[0].input.paper, { mmPerPx: 0.25, penWidthMm: 0.8 });
  assert.ok(!fresh.some((r) => r.uid === hatch.uid));
  // field, margin and rotation change the scale -> restart
  env.ctx.set({ marginMm: 10 });
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.at(-1).uid, waves.uid);
  assert.ok(Math.abs(env.runner.runs.at(-1).input.paper.mmPerPx - 180 / 800) < 1e-12);
});

test('print parameters that keep the scale and the pen restart nothing; a hidden layer is reset instead', async () => {
  const env = setup();
  const [waves] = await withLayers(env);
  const before = env.runner.runs.length;
  env.ctx.set({ fieldMm: { w: 200, h: 300 } }); // the width limits: the scale stays 0.25
  env.ctx.set({});
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.length, before, 'nothing restarted');
  env.model.stack.applyResult(waves.uid, { status: 'done', lines: [[0, 0, 1, 1]] });
  env.model.setVisible(waves.uid, false);
  env.ctx.set({ penWidthMm: 0.3 });
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.length, before, 'a hidden layer is not computed');
  assert.equal(waves.status, 'idle', 'its old result is dropped');
  env.model.setVisible(waves.uid, true);
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.at(-1).uid, waves.uid, 'showing it recomputes with the new paper');
  assert.equal(env.runner.runs.at(-1).input.paper.penWidthMm, 0.3);
});

test('style preset: defaults overlaid with the preset in one change, the layer restarts (not live)', async () => {
  const env = setup();
  const [waves] = await withLayers(env);
  const style = getStyle('own:waves');
  env.model.changeParam(waves.uid, style.params, 'gamma', 2);
  assert.equal(env.runner.lives.length, 1, 'a slider goes the live path');
  const events = [];
  env.model.stack.subscribe((e) => events.push(e));
  const before = env.runner.runs.length;
  assert.equal(env.model.applyStylePreset(waves.uid, 'bold'), true);
  assert.deepEqual(waves.params, presetValues(style.params, style.presets.find((p) => p.id === 'bold')));
  assert.equal(waves.params.gamma, 1, 'other values back to the defaults');
  assert.equal(events.filter((e) => e.type === 'params').length, 1, 'one change');
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.length, before + 1, 'restarted');
  assert.equal(env.runner.lives.length, 1, 'not through the live path');
  assert.equal(env.model.applyStylePreset(waves.uid, 'nope'), false);
  assert.equal(env.model.toPreset().layers[0].params.spacing, 2.5, 'the values are saved in the tab preset as usual');
});

test('density: spacing 0.4 mm with a 0.5 mm pen warns that lines merge, 1.2 mm shows the step', async () => {
  setLocale('en');
  const env = setup();
  await withLayers(env);
  const { imageData } = env.model.image(), paper = env.model.paper(), print = env.model.printParams();
  const style = getStyle('own:waves');
  const est = (spacing) => estimateSpacing(style.spacing({ spacing }, imageData, paper), imageData, print);
  assert.equal(est(0.4).tooDense, true);
  assert.equal(densityText(est(0.4), 0.5), 'step 0.4 mm is smaller than the pen width 0.5 mm: lines merge');
  assert.equal(est(1.2).tooDense, false);
  assert.equal(densityText(est(1.2), 0.5), 'step 1.2 mm');
});

test('progress with a number: "Wave lines 40%" / "Волнистые линии 40%"; string keys and foreign texts as before', () => {
  const p = { key: 'styles.progress.waves', params: { percent: 40 } };
  try {
    setLocale('en');
    assert.equal(progressText(p), 'Wave lines 40%');
    assert.equal(progressText('styles.progress.hatch'), 'Computing hatching');
    assert.equal(progressText('Iteration 12'), 'Iteration 12');
    assert.equal(progressText(''), '');
    setLocale('ru');
    assert.equal(progressText(p), 'Волнистые линии 40%');
    assert.equal(progressText({ key: 'styles.progress.waves', params: { percent: 12.5 } }), 'Волнистые линии 12,5%');
  } finally { setLocale('en'); }
});

test('layer form: select options by optionLabel in the current language; the preset row follows the values', () => {
  installFakeDom();
  const style = getStyle('own:waves');
  const values = presetValues(style.params, style.presets[1]);
  const optionTexts = (form) => form.findAll((n) => n.tagName === 'OPTION').map((o) => [o.value, o.textContent]);
  try {
    setLocale('en');
    assert.deepEqual(optionTexts(buildParamForm(style.params, values, () => {})), [['amplitude', 'Amplitude'], ['frequency', 'Frequency'], ['both', 'Both']]);
    setLocale('ru');
    const form = buildParamForm(style.params, values, () => {});
    assert.deepEqual(optionTexts(form), [['amplitude', 'Амплитуда'], ['frequency', 'Частота'], ['both', 'Обе']]);
    assert.equal(form.findAll((n) => n.tagName === 'OPTION').find((o) => o.value === 'both').hasAttribute('selected'), true, 'the value is selected, not the label');

    const picked = [];
    const picker = buildPresetPicker(style.params, style.presets, values, (id) => picked.push(id));
    assert.deepEqual(picker.select.findAll((n) => n.tagName === 'OPTION').map((o) => o.textContent), ['—', 'Тонкие волны', 'Классика', 'Крупно']);
    assert.equal(picker.select.value, 'classic', 'the defaults are the classic preset');
    picker.sync({ ...values, spacing: 1.5 });
    assert.equal(picker.select.value, '', 'a manual change shows "—"');
    picker.select.value = 'bold';
    picker.select.dispatch('change');
    assert.deepEqual(picked, ['bold']);
    picker.select.value = '';
    picker.select.dispatch('change');
    assert.deepEqual(picked, ['bold'], '"—" does nothing');
  } finally { setLocale('en'); }
});
