import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFirmwareSettings, FEED_LOG_FILTER, classifySent } from '../src/core/marlin-replies.js';
import { firmwareAccelSuggestion, firmwareWarnings, firmwareEstimateOptions } from '../src/core/firmware-settings.js';
import { moveSeconds, estimateTime } from '../src/core/time-estimate.js';
import { createFirmwareMemo } from '../src/app/ui/feed-firmware.js';

// a real M503 reply of the Neptune 3 Pro (excerpt)
const M503 = [
  'echo:; Linear Units:', 'echo:  G21 ; (mm)', 'echo:; Steps per unit:', 'echo:  M92 X80.00 Y80.00 Z400.00 E424.90',
  'echo:; Maximum feedrates (units/s):', 'echo:  M203 X300.00 Y300.00 Z5.00 E60.00',
  'echo:; Maximum Acceleration (units/s2):', 'echo:  M201 X1100.00 Y900.00 Z100.00 E5000.00',
  'echo:; Acceleration (units/s2): P<print_accel> R<retract_accel> T<travel_accel>', 'echo:  M204 P500.00 R1000.00 T500.00',
  'echo:; Advanced: B<min_segment_time_us> S<min_feedrate> T<min_travel_feedrate> J<junc_dev>', 'echo:  M205 B20000 S0.00 T0.00 X8.00 Y8.00 Z0.40 E5.00',
  'echo:; Home offset:', 'echo:  M206 X0.00 Y0.00 Z0.00', 'echo:; Auto Bed Leveling:', 'echo:  M420 S1 Z10.00',
  'echo:  G29 W I0 J0 Z0.10000', 'echo:; Z-Probe Offset:', 'echo:  M851 X-27.00 Y-14.00 Z-1.50',
].join('\n');

test('M503: a real Neptune 3 Pro reply', () => {
  assert.deepEqual(parseFirmwareSettings(M503), {
    maxAccel: { x: 1100, y: 900, z: 100 }, maxFeed: { x: 300, y: 300, z: 5 }, accel: { print: 500, travel: 500 },
    jerk: { x: 8, y: 8, z: 0.4 }, meshFade: 10,
  });
});

test('M503: lines without echo:, extra spaces, one part at a time', () => {
  assert.deepEqual(parseFirmwareSettings('  M203 X300 Y300 Z5 E60'), { maxAccel: null, maxFeed: { x: 300, y: 300, z: 5 }, accel: null, jerk: null, meshFade: null });
  const r = parseFirmwareSettings('  M204 T750\n  M420 S0 Z0.00');
  assert.deepEqual(r.accel, { print: null, travel: 750 });
  assert.equal(r.meshFade, 0);
});

test('M503: no needed lines or an axis without a number — null', () => {
  assert.equal(parseFirmwareSettings('echo:; Maximum feedrates (units/s):\nok\necho:  M92 X80 Y80 Z400'), null);
  assert.equal(parseFirmwareSettings(''), null);
  assert.equal(parseFirmwareSettings('echo:  M205 B20000 S0 J0.013 E5'), null); // junction deviation without X/Y/Z — no jerk
});

test('the log filter passes M503 lines and the command, cuts the rest', () => {
  const re = new RegExp(FEED_LOG_FILTER);
  for (const l of ['Send: M503', 'Send: N5 M503*12', 'Recv: echo:  M203 X300.00 Y300.00 Z5.00 E60.00', 'Recv:   M201 X1100 Y900 Z100 E5000',
    'Recv: echo:  M204 P500.00 R1000.00 T500.00', 'Recv: echo:  M205 B20000 S0.00 T0.00 X8.00 Y8.00 Z0.40 E5.00', 'Recv: echo:  M420 S1 Z10.00']) {
    assert.ok(re.test(l), l);
  }
  for (const l of ['Send: M5031', 'Recv: echo:; Maximum feedrates (units/s):', 'Recv: echo:  M92 X80.00 Y80.00 Z400.00 E424.90',
    'Recv: echo:  M851 X-27.00 Y-14.00 Z-1.50', 'Recv: echo:  M206 X0.00 Y0.00 Z0.00', 'Recv: echo:  G29 W I0 J0 Z0.10000']) {
    assert.ok(!re.test(l), l);
  }
  assert.equal(classifySent('M503'), 'query');
});

