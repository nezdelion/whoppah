import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readiness } from '../src/core/readiness.js';
import { bedFromPenOffset } from '../src/core/bed.js';
import { defaultsOf, PROFILE_SCHEMA, CALIBRATION_SCHEMA } from '../src/core/profile.js';
import './helpers/ru.js';

const profile = () => ({ ...defaultsOf(PROFILE_SCHEMA), limX0: -4, limX1: 234, limY0: 1, limY1: 231 });
const withArea = () => ({ ...profile(), ...bedFromPenOffset({ x: 35, y: 0 }, { w: 235, h: 235 }).changes });
const cal = (extra = {}) => ({ ...defaultsOf(CALIBRATION_SCHEMA), updatedAt: '2026-10-02T00:00:00Z', ...extra });
const states = (r) => Object.fromEntries(r.items.map((i) => [i.id, i.state]));

test('readiness: nothing set — area and calibration todo; connection only when known', () => {
  const r = readiness({ profile: profile(), calibration: defaultsOf(CALIBRATION_SCHEMA) });
  assert.deepEqual(states(r), { area: 'todo', corner: 'todo', touch: 'todo' });
  assert.equal(r.ready, false);
  const s = readiness({ profile: profile(), calibration: defaultsOf(CALIBRATION_SCHEMA), connected: false });
  assert.equal(states(s).connection, 'todo');
});

test('readiness: fresh parts are ok, a stale corner is stale, without a monitor — unknown', () => {
  const ok = readiness({ profile: withArea(), calibration: cal(), fresh: { xy: true, z: true }, connected: true });
  assert.deepEqual(states(ok), { connection: 'ok', area: 'ok', corner: 'ok', touch: 'ok' });
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.items.find((i) => i.id === 'area').value.w, 204);
  const stale = readiness({ profile: withArea(), calibration: cal(), fresh: { xy: false, z: true } });
  assert.deepEqual(states(stale), { area: 'ok', corner: 'stale', touch: 'ok' });
  assert.equal(stale.ready, false);
  const unknown = readiness({ profile: withArea(), calibration: cal() });
  assert.deepEqual(states(unknown), { area: 'ok', corner: 'unknown', touch: 'unknown' });
});

test('readiness: an empty pen area is reported as stale (needs attention)', () => {
  const p = { ...profile(), ...bedFromPenOffset({ x: 300, y: 0 }, { w: 235, h: 235 }).changes };
  assert.equal(states(readiness({ profile: p, calibration: cal() })).area, 'stale');
});
