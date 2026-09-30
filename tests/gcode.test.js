import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing } from '../src/core/drawing.js';
import { generateGcode, liftLines, cornerLines, touchLines, homeLines, frameLines, overflow } from '../src/core/gcode.js';
import { defaultsOf, PROFILE_SCHEMA, CALIBRATION_SCHEMA } from '../src/core/profile.js';

const profile = defaultsOf(PROFILE_SCHEMA), cal = defaultsOf(CALIBRATION_SCHEMA);
const machine = (layers, meta) => createDrawing({ space: 'machine', layers, meta });
const one = (lines) => machine([{ id: 'a', name: 'a', lines }]);

test('default structure: no G28, Z7.3/10/15/25, M84 at the end', () => {
  const { gcode } = generateGcode(one([[0, 60, 10, 60, 10, 70]]), { profile, calibration: cal });
  const g = gcode.trim().split('\n');
  assert.deepEqual(g.slice(0, 3), ['G21', 'G90', 'G0 Z15 F1200']);
  assert.ok(!gcode.includes('G28'));
  assert.deepEqual(g.slice(3, 9), ['G0 Z10 F1200', 'G0 X0.000 Y60.000 F6000', 'G1 Z7.3 F600', 'G1 X10.000 Y60.000 F3000', 'G1 X10.000 Y70.000', 'G0 Z10 F1200']);
  assert.deepEqual(g.slice(-3), ['G0 Z10 F1200', 'G0 Z25 F1200', 'M84']);
});

test('G28 and M84 are toggled by options', () => {
  const { gcode } = generateGcode(one([[0, 60, 1, 61]]), { profile: { ...profile, home: true, motorsOff: false }, calibration: cal });
  assert.equal(gcode.split('\n')[2], 'G28');
  assert.ok(!gcode.includes('M84'));
});

test('heights from the touch: Z9.0 gives 8.3 down and 11 up', () => {
  const { gcode } = generateGcode(one([[0, 60, 1, 61]]), { profile, calibration: { ...cal, zTouch: 9 } });
  assert.match(gcode, /G1 Z8\.3 F600/);
  assert.match(gcode, /G0 Z11 F1200/);
});

test('drawing feed in the first working move of each line', () => {
  const { gcode } = generateGcode(one([[0, 60, 1, 61, 2, 62], [5, 60, 6, 61]]), { profile: { ...profile, fDraw: 2500 }, calibration: cal });
  assert.equal((gcode.match(/G1 X[\d.]+ Y[\d.]+ F2500/g) || []).length, 2);
});

test('exceeding the right limit: out of X limits by 12.0 mm, outOfLimits', () => {
  const r = generateGcode(one([[200, 60, 246, 60]]), { profile, calibration: cal });
  assert.ok(r.warnings.includes('выход за X на 12.0 мм'));
  assert.ok(Math.abs(r.outOfLimits.x - 12) < 1e-9);
  assert.equal(r.outOfLimits.y, 0);
  assert.equal(generateGcode(one([[0, 60, 10, 60]]), { profile, calibration: cal }).outOfLimits, null);
  assert.deepEqual(overflow({ x0: 0, x1: 1, y0: -3, y1: 1 }, { x0: 0, x1: 5, y0: 0, y1: 5 }), { x: 0, y: 3 });
});

test('two layers: comments before the lines; one layer — no comment', () => {
  const two = generateGcode(machine([{ id: 'a', name: 'контур', lines: [[0, 60, 1, 60]] }, { id: 'b', name: 'штрих', lines: [[5, 60, 6, 60]] }]), { profile, calibration: cal }).gcode;
  const lines = two.split('\n');
  const a = lines.indexOf('; layer: контур'), b = lines.indexOf('; layer: штрих');
  assert.ok(a > 0 && b > a);
  assert.ok(lines.findIndex((l) => l.startsWith('G0 X0.000')) > a);
  assert.ok(lines.findIndex((l) => l.startsWith('G0 X5.000')) > b);
  assert.ok(!generateGcode(one([[0, 60, 1, 60]]), { profile, calibration: cal }).gcode.includes('; layer'));
});

