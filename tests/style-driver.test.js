// The own-styles worker driver: time slices, live parameters (latest wins), progress throttling, partial and final
// results, errors, the plain() wrapper — with fake post/now/defer in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDriver, plain, staged } from '../src/styles/style-driver.js';
import { crosshatch } from '../src/styles/own/crosshatch.js';
import { wavesSteps, waves } from '../src/styles/own/waves.js';
import { engravingSteps, engraving } from '../src/styles/own/engraving.js';
import { toGray } from '../src/styles/tone.js';
import './helpers/ru.js';
import { sameData } from './helpers/same.js';

/** A driver with a manual clock and a manual slice queue. */
function harness(impl, opts = {}) {
  const sent = [], queue = [];
  const clock = { t: 0 };
  const driver = createDriver({
    impl, post: (msg, transfer) => sent.push({ msg, transfer }), now: () => clock.t, defer: (fn) => queue.push(fn), ...opts,
  });
  return {
    driver, sent, clock, queue,
    step() { const fn = queue.shift(); if (fn) fn(); return !!fn; },
    drain(limit = 100000) { let n = 0; while (queue.length && n++ < limit) queue.shift()(); assert.ok(n < limit, 'the driver settles'); },
    finals: () => sent.filter((s) => s.msg.type === 'result' && s.msg.final),
    of: (type) => sent.filter((s) => s.msg.type === type),
  };
}

// RGBA image w x h from a function (x, y) -> brightness 0..255
function rgba(w, h, f) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = f(x, y), p = 4 * (y * w + x);
    data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255;
  }
  return { width: w, height: h, data };
}
const run = (runId, styleId, image, params, paper = null) => ({ type: 'run', runId, styleId, image, params, paper });
const arr = (lines) => lines.map((l) => Array.from(l));

test('ten live changes in a row: one more computation with the last value and one final result', () => {
  const starts = [];
  const h = harness({
    'own:x': staged(function* ({ params }) {
      starts.push(params.v);
      for (let i = 0; i < 10; i++) { h.clock.t += 10; yield { progress: { key: 'k', params: { percent: i * 10 } } }; }
      return [Float64Array.of(params.v, 0, 1, 1)];
    }),
  });
  h.driver.onMessage(run(1, 'own:x', rgba(2, 2, () => 0), { v: 0 }));
  h.step(); // the first slice: 3 steps of 30 ms
  assert.deepEqual(starts, [0]);
  for (let v = 1; v <= 10; v++) h.driver.onMessage({ type: 'params', runId: 1, params: { v } });
  assert.equal(h.queue.length, 1, 'one slice queued, not ten');
  h.drain();
  assert.deepEqual(starts, [0, 10], 'only the last value is computed');
  assert.equal(h.finals().length, 1);
  assert.deepEqual(arr(h.finals()[0].msg.lines), [[10, 0, 1, 1]]);
  // a foreign runId is ignored
  h.driver.onMessage({ type: 'params', runId: 99, params: { v: 5 } });
  assert.equal(h.queue.length, 0);
});

test('slices: the generator yields to the message loop every sliceMs; progress at most every progressMs', () => {
  const h = harness({
    'own:x': staged(function* () {
      for (let i = 0; i < 100; i++) { h.clock.t += 10; yield { progress: { key: 'k', params: { percent: i } } }; }
      return [];
    }),
  }, { sliceMs: 30, progressMs: 200 });
  h.driver.onMessage(run(1, 'own:x', rgba(1, 1, () => 0), {}));
  let slices = 0;
  while (h.step()) slices++;
  assert.ok(slices >= 30 && slices <= 40, `about 1000 ms / 30 ms slices: ${slices}`);
  const progress = h.of('progress');
  assert.ok(progress.length >= 4 && progress.length <= 6, `about 1000 ms / 200 ms: ${progress.length}`);
  assert.deepEqual(progress[0].msg.text, { key: 'k', params: { percent: 0 } }, 'the first progress goes at once');
  assert.equal(h.finals().length, 1);
});

