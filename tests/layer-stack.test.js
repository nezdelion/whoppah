import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLayerStack, normalizeParams, clampSize, PRESET_VERSION } from '../src/app/photo/layer-stack.js';
import { estimateSpacing, densityText, scaleToPaper } from '../src/app/photo/density.js';
import { fitSize } from '../src/app/photo/image-loader.js';
import { isPartial, partialReasons } from '../src/core/drawing.js';
import './helpers/ru.js';

const styles = { a: { name: 'Alpha' }, b: { name: 'Beta' } };
const make = () => createLayerStack({ getStyle: (id) => styles[id] || null });
const done = (lines) => ({ status: 'done', lines });

test('adding, unique names, deleting', () => {
  const s = make();
  const l1 = s.add('a'), l2 = s.add('a'), l3 = s.add('b');
  assert.deepEqual(s.layers.map((l) => l.name), ['Alpha', 'Alpha 2', 'Beta']);
  s.remove(l2.uid);
  assert.deepEqual(s.layers.map((l) => l.uid), [l1.uid, l3.uid]);
  s.remove('нет такого');
  assert.equal(s.layers.length, 2);
});

test('order: move up/down, the bounds do not let through', () => {
  const s = make();
  const [a, b, c] = ['a', 'b', 'a'].map((id) => s.add(id));
  assert.equal(s.move(a.uid, -1), false);
  assert.equal(s.move(c.uid, 1), false);
  assert.equal(s.move(c.uid, -1), true);
  assert.deepEqual(s.layers.map((l) => l.uid), [a.uid, c.uid, b.uid]);
});

test('renaming, hiding, events', () => {
  const s = make();
  const events = [];
  s.subscribe((e) => events.push(e.type));
  const l = s.add('a');
  s.rename(l.uid, '  Контур  ');
  s.rename(l.uid, '   ');
  s.setVisible(l.uid, false);
  s.setVisible(l.uid, false);
  assert.equal(l.name, 'Контур');
  assert.equal(l.visible, false);
  assert.deepEqual(events, ['structure', 'meta', 'meta', 'visibility']);
});

test('Drawing: visible layers with a result, order, image coordinates, separate layers', () => {
  const s = make();
  const a = s.add('a', { name: 'Штриховка' }), b = s.add('b', { name: 'Контур' }), c = s.add('a', { name: 'Скрытый', visible: false });
  s.applyResult(a.uid, done([Float64Array.of(0, 0, 10, 0)]));
  s.applyResult(b.uid, done([Float64Array.of(1, 1, 2, 2), [3, 3, 4, 4]]));
  s.applyResult(c.uid, done([[0, 0, 1, 1]]));
  const d = s.toDrawing({ name: 'photo' });
  assert.equal(d.space, 'document');
  assert.deepEqual(d.layers.map((l) => l.name), ['Штриховка', 'Контур']);
  assert.deepEqual(d.layers[1].lines, [[1, 1, 2, 2], [3, 3, 4, 4]]);
  assert.equal(d.meta.name, 'photo');
  assert.equal(isPartial(d), false);
  assert.deepEqual(s.pending(), []);
  s.move(b.uid, -1);
  assert.deepEqual(s.toDrawing().layers.map((l) => l.name), ['Контур', 'Штриховка']);
});

test('unfinished layers: pending and an intermediate Drawing with a reason; without lines — null', () => {
  const s = make();
  assert.equal(s.toDrawing(), null);
  const a = s.add('a', { name: 'stipple' });
  const b = s.add('b', { name: 'Контур' });
  s.applyResult(a.uid, { status: 'running', progress: 'Iteration 3', reason: 'завершение стиля не отслеживается', lines: [[0, 0, 5, 5]] });
  s.applyResult(b.uid, done([[0, 0, 1, 1]]));
  assert.deepEqual(s.pending().map((p) => [p.name, p.status]), [['stipple', 'running']]);
  const d = s.toDrawing();
  assert.equal(isPartial(d), true);
  assert.match(partialReasons(d)[0], /слой «stipple» не завершён.*не отслеживается/);
  s.applyResult(a.uid, done([[0, 0, 5, 5]]));
  assert.equal(isPartial(s.toDrawing()), false);
});

test('a hidden unfinished layer does not interfere and does not go into pending', () => {
  const s = make();
  const a = s.add('a', { visible: false });
  const b = s.add('b');
  s.applyResult(b.uid, done([[0, 0, 1, 1]]));
  assert.deepEqual(s.pending(), []);
  void a;
});

