import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fromLegacy, createProfile, duplicateProfile, renameProfile, removeProfile, selectProfile, updateProfileValues,
  validateName, normalizeCollection, newProfileId, isProfileId, activeProfile, uniqueName, MAX_PROFILES,
} from '../src/core/profiles.js';
import './helpers/ru.js';

let n = 0;
const nextId = () => `p_${(++n).toString(16).padStart(8, '0')}`;
const base = () => fromLegacy({ fDraw: 2500 }, { now: 'T0', id: 'p_000000aa' });
const add = (col, name) => { const r = createProfile(col, { name, now: 'T1', id: nextId() }); assert.ok(r.ok, r.message); return r; };

test('fromLegacy: one active "Neptune 3 Pro" with the old values, the bed not measured', () => {
  const col = base();
  assert.equal(col.items.length, 1);
  assert.equal(col.activeId, 'p_000000aa');
  const p = activeProfile(col);
  assert.equal(p.name, 'Neptune 3 Pro');
  assert.equal(p.values.fDraw, 2500);
  assert.equal(p.values.bedX0, null);
  assert.equal(p.values.bedW, 235);
  assert.equal(fromLegacy(null).items[0].values.fDraw, 3000);
});

test('ids: p_ + 8 hex, independent of the name', () => {
  const id = newProfileId();
  assert.ok(isProfileId(id), id);
  assert.equal(isProfileId('Neptune'), false);
});

test('validateName: empty, longer than 64, taken without regard to case', () => {
  const items = base().items;
  assert.equal(validateName('   ', items), 'введите имя профиля');
  assert.match(validateName('x'.repeat(65), items), /длиннее 64/);
  assert.equal(validateName('x'.repeat(64), items), null);
  assert.equal(validateName('neptune 3 pro', items), 'имя уже занято');
  assert.equal(validateName('neptune 3 pro', items, 'p_000000aa'), null, 'its own name is not a repeat');
});

test('create: default values, the active profile does not change; at most 20', () => {
  const r = add(base(), 'Держатель Б');
  assert.equal(r.collection.activeId, 'p_000000aa');
  assert.equal(r.collection.items.at(-1).values.fDraw, 3000);
  let col = base();
  for (let i = 1; i < MAX_PROFILES; i++) col = add(col, `P${i}`).collection;
  assert.equal(col.items.length, 20);
  const over = createProfile(col, { name: 'P21', id: nextId() });
  assert.equal(over.ok, false);
  assert.match(over.message, /не больше 20/);
});

test('duplicate: the same values, a new unique name, the active profile stays', () => {
  const r = duplicateProfile(base(), 'p_000000aa', { now: 'T', id: nextId() });
  assert.ok(r.ok);
  const copy = r.collection.items.at(-1);
  assert.equal(copy.name, 'Neptune 3 Pro (копия)');
  assert.equal(copy.values.fDraw, 2500);
  assert.equal(r.collection.activeId, 'p_000000aa');
  const again = duplicateProfile(r.collection, 'p_000000aa', { id: nextId() });
  assert.equal(again.collection.items.at(-1).name, 'Neptune 3 Pro (копия) (2)');
  assert.equal(uniqueName('Новый', base().items), 'Новый');
});

test('rename: a repeated name is refused, the name is not changed', () => {
  const col = add(base(), 'Держатель Б').collection;
  const id = col.items[1].id;
  const bad = renameProfile(col, id, 'neptune 3 pro');
  assert.deepEqual(bad, { ok: false, message: 'имя уже занято' });
  assert.equal(col.items[1].name, 'Держатель Б');
  assert.equal(renameProfile(col, id, '  Держатель В ').collection.items[1].name, 'Держатель В');
});

test('remove: the last one stays; the active one — the neighbour becomes active with a message', () => {
  assert.deepEqual(removeProfile(base(), 'p_000000aa'), { ok: false, message: 'последний профиль удалить нельзя' });
  let col = add(add(base(), 'Б').collection, 'В').collection; // [Neptune, Б, В], active Neptune
  const first = removeProfile(col, 'p_000000aa');
  assert.equal(first.activeChanged, true);
  assert.equal(first.activeName, 'Б', 'no previous one: the next one');
  col = selectProfile(col, col.items[2].id).collection;
  const last = removeProfile(col, col.items[2].id);
  assert.equal(last.activeName, 'Б', 'the previous one');
  const other = removeProfile(col, col.items[1].id);
  assert.equal(other.activeChanged, false);
  assert.equal(other.collection.activeId, col.activeId);
  assert.equal(removeProfile(col, 'p_ffffffff').ok, false);
});

test('select: unknown id refused', () => {
  const col = add(base(), 'Б').collection;
  assert.equal(selectProfile(col, col.items[1].id).collection.activeId, col.items[1].id);
  assert.equal(selectProfile(col, 'p_ffffffff').ok, false);
});

test('updateProfileValues: merged and normalized; a partial bed is refused', () => {
  const col = base();
  const r = updateProfileValues(col, 'p_000000aa', { fDraw: 2600, fTravel: -1 });
  assert.equal(r.collection.items[0].values.fDraw, 2600);
  assert.equal(r.collection.items[0].values.fTravel, 6000);
  const bad = updateProfileValues(col, 'p_000000aa', { bedX0: -12, bedY0: -3 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /не целиком/);
  assert.equal(col.items[0].values.fDraw, 2500, 'the input is not changed');
});

test('normalizeCollection: broken items dropped, unknown active → the first, nothing usable → null', () => {
  assert.equal(normalizeCollection(null), null);
  assert.equal(normalizeCollection({ items: [{ id: 'bad', name: 'x' }] }), null);
  const col = normalizeCollection({ activeId: 'p_00000009', items: [{ id: 'p_00000001', name: ' A ', values: { fDraw: 1 } }, { id: 'p_00000001', name: 'dup' }, 5] });
  assert.equal(col.items.length, 1);
  assert.equal(col.items[0].name, 'A');
  assert.equal(col.activeId, 'p_00000001');
  assert.equal(col.items[0].values.fDraw, 1);
});
