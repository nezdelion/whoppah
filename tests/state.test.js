import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createSourceContext } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createDrawing } from '../src/core/drawing.js';
import './helpers/ru.js';

async function fresh(initial) {
  const store = new MemoryStore(initial);
  const state = createState({ store, now: () => 'NOW' });
  await state.load();
  return { store, state };
}

test('the printParams subscriber receives a change of field, margin, rotation and pen width', async () => {
  const { state, store } = await fresh();
  const ctx = createSourceContext({ state, store, sourceId: 'svg' });
  const got = [];
  const off = ctx.printParams.subscribe((p) => got.push(p));
  assert.deepEqual(ctx.printParams.get(), { fieldMm: { w: 180, h: 180 }, marginMm: 5, rotate: false, penWidthMm: 0.5 });
  await state.patch('job', { paperId: 'a5', orientation: 'landscape' });
  await state.patch('job', { marginMm: 10 });
  await state.patch('profile', { penWidthMm: 0.8 });
  await state.patch('job', { halign: 'left' });
  assert.equal(got.length, 3, 'a change not affecting source params is not broadcast');
  assert.deepEqual(got[0].fieldMm, { w: 210, h: 148 });
  assert.equal(got[1].marginMm, 10);
  assert.equal(got[2].penWidthMm, 0.8);
  off();
  await state.patch('job', { marginMm: 1 });
  assert.equal(got.length, 3);
});

test('presets of two sources are separate and survive a reload', async () => {
  const { state, store } = await fresh();
  const a = createSourceContext({ state, store, sourceId: 'a' });
  const b = createSourceContext({ state, store, sourceId: 'b' });
  assert.equal(await a.presets.load(), null);
  await a.presets.save({ v: 1 });
  await b.presets.save({ v: 2 });
  assert.deepEqual(await a.presets.load(), { v: 1 });
  assert.deepEqual(await b.presets.load(), { v: 2 });
  const a2 = createSourceContext({ state: (await fresh(store.data.size ? Object.fromEntries(store.data) : {})).state, store, sourceId: 'a' });
  assert.deepEqual(await a2.presets.load(), { v: 1 });
});

test('a source emits a drawing via emit; state stores it and the name', async () => {
  const { state, store } = await fresh();
  const events = [];
  state.subscribe((e) => events.push(e.type));
  const d = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 1, 1]] }], meta: { name: 'cat' } });
  createSourceContext({ state, store, sourceId: 'svg' }).emit(d);
  assert.equal(state.drawing(), d);
  assert.equal(state.sourceName(), 'cat');
  assert.deepEqual(events, ['drawing']);
});

test('the calibration gets a modification date; reset returns the defaults', async () => {
  const { state, store } = await fresh();
  await state.patch('calibration', { cornerX: -7 });
  assert.equal(state.get('calibration').updatedAt, 'NOW');
  assert.equal((await store.load('calibration')).cornerX, -7);
  await state.reset('calibration');
  assert.equal(state.get('calibration').cornerX, -5);
  assert.equal(state.get('calibration').updatedAt, null);
});

test('settings and custom formats persist after a reload', async () => {
  const { state, store } = await fresh();
  const formats = [...state.get('job').customFormats, { id: 'card', name: 'Открытка', w: 100, h: 150 }];
  await state.patch('job', { customFormats: formats, paperId: 'card' });
  await state.patch('profile', { zDownOffset: -1 });
  const again = createState({ store });
  await again.load();
  assert.equal(again.get('profile').zDownOffset, -1);
  assert.equal(again.get('job').customFormats.at(-1).name, 'Открытка');
  assert.deepEqual(again.printParams().fieldMm, { w: 100, h: 150 });
});

test('invalid values in a patch are replaced by defaults', async () => {
  const { state } = await fresh();
  await state.patch('profile', { fDraw: -5 });
  assert.equal(state.get('profile').fDraw, 3000);
});

// --- machine profiles

test('profiles: get(profile) is the active profile; switching recomputes, the job and calibration stay', async () => {
  const { state } = await fresh();
  await state.patch('job', { paperId: 'a5' });
  await state.patch('calibration', { cornerX: -5, cornerY: 50 });
  const b = await state.createProfile('Neptune + держатель Б');
  assert.equal(b.ok, true);
  assert.equal(state.profiles().items.length, 2);
  assert.notEqual(state.activeProfileId(), b.id, 'creating does not switch');
  await state.patch('profile', { fDraw: 2500 });
  const events = [];
  state.subscribe((e) => events.push(e.section));
  await state.selectProfile(b.id);
  assert.equal(state.activeProfileId(), b.id);
  assert.equal(state.get('profile').fDraw, 3000);
  assert.ok(events.includes('profile') && events.includes('profiles'));
  assert.equal(state.get('job').paperId, 'a5');
  assert.equal(state.get('calibration').cornerX, -5);
});

