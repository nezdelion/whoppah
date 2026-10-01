import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing, bbox, SPACE } from '../src/core/drawing.js';
import { layout, resolveField, sheetOverflow, sheetWarnings, PAPER_FORMATS } from '../src/core/layout.js';
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
