// Photo crop and "Fade background": frame geometry (crop.js), image preprocessing (styles/prep.js), the model (crop, paper
// scale, vignette, presets) and the crop gesture on the preview (fake DOM).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fullRect, normalizeCrop, isFull, fieldAspect, fitAspect, hitTest, dragRect, MIN_CROP } from '../src/app/photo/crop.js';
import { cropImage, vignetteMask, applyVignette, normalizeVignette, toneFade, applyFade, VIGNETTE_DEFAULTS } from '../src/styles/prep.js';
import { engravingSteps, defaultParams as defaultEngraving } from '../src/styles/own/engraving.js';
import { createCache, runToEnd } from '../src/styles/own/kit/stages.js';
import { STYLES } from '../src/styles/registry.js';
import { createDriver, plain } from '../src/styles/style-driver.js';
import { createNativeSession } from '../src/styles/native-adapter.js';
import { createPhotoModel, VIGNETTE_PARAMS } from '../src/app/photo/photo-model.js';
import { fitSize } from '../src/app/photo/image-loader.js';
import { getStyle } from '../src/styles/registry.js';
import { setLocale } from '../src/i18n/index.js';
import { installFakeDom } from './helpers/fake-dom.js';
import { sameData } from './helpers/same.js';

const IMG = { width: 400, height: 300 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const inside = (r, img) => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= img.width + 1e-9 && r.y + r.h <= img.height + 1e-9;

// --- crop.js

test('normalizeCrop: whole px, clamped into the image, minimum size; the whole image and invalid rects -> null', () => {
  assert.deepEqual(normalizeCrop({ x: 10.4, y: 20.6, w: 100.2, h: 50.5 }, IMG), { x: 10, y: 21, w: 100, h: 51 });
  assert.deepEqual(normalizeCrop({ x: 350, y: -20, w: 100, h: 50 }, IMG), { x: 300, y: 0, w: 100, h: 50 });
  assert.deepEqual(normalizeCrop({ x: 10, y: 10, w: 2, h: 3 }, IMG), { x: 10, y: 10, w: MIN_CROP, h: MIN_CROP });
  assert.equal(normalizeCrop({ x: 0, y: 0, w: 400, h: 300 }, IMG), null);
  assert.equal(normalizeCrop({ x: -5, y: -5, w: 500, h: 500 }, IMG), null);
  assert.equal(normalizeCrop({ x: NaN, y: 0, w: 1, h: 1 }, IMG), null);
  assert.equal(normalizeCrop(null, IMG), null);
  assert.equal(isFull(null, IMG), true);
  assert.equal(isFull({ x: 0, y: 0, w: 399, h: 300 }, IMG), false);
});

test('fieldAspect: field minus margins, the inverse when rotated, null without a field', () => {
  assert.equal(fieldAspect({ fieldMm: { w: 200, h: 300 }, marginMm: 10, rotate: false }), 180 / 280);
  assert.equal(fieldAspect({ fieldMm: { w: 200, h: 300 }, marginMm: 10, rotate: true }), 280 / 180);
  assert.equal(fieldAspect({ fieldMm: { w: 10, h: 300 }, marginMm: 10 }), null);
  assert.equal(fieldAspect(null), null);
});

test('fitAspect: the largest rect of the aspect with the same centre inside the frame', () => {
  const r = fitAspect(null, IMG, 1);
  assert.deepEqual(r, { x: 50, y: 0, w: 300, h: 300 });
  const tall = fitAspect({ x: 100, y: 0, w: 200, h: 300 }, IMG, 2);
  assert.deepEqual(tall, { x: 100, y: 100, w: 200, h: 100 });
});

test('hitTest: corners win over sides, inside is move, outside is null; a small frame keeps an inside', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(hitTest(r, 100, 100, 10), 'nw');
  assert.equal(hitTest(r, 305, 205, 10), 'se');
  assert.equal(hitTest(r, 298, 95, 10), 'ne');
  assert.equal(hitTest(r, 104, 199, 10), 'sw');
  assert.equal(hitTest(r, 200, 103, 10), 'n');
  assert.equal(hitTest(r, 200, 196, 10), 's');
  assert.equal(hitTest(r, 96, 150, 10), 'w');
  assert.equal(hitTest(r, 309, 150, 10), 'e');
  assert.equal(hitTest(r, 200, 150, 10), 'move');
  assert.equal(hitTest(r, 50, 50, 10), null);
  assert.equal(hitTest(r, 200, 300, 10), null);
  assert.equal(hitTest({ x: 0, y: 0, w: 30, h: 30 }, 15, 15, 40), 'move', 'the grab zones shrink to a third of the side');
});

