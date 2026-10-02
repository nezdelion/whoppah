// A minimal DOM for UI helper tests in node: elements, attributes, events, text. Installs globalThis.document.
class FakeText {
  constructor(text) { this.nodeType = 3; this.textContent = String(text); }
}

export class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.hidden = false;
    this.title = '';
    this.disabled = false;
    this.type = '';
    this.value = '';
    this.checked = false;
    this.dataset = {};
    this.open = false;
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) };
  }

  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' || typeof n === 'number' ? new FakeText(n) : n); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  /** The number of listeners of all types (a remounted view must not leave the old ones). */
  listenerCount() { let n = 0; for (const fns of this.listeners.values()) n += fns.length; return n; }
  focus() {}
  /** <dialog>: showModal/close toggle open; <details>: open is a plain property. */
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch('close'); }
  querySelectorAll(sel) { const m = /^(\w+)?(?::checked)?$/.exec(sel); return m ? this.findAll((e) => (!m[1] || e.tagName === m[1].toUpperCase()) && (!sel.includes(':checked') || e.checked)) : []; }
  /** Canvas: a 2D context that accepts every call. */
  getContext() { return new Proxy({}, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } }); }

  get textContent() { return this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this.children = v === '' ? [] : [new FakeText(v)]; }

  /** Dispatch like a browser: a disabled button gets no click. */
  dispatch(type, init = {}) {
    if (type === 'click' && this.tagName === 'BUTTON' && this.disabled) return;
    const ev = { type, target: this, defaultPrevented: false, stopped: false, ...init };
    ev.preventDefault = () => { ev.defaultPrevented = true; };
    ev.stopPropagation = () => { ev.stopped = true; };
    for (const fn of this.listeners.get(type) || []) fn(ev);
    return ev;
  }

  click() { return this.dispatch('click'); }

  /** All descendants (depth first) matching a predicate. */
  findAll(pred) {
    const out = [];
    const walk = (n) => { for (const c of n.children || []) { if (c instanceof FakeElement) { if (pred(c)) out.push(c); walk(c); } } };
    walk(this);
    return out;
  }
}

export function installFakeDom() {
  const doc = { activeElement: null, createElement: (tag) => new FakeElement(tag) };
  globalThis.document = doc;
  return doc;
}
