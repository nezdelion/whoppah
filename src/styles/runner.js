// StyleRunner: running styles in workers, cancel, statuses, completion detection.
// Knows nothing about specific styles: the worker and protocol are given by descriptor + createSession(descriptor).
// Layer statuses: running (computing) | partial (the style kept producing output after completion) | done | error.
// "done" is set only by a result event with final:true; the runner does not measure quiet time at all.
import { PROGRESS, RESULT, ERROR, SLIDERS } from './protocol.js';
import { t } from '../i18n/index.js';

export const STATUS = Object.freeze({ RUNNING: 'running', PARTIAL: 'partial', DONE: 'done', ERROR: 'error' });

/**
 * @param opts { createSession(descriptor) -> session }  session — see plotterfun-adapter / native-adapter
 *             The worker is not released after final: a style may send data later (style-engine spec) with no time limit.
 *             It is terminated by cancel, by replacing a run of the same layer, by an error and by dispose.
 */
export function createRunner({ createSession }) {
  const runs = new Map(); // key -> run
  let counter = 0;

  function post(worker, entry) {
    if (!entry) return;
    const [msg, transfer] = entry;
    worker.postMessage(msg, transfer || []);
  }

  function stop(run) {
    if (run.stopped) return;
    run.stopped = true;
    run.worker.onmessage = null;
    run.worker.onerror = null;
    run.worker.onmessageerror = null;
    run.worker.terminate();
  }

  function cancel(key) {
    const run = runs.get(key);
    if (!run) return;
    runs.delete(key);
    stop(run);
  }

  /** Run of layer key; the previous run of the same layer is cancelled (the worker is terminated). */
  function run(key, descriptor, { image, params }, listener) {
    cancel(key);
    const runId = ++counter;
    const session = createSession(descriptor);
    const worker = descriptor.createWorker();
    const r = {
      runId, key, worker, session, listener, hasLive: Array.isArray(descriptor.params) && descriptor.params.some((p) => p.live),
      state: { runId, status: STATUS.RUNNING, progress: '', lines: [], partial: true, reason: '' },
    };
    runs.set(key, r);
    const emit = () => { if (runs.get(key) === r) listener({ ...r.state }); };

    worker.onmessage = (e) => {
      if (runs.get(key) !== r) return; // a cancelled or replaced run
      const data = e.data;
      // runId in the message: late messages of a previous run (the same worker) are discarded
      if (data && data.runId && data.runId !== r.runId) return;
      for (const ev of session.decode(data)) handle(r, ev, emit);
    };
    const onFail = (e) => handle(r, { type: ERROR, message: (e && e.message) || t('styles.workerFailed') }, emit);
    worker.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); onFail(e); };
    worker.onmessageerror = onFail;

    try {
      for (const entry of session.initMessages()) post(worker, entry);
      // a copy of the buffer: each layer has its own, transfer does not break the shared image
      const copy = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
      post(worker, session.runMessage({ runId, image: copy, params }));
    } catch (e) {
      onFail(e);
      return;
    }
    emit();
  }

  function handle(r, ev, emit) {
    const s = r.state;
    if (s.status === STATUS.ERROR) return;
    if (ev.type === PROGRESS) s.progress = ev.text;
    else if (ev.type === SLIDERS) r.hasLive = ev.params.some((p) => p.live);
    else if (ev.type === RESULT) {
      s.lines = ev.lines;
      s.reason = ev.reason || '';
      if (ev.final) { s.status = STATUS.DONE; s.partial = false; s.reason = ''; }
      else { s.status = ev.late ? STATUS.PARTIAL : STATUS.RUNNING; s.partial = true; }
    } else if (ev.type === ERROR) {
      s.status = STATUS.ERROR; s.message = ev.message; s.partial = true;
      stop(r);
    } else return;
    emit();
  }

  /** Live parameters to a running (or completed but alive) worker. false — there is no worker, a restart is needed. */
  function live(key, params) {
    const r = runs.get(key);
    if (!r || r.state.status === STATUS.ERROR || !r.hasLive) return false;
    r.state = { ...r.state, status: STATUS.RUNNING, partial: true };
    post(r.worker, r.session.paramsMessage({ runId: r.runId, params }));
    r.listener({ ...r.state });
    return true;
  }

  /** Dynamic style parameter description: a short worker run until the sliders message. */
  function probe(descriptor) {
    return new Promise((resolve, reject) => {
      const session = createSession(descriptor);
      const worker = descriptor.createWorker();
      const done = (fn, v) => { worker.onmessage = null; worker.onerror = null; worker.terminate(); fn(v); };
      worker.onmessage = (e) => {
        for (const ev of session.decode(e.data)) {
          if (ev.type === SLIDERS) done(resolve, ev.params);
          else if (ev.type === ERROR) done(reject, new Error(ev.message));
        }
      };
      worker.onerror = (e) => done(reject, new Error((e && e.message) || t('styles.workerFailed')));
      try { for (const entry of session.initMessages()) post(worker, entry); } catch (e) { done(reject, e); }
    });
  }

  return {
    run, live, cancel, probe,
    isActive: (key) => runs.has(key),
    dispose() { for (const key of [...runs.keys()]) cancel(key); },
  };
}
