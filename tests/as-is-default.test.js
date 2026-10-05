import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createDrawing } from '../src/core/drawing.js';
import { followAsIsDefault } from '../src/app/as-is-default.js';

const setup = async () => {
  const state = createState({ store: new MemoryStore({}), now: () => 'NOW' });
  await state.load();
  followAsIsDefault(state);
  const send = (source) => state.setDrawing(createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 1, 1]] }], meta: { unitMm: 1 } }), '', source);
  return { state, send, asIs: () => state.get('job').asIs };
};

test('a text drawing switches "As is in mm" on; the next SVG drawing puts back the previous value', async () => {
  const { send, asIs } = await setup();
  assert.equal(asIs(), false);
  send('text');
  assert.equal(asIs(), true);
  send('svg');
  assert.equal(asIs(), false);
});

test('the user can switch it off for text (to scale it): the choice is kept, also for the next drawings', async () => {
  const { state, send, asIs } = await setup();
  send('text');
  state.patch('job', { asIs: false });
  send('text'); // a new text: switched on again by default
  assert.equal(asIs(), true);
  state.patch('job', { asIs: false });
  send('svg');
  assert.equal(asIs(), false, 'nothing to restore after a user change');
});

test('already on before the text: stays on for the next drawing (nothing was switched by the text)', async () => {
  const { state, send, asIs } = await setup();
  state.patch('job', { asIs: true });
  send('text');
  send('photo');
  assert.equal(asIs(), true);
});

test('a user change while text is active means the SVG keeps the user choice', async () => {
  const { state, send, asIs } = await setup();
  send('text');
  state.patch('job', { asIs: true }); // user touched the option (even to the same value)
  send('svg');
  assert.equal(asIs(), true);
});
