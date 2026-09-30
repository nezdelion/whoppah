import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPrintTransport } from '../src/transport/octoprint-http.js';
import { createSessionAuth, readCookie } from '../src/transport/auth-session.js';
import { authContract } from './contract/auth.contract.js';
import { fakeFetch } from './helpers/fake-fetch.js';

const COOKIE = 'csrf_token_P5000';
const alive = async () => ({ ok: true, status: 200, text: async () => '{"name":"admin"}' });

// Login requests go through the strategy's own fetch so as not to mix with the transport request log.
authContract('auth-session', () => createSessionAuth({ csrfCookie: COOKIE, getCookie: () => `${COOKIE}=T1`, fetch: alive }));

function setup({ cookies = { v: `${COOKIE}=T1` }, login, handler, onExpired } = {}) {
  const loginCalls = [];
  const auth = createSessionAuth({
    baseUrl: 'http://op/', csrfCookie: COOKIE, getCookie: () => cookies.v, onExpired,
    fetch: async (url, init) => { loginCalls.push({ url, ...init }); return login(loginCalls.length); },
  });
  const fetch = fakeFetch(handler || { body: { state: 'Operational' } });
  const transport = createOctoPrintTransport({ getBaseUrl: () => 'http://op/', auth, fetch });
  return { auth, fetch, transport, loginCalls, cookies };
}
const ok = (name = 'admin') => ({ ok: true, status: 200, text: async () => JSON.stringify({ name }) });
const status = (s, body = '') => ({ ok: s < 300, status: s, text: async () => body });

test('readCookie: exact name, value with an equals sign, absence', () => {
  assert.equal(readCookie('a=1; csrf_token_P5000=x=y; b=2', 'csrf_token_P5000'), 'x=y');
  assert.equal(readCookie('csrf_token_P5000_R|x=1', 'csrf_token_P5000'), '');
  assert.equal(readCookie('', 'a'), '');
});

test('init: passive login at baseUrl; prepare: same-origin and CSRF only for mutating requests', async () => {
  const { transport, fetch, loginCalls } = setup({ login: () => ok() });
  await transport.job();
  await transport.pause(true);
  assert.equal(loginCalls.length, 1);
  assert.equal(loginCalls[0].url, 'http://op/api/login');
  assert.deepEqual(JSON.parse(loginCalls[0].body), { passive: true });
  assert.equal(fetch.calls[0].credentials, 'same-origin');
  assert.equal(fetch.calls[0].headers['X-CSRF-Token'], undefined);
  assert.equal(fetch.calls[1].headers['X-CSRF-Token'], 'T1');
  assert.equal(fetch.calls[1].headers['X-Api-Key'], undefined);
});

test('stale CSRF: one passive login and one retry with a new token', async () => {
  const cookies = { v: `${COOKIE}=OLD` };
  const { transport, fetch, loginCalls } = setup({
    cookies,
    login: (n) => { if (n > 1) cookies.v = `${COOKIE}=NEW`; return ok(); }, // the server refreshes the cookie on a repeated login
    handler: (url, init) => (init.headers['X-CSRF-Token'] === 'NEW' ? { body: {} } : { status: 400, body: '<p>CSRF validation failed</p>' }),
  });
  await transport.cancel();
  assert.deepEqual(fetch.calls.map((c) => c.headers['X-CSRF-Token']), ['OLD', 'NEW']);
  assert.equal(loginCalls.length, 2);
});

test('repeated CSRF denial: an error, at most two transport requests', async () => {
  const { transport, fetch } = setup({ login: () => ok(), handler: { status: 400, body: 'CSRF validation failed' } });
  await assert.rejects(transport.cancel(), (e) => e.status === 400 && /CSRF/.test(e.message));
  assert.equal(fetch.calls.length, 2);
});

test('CSRF denial with an expired session: no retry, session expired', async () => {
  let n = 0;
  const { transport, fetch } = setup({ login: () => (++n === 1 ? ok() : status(200, '{"name":"_anonymous","_anonymous":true}')), handler: { status: 403 } });
  await assert.rejects(transport.cancel(), (e) => /истекла/.test(e.message));
  assert.equal(fetch.calls.length, 1);
});