test('dragRect move: the size is kept, the frame stops at the image edge', () => {
  const start = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(start, 'move', 30, -20, IMG), { x: 130, y: 80, w: 200, h: 100 });
  assert.deepEqual(dragRect(start, 'move', 500, 500, IMG), { x: 200, y: 200, w: 200, h: 100 });
  assert.deepEqual(dragRect(start, 'move', -500, -500, IMG), { x: 0, y: 0, w: 200, h: 100 });
});

test('dragRect free: each handle moves only its sides, clamped to the image and the minimum size', () => {
  const s = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(dragRect(s, 'se', 50, 20, IMG), { x: 100, y: 100, w: 250, h: 120 });
  assert.deepEqual(dragRect(s, 'nw', -500, -500, IMG), { x: 0, y: 0, w: 300, h: 200 });
  assert.deepEqual(dragRect(s, 'e', 1000, 999, IMG), { x: 100, y: 100, w: 300, h: 100 });
  assert.deepEqual(dragRect(s, 'n', 0, 1000, IMG), { x: 100, y: 200 - MIN_CROP, w: 200, h: MIN_CROP });
  assert.deepEqual(dragRect(s, 'w', 1000, 0, IMG), { x: 300 - MIN_CROP, y: 100, w: MIN_CROP, h: 100 });
  assert.deepEqual(dragRect(s, 's', 7, -30, IMG), { x: 100, y: 100, w: 200, h: 70 });
});

test('dragRect with aspect: a corner keeps the opposite corner and the aspect, also at the image edge', () => {
  const a = 0.75, s = { x: 100, y: 50, w: 150, h: 200 };
  const r = dragRect(s, 'se', 30, 0, IMG, { aspect: a });
  assert.equal(r.x, 100); assert.equal(r.y, 50);
  assert.ok(near(r.w / r.h, a)); assert.ok(near(r.w, 180));
  const big = dragRect(s, 'se', 1000, 1000, IMG, { aspect: a });
  assert.ok(near(big.w / big.h, a)); assert.ok(inside(big, IMG)); assert.ok(near(big.y + big.h, 300), 'stops at the bottom edge');
  const nw = dragRect(s, 'nw', -1000, -10, IMG, { aspect: a });
  assert.ok(near(nw.x + nw.w, 250) && near(nw.y + nw.h, 250), 'the opposite corner stays');
  assert.ok(near(nw.w / nw.h, a)); assert.ok(inside(nw, IMG));
  const tiny = dragRect(s, 'se', -1000, -1000, IMG, { aspect: a });
  assert.ok(tiny.w >= MIN_CROP - 1e-9 && tiny.h >= MIN_CROP - 1e-9); assert.ok(near(tiny.w / tiny.h, a));
});

test('dragRect with aspect: a side keeps the opposite side and grows the other axis about the centre', () => {
  const a = 2, s = { x: 100, y: 100, w: 100, h: 50 };
  const r = dragRect(s, 'e', 40, 0, IMG, { aspect: a });
  assert.equal(r.x, 100); assert.ok(near(r.w, 140)); assert.ok(near(r.h, 70)); assert.ok(near(r.y + r.h / 2, 125), 'the centre stays');
  const wide = dragRect(s, 'e', 1000, 0, IMG, { aspect: a });
  assert.ok(near(wide.w / wide.h, a)); assert.ok(inside(wide, IMG));
  const down = dragRect(s, 's', 0, 1000, IMG, { aspect: a });
  assert.ok(near(down.w / down.h, a)); assert.ok(inside(down, IMG)); assert.equal(down.y, 100);
});

