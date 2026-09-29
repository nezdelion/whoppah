// Mocked fetch: a call log and a queue/function of responses.
export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, ...init });
    const r = typeof handler === 'function' ? await handler(url, init, calls.length) : handler;
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    const text = r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}
