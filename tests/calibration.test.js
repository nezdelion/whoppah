import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cornerFromPosition, touchFromPosition, calibrationFreshness, staleMessage } from '../src/core/calibration.js';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createCalibrationMonitor, POLL_MS } from '../src/app/calibration/monitor.js';
import { createCalibrationCapture } from '../src/app/calibration/capture.js';
import { setupCalibration } from '../src/app/calibration/setup.js';
import { calibrationFreshCheck } from '../src/app/print/checks.js';
import { fakeServer, fakeTimers, fakeVisibility } from './helpers/fake-position.js';

// --- pure functions

test('pen at the corner: corner = position', () => {
  assert.deepEqual(cornerFromPosition({ x: -5, y: 50, z: 8 }), { cornerX: -5, cornerY: 50 });
});

test('pen outside the sheet: corner = position − offset', () => {
  assert.deepEqual(cornerFromPosition({ x: -15, y: 40 }, { x: -10, y: -10 }), { cornerX: -5, cornerY: 50 });
  assert.deepEqual(cornerFromPosition({ x: 10.0004, y: 0.1 + 0.2 }, { x: 0, y: 0 }), { cornerX: 10, cornerY: 0.3 });
});

test('touch: Z from the position; outside the schema range — an error', () => {
  assert.deepEqual(touchFromPosition({ z: 8.2 }), { zTouch: 8.2 });
  assert.match(touchFromPosition({ z: -1 }).error, /вне допустимого/);
  assert.match(touchFromPosition({ z: 400 }).error, /вне допустимого/);
});

test('part freshness by epoch; without an epoch — outdated', () => {
  assert.deepEqual(calibrationFreshness({ epochXY: 3, epochZ: 3 }, 3), { xy: true, z: true, stale: [] });
  assert.deepEqual(calibrationFreshness({ epochXY: 3, epochZ: 2 }, 3), { xy: true, z: false, stale: ['касание'] });
  assert.deepEqual(calibrationFreshness({ epochXY: null, epochZ: undefined }, 0), { xy: false, z: false, stale: ['угол листа', 'касание'] });
  assert.equal(staleMessage([]), '');
  assert.match(staleMessage(['касание']), /^Калибровка могла устареть: касание/);
});

// --- app: capture, monitor, pre-print check

async function app({ head, calibration, visible = true } = {}) {
  const server = fakeServer({ head, calibration });
  const store = new MemoryStore();
  const state = createState({ store });
  await state.load();
  const timers = fakeTimers();
  const visibility = fakeVisibility(visible);
  const monitor = createCalibrationMonitor({ state, positionSource: server.source, loadCalibration: async () => structuredClone(server.calibration), timers, visibility });
  const capture = createCalibrationCapture({ state, positionSource: server.source, monitor });
  return { server, state, timers, visibility, monitor, capture, check: calibrationFreshCheck(monitor) };
}
const cal = (a) => a.state.get('calibration');

test('Corner here: the corner is written, the date updated, the corner epoch is fresh', async () => {
  const a = await app({ head: { x: -5, y: 50, z: 8 } });
  const r = await a.capture.captureCorner();
  assert.equal(r.ok, true);
  assert.deepEqual([cal(a).cornerX, cal(a).cornerY, cal(a).epochXY, cal(a).updatedAt], [-5, 50, 0, 'T']);
});

test('Corner here with an offset: the pen is outside the sheet', async () => {
  const a = await app({ head: { x: -15, y: 40, z: 8 } });
  await a.capture.captureCorner({ x: -10, y: -10 });
  assert.deepEqual([cal(a).cornerX, cal(a).cornerY], [-5, 50]);
});

test('Touch here: Z is written, the heights are recomputed from it', async () => {
  const { absoluteZ, defaultsOf, PROFILE_SCHEMA } = await import('../src/core/profile.js');
  const a = await app({ head: { x: 0, y: 0, z: 8.2 } });
  const r = await a.capture.captureTouch();
  assert.equal(r.ok, true);
  assert.equal(cal(a).zTouch, 8.2);
  assert.equal(absoluteZ(defaultsOf(PROFILE_SCHEMA), cal(a)).down, 7.5);
});

