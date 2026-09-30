import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, STATUS } from '../src/styles/runner.js';
import { createNativeSession } from '../src/styles/native-adapter.js';

class FakeWorker {
  constructor() { this.sent = []; this.terminated = false; FakeWorker.all.push(this); }
  postMessage(msg, transfer) { this.sent.push({ msg, transfer }); }
  terminate() { this.terminated = true; }
  emit(data) { if (this.onmessage) this.onmessage({ data }); }
}
FakeWorker.all = [];

const descriptor = (over = {}) => ({ id: 'own:fake', adapter: 'native', params: [], createWorker: () => new FakeWorker(), ...over });
const image = () => ({ width: 2, height: 1, data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]) });
const setup = () => { FakeWorker.all = []; return createRunner({ createSession: (d) => createNativeSession(d) }); };
const line = (x) => Float64Array.of(x, 0, x + 1, 1);

test('start: a copy of the image goes to the worker, the layer is computing', () => {
  const runner = setup();
  const img = image();
  const seen = [];
  runner.run('a', descriptor(), { image: img, params: { k: 1 } }, (s) => seen.push(s));
  const w = FakeWorker.all[0];
  assert.equal(w.sent[0].msg.type, 'run');
  assert.equal(w.sent[0].msg.image.data.buffer === img.data.buffer, false, 'buffer is not shared');
  assert.deepEqual(Array.from(w.sent[0].msg.image.data), Array.from(img.data));
  assert.equal(seen.at(-1).status, STATUS.RUNNING);
});

test('stale messages are discarded: a replaced run, a cancelled run, a foreign runId', () => {
  const runner = setup();
  const seenA = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => seenA.push(s));
  const [w1] = FakeWorker.all;
  const id1 = w1.sent[0].msg.runId;
  const seenB = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => seenB.push(s));
  const w2 = FakeWorker.all[1];
  assert.equal(w1.terminated, true, 'previous worker terminated');
  w1.emit({ type: 'result', runId: id1, lines: [line(1)], final: true });
  assert.equal(seenA.at(-1).status, STATUS.RUNNING, 'old worker message did not arrive');
  w2.emit({ type: 'result', runId: id1, lines: [line(9)], final: true }); // runId of the old run
  assert.equal(seenB.at(-1).lines.length, 0);
  const id2 = w2.sent[0].msg.runId;
  assert.notEqual(id1, id2);
  w2.emit({ type: 'result', runId: id2, lines: [line(2)], final: true });
  assert.equal(seenB.at(-1).status, STATUS.DONE);
  assert.deepEqual(Array.from(seenB.at(-1).lines[0]), [2, 0, 3, 1]);
  runner.cancel('a');
  const n = seenB.length;
  w2.emit({ type: 'progress', runId: id2, text: 'после отмены' });
  assert.equal(seenB.length, n);
});

test('without final the status stays computing at any pause, the result is intermediate', async () => {
  const runner = setup();
  const seen = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => seen.push(s));
  const w = FakeWorker.all[0], id = w.sent[0].msg.runId;
  w.emit({ type: 'progress', runId: id, text: 'Iteration 12' });
  w.emit({ type: 'result', runId: id, lines: [line(1)], final: false, reason: 'завершение стиля не отслеживается' });
  await new Promise((r) => setTimeout(r, 120));
  const s = seen.at(-1);
  assert.equal(s.status, STATUS.RUNNING);
  assert.equal(s.partial, true);
  assert.equal(s.progress, 'Iteration 12');
  assert.equal(s.reason, 'завершение стиля не отслеживается');
  assert.equal(s.lines.length, 1);
});

test('final: status done, the result is not intermediate, the worker stays listening', () => {
  const runner = setup();
  const seen = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => seen.push(s));
  const w = FakeWorker.all[0], id = w.sent[0].msg.runId;
  w.emit({ type: 'result', runId: id, lines: [line(1), line(3)], final: true });
  assert.equal(seen.at(-1).status, STATUS.DONE);
  assert.equal(seen.at(-1).partial, false);
  assert.equal(w.terminated, false, 'worker still listens after final');
  assert.equal(w.terminated, false);
  runner.cancel('a');
  assert.equal(w.terminated, true);
});

test('a style without live parameters: data after final at any moment returns the layer to intermediate', () => {
  const runner = setup();
  const seen = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => seen.push(s));
  const w = FakeWorker.all[0], id = w.sent[0].msg.runId;
  w.emit({ type: 'result', runId: id, lines: [line(1)], final: true });
  assert.equal(seen.at(-1).status, STATUS.DONE);
  w.emit({ type: 'result', runId: id, lines: [line(1), line(2)], final: false, late: true, reason: 'стиль продолжил вывод после завершения' });
  assert.equal(seen.at(-1).status, STATUS.PARTIAL);
  assert.equal(seen.at(-1).lines.length, 2);
  assert.equal(w.terminated, false);
  w.emit({ type: 'result', runId: id, lines: [line(1), line(2), line(3)], final: true });
  assert.equal(seen.at(-1).status, STATUS.DONE);
  w.emit({ type: 'result', runId: id, lines: [line(1)], final: false, late: true });
  assert.equal(seen.at(-1).status, STATUS.PARTIAL);
  runner.cancel('a');
  assert.equal(w.terminated, true);
});

