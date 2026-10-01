// Calibration capture in standalone: the feed source + the calibration in the app storage, the homing done flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrinterFeed, createFeedPositionSource } from '../src/transport/octoprint-feed.js';
import * as replies from '../src/core/marlin-replies.js';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { setupCalibration } from '../src/app/calibration/setup.js';
import { clock, FakeWebSocket, current, history, fakeLogin } from './helpers/fake-feed.js';
import { fakeVisibility } from './helpers/fake-position.js';
import './helpers/ru.js';

const ridOf = (sent) => /PLT_B (\S+)/.exec(sent[sent.length - 1][0])[1];

async function setup({ stored = null } = {}) {
  FakeWebSocket.instances = [];
  const t = clock();
  const sent = [];
  const feed = createPrinterFeed({
    getBaseUrl: () => 'http://octopi.local', getKey: () => 'KEY-SECRET', replies,
    sendCommands: async (lines) => { sent.push([...lines]); },
    timers: t, WebSocket: FakeWebSocket, fetch: fakeLogin().fetch,
  });
  const store = new MemoryStore();
  if (stored) await store.save('calibration', stored);
  const stamp = (changes) => {
    const e = feed.epoch(), out = {};
    if (('cornerX' in changes || 'cornerY' in changes) && !('epochXY' in changes)) out.epochXY = e.xy;
    if ('zTouch' in changes && !('epochZ' in changes)) out.epochZ = e.z;
    return out;
  };
  const state = createState({ store, now: () => 'NOW', stampEdit: stamp });
  await state.load();
  const source = createFeedPositionSource(feed, { calibration: { get: () => state.get('calibration'), patch: (c) => state.patch('calibration', c) } });
  const cal = setupCalibration({ positionSource: source, state, store, visibility: fakeVisibility(false), standalone: true, transport: { command: (l) => feed.command(l) } });
  const ws = () => FakeWebSocket.last();
  feed.start();
  await t.flush();
  ws().open();
  ws().push(history([]));
  await t.flush();
  const ctx = { feed, t, sent, state, store, source, cal, ws };
  ctx.home = async (cmd = 'G28') => { ws().push(current([`Send: ${cmd}`])); await t.flush(); };
  /** The printer reply to a position read started by the action act() */
  ctx.answer = async (x, y, z) => {
    await t.flush();
    const rid = ridOf(sent);
    ws().push(current([`Recv: PLT_B ${rid}`, `Recv: X:${x} Y:${y} Z:${z} E:0`, `Recv: PLT_E ${rid}`]));
    await t.flush();
  };
  return ctx;
}

test('feed: homing per axes, reset on Connected, a drop and stop; G92 and moves do not home', async () => {
  const s = await setup();
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  await s.home('G0 X5');
  await s.home('G92 X0');
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  await s.home('G28 X Y');
  assert.deepEqual(s.feed.homed(), { xy: true, z: false });
  await s.home('G28 Z');
  assert.deepEqual(s.feed.homed(), { xy: true, z: true });
  s.ws().push({ event: { type: 'Connected' } });
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  await s.home('G28 O');
  assert.deepEqual(s.feed.homed(), { xy: true, z: true });
  s.ws().drop();
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  await s.t.tick(2000);
  s.ws().open(); s.ws().push(history([])); await s.t.flush();
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  await s.home();
  s.feed.stop();
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
});

test('feed: an own G28 (the Home button) also counts as homing and does not advance the epoch', async () => {
  const s = await setup();
  const e0 = s.feed.epoch();
  await s.feed.command(['G28']);
  await s.home('N7 G28*12');
  assert.deepEqual(s.feed.homed(), { xy: true, z: true });
  assert.deepEqual(s.feed.epoch(), e0);
  s.feed.stop();
});

test('guard: without Home capture refuses without reading the position; after Home it saves with an epoch', async () => {
  const s = await setup();
  const before = s.sent.length;
  const blocked = await s.cal.calibrator.capture.captureCorner();
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /Home не выполнен/);
  assert.equal(s.sent.length, before);
  assert.match(s.cal.calibrator.link().hint, /Home не выполнен/);

  await s.home();
  const p = s.cal.calibrator.capture.captureCorner({ x: -10, y: -10 });
  await s.answer(-15, 40, 8);
  const r = await p;
  assert.equal(r.ok, true, r.message);
  const c = s.state.get('calibration');
  assert.equal(c.cornerX, -5);
  assert.equal(c.cornerY, 50);
  assert.equal(c.epochXY, s.feed.epoch().xy);
  assert.equal(c.epochZ, null); // the touch is not affected
  assert.equal(c.updatedAt, 'NOW');
  assert.equal((await s.store.load('calibration')).cornerX, -5); // written to the app storage
  s.feed.stop();
});

test('G28 between the read and the save — stale of the same shape, the calibration does not change', async () => {
  const s = await setup();
  await s.home();
  const p = s.source.read();
  await s.answer(1, 2, 3);
  const pos = await p;
  await s.home('G28 X Y');
  await assert.rejects(s.source.saveCorner({ x: 1, y: 2, epoch: pos.epochXY }), (e) => e.kind === 'stale' && e.message === 'положение сбилось — повторите захват');
  assert.equal(s.state.get('calibration').cornerX, -5); // default value
  // the Z epoch did not change: the touch is saved with the previous epoch
  const doc = await s.source.saveTouch({ zTouch: 8.2, epoch: pos.epochZ });
  assert.equal(doc.zTouch, 8.2);
  assert.equal(doc.epochZ, pos.epochZ);
  s.feed.stop();
});

