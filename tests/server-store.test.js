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

const FILE = JSON.stringify({ format: 'neptune-plotter-settings', version: 1, sections: { profile: { fDraw: 1 }, calibration: { cornerX: 1 }, job: { marginMm: 9 }, presets: { svg: {} } } });
const needs = (k) => (k === 'profile' ? 'нужно право «изменение профиля машины»' : k === 'calibration' ? 'нужно право «управление принтером»' : null);

test('import without permissions: job and presets are written, profile and calibration skipped with a reason', async () => {
  const store = new MemoryStore();
  const r = await applySettings(store, parseSettings(FILE), undefined, { needs });
  assert.deepEqual(r.applied, ['job', 'presets']);
  assert.deepEqual(r.skipped.map((s) => s.key), ['profile', 'calibration']);
  assert.equal(await store.load('profile'), null);
  assert.deepEqual(await store.load('job'), { marginMm: 9 });
});

test('import with permissions: all sections; a storage refusal skips the section, the others are written', async () => {
  const store = new MemoryStore();
  const r = await applySettings(store, parseSettings(FILE));
  assert.equal(r.applied.length, 4);
  const failing = new MemoryStore();
  const save = failing.save.bind(failing);
  failing.save = async (k, v) => { if (k === 'profile') throw new Error('нет права: изменение профиля машины'); return save(k, v); };
  const r2 = await applySettings(failing, parseSettings(FILE));
  assert.deepEqual(r2.skipped, [{ key: 'profile', reason: 'нет права: изменение профиля машины' }]);
  assert.equal(r2.applied.length, 3);
});

function flagsStub() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; }

test('transfer from localStorage: offered once, permissions are respected', async () => {
  const local = new MemoryStore({ job: { marginMm: 4 }, profile: { fDraw: 2 } });
  const srv = new MemoryStore();
  const flags = flagsStub();
  let asked = 0;
  const args = { serverStore: srv, localStore: local, flags, flagKey: 'k', confirm: async () => { asked++; return true; }, needs };
  const msg = await offerLocalImport(args);
  assert.match(msg, /Пропущено: Профиль машины/);
  assert.deepEqual(await srv.load('job'), { marginMm: 4 });
  assert.equal(await srv.load('profile'), null);
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
