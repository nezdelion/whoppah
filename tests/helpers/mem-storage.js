// Web Storage mock for node.
export class MemStorage {
  constructor(initial = {}) { this.m = new Map(Object.entries(initial)); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  get length() { return this.m.size; }
  keys() { return [...this.m.keys()]; }
}