test('after final the worker is terminated by cancel, run replacement and dispose', () => {
  const runner = setup();
  const fin = (w) => w.emit({ type: 'result', runId: w.sent[0].msg.runId, lines: [], final: true });
  runner.run('a', descriptor(), { image: image(), params: {} }, () => {});
  const a = FakeWorker.all[0]; fin(a);
  assert.equal(a.terminated, false);
  runner.cancel('a');
  assert.equal(a.terminated, true);
  runner.run('b', descriptor(), { image: image(), params: {} }, () => {});
  const b = FakeWorker.all[1]; fin(b);
  runner.run('b', descriptor(), { image: image(), params: {} }, () => {});
  assert.equal(b.terminated, true, 'replacement');
  const b2 = FakeWorker.all[2]; fin(b2);
  runner.dispose();
  assert.equal(b2.terminated, true, 'dispose');
  assert.equal(runner.isActive('b'), false);
});

test('data after completion: the layer is intermediate with a reason, the result updated', () => {
  const runner = setup();
  const seen = [];
  runner.run('a', descriptor({ params: [{ key: 'x', live: true }] }), { image: image(), params: {} }, (s) => seen.push(s));
  const w = FakeWorker.all[0], id = w.sent[0].msg.runId;
  w.emit({ type: 'result', runId: id, lines: [line(1)], final: true });
  assert.equal(seen.at(-1).status, STATUS.DONE);
  w.emit({ type: 'result', runId: id, lines: [line(1), line(2)], final: false, late: true, reason: 'стиль продолжил вывод после завершения' });
  const s = seen.at(-1);
  assert.equal(s.status, STATUS.PARTIAL);
  assert.equal(s.partial, true);
  assert.equal(s.reason, 'стиль продолжил вывод после завершения');
  assert.equal(s.lines.length, 2);
});

test('worker error: the layer is in error, other layers are not affected', () => {
  const runner = setup();
  const a = [], b = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => a.push(s));
  runner.run('b', descriptor(), { image: image(), params: {} }, (s) => b.push(s));
  const [wa, wb] = FakeWorker.all;
  wa.onerror({ message: 'boom', preventDefault() {} });
  assert.equal(a.at(-1).status, STATUS.ERROR);
  assert.equal(a.at(-1).message, 'boom');
  assert.equal(wa.terminated, true);
  assert.equal(b.at(-1).status, STATUS.RUNNING);
  wb.emit({ type: 'result', runId: wb.sent[0].msg.runId, lines: [line(1)], final: true });
  assert.equal(b.at(-1).status, STATUS.DONE);
  wa.emit({ type: 'result', runId: wa.sent[0].msg.runId, lines: [], final: true }); // changes nothing
  assert.equal(a.at(-1).status, STATUS.ERROR);
});

test('an error message from a style puts the layer into error', () => {
  const runner = setup();
  const a = [];
  runner.run('a', descriptor(), { image: image(), params: {} }, (s) => a.push(s));
  const w = FakeWorker.all[0];
  w.emit({ type: 'error', runId: w.sent[0].msg.runId, message: 'плохие параметры' });
  assert.equal(a.at(-1).status, STATUS.ERROR);
  assert.equal(a.at(-1).message, 'плохие параметры');
});

test('live parameters go to the running worker without a restart; without live — false', () => {
  const runner = setup();
  const seen = [];
  runner.run('a', descriptor({ params: [{ key: 'dot', live: true }] }), { image: image(), params: { dot: 1 } }, (s) => seen.push(s));
  const w = FakeWorker.all[0], id = w.sent[0].msg.runId;
  w.emit({ type: 'result', runId: id, lines: [line(1)], final: true });
  assert.equal(w.terminated, false, 'worker with live params alive after final');
  assert.equal(runner.live('a', { dot: 2 }), true);
  assert.equal(FakeWorker.all.length, 1);
  assert.deepEqual(w.sent.at(-1).msg, { type: 'params', runId: id, styleId: 'own:fake', params: { dot: 2 } });
  assert.equal(seen.at(-1).status, STATUS.RUNNING);
  w.emit({ type: 'result', runId: id, lines: [line(5)], final: true });
  assert.equal(seen.at(-1).status, STATUS.DONE);

  const r2 = setup();
  r2.run('a', descriptor(), { image: image(), params: {} }, () => {});
  assert.equal(r2.live('a', {}), false);
  assert.equal(r2.live('missing', {}), false);
});

test('probe: dynamic style parameters from sliders, the worker terminates', async () => {
  FakeWorker.all = [];
  const runner = createRunner({
    createSession: () => ({
      initMessages: () => [[{ type: 'init' }]],
      decode: (m) => (m.type === 'sliders' ? [{ type: 'sliders', params: [{ key: 'A' }] }] : []),
    }),
  });
  const promise = runner.probe(descriptor());
  const w = FakeWorker.all[0];
  assert.deepEqual(w.sent[0].msg, { type: 'init' });
  w.emit({ type: 'sliders', controls: [] });
  assert.deepEqual(await promise, [{ key: 'A' }]);
  assert.equal(w.terminated, true);
});

test('quick restarts: only the last run reaches the result', () => {
  const runner = setup();
  const seen = [];
  for (let i = 0; i < 10; i++) runner.run('a', descriptor(), { image: image(), params: { i } }, (s) => seen.push(s));
  assert.equal(FakeWorker.all.filter((w) => !w.terminated).length, 1);
  FakeWorker.all.forEach((w, i) => w.emit({ type: 'result', runId: w.sent[0].msg.runId, lines: [line(i)], final: true }));
  assert.equal(seen.at(-1).status, STATUS.DONE);
  assert.deepEqual(Array.from(seen.at(-1).lines[0]), [9, 0, 10, 1]);
});
