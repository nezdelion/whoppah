import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createSourceContext } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createDrawing } from '../src/core/drawing.js';

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
