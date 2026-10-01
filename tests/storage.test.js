import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageStore, MemoryStore, migrateLegacy, LEGACY_KEY, convertLegacySettings } from '../src/storage/settings-store.js';
import { serializeSettings, parseSettings, applySettings, SettingsFileError } from '../src/storage/settings-file.js';
import { createState } from '../src/app/state.js';
import { importSvg } from '../src/core/svg-import.js';
import { buildPlan, fieldOf } from '../src/core/pipeline.js';
import { normalizeProfile, normalizeJob } from '../src/core/profile.js';
import { MemStorage } from './helpers/mem-storage.js';
import { loadTree } from './helpers/fixtures.js';
import legacy from './tools/legacy-core.cjs';
import './helpers/ru.js';

const OLD = { fieldW: 150, fieldH: 100, margin: 7, halign: 'left', valign: 'bottom', rotate: true, cornerX: -3, cornerY: 48,
  zDown: 7.1, zUp: 10.5, zStart: 16, zEnd: 24, fDraw: 2500, fTravel: 7000, fZUp: 1000, fZDown: 500,
  home: false, motorsOff: false, mergeTol: 0.1, limX0: -5, limX1: 230, limY0: 0, limY1: 230,
  opUrl: 'http://pi.local', opKey: 'SECRET', opName: 'x.gcode' };

test('LocalStorageStore: save and load, absence and corruption', async () => {
  const st = new MemStorage();
  const store = new LocalStorageStore(st);
  assert.equal(await store.load('job'), null);
  await store.save('job', { a: 1 });
  assert.deepEqual(await store.load('job'), { a: 1 });
  st.setItem('neptune-plotter.v2.bad', '{oops');
  assert.equal(await store.load('bad'), null);
});

test('migration: the old key is removed, sections are created, the connection key is carried over', async () => {
  const st = new MemStorage({ [LEGACY_KEY]: JSON.stringify(OLD) });
  const store = new LocalStorageStore(st);
  assert.equal(await migrateLegacy(st, store), true);
  assert.equal(st.getItem(LEGACY_KEY), null);
  const cal = await store.load('calibration');
  assert.deepEqual([cal.cornerX, cal.cornerY, cal.zTouch], [-3, 48, 8]);
  const profile = await store.load('profile');
  assert.equal(profile.zDownOffset, -0.9);
  assert.equal((await store.load('connection')).key, 'SECRET');
  assert.equal(await migrateLegacy(st, store), false, 'second time does nothing');
});

test('migration does not overwrite new sections; a corrupted key is simply removed', async () => {
  const st = new MemStorage({ [LEGACY_KEY]: JSON.stringify(OLD) });
  const store = new LocalStorageStore(st);
  await store.save('calibration', { cornerX: 1, cornerY: 2, zTouch: 3 });
  await migrateLegacy(st, store);
  assert.equal((await store.load('calibration')).cornerX, 1);
  const st2 = new MemStorage({ [LEGACY_KEY]: '{broken' });
  await migrateLegacy(st2, new LocalStorageStore(st2));
  assert.equal(st2.getItem(LEGACY_KEY), null);
});

test('G-code before and after the migration matches', async () => {
  const st = new MemStorage({ [LEGACY_KEY]: JSON.stringify(OLD) });
  const store = new LocalStorageStore(st);
  await migrateLegacy(st, store);
  const state = createState({ store });
  await state.load();
  const tree = loadTree('user.svg');
  const settings = state.settings();
  const drawing = importSvg(tree, { fit: { fieldMm: fieldOf(settings.job), marginMm: settings.job.marginMm, rotate: settings.job.rotate } });
  const actual = buildPlan(drawing, settings).gcode;
  assert.equal(actual, legacy.plan(tree, OLD).gcode);
});

test('migration keeps Work area and adds a custom format; a matching size is not duplicated', () => {
  const a = convertLegacySettings({ fieldW: 150, fieldH: 100 }).job;
  assert.deepEqual(a.customFormats.map((f) => f.id), ['work', 'migrated']);
  assert.equal(a.paperId, 'migrated');
  const b = convertLegacySettings({ fieldW: 180, fieldH: 180 }).job;
  assert.deepEqual(b.customFormats.map((f) => f.id), ['work']);
  assert.equal(b.paperId, 'work');
});

test('convertLegacySettings: a square format — portrait, a wide one — landscape', () => {
  assert.equal(convertLegacySettings({ fieldW: 100, fieldH: 200 }).job.orientation, 'portrait');
  assert.equal(convertLegacySettings({ fieldW: 200, fieldH: 100 }).job.orientation, 'landscape');
});

const sections = () => ({ profile: normalizeProfile({ fDraw: 1234 }), calibration: { cornerX: -1, cornerY: 2, zTouch: 3, updatedAt: null }, job: normalizeJob({ marginMm: 9 }), presets: { photo: { style: 'x' } } });

test('settings file: round-trip export → import', async () => {
  const src = sections();
  const parsed = parseSettings(serializeSettings(src));
  const target = new MemoryStore();
  await applySettings(target, parsed);
  for (const k of Object.keys(src)) assert.deepEqual(await target.load(k), src[k]);
  assert.equal(JSON.parse(serializeSettings(src)).version, 1);
});

test('section choice on import', async () => {
  const parsed = parseSettings(serializeSettings(sections()));
  const target = new MemoryStore();
  await applySettings(target, parsed, ['job']);
  assert.notEqual(await target.load('job'), null);
  assert.equal(await target.load('profile'), null);
});

test('a broken file: an error, the settings do not change', async () => {
  const target = new MemoryStore({ job: { marginMm: 1 } });
  const bad = ['', 'not json', '{}', '{"format":"other","version":1,"sections":{}}',
    '{"format":"neptune-plotter-settings","version":99,"sections":{"job":{}}}',
    '{"format":"neptune-plotter-settings","version":1,"sections":{"job":5}}',
    '{"format":"neptune-plotter-settings","version":1,"sections":{"x":{}}}'];
  for (const text of bad) {
    assert.throws(() => parseSettings(text), SettingsFileError, text);
  }
  assert.deepEqual(await target.load('job'), { marginMm: 1 });
});
