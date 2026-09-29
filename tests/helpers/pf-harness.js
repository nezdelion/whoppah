// Running plotterfun styles in node (worker_threads with web-worker globals, see pf-thread.js).
// Modes: hosted — via src/styles/plotterfun-host.js; direct — the style itself without the wrapper (reference).
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VENDOR_DIR = join(root, 'vendor', 'plotterfun');
export const HOST_FILE = join(root, 'src', 'styles', 'plotterfun-host.js');
const THREAD = join(dirname(fileURLToPath(import.meta.url)), 'pf-thread.js');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @returns { post(msg), terminate(), messages: [] } */
export function spawnWorker({ hosted, style }) {
  const messages = [];
  const w = new Worker(THREAD, { workerData: { base: VENDOR_DIR + '/', hostFile: hosted ? HOST_FILE : null, preload: hosted ? null : style } });
  const t = { messages, lastAt: Date.now(), failure: null };
  w.on('message', (m) => { if (!(m && (m.__idle || m.__pong))) t.lastAt = Date.now(); messages.push(m); });
  w.on('error', (e) => { t.failure = e; });
  return Object.assign(t, { post: (m) => w.postMessage(m), terminate: () => w.terminate() });
}

export function makeImage(kind, w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const v = kind === 'gradient' ? (x / (w - 1)) * 255
      : 128 + 100 * Math.sin(x / 9) * Math.cos(y / 7) + 20 * Math.sin((x * y) / 97); // "photo": blobs of different tones
    data[i] = v; data[i + 1] = v * 0.9; data[i + 2] = v * 0.8; data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

const lastPath = (paths) => (paths.length ? paths[paths.length - 1] : null);
const copyImage = (image) => ({ width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) });

/** Style parameters (controls) from its sliders message. */
export async function probeControls(style) {
  const w = spawnWorker({ hosted: true });
  w.post({ type: 'init', style, model: 'none', base: VENDOR_DIR + '/' });
  const t0 = Date.now();
  while (!w.messages.some((m) => m.type === 'sliders') && Date.now() - t0 < 5000) await sleep(2);
  const controls = (w.messages.find((m) => m.type === 'sliders') || {}).controls;
  await w.terminate();
  return controls;
}

const HANG_MS = 2500;

// Waiting for a pong to a ping: the thread replies when the synchronous part of the computation has finished; false — looped or crashed.
async function settle(w, id, hangMs = HANG_MS) {
  w.post({ __ping: id });
  const t0 = Date.now();
  while (!w.messages.some((m) => m && m.__pong === id)) {
    if (w.failure || Date.now() - t0 > hangMs) return false;
    await sleep(2);
  }
  return true;
}
// Waiting until the thread has no timers left (node data, not host wrapper data), then a short quiet period.
async function untilIdle(w, quietMs, limitMs = 90000) {
  const t0 = Date.now();
  let id = 1000, idleRuns = 0;
  while (Date.now() - t0 < limitMs && !w.failure) {
    const mine = ++id;
    w.post({ __idle: mine });
    const asked = Date.now();
    // the thread does not respond for 5 s — looped inside a timer callback
    while (!w.messages.some((m) => m && m.__idle === mine) && !w.failure && Date.now() - t0 < limitMs && Date.now() - asked < 5000) await sleep(2);
    if (!w.messages.some((m) => m && m.__idle === mine)) return false;
    const reply = w.messages.find((m) => m && m.__idle === mine);
    idleRuns = reply && reply.timers === 0 ? idleRuns + 1 : 0;
    if (idleRuns >= 2 && Date.now() - w.lastAt >= quietMs) return true;
    await sleep(10);
  }
  return false;
}
const threw = (w) => w.messages.filter((m) => m && m.__threw).map((m) => m.__threw);

/** Reference: the style without the wrapper; after the synchronous part we wait for quietMs of quiet. followUps — live config changes. */
export async function runDirect({ style, image, params, followUps = [], quietMs = 300, hangMs = HANG_MS }) {
  const w = spawnWorker({ hosted: false, style });
  const config = { ...params, width: image.width, height: image.height };
  const result = { hung: false, failed: false };
  const step = async (msg, id) => {
    w.post(msg);
    if (!(await settle(w, id, hangMs))) { result.hung = !w.failure; result.failed = !!w.failure; return false; }
    if (threw(w).length) { result.failed = true; return false; }
    if (!(await untilIdle(w, quietMs))) { result.hung = !w.failure; result.failed = !!w.failure; return false; }
    if (w.failure) { result.failed = true; return false; }
    return true;
  };
  let ok = await step([config, copyImage(image)], 1);
  for (let i = 0; ok && i < followUps.length; i++) { Object.assign(config, followUps[i]); ok = await step([config], i + 2); }
  await w.terminate();
  result.ok = ok;
  result.path = lastPath(w.messages.filter((m) => Array.isArray(m) && m[0] === 'svg-path').map((m) => m[1]));
  return result;
}

/** Via plotterfun-host: wait for 'final' (up to limitMs), then quietMs without new messages. */
export async function runHosted({ style, model, image, params, followUps = [], quietMs = 300, limitMs = 60000, hangMs = HANG_MS }) {
  const w = spawnWorker({ hosted: true });
  const msgs = w.messages;
  const finals = () => msgs.filter((m) => m.type === 'final').length;
  const failed = () => msgs.some((m) => m.type === 'error' || m.__threw) || w.failure;
  const result = { finalOk: [], afterFinal: [], errors: [], hung: false };
  const step = async (msg, n) => {
    w.post(msg);
    const responsive = await settle(w, n, hangMs);
    if (!responsive && !w.failure) result.hung = true;
    const t0 = Date.now();
    let pinged = Date.now(), alive = responsive;
    while (alive && finals() < n && !failed() && Date.now() - t0 < limitMs) {
      await sleep(5);
      // looping inside a timer callback: the thread stops responding to ping
      if (Date.now() - pinged > 1000) {
        pinged = Date.now();
        if (!(await settle(w, `w${n}-${pinged}`, 5000))) { alive = false; result.hung = !w.failure; }
      }
    }
    result.finalOk.push(finals() >= n);
    if (!alive) { result.afterFinal.push(0); return false; }
    const mark = msgs.length;
    await sleep(quietMs);
    await untilIdle(w, 0, 5000); // and no timers are left
    result.afterFinal.push(msgs.slice(mark).filter((m) => !(m && (m.__idle || m.__pong))).length);
    return true;
  };
  w.post({ type: 'init', style, model, base: VENDOR_DIR + '/' });
  let ok = await step({ type: 'run', runId: 1, image: copyImage(image), params: { ...params } }, 1);
  for (let i = 0; ok && i < followUps.length; i++) ok = await step({ type: 'params', runId: 1, params: followUps[i] }, i + 2);
  await w.terminate();
  result.errors = msgs.filter((m) => m.type === 'error').map((m) => m.message).concat(threw(w), w.failure ? [String(w.failure.message)] : []);
  result.path = lastPath(msgs.filter((m) => m.type === 'svg-path').map((m) => m.d));
  result.msgs = msgs;
  return result;
}
