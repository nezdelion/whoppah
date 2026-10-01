import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing, bbox, stats, SPACE, DrawingError, assertSpace, isPartial, partialReasons, derive } from '../src/core/drawing.js';
import { layout } from '../src/core/layout.js';
import { deepFreeze } from './helpers/fixtures.js';
import './helpers/ru.js';

const layer = (lines, id = 'l1', name = 'Слой') => ({ id, name, lines });

test('single-layer drawing: polylines of two or more points', () => {
  const d = createDrawing({ layers: [layer([[0, 0, 10, 0], [0, 0, 5, 5, 10, 0]])] });
  assert.equal(d.layers.length, 1);
  assert.equal(d.space, SPACE.DOCUMENT);
  assert.equal(d.layers[0].lines.length, 2);
});

test('degenerate lines are discarded and counted', () => {
  const d = createDrawing({ layers: [layer([[1, 1], [1, 1, 1, 1], [0, 0, 1, 1]])] });
  assert.equal(d.layers[0].lines.length, 1);
  assert.equal(d.meta.dropped, 2);
});

test('coincident neighboring points collapse', () => {
  const d = createDrawing({ layers: [layer([[0, 0, 0, 0, 5, 5]])] });
  assert.deepEqual(d.layers[0].lines[0], [0, 0, 5, 5]);
});

test('a G-code-like operation rejects a wrong coordinate system', () => {
  const d = createDrawing({ layers: [layer([[0, 0, 1, 1]])] });
  assert.throws(() => assertSpace(d, SPACE.MACHINE, 'нужна раскладка на поле'), /нужна раскладка на поле/);
  assert.throws(() => assertSpace(d, SPACE.MACHINE, 'x'), DrawingError);
});

test('the intermediate flag is preserved by the layout', () => {
  const d = createDrawing({ layers: [layer([[0, 0, 10, 10]])], meta: { partial: { reasons: ['стиль считается'] } } });
  const out = layout(d, { field: { w: 100, h: 100 }, marginMm: 0, corner: { x: 0, y: 0 } });
  assert.equal(isPartial(out), true);
  assert.deepEqual(partialReasons(out), ['стиль считается']);
});

test('operations do not modify the input drawing', () => {
  const d = deepFreeze(createDrawing({ layers: [layer([[0, 0, 10, 5]])] }));
  const a = layout(d, { field: { w: 100, h: 100 }, marginMm: 5, corner: { x: 0, y: 0 } });
  const b = layout(d, { field: { w: 50, h: 50 }, marginMm: 0, corner: { x: 10, y: 10 } });
  assert.notDeepEqual(a.layers[0].lines, b.layers[0].lines);
  assert.deepEqual(d.layers[0].lines[0], [0, 0, 10, 5]);
  assert.equal(derive(d, { meta: { x: 1 } }).meta.x, 1);
});

test('bounds and statistics', () => {
  const d = createDrawing({ layers: [layer([[0, 0, 3, 4]]), layer([[10, 10, 10, 20, 20, 20]], 'l2')] });
  assert.deepEqual(bbox(d), { x0: 0, y0: 0, x1: 20, y1: 20, w: 20, h: 20 });
  const s = stats(d);
  assert.equal(s.lines, 2);
  assert.equal(s.points, 5);
  assert.equal(s.length, 5 + 20);
});

test('empty drawing: no bounds, zeros, the layout reports nothing to draw', () => {
  const d = createDrawing({ layers: [layer([])] });
  assert.equal(bbox(d), null);
  assert.deepEqual(stats(d), { lines: 0, points: 0, length: 0, bbox: null });
  assert.throws(() => layout(d, { field: { w: 100, h: 100 }, marginMm: 0, corner: { x: 0, y: 0 } }), /нечего рисовать/);
});