// --- styles/prep.js

const gradient = (w, h) => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = i % 256; data[i * 4 + 1] = (i * 7) % 256; data[i * 4 + 2] = (i * 13) % 256; data[i * 4 + 3] = 200; }
  return { width: w, height: h, data };
};

test('cropImage: the pixels of the rect, row by row; clamped to the image', () => {
  const img = gradient(20, 10);
  const c = cropImage(img, { x: 3, y: 2, w: 5, h: 4 });
  assert.equal(c.width, 5); assert.equal(c.height, 4);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) for (let ch = 0; ch < 4; ch++) {
    assert.equal(c.data[(y * 5 + x) * 4 + ch], img.data[((y + 2) * 20 + x + 3) * 4 + ch]);
  }
  const edge = cropImage(img, { x: 18, y: 8, w: 10, h: 10 });
  assert.equal(edge.width, 2); assert.equal(edge.height, 2);
});

test('vignetteMask: 1 in the centre, 0 outside the ellipse, monotonic along a radius; softness 0 is a step', () => {
  const w = 101, h = 61;
  const m = vignetteMask(w, h, { size: 100, softness: 40 });
  const at = (x, y) => m[y * w + x];
  assert.equal(at(50, 30), 1);
  assert.equal(at(0, 0), 0, 'a corner is outside the inscribed ellipse');
  assert.ok(at(0, 30) < 0.01, 'the edge pixel centre lies almost on the ellipse');
  let prev = 1;
  for (let x = 50; x >= 0; x--) { assert.ok(at(x, 30) <= prev + 1e-7); prev = at(x, 30); }
  assert.ok(at(15, 30) > 0 && at(15, 30) < 1, 'a soft transition inside the edge');
  const hard = vignetteMask(w, h, { size: 100, softness: 0 });
  for (const v of hard) assert.ok(v === 0 || v === 1);
  const big = vignetteMask(w, h, { size: 120, softness: 0 });
  assert.equal(big[0], 0); assert.equal(big[30 * w], 1, 'a larger ellipse keeps the side middle');
});

test('applyVignette: strength 0 is the same object; 100 — white outside, centre unchanged; 70 — v + 0.7·(255 − v); alpha kept', () => {
  const img = gradient(41, 31);
  assert.equal(applyVignette(img, { strength: 0 }), img);
  assert.equal(applyVignette(img, {}), img);
  const full = applyVignette(img, { strength: 100, size: 80, softness: 30 });
  assert.notEqual(full.data, img.data);
  const c = (15 * 41 + 20) * 4;
  assert.deepEqual([...full.data.subarray(c, c + 4)], [...img.data.subarray(c, c + 4)]);
  assert.deepEqual([...full.data.subarray(0, 4)], [255, 255, 255, 200]);
  const part = applyVignette(img, { strength: 70, size: 80, softness: 30 });
  for (let ch = 0; ch < 3; ch++) assert.ok(Math.abs(part.data[ch] - (img.data[ch] + 0.7 * (255 - img.data[ch]))) <= 1);
  assert.equal(part.data[3], 200);
  assert.deepEqual([...img.data.subarray(0, 4)], [0, 0, 0, 200], 'the source is not changed');
});

test('normalizeVignette: defaults, clamping, unknown keys dropped', () => {
  assert.deepEqual(normalizeVignette(), { ...VIGNETTE_DEFAULTS });
  assert.deepEqual(normalizeVignette({ strength: 300, size: 'x', softness: -5, extra: 1 }), { ...VIGNETTE_DEFAULTS, strength: 100, softness: 0 });
});

// --- the model

function fakeRunner() {
  const r = {
    runs: [], cancelled: [],
    probe: async () => [],
    run(uid, style, input, onState) { r.runs.push({ uid, input, onState }); },
    cancel(uid) { r.cancelled.push(uid); },
    live: () => false,
    dispose() {},
  };
  return r;
}