for (const [kind, text] of [['busy', /печат/], ['offline', /не подключён/], ['timeout', /не ответил/], ['forbidden', /./]]) {
  test(`read error ${kind}: the calibration is unchanged, the message is shown`, async () => {
    const a = await app({ calibration: { cornerX: 1, cornerY: 2, zTouch: 3 } });
    await a.state.load();
    a.state.adoptCalibration(a.server.calibration);
    a.server.failNext(kind, { busy: 'нельзя во время печати', offline: 'принтер не подключён', timeout: 'принтер не ответил', forbidden: 'нет права' }[kind]);
    const before = structuredClone(cal(a));
    const r = await a.capture.captureCorner();
    assert.equal(r.ok, false);
    assert.match(r.message, text);
    assert.deepEqual(cal(a), before);
    assert.equal(a.server.calibration.cornerX, 1);
  });
}

test('homing between the read and the save: refusal, the calibration is unchanged', async () => {
  const a = await app();
  const read = a.server.source.read;
  a.server.source.read = async () => { const p = await read(); a.server.g28(); return p; };
  const r = await a.capture.captureCorner();
  assert.equal(r.ok, false);
  assert.match(r.message, /повторите захват/);
  assert.equal(a.server.calibration, null);
  assert.equal(cal(a).epochXY, null);
});

test('firmware without M118: the capture buttons are disabled', async () => {
  const a = await app();
  assert.equal(a.capture.unsupported, false);
  a.server.failNext('unsupported', 'прошивка не отвечает на M118');
  await a.capture.captureTouch();
  assert.equal(a.capture.unsupported, true);
});

test('a capture outside the touch range is not sent to the server', async () => {
  const a = await app({ head: { x: 0, y: 0, z: -3 } });
  const r = await a.capture.captureTouch();
  assert.equal(r.ok, false);
  assert.equal(a.server.calibration, null);
});

test('homing in another tab: a warning within 10 s at most, without a reload', async () => {
  const a = await app();
  a.monitor.start();
  await a.capture.captureCorner();
  await a.capture.captureTouch();
  await a.timers.tick(0);
  assert.equal(a.monitor.status().message, '');
  const seen = [];
  a.monitor.subscribe((s) => seen.push(s.message));
  a.server.g28();
  await a.timers.tick(2 * POLL_MS);
  assert.match(a.monitor.status().message, /могла устареть: угол листа, касание/);
  assert.ok(seen.some((m) => m));
  assert.ok(2 * POLL_MS <= 10000);
});

test('after homing only the corner is captured: the touch stays outdated, printing with confirmation', async () => {
  const a = await app();
  await a.capture.captureCorner(); await a.capture.captureTouch();
  a.server.g28();
  await a.capture.captureCorner();
  const s = a.monitor.status();
  assert.deepEqual([s.xy, s.z, s.stale], [true, false, ['касание']]);
  assert.match(s.message, /касание/);
  const r = await a.check({});
  assert.equal(r.level, 'confirm');
  assert.match(r.message, /касание/);
  assert.doesNotMatch(r.message, /угол листа/);
});

test('explicit confirmation: both parts are fresh, the warning is cleared', async () => {
  const a = await app();
  await a.capture.captureCorner(); await a.capture.captureTouch();
  a.server.g28();
  await a.capture.captureCorner();
  assert.equal((await a.capture.confirm('z')).ok, true);
  assert.equal(a.monitor.status().message, '');
  assert.equal((await a.check({})).level, 'ok');
});

test('the pre-send check sees a fresh G28 before the next poll', async () => {
  const a = await app();
  a.monitor.start();
  await a.capture.captureCorner(); await a.capture.captureTouch();
  await a.timers.tick(0);
  a.server.g28(); // the poll has not fired yet
  assert.equal(a.monitor.status().message, '');
  const r = await a.check({});
  assert.equal(r.level, 'confirm');
});

