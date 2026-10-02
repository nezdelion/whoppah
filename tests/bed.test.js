import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bedRect, printArea, rectOverflow, bedFromPoints, bedPoints, applyBedPoint, bedHint, clearedBed } from '../src/core/bed.js';
import { defaultsOf, PROFILE_SCHEMA } from '../src/core/profile.js';
import './helpers/ru.js';

const base = defaultsOf(PROFILE_SCHEMA); // limits X-4…234 Y1…231, nominal 235×235, bed not measured
const withBed = (x0, y0, x1, y1, extra = {}) => ({ ...base, bedX0: x0, bedY0: y0, bedX1: x1, bedY1: y1, ...extra });

test('bed not measured: the print area is the axis limits, bedMeasured false', () => {
  assert.equal(bedRect(base), null);
  assert.deepEqual(printArea(base), { x0: -4, x1: 234, y0: 1, y1: 231, bedMeasured: false });
});

test('the print area is the limits ∩ the bed (pen offset to the right of the nozzle)', () => {
  const a = printArea(withBed(-12, -3, 221, 230));
  assert.deepEqual(a, { x0: -4, y0: 1, x1: 221, y1: 230, bedMeasured: true });
});

test('a partial or degenerate bed counts as not measured', () => {
  assert.equal(bedRect({ ...base, bedX0: -12, bedY0: -3 }), null);
  assert.equal(bedRect(withBed(100, 0, 50, 10)), null);
  assert.equal(printArea(withBed(100, 0, 50, 10)).bedMeasured, false);
});

test('a nominal upper right corner follows the nominal size', () => {
  assert.deepEqual(bedRect(withBed(-12, -3, 223, 232, { bedUrNominal: true, bedW: 230 })), { x0: -12, y0: -3, x1: 218, y1: 232 });
});

test('rectOverflow per side', () => {
  const area = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert.deepEqual(rectOverflow({ x0: -2, y0: 10, x1: 50, y1: 50 }, area), { left: 2, right: 0, bottom: 0, top: 0 });
  assert.deepEqual(rectOverflow({ x0: 10, y0: 10, x1: 105, y1: 50 }, area), { left: 0, right: 5, bottom: 0, top: 0 });
  assert.deepEqual(rectOverflow({ x0: 10, y0: -1, x1: 50, y1: 50 }, area), { left: 0, right: 0, bottom: 1, top: 0 });
  assert.deepEqual(rectOverflow({ x0: 10, y0: 10, x1: 50, y1: 103 }, area), { left: 0, right: 0, bottom: 0, top: 3 });
  assert.deepEqual(rectOverflow({ x0: 10, y0: 10, x1: 50, y1: 50 }, area), { left: 0, right: 0, bottom: 0, top: 0 });
});

test('bedHint: 8 mm off the nominal — a hint, 4 mm — none; a nominal corner — none', () => {
  const nominal = { w: 235, h: 235 };
  assert.deepEqual(bedHint({ x0: -12, y0: -3, x1: 215, y1: 230 }, nominal, 5), ['ширина стола отличается от номинальной на 8,0 мм: проверьте точку']);
  assert.deepEqual(bedHint({ x0: -12, y0: -3, x1: 219, y1: 230 }, nominal, 5), []);
  assert.deepEqual(bedHint({ x0: 0, y0: 0, x1: 235, y1: 225 }, nominal, 5), ['глубина стола отличается от номинальной на 10,0 мм: проверьте точку']);
  assert.deepEqual(bedHint({ x0: -12, y0: -3, x1: 215, y1: 230 }, nominal, 5, { urNominal: true }), []);
  assert.deepEqual(bedHint(null, nominal), []);
});

test('bedFromPoints: one point — the upper right by the nominal; two points; no lower left — refusal', () => {
  assert.deepEqual(bedFromPoints({ x: -12, y: -3 }, null, { w: 235, h: 235 }), { ok: true, bed: { x0: -12, y0: -3, x1: 223, y1: 232 }, urNominal: true });
  assert.deepEqual(bedFromPoints({ x: -12, y: -3 }, { x: 221, y: 230 }, { w: 235, h: 235 }), { ok: true, bed: { x0: -12, y0: -3, x1: 221, y1: 230 }, urNominal: false });
  assert.deepEqual(bedFromPoints(null, { x: 221, y: 230 }, { w: 235, h: 235 }), { ok: false, message: 'сначала левый нижний угол стола' });
  assert.equal(bedFromPoints({ x: 10, y: 10 }, { x: 5, y: 20 }, { w: 235, h: 235 }).ok, false);
});

test('bedPoints: nothing measured — X0 Y0 and X235 Y235 by the nominal, the bed is not measured', () => {
  assert.deepEqual(bedPoints(base), { measured: false, ll: { x: 0, y: 0, nominal: true }, ur: { x: 235, y: 235, nominal: true } });
});

test('applyBedPoint: the lower left, then the upper right captured — the nominal mark is gone', () => {
  const ll = applyBedPoint(base, 'll', { x: -12, y: -3 });
  assert.deepEqual(ll, { ok: true, changes: { bedX0: -12, bedY0: -3, bedX1: 223, bedY1: 232, bedUrNominal: true } });
  const p1 = { ...base, ...ll.changes };
  assert.deepEqual(bedPoints(p1).ur, { x: 223, y: 232, nominal: true });
  const ur = applyBedPoint(p1, 'ur', { x: 221, y: 230 });
  assert.deepEqual(ur.changes, { bedX0: -12, bedY0: -3, bedX1: 221, bedY1: 230, bedUrNominal: false });
  const p2 = { ...p1, ...ur.changes };
  assert.deepEqual(bedHint(bedRect(p2), { w: 235, h: 235 }), []);
  // a new lower left keeps the measured upper right corner
  assert.deepEqual(applyBedPoint(p2, 'll', { x: -10, y: -2 }).changes, { bedX0: -10, bedY0: -2, bedX1: 221, bedY1: 230, bedUrNominal: false });
});

test('applyBedPoint: the upper right without the lower left is refused, nothing changes', () => {
  assert.deepEqual(applyBedPoint(base, 'ur', { x: 221, y: 230 }), { ok: false, message: 'сначала левый нижний угол стола' });
  assert.equal(applyBedPoint(base, 'll', { x: NaN, y: 0 }).ok, false);
});

test('manual input of both points: measured, no nominal mark, the print area is recomputed', () => {
  const p = { ...base, ...applyBedPoint({ ...base, ...applyBedPoint(base, 'll', { x: -12, y: -3 }).changes }, 'ur', { x: 221, y: 230 }).changes };
  assert.equal(printArea(p).x1, 221);
  assert.equal(bedPoints(p).ur.nominal, false);
  assert.equal(bedRect({ ...p, ...clearedBed() }), null);
});
