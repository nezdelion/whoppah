import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePath, COMMON_CONTROLS, commonDefaults, controlsToParams, createPlotterfunSession, REASON_LATE, REASON_UNTRACKED } from '../src/styles/plotterfun-adapter.js';
import { resolveModels, parseUpstream, loadModels } from '../src/styles/plotterfun-models.js';
import { probeControls, runHosted, makeImage } from './helpers/pf-harness.js';
import './helpers/ru.js';

const defaultOf = (c) => (c.type === 'checkbox' ? !!(c.checked ?? c.value) : c.type === 'select' ? (c.value ?? c.options[0]) : c.value);
const near = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sliders -> parameter description: types, bounds, defaults, live', () => {
  const params = controlsToParams([
    { label: 'Inverted', type: 'checkbox' },
    { label: 'Brightness', value: 0, min: -100, max: 100 },
    { label: 'Amplitude', value: 1, min: 0.1, max: 5, step: 0.1 },
    { label: 'Modulation', type: 'select', value: 'both', options: ['both', 'AM', 'FM'] },
    { label: 'Stipple type', type: 'select', options: ['Circles', 'Spirals'], noRestart: true },
  ]);
  assert.deepEqual(params[0], { key: 'Inverted', label: 'Inverted', live: false, type: 'bool', default: false });
  assert.deepEqual(params[1], { key: 'Brightness', label: 'Brightness', live: false, type: 'number', min: -100, max: 100, step: 1, default: 0 });
  assert.equal(params[2].step, 0.1);
  assert.deepEqual(params[3].options, ['both', 'AM', 'FM']);
  assert.equal(params[3].default, 'both');
  assert.equal(params[4].default, 'Circles');
  assert.equal(params[4].live, true);
});

test('plotterfun circles (an arc with the large-arc flag) -> closed polylines of the same radius', () => {
  const s = createPlotterfunSession({ style: 'halftone', model: 'sync' });
  const [ev] = s.decode({ type: 'svg-path', d: 'M10.00,8.00 a 2.000 2.000 0 1 0 0.001 0Z M30.00,22.00 a 5.000 5.000 0 1 0 0.001 0Z ', late: false });
  assert.equal(ev.type, 'result');
  assert.equal(ev.lines.length, 2);
  [[10, 10, 2], [30, 27, 5]].forEach(([cx, cy, r], i) => {
    const l = ev.lines[i];
    assert.deepEqual([l[0], l[1]], [l[l.length - 2], l[l.length - 1]], 'closed');
    assert.ok(l.length / 2 > 12, 'enough points');
    for (let k = 0; k < l.length; k += 2) near(Math.hypot(l[k] - cx, l[k + 1] - cy), r, 0.03 * r + 0.01);
  });
});

test('recording squiggle messages: path -> lines in image coordinates, final -> the last result', async () => {
  const controls = await probeControls('squiggle');
  const params = { ...commonDefaults(), ...Object.fromEntries(controls.map((c) => [c.label, defaultOf(c)])) };
  const image = makeImage('photo', 120, 90);
  const rec = await runHosted({ style: 'squiggle', model: 'sync', image, params, quietMs: 50 });
  const s = createPlotterfunSession({ style: 'squiggle', model: 'sync' });
  const events = rec.msgs.flatMap((m) => s.decode(m));
  const sliders = events.find((e) => e.type === 'sliders');
  assert.ok(sliders.params.some((p) => p.key === 'Line Count' && p.default === 50));
  const results = events.filter((e) => e.type === 'result');
  assert.equal(results.length, 2);
  assert.equal(results[0].final, false);
  assert.equal(results[1].final, true);
  assert.equal(results[1].lines, results[0].lines);
  const lines = results[1].lines;
  assert.equal(lines.length, Math.ceil(90 / Math.floor(90 / 50)), 'one line per grid row');
  for (const l of lines) for (let i = 0; i < l.length; i += 2) {
    assert.ok(l[i] >= 0 && l[i] <= 120.01 && l[i + 1] > -20 && l[i + 1] < 110);
  }
});

test('recording halftone messages: circles with the radius from the parameters', async () => {
  const controls = await probeControls('halftone');
  const params = { ...commonDefaults(), ...Object.fromEntries(controls.map((c) => [c.label, defaultOf(c)])) };
  const image = { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4).fill(0) };
  for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255; // black
  const rec = await runHosted({ style: 'halftone', model: 'sync', image, params, quietMs: 50 });
  const s = createPlotterfunSession({ style: 'halftone', model: 'sync' });
  const results = rec.msgs.flatMap((m) => s.decode(m)).filter((e) => e.type === 'result' && e.final);
  const lines = results[0].lines;
  assert.ok(lines.length > 100);
  const l = lines[0];
  assert.deepEqual([l[0], l[1]], [l[l.length - 2], l[l.length - 1]]);
  // major = (100+100)/25/2 = 4, hm = 2, r = 255 * hm / 255 * factor/100 = 2
  const xs = []; for (let k = 0; k < l.length; k += 2) xs.push(l[k]);
  near((Math.max(...xs) - Math.min(...xs)) / 2, 2, 0.1);
});

test('NaN in a path: bad points and circles are dropped, the rest stays', () => {
  const squash = (t) => t.replace(/\s+/g, '');
  assert.equal(sanitizePath('M0,0L1,1'), 'M0,0L1,1');
  assert.equal(squash(sanitizePath(' M0,0L1,1L2,NaN L3,3 M5,5LNaN,NaN')), 'M0,0L1,1L3,3M5,5');
  assert.equal(squash(sanitizePath('M1,NaN L2,2L3,3')), 'M2,2L3,3');
  assert.equal(squash(sanitizePath('M1,1 a 2 2 0 1 0 0.001 0Z M4,NaN a 2 2 0 1 0 0.001 0Z ')), squash('M1,1 a 2 2 0 1 0 0.001 0Z'));
  const s = createPlotterfunSession({ style: 'x', model: 'sync' });
  const [ev] = s.decode({ type: 'svg-path', d: ' M0,0L1,NaN L2,2 M9,9L8,8' });
  assert.equal(ev.type, 'result');
  assert.equal(ev.lines.length, 2);
});

