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
  }

  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' || typeof n === 'number' ? new FakeText(n) : n); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }

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