function fakeTimers() {
  let id = 0;
  const due = new Map();
  return {
    setTimeout: (fn) => { due.set(++id, fn); return id; },
    clearTimeout: (k) => { due.delete(k); },
    pending: () => due.size,
    run() { for (const [k, fn] of [...due]) { due.delete(k); fn(); } },
  };
}

/** rasterize like the real one: the frame (or the image) scaled to the long side, a grey image with a dark centre. */
function fakeRasterize(d, size, rect) {
  const src = rect || { w: d.width, h: d.height };
  const { width, height } = fitSize(src.w, src.h, size);
  const data = new Uint8ClampedArray(width * height * 4).fill(100);
  return { width, height, data };
}

function setup({ print = {}, saved = null, timers = fakeTimers() } = {}) {
  const runner = fakeRunner();
  let params = { fieldMm: { w: 200, h: 200 }, marginMm: 0, rotate: false, penWidthMm: 0.5, ...print };
  const ctx = {
    saves: [],
    emit() {}, presets: { load: async () => saved, save: async (o) => { ctx.saves.push(o); } },
    printParams: { get: () => structuredClone(params), subscribe: () => () => {} },
  };
  const model = createPhotoModel({
    getStyle, loadRunner: async () => runner, timers, rasterize: fakeRasterize,
    decodeImage: async () => ({ width: 800, height: 600, bitmap: { close() {} } }),
    defaultStyle: 'own:waves',
  });
  model.attach(ctx);
  return { model, runner, timers, ctx };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function loaded(env) {
  await env.model.loadFile({ name: 'p.jpg' });
  await env.model.addLayer('own:crosshatch');
  env.timers.run(); await tick();
  return env.model.stack.layers;
}

test('crop: the frame gets the working resolution, the paper scale follows it, every visible layer restarts once', async () => {
  const env = setup();
  const [waves, hatch] = await loaded(env);
  env.model.setWorkingSize(400);
  env.timers.run(); await tick();
  assert.equal(env.model.paper().mmPerPx, 0.5, '800×600 at 400 px on a 200 mm field');
  const before = env.runner.runs.length;

  env.model.setCrop({ x: 200, y: 150, w: 400, h: 300 });
  env.timers.run(); await tick();
  assert.deepEqual(env.model.crop(), { x: 200, y: 150, w: 400, h: 300 });
  const { imageData } = env.model.image();
  assert.deepEqual([imageData.width, imageData.height], [400, 300]);
  assert.equal(env.model.paper().mmPerPx, 0.5, 'the frame fills the field: half the photo on the same sheet');
  const runs = env.runner.runs.slice(before);
  assert.deepEqual(runs.map((r) => r.uid).sort(), [waves.uid, hatch.uid].sort(), 'one run per layer');
  assert.equal(runs.find((r) => r.uid === waves.uid).input.image.width, 400);
  assert.match(env.model.text('info'), /crop 400×300, working 400×300/);

  // the same frame again: nothing; a narrow frame: a new paper scale
  env.model.setCrop({ x: 200, y: 150, w: 400, h: 300 });
  env.timers.run(); await tick();
  assert.equal(env.runner.runs.length, before + 2);
  env.model.setCrop({ x: 0, y: 0, w: 200, h: 600 });
  assert.equal(env.model.paper().mmPerPx, 200 / 400, 'the long side 600 -> 400 px fills 200 mm');
  assert.equal(env.model.image().imageData.width, 133);

  env.model.resetCrop();
  assert.equal(env.model.crop(), null);
  assert.equal(env.model.image().imageData.width, 400);
});

test('crop: kept by a preset, reset by a new file, not in the preset', async () => {
  const env = setup();
  await loaded(env);
  env.model.setCrop({ x: 10, y: 10, w: 300, h: 200 });
  const preset = env.model.toPreset();
  assert.equal('crop' in preset, false);
  env.model.applyPreset(preset);
  assert.deepEqual(env.model.crop(), { x: 10, y: 10, w: 300, h: 200 });
  await env.model.loadFile({ name: 'q.jpg' });
  assert.equal(env.model.crop(), null);
});

test('crop lock "field": the frame is fitted to the drawing field aspect at once, dragging keeps it', async () => {
  const env = setup({ print: { fieldMm: { w: 180, h: 280 }, marginMm: 0 } });
  await loaded(env);
  env.model.setCropLock('field');
  const c = env.model.crop();
  assert.ok(Math.abs(c.w / c.h - 180 / 280) < 0.01, `${c.w}×${c.h}`);
  assert.equal(c.h, 600);
  assert.equal(env.model.cropAspect(), 180 / 280);
  env.model.setCropLock('free');
  assert.equal(env.model.cropAspect(), null);
});

test('vignette: saved at once, applied after the parameter delay with one restart per visible layer', async () => {
  const env = setup();
  const layers = await loaded(env);
  const before = env.runner.runs.length;
  env.model.setVignette({ strength: 30 });
  env.model.setVignette({ strength: 50 });
  env.model.setVignette({ strength: 70, size: 90 });
  await tick();
  assert.equal(env.runner.runs.length, before, 'nothing restarts while the slider moves');
  assert.equal(env.model.vignette().strength, 70);
  env.timers.run(); await tick();
  env.timers.run(); await tick();
  const runs = env.runner.runs.slice(before);
  assert.equal(runs.length, layers.length, 'one restart per layer');
  // own styles: the un-faded image (their direction fields stay natural) and the fade as a tone mask
  for (const r of runs) {
    assert.equal(r.input.image.data[0], 100, 'own styles analyse the un-faded image');
    assert.deepEqual(r.input.fade, { strength: 70, size: 90, softness: VIGNETTE_DEFAULTS.softness, cx: 0.5, cy: 0.5 });
  }
  // the underlay (and plotterfun styles) get it baked in
  const img = env.model.image().imageData, w = img.width, h = img.height;
  assert.ok(img.data[0] > 200, 'a corner is faded toward white');
  const c = ((h >> 1) * w + (w >> 1)) * 4;
  assert.equal(img.data[c], 100, 'the centre is unchanged');
  const saved = env.ctx.saves.at(-1);
  assert.deepEqual(saved.vignette, { strength: 70, size: 90, softness: VIGNETTE_DEFAULTS.softness });
});

test('vignette: a plotterfun layer (image only) gets the fade baked into its image and no tone mask', async () => {
  const env = setup();
  await loaded(env);
  const pf = STYLES.find((s) => s.adapter === 'plotterfun');
  await env.model.addLayer(pf.id);
  env.model.setVignette({ strength: 100 });
  env.timers.run(); await tick();
  env.timers.run(); await tick();
  const run = env.runner.runs.filter((r) => r.uid === env.model.stack.layers.at(-1).uid).at(-1);
  assert.equal(run.input.fade, undefined);
  assert.equal(run.input.image.data[0], 255, 'the corner is white');
  const own = env.runner.runs.filter((r) => r.uid === env.model.stack.layers[0].uid).at(-1);
  assert.equal(own.input.image.data[0], 100);
  assert.equal(own.input.fade.strength, 100);
});

test('vignette is tone only: the engraving direction field is bit-identical with and without it, the darkness fades toward the edges', () => {
  // a synthetic "portrait": a dark disc lit from the side on a textured background
  const w = 160, h = 200, gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x - 80, y - 90) / 50;
    gray[y * w + x] = d < 1 ? 60 + 90 * (x / w) : 150 + 40 * Math.sin(x / 5) * Math.cos(y / 7);
  }
  const v = { strength: 70, size: 90, softness: 40 };
  const fade = toneFade(w, h, v);
  const run = (f) => {
    const cache = createCache();
    const lines = runToEnd(engravingSteps({ gray, w, h, params: defaultEngraving(), paper: null, cache, fade: f }));
    return { lines, field: cache.get('field').value, tone: cache.get('tone').value };
  };
  const plain = run(null), faded = run(fade);
  sameData(faded.field, plain.field, 'the direction field ignores the fade');
  const at = (a, x, y) => a[y * w + x];
  assert.ok(at(faded.tone, 3, 3) < 0.45 * at(plain.tone, 3, 3), 'a corner is ~70 % lighter');
  assert.ok(Math.abs(at(faded.tone, 80, 90) - at(plain.tone, 80, 90)) < 1e-6, 'the centre tone is unchanged');
  const ink = (lines) => lines.reduce((s, l) => s + l.length, 0);
  assert.ok(ink(faded.lines) < ink(plain.lines), 'fewer lines with the fade');
  assert.equal(toneFade(w, h, { strength: 0 }), null);
  assert.equal(applyFade(plain.tone, null), plain.tone);
});