test('Touch is correct: the current Z epoch, values and date do not change, the corner is untouched', async () => {
  const s = await setup({ stored: { cornerX: 1, cornerY: 2, zTouch: 7, updatedAt: 'OLD', epochXY: null, epochZ: null } });
  await s.home();
  const r = await s.cal.calibrator.capture.confirm('z');
  assert.equal(r.ok, true, r.message);
  const c = s.state.get('calibration');
  assert.equal(c.epochZ, s.feed.epoch().z);
  assert.equal(c.epochXY, null);
  assert.equal(c.zTouch, 7);
  assert.equal(c.updatedAt, 'OLD');
  s.feed.stop();
});

test('monitor in standalone: G28 X Y makes only the corner outdated', async () => {
  const s = await setup();
  await s.home();
  await s.cal.calibrator.capture.confirm('xy');
  await s.cal.calibrator.capture.confirm('z');
  let st = await s.cal.calibrator.monitor.refresh();
  assert.deepEqual([st.xy, st.z], [true, true]);
  await s.home('G28 X Y');
  st = await s.cal.calibrator.monitor.refresh();
  assert.deepEqual([st.xy, st.z], [false, true]);
  s.feed.stop();
});

test('manual input of a part values sets its current epoch, the other is untouched', async () => {
  const s = await setup();
  await s.home('G28 X Y');
  await s.state.patch('calibration', { cornerX: 3 });
  const c = s.state.get('calibration');
  assert.equal(c.epochXY, s.feed.epoch().xy);
  assert.equal(c.epochZ, null);
});

test('after a reload the saved epochs do not match the feed counters: reset to null', async () => {
  // feed counters start from 0 again after a reload; a saved epoch 0 would look fresh — main.js resets it
  const s = await setup({ stored: { cornerX: 1, cornerY: 2, zTouch: 7, epochXY: 0, epochZ: 0 } });
  assert.equal(s.cal.calibrator.monitor.status().known, false);
  s.state.adoptCalibration({ ...s.state.get('calibration'), epochXY: null, epochZ: null });
  const st = await s.cal.calibrator.monitor.refresh();
  assert.deepEqual([st.xy, st.z], [false, false]);
  assert.equal(s.state.get('calibration').cornerX, 1); // values are intact
  s.feed.stop();
});

test('jog panel in standalone: a step via the feed is not counted as a foreign move, Z does not go below the touch', async () => {
  const s = await setup({ stored: { cornerX: 1, cornerY: 2, zTouch: 8 } });
  await s.home();
  const jog = s.cal.calibrator.jog;
  const e0 = s.feed.epoch();
  const p = jog.move('x', 1, 10);
  await s.answer(100, 100, 20);
  const r = await p;
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(s.sent[s.sent.length - 1], ['G91', 'G0 X10 F6000', 'G90']);
  // own G91/G0/G90 arrive in the log and are recognized as own
  s.ws().push(current(['Send: G91', 'Send: G0 X10 F6000', 'Send: G90']));
  await s.t.flush();
  assert.deepEqual(s.feed.epoch(), e0);
  assert.equal(s.feed.positionKnown(), true); // own commands do not make the position unknown
  const q = jog.move('z', -1, 10);
  await s.answer(110, 100, 6.5);
  assert.equal((await q).ok, true);
  assert.deepEqual(s.sent[s.sent.length - 1], ['G91', 'G0 Z-0.5 F600', 'G90']);
  s.feed.stop();
});

test('Already homed: markHomed removes the guard, epochs and calibration do not change, an event reset restores the guard', async () => {
  const s = await setup({ stored: { cornerX: 1, cornerY: 2, zTouch: 8, epochXY: null, epochZ: null } });
  const e0 = s.feed.epoch();
  assert.equal(s.cal.calibrator.link().homeMissing, true);
  s.cal.calibrator.markHomed();
  assert.deepEqual(s.feed.homed(), { xy: true, z: true });
  assert.deepEqual(s.feed.epoch(), e0);
  assert.equal(s.cal.calibrator.link().xy.ok && s.cal.calibrator.link().z.ok, true);
  assert.equal(s.cal.calibrator.link().homeMissing, false);
  assert.equal(s.state.get('calibration').epochXY, null); // calibration freshness is unchanged
  assert.equal((await s.cal.calibrator.monitor.refresh()).xy, false);
  // a foreign G28 after that works as before
  await s.home('G28 X Y');
  assert.deepEqual(s.feed.epoch(), { xy: e0.xy + 1, z: e0.z });
  assert.deepEqual(s.feed.homed(), { xy: true, z: true });
  s.ws().push({ event: { type: 'Disconnected' } });
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
  s.cal.calibrator.markHomed();
  s.ws().drop();
  assert.deepEqual(s.feed.homed(), { xy: false, z: false });
});
