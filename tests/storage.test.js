import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorageStore, MemoryStore, migrateLegacy, migrateProfiles, LEGACY_KEY, convertLegacySettings } from '../src/storage/settings-store.js';
import { serializeSettings, parseSettings, applySettings, SettingsFileError } from '../src/storage/settings-file.js';
import { createState } from '../src/app/state.js';
import { importSvg } from '../src/core/svg-import.js';
import { buildPlan, fieldOf } from '../src/core/pipeline.js';
import { normalizeJob } from '../src/core/profile.js';
import { fromLegacy } from '../src/core/profiles.js';
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
  st.setItem('whoppah.v2.bad', '{oops');
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

const sections = () => ({ profiles: fromLegacy({ fDraw: 1234 }, { now: 'T', id: 'p_0000abcd' }), calibration: { cornerX: -1, cornerY: 2, zTouch: 3, updatedAt: null }, job: normalizeJob({ marginMm: 9 }), presets: { photo: { style: 'x' } } });

test('settings file: round-trip export → import', async () => {
  const src = sections();
  const parsed = parseSettings(serializeSettings(src));
  const target = new MemoryStore();
  await applySettings(target, parsed);
  for (const k of Object.keys(src)) assert.deepEqual(await target.load(k), src[k]);
  assert.equal(JSON.parse(serializeSettings(src)).version, 2);
});

test('section choice on import', async () => {
  const parsed = parseSettings(serializeSettings(sections()));
  const target = new MemoryStore();
  await applySettings(target, parsed, ['job']);
  assert.notEqual(await target.load('job'), null);
  assert.equal(await target.load('profiles'), null);
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

// --- settings file version 2 and the profiles migration (standalone)

test('a version 1 file is rejected with its own message, the settings do not change', async () => {
  const target = new MemoryStore({ job: { marginMm: 1 } });
  const v1 = JSON.stringify({ format: 'neptune-plotter-settings', version: 1, sections: { profile: { fDraw: 1 }, job: { marginMm: 9 } } });
  assert.throws(() => parseSettings(v1), (e) => e instanceof SettingsFileError && e.message === 'старый формат файла настроек не поддерживается');
  assert.deepEqual(await target.load('job'), { marginMm: 1 });
});

test('a version 2 file: profiles with the active one round-trip; a broken collection is rejected', async () => {
  const col = fromLegacy({ fDraw: 2500 }, { now: 'T', id: 'p_00000001' });
  col.items.push({ ...col.items[0], id: 'p_00000002', name: 'Б' });
  col.activeId = 'p_00000002';
  const parsed = parseSettings(serializeSettings({ profiles: col }));
  const target = new MemoryStore();
  await applySettings(target, parsed);
  const state = createState({ store: target });
  await state.load();
  assert.equal(state.activeProfileId(), 'p_00000002');
  assert.equal(state.get('profile').fDraw, 2500);
  const file = (profiles) => JSON.stringify({ format: 'neptune-plotter-settings', version: 2, sections: { profiles } });
  for (const bad of [{ items: [] }, { activeId: 'x', items: [{ id: 'p_00000001', name: 'a', values: {} }] }, { activeId: 'p_00000001', items: [{ id: 'p_00000001', name: '', values: {} }] }]) {
    assert.throws(() => parseSettings(file(bad)), /повреждён/);
  }
});

test('profiles migration: a profile with fDraw 2500 becomes the active "Neptune 3 Pro", the bed not measured; the old key stays', async () => {
  const store = new MemoryStore({ profile: { fDraw: 2500 }, calibration: { cornerX: -3, cornerY: 48, zTouch: 8, epochXY: 1, epochZ: 1 } });
  assert.equal(await migrateProfiles(store, (v) => fromLegacy(v, { now: 'T' })), true);
  const col = await store.load('profiles');
  assert.equal(col.items.length, 1);
  assert.equal(col.items[0].name, 'Neptune 3 Pro');
  assert.equal(col.activeId, col.items[0].id);
  assert.equal(col.items[0].values.fDraw, 2500);
  assert.equal(col.items[0].values.bedX0, null);
  assert.deepEqual(await store.load('profile'), { fDraw: 2500 });
  const cal = await store.load('calibration');
  assert.deepEqual([cal.profileXY, cal.profileZ], [col.activeId, col.activeId], 'the calibration belongs to the created profile');
  const state = createState({ store });
  await state.load();
  assert.equal(state.get('profile').fDraw, 2500);
  await state.patch('profile', { fDraw: 2600 });
  assert.equal(await migrateProfiles(store, (v) => fromLegacy(v, { now: 'T' })), false, 'a second run does nothing');
  const again = createState({ store });
  await again.load();
  assert.equal(again.profiles().items.length, 1);
  assert.equal(again.get('profile').fDraw, 2600, 'the change after the migration is kept');
});

test('profiles migration on an empty storage: one "Neptune 3 Pro" with defaults', async () => {
  const store = new MemoryStore();
  await migrateProfiles(store, (v) => fromLegacy(v, { now: 'T' }));
  const state = createState({ store });
  await state.load();
  assert.deepEqual(state.profiles().items.map((p) => p.name), ['Neptune 3 Pro']);
  assert.equal(state.get('profile').fDraw, 3000);
  assert.equal(await store.load('calibration'), null);
});
