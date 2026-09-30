// Mocks for OctoPrint feed tests: virtual time, WebSocket, key login.

export function clock() {
  const t = { time: 0, now: () => t.time, items: new Map(), id: 1 };
  t.setTimeout = (fn, ms) => { const id = t.id++; t.items.set(id, { fn, at: t.time + ms }); return id; };
  t.clearTimeout = (id) => { t.items.delete(id); };
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  t.flush = flush;
  t.tick = async (ms) => {
    await flush();
    const end = t.time + ms;
    for (;;) {
      const due = [...t.items.entries()].filter(([, i]) => i.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, item] = due;
      t.time = item.at;
      t.items.delete(id);
      item.fn();
      await flush();
    }
    t.time = end;
    await flush();
  };
  return t;
}

export class FakeWebSocket {
  static instances = [];
  static last() { return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]; }
  constructor(url) { this.url = url; this.sent = []; this.closed = false; FakeWebSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  // server side
  open() { this.onopen && this.onopen(); }
  push(obj) { this.onmessage && this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  drop() { this.onclose && this.onclose({ code: 1006 }); }
}

const FLAGS = { printing: false, paused: false, pausing: false, resuming: false, cancelling: false, finishing: false };

/** Server message: current/history with the log and state flags. */
export const current = (logs, flags = {}) => ({ current: { state: { text: 'Operational', flags: { ...FLAGS, ...flags } }, logs, messages: [] } });
export const history = (logs = [], flags = {}) => ({ history: { state: { text: 'Operational', flags: { ...FLAGS, ...flags } }, logs, messages: [] } });

/** fetch for POST /api/login: status and body are set by a scenario; calls — requests without the key value in the test text. */
export function fakeLogin({ status = 200, body = { name: 'plot', session: 'SESSION-SECRET' }, fail = false } = {}) {
  const f = { calls: [], status, body, fail };
  f.fetch = async (url, init) => {
    f.calls.push({ url, method: init.method, headers: { ...init.headers }, body: init.body });
    if (f.fail) throw new TypeError('Failed to fetch');
    return { ok: f.status >= 200 && f.status < 300, status: f.status, json: async () => f.body, text: async () => JSON.stringify(f.body) };
  };
  return f;
}
