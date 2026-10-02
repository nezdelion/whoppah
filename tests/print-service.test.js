import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrintService, classifyState } from '../src/app/print/print-service.js';
import { limitsCheck, partialCheck } from '../src/app/print/checks.js';
import { createDrawing } from '../src/core/drawing.js';
import { defaultsOf, PROFILE_SCHEMA, CALIBRATION_SCHEMA, JOB_SCHEMA } from '../src/core/profile.js';
import { TransportError } from '../src/transport/transport.js';
import './helpers/ru.js';

const settings = () => ({ profile: defaultsOf(PROFILE_SCHEMA), calibration: defaultsOf(CALIBRATION_SCHEMA), job: defaultsOf(JOB_SCHEMA) });
const doc = (meta, lines = [[0, 0, 100, 100]]) => createDrawing({ layers: [{ id: 'l', name: 'l', lines }], meta });

// Stub transport: job() returns states in turn (the last repeats).
function fakeTransport(states = ['Operational'], { failOn } = {}) {
  const calls = [];
  let i = 0;
  const rec = (name) => async (...args) => {
    calls.push([name, ...args]);
    if (failOn === name) throw new TransportError('сбой ' + name, { kind: 'http', operation: name, status: 500 });
  };
  return {
    calls,
    configured: () => true,
    upload: rec('upload'), pause: rec('pause'), cancel: rec('cancel'), command: rec('command'),
    async job() { calls.push(['job']); return { state: states[Math.min(i++, states.length - 1)] }; },
  };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

function service(transport, { answer = true, preflight = [], ...rest } = {}) {
  const asked = [];
  const svc = createPrintService({
    transport, getSettings: settings, preflight, ...clock(), ...rest,
    confirm: async (m) => { asked.push(m); return typeof answer === 'function' ? answer(m) : answer; },
  });
  return { svc, asked };
}

const names = (t) => t.calls.map((c) => c[0]);

test('upload without starting goes without confirmation', async () => {
  const t = fakeTransport();
  const { svc, asked } = service(t);
  const r = await svc.send(doc({}), { print: false, name: 'a.gcode' });
  assert.equal(r.ok, true);
  assert.equal(asked.length, 0);
  assert.deepEqual(t.calls[0].slice(0, 1), ['upload']);
  assert.deepEqual(t.calls[0][3], { select: true, print: false });
  assert.match(t.calls[0][2], /^G21\n/);
});

test('starting requires confirmation; on refusal the transport is not called', async () => {
  const t = fakeTransport();
  const { svc, asked } = service(t, { answer: false });
  const r = await svc.send(doc({}), { print: true });
  assert.equal(r.ok, false);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /Бумага в углу X-5 Y50/);
  assert.deepEqual(t.calls, []);
});

test('a confirmed start: upload with print=true', async () => {
  const t = fakeTransport();
  const { svc } = service(t);
  await svc.send(doc({}), { print: true, name: 'b.gcode' });
  assert.deepEqual(t.calls[0][3], { select: true, print: true });
});

test('an intermediate drawing requires confirmation with the reasons', async () => {
  const { svc, asked } = service(fakeTransport(), { preflight: [limitsCheck, partialCheck], answer: false });
  const drawing = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 100, 100]] }], meta: { partial: { reasons: ['идёт расчёт'] } } });
  await svc.send(drawing, { print: false });
  assert.match(asked[0], /промежуточный: идёт расчёт/);
});

test('both remarks are shown together: out of limits and intermediate', async () => {
  const t = fakeTransport();
  const s = { ...settings() };
  s.calibration = { ...s.calibration, cornerX: 100 };
  s.job = { ...s.job, fitPrintArea: false }; // with the option on the drawing would be fitted into the print area
  const asked = [];
  const svc = createPrintService({ transport: t, getSettings: () => s, preflight: [limitsCheck, partialCheck], confirm: async (m) => { asked.push(m); return false; }, ...clock() });
  await svc.send(createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 5, 5]] }], meta: { partial: { reasons: ['r1'] } } }), { print: false });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /выход за X/);
  assert.match(asked[0], /промежуточный: r1/);
  assert.deepEqual(t.calls, []);
});