test('partial results are sent with final:false; the final lines are copies with transferred buffers', () => {
  const kept = Float64Array.of(1, 2, 3, 4);
  const h = harness({
    'own:x': staged(function* () { yield { partial: [kept] }; return [kept]; }),
  });
  h.driver.onMessage(run(7, 'own:x', rgba(1, 1, () => 0), {}));
  h.drain();
  const results = h.of('result');
  assert.deepEqual(results.map((r) => r.msg.final), [false, true]);
  assert.equal(results[0].msg.runId, 7);
  const fin = results[1];
  assert.notEqual(fin.msg.lines[0], kept, 'a copy: the original may live in the stage cache');
  assert.deepEqual(Array.from(fin.msg.lines[0]), [1, 2, 3, 4]);
  assert.deepEqual(fin.transfer, [fin.msg.lines[0].buffer]);
});

test('an exception in a style becomes an error message; an unknown style too', () => {
  const h = harness({ 'own:x': staged(function* () { yield {}; throw new Error('boom'); }) });
  h.driver.onMessage(run(3, 'own:x', rgba(1, 1, () => 0), {}));
  h.drain();
  assert.deepEqual(h.of('error').map((e) => e.msg), [{ type: 'error', runId: 3, message: 'boom' }]);
  h.driver.onMessage(run(4, 'own:nope', rgba(1, 1, () => 0), {}));
  h.drain();
  assert.match(h.of('error').at(-1).msg.message, /unknown style own:nope/);
});

test('crosshatch through plain(): the same result and progress as before', () => {
  const img = rgba(60, 40, (x) => 255 * (1 - x / 59));
  const h = harness({ 'own:crosshatch': plain(crosshatch, 'styles.progress.hatch') });
  h.driver.onMessage(run(1, 'own:crosshatch', img, { levels: 3, spacing: 3 }));
  h.drain();
  assert.equal(h.of('progress')[0].msg.text, 'styles.progress.hatch');
  const direct = crosshatch(toGray(img.data, 60, 40), 60, 40, { levels: 3, spacing: 3 });
  assert.ok(direct.length > 0);
  assert.deepEqual(arr(h.finals()[0].msg.lines), arr(direct));
});

test('wave lines: a live change equals a fresh run, also when it arrives mid-computation', () => {
  const img = rgba(160, 120, (x, y) => (Math.hypot(x - 80, y - 60) < 40 ? 30 : 255 * (1 - x / 159)));
  const paper = { mmPerPx: 0.25, penWidthMm: 0.5 };
  const gray = toGray(img.data, 160, 120);
  const p1 = { amplitude: 0.2, maxPasses: 3 }, p2 = { amplitude: 0.4, maxPasses: 3, spacing: 2 };
  const fresh = arr(waves(gray, 160, 120, p2, paper));
  assert.notDeepEqual(arr(waves(gray, 160, 120, p1, paper)), fresh, 'the parameters matter');

  // p1 to the end, then live p2
  const a = harness({ 'own:waves': staged(wavesSteps) }, { sliceMs: 0 });
  a.driver.onMessage(run(1, 'own:waves', img, p1, paper));
  a.drain();
  a.driver.onMessage({ type: 'params', runId: 1, params: p2 });
  a.drain();
  assert.equal(a.finals().length, 2);
  sameData(arr(a.finals()[1].msg.lines), fresh);

  // live p2 in the middle of p1 (slices of one step, the clock advances on every now())
  const b = harness({ 'own:waves': staged(wavesSteps) }, { sliceMs: 0 });
  b.driver.onMessage(run(1, 'own:waves', img, p1, paper));
  for (let i = 0; i < 20; i++) b.step();
  assert.equal(b.finals().length, 0, 'still computing');
  b.driver.onMessage({ type: 'params', runId: 1, params: p2 });
  b.drain();
  assert.equal(b.finals().length, 1, 'one final, for the last value');
  sameData(arr(b.finals()[0].msg.lines), fresh);
  // the progress object of the style
  assert.equal(b.of('progress')[0].msg.text.key, 'styles.progress.waves');
});