test('profiles: the active profile and the operations survive a reload', async () => {
  const { state, store } = await fresh();
  const b = await state.createProfile('Б');
  await state.selectProfile(b.id);
  await state.patch('profile', { penWidthMm: 0.3 });
  await state.renameProfile(b.id, 'В');
  const dup = await state.duplicateProfile(b.id);
  const again = createState({ store });
  await again.load();
  assert.equal(again.activeProfileId(), b.id);
  assert.equal(again.get('profile').penWidthMm, 0.3);
  assert.deepEqual(again.profiles().items.map((p) => p.name), ['Neptune 3 Pro', 'В', 'В (копия)']);
  assert.equal(again.profiles().items.find((p) => p.id === dup.id).values.penWidthMm, 0.3);
});

test('profiles: deleting the active one makes the neighbour active and says which; the last one stays', async () => {
  const { state } = await fresh();
  const first = state.activeProfileId();
  const b = await state.createProfile('Б');
  await state.selectProfile(b.id);
  const r = await state.removeProfile(b.id);
  assert.deepEqual([r.ok, r.message], [true, 'Активный профиль: Neptune 3 Pro']);
  assert.equal(state.activeProfileId(), first);
  const last = await state.removeProfile(first);
  assert.deepEqual(last, { ok: false, message: 'последний профиль удалить нельзя' });
  assert.equal(state.profiles().items.length, 1);
});

test('profiles: a repeated name is refused, nothing written', async () => {
  const { state } = await fresh();
  const r = await state.createProfile('neptune 3 PRO');
  assert.deepEqual(r, { ok: false, message: 'имя уже занято' });
  assert.equal(state.profiles().items.length, 1);
});

test('bed points: a partial bed never reaches the profile; the upper right needs the lower left', async () => {
  const { state } = await fresh();
  assert.deepEqual(await state.setBedPoint('ur', { x: 221, y: 230 }), { ok: false, message: 'сначала левый нижний угол стола' });
  assert.equal(state.get('profile').bedX0, null);
  assert.equal((await state.setBedPoint('ll', { x: -12, y: -3 })).ok, true);
  assert.deepEqual([state.get('profile').bedX1, state.get('profile').bedY1, state.get('profile').bedUrNominal], [223, 232, true]);
  const events = [];
  state.subscribe((e) => events.push(e));
  await state.patch('profile', { bedX1: null });
  assert.equal(state.get('profile').bedX1, 223, 'a partial bed is refused');
  assert.match(events.find((e) => e.type === 'save-error').message, /не целиком/);
});

test('profiles: the reset button resets the active profile only', async () => {
  const { state } = await fresh();
  await state.patch('profile', { fDraw: 2500 });
  const b = await state.createProfile('Б');
  await state.reset('profile');
  assert.equal(state.get('profile').fDraw, 3000);
  assert.equal(state.profiles().items.find((p) => p.id === b.id).values.fDraw, 3000);
});

test('a poll from another device: the collection is taken unless our own write is in flight', async () => {
  const { state } = await fresh();
  const b = await state.createProfile('Б');
  const remote = structuredClone(state.profiles());
  remote.activeId = b.id;
  state.adoptProfiles(remote);
  assert.equal(state.activeProfileId(), b.id);
  // an own write in flight: the poll does not overwrite it
  let release;
  const store = new MemoryStore();
  const slow = createState({ store });
  await slow.load();
  const save = store.save.bind(store);
  store.save = async (k, v, op) => { if (k === 'profiles') await new Promise((r) => { release = r; }); return save(k, v, op); };
  const p = slow.patch('profile', { fDraw: 2100 });
  await new Promise((r) => setImmediate(r));
  const stale = structuredClone(slow.profiles());
  stale.items[0].values.fDraw = 1000;
  slow.adoptProfiles(stale);
  assert.equal(slow.get('profile').fDraw, 2100);
  release();
  await p;
  assert.equal(slow.get('profile').fDraw, 2100);
});
