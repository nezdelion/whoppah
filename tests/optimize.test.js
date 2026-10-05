import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing, stats, allLines } from '../src/core/drawing.js';
import { simplify, simplifyLine, sortMerge, optimize, travelLength, mergeInOrder } from '../src/core/optimize.js';
import { pointSegmentDistance } from '../src/core/geometry.js';
import { deepFreeze } from './helpers/fixtures.js';
import './helpers/ru.js';

const draw = (lines, name = 'L') => createDrawing({ space: 'machine', layers: [{ id: name, name, lines }] });

function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

test('an almost straight line of 1000 points is simplified to two', () => {
  const r = rng(1);
  const line = [];
  for (let i = 0; i < 1000; i++) line.push(i * 0.1, (r() - 0.5) * 0.04);
  const out = simplify(draw([line]), 0.05);
  assert.equal(out.layers[0].lines[0].length, 4);
  assert.deepEqual(out.layers[0].lines[0].slice(0, 2), line.slice(0, 2));
  assert.deepEqual(out.layers[0].lines[0].slice(2), line.slice(-2));
});

test('the shape is preserved: every original point is within d of the simplified line', () => {
  const r = rng(7);
  const line = [];
  for (let i = 0; i < 400; i++) line.push(i * 0.5, 10 * Math.sin(i / 20) + (r() - 0.5));
  const tol = 0.3;
  const s = simplify(draw([line]), tol).layers[0].lines[0];
  assert.ok(s.length < line.length);
  for (let i = 0; i < line.length; i += 2) {
    let best = Infinity;
    for (let k = 2; k < s.length; k += 2) best = Math.min(best, pointSegmentDistance(line[i], line[i + 1], s[k - 2], s[k - 1], s[k], s[k + 1]));
    assert.ok(best <= tol + 1e-9);
  }
});

test('tolerance 0 disables simplification; the input does not change; a long line without recursion', () => {
  const d = deepFreeze(draw([[0, 0, 1, 0.001, 2, 0]]));
  assert.equal(simplify(d, 0), d);
  const big = [];
  for (let i = 0; i < 200000; i++) big.push(i, i % 2 ? 0.001 : 0);
  assert.equal(simplify(draw([big]), 0.05).layers[0].lines[0].length, 4);
});

test('segment grid: the travel path and line count do not grow', () => {
  const r = rng(42);
  const segs = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) segs.push([i * 5, j * 5, i * 5 + 4, j * 5]);
  for (let i = segs.length - 1; i > 0; i--) { const k = Math.floor(r() * (i + 1)); [segs[i], segs[k]] = [segs[k], segs[i]]; }
  const shuffled = segs.map((s) => (r() < 0.5 ? [s[2], s[3], s[0], s[1]] : s));
  const d = draw(shuffled);
  const { drawing, report } = optimize(d, { mergeTolMm: 0.05, start: [0, 0] });
  assert.ok(report.travelAfter <= report.travelBefore);
  assert.ok(report.linesAfter <= report.linesBefore);
  assert.equal(stats(drawing).length, stats(d).length, 'total drawing length unchanged');
});

test('merging adjacent ends and reversal', () => {
  const d = draw([[10, 0, 20, 0], [0, 0, 10, 0.01]]);
  const out = sortMerge(d, { start: [0, 0], tol: 0.05 });
  assert.equal(allLines(out).length, 1);
  assert.deepEqual([out.layers[0].lines[0][0], out.layers[0].lines[0][1]], [0, 0]);
});

test('the layer order is preserved', () => {
  const d = createDrawing({ space: 'machine', layers: [
    { id: 'a', name: 'a', lines: [[50, 50, 60, 60]] }, { id: 'b', name: 'b', lines: [[0, 0, 1, 1]] }] });
  const out = sortMerge(d, { start: [0, 0] });
  assert.deepEqual(out.layers.map((l) => l.name), ['a', 'b']);
});

