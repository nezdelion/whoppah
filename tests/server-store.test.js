import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerStore } from '../src/storage/server-store.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createSessionAuth } from '../src/transport/auth-session.js';
import { applySettings, parseSettings } from '../src/storage/settings-file.js';
import { offerLocalImport } from '../src/app/local-import.js';
import { createState } from '../src/app/state.js';
import { resolveEnv, loadEnv } from '../src/app/env.js';
import { fakeFetch } from './helpers/fake-fetch.js';
import './helpers/ru.js';

const COOKIE = 'csrf_token_P5000';
const login = async () => ({ ok: true, status: 200, text: async () => '{"name":"u"}' });

function server(handler, opts = {}) {
  const fetch = fakeFetch(handler);
  const auth = createSessionAuth({ csrfCookie: COOKIE, getCookie: () => `${COOKIE}=T`, fetch: opts.login || login });
  return { store: new ServerStore({ baseUrl: 'http://op', settingsUrl: 'http://op/plugin/plotter/api/settings/', auth, fetch }), fetch };
}

test('load: GET of a section, null for an empty one, unknown sections are not requested', async () => {
  const { store, fetch } = server((url) => ({ body: url.endsWith('/job') ? { marginMm: 3 } : null }));
  assert.deepEqual(await store.load('job'), { marginMm: 3 });
  assert.equal(await store.load('presets'), null);
  assert.equal(await store.load('connection'), null);
  assert.deepEqual(fetch.calls.map((c) => c.url), ['http://op/plugin/plotter/api/settings/job', 'http://op/plugin/plotter/api/settings/presets']);
  assert.equal(fetch.calls[0].credentials, 'same-origin');
});

test('save: PUT JSON with a CSRF token; connection is not written', async () => {
  const { store, fetch } = server({ body: {} });
  await store.save('job', { a: 1 });
  await store.save('connection', { url: 'x' });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, 'PUT');
  assert.equal(fetch.calls[0].headers['X-CSRF-Token'], 'T');
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { a: 1 });
});

test('save: quick writes of one section are coalesced, the last value is sent', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store, fetch } = server(async () => { await gate; return { body: {} }; });
  const ps = [store.save('job', { v: 1 }), store.save('job', { v: 2 }), store.save('job', { v: 3 })];
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all(ps);
  assert.deepEqual(fetch.calls.map((c) => JSON.parse(c.body).v), [1, 3]);
});

test('save: 403 on the profile with a live session — permission required: changing the machine profile', async () => {
  const { store } = server({ status: 403, body: '{"error":"нет права"}' });
  await assert.rejects(store.save('profile', {}), (e) => e.status === 403 && e.message === 'нет права: изменение профиля машины');
  await assert.rejects(store.save('calibration', {}), (e) => e.message === 'нет права: управление принтером');
});

test('save: 403 without a session — session expired; 413 — the server text', async () => {
  const dead = async () => ({ ok: false, status: 403, text: async () => '' });
  const a = server({ status: 403 }, { login: dead });
  await assert.rejects(a.store.save('profile', {}), (e) => /истекла/.test(e.message));
  const b = server({ status: 413, body: '{"error":"раздел больше 1 МБ"}' });
  await assert.rejects(b.store.save('job', {}), (e) => e.status === 413 && /1 МБ/.test(e.message));
});

test('load: a server error is propagated, not turned into empty settings', async () => {
  const { store } = server({ status: 500, body: 'oops' });
  await assert.rejects(store.load('job'), (e) => e.status === 500);
});

test('state: a storage refusal gives a save-error event, the value stays in memory', async () => {
  const store = new MemoryStore();
  store.save = async () => { throw new Error('нет права: изменение профиля машины'); };
  const state = createState({ store });
  await state.load();
  const events = [];
  state.subscribe((e) => events.push(e));
  await state.patch('profile', { penWidthMm: 0.9 });
  assert.equal(state.get('profile').penWidthMm, 0.9);
  assert.deepEqual(events.filter((e) => e.type === 'save-error').map((e) => [e.section, e.message]), [['profile', 'нет права: изменение профиля машины']]);
});

const PROFILES = { version: 1, rev: 1, activeId: 'p_00000001', items: [{ id: 'p_00000001', name: 'Neptune 3 Pro', rev: 1, values: { fDraw: 1 } }] };
const FILE = JSON.stringify({ format: 'neptune-plotter-settings', version: 2, sections: { profiles: PROFILES, calibration: { cornerX: 1 }, job: { marginMm: 9 }, presets: { svg: {} } } });
const needs = (k) => (k === 'profiles' ? 'нужно право «изменение профиля машины»' : k === 'calibration' ? 'нужно право «управление принтером»' : null);

