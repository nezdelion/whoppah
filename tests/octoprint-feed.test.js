import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrinterFeed, createFeedPositionSource } from '../src/transport/octoprint-feed.js';
import { TransportError } from '../src/transport/transport.js';
import * as replies from '../src/core/marlin-replies.js';

const { FEED_LOG_FILTER } = replies;
import { clock, FakeWebSocket, current, history, fakeLogin } from './helpers/fake-feed.js';

function setup({ url = 'http://octopi.local', key = 'KEY-SECRET', login = fakeLogin(), visible = true, sendFail = null } = {}) {
  FakeWebSocket.instances = [];
  const t = clock();
  const env = { url, key, visible, listeners: new Set() };
  const sent = [];
  const feed = createPrinterFeed({
    getBaseUrl: () => env.url, getKey: () => env.key,
    replies,
    sendCommands: async (lines) => { sent.push([...lines]); if (env.sendFail) throw env.sendFail; },
    visibility: { visible: () => env.visible, subscribe: (fn) => { env.listeners.add(fn); return () => env.listeners.delete(fn); } },
    timers: t, WebSocket: FakeWebSocket, fetch: login.fetch,
  });
  env.sendFail = sendFail;
  env.setVisible = (v) => { env.visible = v; for (const fn of [...env.listeners]) fn(); };
  const ws = () => FakeWebSocket.last();
  /** start → socket open → history arrived: the feed is connected */
  async function live(flags) {
    feed.start();
    await t.flush();
    ws().open();
    ws().push(history([], flags));
    await t.flush();
    assert.equal(feed.state(), 'live');
  }
  return { feed, t, env, sent, login, ws, live };
}

const ridOf = (sent) => /PLT_B (\S+)/.exec(sent[sent.length - 1][0])[1];

test('connection: key login, ws address, auth and a subscription with a filter; connected after the first message', async () => {
  const s = setup();
  s.feed.start();
  await s.t.flush();
  assert.equal(s.feed.state(), 'connecting');
  assert.equal(s.login.calls.length, 1);
  assert.equal(s.login.calls[0].url, 'http://octopi.local/api/login');
  assert.equal(s.login.calls[0].method, 'POST');
  assert.equal(s.login.calls[0].headers['X-Api-Key'], 'KEY-SECRET');
  assert.deepEqual(JSON.parse(s.login.calls[0].body), { passive: true });
  assert.equal(s.ws().url, 'ws://octopi.local/sockjs/websocket');
  s.ws().open();
  assert.deepEqual(s.ws().sent[0], { auth: 'plot:SESSION-SECRET' });
  assert.deepEqual(s.ws().sent[1], { subscribe: { state: { logs: FEED_LOG_FILTER, messages: false }, events: ['Connected', 'Disconnected'] } });
  assert.equal(s.feed.state(), 'connecting');
  s.ws().push(history());
  assert.equal(s.feed.state(), 'live');
  s.feed.stop();
});

test('https gives wss, a trailing slash in the address does not interfere, the path is preserved', async () => {
  const s = setup({ url: 'https://host.example/octoprint/' });
  s.feed.start();
  await s.t.flush();
  assert.equal(s.login.calls[0].url, 'https://host.example/octoprint/api/login');
  assert.equal(s.ws().url, 'wss://host.example/octoprint/sockjs/websocket');
  s.feed.stop();
});

test('neither the session nor the key appears in the state text', async () => {
  const s = setup();
  await s.live();
  const texts = [s.feed.detail()];
  s.login.fail = true;
  s.ws().drop();
  await s.t.tick(1000);
  texts.push(s.feed.detail());
  for (const x of texts) assert.doesNotMatch(x, /SESSION-SECRET|KEY-SECRET/);
  s.feed.stop();
});

test('not configured: off, no connections; after configuring — it connects', async () => {
  const s = setup({ key: '' });
  s.feed.start();
  await s.t.flush();
  assert.equal(s.feed.state(), 'off');
  assert.equal(s.login.calls.length, 0);
  s.env.key = 'K';
  s.feed.configChanged();
  assert.equal(s.feed.state(), 'connecting');
  await s.t.tick(600);
  assert.equal(s.login.calls.length, 1);
  s.feed.stop();
});

