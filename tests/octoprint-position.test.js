import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPrintPosition } from '../src/transport/octoprint-position.js';
import { createSessionAuth } from '../src/transport/auth-session.js';
import { createApiKeyAuth } from '../src/transport/auth-api-key.js';
import { TransportError } from '../src/transport/transport.js';
import { fakeFetch } from './helpers/fake-fetch.js';

const make = (fetch, auth = createApiKeyAuth({ getKey: () => 'K' })) => createOctoPrintPosition({ apiUrl: 'http://op/plugin/plotter/api/', auth, fetch });

test('read: POST /position, the position with an epoch', async () => {
  const fetch = fakeFetch({ body: { x: -5, y: 50, z: 8.2, epoch: 3 } });
  assert.deepEqual(await make(fetch).read(), { x: -5, y: 50, z: 8.2, epoch: 3 });
  assert.equal(fetch.calls[0].url, 'http://op/plugin/plotter/api/position');
  assert.equal(fetch.calls[0].method, 'POST');
});

test('epoch: GET /position/epoch', async () => {
  const fetch = fakeFetch({ body: { epoch: 7 } });
  assert.equal(await make(fetch).epoch(), 7);
  assert.equal(fetch.calls[0].url, 'http://op/plugin/plotter/api/position/epoch');
  assert.equal(fetch.calls[0].method, 'GET');
});

const cases = [
  [409, 'busy', /печат/], [409, 'offline', /не подключён/], [504, 'timeout', /не ответил/], [409, 'stale', /повторите захват/],
  [501, 'unsupported', /M118/], [502, 'nocoords', /координаты/],
];
for (const [status, code, text] of cases) {
  test(`code ${status}/${code}: kind and a clear message`, async () => {
    await assert.rejects(make(fakeFetch({ status, body: { error: 'x', code } })).read(),
      (e) => e instanceof TransportError && e.kind === code && text.test(e.message) && e.status === status);
  });
}

test('network, non-JSON and an incomplete response', async () => {
  await assert.rejects(make(fakeFetch(new TypeError('Failed to fetch'))).read(), (e) => e.kind === 'network');
  await assert.rejects(make(fakeFetch({ body: '<html>' })).read(), (e) => e.kind === 'http');
  await assert.rejects(make(fakeFetch({ body: { x: 1 } })).read(), (e) => e.kind === 'http');
  await assert.rejects(make(fakeFetch({ status: 500, body: 'oops' })).epoch(), (e) => e.kind === 'http' && /500/.test(e.message));
});

test('403: no permission (session alive) and session expired (session dead)', async () => {
  let expired = 0;
  const session = (alive) => createSessionAuth({
    csrfCookie: 'csrf', getCookie: () => 'csrf=T', onExpired: () => expired++,
    fetch: fakeFetch(async () => ({ body: alive ? { name: 'bob' } : { name: '_anonymous' }, status: alive ? 200 : 403 })),
  });
  const denied = () => fakeFetch((url) => (url.endsWith('/position') ? { status: 403, body: { error: 'missing permission' } } : { body: { name: 'bob' } }));
  await assert.rejects(make(denied(), session(true)).read(), (e) => e.kind === 'forbidden' && /нет права: управление принтером/.test(e.message));
  await assert.rejects(make(denied(), session(false)).read(), (e) => /истекла/.test(e.message));
  assert.equal(expired, 1);
});

test('save and confirm: routes and bodies', async () => {
  const fetch = fakeFetch({ body: { ok: true, calibration: { cornerX: 1 } } });
  const p = make(fetch);
  assert.deepEqual(await p.saveCorner({ x: 1, y: 2, epoch: 4 }), { cornerX: 1 });
  await p.saveTouch({ zTouch: 8.2, epoch: 4 });
  await p.confirm('xy');
  await p.confirm('z');
  assert.deepEqual(fetch.calls.map((c) => c.url.replace('http://op/plugin/plotter/api', '')),
    ['/calibration/xy', '/calibration/z', '/calibration/xy/confirm', '/calibration/z/confirm']);
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { x: 1, y: 2, epoch: 4 });
  assert.deepEqual(JSON.parse(fetch.calls[1].body), { zTouch: 8.2, epoch: 4 });
  await assert.rejects(p.confirm('q'), /неизвестная часть/);
});

test('stale on save', async () => {
  await assert.rejects(make(fakeFetch({ status: 409, body: { error: 'x', code: 'stale' } })).saveCorner({ x: 1, y: 2, epoch: 0 }), (e) => e.kind === 'stale');
});
