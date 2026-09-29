// Contract tests of the auth strategy: run for every implementation.
// makeAuth() -> Auth; if needed the strategy may return { auth, ...}.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOctoPrintTransport } from '../../src/transport/octoprint-http.js';
import { TransportError } from '../../src/transport/transport.js';
import { fakeFetch } from '../helpers/fake-fetch.js';

function traced(auth, log) {
  const wrap = (name) => async (...args) => { log.push(name); return auth[name](...args); };
  return { ...auth, init: wrap('init'), prepare: wrap('prepare'), recover: wrap('recover'),
    describe: (e) => { log.push('describe'); return auth.describe(e); } };
}

export function authContract(name, makeAuth) {
  const client = (auth, fetch) => createOctoPrintTransport({ getBaseUrl: () => 'http://op', auth, fetch });

  test(`[${name}] order: init → prepare → fetch`, async () => {
    const log = [];
    const fetch = fakeFetch(async () => { log.push('fetch'); return { body: { server: '1.11' } }; });
    await client(traced(makeAuth(), log), fetch).test();
    assert.deepEqual(log.slice(0, 3), ['init', 'prepare', 'fetch']);
  });

  test(`[${name}] concurrent requests call init once`, async () => {
    const log = [];
    const fetch = fakeFetch({ body: { state: 'Operational' } });
    const t = client(traced(makeAuth(), log), fetch);
    await Promise.all([t.job(), t.job(), t.job()]);
    assert.equal(log.filter((x) => x === 'init').length, 1);
    assert.equal(log.filter((x) => x === 'prepare').length, 3);
  });

  test(`[${name}] a retry at most once`, async () => {
    const fetch = fakeFetch({ status: 403, body: 'no' });
    const t = client(makeAuth(), fetch);
    await assert.rejects(t.job(), (e) => e instanceof TransportError && e.status === 403);
    assert.ok(fetch.calls.length <= 2, `requests: ${fetch.calls.length}`);
  });

  test(`[${name}] errors keep status and operation`, async () => {
    for (const status of [401, 403, 409, 500]) {
      const t = client(makeAuth(), fakeFetch({ status, body: 'x' }));
      await assert.rejects(t.cancel(), (e) => e.status === status && e.operation === 'cancel' && e.message.length > 0);
    }
  });

  test(`[${name}] a network error becomes TransportError('network')`, async () => {
    const t = client(makeAuth(), fakeFetch(new TypeError('Failed to fetch')));
    await assert.rejects(t.job(), (e) => e.kind === 'network');
  });
}
