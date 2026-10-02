import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing, bbox, SPACE } from '../src/core/drawing.js';
import { layout, resolveField, sheetOverflow, sheetWarnings, fitRectFor, PAPER_FORMATS } from '../src/core/layout.js';
import { buildPlan, sheetCheck, fitRectOf } from '../src/core/pipeline.js';
import { defaultsOf, SCHEMAS } from '../src/core/profile.js';
import { DrawingError } from '../src/core/drawing.js';
import { closeTo } from './helpers/fixtures.js';
import './helpers/ru.js';

const doc = (lines, meta) => createDrawing({ layers: [{ id: 'l', name: 'l', lines }], meta });
const WORK = { field: { w: 180, h: 180 }, corner: { x: -5, y: 50 }, marginMm: 5 };

test('working profile: X 0..170, Y 55..225', () => {
  const out = layout(doc([[0, 0, 100, 100]]), WORK);
  const b = bbox(out);
  assert.equal(out.space, SPACE.MACHINE);
  assert.ok(closeTo(b.x0, 0) && closeTo(b.x1, 170) && closeTo(b.y0, 55) && closeTo(b.y1, 225));
});

test('the top of the document is the far edge of the paper (Y grows upward)', () => {
  const out = layout(doc([[0, 0, 10, 0], [0, 10, 10, 10]]), WORK);
  const [top, bottom] = out.layers[0].lines;
  assert.ok(top[1] > bottom[1]);
});

test('wide drawing 400×100: 170×42.5 mm, top and bottom margins are equal', () => {
  const out = layout(doc([[0, 0, 400, 100]]), WORK);
  const b = bbox(out);
  assert.ok(closeTo(b.w, 170) && closeTo(b.h, 42.5));
  const top = 50 + 180 - b.y1, bottom = b.y0 - 50;
  assert.ok(closeTo(top, bottom));
  assert.deepEqual(out.meta.layout.sizeMm.map((v) => +v.toFixed(3)), [170, 42.5]);
});

test('alignment', () => {
  const src = doc([[0, 0, 400, 100]]);
  const tl = bbox(layout(src, { ...WORK, halign: 'left', valign: 'top' }));
  assert.ok(closeTo(tl.x0, 0) && closeTo(tl.y1, 225));
  const br = bbox(layout(src, { ...WORK, halign: 'right', valign: 'bottom' }));
  assert.ok(closeTo(br.x1, 170) && closeTo(br.y0, 55));
});

test('rotation by 90° before fitting', () => {
  const b = bbox(layout(doc([[0, 0, 100, 25]]), { ...WORK, rotate: true }));
  assert.ok(closeTo(b.h, 170) && closeTo(b.w, 42.5));
});

test('as-is mode: the size in mm does not change, a large drawing gives a warning', () => {
  const ok = layout(doc([[0, 0, 100, 50]], { unitMm: 0.5 }), { ...WORK, asIs: true });
  assert.ok(closeTo(bbox(ok).w, 50));
  const big = layout(doc([[0, 0, 400, 400]], { unitMm: 0.5 }), { ...WORK, asIs: true });
  assert.ok(big.meta.warnings.includes('рисунок больше поля'));
  assert.throws(() => layout(doc([[0, 0, 1, 1]]), { ...WORK, asIs: true }), /мм неизвестен/);
});

test('paper formats and orientation', () => {
  assert.deepEqual(resolveField({ paperId: 'a5', orientation: 'landscape' }), { w: 210, h: 148 });
  assert.deepEqual(resolveField({ paperId: 'a5', orientation: 'portrait' }), { w: 148, h: 210 });
  const custom = [{ id: 'c1', name: 'Открытка', w: 100, h: 150 }];
  assert.deepEqual(resolveField({ paperId: 'c1', orientation: 'portrait', customFormats: custom }), { w: 100, h: 150 });
  assert.deepEqual(resolveField({ paperId: 'нет' }), { w: 180, h: 180 });
  assert.ok(PAPER_FORMATS.some((f) => f.id === 'letter'));
});

test('A4 on the working profile exceeds the axis limits', () => {
  const limits = { x0: -5, x1: 230, y0: 0, y1: 230 };
  const field = resolveField({ paperId: 'a4', orientation: 'portrait' });
  const o = sheetOverflow(field, WORK.corner, limits);
  assert.equal(o.x, 0);
  assert.ok(closeTo(o.y, 117));
  assert.match(sheetWarnings(field, WORK.corner, limits)[0], /по Y на 117,0 мм/);
  assert.deepEqual(sheetWarnings({ w: 180, h: 180 }, WORK.corner, limits), []);
});

