import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPrintTransport } from '../src/transport/octoprint-http.js';
import { createApiKeyAuth } from '../src/transport/auth-api-key.js';
import { NullTransport, TransportError } from '../src/transport/transport.js';
import { authContract } from './contract/auth.contract.js';
import { fakeFetch } from './helpers/fake-fetch.js';

// A strategy with one retry: after the first error it asks for "retry" and changes the token.
function retryingAuth() {
  let token = 'old';
  return {
    async init() {},
    async prepare(req) { return { ...req, headers: { ...req.headers, Authorization: token } }; },
    async recover(err, attempt) { if (attempt === 0) { token = 'new'; return 'retry'; } return 'fail'; },
    describe: (e) => `сессия: ${e.status}`,
  };
}

authContract('auth-api-key', () => createApiKeyAuth({ getKey: () => 'KEY' }));
authContract('тестовая стратегия с повтором', retryingAuth);

const apiKey = (key = 'KEY') => createApiKeyAuth({ getKey: () => key });
const make = (fetch, opts = {}) => createOctoPrintTransport({ getBaseUrl: () => 'http://octopi.local/', auth: apiKey(), fetch, ...opts });

test('X-Api-Key is added, a trailing slash of the address is removed', async () => {
  const fetch = fakeFetch({ body: { server: '1.11.0' } });
  await make(fetch).test();
  assert.equal(fetch.calls[0].url, 'http://octopi.local/api/version');
  assert.equal(fetch.calls[0].headers['X-Api-Key'], 'KEY');
});

test('connection test: server version and printer state', async () => {
  const fetch = fakeFetch((url) => (url.endsWith('/api/version') ? { body: { server: '1.11.0' } } : { body: { current: { state: 'Operational' } } }));
  assert.deepEqual(await make(fetch).test(), { server: '1.11.0', printer: 'Operational' });
});

test('wrong key: OctoPrint rejected the key (403)', async () => {
  await assert.rejects(make(fakeFetch({ status: 403, body: 'Forbidden' })).test(), (e) => e.kind === 'auth' && e.message === 'OctoPrint отклонил ключ (403)');
});

test('CORS/network: a CORS hint', async () => {
  await assert.rejects(make(fakeFetch(new TypeError('Failed to fetch'))).test(), (e) => /CORS/.test(e.message));
});

test('409 — the printer is not connected', async () => {
  await assert.rejects(make(fakeFetch({ status: 409, body: 'Printer is not operational' })).command(['G28']), (e) => e.kind === 'conflict' && /409/.test(e.message));
});

test('upload: multipart with select/print, file name', async () => {
  const fetch = fakeFetch({ body: {} });
  await make(fetch).upload('cat.gcode', 'G21\n', { select: true, print: true });
  const c = fetch.calls[0];
  assert.equal(c.url, 'http://octopi.local/api/files/local');
  assert.equal(c.method, 'POST');
  assert.ok(c.body instanceof FormData);
  assert.equal(c.body.get('select'), 'true');
  assert.equal(c.body.get('print'), 'true');
  assert.equal(c.body.get('file').name, 'cat.gcode');
  assert.equal(c.headers['Content-Type'], undefined, 'boundary is set by the browser');
});

test('upload without starting', async () => {
  const fetch = fakeFetch({ body: {} });
  await make(fetch).upload('a.gcode', 'G21', { select: true, print: false });
  assert.equal(fetch.calls[0].body.get('print'), 'false');
});

test('pause, resume, cancel, commands', async () => {
  const fetch = fakeFetch({ status: 204 });
  const t = make(fetch);
  await t.pause(true); await t.pause(false); await t.cancel(); await t.command(['G90', 'M84']);
  const bodies = fetch.calls.map((c) => JSON.parse(c.body));
  assert.deepEqual(bodies, [
    { command: 'pause', action: 'pause' }, { command: 'pause', action: 'resume' },
    { command: 'cancel' }, { commands: ['G90', 'M84'] }]);
  assert.equal(fetch.calls[2].url, 'http://octopi.local/api/job');
  assert.equal(fetch.calls[3].url, 'http://octopi.local/api/printer/command');
});

test('job status', async () => {
  const fetch = fakeFetch({ body: { state: 'Printing', job: { file: { name: 'a.gcode' } }, progress: { completion: 42.5, printTimeLeft: 120 } } });
  assert.deepEqual(await make(fetch).job(), { state: 'Printing', file: 'a.gcode', progress: 42.5, timeLeft: 120 });
});

test('a retry on recover=retry uses a new prepare', async () => {
  const seen = [];
  const fetch = fakeFetch(async (url, init) => { seen.push(init.headers.Authorization); return seen.length === 1 ? { status: 403, body: '' } : { body: { state: 'Operational' } }; });
  const t = createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth: retryingAuth(), fetch });
  assert.equal((await t.job()).state, 'Operational');
  assert.deepEqual(seen, ['old', 'new']);
});

test('configured(): the address and key are needed; NullTransport is not configured and refuses', async () => {
  assert.equal(make(fakeFetch({})).configured(), true);
  assert.equal(createOctoPrintTransport({ getBaseUrl: () => '', auth: apiKey(), fetch: fakeFetch({}) }).configured(), false);
  assert.equal(createOctoPrintTransport({ getBaseUrl: () => 'http://x', auth: apiKey(''), fetch: fakeFetch({}) }).configured(), false);
  const n = new NullTransport();
  assert.equal(n.configured(), false);
  await assert.rejects(n.upload('a', 'b', {}), (e) => e instanceof TransportError && e.kind === 'not-configured');
});

test('2xx non-JSON (a proxy page) — TransportError, not SyntaxError', async () => {
  const t = make(fakeFetch({ body: '<html>proxy</html>' }));
  await assert.rejects(t.job(), (e) => e instanceof TransportError && e.kind === 'http' && e.operation === 'job' && e.message === 'OctoPrint вернул не JSON');
});

test('test({signal}): the signal goes to fetch, abort — TransportError kind=aborted without a retry', async () => {
  const ac = new AbortController();
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.signal);
    ac.abort();
    throw new DOMException('aborted', 'AbortError');
  };
  await assert.rejects(make(fetch).test({ signal: ac.signal }), (e) => e instanceof TransportError && e.kind === 'aborted');
  assert.equal(seen.length, 1);
  assert.equal(seen[0], ac.signal);
});
