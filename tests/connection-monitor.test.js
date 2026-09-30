import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConnectionMonitor, isValidBaseUrl, printerIsUp, INTERVAL_MS } from '../src/app/connection-monitor.js';
import { TransportError } from '../src/transport/transport.js';
import { fakeVisibility } from './helpers/fake-position.js';

// Virtual time: setTimeout/setInterval/now; tick(ms) advances timers and microtasks.
function clock() {
  const t = { time: 0, now: () => t.time, items: new Map(), id: 1 };
  t.setTimeout = (fn, ms) => { const id = t.id++; t.items.set(id, { fn, at: t.time + ms }); return id; };
  t.setInterval = (fn, ms) => { const id = t.id++; t.items.set(id, { fn, at: t.time + ms, every: ms }); return id; };
  t.clearTimeout = t.clearInterval = (id) => { t.items.delete(id); };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  t.tick = async (ms) => {
    await flush();
    const end = t.time + ms;
    for (;;) {
      const due = [...t.items.entries()].filter(([, i]) => i.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, item] = due;
      t.time = item.at;
      if (item.every) item.at += item.every; else t.items.delete(id);
      item.fn();
      await flush();
    }
    t.time = end;
    await flush();
  };
  t.flush = flush;
  t.pending = () => t.items.size;
  return t;
}

// Transport: the response is set by a scenario; hang = the response does not arrive until signal fires (or manually).
function fakeTransport({ abortable = true } = {}) {
  const tr = { calls: 0, inflight: 0, maxInflight: 0, reply: () => ({ server: '1.11.8', printer: 'Operational' }), hang: false, aborts: 0, resolvers: [] };
  tr.test = (opts = {}) => {
    tr.calls++; tr.inflight++; tr.maxInflight = Math.max(tr.maxInflight, tr.inflight);
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { tr.inflight--; fn(v); };
      if (tr.hang) {
        tr.resolvers.push(() => done(resolve, tr.reply()));
        if (abortable && opts.signal) opts.signal.addEventListener('abort', () => { tr.aborts++; done(reject, new TransportError('запрос прерван', { kind: 'aborted' })); });
        return;
      }
      Promise.resolve().then(() => {
        try { done(resolve, tr.reply()); } catch (e) { done(reject, e); }
      });
    });
  };
  tr.configured = () => true;
  return tr;
}

function setup(opts = {}) {
  const timers = clock();
  const transport = opts.transport || fakeTransport();
  const visibility = fakeVisibility(opts.visible ?? true);
  let cfg = opts.cfg ?? true;
  const monitor = createConnectionMonitor({ transport, configured: () => cfg, visibility, timers });
  const seen = [];
  monitor.subscribe((s) => seen.push(s.status));
  return { timers, transport, visibility, monitor, seen, setCfg: (v) => { cfg = v; } };
}

test('address: validity', () => {
  assert.equal(isValidBaseUrl('http://octopi.local'), true);
  assert.equal(isValidBaseUrl('https://10.0.0.5:5000/'), true);
  assert.equal(isValidBaseUrl('octopi.local'), false);
  assert.equal(isValidBaseUrl('http://'), false);
  assert.equal(isValidBaseUrl(''), false);
});

test('printer states: working and not', () => {
  for (const s of ['Operational', 'Printing', 'Paused', 'Printing from SD', 'Finishing']) assert.equal(printerIsUp(s), true, s);
  for (const s of ['Offline', 'Closed', 'Error', 'Offline after error', 'Detecting serial connection', null, '']) assert.equal(printerIsUp(s), false, String(s));
});

test('without settings: unconfigured, no requests', async () => {
  const { monitor, transport, timers } = setup({ cfg: false });
  monitor.start();
  await timers.tick(10000);
  assert.equal(monitor.status().status, 'unconfigured');
  assert.equal(transport.calls, 0);
});

