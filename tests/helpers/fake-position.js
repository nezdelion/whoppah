// Plugin server model for app tests: head position, coordinate epoch, calibration document.
import { TransportError } from '../../src/transport/transport.js';

export function fakeServer({ head = { x: -5, y: 50, z: 8 }, calibration = null } = {}) {
  const s = {
    head: { ...head }, epochs: { xy: 0, z: 0 }, calibration, fail: null, reads: 0, epochCalls: 0,
    /** G28: without arguments — both epochs; 'xy' / 'z' — only its own (G28 X Y / G28 Z) */
    g28(part) { if (part !== 'z') s.epochs.xy++; if (part !== 'xy') s.epochs.z++; },
    /** error of the next read(): kind from the source error list */
    failNext(kind, message = kind) { s.fail = new TransportError(message, { kind }); },
  };
  const doc = () => ({ cornerX: -5, cornerY: 50, zTouch: 8, updatedAt: null, ...(s.calibration || {}) });
  const stale = () => new TransportError('положение сбилось — повторите захват', { kind: 'stale' });
  s.source = {
    async read() {
      s.reads++;
      if (s.fail) { const e = s.fail; s.fail = null; throw e; }
      return { ...s.head, epochXY: s.epochs.xy, epochZ: s.epochs.z };
    },
    async epoch() { s.epochCalls++; return { ...s.epochs }; },
    async saveCorner({ x, y, epoch }) {
      if (epoch !== s.epochs.xy) throw stale();
      s.calibration = { ...doc(), cornerX: x, cornerY: y, epochXY: epoch, updatedAt: 'T' };
      return structuredClone(s.calibration);
    },
    async saveTouch({ zTouch, epoch }) {
      if (epoch !== s.epochs.z) throw stale();
      s.calibration = { ...doc(), zTouch, epochZ: epoch, updatedAt: 'T' };
      return structuredClone(s.calibration);
    },
    async confirm(part) {
      s.calibration = { ...doc(), [part === 'xy' ? 'epochXY' : 'epochZ']: s.epochs[part] };
      return structuredClone(s.calibration);
    },
  };
  return s;
}

/** Clock for polling: tick(ms) invokes the registered intervals. */
export function fakeTimers() {
  const t = { now: 0, intervals: new Map(), nextId: 1 };
  t.setInterval = (fn, ms) => { const id = t.nextId++; t.intervals.set(id, { fn, ms, next: t.now + ms }); return id; };
  t.clearInterval = (id) => { t.intervals.delete(id); };
  t.tick = async (ms) => {
    const end = t.now + ms;
    for (;;) {
      const due = [...t.intervals.values()].filter((i) => i.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      t.now = due.next; due.next += due.ms;
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    t.now = end;
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  t.active = () => t.intervals.size;
  return t;
}

export function fakeVisibility(initial = true) {
  const v = { hidden: !initial, listeners: new Set() };
  v.visible = () => !v.hidden;
  v.subscribe = (fn) => { v.listeners.add(fn); return () => v.listeners.delete(fn); };
  v.set = (visible) => { v.hidden = !visible; for (const fn of [...v.listeners]) fn(); };
  return v;
}