test('an unparseable style path gives an error event, not an exception', () => {
  const s = createPlotterfunSession({ style: 'x', model: 'sync' });
  assert.equal(s.decode({ type: 'svg-path', d: 'M1,1 Lx' })[0].type, 'error');
});

test('progress, error, the none model and data after final', () => {
  const none = createPlotterfunSession({ style: 'x', model: 'none' });
  assert.deepEqual(none.decode({ type: 'msg', text: 'Iteration 3' }), [{ type: 'progress', text: 'Iteration 3' }]);
  const [r] = none.decode({ type: 'svg-path', d: 'M0,0L5,5' });
  assert.equal(r.final, false);
  assert.equal(r.reason, REASON_UNTRACKED);
  assert.deepEqual(none.decode({ type: 'error', message: 'boom' }), [{ type: 'error', message: 'boom' }]);
  const sync = createPlotterfunSession({ style: 'x', model: 'sync' });
  assert.equal(sync.decode({ type: 'svg-path', d: 'M0,0L5,5' })[0].reason, undefined);
  const [late] = sync.decode({ type: 'svg-path', d: 'M0,0L6,6', late: true });
  assert.equal(late.late, true);
  assert.equal(late.reason, REASON_LATE);
});

test('models: apply only when vendorCommit matches UPSTREAM', () => {
  const hash = 'a'.repeat(40);
  const manifest = { vendorCommit: hash, styles: { squiggle: 'sync', stipple: 'timer-chain', weird: 'magic' } };
  const upstream = `${hash}\nrepo: https://example.org\n`;
  const ok = resolveModels(manifest, upstream);
  assert.equal(ok('squiggle'), 'sync');
  assert.equal(ok('stipple'), 'timer-chain');
  assert.equal(ok('weird'), 'none');
  assert.equal(ok('unknown'), 'none');
  for (const bad of [resolveModels(manifest, 'b'.repeat(40) + '\n'), resolveModels(manifest, null), resolveModels(manifest, 'garbage'), resolveModels(null, upstream), resolveModels({ vendorCommit: hash }, upstream)]) {
    assert.equal(bad('squiggle'), 'none');
    assert.equal(bad('stipple'), 'none');
  }
  assert.equal(parseUpstream(`${hash}\n`), hash);
  assert.equal(parseUpstream('short'), null);
});

test('loadModels: no file or broken JSON — none for all', async () => {
  const hash = 'c'.repeat(40);
  const files = { 'm.json': JSON.stringify({ vendorCommit: hash, styles: { squiggle: 'sync' } }), 'u.txt': hash + '\n' };
  const ok = await loadModels(async (u) => files[u], { manifestUrl: 'm.json', upstreamUrl: 'u.txt' });
  assert.equal(ok('squiggle'), 'sync');
  const missing = await loadModels(async (u) => { if (u === 'u.txt') throw new Error('404'); return files[u]; }, { manifestUrl: 'm.json', upstreamUrl: 'u.txt' });
  assert.equal(missing('squiggle'), 'none');
  const broken = await loadModels(async (u) => (u === 'm.json' ? '{oops' : files[u]), { manifestUrl: 'm.json', upstreamUrl: 'u.txt' });
  assert.equal(broken('squiggle'), 'none');
});

test('the real vendor/UPSTREAM and the manifest are consistent: the models apply', async () => {
  const { readFileSync } = await import('node:fs');
  const manifest = JSON.parse(readFileSync(new URL('../src/styles/plotterfun-completion.json', import.meta.url), 'utf8'));
  const upstream = readFileSync(new URL('../vendor/plotterfun/UPSTREAM', import.meta.url), 'utf8');
  const modelOf = resolveModels(manifest, upstream);
  assert.equal(modelOf('squiggle'), 'sync');
  assert.equal(modelOf('stipple'), 'timer-chain');
  assert.equal(modelOf('jaggy'), 'async-handler');
});

test('common parameters match defaultControls from helpers.js; the checkbox reads checked', async () => {
  const vm = await import('node:vm');
  const { readFileSync } = await import('node:fs');
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../vendor/plotterfun/helpers.js', import.meta.url), 'utf8').split('function pixelProcessor')[0], ctx);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.defaultControls)), JSON.parse(JSON.stringify(COMMON_CONTROLS)));
  assert.deepEqual(commonDefaults(), { Inverted: false, Brightness: 0, Contrast: 0, 'Min brightness': 0, 'Max brightness': 255 });
  assert.equal(controlsToParams([{ label: 'Contours', type: 'checkbox', checked: true }])[0].default, true);
});

test('a style without common parameters (linescan): the form gets them, a run substitutes defaults', () => {
  const s = createPlotterfunSession({ style: 'linescan', model: 'sync', commonTone: true });
  const [ev] = s.decode({ type: 'sliders', controls: [{ label: 'Spacing', value: 5, min: 1, max: 20 }] });
  assert.deepEqual(ev.params.map((p) => p.key), ['Spacing', ...COMMON_CONTROLS.map((c) => c.label)]);
  const [msg] = s.runMessage({ runId: 1, image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, params: { Spacing: 7 } });
  assert.equal(msg.params.Spacing, 7);
  assert.equal(msg.params['Max brightness'], 255);
});
