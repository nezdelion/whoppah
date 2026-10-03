import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toGray, toDarkness, boxBlur, sampleBilinear, levelsRange, autoLevels, localContrast, LEVELS_MIN_RANGE } from '../src/styles/tone.js';
import './helpers/ru.js';

const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('toGray: gray by ITU-R 601, transparency — white', () => {
  const g = toGray(Uint8ClampedArray.of(255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0, 0, 0, 0, 255), 4, 1);
  near(g[0], 0.299 * 255);
  near(g[1], 0.587 * 255);
  near(g[2], 255);
  near(g[3], 0);
});

test('toDarkness: white 0, black 1, the midpoint about 0.5', () => {
  const d = toDarkness(Float32Array.of(255, 0, 127.5));
  near(d[0], 0); near(d[1], 1); near(d[2], 0.5);
});

test('toDarkness: inversion turns the darkness into its complement', () => {
  const d = toDarkness(Float32Array.of(255, 0, 51), { invert: true });
  near(d[0], 1); near(d[1], 0); near(d[2], 51 / 255);
});

test('toDarkness: brightness shifts, contrast stretches around 128', () => {
  near(toDarkness(Float32Array.of(100), { brightness: 55 })[0], (255 - 155) / 255);
  const factor = (259 * (100 + 255)) / (255 * (259 - 100));
  const expected = (255 - Math.min(255, Math.max(0, factor * (200 - 128) + 128))) / 255;
  near(toDarkness(Float32Array.of(200), { contrast: 100 })[0], expected);
  near(toDarkness(Float32Array.of(128), { contrast: 100 })[0], 127 / 255);
});

test('toDarkness: minimum and maximum brightness clamp the range', () => {
  const d = toDarkness(Float32Array.of(0, 100, 255), { min: 100, max: 200 });
  near(d[0], 100 / 200); near(d[1], 100 / 200); near(d[2], 0.5 * 0 + Math.max((200 - 255) / 200, 0));
});

test('boxBlur: radius 0 — a copy, a constant field does not change, a peak spreads preserving the sum', () => {
  const src = Float32Array.of(0, 0, 0, 9, 0, 0, 0);
  const copy = boxBlur(src, 7, 1, 0);
  assert.deepEqual(Array.from(copy), Array.from(src));
  assert.notEqual(copy, src);
  const flat = boxBlur(new Float32Array(25).fill(0.4), 5, 5, 2);
  for (const v of flat) near(v, 0.4);
  const b = boxBlur(src, 7, 1, 1);
  assert.deepEqual(Array.from(b).map((v) => +v.toFixed(3)), [0, 0, 3, 3, 3, 0, 0]);
});

test('boxBlur: works along both axes', () => {
  const src = new Float32Array(25); src[12] = 9;
  const b = boxBlur(src, 5, 5, 1);
  near(b[12], 1); near(b[6], 1); near(b[0], 0);
  near(b.reduce((a, v) => a + v, 0), 9);
});

// the formula before gamma (a frozen copy): gamma = 1 must give exactly these bits
function oldDarkness(gray, { invert = false, brightness = 0, contrast = 0, min = 0, max = 255 } = {}) {
  const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
  const span = Math.max(max, 1);
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) {
    let b = contrast !== 0 ? factor * (gray[i] - 128) + 128 + brightness : gray[i] + brightness;
    b = Math.min(Math.max(b, 0), 255);
    if (invert) b = 255 - b;
    b = Math.max(min, b);
    out[i] = Math.min(Math.max((max - b) / span, 0), 1);
  }
  return out;
}

test('toDarkness: gamma 1 (and no gamma) is bit for bit the old computation', () => {
  const gray = Float32Array.from({ length: 256 }, (_, i) => i);
  for (const opts of [{}, { invert: true }, { brightness: 30, contrast: -40 }, { contrast: 70, min: 20, max: 230 }]) {
    assert.deepEqual(Array.from(toDarkness(gray, { ...opts, gamma: 1 })), Array.from(oldDarkness(gray, opts)));
    assert.deepEqual(Array.from(toDarkness(gray, opts)), Array.from(oldDarkness(gray, opts)));
  }
});

