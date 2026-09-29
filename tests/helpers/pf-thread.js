// Body of the worker_threads worker for tests: web-worker globals (self, postMessage, importScripts, onmessage) on top of node.
// Runs in the real global context — as fast as in a browser worker (in a vm context access to the globals of
// plotterfun styles is many times slower).
import { parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const { base, hostFile, preload } = workerData;
globalThis.self = globalThis;
let seed = 123456789; // deterministic Math.random: two runs with the same call order give the same result
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
globalThis.postMessage = (msg) => parentPort.postMessage(msg);
globalThis.importScripts = (...names) => {
  for (const n of names) vm.runInThisContext(readFileSync(n.startsWith('/') ? n : base + n, 'utf8'), { filename: base + n });
};
if (hostFile) vm.runInThisContext(readFileSync(hostFile, 'utf8'), { filename: hostFile });
if (preload) globalThis.importScripts(preload + '.js');
// {__ping} is processed in the queue after the style: pong means "the synchronous part of the computation has finished"
parentPort.on('message', (msg) => {
  // {__idle}: the number of pending timers by node own data (not by the host wrapper) — an independent "work finished" signal
  if (msg && msg.__idle) { parentPort.postMessage({ __idle: msg.__idle, timers: process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length }); return; }
  if (msg && msg.__ping) { parentPort.postMessage({ __pong: msg.__ping }); return; }
  try { globalThis.onmessage({ data: msg }); } catch (e) { parentPort.postMessage({ __threw: String(e && e.message) }); }
});