for (const status of [400, 401, 403]) {
  test(`login returned ${status}: no access, no retries until the settings change`, async () => {
    const s = setup({ login: fakeLogin({ status, body: {} }) });
    s.feed.start();
    await s.t.flush();
    assert.equal(s.feed.state(), 'forbidden');
    assert.match(s.feed.detail(), new RegExp(`\\(${status}\\)`));
    await s.t.tick(120000);
    assert.equal(s.login.calls.length, 1);
    assert.equal(FakeWebSocket.instances.length, 0);
    s.login.status = 200; s.login.body = { name: 'plot', session: 'S' };
    s.feed.configChanged();
    await s.t.tick(600);
    assert.equal(s.login.calls.length, 2);
    assert.equal(s.feed.state(), 'connecting');
    s.feed.stop();
  });
}

test('no connection to the server: unavailable with a CORS hint, retry with an increasing pause up to 30 s', async () => {
  const s = setup({ login: fakeLogin({ fail: true }) });
  s.feed.start();
  await s.t.flush();
  assert.equal(s.feed.state(), 'unavailable');
  assert.match(s.feed.detail(), /allowCrossOrigin/);
  const at = [];
  let seen = s.login.calls.length;
  for (let ms = 0; ms < 200000 && at.length < 8; ms += 500) {
    await s.t.tick(500);
    if (s.login.calls.length > seen) { at.push(s.t.time); seen = s.login.calls.length; }
  }
  const gaps = at.map((v, i) => v - (i ? at[i - 1] : 0));
  assert.deepEqual(gaps.slice(1, 6), [2000, 4000, 8000, 16000, 30000]);
  assert.ok(gaps.slice(5).every((g) => g <= 30000));
  s.feed.stop();
});

test('socket rejected (CORS): unavailable, retry', async () => {
  const s = setup();
  s.feed.start();
  await s.t.flush();
  s.ws().drop(); // the server closed the handshake
  assert.equal(s.feed.state(), 'unavailable');
  assert.match(s.feed.detail(), /allowCrossOrigin/);
  await s.t.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2);
  s.feed.stop();
});

test('the socket does not respond for 10 s: drop and retry', async () => {
  const s = setup();
  s.feed.start();
  await s.t.flush();
  await s.t.tick(10000);
  assert.equal(s.feed.state(), 'unavailable');
  assert.ok(s.ws().closed);
  s.feed.stop();
});

test('a drop after connected: the coordinate epoch grows, the position is unknown, reconnect, the pause is reset', async () => {
  const s = setup();
  await s.live();
  const e0 = s.feed.epoch();
  const p = s.feed.readPosition();
  await s.t.flush();
  s.ws().push(current(['Send: G0 X1', 'Recv: PLT_B ' + ridOf(s.sent)]));
  s.ws().drop();
  await assert.rejects(p, { kind: 'offline' });
  assert.equal(s.feed.state(), 'connecting');
  assert.equal(s.feed.epoch(), e0 + 1);
  assert.equal(s.feed.positionKnown(), false);
  await s.t.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2);
  s.ws().open();
  s.ws().push(history());
  await s.t.flush();
  assert.equal(s.feed.state(), 'live');
  s.ws().drop();
  await s.t.tick(1000); // the first pause again, not a doubled one
  assert.equal(FakeWebSocket.instances.length, 3);
  s.feed.stop();
});

test('a hidden page closes the connection, a visible one opens it', async () => {
  const s = setup();
  await s.live();
  const first = s.ws();
  const e0 = s.feed.epoch();
  s.env.setVisible(false);
  assert.ok(first.closed);
  assert.equal(s.feed.state(), 'off');
  assert.equal(s.feed.epoch(), e0 + 1);
  await s.t.tick(60000);
  assert.equal(FakeWebSocket.instances.length, 1);
  s.env.setVisible(true);
  await s.t.flush();
  assert.equal(FakeWebSocket.instances.length, 2);
  s.feed.stop();
});

