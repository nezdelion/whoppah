// OctoPrint printer connection feed (standalone): a raw WebSocket to /sockjs/websocket without the SockJS client.
// Login: POST /api/login {"passive": true} with X-Api-Key → {name, session}; over the socket {"auth": "name:session"}.
// The session lives only in this function's memory: not written to storage, log or UI; the key is not printed anywhere either.
// Subscribing to the connection log (logs) requires the MONITOR_TERMINAL permission; without it messages have no logs field.
//
// PrinterFeed {
//   state():          'off' | 'connecting' | 'live' | 'forbidden' | 'unavailable'
//   detail():         reason text for the UI
//   readPosition():   Promise<{x, y, z, epochXY, epochZ}>
//   readLimits():     Promise<{enabled, min: {x, y, z}, max: {x, y, z}}>
//   session():        number — the connection session number (grows on every transition to "connected"); a limits read result is valid only within it
//   epoch():          {xy, z} — coordinate epochs (sheet corner and touch): foreign G28/G92 advance only the affected axes,
//                     a printer reconnect and a feed drop — both
//   positionKnown():  boolean — false after a foreign move, a drop, printing; true after a read
//   markHomed():      accept Home as done on the user's word (coordinate epochs do not change; reset by the same events)
//   homed():          {xy, z} — whether G28 (own or foreign) happened on the axes since (re)connecting to the printer; a drop and feed stop reset it
//   command(lines):   send commands via REST and record them as "own"
//   onChange(fn):     unsubscribe
//   start(), stop(), configChanged()
// }
// Read errors are TransportError; kind: busy | offline | timeout | stale | unsupported | nocoords | http | conflict | auth | network.
import { TransportError } from './transport.js';
import { positionError } from './octoprint-position.js';

export const READ_TIMEOUT_MS = 10000;
export const EXPECT_TTL_MS = 10000;
export const CONNECT_TIMEOUT_MS = 10000;
export const BACKOFF_MAX_MS = 30000;
export const DEBOUNCE_MS = 500;

export const FEED_LABELS = {
  off: 'выключен', connecting: 'подключение…', live: 'на связи', forbidden: 'нет доступа', unavailable: 'недоступно',
};

const HINT_CORS = 'нет соединения с потоком: включите api.allowCrossOrigin в OctoPrint (или прокси не пропускает WebSocket)';
const EVENTS = ['Connected', 'Disconnected'];

const defaultTimers = {
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id), now: () => Date.now(),
};

const isBusyFlags = (f) => !!f && !!(f.printing || f.paused || f.pausing || f.resuming || f.cancelling || f.finishing);

/**
 * @param getBaseUrl   () => OctoPrint address
 * @param getKey       () => API key
 * @param sendCommands (lines) => Promise — REST POST /api/printer/command (a transport without tracking)
 * @param visibility   { visible(), subscribe(fn) → unsubscribe }
 * @param replies      log line parsing — core/marlin-replies.js (the transport layer does not look into core, the module is passed by app)
 */
