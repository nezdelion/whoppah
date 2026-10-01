import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createViewport } from '../src/app/ui/viewport.js';
import './helpers/ru.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const mk = () => { const v = createViewport(); v.setSize(800, 600); return v; };

test('fit by default', () => {
  const v = mk();
  assert.ok(v.isFit());
  assert.deepEqual(v.toScreen(10, 20), [10, 20]);
});

test('zoomAt keeps the point under the cursor in place', () => {
  const v = mk();
  const before = v.toContent(300, 200);
  v.zoomAt(300, 200, 3);
  near(v.zoom, 3);
  const [sx, sy] = v.toScreen(...before);
  near(sx, 300); near(sy, 200);
  v.zoomAt(500, 100, 0.5);
  const c = v.toContent(500, 100); v.zoomAt(500, 100, 1.5);
  const [ax, ay] = v.toScreen(...c); near(ax, 500); near(ay, 100);
});

test('zoom is clamped to 1..20', () => {
  const v = mk();
  v.zoomAt(0, 0, 1000); near(v.zoom, 20);
  v.zoomAt(0, 0, 1e-6); near(v.zoom, 1);
  assert.ok(v.isFit());
});

test('pan is clamped: the content covers the field', () => {
  const v = mk();
  v.panBy(100, 100); assert.ok(v.isFit());
  v.zoomAt(0, 0, 2);
  v.panBy(500, 500); near(v.ox, 0); near(v.oy, 0);
  v.panBy(-5000, -5000); near(v.ox, -800); near(v.oy, -600);
});

test('reset returns the fit', () => {
  const v = mk(); v.zoomAt(100, 100, 5); v.panBy(-30, -10);
  v.reset(); assert.ok(v.isFit());
});

test('toContent is the inverse of toScreen', () => {
  const v = mk(); v.zoomAt(250, 120, 4); v.panBy(-40, 25);
  const [x, y] = v.toContent(...v.toScreen(123, 45)); near(x, 123); near(y, 45);
});

test('setSize keeps the visible part', () => {
  const v = mk(); v.zoomAt(400, 300, 2);
  const c = v.toContent(400, 300);
  v.setSize(1600, 1200);
  const [sx, sy] = v.toScreen(c[0] * 2, c[1] * 2); near(sx, 400 * 2); near(sy, 300 * 2);
});

test('apply sets the canvas matrix', () => {
  const v = mk(); v.zoomAt(0, 0, 2);
  let m; v.apply({ setTransform: (...a) => { m = a; } });
  assert.deepEqual(m, [2, 0, 0, 2, 0, 0]);
});