test('a note goes with the final result; a restart with new parameters forgets it', () => {
  const h = harness({
    'own:x': staged(function* ({ params }) {
      if (params.v === 0) yield { note: { key: 'n', params: {} } };
      yield {};
      return [];
    }),
  });
  h.driver.onMessage(run(1, 'own:x', rgba(1, 1, () => 0), { v: 0 }));
  h.drain();
  assert.deepEqual(h.finals()[0].msg.note, { key: 'n', params: {} });
  h.driver.onMessage({ type: 'params', runId: 1, params: { v: 1 } });
  h.drain();
  assert.equal('note' in h.finals()[1].msg, false);
});

test('engraving: a chain of live changes (base angle, cross threshold, passes) mid-computation equals a fresh run', () => {
  const img = rgba(160, 120, (x, y) => (Math.hypot(x - 70, y - 60) < 35 ? 40 : 230 - 150 * (x / 159)));
  const paper = { mmPerPx: 0.25, penWidthMm: 0.5 };
  const p3 = { baseAngle: 70, crossThreshold: 60, maxPasses: 5 };
  const fresh = arr(engraving(toGray(img.data, 160, 120), 160, 120, p3, paper));
  const h = harness({ 'own:engraving': staged(engravingSteps) }, { sliceMs: 0 });
  h.driver.onMessage(run(1, 'own:engraving', img, {}, paper));
  for (let i = 0; i < 15; i++) h.step();
  h.driver.onMessage({ type: 'params', runId: 1, params: { baseAngle: 70 } });
  for (let i = 0; i < 15; i++) h.step();
  h.driver.onMessage({ type: 'params', runId: 1, params: { baseAngle: 70, crossThreshold: 60 } });
  h.drain();
  h.driver.onMessage({ type: 'params', runId: 1, params: p3 });
  h.drain();
  sameData(arr(h.finals().at(-1).msg.lines), fresh);
  // an intermediate result (the main lines) comes before the final one
  const results = h.of('result').map((r) => r.msg.final);
  assert.ok(results.indexOf(false) >= 0 && results.indexOf(false) < results.indexOf(true));
});

test('engraving progress: phases in order, the percent does not fall within a phase, messages at most every 200 ms', () => {
  const img = rgba(240, 180, (x, y) => (Math.hypot(x - 120, y - 90) < 60 ? 20 + x / 3 : 255 * (1 - x / 239)));
  const sent = [], queue = [];
  let t = 0;
  const driver = createDriver({
    impl: { 'own:engraving': staged(engravingSteps) },
    post: (msg) => sent.push({ msg, at: t }), now: () => (t += 25), defer: (fn) => queue.push(fn), sliceMs: 30, progressMs: 200,
  });
  driver.onMessage(run(1, 'own:engraving', img, {}, { mmPerPx: 0.25, penWidthMm: 0.5 }));
  while (queue.length) queue.shift()();
  const progress = sent.filter((s) => s.msg.type === 'progress');
  const order = ['field', 'lines', 'cross', 'finish'].map((k) => `styles.progress.engraving.${k}`);
  assert.ok(progress.length >= 4, `${progress.length} progress messages`);
  let phase = 0, last = -1;
  for (const { msg } of progress) {
    const i = order.indexOf(msg.text.key);
    assert.ok(i >= phase, `phase ${msg.text.key} after ${order[phase]}`);
    if (i > phase) { phase = i; last = -1; }
    assert.ok(msg.text.params.percent >= last, 'the percent does not fall');
    last = msg.text.params.percent;
  }
  assert.ok(new Set(progress.map((p) => p.msg.text.key)).size >= 3, 'several phases are shown');
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i].at - progress[i - 1].at >= 200);
  assert.equal(sent.filter((s) => s.msg.type === 'result' && s.msg.final).length, 1);
});
