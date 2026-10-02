// Environment description: env.json next to the page. Standalone serves a static file, the OctoPrint plugin a dynamic one.
// Returns { mode: 'standalone' } or { mode: 'plugin', baseUrl, apiBase, settingsUrl, profilesUrl, octoprintUrl, loginUrl,
// version, csrfCookie, user, canEditProfile, canEditCalibration, language }; the addresses in the result are absolute.

const PLUGIN_FIELDS = ['baseUrl', 'settingsUrl', 'octoprintUrl', 'csrfCookie'];

/** Parsing the raw env.json; origin is needed to turn root-relative paths into absolute addresses (works behind a proxy too). */
export function resolveEnv(raw, origin) {
  if (!raw || typeof raw !== 'object' || raw.mode !== 'plugin') return { mode: 'standalone' };
  for (const f of PLUGIN_FIELDS) {
    if (typeof raw[f] !== 'string') throw new Error(`env.json: missing field "${f}"`);
  }
  const abs = (v) => (/^https?:\/\//i.test(v) ? v : origin + v);
  const trim = (v) => v.replace(/\/+$/, '');
  return {
    mode: 'plugin',
    baseUrl: trim(abs(raw.baseUrl)),
    apiBase: trim(abs(raw.apiBase ?? raw.baseUrl + '/api')),
    settingsUrl: trim(abs(raw.settingsUrl)),
    // machine profiles API; an env.json without it (older plugin) — next to the sections
    profilesUrl: trim(abs(typeof raw.profilesUrl === 'string' ? raw.profilesUrl : raw.settingsUrl.replace(/\/settings\/?$/, '/profiles'))),
    octoprintUrl: abs(raw.octoprintUrl),
    loginUrl: raw.loginUrl ? abs(raw.loginUrl) : abs(raw.octoprintUrl),
    version: String(raw.version ?? ''),
    csrfCookie: raw.csrfCookie,
    user: raw.user ?? null,
    canEditProfile: !!raw.canEditProfile,
    canEditCalibration: !!raw.canEditCalibration,
    language: typeof raw.language === 'string' && raw.language ? raw.language : null, // the interface language of the current OctoPrint user
  };
}

/** An unavailable or non-JSON env.json means standalone (a static server without the file). A corrupted plugin env is an error. */
export async function loadEnv({ fetch: fetchFn = globalThis.fetch.bind(globalThis), origin = globalThis.location.origin, url = 'env.json' } = {}) {
  let res;
  try { res = await fetchFn(url, { cache: 'no-store', credentials: 'same-origin' }); } catch (e) { return { mode: 'standalone' }; }
  if (!res.ok) return { mode: 'standalone' };
  let raw;
  try { raw = JSON.parse(await res.text()); } catch (e) { return { mode: 'standalone' }; }
  return resolveEnv(raw, origin);
}
