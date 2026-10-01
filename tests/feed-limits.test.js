import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLimitsMemo } from '../src/app/ui/feed-limits.js';
import './helpers/ru.js';

const L = { enabled: true, min: { x: 0, y: 0, z: 0 }, max: { x: 235, y: 235, z: 280 } };

function fakeFeed() {
  const f = { st: 'live', ses: 1, pending: null };
  f.state = () => f.st;
  f.session = () => f.ses;
  f.readLimits = () => new Promise((resolve) => { f.pending = resolve; });
  return f;
}

test('the limits are valid while the feed session is the same', async () => {
  const f = fakeFeed();
  const m = createLimitsMemo(f);
  const p = m.read();
  f.pending(L);
  assert.deepEqual(await p, L);
  assert.deepEqual(m.get(), L);
});

test('a feed drop resets the limits, and a new session does not bring them back', async () => {
  const f = fakeFeed();
  const m = createLimitsMemo(f);
  const p = m.read(); f.pending(L); await p;
  f.st = 'connecting';
  assert.equal(m.get(), null);
  f.st = 'live'; f.ses++;
  assert.equal(m.get(), null);
});

test('a reconnect between two checks (the session grew) also resets', async () => {
  const f = fakeFeed();
  const m = createLimitsMemo(f);
  const p = m.read(); f.pending(L); await p;
  f.ses++;
  assert.equal(m.get(), null);
});

test('a read that finished already in another session is discarded', async () => {
  const f = fakeFeed();
  const m = createLimitsMemo(f);
  const p = m.read();
  f.ses++;
  f.pending(L);
  assert.equal(await p, null);
  assert.equal(m.get(), null);
});