test('the report contains points, lines and travel path before and after', () => {
  const line = [];
  for (let i = 0; i < 100; i++) line.push(i, 0);
  const { report } = optimize(draw([line, [200, 0, 201, 0]]), { simplifyTolMm: 0.05 });
  assert.equal(report.pointsBefore, 102);
  assert.equal(report.pointsAfter, 4);
  assert.equal(report.linesBefore, 2);
  assert.ok(report.travelBefore >= report.travelAfter - 1e-9);
  assert.equal(travelLength(draw([[3, 4, 5, 5]]), [0, 0]), 5);
});

test('joining by a stroke: the ends do not move, the transition is drawn', () => {
  // two parallel hatching lines with a 1 mm step
  const d = draw([[0, 0, 10, 0], [10, 1, 0, 1]]);
  const merged = sortMerge(d, { start: [0, 0], tol: 1.5 });
  assert.deepEqual(merged.layers[0].lines, [[0, 0, 10, 0, 0, 1]], 'merging drops the start of the next line');
  const linked = sortMerge(d, { start: [0, 0], tol: 0.05, linkTol: 1.5 });
  assert.deepEqual(linked.layers[0].lines, [[0, 0, 10, 0, 10, 1, 0, 1]]);
});

test('joining by a stroke: beyond the tolerance — a separate line with a lift', () => {
  const d = draw([[0, 0, 10, 0], [10, 3, 0, 3]]);
  const out = sortMerge(d, { start: [0, 0], tol: 0.05, linkTol: 1.5 });
  assert.equal(out.layers[0].lines.length, 2);
  assert.equal(sortMerge(d, { start: [0, 0] }).layers[0].lines.length, 2, 'off by default');
});

test('simplifyLine: the same RDP as simplify, the ends are kept, the type follows the input', () => {
  const r = rng(3);
  const line = [];
  for (let i = 0; i < 300; i++) line.push(i * 0.5, 4 * Math.sin(i / 15) + (r() - 0.5) * 0.1);
  const viaDrawing = simplify(draw([line]), 0.2).layers[0].lines[0];
  assert.ok(viaDrawing.length < line.length);
  assert.deepEqual(simplifyLine(line, 0.2), viaDrawing, 'plain array: identical to simplify()');
  const typed = simplifyLine(Float64Array.from(line), 0.2);
  assert.ok(typed instanceof Float64Array);
  assert.deepEqual(Array.from(typed), viaDrawing);
  // all points within the tolerance of the chord: only the ends remain
  const flat = Float64Array.of(0, 0, 1, 0.01, 2, -0.01, 3, 0.005, 4, 0);
  assert.deepEqual(Array.from(simplifyLine(flat, 0.05)), [0, 0, 4, 0]);
  assert.equal(simplifyLine(flat, 0), flat, 'tolerance 0 — unchanged');
});


test('mergeInOrder: keeps the given order and direction (no nearest-first, no reversal), joins only consecutive touching lines', () => {
  // written right-to-left on purpose: sortMerge from the origin would start at the nearest end and reverse lines
  const d = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[50, 0, 40, 0], [40, 0, 30, 0], [10, 0, 0, 0], [20, 5, 25, 5]] }] });
  const r = mergeInOrder(d, { tol: 0.05 });
  assert.deepEqual(r.layers[0].lines, [[50, 0, 40, 0, 30, 0], [10, 0, 0, 0], [20, 5, 25, 5]]);
  const o = optimize(d, { start: [0, 0], keepOrder: true });
  assert.deepEqual(o.drawing.layers[0].lines, r.layers[0].lines, 'optimize with keepOrder = mergeInOrder');
  const nearest = optimize(d, { start: [0, 0] });
  assert.notDeepEqual(nearest.drawing.layers[0].lines[0], [50, 0, 40, 0, 30, 0], 'without it the order changes');
});

test('mergeInOrder: linkTol draws the short gap to the next line without dropping its first point', () => {
  const d = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 10, 0], [10.4, 0, 20, 0]] }] });
  assert.deepEqual(mergeInOrder(d, { tol: 0.05, linkTol: 0.5 }).layers[0].lines, [[0, 0, 10, 0, 10.4, 0, 20, 0]]);
});
