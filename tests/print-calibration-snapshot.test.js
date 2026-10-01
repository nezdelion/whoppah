import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { setupCalibration } from '../src/app/calibration/setup.js';
import { createPrintService } from '../src/app/print/print-service.js';
import { createDrawing } from '../src/core/drawing.js';
import { buildPlan } from '../src/core/pipeline.js';
import { fakeServer, fakeVisibility } from './helpers/fake-position.js';
import './helpers/ru.js';

test('printing: the calibration is refreshed BEFORE building the plan — G-code and the check see one snapshot', async () => {
  const server = fakeServer({ calibration: { cornerX: 0, cornerY: 0, zTouch: 8, epochXY: 0, epochZ: 0 } });
  const state = createState({ store: new MemoryStore() });
  await state.load();
  state.adoptCalibration(server.calibration);
  const cal = setupCalibration({
    positionSource: server.source, state, store: { load: async () => structuredClone(server.calibration) }, visibility: fakeVisibility(false),
  });
  const uploads = [];
  const svc = createPrintService({
    transport: { upload: async (name, gcode) => { uploads.push(gcode); } },
    getSettings: () => state.settings(), confirm: async () => true,
    preflight: [cal.check], beforePlan: [cal.beforePlan],
  });
  const drawing = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 10, 10]] }], meta: {} });
  // another tab shifted the corner, the coordinate epoch is the same
  server.calibration = { ...server.calibration, cornerX: 40 };
  const r = await svc.send(drawing, { print: false });
  assert.equal(r.ok, true);
  assert.equal(state.get('calibration').cornerX, 40);
  assert.equal(uploads[0], buildPlan(drawing, state.settings()).gcode, 'G-code built from the fresh cornerX=40');
  assert.equal(cal.calibrator.monitor.status().stale.length, 0);
});

test('printing: the coordinates changed between the snapshot and the check — sending is blocked', async () => {
  const server = fakeServer({ calibration: { cornerX: 0, cornerY: 0, zTouch: 8, epochXY: 0, epochZ: 0 } });
  const state = createState({ store: new MemoryStore() });
  await state.load();
  state.adoptCalibration(server.calibration);
  const cal = setupCalibration({
    positionSource: server.source, state, store: { load: async () => structuredClone(server.calibration) }, visibility: fakeVisibility(false),
  });
  const uploads = [];
  const svc = createPrintService({
    transport: { upload: async (name, gcode) => { uploads.push(gcode); } },
    // the snapshot is taken, and now another tab shifts the corner before the check
    getSettings: () => { const s = state.settings(); server.calibration = { ...server.calibration, cornerX: 40 }; return s; },
    confirm: async () => true,
    preflight: [cal.check], beforePlan: [cal.beforePlan],
  });
  const drawing = createDrawing({ layers: [{ id: 'l', name: 'l', lines: [[0, 0, 10, 10]] }], meta: {} });
  const r = await svc.send(drawing, { print: false });
  assert.equal(r.ok, false);
  assert.equal(uploads.length, 0);
});
