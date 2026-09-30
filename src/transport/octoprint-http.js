// OctoPrint REST over fetch. The auth method is set by the auth strategy (init/prepare/recover/describe).
import { TransportError } from './transport.js';

const NETWORK_HINT = 'нет ответа от OctoPrint: проверьте адрес и включён ли CORS в настройках API OctoPrint';

function errorFromStatus(status, body, operation) {
  const text = String(body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 401 || status === 403) return new TransportError(`OctoPrint отклонил запрос (${status})`, { kind: 'auth', operation, status });
  if (status === 409) return new TransportError(`OctoPrint не может выполнить операцию (409): принтер не подключён или занят${text ? ' — ' + text : ''}`, { kind: 'conflict', operation, status });
  return new TransportError(`OctoPrint ответил ${status}${text ? ': ' + text : ''}`, { kind: 'http', operation, status });
}

// sameOrigin: the address is intentionally empty (plugin, OctoPrint at the site root) — relative /api/... are correct and "configured" does not depend on the address.
export function createOctoPrintTransport({ getBaseUrl, auth, sameOrigin = false, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
  const base = () => String(getBaseUrl() || '').replace(/\/+$/, '');
  let initPromise = null;

  const ensureInit = () => {
    if (!initPromise) {
      initPromise = Promise.resolve(auth.init({ fetch: fetchFn })).catch((e) => {
        initPromise = null;
        throw e;
      });
    }
    return initPromise;
  };

  async function attemptOnce(method, path, { json, form, signal }, operation) {
    let request = { url: base() + path, method, headers: {}, body: undefined };
    if (json !== undefined) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(json);
    } else if (form) request.body = form;
    request = await auth.prepare(request);
    let res;
    try {
      res = await fetchFn(request.url, {
        method: request.method, headers: request.headers, body: request.body,
        ...(request.credentials ? { credentials: request.credentials } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (e) {
      if (signal && signal.aborted) throw new TransportError('запрос прерван', { kind: 'aborted', operation });
      throw new TransportError(NETWORK_HINT, { kind: 'network', operation });
    }
    const text = await res.text();
    if (!res.ok) throw errorFromStatus(res.status, text, operation);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new TransportError('OctoPrint вернул не JSON', { kind: 'http', operation, status: res.status });
    }
  }

  async function request(method, path, body = {}, operation = path) {
    await ensureInit();
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptOnce(method, path, body, operation);
      } catch (e) {
        if (!(e instanceof TransportError) || e.kind === 'aborted') throw e;
        const decision = await auth.recover(e, attempt);
        if (decision === 'retry' && attempt === 0) continue;
        const described = auth.describe(e);
        if (described) e.message = described;
        throw e;
      }
    }
  }

  const post = (path, json, operation) => request('POST', path, { json }, operation);

  return {
    id: 'octoprint-http',
    label: 'OctoPrint (REST)',
    configured: () => (sameOrigin || !!base()) && (auth.ready ? auth.ready() : true),

    /** signal (AbortSignal) — optional: aborts check requests (used by the connection monitor). */
    async test({ signal } = {}) {
      const v = await request('GET', '/api/version', { signal }, 'test');
      let printer = null;
      try {
        const c = await request('GET', '/api/connection', { signal }, 'test');
        printer = c && c.current ? c.current.state : null;
      } catch (e) {
        if (e.kind === 'aborted') throw e;
        /* printer state — an optional part of the check */
      }
      return { server: v.server, printer };
    },

    async upload(name, gcode, { select = true, print = false } = {}) {
      const form = new FormData();
      form.append('file', new Blob([gcode], { type: 'text/plain' }), name);
      form.append('select', select ? 'true' : 'false');
      form.append('print', print ? 'true' : 'false');
      await request('POST', '/api/files/local', { form }, 'upload');
    },

    async job() {
      const j = await request('GET', '/api/job', {}, 'job');
      const p = j.progress || {};
      return {
        state: j.state,
        file: j.job && j.job.file ? j.job.file.name || null : null,
        progress: p.completion ?? null,
        timeLeft: p.printTimeLeft ?? null,
      };
    },

    async pause(on) {
      await post('/api/job', { command: 'pause', action: on ? 'pause' : 'resume' }, 'pause');
    },

    async cancel() {
      await post('/api/job', { command: 'cancel' }, 'cancel');
    },

    async command(lines) {
      await post('/api/printer/command', { commands: lines }, 'command');
    },
  };
}