export function createPrinterFeed({
  getBaseUrl, getKey, sendCommands, replies, visibility = { visible: () => true, subscribe: () => () => {} },
  timers = defaultTimers, WebSocket: WS = globalThis.WebSocket, fetch: fetchFn = globalThis.fetch && globalThis.fetch.bind(globalThis),
  readTimeoutMs = READ_TIMEOUT_MS, expectTtlMs = EXPECT_TTL_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS, debounceMs = DEBOUNCE_MS,
}) {
  const {
    FEED_LOG_FILTER, parseLogLine, normalizeSent, classifySent, epochParts, parsePosition, parseLimits, parseMarker, parseUnknownCommand,
  } = replies;
  const T = { ...defaultTimers, ...timers };
  const listeners = new Set();
  let state = 'off', detail = 'укажите адрес и API-ключ OctoPrint';
  let epochXY = 0, epochZ = 0, known = false, busy = false;
  let homedXY = false, homedZ = false; // G28 per axes since (re)connecting; initially — none
  let gen = 0, sessionN = 0, loginAbort = null, ws = null, wasLive = false, attempt = 0, retryTimer = null, connectTimer = null, debounceTimer = null;
  let started = false, offVisibility = () => {};
  let expected = [], active = null, ridCounter = 0;

  const base = () => String(getBaseUrl() || '').replace(/\/+$/, '');
  const configured = () => /^https?:\/\/[^\s/?#]+/i.test(base()) && !!getKey();
  const snapshot = () => `${state}|${detail}|${epochXY}|${epochZ}|${known}|${homedXY}|${homedZ}`;
  const change = (fn) => {
    const before = snapshot();
    fn();
    if (snapshot() !== before) for (const l of [...listeners]) l();
  };
  const setState = (s, d) => change(() => { state = s; detail = d; });
  // parts — { xy, z }: which counters to advance (both by default); the head position is unknown after this
  // Without parts (reconnect, drop, denial) homing is also considered not done.
  const bump = (parts) => {
    if (!parts) { parts = { xy: true, z: true }; homedXY = homedZ = false; }
    if (parts.xy) epochXY++;
    if (parts.z) epochZ++;
    known = false;
  };

  function failRead(err) {
    if (active) finish(active, err);
  }

  function finish(rec, err, value) {
    if (active !== rec) return;
    T.clearTimeout(rec.timer);
    active = null;
    if (err) { rec.reject(err); return; }
    // a read is stale if any of the counters changed (the simplest rule: the read does not know which part the caller needs)
    if (epochXY !== rec.epoch0.xy || epochZ !== rec.epoch0.z) { rec.reject(positionError('stale')); return; }
    if (!value) { rec.reject(positionError('nocoords', 'position', rec.kind === 'limits' ? 'принтер не прислал границы прошивки (M211)' : undefined)); return; }
    if (rec.kind === 'position') change(() => { known = true; });
    rec.resolve(rec.kind === 'position' ? { ...value, epochXY: rec.epoch0.xy, epochZ: rec.epoch0.z } : value);
  }

  // --- log line parsing ---

  function onRecv(text) {
    if (!active) return;
    const marker = parseMarker(text);
    if (marker) {
      if (marker.rid !== active.rid) return;
      if (marker.kind === 'B') { active.inside = true; active.value = null; active.text = ''; return; }
      if (active.inside) finish(active, null, active.value);
      return;
    }
    const unknown = parseUnknownCommand(text);
    if (unknown && unknown.includes(`PLT_B ${active.rid}`)) { finish(active, positionError('unsupported')); return; }
    if (!active.inside) return; // lines before the start marker belong to foreign requests
    // M211 on Marlin 2.1 replies with two lines ("M211 S1 ; ON", "Min: … Max: …"): the limits are parsed from the accumulated text
    const v = active.kind === 'position' ? parsePosition(text) : parseLimits(active.text = `${active.text || ''}\n${text}`);
    if (v) active.value = v;
  }

  function onSend(text) {
    const cmd = normalizeSent(text);
    const kind = classifySent(cmd);
    if (kind === 'other') return;
    const now = T.now();
    expected = expected.filter((e) => now - e.at <= expectTtlMs);
    const i = expected.findIndex((e) => e.text === cmd);
    const mark = () => { // homing is done by our own G28 (the Home button) as well as by a foreign one
      const parts = epochParts(cmd);
      if (parts.xy) homedXY = true;
      if (parts.z) homedZ = true;
    };
    if (i >= 0) { expected.splice(i, 1); if (kind === 'home') change(mark); return; } // own command
    change(() => {
      if (kind === 'home') mark();
      if (kind === 'home' || kind === 'setpos') {
        const parts = epochParts(cmd);
        if (parts.xy || parts.z) bump(parts); // G92 E0 does not shift coordinates
      }
      else if (kind === 'move') known = false;
    });
  }

  function processLogs(lines) {
    for (const line of lines) {
      const p = parseLogLine(line);
      if (!p) continue;
      if (p.dir === 'recv') onRecv(p.text); else onSend(p.text);
    }
  }

  function subscribeMessage() {
    // the log is not needed while printing: we do not stream every line of the file
    return JSON.stringify({ subscribe: { state: { logs: busy ? false : FEED_LOG_FILTER, messages: false }, events: EVENTS } });
  }

  function onMessage(my, data) {
    if (my !== gen) return;
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.reauthRequired) { drop(my, 'сессия OctoPrint устарела, вхожу заново'); return; }
    if (msg.event) {
      const type = msg.event.type;
      if (type === 'Connected' || type === 'Disconnected') { change(() => bump()); failRead(positionError('stale')); }
      return;
    }
    const isHistory = !!msg.history, payload = msg.history || msg.current;
    if (!payload) return;
    if (!Array.isArray(payload.logs)) { // the log is delivered only with the MONITOR_TERMINAL permission
      forbid(my, 'у ключа нет права «Терминал» (MONITOR_TERMINAL): поток связи недоступен');
      return;
    }
    const wasBusy = busy;
    if (payload.state && payload.state.flags) busy = isBusyFlags(payload.state.flags);
    if (state !== 'live') {
      T.clearTimeout(connectTimer); connectTimer = null;
      attempt = 0; wasLive = true; sessionN++;
      setState('live', 'поток связи с принтером на связи');
    }
    if (busy !== wasBusy) {
      expected = [];
      if (busy) failRead(positionError('busy'));
      else change(() => { known = false; }); // printing ended: the head is somewhere
      if (ws) ws.send(subscribeMessage());
    }
    // history is the log of the past, not new commands: only current messages and only outside printing
    if (!isHistory && !busy) processLogs(payload.logs);
  }

  // --- connection ---

  function closeSocket() {
    T.clearTimeout(connectTimer); connectTimer = null;
    if (loginAbort) { const a = loginAbort; loginAbort = null; a.abort(); } // login in flight: cancel it, its late response is not needed
    if (ws) {
      const s = ws;
      ws = null;
      s.onopen = s.onmessage = s.onclose = s.onerror = null;
      try { s.close(); } catch (e) { /* already closed */ }
    }
  }

  function forbid(my, text) {
    if (my !== gen) return;
    gen++;
    closeSocket();
    change(() => { bump(); state = 'forbidden'; detail = text; });
    failRead(positionError('offline'));
  }

  function scheduleRetry() {
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** attempt);
    attempt++;
    retryTimer = T.setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  /** A drop or error: the coordinate epoch advances if the feed was already connected; retry with an increasing pause. */
  function drop(my, text) {
    if (my !== gen) return;
    gen++;
    closeSocket();
    const was = wasLive;
    wasLive = false;
    change(() => {
      if (was) bump();
      state = was ? 'connecting' : 'unavailable';
      detail = was ? `связь с потоком потеряна, переподключаюсь (${text})` : text;
    });
    failRead(positionError('offline'));
    if (started && visibility.visible()) scheduleRetry();
  }

  async function connect() {
    const my = ++gen;
    T.clearTimeout(retryTimer); retryTimer = null;
    closeSocket();
    if (!started) return;
    if (!visibility.visible()) { setState('off', 'страница скрыта'); return; }
    if (!configured()) { setState('off', 'укажите адрес и API-ключ OctoPrint'); return; }
    setState('connecting', 'подключение к потоку…');
    // one deadline for the whole procedure: login, reading the response, opening the socket, auth/subscription and the first message
    connectTimer = T.setTimeout(() => drop(my, 'поток не ответил за 10 с'), connectTimeoutMs);
    const ac = new AbortController();
    loginAbort = ac;
    let login;
    try {
      const res = await fetchFn(`${base()}/api/login`, {
        signal: ac.signal, method: 'POST', headers: { 'X-Api-Key': getKey(), 'Content-Type': 'application/json' }, body: JSON.stringify({ passive: true }),
      });
      if (my !== gen) return;
      if (res.status === 400 || res.status === 401 || res.status === 403) { forbid(my, `ключ не принят (${res.status}): поток недоступен`); return; }
      if (!res.ok) { drop(my, `OctoPrint ответил ${res.status} на вход`); return; }
      login = await res.json();
    } catch (e) {
      drop(my, HINT_CORS); // on cancel my is already stale — drop does nothing
      return;
    }
    if (my !== gen) return;
    if (loginAbort === ac) loginAbort = null;
    if (!login || typeof login.name !== 'string' || typeof login.session !== 'string') { drop(my, 'OctoPrint не выдал сессию для потока'); return; }
    const auth = `${login.name}:${login.session}`; // in memory only, to the socket only
    login = null;
    let socket;
    try {
      socket = new WS(`${base().replace(/^http/i, 'ws')}/sockjs/websocket`);
    } catch (e) { drop(my, HINT_CORS); return; }
    ws = socket;
    socket.onopen = () => {
      if (my !== gen) return;
      socket.send(JSON.stringify({ auth }));
      socket.send(subscribeMessage());
    };
    socket.onmessage = (e) => onMessage(my, e.data);
    socket.onerror = () => {};
    socket.onclose = () => drop(my, wasLive || state === 'live' ? 'сокет закрыт' : HINT_CORS);
  }

  function restart(reconnect) {
    gen++;
    T.clearTimeout(retryTimer); retryTimer = null;
    closeSocket();
    const was = wasLive;
    wasLive = false;
    attempt = 0;
    change(() => { if (was || known) bump(); homedXY = homedZ = false; });
    failRead(positionError('offline'));
    if (reconnect && started) connect();
  }

  const onVisibility = () => {
    if (!started) return;
    if (visibility.visible()) { if (state === 'off' || state === 'unavailable' || state === 'connecting') connect(); }
    else { restart(false); setState('off', 'страница скрыта'); }
  };

  // --- reading by markers ---

  function read(kind, query) {
    if (state !== 'live') return Promise.reject(positionError('offline', 'position', 'поток связи с принтером не на связи'));
    if (busy || active) return Promise.reject(positionError('busy'));
    const rid = `${(T.now()).toString(36)}${(++ridCounter).toString(36)}`;
    return new Promise((resolve, reject) => {
      const rec = { kind, rid, inside: false, value: null, epoch0: { xy: epochXY, z: epochZ }, resolve, reject, timer: null };
      rec.timer = T.setTimeout(() => finish(rec, positionError('timeout')), readTimeoutMs);
      active = rec;
      command([`M118 PLT_B ${rid}`, 'M400', query, `M118 PLT_E ${rid}`]).catch((e) => {
        const err = e instanceof TransportError && e.kind === 'conflict' ? positionError('offline') : e;
        finish(rec, err);
      });
    });
  }

  /** Record the commands in the "own" queue and send via REST. */
  function command(lines) {
    const now = T.now();
    const mine = [];
    for (const l of lines) if (classifySent(l) !== 'other') { const e = { text: normalizeSent(l), at: now }; mine.push(e); expected.push(e); }
    return Promise.resolve(sendCommands(lines)).catch((err) => {
      // OctoPrint refused (4xx): the command was definitely not queued — we remove exactly our entries, otherwise
      // an identical foreign command from the terminal within the TTL would pass for "own". A network error/timeout/cancel and 5xx
      // (a proxy may have answered when OctoPrint had already accepted) are ambiguous: the command may have gone out, we keep the entries
      // (an extra one expires by TTL, while a lost one would give a false "foreign" G28).
      if (err instanceof TransportError && err.status >= 400 && err.status < 500) expected = expected.filter((e) => !mine.includes(e));
      throw err;
    });
  }

  return {
    state: () => state,
    detail: () => detail,
    epoch: () => ({ xy: epochXY, z: epochZ }),
    session: () => sessionN,
    positionKnown: () => known,
    homed: () => ({ xy: homedXY, z: homedZ }),
    /** The user confirmed that Home is already done (on the printer screen, in OctoPrint, before the page was opened): both axis groups, epochs untouched. Reset as usual. */
    markHomed() { change(() => { homedXY = homedZ = true; }); },
    readPosition: () => read('position', 'M114'),
    readLimits: () => read('limits', 'M211'),
    command,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      if (started) return;
      started = true;
      offVisibility = visibility.subscribe(onVisibility);
      connect();
    },
    stop() {
      started = false;
      offVisibility();
      T.clearTimeout(debounceTimer); debounceTimer = null;
      restart(false);
      setState('off', 'выключен');
    },
    /** The address or key changed: again, after a pause (fields are typed character by character); forbidden is cleared. */
    configChanged() {
      if (!started) return;
      restart(false);
      setState(configured() ? 'connecting' : 'off', configured() ? 'подключение к потоку…' : 'укажите адрес и API-ключ OctoPrint');
      T.clearTimeout(debounceTimer);
      debounceTimer = T.setTimeout(() => { debounceTimer = null; connect(); }, debounceMs);
    },
  };
}