test('toDarkness: gamma 2 lightens the midtone (0.5 -> about 0.29), gamma 0.5 darkens it; the ends stay', () => {
  const g = Float32Array.of(255, 127.5, 0);
  const light = toDarkness(g, { gamma: 2 }), dark = toDarkness(g, { gamma: 0.5 });
  near(light[1], 1 - Math.sqrt(0.5));
  assert.ok(Math.abs(light[1] - 0.29) < 0.01);
  near(dark[1], 0.75);
  near(light[0], 0); near(light[2], 1); near(dark[0], 0); near(dark[2], 1);
  // inversion first, then gamma: inverted midtone is also lighter (less darkness)
  assert.ok(toDarkness(Float32Array.of(127.5), { invert: true, gamma: 2 })[0] < 0.5);
});

test('sampleBilinear: the pixel value at its centre, the mean between centres, the edge repeats', () => {
  // 3x2 field
  const f = Float32Array.of(0, 1, 2, 10, 11, 12);
  near(sampleBilinear(f, 3, 2, 0.5, 0.5), 0);
  near(sampleBilinear(f, 3, 2, 2.5, 1.5), 12);
  near(sampleBilinear(f, 3, 2, 1, 0.5), 0.5);
  near(sampleBilinear(f, 3, 2, 0.5, 1), 5);
  near(sampleBilinear(f, 3, 2, 1, 1), 5.5);
  near(sampleBilinear(f, 3, 2, -5, -5), 0);
  near(sampleBilinear(f, 3, 2, 99, 99), 12);
  near(sampleBilinear(f, 3, 2, 3, 0.5), 2);
  near(sampleBilinear(Float32Array.of(7), 1, 1, 0.2, 0.9), 7);
});

test('auto levels: the percentile range is stretched to 0..255, the clipped tails clamp, a flat image stays as is', () => {
  // a washed-out image: 1000 pixels evenly 100..199 plus 1 % outliers at 0 and at 255
  const g = new Float32Array(1020);
  for (let i = 0; i < 1000; i++) g[i] = 100 + (i % 100);
  for (let i = 1000; i < 1010; i++) g[i] = 0;
  for (let i = 1010; i < 1020; i++) g[i] = 255;
  assert.deepEqual(levelsRange(g, 0), [0, 255]);
  assert.deepEqual(levelsRange(g, 1.5), [100, 199]);
  const out = autoLevels(g, 1.5);
  near(out[0], 0); near(out[99], 255); // 100 → 0, 199 → 255
  near(out[49], (49 / 99) * 255, 1e-3);
  assert.equal(out[1005], 0); assert.equal(out[1015], 255);
  for (let i = 1; i < 100; i++) assert.ok(out[i] > out[i - 1], 'monotone');
  // a flat (or almost flat) image: an unchanged copy
  const flat = new Float32Array(50).fill(128);
  flat[3] = 128 + LEVELS_MIN_RANGE - 1;
  const same = autoLevels(flat, 0);
  assert.notEqual(same, flat);
  assert.deepEqual(Array.from(same), Array.from(flat));
});

test('local contrast: amount 0 and a flat image are unchanged; a dim face beside a bright background gets its range back', () => {
  const w = 160, h = 80;
  const flat = new Float32Array(w * h).fill(90);
  assert.deepEqual(Array.from(localContrast(flat, w, h, { amount: 0.8 }), (v) => Math.round(v)), Array.from(flat));
  // left half: a low-contrast gradient 200..230 (a washed-out face), right half: white
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = x < w / 2 ? 200 + 30 * (y / (h - 1)) : 255;
  assert.deepEqual(Array.from(localContrast(g, w, h, { amount: 0 })), Array.from(g));
  const out = localContrast(g, w, h, { amount: 1, tiles: 8 });
  const col = (img, x) => Array.from({ length: h }, (_, y) => img[y * w + x]);
  const range = (a) => Math.max(...a) - Math.min(...a);
  const before = range(col(g, 20)), after = range(col(out, 20));
  assert.ok(after > 1.4 * before, `the face range ${before.toFixed(0)} → ${after.toFixed(0)}`);
  // the order of tones along the face is kept, the white stays white
  const c = col(out, 20);
  for (let y = 1; y < h; y++) assert.ok(c[y] >= c[y - 1] - 0.5, `row ${y}: ${c[y - 1]} → ${c[y]}`);
  assert.ok(out[40 * w + 150] > 245);
});