test('a calibration without epochs (entered manually earlier): outdated in both parts', async () => {
  const a = await app({ calibration: { cornerX: 1, cornerY: 2, zTouch: 3, updatedAt: 'X' } });
  a.monitor.start();
  await a.timers.tick(0);
  assert.deepEqual(a.monitor.status().stale, ['угол листа', 'касание']);
});

test('part epochs come from the server: a capture in another tab clears the warning', async () => {
  const a = await app();
  a.monitor.start();
  a.server.g28();
  await a.timers.tick(POLL_MS);
  assert.ok(a.monitor.status().message);
  a.server.calibration = { cornerX: -5, cornerY: 50, zTouch: 8, epochXY: 1, epochZ: 1 };
  await a.timers.tick(POLL_MS);
  assert.equal(a.monitor.status().message, '');
});

test('a manual edit is saved: the epochs are pulled from the server after the write', async () => {
  const a = await app();
  a.monitor.start();
  await a.capture.captureCorner(); await a.capture.captureTouch();
  a.server.g28();
  // manual input of Z only: the server (model) gives the current epoch of Z only
  a.server.calibration = { ...a.server.calibration, zTouch: 9, epochZ: 1 };
  a.state.adoptCalibration(a.server.calibration, { epochsOnly: true });
  await a.timers.tick(POLL_MS);
  assert.deepEqual(a.monitor.status().stale, ['угол листа']);
});

test('polling runs only while the page is visible; on return — immediately', async () => {
  const a = await app();
  a.monitor.start();
  await a.timers.tick(0);
  const n = a.server.epochCalls;
  a.visibility.set(false);
  assert.equal(a.timers.active(), 0);
  await a.timers.tick(60000);
  assert.equal(a.server.epochCalls, n);
  a.server.g28();
  a.visibility.set(true);
  await a.timers.tick(0);
  assert.ok(a.server.epochCalls > n, 'request right away on return');
  assert.equal(a.timers.active(), 1);
  a.monitor.stop();
  assert.equal(a.timers.active(), 0);
});

test('no connection during the poll: the warning is not invented, the state is not reset', async () => {
  const a = await app();
  a.monitor.start();
  await a.capture.captureCorner(); await a.capture.captureTouch();
  a.server.g28();
  await a.timers.tick(POLL_MS);
  const msg = a.monitor.status().message;
  assert.ok(msg);
  a.server.source.epoch = async () => { throw new Error('сеть'); };
  await a.timers.tick(POLL_MS);
  assert.equal(a.monitor.status().message, msg);
  assert.equal((await a.check({})).level, 'confirm');
});

test('epoch unknown (no poll yet): the pre-print check does not interfere', async () => {
  const a = await app();
  a.server.source.epoch = async () => { throw new Error('сеть'); };
  assert.equal((await a.check({})).level, 'ok');
});

test('standalone: without a position source there are neither buttons nor a check', async () => {
  const state = createState({ store: new MemoryStore() });
  assert.equal(setupCalibration({ positionSource: null, state, store: new MemoryStore() }), null);
  assert.equal(setupCalibration({ positionSource: undefined, state, store: new MemoryStore() }), null);
});

test('state.adoptCalibration: epochs only do not touch the entered values; without changes — no event', async () => {
  const a = await app();
  await a.state.patch('calibration', { cornerX: 7 });
  let events = 0;
  a.state.subscribe((e) => { if (e.type === 'settings') events++; });
  a.state.adoptCalibration({ cornerX: 1, cornerY: 2, zTouch: 3, epochXY: 4, epochZ: 5 }, { epochsOnly: true });
  assert.deepEqual([cal(a).cornerX, cal(a).epochXY, cal(a).epochZ], [7, 4, 5]);
  a.state.adoptCalibration({ cornerX: 1, epochXY: 4, epochZ: 5 }, { epochsOnly: true });
  assert.equal(events, 1);
});