test('start: checking → ok with the version and printer state; lastOk recorded', async () => {
  const { monitor, seen, timers } = setup();
  timers.time = 5000;
  monitor.start();
  assert.equal(monitor.status().status, 'checking');
  await timers.tick(1);
  const s = monitor.status();
  assert.equal(s.status, 'ok');
  assert.equal(s.detail, 'OctoPrint 1.11.8, принтер: Operational');
  assert.equal(s.lastOk, 5000);
  assert.deepEqual(seen, ['checking', 'ok']);
});

test('ping every 3 s; the subscriber gets only changes, onCycle — every check', async () => {
  const { monitor, transport, timers, seen } = setup();
  let cycles = 0;
  monitor.onCycle(() => cycles++);
  monitor.start();
  await timers.tick(9000);
  assert.equal(transport.calls, 4); // start + 3, 6, 9 s
  assert.equal(cycles, 4);
  assert.deepEqual(seen, ['checking', 'ok']);
  assert.equal(INTERVAL_MS, 3000);
});

test('printer off → printer-off; turned on → ok', async () => {
  const { monitor, transport, timers } = setup();
  monitor.start();
  await timers.tick(1);
  transport.reply = () => ({ server: '1.11.8', printer: 'Closed' });
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'printer-off');
  assert.equal(monitor.status().detail, 'OctoPrint 1.11.8, принтер: Closed');
  transport.reply = () => ({ server: '1.11.8', printer: null });
  await timers.tick(3000);
  assert.equal(monitor.status().detail, 'OctoPrint 1.11.8, принтер: не подключён');
  transport.reply = () => ({ server: '1.11.8', printer: 'Printing' });
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'ok');
});

test('403 → auth, network → error with a CORS hint, otherwise — the error text; after an error the connection recovers', async () => {
  const { monitor, transport, timers } = setup();
  monitor.start();
  transport.reply = () => { throw new TransportError('OctoPrint отклонил ключ (403)', { kind: 'auth', status: 403 }); };
  await timers.tick(3000);
  assert.deepEqual([monitor.status().status, monitor.status().detail], ['auth', 'ключ не принят (403)']);
  transport.reply = () => { throw new TransportError('длинный текст сети', { kind: 'network' }); };
  await timers.tick(3000);
  assert.deepEqual([monitor.status().status, monitor.status().detail], ['error', 'нет ответа: проверь адрес и CORS']);
  transport.reply = () => { throw new TransportError('OctoPrint ответил 500', { kind: 'http', status: 500 }); };
  await timers.tick(3000);
  assert.deepEqual([monitor.status().status, monitor.status().detail], ['error', 'OctoPrint ответил 500']);
  transport.reply = () => ({ server: '1.11.8', printer: 'Operational' });
  const lastOkBefore = monitor.status().lastOk;
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'ok');
  assert.ok(monitor.status().lastOk > lastOkBefore);
});

test('an error keeps lastOk of the past success', async () => {
  const { monitor, transport, timers } = setup();
  monitor.start();
  await timers.tick(1);
  const ok = monitor.status().lastOk;
  transport.reply = () => { throw new TransportError('x', { kind: 'network' }); };
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'error');
  assert.equal(monitor.status().lastOk, ok);
});

test('hung request: 2.5 s timeout via AbortController, requests do not overlap', async () => {
  const { monitor, transport, timers } = setup();
  transport.hang = true;
  monitor.start();
  await timers.tick(2400);
  assert.equal(monitor.status().status, 'checking');
  await timers.tick(200);
  assert.equal(transport.aborts, 1);
  assert.deepEqual([monitor.status().status, monitor.status().detail], ['error', 'нет ответа за 2,5 с']);
  await timers.tick(20000);
  assert.equal(transport.maxInflight, 1);
  transport.hang = false;
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'ok');
});