test('import without permissions: job and presets are written, profile and calibration skipped with a reason', async () => {
  const store = new MemoryStore();
  const r = await applySettings(store, parseSettings(FILE), undefined, { needs });
  assert.deepEqual(r.applied, ['job', 'presets']);
  assert.deepEqual(r.skipped.map((s) => s.key), ['profiles', 'calibration']);
  assert.equal(await store.load('profiles'), null);
  assert.deepEqual(await store.load('job'), { marginMm: 9 });
});

test('import with permissions: all sections; a storage refusal skips the section, the others are written', async () => {
  const store = new MemoryStore();
  const r = await applySettings(store, parseSettings(FILE));
  assert.equal(r.applied.length, 4);
  const failing = new MemoryStore();
  const save = failing.save.bind(failing);
  failing.save = async (k, v) => { if (k === 'profiles') throw new Error('нет права: изменение профиля машины'); return save(k, v); };
  const r2 = await applySettings(failing, parseSettings(FILE));
  assert.deepEqual(r2.skipped, [{ key: 'profiles', reason: 'нет права: изменение профиля машины' }]);
  assert.equal(r2.applied.length, 3);
});

function flagsStub() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; }

test('transfer from localStorage: offered once, permissions are respected', async () => {
  const local = new MemoryStore({ job: { marginMm: 4 }, profiles: PROFILES });
  const srv = new MemoryStore();
  const flags = flagsStub();
  let asked = 0;
  const args = { serverStore: srv, localStore: local, flags, flagKey: 'k', confirm: async () => { asked++; return true; }, needs };
  const msg = await offerLocalImport(args);
  assert.match(msg, /Пропущено: Профили машины/);
  assert.deepEqual(await srv.load('job'), { marginMm: 4 });
  assert.equal(await srv.load('profiles'), null);
  assert.equal(await offerLocalImport(args), null);
  assert.equal(asked, 1);
});

test('transfer: not offered if the server already has settings or there are no local ones; a refusal is remembered', async () => {
  const flags = flagsStub();
  const base = { flags, flagKey: 'k', needs, confirm: async () => false };
  assert.equal(await offerLocalImport({ ...base, serverStore: new MemoryStore({ job: {} }), localStore: new MemoryStore({ job: { a: 1 } }) }), null);
  assert.equal(await offerLocalImport({ ...base, serverStore: new MemoryStore(), localStore: new MemoryStore() }), null);
  const srv = new MemoryStore();
  assert.equal(await offerLocalImport({ ...base, serverStore: srv, localStore: new MemoryStore({ job: { a: 1 } }) }), null);
  assert.equal(await srv.load('job'), null);
  assert.equal(flags.getItem('k'), '1');
});

const RAW = { mode: 'plugin', baseUrl: '/octoprint', settingsUrl: '/octoprint/plugin/plotter/api/settings', octoprintUrl: '/octoprint/', csrfCookie: 'csrf_token_P80_R|octoprint', version: '0.1.0', user: 'a', canEditProfile: true };

test('env: standalone by default, plugin — absolute addresses from origin (behind a prefix)', () => {
  assert.deepEqual(resolveEnv({ mode: 'standalone' }, 'https://h'), { mode: 'standalone' });
  assert.deepEqual(resolveEnv(null, 'https://h'), { mode: 'standalone' });
  const e = resolveEnv(RAW, 'https://h');
  assert.equal(e.baseUrl, 'https://h/octoprint');
  assert.equal(e.settingsUrl, 'https://h/octoprint/plugin/plotter/api/settings');
  assert.equal(e.octoprintUrl, 'https://h/octoprint/');
  assert.equal(e.canEditCalibration, false);
  assert.equal(resolveEnv({ ...RAW, baseUrl: '' }, 'http://h:5000').baseUrl, 'http://h:5000');
  assert.throws(() => resolveEnv({ mode: 'plugin' }, 'https://h'), /baseUrl/);
});

test('loadEnv: an unavailable or non-JSON env.json — standalone', async () => {
  assert.deepEqual(await loadEnv({ fetch: fakeFetch({ status: 404, body: 'x' }), origin: 'http://h' }), { mode: 'standalone' });
  assert.deepEqual(await loadEnv({ fetch: fakeFetch({ body: '<html>' }), origin: 'http://h' }), { mode: 'standalone' });
  assert.deepEqual(await loadEnv({ fetch: fakeFetch(new TypeError('x')), origin: 'http://h' }), { mode: 'standalone' });
  assert.equal((await loadEnv({ fetch: fakeFetch({ body: RAW }), origin: 'http://h' })).mode, 'plugin');
});

// --- machine profiles API

const col = (over = {}) => ({ version: 1, rev: 3, activeId: 'p_00000001', items: [{ id: 'p_00000001', name: 'Neptune 3 Pro', rev: 2, values: { fDraw: 3000 } }], ...over });