test('preset: round trip, unknown styles are skipped, the version is checked', () => {
  const s = make();
  s.add('a', { params: { k: 3 }, name: 'Один' });
  s.add('b', { visible: false });
  const preset = JSON.parse(JSON.stringify(s.toPreset(1200)));
  assert.equal(preset.version, PRESET_VERSION);
  assert.equal(preset.workingSize, 1200);
  assert.equal(JSON.stringify(preset).includes('lines'), false, 'results and image are not stored in the preset');
  const t = make();
  const r = t.loadPreset({ ...preset, layers: [...preset.layers, { styleId: 'нет', params: {} }] });
  assert.deepEqual(r, { workingSize: 1200, skipped: ['нет'] });
  assert.deepEqual(t.toPreset(1200), preset);
  assert.throws(() => t.loadPreset({ version: 99, layers: [] }));
  assert.throws(() => t.loadPreset(null));
  assert.equal(t.loadPreset({ version: PRESET_VERSION, layers: [], workingSize: 5 }).workingSize, 200);
});

test('normalizeParams: unknown keys dropped, invalid values — defaults', () => {
  const descs = [
    { key: 'n', type: 'number', min: 1, max: 10, default: 5 },
    { key: 'f', type: 'bool', default: true },
    { key: 's', type: 'select', options: ['x', 'y'], default: 'x' },
  ];
  assert.deepEqual(normalizeParams(descs, { n: 7, f: false, s: 'y', extra: 1 }), { n: 7, f: false, s: 'y' });
  assert.deepEqual(normalizeParams(descs, { n: 100, f: 'yes', s: 'z' }), { n: 5, f: true, s: 'x' });
  assert.deepEqual(normalizeParams(descs, null), { n: 5, f: true, s: 'x' });
});

test('working resolution: clamp to 200–2000, size 4000×3000 -> 800×600', () => {
  assert.equal(clampSize(50), 200);
  assert.equal(clampSize(99999), 2000);
  assert.equal(clampSize('abc'), 800);
  assert.deepEqual(fitSize(4000, 3000, 800), { width: 800, height: 600 });
  assert.deepEqual(fitSize(3000, 4000, 800), { width: 600, height: 800 });
  assert.deepEqual(fitSize(1, 1000, 200), { width: 1, height: 200 });
});

test('density: squiggle 200 lines, image 800×600 over 170 mm of height -> step 0.85 mm', () => {
  const image = { width: 800, height: 600 };
  const pp = { fieldMm: { w: 300, h: 170 }, marginMm: 0, rotate: false, penWidthMm: 0.5 };
  const step = Math.floor(600 / 200);
  const est = estimateSpacing(step, image, pp);
  assert.ok(Math.abs(est.stepMm - 0.85) < 1e-9);
  assert.equal(est.tooDense, false);
  assert.equal(densityText(est, 0.5), 'шаг 0,85 мм');
  const wide = estimateSpacing(step, image, { ...pp, penWidthMm: 1.0 });
  assert.equal(wide.tooDense, true);
  assert.match(densityText(wide, 1), /линии сливаются/);
});

test('density: changing paper format, margin and rotation recomputes the estimate; an unknown step — no check', () => {
  const image = { width: 800, height: 600 };
  const a = estimateSpacing(3, image, { fieldMm: { w: 180, h: 180 }, marginMm: 0, rotate: false, penWidthMm: 0.5 });
  const b = estimateSpacing(3, image, { fieldMm: { w: 297, h: 210 }, marginMm: 0, rotate: false, penWidthMm: 0.5 });
  assert.ok(Math.abs(a.stepMm - 3 * 180 / 800) < 1e-9);
  assert.ok(Math.abs(b.stepMm - 3 * 210 / 600) < 1e-9);
  const rotated = estimateSpacing(3, image, { fieldMm: { w: 180, h: 180 }, marginMm: 10, rotate: true, penWidthMm: 0.5 });
  assert.ok(Math.abs(rotated.stepMm - 3 * 160 / 800) < 1e-9);
  assert.equal(estimateSpacing(null, image, { fieldMm: { w: 180, h: 180 }, marginMm: 0, rotate: false, penWidthMm: 0.5 }), null);
  assert.equal(scaleToPaper(image, { fieldMm: { w: 20, h: 20 }, marginMm: 10, rotate: false }), null);
  assert.equal(densityText(null, 0.5), '');
});
