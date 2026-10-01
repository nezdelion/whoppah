import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransform, applyMatrix, arcToCubics, flattenSubpath, pointSegmentDistance, multiply } from '../src/core/geometry.js';
import { closeTo } from './helpers/fixtures.js';
import './helpers/ru.js';

test('translate/scale/rotate/skew/matrix', () => {
  const at = (s, x, y) => applyMatrix(parseTransform(s), x, y);
  assert.deepEqual(at('translate(5 7)', 1, 1), [6, 8]);
  assert.deepEqual(at('scale(2)', 3, 4), [6, 8]);
  assert.deepEqual(at('scale(2 3)', 1, 1), [2, 3]);
  assert.deepEqual(at('matrix(1 0 0 1 10 20)', 0, 0), [10, 20]);
  const [rx, ry] = at('rotate(90)', 1, 0);
  assert.ok(closeTo(rx, 0) && closeTo(ry, 1));
  const [cx, cy] = at('rotate(180 5 5)', 0, 0);
  assert.ok(closeTo(cx, 10) && closeTo(cy, 10));
  const [sx, sy] = at('skewX(45)', 0, 2);
  assert.ok(closeTo(sx, 2) && closeTo(sy, 2));
});

test('order of application: left to right as in SVG', () => {
  const [x, y] = applyMatrix(parseTransform('translate(10 0) scale(2)'), 1, 0);
  assert.deepEqual([x, y], [12, 0]);
  const m = multiply([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(applyMatrix(m, 1, 0), [12, 0]);
});

test('arc: the polyline points lie on the true circle with a small deviation', () => {
  const R = 50;
  const segs = arcToCubics(R, 0, R, R, 0, false, true, -R, 0);
  const pts = flattenSubpath({ x: R, y: 0, segs }, 1);
  for (let i = 0; i < pts.length; i += 2) {
    assert.ok(Math.abs(Math.hypot(pts[i], pts[i + 1]) - R) < 0.02, `point ${i / 2} too far from the circle`);
  }
  // chords: the chord midpoint deviation from the circle is at most the sagitta
  let worst = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const mx = (pts[i] + pts[i - 2]) / 2, my = (pts[i + 1] + pts[i - 1]) / 2;
    worst = Math.max(worst, R - Math.hypot(mx, my));
  }
  assert.ok(worst < 0.03, `deviation ${worst}`);
});

test('a zero-length arc gives an empty list, a zero radius — a segment', () => {
  assert.deepEqual(arcToCubics(1, 1, 5, 5, 0, false, false, 1, 1), []);
  assert.deepEqual(arcToCubics(0, 0, 0, 5, 0, false, false, 4, 4), [['L', 4, 4]]);
});

test('distance to a segment', () => {
  assert.equal(pointSegmentDistance(5, 3, 0, 0, 10, 0), 3);
  assert.equal(pointSegmentDistance(-3, 4, 0, 0, 10, 0), 5);
  assert.equal(pointSegmentDistance(3, 4, 0, 0, 0, 0), 5);
});
