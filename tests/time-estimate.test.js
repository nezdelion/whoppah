import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveSeconds, chainLengths, estimateTime, MERGE_ANGLE_DEG } from '../src/core/time-estimate.js';
import { createDrawing } from '../src/core/drawing.js';
import { generateGcode } from '../src/core/gcode.js';
import { defaultsOf, normalizeProfile, PROFILE_SCHEMA, CALIBRATION_SCHEMA } from '../src/core/profile.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const F = 3000; // v = 50 mm/s, a = 500 -> v²/a = 5 mm
const ACC = { accelXY: 500, accelZ: 100 };

test('move: a triangle if the feed is not reached', () => {
  near(moveSeconds(1, F, 500), 2 * Math.sqrt(0.002));
  near(moveSeconds(1, F, 500), 0.0894427, 1e-6);
});

test('move: trapezoid len/v + v/a', () => {
  near(moveSeconds(100, F, 500), 2.1);
});

test('move: at the boundary len = v²/a the formulas coincide', () => {
  near(moveSeconds(5, F, 500), 5 / 50 + 50 / 500); // 0.2
  near(moveSeconds(5, F, 500), 2 * Math.sqrt(5 / 500));
  near(moveSeconds(5 - 1e-9, F, 500), moveSeconds(5, F, 500), 1e-6);
});

test('a zero-length move — 0', () => {
  assert.equal(moveSeconds(0, F, 500), 0);
});

test('a straight polyline 10×1 mm: min — one 10 mm move, max — ten 1 mm moves', () => {
  const pts = [];
  for (let i = 0; i <= 10; i++) pts.push(i, 0);
  const t = estimateTime([{ kind: 'draw', pts, feed: F }], ACC);
  near(t.min, moveSeconds(10, F, 500));
  near(t.max, 10 * moveSeconds(1, F, 500));
  assert.ok(t.min < t.max);
});

test('a 90° zigzag: chains break, min == max', () => {
  const pts = [0, 0, 1, 0, 1, 1, 2, 1, 2, 2, 3, 2];
  assert.deepEqual(chainLengths(pts), [1, 1, 1, 1, 1]);
  const t = estimateTime([{ kind: 'draw', pts, feed: F }], ACC);
  near(t.min, t.max);
});

test('30° and exactly 45° bends merge, 60° ones do not', () => {
  const rad = (deg) => (deg * Math.PI) / 180;
  const bend = (deg) => [0, 0, 1, 0, 1 + Math.cos(rad(deg)), Math.sin(rad(deg))];
  assert.equal(MERGE_ANGLE_DEG, 45);
  assert.equal(chainLengths(bend(30)).length, 1);
  near(chainLengths(bend(30))[0], 2);
  assert.equal(chainLengths(bend(45)).length, 1);
  assert.equal(chainLengths(bend(60)).length, 2);
});

test('zero segments do not break the chain and do not give NaN', () => {
  const pts = [0, 0, 1, 0, 1, 0, 2, 0, 2, 0];
  assert.deepEqual(chainLengths(pts), [2]);
  const t = estimateTime([{ kind: 'draw', pts, feed: F }], ACC);
  assert.ok(Number.isFinite(t.min) && Number.isFinite(t.max));
  near(t.min, moveSeconds(2, F, 500));
  near(t.max, 2 * moveSeconds(1, F, 500));
  assert.deepEqual(chainLengths([5, 5, 5, 5]), []);
  assert.deepEqual(estimateTime([{ kind: 'draw', pts: [5, 5, 5, 5], feed: F }], ACC), { min: 0, max: 0 });
});

test('travel moves and Z — separate moves with their own acceleration', () => {
  const t = estimateTime([{ kind: 'travel', len: 100, feed: F }, { kind: 'z', len: 10, feed: 600 }], ACC);
  near(t.min, t.max);
  near(t.min, 2.1 + 1.1); // XY: 100/50 + 0.1; Z: 10/10 + 10/100
});

// --- generateGcode

const profile = defaultsOf(PROFILE_SCHEMA), cal = defaultsOf(CALIBRATION_SCHEMA);
const one = (lines) => createDrawing({ space: 'machine', layers: [{ id: 'a', name: 'a', lines }] });
const gen = (lines, over = {}) => generateGcode(one(lines), { profile: { ...profile, ...over }, calibration: cal }).stats;

// many short strokes with sharp angles and a smooth curve
const strokes = Array.from({ length: 40 }, (_, i) => [i, 60, i + 0.5, 60.5, i + 1, 60]);
const curve = [0, 100];
for (let i = 1; i <= 60; i++) curve.push(i * 0.5, 100 + 10 * Math.sin(i / 10));

test('generateGcode: ideal <= min <= max', () => {
  for (const lines of [strokes, [curve], [[0, 60, 30, 60]]]) {
    const st = gen(lines);
    const ideal = st.draw / (profile.fDraw / 60) + st.travel / (profile.fTravel / 60);
    assert.ok(ideal <= st.time.min + 1e-9, 'ideal <= min');
    assert.ok(st.time.min <= st.time.max + 1e-9, 'min <= max');
  }
  const st = gen([curve]);
  assert.ok(st.time.max > st.time.min);
});

test('generateGcode: a larger acceleration gives a shorter time', () => {
  const slow = gen(strokes, { accelXY: 200 }).time, fast = gen(strokes, { accelXY: 5000 }).time;
  assert.ok(fast.min < slow.min && fast.max < slow.max);
});

test('generateGcode: Z moves are counted with accelZ, XY with accelXY', () => {
  const zero = [[0, 60, 0.001, 60]]; // almost no drawing: Z 15→10, down 2.7, up 2.7, to 25 over 15 mm
  const a = gen(zero, { accelZ: 100 }).time.max;
  const b = gen(zero, { accelZ: 1e9 }).time.max;
  // trapezoids (5, 2.7 down, 15 mm): v/a = 0.2 + 0.1 + 0.2; the 2.7 mm lift is a triangle 2·sqrt(2.7/100), without accel — 2.7/20
  near(a - b, 0.5 + 2 * Math.sqrt(2.7 / 100) - 2.7 / 20, 1e-6);
  const c = gen(zero, { accelXY: 1e9 }).time.max;
  assert.ok(a - c > 0.05, 'XY travel depends on accelXY');
});

test('a profile without acceleration keys gets default values', () => {
  const p = normalizeProfile({ fDraw: 2000 });
  assert.equal(p.accelXY, 500);
  assert.equal(p.accelZ, 100);
});