test('driver and native adapter: fade goes with "run" and reaches the steps (and plain styles) as a tone mask', () => {
  const seen = [];
  const impl = {
    staged: function* ({ fade }) { seen.push(fade); return []; },
    plainStyle: plain((gray, w, h, params, paper, fade) => { seen.push(fade); return []; }),
  };
  const driver = createDriver({ impl, post: () => {}, defer: (fn) => fn() });
  const image = { width: 10, height: 8, data: new Uint8ClampedArray(320).fill(255) };
  const [msg] = createNativeSession({ id: 'staged' }).runMessage({ runId: 1, image, params: {}, paper: null, fade: { strength: 50 } });
  driver.onMessage(msg);
  driver.onMessage({ type: 'run', runId: 2, styleId: 'plainStyle', image, params: {}, fade: { strength: 50 } });
  driver.onMessage({ type: 'run', runId: 3, styleId: 'staged', image, params: {} });
  assert.equal(seen.length, 3);
  for (const f of seen.slice(0, 2)) { assert.equal(f.length, 80); assert.ok(Math.abs(f[0] - 0.5) < 1e-6); assert.equal(f[4 * 10 + 5], 1); }
  assert.equal(seen[2], null);
});

test('vignette in presets: export and import, an old preset without it switches it off, restored on attach', async () => {
  const env = setup();
  await loaded(env);
  env.model.setVignette({ strength: 60 });
  const preset = env.model.toPreset();
  assert.equal(preset.vignette.strength, 60);
  env.model.applyPreset({ ...preset, vignette: undefined });
  assert.equal(env.model.vignette().strength, 0);
  env.model.applyPreset(preset);
  assert.equal(env.model.vignette().strength, 60);
  assert.ok(env.model.image().imageData.data[0] > 100, 'the image follows the preset at once');

  const restored = setup({ saved: preset });
  await tick();
  assert.equal(restored.model.vignette().strength, 60);
});