test('a block check forbids sending without a question', async () => {
  const t = fakeTransport();
  const { svc, asked } = service(t, { preflight: [async () => ({ level: 'block', message: 'калибровка устарела' })] });
  const r = await svc.send(doc({}), { print: true });
  assert.deepEqual([r.ok, r.message], [false, 'калибровка устарела']);
  assert.equal(asked.length, 0);
  assert.deepEqual(t.calls, []);
});

test('a new check is added without editing the service', async () => {
  const t = fakeTransport();
  const custom = async () => ({ level: 'confirm', message: 'КАСТОМ' });
  const { svc, asked } = service(t, { preflight: [custom] });
  await svc.send(doc({}), { print: false });
  assert.match(asked[0], /КАСТОМ/);
  assert.equal(names(t)[0], 'upload');
});

test('empty drawing: a message, the transport is not called', async () => {
  const t = fakeTransport();
  const { svc } = service(t);
  const r = await svc.send(createDrawing({ layers: [] }), { print: false });
  assert.deepEqual([r.ok, r.message], [false, 'нечего рисовать']);
  assert.deepEqual(t.calls, []);
});

test('a transport error becomes a message', async () => {
  const { svc } = service(fakeTransport(['Operational'], { failOn: 'upload' }));
  const r = await svc.send(doc({}), { print: false });
  assert.deepEqual([r.ok, r.message], [false, 'сбой upload']);
});

// --- cancel

test('cancel: Cancelling → Operational → recheck → lift', async () => {
  const t = fakeTransport(['Cancelling', 'Cancelling', 'Operational', 'Operational']);
  const { svc } = service(t);
  const r = await svc.cancel();
  assert.equal(r.ok, true);
  assert.deepEqual(names(t), ['cancel', 'job', 'job', 'job', 'job', 'command']);
  assert.deepEqual(t.calls.at(-1), ['command', ['G90', 'G0 Z15 F1200']]);
  assert.match(r.message, /перо поднято на Z15/);
});

test('cancel hung: 30 seconds of Cancelling — cancel did not finish, no lift', async () => {
  const t = fakeTransport(['Cancelling']);
  const { svc } = service(t);
  const r = await svc.cancel();
  assert.equal(r.ok, false);
  assert.match(r.message, /отмена не завершилась/);
  assert.ok(!names(t).includes('command'));
  assert.ok(t.calls.filter((c) => c[0] === 'job').length <= 32);
});

for (const [state, expected] of [
  ['Error', /принтер: ошибка — перо не поднято/],
  ['Offline after error', /принтер: ошибка — перо не поднято/],
  ['Offline', /принтер: отключён — перо не поднято/],
  ['Closed', /принтер: отключён — перо не поднято/],
  ['Unknown', /принтер: состояние «Unknown» — перо не поднято/],
  ['Printing', /началось другое задание — перо не поднято/],
  ['Printing from SD', /началось другое задание/],
  ['Paused', /началось другое задание — перо не поднято/],
  ['Pausing', /началось другое задание/],
  ['Resuming', /началось другое задание/],
  ['Starting', /началось другое задание/],
]) {
  test(`cancel: between polls the state is ${state} — no lift`, async () => {
    const t = fakeTransport(['Cancelling', state]);
    const { svc } = service(t);
    const r = await svc.cancel();
    assert.equal(r.ok, false);
    assert.match(r.message, expected);
    assert.ok(!names(t).includes('command'));
    assert.equal(t.calls.filter((c) => c[0] === 'upload').length, 0, 'nothing sent into the new job');
  });
}

test('a job started right before sending: the poll says ready, the recheck says Printing', async () => {
  const t = fakeTransport(['Operational', 'Printing']);
  const { svc } = service(t);
  const r = await svc.cancel();
  assert.equal(r.ok, false);
  assert.match(r.message, /началось другое задание/);
  assert.ok(!names(t).includes('command'));
});

