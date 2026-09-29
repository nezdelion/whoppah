import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_SCHEMA, CALIBRATION_SCHEMA, JOB_SCHEMA, defaultsOf, validate, normalize, absoluteZ, normalizeJob } from '../src/core/profile.js';
import { resolveField } from '../src/core/layout.js';
import legacy from './tools/legacy-core.cjs';

test('absolute Z and the corner from the defaults match the old DEFAULTS', () => {
  const p = defaultsOf(PROFILE_SCHEMA), c = defaultsOf(CALIBRATION_SCHEMA), j = defaultsOf(JOB_SCHEMA);
  const z = absoluteZ(p, c);
  const D = legacy.DEFAULTS;
  assert.deepEqual([z.down, z.up, z.start, z.end], [D.zDown, D.zUp, D.zStart, D.zEnd]);
  assert.deepEqual([c.cornerX, c.cornerY], [D.cornerX, D.cornerY]);
  for (const k of ['fDraw', 'fTravel', 'fZUp', 'fZDown', 'home', 'motorsOff', 'limX0', 'limX1', 'limY0', 'limY1']) assert.equal(p[k], D[k], k);
  assert.deepEqual(resolveField(j), { w: D.fieldW, h: D.fieldH });
  assert.equal(j.marginMm, D.margin);
  assert.equal(j.mergeTolMm, D.mergeTol);
  assert.equal(p.penWidthMm, 0.5);
  assert.equal(j.simplifyTolMm, 0.05);
});

test('touch Z9.0 shifts the pen heights', () => {
  const z = absoluteZ(defaultsOf(PROFILE_SCHEMA), { ...defaultsOf(CALIBRATION_SCHEMA), zTouch: 9 });
  assert.equal(z.down, 8.3);
  assert.equal(z.up, 11);
});

test('validation: ranges, types, enums', () => {
  assert.deepEqual(validate(PROFILE_SCHEMA, defaultsOf(PROFILE_SCHEMA)), []);
  const bad = validate(PROFILE_SCHEMA, { ...defaultsOf(PROFILE_SCHEMA), fDraw: 0, home: 'yes' });
  assert.deepEqual(bad.map((e) => e.key).sort(), ['fDraw', 'home']);
  assert.equal(validate(JOB_SCHEMA, { ...defaultsOf(JOB_SCHEMA), halign: 'up' }).length, 1);
});

test('normalize: invalid fields are replaced by defaults, unknown ones dropped', () => {
  const j = normalizeJob({ marginMm: -3, halign: 'left', junk: 1 });
  assert.equal(j.marginMm, 5);
  assert.equal(j.halign, 'left');
  assert.equal('junk' in j, false);
  assert.equal(normalize(CALIBRATION_SCHEMA, { updatedAt: '2026-01-01' }).updatedAt, '2026-01-01');
});

test('defaults do not share mutable state', () => {
  const a = defaultsOf(JOB_SCHEMA);
  a.customFormats.push({ id: 'x', name: 'x', w: 1, h: 1 });
  assert.equal(defaultsOf(JOB_SCHEMA).customFormats.length, 1);
});