test('profiles: GET the collection next to the sections; operations — PUT/DELETE per profile, PUT active; the answer is returned', async () => {
  const { store, fetch } = server(() => ({ body: col() }));
  assert.deepEqual(await store.load('profiles'), col());
  const c = col();
  assert.deepEqual(await store.save('profiles', c, { kind: 'put', id: 'p_00000001' }), col());
  await store.save('profiles', c, { kind: 'delete', id: 'p_00000001' });
  await store.save('profiles', c, { kind: 'active', id: 'p_00000001' });
  await store.save('profiles', c);
  assert.deepEqual(fetch.calls.map((x) => `${x.method || 'GET'} ${x.url}`), [
    'GET http://op/plugin/plotter/api/profiles',
    'PUT http://op/plugin/plotter/api/profiles/p_00000001',
    'DELETE http://op/plugin/plotter/api/profiles/p_00000001',
    'PUT http://op/plugin/plotter/api/profiles/active',
    'PUT http://op/plugin/plotter/api/profiles',
  ]);
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { name: 'Neptune 3 Pro', values: { fDraw: 3000 }, rev: 2 });
  assert.deepEqual(JSON.parse(fetch.calls[3].body), { id: 'p_00000001' });
  assert.equal(fetch.calls[2].headers['X-CSRF-Token'], 'T');
});

test('profiles: 403 — permission required (any write, the active choice too); 404 and 409 keep the server text', async () => {
  const deny = server({ status: 403, body: '{"error":"missing permission"}' });
  await assert.rejects(deny.store.save('profiles', col(), { kind: 'active', id: 'p_00000001' }), (e) => e.status === 403 && e.message === 'нет права: изменение профиля машины');
  const missing = server({ status: 404, body: '{"error":"unknown profile"}' });
  await assert.rejects(missing.store.save('profiles', col(), { kind: 'delete', id: 'p_00000009' }), (e) => e.status === 404 && /unknown profile/.test(e.message));
  const conflict = server({ status: 409, body: JSON.stringify({ error: 'profile changed', code: 'conflict', profile: { id: 'p_00000001', rev: 3 } }) });
  await assert.rejects(conflict.store.save('profiles', col(), { kind: 'put', id: 'p_00000001' }), (e) => e.status === 409 && e.code === 'conflict' && e.current.rev === 3);
});

test('profiles: a conflict rereads the profiles and says another device changed it; the other value is not lost', async () => {
  let serverCol = col({ items: [{ id: 'p_00000001', name: 'Neptune 3 Pro', rev: 2, values: { fDraw: 3000 } }] });
  const { store } = server((url, init) => {
    if (init.method === 'PUT' && url.endsWith('/p_00000001')) {
      const body = JSON.parse(init.body);
      if (body.rev !== serverCol.items[0].rev) return { status: 409, body: { error: 'profile changed', code: 'conflict', profile: serverCol.items[0] } };
      serverCol = col({ items: [{ ...serverCol.items[0], rev: body.rev + 1, values: body.values }] });
      return { body: serverCol };
    }
    if (url.endsWith('/profiles')) return { body: serverCol };
    return { body: null };
  });
  const state = createState({ store });
  await state.load();
  // the first device saved the speed meanwhile
  serverCol = col({ items: [{ id: 'p_00000001', name: 'Neptune 3 Pro', rev: 3, values: { fDraw: 2000 } }] });
  const events = [];
  state.subscribe((e) => events.push(e));
  await state.patch('profile', { penWidthMm: 0.9 });
  assert.equal(events.find((e) => e.type === 'save-error').message, 'Профиль изменён на другом устройстве: профили перечитаны, повторите изменение.');
  assert.equal(state.get('profile').fDraw, 2000);
  assert.equal(state.get('profile').penWidthMm, 0.5);
  // the next edit goes on the new revision
  await state.patch('profile', { penWidthMm: 0.9 });
  assert.equal(serverCol.items[0].rev, 4);
  assert.equal(serverCol.items[0].values.penWidthMm, 0.9);
  assert.equal(state.profiles().items[0].rev, 4);
});

test('profiles: quick edits go one after another, each on the revision the server returned', async () => {
  let serverCol = col();
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { store } = server(async (url, init) => {
    if (init.method === 'PUT') {
      const body = JSON.parse(init.body);
      sent.push(body);
      await gate;
      if (body.rev !== serverCol.items[0].rev) return { status: 409, body: { error: 'conflict', code: 'conflict' } };
      serverCol = col({ items: [{ ...serverCol.items[0], rev: body.rev + 1, values: body.values }] });
      return { body: serverCol };
    }
    return { body: serverCol };
  });
  const state = createState({ store });
  await state.load();
  const ps = [state.patch('profile', { fDraw: 1 })];
  await new Promise((r) => setTimeout(r, 5)); // the first write is in flight, the next ones are coalesced
  ps.push(state.patch('profile', { fDraw: 2 }), state.patch('profile', { fDraw: 3 }));
  release();
  await Promise.all(ps);
  assert.deepEqual(sent.map((b) => [b.rev, b.values.fDraw]), [[2, 1], [3, 3]]);
  assert.equal(state.get('profile').fDraw, 3);
});
