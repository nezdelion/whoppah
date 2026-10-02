import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJog, jogRange, planGoTo, JOG_Z_MAX } from '../src/core/jog.js';
import { jogLines } from '../src/core/gcode.js';
import { defaultsOf, SCHEMAS } from '../src/core/profile.js';
import { createJog } from '../src/app/calibration/jog.js';
import { guardState, homeHint } from '../src/app/calibration/guard.js';
import './helpers/ru.js';

const profile = { ...defaultsOf(SCHEMAS.profile), limX0: -4, limX1: 234, limY0: 1, limY1: 231, fTravel: 6000, fZUp: 1200, fZDown: 600 };
const calibration = { ...defaultsOf(SCHEMAS.calibration), zTouch: 8 };
const plan = (axis, dir, step, pos) => planJog({ axis, dir, step, position: { x: 100, y: 100, z: 20, ...pos }, profile, calibration });

test('planJog: an ordinary step without clamping', () => {
  assert.deepEqual(plan('x', 1, 10, {}), { ok: true, delta: 10, target: 110, clamped: false });
  assert.deepEqual(plan('y', -1, 0.1, {}), { ok: true, delta: -0.1, target: 99.9, clamped: false });
  assert.deepEqual(plan('z', -1, 1, { z: 20 }), { ok: true, delta: -1, target: 19, clamped: false });
});

test('planJog: the step is shortened to the limit', () => {
  assert.deepEqual(plan('x', 1, 10, { x: 233 }), { ok: true, delta: 1, target: 234, clamped: true });
  assert.deepEqual(plan('x', -1, 10, { x: -1 }), { ok: true, delta: -3, target: -4, clamped: true });
  assert.deepEqual(plan('y', 1, 10, { y: 225.5 }), { ok: true, delta: 5.5, target: 231, clamped: true });
});

test('planJog: at the limit and beyond it outward — refusal, inward — allowed', () => {
  assert.equal(plan('x', 1, 1, { x: 234 }).ok, false);
  assert.match(plan('x', 1, 1, { x: 234 }).message, /предел оси X/);
  assert.equal(plan('x', 1, 1, { x: 240 }).ok, false);
  assert.equal(plan('y', -1, 1, { y: 1 }).ok, false);
  // beyond the limit (the head was moved out by hand): return inward by a step, not a jump to the boundary and not more than a step
  assert.deepEqual(plan('x', -1, 1, { x: 240 }), { ok: true, delta: -1, target: 239, clamped: false });
  assert.deepEqual(plan('x', 1, 10, { x: -10 }), { ok: true, delta: 10, target: 0, clamped: false });
});

test('planJog: Z not below the touch minus a 2 mm margin and not below 0, ceiling 300', () => {
  assert.deepEqual(jogRange('z', profile, calibration), [6, JOG_Z_MAX]);
  assert.deepEqual(plan('z', -1, 10, { z: 6.5 }), { ok: true, delta: -0.5, target: 6, clamped: true });
  assert.equal(plan('z', -1, 0.1, { z: 6 }).ok, false);
  assert.deepEqual(jogRange('z', profile, { zTouch: 1 }), [0, JOG_Z_MAX]);
  assert.equal(planJog({ axis: 'z', dir: -1, step: 1, position: { z: 0 }, profile, calibration: { zTouch: 1 } }).ok, false);
  assert.deepEqual(plan('z', 1, 10, { z: 295 }), { ok: true, delta: 5, target: 300, clamped: true });
});

test('planJog: unknown position, invalid step', () => {
  assert.equal(planJog({ axis: 'x', dir: 1, step: 1, position: { y: 1 }, profile, calibration }).ok, false);
  assert.equal(planJog({ axis: 'x', dir: 1, step: 1, position: { x: NaN }, profile, calibration }).ok, false);
  assert.equal(plan('x', 1, 0, {}).ok, false);
  assert.equal(plan('x', 2, 1, {}).ok, false);
});

test('jogLines: G91/G0/G90, feeds from the profile, the mesh between G91 and G0', () => {
  assert.deepEqual(jogLines(profile, 'x', 10), ['G91', 'G0 X10 F6000', 'G90']);
  assert.deepEqual(jogLines(profile, 'y', -0.1), ['G91', 'G0 Y-0.1 F6000', 'G90']);
  assert.deepEqual(jogLines(profile, 'z', 1), ['G91', 'G0 Z1 F1200', 'G90']);
  assert.deepEqual(jogLines(profile, 'z', -0.5), ['G91', 'G0 Z-0.5 F600', 'G90']);
  assert.deepEqual(jogLines({ ...profile, meshNoFade: true }, 'x', 1), ['G91', 'M420 S1 Z0', 'G0 X1 F6000', 'G90']);
});