test('no log in the messages (no terminal permission): no access, without retries', async () => {
  const s = setup();
  s.feed.start();
  await s.t.flush();
  s.ws().open();
  s.ws().push({ history: { state: { text: 'Operational', flags: {} } } });
  assert.equal(s.feed.state(), 'forbidden');
  assert.match(s.feed.detail(), /MONITOR_TERMINAL/);
  await s.t.tick(60000);
  assert.equal(FakeWebSocket.instances.length, 1);
  s.feed.stop();
});

test('reauthRequired: a new login and a new connection', async () => {
  const s = setup();
  await s.live();
  s.ws().push({ reauthRequired: { reason: 'stale' } });
  await s.t.tick(1000);
  assert.equal(s.login.calls.length, 2);
  assert.equal(FakeWebSocket.instances.length, 2);
  s.feed.stop();
});

test('printer events Connected/Disconnected raise the coordinate epoch', async () => {
  const s = setup();
  await s.live();
  const e0 = s.feed.epoch();
  s.ws().push({ event: { type: 'Disconnected', payload: null } });
  s.ws().push({ event: { type: 'Connected', payload: { port: 'VIRTUAL', baudrate: 0 } } });
  assert.equal(s.feed.epoch(), e0 + 2);
  s.ws().push({ event: { type: 'PrintStarted' } });
  assert.equal(s.feed.epoch(), e0 + 2);
  s.feed.stop();
});

test('onChange: called on a state and epoch change, unsubscribe works', async () => {
  const s = setup();
  let n = 0;
  const off = s.feed.onChange(() => n++);
  await s.live();
  assert.ok(n >= 2); // connecting, live
  const before = n;
  s.ws().push(current(['Send: G28']));
  assert.equal(n, before + 1);
  off();
  s.ws().push(current(['Send: G28']));
  assert.equal(n, before + 1);
  s.feed.stop();
});

// --- own and foreign commands ---

test('an own command (with line number and checksum) does not change the epoch; a foreign G28 does', async () => {
  const s = setup();
  await s.live();
  await s.feed.command(['G0 X10 Y10']);
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: N40 G0 X10 Y10*97']));
  assert.equal(s.feed.epoch(), e0);
  s.ws().push(current(['Send: N41 G28*12']));
  assert.equal(s.feed.epoch(), e0 + 1);
  s.feed.stop();
});

test('a foreign G92 raises the epoch; a foreign move and G91 — only unknown', async () => {
  const s = setup();
  await s.live();
  const src = createFeedPositionSource(s.feed);
  const readOk = async () => {
    const p = src.read();
    await s.t.flush();
    const rid = ridOf(s.sent);
    s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: X:1 Y:2 Z:3 E:0', `Recv: PLT_E ${rid}`]));
    return p;
  };
  await readOk();
  assert.equal(s.feed.positionKnown(), true);
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G0 X50']));
  assert.equal(s.feed.positionKnown(), false);
  assert.equal(s.feed.epoch(), e0);
  await readOk();
  s.ws().push(current(['Send: G91']));
  assert.equal(s.feed.positionKnown(), false);
  assert.equal(s.feed.epoch(), e0);
  await readOk();
  s.ws().push(current(['Send: G92 X0 Y0']));
  assert.equal(s.feed.epoch(), e0 + 1);
  assert.equal(s.feed.positionKnown(), false);
  s.feed.stop();
});

test('foreign G90 and M114/M211 queries do not affect coordinates', async () => {
  const s = setup();
  await s.live();
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G90', 'Send: M114', 'Send: M211']));
  assert.equal(s.feed.epoch(), e0);
  s.feed.stop();
});

test('an own command not seen within 10 s is dropped: the same one later is considered foreign', async () => {
  const s = setup();
  await s.live();
  await s.feed.command(['G28']);
  await s.t.tick(10001);
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28']));
  assert.equal(s.feed.epoch(), e0 + 1);
  s.feed.stop();
});

test('an own command is dropped one at a time: two sends — two matches, the third is foreign', async () => {
  const s = setup();
  await s.live();
  await s.feed.command(['G28']);
  await s.feed.command(['G28']);
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28', 'Send: G28']));
  assert.equal(s.feed.epoch(), e0);
  s.ws().push(current(['Send: G28']));
  assert.equal(s.feed.epoch(), e0 + 1);
  s.feed.stop();
});

