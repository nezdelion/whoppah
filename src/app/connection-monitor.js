// Live OctoPrint connection state: no DOM, the transport and timers are replaced in tests.
// Once every 3 s (while the page is visible) one transport.test() request — that is GET /api/version and GET /api/connection.
// Requests do not overlap; each is limited to 2.5 s (AbortController, if the transport accepts signal).
// Statuses: unconfigured | checking | ok | printer-off | auth | error. The API key does not appear in texts: only
// TransportError messages are used, and they do not contain it.

import { t, fmtNumber } from '../i18n/index.js';

export const INTERVAL_MS = 3000;
export const TIMEOUT_MS = 2500;
export const DEBOUNCE_MS = 400;

export const STATUS_LABELS = {
  get unconfigured() { return t('conn.status.unconfigured'); },
  get checking() { return t('conn.status.checking'); },
  get ok() { return t('conn.status.ok'); },
  get 'printer-off'() { return t('conn.status.printerOff'); },
  get auth() { return t('conn.status.auth'); },
  get error() { return t('conn.status.error'); },
};

const ACTIVE_PRINTER = /^(operational|printing|paused|pausing|resuming|finishing|cancelling|starting|transferring)/i;

/** The OctoPrint address is usable for a request: http(s)://host[…]. */
export function isValidBaseUrl(url) {
  return /^https?:\/\/[^\s/?#]+/i.test(String(url || '').trim());
}

/** The printer is in a working state (Operational, Printing, Paused, …), not Offline/Closed/Error/no data. */
export const printerIsUp = (printer) => !!printer && ACTIVE_PRINTER.test(printer);

const UNCONFIGURED = () => t('conn.configure');
const defaultTimers = {
  setInterval: (f, ms) => globalThis.setInterval(f, ms), clearInterval: (id) => globalThis.clearInterval(id),
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id),
  now: () => Date.now(),
};

/**
 * @param transport   { test({signal}?) → Promise<{server, printer}> }
 * @param configured  () => boolean — whether there is anything to check (in standalone: a valid address and a non-empty key)
 * @param visibility  { visible(), subscribe(fn) → unsubscribe }
 * @param describeAuth (status) => text for 401/403 (in plugin mode — about the session)
 */
export function createConnectionMonitor({
  transport, configured = () => transport.configured(), visibility = { visible: () => true, subscribe: () => () => {} },
  timers = defaultTimers, intervalMs = INTERVAL_MS, timeoutMs = TIMEOUT_MS, debounceMs = DEBOUNCE_MS,
  describeAuth = (status) => t('conn.keyRejected', { status }),
}) {
  const T = { ...defaultTimers, ...timers };
  let cur = { status: 'unconfigured', detail: UNCONFIGURED(), lastOk: null, server: null, printer: null };
  const listeners = new Set(), cycleListeners = new Set();
  let running = null, again = false, epoch = 0, ctrl = null, underlying = null;
  let interval = null, debounce = null, started = false, offVisibility = () => {};

  const status = () => ({ ...cur });
  const set = (patch) => {
    const next = { ...cur, ...patch };
    const changed = next.status !== cur.status || next.detail !== cur.detail;
    cur = next;
    if (changed) for (const fn of [...listeners]) fn(status());
  };

  function classify(r) {
    const server = r && r.server ? String(r.server) : '';
    const head = server ? `OctoPrint ${server}` : 'OctoPrint';
    const printer = r && r.printer ? String(r.printer) : null;
    if (printerIsUp(printer)) return { status: 'ok', detail: t('conn.printer', { head, printer }), lastOk: T.now(), server, printer };
    return { status: 'printer-off', detail: t('conn.printer', { head, printer: printer || t('conn.printerNone') }), lastOk: T.now(), server, printer };
  }

  function fromError(e) {
    if (e && e.kind === 'auth') return { status: 'auth', detail: describeAuth(e.status), server: null, printer: null };
    if (e && e.kind === 'network') return { status: 'error', detail: t('conn.noResponse'), server: null, printer: null };
    return { status: 'error', detail: (e && e.message) || t('conn.error'), server: null, printer: null };
  }

  async function once() {
    if (!configured()) { set({ status: 'unconfigured', detail: UNCONFIGURED(), server: null, printer: null }); return; }
    if (underlying) return; // the previous request (without signal support) is still pending — do not overlap
    if (cur.status === 'unconfigured') set({ status: 'checking', detail: t('conn.checking') });
    const myEpoch = epoch;
    const c = new AbortController();
    ctrl = c;
    let timedOut = false, tid = null;
    const timeout = new Promise((resolve) => { tid = T.setTimeout(() => { timedOut = true; c.abort(); resolve(); }, timeoutMs); });
    const call = Promise.resolve().then(() => transport.test({ signal: c.signal }));
    const settled = call.then(() => {}, () => {});
    underlying = settled;
    settled.then(() => { if (underlying === settled) underlying = null; });
    let result;
    try {
      const r = await Promise.race([call, timeout.then(() => { throw new Error('timeout'); })]);
      result = classify(r);
    } catch (e) {
      if (!timedOut && e && e.kind === 'aborted') result = null;
      else result = timedOut ? { status: 'error', detail: t('conn.timeout', { s: fmtNumber(timeoutMs / 1000, { maxFrac: 1 }) }), server: null, printer: null } : fromError(e);
    }
    T.clearTimeout(tid);
    if (ctrl === c) ctrl = null;
    if (!result || myEpoch !== epoch) return; // aborted or the settings changed — the response is stale
    set(result);
    for (const fn of [...cycleListeners]) fn(status());
  }

  async function loop() {
    do { again = false; await once(); } while (again && started);
  }

  /** Check now. If a request is already in flight, join it. */
  function checkNow() {
    if (!running) running = loop().finally(() => { running = null; });
    return running.then(status);
  }

  const tick = () => { if (!debounce && !running) checkNow(); };
  const arm = () => { if (started && !interval) interval = T.setInterval(tick, intervalMs); };
  const disarm = () => { if (interval) { T.clearInterval(interval); interval = null; } };
  const onVisibility = () => { if (visibility.visible()) { arm(); checkNow(); } else disarm(); };

  return {
    status,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Called after every completed check (not a stale one); convenient for hooking job polling to it. */
    onCycle(fn) { cycleListeners.add(fn); return () => cycleListeners.delete(fn); },
    checkNow,
    /** The address or key changed: immediately show "checking"/"not configured", check after debounceMs */
    configChanged() {
      epoch++;
      if (ctrl) ctrl.abort();
      if (debounce) T.clearTimeout(debounce);
      if (!configured()) { debounce = null; set({ status: 'unconfigured', detail: UNCONFIGURED(), server: null, printer: null }); return; }
      set({ status: 'checking', detail: t('conn.checking'), server: null, printer: null });
      debounce = T.setTimeout(() => {
        debounce = null;
        if (!started) return;
        again = true; // a request with old settings, if still finishing, yields to the new one
        checkNow();
      }, debounceMs);
    },
    start() {
      if (started) return;
      started = true;
      offVisibility = visibility.subscribe(onVisibility);
      if (visibility.visible()) { arm(); checkNow(); }
    },
    stop() {
      started = false;
      disarm();
      offVisibility();
      if (debounce) { T.clearTimeout(debounce); debounce = null; }
      if (ctrl) ctrl.abort();
    },
  };
}
