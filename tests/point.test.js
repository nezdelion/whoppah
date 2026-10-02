// The "Point" control with fake handlers, and capture of the bed corners into the active profile.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.js';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createCalibrationCapture } from '../src/app/calibration/capture.js';
import { guardState } from '../src/app/calibration/guard.js';
import { fakeServer } from './helpers/fake-position.js';
import './helpers/ru.js';

let createPoint;
before(async () => {
  installFakeDom();
  ({ createPoint } = await import('../src/app/ui/point.js'));
});

const tick = () => new Promise((r) => setImmediate(r));
const inputs = (p) => p.element.findAll((e) => e.tagName === 'INPUT');
const buttons = (p) => p.element.findAll((e) => e.tagName === 'BUTTON');
const byText = (p, text) => buttons(p).find((b) => b.textContent === text);

test('point: the value and the note are shown; manual input saves both numbers', async () => {
  const saved = [];
  const p = createPoint({ label: 'Угол листа', value: { x: -5, y: 50 }, note: 'по номиналу', onSave: async (v) => { saved.push(v); } });
  const [x, y] = inputs(p);
  assert.deepEqual([x.value, y.value], ['-5', '50']);
  assert.match(p.element.textContent, /по номиналу/);
  x.value = '-7';
  x.dispatch('change');
  await tick();
  assert.deepEqual(saved, [{ x: -7, y: 50 }]);
  y.value = '';
  y.dispatch('change');
  await tick();
  assert.equal(saved.length, 1, 'not a number — not saved');
});

test('point: a refused manual value returns to the saved one', async () => {
  const p = createPoint({ label: 'Правый верхний угол стола', value: { x: 235, y: 235 }, onSave: async () => ({ ok: false, message: 'сначала левый нижний угол стола' }) });
  const [x] = inputs(p);
  x.value = '221';
  x.dispatch('change');
  await tick(); await tick();
  assert.equal(x.value, '235');
  assert.match(p.element.textContent, /сначала левый нижний угол/);
});

test('point: "Use current position" — a failed read changes neither the fields nor the value', async () => {
  const log = [];
  const p = createPoint({
    label: 'Левый нижний угол стола', value: { x: 0, y: 0 }, log: (m) => log.push(m),
    onCapture: async () => ({ ok: false, message: 'принтер не ответил' }),
  });
  byText(p, 'Взять текущее').click();
  await tick();
  assert.deepEqual(inputs(p).map((i) => i.value), ['0', '0']);
  assert.match(p.element.textContent, /принтер не ответил/);
  assert.deepEqual(log, ['Левый нижний угол стола: принтер не ответил']);
});

test('point: a successful capture fills the fields; "Go to" gets the field values', async () => {
  const went = [];
  const p = createPoint({
    label: 'Угол', value: { x: 0, y: 0 },
    onCapture: async () => ({ ok: true, message: 'ok', value: { x: -12, y: -3 } }),
    onGoTo: async (v) => { went.push(v); return { ok: true, message: '' }; },
  });
  byText(p, 'Взять текущее').click();
  await tick();
  assert.deepEqual(inputs(p).map((i) => i.value), ['-12', '-3']);
  byText(p, 'Перейти').click();
  await tick();
  assert.deepEqual(went, [{ x: -12, y: -3 }]);
});

test('point: without the write permission the fields and "Use current position" are unavailable, "Go to" by the jog rules', () => {
  const p = createPoint({ label: 'Угол', onSave: () => {}, onCapture: async () => ({ ok: true }), onGoTo: async () => ({ ok: true }) });
  p.setEnabled({ edit: false, capture: false, move: true });
  assert.ok(inputs(p).every((i) => i.disabled));
  assert.equal(byText(p, 'Взять текущее').disabled, true);
  assert.equal(byText(p, 'Перейти').disabled, false);
  const plain = createPoint({ label: 'Угол' });
  assert.equal(buttons(plain).length, 0, 'no handlers — no buttons');
});

// --- capture of the bed corners (position read → the active profile)

async function bedApp({ head = { x: -12, y: -3, z: 20 }, guard, profileNeed } = {}) {
  const server = fakeServer({ head });
  const state = createState({ store: new MemoryStore() });
  await state.load();
  const capture = createCalibrationCapture({ state, positionSource: server.source, monitor: { refresh: async () => {} }, guard, profileNeed });
  return { server, state, capture, profile: () => state.get('profile') };
}

