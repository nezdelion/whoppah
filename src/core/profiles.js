// Named machine profiles ("printer + pen holder"): a collection with one active profile. Pure functions, no DOM or transport.
// Document: { version: 1, rev, activeId, items: [{ id, name, rev, createdAt, updatedAt, values }] }; values — PROFILE_SCHEMA.
// Every operation returns { ok: true, collection, ... } with a new collection, or { ok: false, message }; the input is not changed.
import { defaultsOf, PROFILE_SCHEMA, normalizeProfile, bedErrors } from './profile.js';
import { t } from '../i18n/index.js';

export const PROFILES_VERSION = 1;
export const MAX_PROFILES = 20;
export const MAX_NAME = 64;
/** The name of the profile created from the single profile of earlier versions (and on a first start). */
export const DEFAULT_PROFILE_NAME = 'Neptune 3 Pro';

const ID_RE = /^p_[0-9a-f]{8}$/;
export const isProfileId = (id) => typeof id === 'string' && ID_RE.test(id);

/** A new id, independent of the name: p_ + 8 hex. */
export function newProfileId(random = Math.random) {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(random() * 16).toString(16);
  return 'p_' + s;
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const fail = (message) => ({ ok: false, message });

/** null — the name is fine; otherwise the reason. Unique without regard to case among the other profiles. */
export function validateName(name, items = [], exceptId = null) {
  if (typeof name !== 'string' || !name.trim()) return t('profiles.err.nameEmpty');
  if (name.trim().length > MAX_NAME) return t('profiles.err.nameLong', { max: MAX_NAME });
  if (items.some((p) => p.id !== exceptId && sameName(p.name, name))) return t('profiles.err.nameTaken');
  return null;
}

export const activeProfile = (col) => col.items.find((p) => p.id === col.activeId) || col.items[0];
export const findProfile = (col, id) => col.items.find((p) => p.id === id) || null;

function item({ id, name, values, now }) {
  return { id, name: name.trim(), rev: 1, createdAt: now, updatedAt: now, values: normalizeProfile(values) };
}

const bump = (col, items, extra = {}) => ({ ...col, rev: (col.rev || 0) + 1, items, ...extra });

/** The collection of one profile "Neptune 3 Pro" from the single stored profile of earlier versions (or the defaults). */
export function fromLegacy(values = null, { now = new Date().toISOString(), id = newProfileId() } = {}) {
  return { version: PROFILES_VERSION, rev: 1, activeId: id, items: [item({ id, name: DEFAULT_PROFILE_NAME, values: values || {}, now })] };
}

/** A unique name "<base> (2)", "<base> (3)", … */
export function uniqueName(base, items) {
  const b = base.trim().slice(0, MAX_NAME - 5) || DEFAULT_PROFILE_NAME;
  if (!validateName(b, items)) return b;
  for (let n = 2; ; n++) {
    const candidate = `${b} (${n})`;
    if (!validateName(candidate, items)) return candidate;
  }
}

/** A new profile with default values (or values); the active profile does not change. */
export function createProfile(col, { name, values = null, now = new Date().toISOString(), id = newProfileId() } = {}) {
  if (col.items.length >= MAX_PROFILES) return fail(t('profiles.err.tooMany', { max: MAX_PROFILES }));
  const err = validateName(name, col.items);
  if (err) return fail(err);
  if (findProfile(col, id)) return fail(t('profiles.err.idTaken'));
  const p = item({ id, name, values: values || defaultsOf(PROFILE_SCHEMA), now });
  return { ok: true, collection: bump(col, [...col.items, p]), id };
}

/** A copy with the same values and a new unique name; the active profile does not change. */
export function duplicateProfile(col, sourceId, { name = null, now, id } = {}) {
  const src = findProfile(col, sourceId);
  if (!src) return fail(t('profiles.err.notFound'));
  return createProfile(col, { name: name || uniqueName(t('profiles.copyName', { name: src.name }), col.items), values: clone(src.values), now, id });
}

export function renameProfile(col, id, name, { now = new Date().toISOString() } = {}) {
  const p = findProfile(col, id);
  if (!p) return fail(t('profiles.err.notFound'));
  const err = validateName(name, col.items, id);
  if (err) return fail(err);
  return { ok: true, collection: bump(col, col.items.map((x) => (x.id === id ? { ...x, name: name.trim(), updatedAt: now } : x))) };
}

/**
 * Deleting: the last profile stays; deleting the active one makes the neighbour active (the previous one in the list, else the next).
 * @returns {ok, collection, activeChanged: boolean, activeName} | {ok: false, message}
 */
export function removeProfile(col, id) {
  const i = col.items.findIndex((p) => p.id === id);
  if (i < 0) return fail(t('profiles.err.notFound'));
  if (col.items.length <= 1) return fail(t('profiles.err.last'));
  const items = col.items.filter((p) => p.id !== id);
  const activeChanged = col.activeId === id;
  const activeId = activeChanged ? col.items[i > 0 ? i - 1 : i + 1].id : col.activeId;
  return { ok: true, collection: bump(col, items, { activeId }), activeChanged, activeName: findProfile({ items }, activeId).name };
}

export function selectProfile(col, id) {
  if (!findProfile(col, id)) return fail(t('profiles.err.notFound'));
  return { ok: true, collection: { ...col, activeId: id } };
}

/**
 * New values of one profile (merged with the current ones; invalid fields — defaults, as for the other sections).
 * A partial or degenerate bed is refused: it must not silently become "not measured".
 */
export function updateProfileValues(col, id, changes, { now = new Date().toISOString() } = {}) {
  const p = findProfile(col, id);
  if (!p) return fail(t('profiles.err.notFound'));
  const values = { ...p.values, ...changes };
  const errors = bedErrors(values);
  if (errors.length) return fail(errors[0].message);
  const next = { ...p, values: normalizeProfile(values), updatedAt: now };
  return { ok: true, collection: { ...col, items: col.items.map((x) => (x.id === id ? next : x)) } };
}

/**
 * A stored or received document → a valid collection, or null if nothing usable is in it.
 * Values are normalized (defaults for missing fields), broken items are dropped, an unknown active id → the first profile.
 */
export function normalizeCollection(doc) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.items)) return null;
  const items = [];
  for (const p of doc.items.slice(0, MAX_PROFILES)) {
    if (!p || typeof p !== 'object' || !isProfileId(p.id) || typeof p.name !== 'string' || !p.name.trim()) continue;
    if (items.some((x) => x.id === p.id)) continue;
    items.push({
      id: p.id, name: p.name.trim().slice(0, MAX_NAME), rev: Number.isInteger(p.rev) ? p.rev : 1,
      createdAt: p.createdAt || null, updatedAt: p.updatedAt || null,
      values: normalizeProfile(p.values && typeof p.values === 'object' ? p.values : {}),
    });
  }
  if (!items.length) return null;
  const activeId = items.some((p) => p.id === doc.activeId) ? doc.activeId : items[0].id;
  return { version: PROFILES_VERSION, rev: Number.isInteger(doc.rev) ? doc.rev : 1, activeId, items };
}