const FW = parseFirmwareSettings(M503);

test('acceleration proposal: accelXY = min(T, X, Y), accelZ = min(T, Z)', () => {
  assert.deepEqual(firmwareAccelSuggestion(FW), { accelXY: 500, accelZ: 100 });
  assert.deepEqual(firmwareAccelSuggestion({ ...FW, accel: { print: 500, travel: 300 } }), { accelXY: 300, accelZ: 100 });
  assert.deepEqual(firmwareAccelSuggestion({ ...FW, accel: { print: 500, travel: 2000 } }), { accelXY: 900, accelZ: 100 });
  assert.deepEqual(firmwareAccelSuggestion({ maxAccel: null, maxFeed: null, accel: { print: null, travel: 750 }, jerk: null, meshFade: null }), { accelXY: 750, accelZ: 750 });
  assert.deepEqual(firmwareAccelSuggestion({ maxAccel: null, maxFeed: null, accel: null, jerk: null, meshFade: 10 }), {});
  assert.deepEqual(firmwareAccelSuggestion(null), {});
});

const PROFILE = { fDraw: 3000, fTravel: 6000, fZUp: 1200, fZDown: 600, meshNoFade: false };

test('warnings: Z feeds above M203 Z, XY is fine', () => {
  const w = firmwareWarnings(PROFILE, { zTouch: 8 }, FW);
  const feed = w.find((x) => x.kind === 'feed');
  assert.ok(feed);
  assert.match(feed.text, /Z вверх 1200 мм\/мин выше предела прошивки по Z \(M203: 5 мм\/с = 300 мм\/мин\)/);
  assert.match(feed.text, /Z вниз 600/);
  assert.doesNotMatch(feed.text, /рисования|переезда/);
  assert.match(feed.text, /срежет/);
});

test('warnings: XY feed above M203 X/Y·60', () => {
  const w = firmwareWarnings({ ...PROFILE, fDraw: 18001, fTravel: 18000, fZUp: 300, fZDown: 300 }, { zTouch: 8 }, FW);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /рисования 18001/);
  assert.doesNotMatch(w[0].text, /переезда/);
});

test('warnings: mesh fade below the touch — informs; meshNoFade or fade 0 — no', () => {
  const ok = { ...PROFILE, fZUp: 300, fZDown: 300 };
  assert.equal(firmwareWarnings(ok, { zTouch: 8 }, FW).length, 0);
  const w = firmwareWarnings(ok, { zTouch: 12 }, FW);
  assert.equal(w.length, 1);
  assert.equal(w[0].kind, 'mesh');
  assert.match(w[0].text, /10 мм/);
  assert.equal(firmwareWarnings({ ...ok, meshNoFade: true }, { zTouch: 12 }, FW).length, 0);
  assert.equal(firmwareWarnings(ok, { zTouch: 12 }, { ...FW, meshFade: 0 }).length, 0);
  assert.deepEqual(firmwareWarnings(PROFILE, { zTouch: 12 }, null), []);
});

test('estimate parameters from the firmware', () => {
  assert.deepEqual(firmwareEstimateOptions(FW), { maxFeedXY: 300, maxFeedZ: 5, jerkXY: 8, jerkZ: 0.4 });
  assert.equal(firmwareEstimateOptions({ ...FW, maxFeed: { x: 300, y: 200, z: 5 } }).maxFeedXY, 200);
  assert.deepEqual(firmwareEstimateOptions(null), {});
});

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('moveSeconds: without options the old formula; limits do not change a move unless they trigger', () => {
  near(moveSeconds(100, 3000, 500), 2.1);
  near(moveSeconds(100, 3000, 500, {}), 2.1);
  near(moveSeconds(100, 3000, 500, { maxFeed: 1000, jerk: 0 }), 2.1);
});