test('bed: the lower left corner — the bed X-12…223 Y-3…232, the upper right by the nominal; no epoch', async () => {
  const a = await bedApp();
  const r = await a.capture.captureBedCorner('ll');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { x: -12, y: -3 });
  const p = a.profile();
  assert.deepEqual([p.bedX0, p.bedY0, p.bedX1, p.bedY1, p.bedUrNominal], [-12, -3, 223, 232, true]);
  assert.equal(a.state.get('calibration').epochXY, null, 'the bed has no coordinate epoch');
});

test('bed: two points — the captured upper right removes the nominal mark', async () => {
  const a = await bedApp();
  await a.capture.captureBedCorner('ll');
  a.server.head = { x: 221, y: 230, z: 20 };
  assert.equal((await a.capture.captureBedCorner('ur')).ok, true);
  const p = a.profile();
  assert.deepEqual([p.bedX1, p.bedY1, p.bedUrNominal], [221, 230, false]);
});

test('bed: the upper right without the lower left — nothing saved, the head is not even read', async () => {
  const a = await bedApp();
  assert.deepEqual(await a.capture.captureBedCorner('ur'), { ok: false, message: 'сначала левый нижний угол стола' });
  assert.equal(a.server.reads, 0);
  assert.equal(a.profile().bedX0, null);
});

test('bed: while printing — "not possible while printing", the profile unchanged', async () => {
  const a = await bedApp();
  a.server.failNext('busy', 'нельзя во время печати');
  const r = await a.capture.captureBedCorner('ll');
  assert.deepEqual(r, { ok: false, message: 'нельзя во время печати' });
  assert.equal(a.profile().bedX0, null);
});

test('bed: not homed — the guard refuses, nothing is read', async () => {
  const guard = (part) => guardState({ state: 'live', detail: '', homed: { xy: false, z: false } })[part];
  const a = await bedApp({ guard });
  const r = await a.capture.captureBedCorner('ll');
  assert.equal(r.ok, false);
  assert.match(r.message, /Home не выполнен/);
  assert.equal(a.server.reads, 0);
});

test('bed: without the machine profile permission — refused with the permission name', async () => {
  const a = await bedApp({ profileNeed: () => 'нужно право «изменение профиля машины»' });
  const r = await a.capture.captureBedCorner('ll');
  assert.deepEqual(r, { ok: false, message: 'нужно право «изменение профиля машины»' });
  assert.equal(a.server.reads, 0);
  assert.equal(a.profile().bedX0, null);
});

// --- "pen offset" mode: the pen tip at a bed corner

test('offset: the pen at the far right bed corner, head X200 Y235 — the bed is the nominal one shifted by −offset', async () => {
  const a = await bedApp();
  a.server.head = { x: 200, y: 235, z: 20 };
  const r = await a.capture.captureBedFromOffsetCorner('ur');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { x: 35, y: 0 });
  const p = a.profile();
  assert.deepEqual([p.bedX0, p.bedY0, p.bedX1, p.bedY1, p.bedUrNominal], [-35, 0, 200, 235, true]);
});

test('offset: the near right corner at head X200 Y-3; without the profile permission — refused, nothing read', async () => {
  const a = await bedApp();
  a.server.head = { x: 200, y: -3, z: 20 };
  assert.deepEqual((await a.capture.captureBedFromOffsetCorner('lr')).value, { x: 35, y: 3 });
  assert.deepEqual([a.profile().bedX0, a.profile().bedY0], [-35, -3]);
  const b = await bedApp({ profileNeed: () => 'нужно право «изменение профиля машины»' });
  const r = await b.capture.captureBedFromOffsetCorner('ur');
  assert.equal(r.ok, false);
  assert.equal(b.server.reads, 0);
  a.server.failNext('busy', 'нельзя во время печати');
  assert.deepEqual(await a.capture.captureBedFromOffsetCorner('ur'), { ok: false, message: 'нельзя во время печати' });
  assert.deepEqual([a.profile().bedX0, a.profile().bedY0], [-35, -3], 'the profile is unchanged while printing');
});

test('offset: a refused profile write (409 conflict) is reported as a failure, not as "X35"', async () => {
  const store = {
    load: async () => null,
    save: async (section, doc) => { if (section === 'profiles') { const e = new Error('conflict'); e.status = 409; throw e; } return doc; },
  };
  const server = fakeServer({ head: { x: 200, y: 235, z: 20 } });
  const state = createState({ store });
  await state.load();
  const capture = createCalibrationCapture({ state, positionSource: server.source, monitor: { refresh: async () => {} } });
  const r = await capture.captureBedFromOffsetCorner('ur');
  assert.equal(r.ok, false);
  assert.match(r.message, /друго/);
  assert.equal(state.get('profile').bedX0, null, 'the collection was reread after the conflict');
});