test('the layout does not accept a drawing in machine coordinates', () => {
  const m = createDrawing({ space: 'machine', layers: [{ id: 'l', name: 'l', lines: [[0, 0, 1, 1]] }] });
  assert.throws(() => layout(m, WORK), /document coordinates/);
});

// --- print area: the bed edge in nozzle coordinates at X150 cuts the working field (corner X-5, field 180, margin 5 → X0…170)
const AREA = { x0: -4, y0: 1, x1: 150, y1: 231, bedMeasured: true };
const settingsWith = ({ bed = [-12, -3, 150, 232], fit = true, job = {} } = {}) => ({
  profile: { ...defaultsOf(SCHEMAS.profile), ...(bed ? { bedX0: bed[0], bedY0: bed[1], bedX1: bed[2], bedY1: bed[3] } : {}) },
  calibration: { ...defaultsOf(SCHEMAS.calibration), cornerX: -5, cornerY: 50 },
  job: { ...defaultsOf(SCHEMAS.job), fitPrintArea: fit, ...job },
});
const square = () => doc([[0, 0, 100, 100]]);

test('the field beyond the bed on the right, option on: a square is fitted 150×150 and does not go right of X150', () => {
  const r = fitRectFor({ w: 180, h: 180 }, 5, { x: -5, y: 50 }, AREA);
  assert.deepEqual(r, { x0: 5, y0: 5, x1: 155, y1: 175 });
  const b = bbox(layout(square(), { ...WORK, fitRect: r }));
  assert.ok(closeTo(b.w, 150) && closeTo(b.h, 150));
  assert.ok(closeTo(b.x0, 0) && closeTo(b.x1, 150));
  const plan = buildPlan(square(), settingsWith());
  assert.ok(closeTo(plan.stats.bbox.x1, 150) && closeTo(plan.stats.bbox.w, 150));
  assert.equal(plan.outOfArea, null);
});

test('option off: X0…170 as without the print area, the area check reports the bed edge', () => {
  const plan = buildPlan(square(), settingsWith({ fit: false }));
  assert.ok(closeTo(plan.stats.bbox.x0, 0) && closeTo(plan.stats.bbox.x1, 170));
  assert.ok(closeTo(plan.outOfBed.right, 20));
  assert.equal(plan.outOfLimits, null);
});

test('as is with the option: aligned right inside the fit rectangle — the right edge at X150', () => {
  const d = doc([[0, 0, 100, 100]], { unitMm: 1 });
  const plan = buildPlan(d, settingsWith({ job: { asIs: true, halign: 'right' } }));
  assert.ok(closeTo(plan.stats.bbox.x1, 150) && closeTo(plan.stats.bbox.w, 100));
  const big = buildPlan(doc([[0, 0, 160, 100]], { unitMm: 1 }), settingsWith({ job: { asIs: true } }));
  assert.ok(big.warnings.includes('рисунок больше поля'));
});

test('the sheet field entirely outside the print area: no layout, "the sheet field is outside the print area"', () => {
  const s = settingsWith({ bed: [200, -3, 400, 232] });
  assert.deepEqual(fitRectOf(s), { empty: true });
  assert.throws(() => buildPlan(square(), s), (e) => e instanceof DrawingError && e.message === 'поле листа вне области печати');
});

test('the field inside the print area: no fit rectangle, the layout is unchanged', () => {
  assert.equal(fitRectOf(settingsWith({ bed: null })), null);
  assert.equal(fitRectOf(settingsWith({ bed: [-12, -3, 223, 232] })), null);
  const a = buildPlan(square(), settingsWith({ bed: null })), b = buildPlan(square(), settingsWith({ bed: null, fit: false }));
  assert.equal(a.gcode, b.gcode);
});

test('the sheet beyond the bed on the right: 14.0 mm, the format stays chosen; with the option — "fitted"', () => {
  const area = { x0: -5, y0: 1, x1: 221, y1: 300, bedMeasured: true };
  assert.deepEqual(sheetWarnings({ w: 240, h: 180 }, { x: -5, y: 50 }, area), ['лист выходит за область печати справа на 14,0 мм']);
  assert.deepEqual(sheetWarnings({ w: 240, h: 180 }, { x: -5, y: 50 }, area, { fitted: true }),
    ['лист выходит за область печати справа на 14,0 мм', 'рисунок вписан в область печати']);
  assert.deepEqual(sheetWarnings({ w: 180, h: 180 }, { x: -5, y: 50 }, area, { fitted: true }), []);
  // pipeline: the sheet against the print area of the profile
  assert.match(sheetCheck(settingsWith()).join('\n'), /справа на 25,0 мм\nрисунок вписан/);
});