function jogSetup({ pos = { x: 100, y: 100, z: 20 }, guard, readError, prof = profile, touchFresh } = {}) {
  const sent = [];
  const jog = createJog({
    state: { settings: () => ({ profile: prof, calibration }) },
    positionSource: { read: async () => { if (readError) throw readError; return pos; } },
    transport: { command: async (lines) => { sent.push(lines); } },
    guard, touchFresh,
  });
  return { jog, sent };
}

test('createJog: reads the position, computes the step and sends the commands', async () => {
  const { jog, sent } = jogSetup();
  const r = await jog.move('x', 1, 10);
  assert.equal(r.ok, true);
  assert.match(r.message, /X\+10 → X110/);
  assert.deepEqual(sent, [['G91', 'G0 X10 F6000', 'G90']]);
});

test('createJog: at the limit sends nothing', async () => {
  const { jog, sent } = jogSetup({ pos: { x: 234, y: 100, z: 20 } });
  const r = await jog.move('x', 1, 1);
  assert.equal(r.ok, false);
  assert.deepEqual(sent, []);
});

test('createJog: position not read (printing) — no move, the reason is shown', async () => {
  const { jog, sent } = jogSetup({ readError: new Error('нельзя во время печати') });
  const r = await jog.move('y', 1, 1);
  assert.deepEqual(r, { ok: false, message: 'нельзя во время печати' });
  assert.deepEqual(sent, []);
});

test('createJog: the Home guard blocks until read; Z is checked by the z part, X/Y by xy', async () => {
  const parts = [];
  const { jog, sent } = jogSetup({ guard: (part) => { parts.push(part); return part === 'z' ? { ok: false, message: homeHint() } : { ok: true, message: '' }; } });
  assert.deepEqual(await jog.move('z', 1, 1), { ok: false, message: homeHint() });
  assert.equal((await jog.move('x', 1, 1)).ok, true);
  assert.deepEqual(parts, ['z', 'xy']);
  assert.equal(sent.length, 1);
});

test('guardState: plugin without a guard; feed not connected; Home per part', () => {
  assert.deepEqual(guardState(null), { xy: { ok: true, message: '' }, z: { ok: true, message: '' } });
  const off = guardState({ state: 'connecting', detail: 'подключение…', homed: { xy: true, z: true } });
  assert.equal(off.xy.ok, false);
  assert.match(off.z.message, /не на связи/);
  const none = guardState({ state: 'live', detail: '', homed: { xy: false, z: false } });
  assert.deepEqual([none.xy, none.z], [{ ok: false, message: homeHint() }, { ok: false, message: homeHint() }]);
  const xyOnly = guardState({ state: 'live', detail: '', homed: { xy: true, z: false } });
  assert.equal(xyOnly.xy.ok, true);
  assert.equal(xyOnly.z.ok, false);
  assert.equal(homeHint(), 'Home не выполнен — сделайте Home до установки пера');
});

// --- bed: the right bed edge in nozzle coordinates X221, touch 8, clearance 1
const bedProfile = { ...profile, zClearanceMm: 1, bedX0: -12, bedY0: -3, bedX1: 221, bedY1: 230 };
const bedPlan = (axis, dir, step, pos) => planJog({ axis, dir, step, position: { x: 100, y: 100, z: 20, ...pos }, profile: bedProfile, calibration });

test('jog with a measured bed: the pen down at the bed edge — X+6 up to 221', () => {
  assert.deepEqual(bedPlan('x', 1, 10, { x: 215, z: 8.5 }), { ok: true, delta: 6, target: 221, clamped: true });
});

test('jog with a measured bed: the pen raised — only the axis limit clamps (X+10 to 225)', () => {
  assert.deepEqual(bedPlan('x', 1, 10, { x: 215, z: 20 }), { ok: true, delta: 10, target: 225, clamped: false });
});

test('jog: Z unknown counts as the pen down', () => {
  assert.deepEqual(planJog({ axis: 'x', dir: 1, step: 10, position: { x: 215, y: 100 }, profile: bedProfile, calibration }),
    { ok: true, delta: 6, target: 221, clamped: true });
  assert.deepEqual(jogRange('y', bedProfile, calibration, { x: 1, y: 1 }), [1, 230]);
});

