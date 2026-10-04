// Style driver inside the own-styles worker: runs a style's steps generator in time slices, applies live parameters,
// throttles progress, sends intermediate and final results. Not in the pure zone (timers are injected, though: tests pass
// fake post/now/defer and run it in node).
//
// A style for the driver is a factory  ({ gray, w, h, params, paper, cache, fade }) => generator  (see own/kit/stages.js):
// it yields { progress: text } (text — a dictionary key or { key, params }), { partial: lines } and { note: text } (a remark
// that stays with the final result, e.g. "too many lines"; the last one wins), and returns the final lines. A plain function (gray, w, h, params, paper, fade) => lines is wrapped by plain().
// fade — the "Fade background" tone mask (styles/prep.js toneFade: Float32Array w*h of keep factors, or null): the style
// multiplies its darkness by it after tone mapping (applyFade) and never uses it for geometry.
//
// Protocol (protocol.js): in  {type:'run', runId, styleId, image, params, paper, fade}, {type:'params', runId, params};
//                         out {type:'progress', runId, text}, {type:'result', runId, lines, final, note?}, {type:'error', runId, message}.
// Live parameters: the latest 'params' wins. They are remembered as pending; at the next slice boundary the current
// generator is dropped and a new one starts with the latest values and the same stage cache (unchanged stages are reused).
// Ten messages in a row give one computation and one final result.
import { RUN, PARAMS, PROGRESS, RESULT, ERROR } from './protocol.js';
import { toGray } from './tone.js';
import { toneFade } from './prep.js';
import { createCache } from './own/kit/stages.js';

/** A plain style function as a one-step generator; progressKey (optional) is reported first. */
export function plain(fn, progressKey = '') {
  return function* plainSteps({ gray, w, h, params, paper, fade }) {
    if (progressKey) yield { progress: progressKey };
    return fn(gray, w, h, params, paper, fade);
  };
}

/** A steps generator factory as is (a marker for readability of the IMPL table). */
export const staged = (steps) => steps;

const messageOf = (err) => (err && err.message ? err.message : String(err));

/**
 * @param impl  { styleId: factory } (plain(fn) or staged(steps))
 * @param post  (msg, transfer?) => void — self.postMessage in the worker
 * @param now   () => ms; defer (fn) => void — the next slice (setTimeout 0: incoming messages are handled in between)
 * @param sliceMs    how long one slice runs the generator before yielding to the message loop
 * @param progressMs progress messages are sent at most this often
 */
export function createDriver({ impl, post, now = () => Date.now(), defer = (fn) => setTimeout(fn, 0), sliceMs = 30, progressMs = 200 }) {
  let job = null;
  let scheduled = false;

  const schedule = () => { if (!scheduled) { scheduled = true; defer(slice); } };

  function start(j, params) {
    j.params = params;
    j.note = null;
    j.gen = j.steps({ gray: j.gray, w: j.w, h: j.h, params, paper: j.paper, cache: j.cache, fade: j.fade });
    j.runs++;
  }

  function fail(j, err) {
    j.gen = null;
    post({ type: ERROR, runId: j.runId, message: messageOf(err) });
  }

  function yielded(j, y) {
    if (!y || typeof y !== 'object') return;
    if (y.progress !== undefined) {
      const t = now();
      if (t - j.lastProgress >= progressMs) { j.lastProgress = t; post({ type: PROGRESS, runId: j.runId, text: y.progress }); }
    }
    if (y.note !== undefined) j.note = y.note;
    // structured clone copies the arrays: the style may keep (cache) them
    if (y.partial) post({ type: RESULT, runId: j.runId, lines: y.partial, final: false });
  }

  function finish(j, lines) {
    // copies are transferred: the originals may live in the stage cache and must not be detached
    const out = (lines || []).map((l) => Float64Array.from(l));
    const msg = { type: RESULT, runId: j.runId, lines: out, final: true };
    if (j.note) msg.note = j.note;
    post(msg, out.map((l) => l.buffer));
  }

  function slice() {
    scheduled = false;
    const j = job;
    if (!j) return;
    try {
      if (j.pending) { const p = j.pending; j.pending = null; start(j, p); }
      if (!j.gen) return;
      const t0 = now();
      for (;;) {
        const r = j.gen.next();
        if (r.done) { j.gen = null; finish(j, r.value); return; }
        yielded(j, r.value);
        if (now() - t0 >= sliceMs) break;
      }
    } catch (err) { fail(j, err); return; }
    schedule();
  }

  function onMessage(msg) {
    if (!msg) return;
    if (msg.type === RUN) {
      const { runId, styleId, image, params, paper, fade } = msg;
      const steps = impl[styleId];
      const j = { runId, styleId, steps, gray: null, fade: null, w: image && image.width, h: image && image.height, paper: paper || null,
        cache: createCache(), params, gen: null, pending: null, note: null, lastProgress: -Infinity, runs: 0 };
      job = j;
      try {
        if (!steps) throw new Error(`unknown style ${styleId}`);
        j.gray = toGray(image.data, image.width, image.height);
        j.fade = fade ? toneFade(image.width, image.height, fade) : null;
        start(j, params);
      } catch (err) { fail(j, err); return; }
      schedule();
    } else if (msg.type === PARAMS) {
      if (!job || msg.runId !== job.runId || !job.steps || !job.gray) return;
      job.pending = msg.params;
      schedule();
    }
  }

  return {
    onMessage,
    /** Diagnostics for tests: how many generators were started for the current run, and whether a slice is queued. */
    get stats() { return { runs: job ? job.runs : 0, scheduled, busy: !!(job && (job.gen || job.pending)) }; },
  };
}