test('the beforeLayer hook replaces the insertion (an extension point for pen changes)', () => {
  const d = machine([{ id: 'a', name: 'a', lines: [[0, 60, 1, 60]] }, { id: 'b', name: 'b', lines: [[5, 60, 6, 60]] }]);
  const { gcode } = generateGcode(d, { profile, calibration: cal, beforeLayer: (l, i) => (i ? ['M0'] : []) });
  assert.equal((gcode.match(/^M0$/gm) || []).length, 1);
  assert.ok(!gcode.includes('; layer'));
});

test('statistics: lines, lengths, bounds, scale, time', () => {
  const d = machine([{ id: 'a', name: 'a', lines: [[0, 60, 30, 60]] }], { layout: { scale: 2, sizeMm: [30, 0] } });
  const { stats } = generateGcode(d, { profile, calibration: cal });
  assert.equal(stats.lines, 1);
  assert.equal(stats.draw, 30);
  assert.ok(Math.abs(stats.travel - Math.hypot(5, 10)) < 1e-9);
  assert.equal(stats.scale, 2);
  assert.deepEqual([stats.bbox.x0, stats.bbox.x1], [0, 30]);
  assert.ok(stats.time.min > 0 && stats.time.max >= stats.time.min);
});

test('a drawing in document coordinates is rejected', () => {
  const d = createDrawing({ layers: [{ id: 'a', name: 'a', lines: [[0, 0, 1, 1]] }] });
  assert.throws(() => generateGcode(d, { profile, calibration: cal }), /нужна раскладка на поле/);
});

test('outline: X 0..170, Y 55..225, no Z below 9.0', () => {
  const lines = frameLines({ x0: 0, y0: 55, x1: 170, y1: 225 }, profile, cal);
  const zs = lines.flatMap((l) => [...l.matchAll(/Z([\d.]+)/g)].map((m) => +m[1]));
  assert.ok(zs.length && Math.min(...zs) >= 9.0);
  assert.ok(lines.includes('G0 X170.000 Y225.000 F6000') && lines.includes('G0 X0.000 Y55.000 F6000'));
  assert.equal(lines.at(-1), 'G0 Z25 F1200');
});

test('short pen programs', () => {
  assert.deepEqual(liftLines(profile, cal), ['G90', 'G0 Z15 F1200']);
  assert.deepEqual(cornerLines(profile, cal), ['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000']);
  assert.deepEqual(touchLines(profile, cal), ['G90', 'G0 Z8 F600']);
  assert.deepEqual(touchLines(profile, { ...cal, zTouch: 9 }), ['G90', 'G0 Z9 F600']);
  assert.deepEqual(homeLines(), ['G28']);
});

test('meshNoFade: M420 S1 Z0 after G90/G28 in the file and in all pen programs; off — absent', () => {
  const on = { ...profile, meshNoFade: true, home: true };
  const g = generateGcode(one([[0, 60, 10, 60]]), { profile: on, calibration: cal }).gcode.split('\n');
  assert.deepEqual(g.slice(0, 4), ['G21', 'G90', 'G28', 'M420 S1 Z0']);
  for (const prog of [liftLines(on, cal), cornerLines(on, cal), touchLines(on, cal), frameLines({ x0: 0, y0: 55, x1: 10, y1: 60 }, on, cal)]) {
    assert.deepEqual(prog.slice(0, 2), ['G90', 'M420 S1 Z0']);
  }
  assert.ok(!generateGcode(one([[0, 60, 10, 60]]), { profile, calibration: cal }).gcode.includes('M420'));
  assert.ok(!touchLines(profile, cal).includes('M420 S1 Z0'));
});
