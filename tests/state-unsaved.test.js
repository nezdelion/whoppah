import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';

const calDoc = (x, over = {}) => ({ cornerX: x, cornerY: 0, zTouch: 8, epochXY: 1, epochZ: 1, ...over });

test('adoptCalibration during a write: after a successful write the edits from another tab are accepted', async () => {
  const store = new MemoryStore();
  const state = createState({ store });
  await state.load();
  let release; const gate = new Promise((r) => { release = r; });
  const origSave = store.save.bind(store);
  store.save = async (...a) => { await gate; return origSave(...a); };
  const p = state.patch('calibration', { cornerX: 50 });
  state.adoptCalibration(calDoc(50), { merge: true }); // recreates the section object while the write is in progress
  release(); await p;
  state.adoptCalibration(calDoc(70), { merge: true });
  assert.equal(state.get('calibration').cornerX, 70, 'server value accepted, unsaved flag cleared');
  assert.equal(state.get('calibration').epochXY, 1);
});

test('a failed write: local stays; the next successful one clears the flag', async () => {
  const store = new MemoryStore();
  const state = createState({ store });
  await state.load();
  const origSave = store.save.bind(store);
  store.save = async () => { throw new Error('нет'); };
  await state.patch('calibration', { cornerX: 50 });
  state.adoptCalibration(calDoc(70), { merge: true });
  assert.equal(state.get('calibration').cornerX, 50);
  assert.equal(state.get('calibration').epochXY, null);
  store.save = origSave;
  await state.patch('calibration', { cornerY: 3 });
  state.adoptCalibration(calDoc(70, { cornerY: 3 }), { merge: true });
  assert.equal(state.get('calibration').cornerX, 70);
});