test('jog: lowering off the bed edge stops at touch + clearance (Z−3 to 9), then "axis limit"', () => {
  assert.deepEqual(bedPlan('z', -1, 10, { x: 228, z: 12 }), { ok: true, delta: -3, target: 9, clamped: true });
  assert.equal(bedPlan('z', -1, 1, { x: 228, z: 9 }).ok, false);
  // over the bed — down to touch − 2 as before
  assert.deepEqual(bedPlan('z', -1, 10, { x: 200, z: 6.5 }), { ok: true, delta: -0.5, target: 6, clamped: true });
});

test('jog: the head off the area with the pen down — outward refused, inward allowed', () => {
  assert.equal(bedPlan('x', 1, 1, { x: 225, z: 8.5 }).ok, false);
  assert.deepEqual(bedPlan('x', -1, 1, { x: 225, z: 8.5 }), { ok: true, delta: -1, target: 224, clamped: false });
});

test('jog: bed not measured — as before (limits and touch − 2)', () => {
  assert.deepEqual(plan('x', 1, 10, { x: 215, z: 8.5 }), { ok: true, delta: 10, target: 225, clamped: false });
  assert.deepEqual(jogRange('z', profile, calibration, { x: 300, y: 100, z: 9 }), [6, JOG_Z_MAX]);
});

test('createJog: the read Z reaches the clamp', async () => {
  const { jog, sent } = jogSetup({ pos: { x: 215, y: 100, z: 8.5 }, prof: bedProfile });
  const r = await jog.move('x', 1, 10);
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [['G91', 'G0 X6 F6000', 'G90']]);
});

// --- "Go to"
const goProfile = { ...profile, limX0: -10, zStartOffset: 7, zClearanceMm: 1 }; // the corner X-5 is inside the limits here
const go = (pos, extra = {}) => planGoTo({ point: { x: -5, y: 50 }, position: pos, profile: goProfile, calibration, touchFresh: true, ...extra });

test('planGoTo: the head low — lift to the start height, move, lower to the clearance', () => {
  assert.deepEqual(go({ x: 100, y: 100, z: 8.5 }), { ok: true, lines: ['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000', 'G0 Z9 F600'] });
});

test('planGoTo: the head already high — no lift', () => {
  assert.deepEqual(go({ x: 100, y: 100, z: 30 }).lines, ['G90', 'G0 X-5 Y50 F6000', 'G0 Z9 F600']);
});

test('planGoTo: Z unknown — lift; the touch not fresh — no lowering', () => {
  assert.deepEqual(go({ x: 100, y: 100 }).lines, ['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000', 'G0 Z9 F600']);
  assert.deepEqual(go({ x: 100, y: 100, z: 8.5 }, { touchFresh: false }).lines, ['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000']);
});

test('planGoTo: a point outside the axis limits — refusal; meshNoFade adds the mesh command; never below touch + clearance', () => {
  assert.deepEqual(go({ z: 20 }, { point: { x: 240, y: 50 } }), { ok: false, message: 'точка вне пределов осей' });
  assert.deepEqual(go({ z: 20 }, { profile: { ...goProfile, meshNoFade: true } }).lines.slice(0, 2), ['G90', 'M420 S1 Z0']);
  const zs = go({ z: 8.5 }).lines.filter((l) => / Z/.test(l)).map((l) => Number(/Z([\d.-]+)/.exec(l)[1]));
  assert.ok(zs.every((z) => z >= 9));
});

test('createJog.goTo: reads the position and sends planGoTo lines', async () => {
  const { jog, sent } = jogSetup({ pos: { x: 100, y: 100, z: 8.5 }, prof: goProfile, touchFresh: () => true });
  const r = await jog.goTo({ x: -5, y: 50 });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000', 'G0 Z9 F600']]);
});

test('createJog.goTo: not without Home, not while printing, not on a read error', async () => {
  const noHome = jogSetup({ guard: (part) => (part === 'z' ? { ok: false, message: homeHint() } : { ok: true, message: '' }) });
  assert.deepEqual(await noHome.jog.goTo({ x: -5, y: 50 }), { ok: false, message: homeHint() });
  assert.deepEqual(noHome.sent, []);
  const busy = jogSetup({ readError: new Error('нельзя во время печати') });
  assert.deepEqual(await busy.jog.goTo({ x: -5, y: 50 }), { ok: false, message: 'нельзя во время печати' });
  assert.deepEqual(busy.sent, []);
  const out = jogSetup();
  assert.equal((await out.jog.goTo({ x: 240, y: 50 })).ok, false);
  assert.deepEqual(out.sent, []);
});
