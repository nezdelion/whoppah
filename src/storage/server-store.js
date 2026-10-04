// SettingsStore on the OctoPrint side (plugin mode): GET/PUT {settingsUrl}/<section>; machine profiles — {profilesUrl}.
// The storage layer knows nothing about transport and core: the auth method comes as an object (init/prepare/recover/describe).
import { SECTIONS } from './settings-store.js';
import { t } from '../i18n/index.js';

export class StoreError extends Error {
  constructor(message, { section = '', status = null } = {}) {
    super(message);
    this.name = 'StoreError';
    this.section = section;
    this.status = status;
  }
}

// Reason for a per-section denial: the missing permission.
export const SECTION_NEEDS = Object.freeze({
  profile: 'perm.profile', profiles: 'perm.profile', calibration: 'perm.control',
});

// the single profile of earlier versions: the server still serves it (the values of the active profile) for a cached old page;
// "fonts" — the user's own fonts of the "Text" tab (per user on the server, not part of the settings file)
const READABLE = [...SECTIONS, 'profile', 'fonts'];

export class ServerStore {
  #slots = new Map();
  #ready = null;

  /**
   * @param baseUrl OctoPrint address (for login), @param settingsUrl sections address, @param auth auth strategy
   * @param profilesUrl machine profiles address (by default next to the sections: …/api/profiles)
   */
  constructor({ baseUrl, settingsUrl, profilesUrl = null, auth, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.settingsUrl = settingsUrl.replace(/\/+$/, '');
    this.profilesUrl = (profilesUrl || this.settingsUrl.replace(/\/settings$/, '/profiles')).replace(/\/+$/, '');
    this.auth = auth;
    this.fetch = fetchFn;
  }

  #init() {
    if (!this.#ready) {
      this.#ready = Promise.resolve(this.auth.init({ fetch: this.fetch }))
        .catch((e) => { this.#ready = null; throw e; });
    }
    return this.#ready;
  }

  async #request(method, section, json, url = `${this.settingsUrl}/${section}`) {
    await this.#init();
    for (let attempt = 0; ; attempt++) {
      let request = { url, method, headers: {}, body: undefined };
      if (json !== undefined) {
        request.headers['Content-Type'] = 'application/json';
        request.body = JSON.stringify(json);
      }
      request = await this.auth.prepare(request);
      let res, text;
      try {
        res = await this.fetch(request.url, {
          method: request.method, headers: request.headers, body: request.body,
          ...(request.credentials ? { credentials: request.credentials } : {}),
        });
        text = await res.text();
      } catch (e) {
        throw new StoreError(t('net.noResponse'), { section });
      }
      if (res.ok) {
        try { return text ? JSON.parse(text) : null; } catch (e) { throw new StoreError(t('net.notJson'), { section, status: res.status }); }
      }
      const err = new StoreError(t('net.status', { status: res.status }), { section, status: res.status });
      err.operation = 'settings';
      let detail = '';
      try {
        const body = JSON.parse(text);
        detail = body.error || '';
        if (body.code) err.code = body.code;
        if (body.profile) err.current = body.profile; // 409: the profile as it is on the server now
      } catch (e) { detail = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
      err.message = detail ? `${err.message}: ${detail}` : err.message;
      const decision = await this.auth.recover(err, attempt);
      if (decision === 'retry' && attempt === 0) continue;
      if (res.status === 401 || (res.status === 403 && !SECTION_NEEDS[section])) {
        err.message = this.auth.describe(err) || err.message;
      } else if (res.status === 403) {
        // per-section denial: "permission required: …" if the session is alive; otherwise the expired session message
        const d = this.auth.describe(err);
        err.message = d && d === t('auth.expired') ? d : t('auth.noPermission', { what: t(SECTION_NEEDS[section]) });
      }
      throw err;
    }
  }

  async load(key) {
    if (!READABLE.includes(key)) return null; // for example, "connection" is not stored in plugin mode
    const value = key === 'profiles' ? await this.#request('GET', key, undefined, this.profilesUrl) : await this.#request('GET', key);
    return value && typeof value === 'object' ? value : null;
  }

  /**
   * Machine profiles: one request per operation, the server answers with its collection (returned).
   * op — { kind: 'put', id } (create or replace the profile, with the revision it is based on), { kind: 'delete', id },
   * { kind: 'active', id }; without op — the whole collection (import). The state sends them one after another.
   */
  async #saveProfiles(col, op) {
    const url = (id) => `${this.profilesUrl}/${encodeURIComponent(id)}`;
    if (!op) return this.#request('PUT', 'profiles', col, this.profilesUrl);
    if (op.kind === 'delete') return this.#request('DELETE', 'profiles', undefined, url(op.id));
    if (op.kind === 'active') return this.#request('PUT', 'profiles', { id: op.id }, `${this.profilesUrl}/active`);
    if (op.kind === 'put') {
      const p = col.items.find((x) => x.id === op.id);
      if (!p) throw new StoreError(`unknown profile: ${op.id}`, { section: 'profiles' });
      return this.#request('PUT', 'profiles', { name: p.name, values: p.values, rev: p.rev }, url(op.id));
    }
    throw new Error(`unknown profiles operation: ${op.kind}`);
  }

  /** Write with coalescing: while a request is in flight, new values of one section replace each other, the last one is sent. */
  save(key, obj, op) {
    if (key === 'profiles') return this.#saveProfiles(obj, op);
    if (!READABLE.includes(key)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let slot = this.#slots.get(key);
      if (!slot) this.#slots.set(key, slot = { busy: false, has: false, value: null, waiters: [] });
      slot.value = obj;
      slot.has = true;
      slot.waiters.push({ resolve, reject });
      if (!slot.busy) this.#drain(key, slot);
    });
  }

  async #drain(key, slot) {
    slot.busy = true;
    while (slot.has) {
      const { value, waiters } = slot;
      slot.has = false;
      slot.waiters = [];
      try {
        await this.#request('PUT', key, value);
        for (const w of waiters) w.resolve();
      } catch (e) {
        for (const w of waiters) w.reject(e);
      }
    }
    slot.busy = false;
  }
}
