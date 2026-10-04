import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crosshatch, thresholdOf, DEFAULT_ANGLES, defaultParams } from '../src/styles/own/crosshatch.js';
import './helpers/ru.js';
import { sameData } from './helpers/same.js';

// horizontal gradient: white (255) on the left, black (0) on the right
const gradient = (w, h) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = 255 * (1 - x / (w - 1));
  return g;
};
const dirOf = (l) => {
  const a = (Math.atan2(l[3] - l[1], l[2] - l[0]) * 180) / Math.PI;
  return ((Math.round(a) % 180) + 180) % 180;
};
const P = { spacing: 3, blur: 0, minLength: 0 };

test('gradient: no lines at the white edge, then consecutively 1, 2, 3 and 4 directions', () => {
  const w = 200, h = 200;
  const lines = crosshatch(gradient(w, h), w, h, { ...P, levels: 4 });
  // for each area along x we count the set of line directions covering it
  const covered = (x) => new Set(lines.filter((l) => Math.min(l[0], l[2]) <= x + 1.5 && Math.max(l[0], l[2]) >= x - 1.5).map(dirOf));
  const lo = Math.min(...lines.flatMap((l) => [l[0], l[2]]));
  assert.ok(lo > w * (thresholdOf(1, 4) - 0.05), `no lines at the white edge, left end x=${lo}`);
  const counts = [0.1, 0.25, 0.45, 0.65, 0.9].map((f) => covered(f * w).size);
  assert.deepEqual(counts, [0, 1, 2, 3, 4]);
  assert.deepEqual([...new Set(lines.map(dirOf))].sort((a, b) => a - b), [0, 45, 90, 135]);
});

test('thresholds divide the tone range uniformly', () => {
  assert.equal(thresholdOf(1, 1), 0.5);
  assert.deepEqual([1, 2, 3, 4].map((k) => +thresholdOf(k, 4).toFixed(2)), [0.2, 0.4, 0.6, 0.8]);
  assert.deepEqual([...DEFAULT_ANGLES], [45, 135, 0, 90]);
});

test('a fully white image — no lines, a fully black one — present at every step', () => {
  assert.equal(crosshatch(new Float32Array(50 * 50).fill(255), 50, 50, { ...P, levels: 4 }).length, 0);
  const black = crosshatch(new Float32Array(50 * 50), 50, 50, { ...P, levels: 1, angle: -45 });
  // levels=1 angle 45-45=0: horizontals with step 3 every 50 px
  assert.ok(black.length >= 15 && black.length <= 18, `${black.length}`);
  for (const l of black) near(l[1], l[3]);
});

function near(a, b, eps = 1e-6) { assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`); }

test('fine noise: single dark pixels shorter than the minimum length are discarded', () => {
  const w = 60, h = 60;
  const img = new Float32Array(w * h).fill(255);
  for (const [x, y] of [[10, 10], [30, 31], [45, 12], [20, 50]]) img[y * w + x] = 0;
  assert.ok(crosshatch(img, w, h, { ...P, levels: 1, minLength: 0 }).length > 0, 'something remains without a threshold');
  assert.equal(crosshatch(img, w, h, { ...P, levels: 1, minLength: 4 }).length, 0);
});

test('the base angle rotates all levels', () => {
  const w = 120, h = 120;
  const g = new Float32Array(w * h);
  const a = crosshatch(g, w, h, { ...P, levels: 2, angle: 0 });
  const b = crosshatch(g, w, h, { ...P, levels: 2, angle: 15 });
  assert.deepEqual([...new Set(a.map(dirOf))].sort((x, y) => x - y), [45, 135]);
  assert.deepEqual([...new Set(b.map(dirOf))].sort((x, y) => x - y), [60, 150 % 180]);
});

test('zigzag: adjacent lines of one level run in opposite directions', () => {
  const w = 40, h = 40;
  const lines = crosshatch(new Float32Array(w * h), w, h, { ...P, levels: 1, angle: -45, minLength: 0 });
  const dir = lines.map((l) => Math.sign(l[2] - l[0]));
  for (let i = 1; i < dir.length; i++) assert.equal(dir[i], -dir[i - 1]);
});

test('determinism: two runs give the same result', () => {
  const w = 90, h = 70;
  const img = new Float32Array(w * h).map((_, i) => (i * 7919) % 256);
  const p = { ...defaultParams(), levels: 4, blur: 2 };
  sameData(crosshatch(img, w, h, p).map((l) => Array.from(l)), crosshatch(img, w, h, p).map((l) => Array.from(l)));
});

test('lines do not go outside the image', () => {
  const w = 80, h = 50;
  const lines = crosshatch(new Float32Array(w * h), w, h, { ...P, levels: 4 });
  for (const l of lines) for (let i = 0; i < 4; i += 2) {
    assert.ok(l[i] >= -1e-9 && l[i] <= w + 1e-9 && l[i + 1] >= -1e-9 && l[i + 1] <= h + 1e-9);
  }
});