test('VIGNETTE_PARAMS: labels follow the language', () => {
  setLocale('ru');
  try { assert.equal(VIGNETTE_PARAMS[0].label, 'Сила, %'); } finally { setLocale('en'); }
  assert.equal(VIGNETTE_PARAMS[0].label, 'Strength, %');
});

// --- the view: crop gesture on the preview

let createPhotoSource;
const saved = {};
before(async () => {
  installFakeDom();
  for (const k of ['window', 'requestAnimationFrame', 'getComputedStyle']) saved[k] = globalThis[k];
  const media = { addEventListener() {}, removeEventListener() {} };
  globalThis.window = { matchMedia: () => media, devicePixelRatio: 1, confirm: () => true };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  ({ createPhotoSource } = await import('../src/app/tabs/photo-tab.js'));
});
after(() => { for (const [k, v] of Object.entries(saved)) globalThis[k] = v; });

async function mounted() {
  const doc = installFakeDom();
  const runner = fakeRunner();
  const model = createPhotoModel({
    getStyle, loadRunner: async () => runner, rasterize: fakeRasterize, paramDelay: 0, saveDelay: 0,
    decodeImage: async () => ({ width: 400, height: 200, bitmap: { close() {} } }),
  });
  const source = createPhotoSource({ createModel: () => model });
  const el = doc.createElement('div');
  const ctx = { emit() {}, presets: { load: async () => null, save: async () => {} },
    printParams: { get: () => ({ fieldMm: { w: 200, h: 200 }, marginMm: 0, rotate: false, penWidthMm: 0.5 }), subscribe: () => () => {} } };
  source.mount(el, ctx);
  await model.loadFile({ name: 'cat.jpg' });
  await tick();
  const canvas = el.findAll((n) => n.tagName === 'CANVAS')[0];
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 }); // 1 source px per CSS px
  canvas.setPointerCapture = () => {};
  const btn = (label) => el.findAll((n) => n.tagName === 'BUTTON' && n.textContent === label)[0];
  return { el, model, runner, source, canvas, btn, ctx };
}