/**
 * PositionSource for standalone on top of the feed: position reading, coordinate epoch and writing the captured calibration.
 * @param calibration { get(): doc, patch(changes): Promise } — in standalone the app stores the calibration (the transport layer
 *   does not access storage, it comes as a parameter). The part epoch is compared with the feed counter at save time:
 *   a mismatch is `stale`, the calibration does not change. The order is as in the plugin: the values and the part epoch are written together.
 * Additionally for the UI: link() — feed state and homing, onChange(fn).
 */
export function createFeedPositionSource(feed, { calibration = null } = {}) {
  const need = () => { if (!calibration) throw new Error('хранилище калибровки не подключено'); return calibration; };
  const fresh = (part, epoch) => { if (epoch !== feed.epoch()[part]) throw positionError('stale'); };
  return {
    id: 'octoprint-feed',
    read: () => feed.readPosition(),
    epoch: async () => feed.epoch(),
    markHomed: () => feed.markHomed(),
    link: () => ({ state: feed.state(), detail: feed.detail(), homed: feed.homed() }),
    onChange: (fn) => feed.onChange(fn),
    async saveCorner({ x, y, epoch }) {
      const c = need();
      fresh('xy', epoch);
      await c.patch({ cornerX: x, cornerY: y, epochXY: epoch });
      return c.get();
    },
    async saveTouch({ zTouch, epoch }) {
      const c = need();
      fresh('z', epoch);
      await c.patch({ zTouch, epochZ: epoch });
      return c.get();
    },
    async confirm(part) {
      const c = need();
      if (part !== 'xy' && part !== 'z') throw new Error(`неизвестная часть калибровки: ${part}`);
      // confirmation does not change the values: the calibration date stays the same
      await c.patch({ [part === 'xy' ? 'epochXY' : 'epochZ']: feed.epoch()[part], updatedAt: c.get().updatedAt });
      return c.get();
    },
  };
}
