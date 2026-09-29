// Authorization by the OctoPrint session (plugin mode): session cookie + X-CSRF-Token header.
// Auth contract: init(http), prepare(request), recover(error, attempt), describe(error).
// No OctoPrint JS client, jQuery or lodash: fetch only.

const PERMISSION_BY_OPERATION = {
  upload: 'печать', pause: 'печать', cancel: 'печать',
  command: 'управление принтером', position: 'управление принтером', job: 'просмотр состояния', test: 'просмотр состояния',
};

export function readCookie(cookieString, name) {
  for (const part of String(cookieString || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

/**
 * @param csrfCookie the full CSRF cookie name (computed by the plugin server)
 * @param getCookie  () => the document.cookie string
 * @param fetch      optional: fetch for login requests (by default the one the client passed to init)
 * @param refreshUrl GET address whose response sets the CSRF cookie (the OctoPrint passive login does not refresh it)
 * @param onExpired  called when session expiry is detected
 */
export function createSessionAuth({ csrfCookie, getCookie = () => globalThis.document?.cookie ?? '', fetch: ownFetch, refreshUrl = '', onExpired = () => {} }) {
  let http = null;
  let alive = null; // null — unknown; true/false — by the result of the last passive login

  const token = () => readCookie(getCookie(), csrfCookie);

  // The passive login confirms the session and makes the server refresh the CSRF cookie.
  async function passiveLogin() {
    const fetchFn = ownFetch || http.fetch;
    const headers = { 'Content-Type': 'application/json' };
    if (token()) headers['X-CSRF-Token'] = token();
    try {
      const res = await fetchFn(http.baseUrl + '/api/login', {
        method: 'POST', headers, body: JSON.stringify({ passive: true }), credentials: 'same-origin',
      });
      const text = await res.text();
      let user = null;
      try { user = JSON.parse(text); } catch (e) { /* not JSON */ }
      // an anonymous response is 200 without a name; 400 (no CSRF) and the like say nothing about the session
      if (res.ok) alive = !!(user && user.name && user.name !== '_anonymous');
      else if (res.status === 401 || res.status === 403) alive = false;
    } catch (e) { /* network unavailable: the session state is unknown, the request itself will show the error */ }
    return alive;
  }

  async function refreshToken() {
    if (!refreshUrl) return;
    try { await (ownFetch || http.fetch)(refreshUrl, { credentials: 'same-origin', cache: 'no-store' }); } catch (e) { /* see passiveLogin */ }
  }

  return {
    async init(client) {
      http = client;
      if (!token()) await refreshToken(); // the passive login is a POST, it already needs a CSRF token
      await passiveLogin();
    },

    async prepare(request) {
      const headers = { ...request.headers };
      if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
        const t = token();
        if (t) headers['X-CSRF-Token'] = t;
      }
      return { ...request, headers, credentials: 'same-origin' };
    },

    async recover(error, attempt) {
      if (attempt !== 0) return 'fail';
      if (error.status === 400 && /CSRF/i.test(error.message)) {
        // a stale token: refresh the session and retry if it is alive
        if ((await passiveLogin()) === false) return 'fail';
        await refreshToken();
        return 'retry';
      }
      if (error.status === 401 || error.status === 403) await passiveLogin();
      return 'fail';
    },

    describe(error) {
      if (error.status === 400 && /CSRF/i.test(error.message)) return 'OctoPrint не принял CSRF-токен сессии — обновите страницу';
      if (error.status !== 401 && error.status !== 403) return null;
      if (error.status === 401 || alive === false) {
        onExpired();
        return 'сессия OctoPrint истекла — войти';
      }
      return `нет права: ${PERMISSION_BY_OPERATION[error.operation] || error.operation || 'операция'}`;
    },
  };
}
