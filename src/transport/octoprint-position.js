// Head position source and writing the captured calibration (plugin mode): routes of the Plotter plugin.
// PositionSource {
//   read():            Promise<{x, y, z, epoch}>
//   epoch():           Promise<number>
//   saveCorner({x, y, epoch}) / saveTouch({zTouch, epoch}): Promise<calibration>  (the server returned the document)
//   confirm('xy'|'z'): Promise<calibration>
// }
// Errors are TransportError; kind: busy | offline | timeout | stale | unsupported | nocoords | forbidden | auth | network | http.
import { TransportError } from './transport.js';

export const MESSAGES = {
  busy: 'нельзя во время печати (или чтение положения уже идёт)',
  offline: 'принтер не подключён',
  timeout: 'принтер не ответил',
  stale: 'положение сбилось — повторите захват',
  unsupported: 'прошивка не отвечает на M118 — введите координаты вручную',
  nocoords: 'принтер не прислал координаты',
};
const NETWORK = 'нет ответа от OctoPrint';

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
    if (status === 401 || status === 403) return new TransportError(`OctoPrint отклонил запрос (${status})`, { kind: status === 403 ? 'forbidden' : 'auth', operation, status });
    if (MESSAGES[code]) return new TransportError(MESSAGES[code], { kind: code, operation, status });
    const detail = body && body.error ? body.error : String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    return new TransportError(`OctoPrint ответил ${status}${detail ? ': ' + detail : ''}`, { kind: 'http', operation, status });
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
      throw new TransportError(NETWORK, { kind: 'network', operation });
    }
    if (!res.ok) throw toError(res.status, text, operation);
    try { return JSON.parse(text); } catch (e) { throw new TransportError('OctoPrint вернул не JSON', { kind: 'http', operation, status: res.status }); }
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
      if (![r.x, r.y, r.z, r.epoch].every(Number.isFinite)) throw new TransportError('OctoPrint вернул неполное положение', { kind: 'http', operation: 'position' });
      return { x: r.x, y: r.y, z: r.z, epoch: r.epoch };
    },

    async epoch() {
      const r = await request('GET', '/position/epoch', undefined, 'position');
      if (!Number.isInteger(r.epoch)) throw new TransportError('OctoPrint вернул неверную версию координат', { kind: 'http', operation: 'position' });
      return r.epoch;
    },

    async saveCorner({ x, y, epoch }) { return (await request('POST', '/calibration/xy', { x, y, epoch }, 'position')).calibration; },
    async saveTouch({ zTouch, epoch }) { return (await request('POST', '/calibration/z', { zTouch, epoch }, 'position')).calibration; },
    async confirm(part) {
      if (part !== 'xy' && part !== 'z') throw new Error(`неизвестная часть калибровки: ${part}`);
      return (await request('POST', `/calibration/${part}/confirm`, {}, 'position')).calibration;
    },
  };
}