test('the log from history is not analyzed as foreign commands', async () => {
  const s = setup();
  s.feed.start();
  await s.t.flush();
  s.ws().open();
  s.ws().push(history(['Send: G28', 'Send: G92 X0', 'Send: G0 X1']));
  assert.equal(s.feed.epoch(), 0);
  s.feed.stop();
});

test('printing: Send lines are not analyzed, the log subscription is dropped; after printing the position is unknown', async () => {
  const s = setup();
  await s.live();
  const src = createFeedPositionSource(s.feed);
  const p = src.read();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: X:1 Y:2 Z:3', `Recv: PLT_E ${rid}`]));
  await p;
  assert.equal(s.feed.positionKnown(), true);
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28', 'Send: G1 X5'], { printing: true }));
  assert.equal(s.feed.epoch(), e0);
  assert.equal(s.feed.positionKnown(), true);
  assert.deepEqual(s.ws().sent[s.ws().sent.length - 1].subscribe.state.logs, false);
  await assert.rejects(s.feed.readPosition(), { kind: 'busy' });
  s.ws().push(current(['Send: G1 X6'], { printing: true }));
  assert.equal(s.feed.epoch(), e0);
  s.ws().push(current([], { printing: false }));
  assert.equal(s.feed.positionKnown(), false);
  assert.equal(s.ws().sent[s.ws().sent.length - 1].subscribe.state.logs, FEED_LOG_FILTER);
  s.feed.stop();
});

// --- reading position and limits ---

test('readPosition: commands and result between own markers; foreign lines and markers are not used', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  assert.deepEqual(s.sent[0], [`M118 PLT_B ${rid}`, 'M400', 'M114', `M118 PLT_E ${rid}`]);
  const e0 = s.feed.epoch();
  s.ws().push(current([
    'Recv: X:99.00 Y:99.00 Z:99.00 E:0.00',       // before the marker — a foreign request
    'Recv: PLT_B other', 'Recv: X:77 Y:77 Z:77',  // a marker with a foreign rid
    `Send: M118 PLT_B ${rid}`, `Recv: PLT_B ${rid}`, 'Recv: ok',
    'Send: M114', 'Recv: X:10.00 Y:20.00 Z:5.00 E:0.00 Count X:800 Y:1600 Z:2000',
    `Send: M118 PLT_E ${rid}`, `Recv: PLT_E ${rid}`,
    'Recv: X:55 Y:55 Z:55',                         // after the end
  ]));
  assert.deepEqual(await p, { x: 10, y: 20, z: 5, epoch: e0 });
  assert.equal(s.feed.epoch(), e0);
  assert.equal(s.feed.positionKnown(), true);
  s.feed.stop();
});

test('readPosition: lines arrive in batches in different messages; the last coordinate line is taken', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: ok X:1 Y:1 Z:1 E:0']));
  s.ws().push(current(['Recv: ok X:3.5 Y:4.5 Z:6 E:0', `Recv: echo:PLT_E ${rid}`]));
  assert.deepEqual(await p, { x: 3.5, y: 4.5, z: 6, epoch: 0 });
  s.feed.stop();
});

test('readPosition: a timeout after 10 s, the next read is possible', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  const failed = assert.rejects(p, { kind: 'timeout' });
  await s.t.tick(10000);
  await failed;
  const q = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: X:1 Y:2 Z:3', `Recv: PLT_E ${rid}`]));
  assert.equal((await q).z, 3);
  s.feed.stop();
});

test('readPosition: no coordinate line between the markers — nocoords', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, `Recv: PLT_E ${rid}`]));
  await assert.rejects(p, { kind: 'nocoords' });
  s.feed.stop();
});

test('readPosition: the epoch grew during the read — stale (a foreign G28 and a printer event)', async () => {
  const s = setup();
  await s.live();
  let p = s.feed.readPosition();
  await s.t.flush();
  let rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Send: G28', 'Recv: X:0 Y:0 Z:0', `Recv: PLT_E ${rid}`]));
  await assert.rejects(p, { kind: 'stale' });
  p = s.feed.readPosition();
  await s.t.flush();
  s.ws().push({ event: { type: 'Disconnected', payload: null } });
  await assert.rejects(p, { kind: 'stale' });
  s.feed.stop();
});

