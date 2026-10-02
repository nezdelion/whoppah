import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROFILE_SCHEMA, CALIBRATION_SCHEMA, JOB_SCHEMA, defaultsOf, validate, normalize, absoluteZ, normalizeJob, normalizeProfile, validateProfile, bedErrors } from '../src/core/profile.js';
import { resolveField } from '../src/core/layout.js';
import legacy from './tools/legacy-core.cjs';
import './helpers/ru.js';

test('absolute Z and the corner from the defaults match the old DEFAULTS', () => {
  const p = defaultsOf(PROFILE_SCHEMA), c = defaultsOf(CALIBRATION_SCHEMA), j = defaultsOf(JOB_SCHEMA);
  const z = absoluteZ(p, c);
  const D = legacy.DEFAULTS;
  assert.deepEqual([z.down, z.up, z.start, z.end], [D.zDown, D.zUp, D.zStart, D.zEnd]);
  assert.deepEqual([c.cornerX, c.cornerY], [D.cornerX, D.cornerY]);
  for (const k of ['fDraw', 'fTravel', 'fZUp', 'fZDown', 'home', 'motorsOff']) assert.equal(p[k], D[k], k);
  // limits per the Neptune 3 Pro M211 (X-5…235, Y0…232) with a 1 mm margin, not from the old app
  assert.deepEqual([p.limX0, p.limX1, p.limY0, p.limY1], [-4, 234, 1, 231]);
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

test('bed fields: not measured by default, nominal 235×235, hidden from the form; the job option is on by default', () => {
  const p = defaultsOf(PROFILE_SCHEMA);
  assert.deepEqual([p.bedX0, p.bedY0, p.bedX1, p.bedY1, p.bedUrNominal, p.bedW, p.bedH], [null, null, null, null, false, 235, 235]);
  for (const k of ['bedX0', 'bedY0', 'bedX1', 'bedY1', 'bedUrNominal']) assert.equal(PROFILE_SCHEMA.find((f) => f.key === k).hidden, true, k);
  assert.equal(defaultsOf(JOB_SCHEMA).fitPrintArea, true);
  const opt = JOB_SCHEMA.find((f) => f.key === 'fitPrintArea');
  assert.equal(opt.groupId, 'align');
  assert.match(opt.warn, /выйти за стол/);
  assert.deepEqual(validateProfile(p), []);
  const c = defaultsOf(CALIBRATION_SCHEMA);
  assert.deepEqual([c.profileXY, c.profileZ], [null, null]);
});

test('a partial or degenerate bed is rejected by the check and dropped by normalize', () => {
  const p = defaultsOf(PROFILE_SCHEMA);
  assert.deepEqual(validateProfile({ ...p, bedX0: -12, bedY0: -3 }).map((e) => e.key), ['bed']);
  assert.match(bedErrors({ ...p, bedX0: 100, bedY0: 0, bedX1: 50, bedY1: 10 })[0].message, /правее и выше/);
  assert.deepEqual(validateProfile({ ...p, bedX0: -12, bedY0: -3, bedX1: 221, bedY1: 230 }), []);
  const n = normalizeProfile({ ...p, bedX0: -12, bedY0: -3, bedUrNominal: true });
  assert.deepEqual([n.bedX0, n.bedY0, n.bedX1, n.bedY1, n.bedUrNominal], [null, null, null, null, false]);
  assert.equal(normalizeProfile({ ...p, bedX0: -12, bedY0: -3, bedX1: 221, bedY1: 230 }).bedX1, 221);
});

test('normalize of an old profile without bed fields: the bed is not measured, the values are kept', () => {
  const n = normalizeProfile({ fDraw: 2500, limX1: 230 });
  assert.equal(n.fDraw, 2500);
  assert.equal(n.limX1, 230);
  assert.equal(n.bedX0, null);
  assert.equal(n.bedW, 235);
});