test('moveSeconds: the feed limit clamps the speed', () => {
  // 6000 mm/min = 100 mm/s, limit 50 mm/s: like a move at 3000
  near(moveSeconds(100, 6000, 500, { maxFeed: 50 }), 2.1);
  // Z: feed 1200 (20 mm/s) with a 5 mm/s limit, a = 100: 10 mm → 10/5 + 5/100
  near(moveSeconds(10, 1200, 100, { maxFeed: 5 }), 2.05);
});

test('moveSeconds: jerk — start and finish at speed min(jerk, v)', () => {
  // v = 50, v0 = 8, a = 500, len = 100: acceleration (2500-64)/1000 = 2.436 mm
  near(moveSeconds(100, 3000, 500, { jerk: 8 }), (2 * 42) / 500 + (100 - 2 * 2.436) / 50);
  // triangle: len = 1, vp = sqrt(500 + 64)
  near(moveSeconds(1, 3000, 500, { jerk: 8 }), (2 * (Math.sqrt(564) - 8)) / 500);
  // jerk above the feed: the move runs at constant speed
  near(moveSeconds(10, 3000, 500, { jerk: 100 }), 10 / 50);
  // with jerk faster than with a stop
  assert.ok(moveSeconds(1, 3000, 500, { jerk: 8 }) < moveSeconds(1, 3000, 500));
  // continuity at the trapezoid/triangle boundary
  const len = 2 * ((50 * 50 - 64) / 1000);
  near(moveSeconds(len - 1e-9, 3000, 500, { jerk: 8 }), moveSeconds(len, 3000, 500, { jerk: 8 }), 1e-6);
});

test('estimateTime: without firmware data the result is unchanged, with data — different', () => {
  const moves = [{ kind: 'draw', pts: [0, 0, 1, 0, 2, 0, 3, 1], feed: 3000 }, { kind: 'z', len: 2.7, feed: 600 }, { kind: 'travel', len: 50, feed: 6000 }];
  const base = estimateTime(moves, { accelXY: 500, accelZ: 100 });
  assert.deepEqual(estimateTime(moves, { accelXY: 500, accelZ: 100, ...firmwareEstimateOptions(null) }), base);
  const withFw = estimateTime(moves, { accelXY: 500, accelZ: 100, ...firmwareEstimateOptions(FW) });
  assert.notDeepEqual(withFw, base);
  // feed clamp only: Z 600 mm/min = 10 mm/s > 5 → slower
  const cap = estimateTime(moves, { accelXY: 500, accelZ: 100, maxFeedZ: 5 });
  assert.ok(cap.max > base.max);
  // jerk only: faster
  const jerk = estimateTime(moves, { accelXY: 500, accelZ: 100, jerkXY: 8, jerkZ: 0.4 });
  assert.ok(jerk.max < base.max);
});

test('firmware settings memory: feed session, erase on drop, notifications', async () => {
  const f = { st: 'live', ses: 1, pending: null, ls: new Set() };
  f.state = () => f.st; f.session = () => f.ses;
  f.onChange = (fn) => { f.ls.add(fn); return () => f.ls.delete(fn); };
  f.readFirmwareSettings = () => new Promise((r) => { f.pending = r; });
  const m = createFirmwareMemo(f);
  let n = 0;
  m.subscribe(() => n++);
  const p = m.read();
  f.pending(FW);
  assert.deepEqual(await p, FW);
  assert.deepEqual(m.get(), FW);
  assert.equal(n, 1);
  f.st = 'connecting'; for (const l of f.ls) l();
  assert.equal(m.get(), null);
  assert.equal(n, 2);
  f.st = 'live'; f.ses++;
  assert.equal(m.get(), null);
  // the session changed during the read — the result is discarded
  const q = m.read();
  f.ses++;
  f.pending(FW);
  assert.equal(await q, null);
  assert.equal(m.get(), null);
});