const ptr = (x, y, id = 1) => ({ clientX: x, clientY: y, pointerId: id, pointerType: 'mouse', button: 0 });

test('crop gesture: dragging a corner moves a draft only, release sets the frame once and restarts the layer once', async () => {
  const { model, runner, canvas, btn } = await mounted();
  assert.equal(runner.runs.length, 1);
  btn('Crop').click();
  assert.equal(canvas.style.touchAction, 'none');
  canvas.dispatch('pointerdown', ptr(400, 200));
  canvas.dispatch('pointermove', ptr(350, 180));
  canvas.dispatch('pointermove', ptr(300, 150));
  await tick();
  assert.equal(model.crop(), null, 'the model is not touched while dragging');
  assert.equal(runner.runs.length, 1, 'no recalculation while dragging');
  canvas.dispatch('pointerup', ptr(300, 150));
  assert.deepEqual(model.crop(), { x: 0, y: 0, w: 300, h: 150 });
  await tick();
  assert.equal(runner.runs.length, 2, 'one recalculation on release');

  // move inside the frame, a cancelled gesture changes nothing
  canvas.dispatch('pointerdown', ptr(150, 75));
  canvas.dispatch('pointermove', ptr(400, 75));
  canvas.dispatch('pointerup', ptr(400, 75));
  assert.deepEqual(model.crop(), { x: 100, y: 0, w: 300, h: 150 });
  canvas.dispatch('pointerdown', ptr(250, 75));
  canvas.dispatch('pointermove', ptr(200, 75));
  canvas.dispatch('pointercancel', ptr(200, 75));
  assert.deepEqual(model.crop(), { x: 100, y: 0, w: 300, h: 150 });

  // reset and leave the mode: the view handlers are back
  btn('Reset crop').click();
  assert.equal(model.crop(), null);
  btn('Done').click();
  assert.equal(canvas.style.touchAction, 'pan-y');
});

test('crop and vignette survive a remount (language switch); the old canvas has no listeners', async () => {
  const { el, model, runner, source, canvas, btn, ctx } = await mounted();
  btn('Crop').click();
  canvas.dispatch('pointerdown', ptr(0, 0));
  canvas.dispatch('pointermove', ptr(100, 50));
  canvas.dispatch('pointerup', ptr(100, 50));
  const range = el.findAll((n) => n.tagName === 'INPUT' && n.type === 'range')[0];
  range.value = '70';
  range.dispatch('input');
  assert.equal(model.vignette().strength, 70);
  await tick(); await tick();
  const runs = runner.runs.length;

  source.unmount();
  assert.equal(canvas.listenerCount(), 0);
  setLocale('ru');
  try {
    const el2 = document.createElement('div');
    source.mount(el2, ctx);
    assert.deepEqual(model.crop(), { x: 100, y: 50, w: 300, h: 150 });
    assert.equal(model.vignette().strength, 70);
    assert.equal(el2.findAll((n) => n.tagName === 'INPUT' && n.type === 'range')[0].value, 70);
    const canvas2 = el2.findAll((n) => n.tagName === 'CANVAS')[0];
    assert.equal(canvas2.style.touchAction, 'none', 'still in crop mode');
    assert.ok(el2.findAll((n) => n.tagName === 'BUTTON' && n.textContent === 'Готово').length);
    await tick();
    assert.equal(runner.runs.length, runs, 'no restart on remount');
  } finally { setLocale('en'); source.dispose(); }
});