test('403 with a live session: permission required: print, onExpired is not called', async () => {
  let expired = 0;
  const { transport } = setup({ login: () => ok(), handler: { status: 403 }, onExpired: () => expired++ });
  await assert.rejects(transport.upload('a.gcode', 'G28', { print: true }), (e) => e.message === 'нет права: печать');
  await assert.rejects(transport.command(['G28']), (e) => e.message === 'нет права: управление принтером');
  assert.equal(expired, 0);
});

test('403 without a session and 401: OctoPrint session expired — sign in, onExpired called', async () => {
  let expired = 0;
  const { transport } = setup({ login: () => status(403), handler: { status: 403 }, onExpired: () => expired++ });
  await assert.rejects(transport.job(), (e) => e.message === 'сессия OctoPrint истекла — войти');
  assert.equal(expired, 1);
  const t2 = setup({ login: () => ok(), handler: { status: 401 } });
  await assert.rejects(t2.transport.job(), (e) => /истекла/.test(e.message));
});

test('after a repeated login requests pass again', async () => {
  let sessionOk = false;
  const { transport } = setup({ login: () => (sessionOk ? ok() : status(403)), handler: () => (sessionOk ? { body: { state: 'Operational' } } : { status: 403 }) });
  await assert.rejects(transport.job());
  sessionOk = true;
  assert.equal((await transport.job()).state, 'Operational');
});

test('a network failure during passive login does not crash init', async () => {
  const auth = createSessionAuth({ csrfCookie: COOKIE, getCookie: () => '', fetch: async () => { throw new TypeError('x'); } });
  const t = createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth, fetch: fakeFetch({ body: { server: '1' } }) });
  assert.equal((await t.test()).server, '1');
});

test('refreshUrl: without a cookie at init and after a CSRF denial the token is requested with GET', async () => {
  const cookies = { v: '' };
  const urls = [];
  const auth = createSessionAuth({
    csrfCookie: COOKIE, getCookie: () => cookies.v, refreshUrl: 'http://op/plugin/plotter/env.json',
    fetch: async (url) => { urls.push(url); if (url.endsWith('env.json')) cookies.v = `${COOKIE}=FRESH`; return ok(); },
  });
  const fetch = fakeFetch((u, init) => (init.headers['X-CSRF-Token'] === 'FRESH' ? { body: {} } : { status: 400, body: 'CSRF validation failed' }));
  await createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth, fetch }).cancel();
  assert.equal(urls.filter((u) => u.endsWith('env.json')).length, 1);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].headers['X-CSRF-Token'], 'FRESH');
  cookies.v = `${COOKIE}=STALE`;
  const f2 = fakeFetch((u, init) => (init.headers['X-CSRF-Token'] === 'FRESH' ? { body: {} } : { status: 400, body: 'CSRF validation failed' }));
  cookies.v = `${COOKIE}=STALE`;
  await createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth, fetch: f2 }).cancel();
  assert.deepEqual(f2.calls.map((c) => c.headers['X-CSRF-Token']), ['STALE', 'FRESH']);
});

test('the login address is set by the strategy itself: /api/login does not depend on which client initialized it first', async () => {
  const { createOctoPrintPosition } = await import('../src/transport/octoprint-position.js');
  for (const first of ['position', 'transport']) {
    const urls = [];
    const auth = createSessionAuth({ baseUrl: 'http://op', csrfCookie: COOKIE, getCookie: () => `${COOKIE}=T`, fetch: async (u) => { urls.push(u); return ok(); } });
    const f = fakeFetch({ body: { epoch: 1 } });
    const pos = createOctoPrintPosition({ apiUrl: 'http://op/plugin/plotter/api', auth, fetch: f });
    const tr = createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth, fetch: fakeFetch({ body: {} }) });
    if (first === 'position') { await pos.epoch(); await tr.job(); } else { await tr.job(); await pos.epoch(); }
    assert.ok(urls.length >= 1 && urls.every((u) => u === 'http://op/api/login'), urls.join());
  }
});

test('sameOrigin: the plugin empty address means configured, relative /api/... are preserved', async () => {
  const auth = createSessionAuth({ csrfCookie: COOKIE, getCookie: () => `${COOKIE}=T`, fetch: async () => ok() });
  const fetch = fakeFetch({ body: {} });
  const t = createOctoPrintTransport({ getBaseUrl: () => '', auth, sameOrigin: true, fetch });
  assert.equal(t.configured(), true);
  await t.job();
  assert.equal(fetch.calls[0].url, '/api/job');
  assert.equal(createOctoPrintTransport({ getBaseUrl: () => '', auth, fetch }).configured(), false);
});
