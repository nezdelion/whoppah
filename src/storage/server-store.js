// SettingsStore on the OctoPrint side (plugin mode): GET/PUT {settingsUrl}/<section>.
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
  profile: 'perm.profile', calibration: 'perm.control',
});

export class ServerStore {
  #slots = new Map();
  #ready = null;

  /** @param baseUrl OctoPrint address (for login), @param settingsUrl sections address, @param auth auth strategy */
  constructor({ baseUrl, settingsUrl, auth, fetch: fetchFn = globalThis.fetch.bind(globalThis) }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.settingsUrl = settingsUrl.replace(/\/+$/, '');
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

  async #request(method, section, json) {
    await this.#init();
    for (let attempt = 0; ; attempt++) {
      let request = { url: `${this.settingsUrl}/${section}`, method, headers: {}, body: undefined };
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
      try { detail = JSON.parse(text).error || ''; } catch (e) { detail = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200); }
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
    if (!SECTIONS.includes(key)) return null; // for example, "connection" is not stored in plugin mode
    const value = await this.#request('GET', key);
    return value && typeof value === 'object' ? value : null;
  }

  /** Write with coalescing: while a request is in flight, new values of one section replace each other, the last one is sent. */
  save(key, obj) {
    if (!SECTIONS.includes(key)) return Promise.resolve();
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
