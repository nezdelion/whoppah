// Head position source and writing the captured calibration (plugin mode): routes of the Plotter plugin.
// PositionSource {
//   read():            Promise<{x, y, z, epochXY, epochZ}>
//   epoch():           Promise<{xy, z}>  (coordinate epochs: sheet corner and touch — independent counters)
//   saveCorner({x, y, epoch}) / saveTouch({zTouch, epoch}): Promise<calibration>  (epoch — the counter of its part; the server returned the document)
//   confirm('xy'|'z'): Promise<calibration>
// }
// Errors are TransportError; kind: busy | offline | timeout | stale | unsupported | nocoords | forbidden | auth | network | http.
import { TransportError } from './transport.js';
import { t } from '../i18n/index.js';

// texts are computed on access (they depend on the current language)
export const MESSAGES = {
  get busy() { return t('position.busy'); },
  get offline() { return t('position.offline'); },
  get timeout() { return t('position.timeout'); },
  get stale() { return t('position.stale'); },
  get unsupported() { return t('position.unsupported'); },
  get nocoords() { return t('position.nocoords'); },
};

/** Position read error by kind (busy | offline | timeout | stale | unsupported | nocoords) — shared by the plugin and the feed. */
export const positionError = (kind, operation = 'position', message = MESSAGES[kind]) => new TransportError(message, { kind, operation });

export function createOctoPrintPosition({ apiUrl, auth, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
  const base = String(apiUrl).replace(/\/+$/, '');
  let initPromise = null;
  const ensureInit = () => {
    if (!initPromise) {
      initPromise = Promise.resolve(auth.init({ fetch: fetchFn })).catch((e) => { initPromise = null; throw e; });
    }
    return initPromise;
  };

  function toError(status, text, operation) {
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    const code = body && typeof body.code === 'string' ? body.code : '';
    if (status === 401 || status === 403) return new TransportError(t('net.rejected', { status }), { kind: status === 403 ? 'forbidden' : 'auth', operation, status });
    if (MESSAGES[code]) return new TransportError(MESSAGES[code], { kind: code, operation, status });
    const detail = body && body.error ? body.error : String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return new TransportError(t('net.status', { status }) + (detail ? ': ' + detail : ''), { kind: 'http', operation, status });
  }

  async function once(method, path, json, operation) {
    let request = { url: base + path, method, headers: {}, body: undefined };
    if (json !== undefined) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(json);
    }
    request = await auth.prepare(request);
    let res, text;
    try {
      res = await fetchFn(request.url, {
        method: request.method, headers: request.headers, body: request.body,
        ...(request.credentials ? { credentials: request.credentials } : {}),
      });
      text = await res.text();
    } catch (e) {
      throw new TransportError(t('net.noResponse'), { kind: 'network', operation });
    }
    if (!res.ok) throw toError(res.status, text, operation);
    try { return JSON.parse(text); } catch (e) { throw new TransportError(t('net.notJson'), { kind: 'http', operation, status: res.status }); }
  }

  async function request(method, path, json, operation) {
    await ensureInit();
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, path, json, operation);
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        // 400 with CSRF and 401/403 are handled by the auth strategy; it does not touch messages by plugin code
        const authLike = e.status === 400 || e.status === 401 || e.status === 403;
        if (authLike) {
          const decision = await auth.recover(e, attempt);
          if (decision === 'retry' && attempt === 0) continue;
          const described = auth.describe(e);
          if (described) e.message = described;
        }
        throw e;
      }
    }
  }

  return {
    id: 'octoprint-position',

    async read() {
      const r = await request('POST', '/position', {}, 'position');
      if (![r.x, r.y, r.z, r.epochXY, r.epochZ].every(Number.isFinite)) throw new TransportError(t('position.incomplete'), { kind: 'http', operation: 'position' });
      return { x: r.x, y: r.y, z: r.z, epochXY: r.epochXY, epochZ: r.epochZ };
    },

    async epoch() {
      const r = await request('GET', '/position/epoch', undefined, 'position');
      if (!Number.isInteger(r.xy) || !Number.isInteger(r.z)) throw new TransportError(t('position.badEpoch'), { kind: 'http', operation: 'position' });
      return { xy: r.xy, z: r.z };
    },

    async saveCorner({ x, y, epoch }) { return (await request('POST', '/calibration/xy', { x, y, epoch }, 'position')).calibration; },
    async saveTouch({ zTouch, epoch }) { return (await request('POST', '/calibration/z', { zTouch, epoch }, 'position')).calibration; },
    async confirm(part) {
      if (part !== 'xy' && part !== 'z') throw new Error(`unknown calibration part: ${part}`);
      return (await request('POST', `/calibration/${part}/confirm`, {}, 'position')).calibration;
    },
  };
}