test('transport without signal support: a slow response = error, the second request does not start, a late response does not overwrite', async () => {
  const transport = fakeTransport({ abortable: false });
  const { monitor, timers } = setup({ transport });
  transport.hang = true;
  monitor.start();
  await timers.tick(9000);
  assert.equal(monitor.status().status, 'error');
  assert.equal(transport.calls, 1);
  assert.equal(transport.maxInflight, 1);
  transport.resolvers[0](); // the response finally arrived
  await timers.flush();
  transport.hang = false;
  await timers.tick(3000);
  assert.equal(monitor.status().status, 'ok');
});

test('page hidden: polling stopped, on show — an immediate check and polling resumed', async () => {
  const { monitor, transport, timers, visibility } = setup();
  monitor.start();
  await timers.tick(1);
  assert.equal(transport.calls, 1);
  visibility.set(false);
  assert.equal(timers.pending(), 0);
  await timers.tick(30000);
  assert.equal(transport.calls, 1);
  visibility.set(true);
  await timers.tick(1);
  assert.equal(transport.calls, 2);
  await timers.tick(3000);
  assert.equal(transport.calls, 3);
});

test('start on a hidden page sends no requests', async () => {
  const { monitor, transport, timers, visibility } = setup({ visible: false });
  monitor.start();
  await timers.tick(10000);
  assert.equal(transport.calls, 0);
  visibility.set(true);
  await timers.tick(1);
  assert.equal(transport.calls, 1);
});

test('settings change: checking immediately, a check after 400 ms (not 3 s), a series of edits — one check', async () => {
  const { monitor, transport, timers } = setup();
  monitor.start();
  await timers.tick(1000);
  assert.equal(transport.calls, 1);
  transport.reply = () => { throw new TransportError('x', { kind: 'auth', status: 403 }); };
  monitor.configChanged();
  assert.equal(monitor.status().status, 'checking');
  await timers.tick(300);
  monitor.configChanged();
  await timers.tick(300);
  assert.equal(transport.calls, 1, 'debounce has not expired yet');
  await timers.tick(150);
  assert.equal(transport.calls, 2);
  assert.equal(monitor.status().status, 'auth');
});

test('settings became empty: unconfigured immediately, no request', async () => {
  const { monitor, transport, timers, setCfg } = setup();
  monitor.start();
  await timers.tick(1);
  setCfg(false);
  monitor.configChanged();
  assert.equal(monitor.status().status, 'unconfigured');
  await timers.tick(10000);
  assert.equal(transport.calls, 1);
  setCfg(true);
  monitor.configChanged();
  await timers.tick(500);
  assert.equal(monitor.status().status, 'ok');
});

test('the response to old settings is discarded', async () => {
  const { monitor, transport, timers } = setup();
  transport.hang = true;
  monitor.start();
  await timers.tick(100);
  transport.hang = false;
  transport.reply = () => ({ server: '2', printer: 'Operational' });
  monitor.configChanged();
  assert.equal(transport.aborts, 1);
  await timers.tick(500);
  assert.equal(monitor.status().detail, 'OctoPrint 2, принтер: Operational');
  assert.equal(transport.maxInflight, 1);
});

test('checkNow joins the request in flight; no key in the text', async () => {
  const { monitor, transport, timers } = setup();
  transport.reply = () => { throw new TransportError('OctoPrint отклонил ключ (401)', { kind: 'auth', status: 401 }); };
  monitor.start();
  const a = monitor.checkNow(), b = monitor.checkNow();
  await timers.tick(1);
  await Promise.all([a, b]);
  assert.equal(transport.calls, 1);
  assert.doesNotMatch(JSON.stringify(monitor.status()), /SECRET/);
});

test('stop: timers cleared, visibility unsubscribed', async () => {
  const { monitor, transport, timers, visibility } = setup();
  monitor.start();
  await timers.tick(1);
  monitor.stop();
  assert.equal(timers.pending(), 0);
  visibility.set(false); visibility.set(true);
  await timers.tick(10000);
  assert.equal(transport.calls, 1);
});