test('recheck: a printer error also stops', async () => {
  const t = fakeTransport(['Operational', 'Error']);
  const { svc } = service(t);
  const r = await svc.cancel();
  assert.match(r.message, /ошибка/);
  assert.ok(!names(t).includes('command'));
});

test('state classification', () => {
  assert.equal(classifyState('Operational'), 'ready');
  assert.equal(classifyState('Cancelling'), 'wait');
  assert.equal(classifyState('Printing'), 'other-job');
  assert.equal(classifyState('Closed with error'), 'stop');
  assert.equal(classifyState(undefined), 'stop');
});

// --- manual commands, pause, outline

test('manual commands are built from the profile and calibration', async () => {
  const t = fakeTransport();
  const { svc } = service(t);
  await svc.manual('up'); await svc.manual('corner'); await svc.manual('touch'); await svc.manual('motorsOff');
  assert.deepEqual(t.calls.map((c) => c[1]), [
    ['G90', 'G0 Z15 F1200'],
    ['G90', 'G0 Z15 F1200', 'G0 X-5 Y50 F6000'],
    ['G90', 'G0 Z8 F600'],
    ['M84']]);
});

test('Home — G28 only after a confirmation with a pen warning', async () => {
  const t = fakeTransport();
  const no = service(t, { answer: false });
  await no.svc.manual('home');
  assert.deepEqual(t.calls, []);
  assert.match(no.asked[0], /перо ниже сопла/);
  const yes = service(t, { answer: true });
  await yes.svc.manual('home');
  assert.deepEqual(t.calls, [['command', ['G28']]]);
});

test('pause and resume', async () => {
  const t = fakeTransport();
  const { svc } = service(t);
  await svc.pause(true); await svc.pause(false);
  assert.deepEqual(t.calls, [['pause', true], ['pause', false]]);
});

test('trace the outline: only Z commands no lower than touch + clearance, printing does not start', async () => {
  const t = fakeTransport();
  const { svc } = service(t);
  const r = await svc.frame(doc({}));
  assert.equal(r.ok, true);
  assert.deepEqual(names(t), ['command']);
  const lines = t.calls[0][1];
  const zs = lines.flatMap((l) => [...l.matchAll(/Z([\d.]+)/g)].map((m) => +m[1]));
  assert.ok(Math.min(...zs) >= 9);
});

test('the pen beyond the bed with the option off: the confirmation names the side and mm; refused — nothing sent', async () => {
  const t = fakeTransport();
  const s = settings();
  s.profile = { ...s.profile, bedX0: -12, bedY0: -3, bedX1: 165, bedY1: 230 };
  s.job = { ...s.job, fitPrintArea: false };
  const asked = [];
  const svc = createPrintService({ transport: t, getSettings: () => s, preflight: [limitsCheck, partialCheck], confirm: async (m) => { asked.push(m); return false; }, ...clock() });
  await svc.send(createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 100, 100]] }], meta: { partial: { reasons: ['r1'] } } }), { print: false });
  assert.equal(asked.length, 1);
  assert.match(asked[0], /перо за краем стола справа на 5,0 мм/);
  assert.match(asked[0], /промежуточный: r1/);
  assert.deepEqual(t.calls, []);
});

test('limitsCheck: confirm level, the bed note when the bed is not measured', async () => {
  assert.deepEqual(await limitsCheck({ plan: { outOfLimits: null, outOfBed: null, bedChecked: false } }), { level: 'ok', message: '' });
  const r = await limitsCheck({ plan: { outOfLimits: { x: 12, y: 0 }, outOfBed: null, bedChecked: false } });
  assert.equal(r.level, 'confirm');
  assert.match(r.message, /выход за X на 12,0 мм/);
  assert.match(r.message, /Стол не измерен: проверка пера на столе пропущена/);
  const both = await limitsCheck({ plan: { outOfLimits: { x: 6, y: 0 }, outOfBed: { left: 0, right: 19, bottom: 0, top: 0 }, bedChecked: true } });
  assert.match(both.message, /выход за X на 6,0 мм, перо за краем стола справа на 19,0 мм/);
  assert.doesNotMatch(both.message, /не измерен/);
});