test('readPosition: one read at a time (busy), without a feed — offline', async () => {
  const s = setup();
  await assert.rejects(s.feed.readPosition(), { kind: 'offline' });
  await s.live();
  const p = s.feed.readPosition();
  await assert.rejects(s.feed.readPosition(), { kind: 'busy' });
  await assert.rejects(s.feed.readLimits(), { kind: 'busy' });
  const failed = assert.rejects(p, { kind: 'timeout' });
  await s.t.tick(10000);
  await failed;
  s.feed.stop();
});

test('readPosition: M118 unknown to the firmware — unsupported', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Send: M118 PLT_B ${rid}`, `Recv: echo:Unknown command: "M118 PLT_B ${rid}"`]));
  await assert.rejects(p, { kind: 'unsupported' });
  s.feed.stop();
});

test('readPosition: a REST error — offline for 409, the rest as is', async () => {
  const s = setup({ sendFail: new TransportError('409', { kind: 'conflict' }) });
  await s.live();
  await assert.rejects(s.feed.readPosition(), { kind: 'offline' });
  s.env.sendFail = new TransportError('нет ответа', { kind: 'network' });
  await assert.rejects(s.feed.readPosition(), { kind: 'network' });
  s.feed.stop();
});

test('readLimits: M211 between markers → {enabled, min, max}; without a line — nocoords', async () => {
  const s = setup();
  await s.live();
  let p = s.feed.readLimits();
  await s.t.flush();
  let rid = ridOf(s.sent);
  assert.deepEqual(s.sent[0], [`M118 PLT_B ${rid}`, 'M400', 'M211', `M118 PLT_E ${rid}`]);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: echo:Soft endstops: On   Min:  X0.00 Y0.00 Z0.00   Max:  X235.00 Y235.00 Z280.00', `Recv: PLT_E ${rid}`]));
  assert.deepEqual(await p, { enabled: true, min: { x: 0, y: 0, z: 0 }, max: { x: 235, y: 235, z: 280 } });
  assert.equal(s.feed.positionKnown(), false); // reading the limits does not change the position
  p = s.feed.readLimits();
  await s.t.flush();
  rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv: ok', `Recv: PLT_E ${rid}`]));
  await assert.rejects(p, { kind: 'nocoords' });
  s.feed.stop();
});

test('readLimits: a two-line M211 reply (Neptune 3 Pro)', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readLimits();
  await s.t.flush();
  const rid = ridOf(s.sent);
  s.ws().push(current([`Recv: PLT_B ${rid}`, 'Recv:   M211 S1 ; ON', 'Recv:   Min:  X-5.00 Y0.00 Z0.00   Max:  X235.00 Y232.00 Z283.00',
    'Recv: ok', `Recv: PLT_E ${rid}`]));
  assert.deepEqual(await p, { enabled: true, min: { x: -5, y: 0, z: 0 }, max: { x: 235, y: 232, z: 283 } });
  s.feed.stop();
});

test('own read commands are not considered foreign', async () => {
  const s = setup();
  await s.live();
  const p = s.feed.readPosition();
  await s.t.flush();
  const rid = ridOf(s.sent);
  const e0 = s.feed.epoch();
  s.ws().push(current([`Send: N7 M118 PLT_B ${rid}*11`, `Recv: PLT_B ${rid}`, 'Send: N9 M114*3', 'Recv: X:1 Y:2 Z:3', `Send: N10 M118 PLT_E ${rid}*4`, `Recv: PLT_E ${rid}`]));
  await p;
  assert.equal(s.feed.epoch(), e0);
  assert.equal(s.feed.positionKnown(), true);
  s.feed.stop();
});

test('createFeedPositionSource: read and epoch on top of the feed', async () => {
  const s = setup();
  await s.live();
  const src = createFeedPositionSource(s.feed);
  assert.equal(await src.epoch(), 0);
  s.ws().push(current(['Send: G28']));
  assert.equal(await src.epoch(), 1);
  s.feed.stop();
});

/** login fetch that does not respond; on abort by signal it rejects like a real one. */
function hangingLogin() {
  const f = { signals: [] };
  f.fetch = (url, init) => new Promise((resolve, reject) => {
    f.signals.push(init.signal);
    if (init.signal) init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  return f;
}

test('hung login: on the connection timeout the request is aborted, a retry with a pause is scheduled', async () => {
  const login = hangingLogin();
  const s = setup({ login });
  s.feed.start();
  await s.t.flush();
  assert.equal(s.feed.state(), 'connecting');
  assert.equal(login.signals.length, 1);
  await s.t.tick(10000);
  assert.equal(login.signals[0].aborted, true);
  assert.equal(s.feed.state(), 'unavailable');
  assert.equal(s.t.items.size, 1); // retry timer
  await s.t.tick(1000);
  assert.equal(login.signals.length, 2); // the retry happened
  s.feed.stop();
});

test('hung login: stop() aborts the request and clears the timers', async () => {
  const login = hangingLogin();
  const s = setup({ login });
  s.feed.start();
  await s.t.flush();
  s.feed.stop();
  assert.equal(login.signals[0].aborted, true);
  assert.equal(s.t.items.size, 0);
});

test('hung login: configChanged() aborts the request; a late response of the old attempt is ignored', async () => {
  const late = [];
  const s = setup({ login: { fetch: (url, init) => new Promise((resolve) => late.push({ init, resolve })) } });
  s.feed.start();
  await s.t.flush();
  s.feed.configChanged();
  assert.equal(late[0].init.signal.aborted, true);
  s.feed.stop();
  // a fetch that does not understand signal still responds late: the socket must not open
  late[0].resolve({ ok: true, status: 200, json: async () => ({ name: 'plot', session: 'X' }) });
  await s.t.flush();
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(s.feed.state(), 'off');
});

test('command: a server refusal (with a status) drops own entries; a foreign G28 after that is considered foreign', async () => {
  const s = setup({ sendFail: new TransportError('409', { kind: 'conflict', status: 409 }) });
  await s.live();
  await assert.rejects(s.feed.command(['G28']), { kind: 'conflict' });
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28']));
  assert.equal(s.feed.epoch(), e0 + 1);
  s.feed.stop();
});

test('command: only the entries of this call are dropped (by identity), not all with the same text', async () => {
  const s = setup();
  await s.live();
  await s.feed.command(['G28']); // sent successfully, waiting for the echo
  s.env.sendFail = new TransportError('409', { kind: 'conflict', status: 409 });
  await assert.rejects(s.feed.command(['G28']));
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28'])); // the echo of the first is own
  assert.equal(s.feed.epoch(), e0);
  s.ws().push(current(['Send: G28'])); // the second was not sent: this one is already foreign
  assert.equal(s.feed.epoch(), e0 + 1);
  s.feed.stop();
});

test('command: a network error is ambiguous — the entries stay (the command may have gone out)', async () => {
  const s = setup({ sendFail: new TransportError('нет ответа', { kind: 'network' }) });
  await s.live();
  await assert.rejects(s.feed.command(['G28']), { kind: 'network' });
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28']));
  assert.equal(s.feed.epoch(), e0);
  s.feed.stop();
});

test('session(): grows on every transition to connected', async () => {
  const s = setup();
  await s.live();
  const a = s.feed.session();
  s.ws().drop();
  await s.t.tick(1000);
  s.ws().open();
  s.ws().push(history());
  await s.t.flush();
  assert.equal(s.feed.state(), 'live');
  assert.ok(s.feed.session() > a);
  s.feed.stop();
});

test('command: 5xx is ambiguous (a proxy could have answered after acceptance) — the entries stay', async () => {
  const s = setup({ sendFail: new TransportError('502', { kind: 'http', status: 502 }) });
  await s.live();
  await assert.rejects(s.feed.command(['G28']));
  const e0 = s.feed.epoch();
  s.ws().push(current(['Send: G28']));
  assert.equal(s.feed.epoch(), e0);
  s.feed.stop();
});
