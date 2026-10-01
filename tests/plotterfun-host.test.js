// plotterfun-host wrapper on real plotterfun styles: for each style with a verified model (≠ none)
// over parameter variants, on two images: final arrives, no data after it, the result matches the reference
// (the style without the wrapper; the end of computation by node data: no pending timers). The quiet period after final defaults to 250 ms instead of 1 s from design.md; PLOTTERFUN_FULL=1 sets 1 s.
// By default a fast set; the full sweep of all 23 styles — PLOTTERFUN_SWEEP=1.
import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commonDefaults } from '../src/styles/plotterfun-adapter.js';
import { probeControls, runHosted, runDirect, makeImage, spawnWorker, sleep, VENDOR_DIR } from './helpers/pf-harness.js';
import './helpers/ru.js';

const manifest = JSON.parse(readFileSync(new URL('../src/styles/plotterfun-completion.json', import.meta.url), 'utf8'));
const FULL = !!process.env.PLOTTERFUN_FULL;
const SWEEP = !!process.env.PLOTTERFUN_SWEEP;
const REF_QUIET = FULL ? 5000 : 150;
const AFTER_QUIET = FULL ? 1000 : 250;
// Extreme values at which a style computes for minutes: capped from above in the test (the cap does not affect the property under test)
const HEAVY_MAX = { 'Max Stipples': 3000, 'Max Iterations': 40, 'Max Iterations ': 40 };
const IMAGES = { 'градиент 64×64': makeImage('gradient', 64, 64), 'фото 160×120': makeImage('photo', 160, 120) };

const defaultOf = (c) => (c.type === 'checkbox' ? !!(c.checked ?? c.value) : c.type === 'select' ? (c.value ?? c.options[0]) : c.value);

export function variantsOf(controls) {
  const base = { ...commonDefaults(), ...Object.fromEntries(controls.map((c) => [c.label, defaultOf(c)])) };
  const out = [{ name: 'по умолчанию', params: { ...base } }];
  for (const c of controls) {
    if (c.type === 'select') {
      for (const o of c.options) if (o !== base[c.label]) out.push({ name: `${c.label}=${o}`, params: { ...base, [c.label]: o } });
    } else if (c.type === 'checkbox') out.push({ name: `${c.label}=${!base[c.label]}`, params: { ...base, [c.label]: !base[c.label] } });
    else if (!c.type || c.type === 'range') {
      const hi = Math.min(c.max, HEAVY_MAX[c.label] ?? c.max);
      out.push({ name: `${c.label}=min`, params: { ...base, [c.label]: c.min } }, { name: `${c.label}=max`, params: { ...base, [c.label]: hi } });
    }
  }
  const live = controls.filter((c) => c.noRestart);
  if (live.length) {
    const followUps = live.map((c) => ({ [c.label]: c.type === 'checkbox' ? !base[c.label] : c.type === 'select' ? c.options[c.options.length - 1] : Math.min(c.max, HEAVY_MAX[c.label] ?? c.max) }));
    out.push({ name: 'live-параметры', params: { ...base }, followUps });
  }
  return out;
}

const styles = Object.entries(manifest.styles).filter(([, model]) => model !== 'none');

test('manifest: stipple and delaunay — timer-chain, jaggy — async-handler, the rest without asynchrony — sync', () => {
  assert.equal(manifest.styles.stipple, 'timer-chain');
  assert.equal(manifest.styles.delaunay, 'timer-chain');
  assert.equal(manifest.styles.jaggy, 'async-handler');
  assert.equal(Object.keys(manifest.styles).length, 23);
  for (const [name, model] of Object.entries(manifest.styles)) {
    if (!['stipple', 'delaunay', 'jaggy'].includes(name)) assert.equal(model, 'sync', name);
  }
});

// Checks one variant; returns 'ok' | 'skipped' (the style itself fails/loops, the reference behaves the same)
async function checkVariant(style, model, imageName, image, v, note) {
  const args = { style, image, params: v.params, followUps: v.followUps || [], limitMs: 90000 };
  const hosted = await runHosted({ ...args, model, quietMs: AFTER_QUIET });
  const where = `${style} / ${imageName} / ${v.name}`;
  if (hosted.hung || hosted.errors.length || hosted.finalOk.some((ok) => !ok)) {
    const ref = await runDirect({ ...args, quietMs: REF_QUIET });
    assert.ok(ref.hung || ref.failed, `${where}: host gave no final (${hosted.errors[0] || 'no reply'}), while the style itself works`);
    if (note) note.push(`${where} (${ref.hung ? 'зацикливается' : hosted.errors[0]})`);
    return 'skipped';
  }
  assert.ok(hosted.afterFinal.every((n) => n === 0), `${where}: data after final ${hosted.afterFinal}`);
  const ref = await runDirect({ ...args, quietMs: REF_QUIET });
  assert.ok(ref.ok, `${where}: reference did not finish`);
  assert.equal(hosted.path === null, ref.path === null, `${where}: result presence`);
  assert.equal(hosted.path, ref.path, `${where}: result differs from reference`);
  return 'ok';
}

// Fast set (default): one style per execution model, one variant on the "photo"; stipple reduced.
describe('plotterfun via the host: fast set', () => {
  const SMOKE = [['squiggle', 'sync', {}], ['jaggy', 'async-handler', {}], ['stipple', 'timer-chain', { 'Max Stipples': 500, 'Max Iterations': 6 }]];
  for (const [style, model, over] of SMOKE) {
    it(`${style} (${model}): final, quiet after it, the result as the reference`, async () => {
      const controls = await probeControls(style);
      const [v] = variantsOf(controls);
      assert.equal(await checkVariant(style, model, 'фото 160×120', IMAGES['фото 160×120'], { ...v, params: { ...v.params, ...over } }), 'ok');
    });
  }
  it('the style fails by itself (dots, Min brightness=max): skipped because the reference fails the same way', async () => {
    const controls = await probeControls('dots');
    const v = variantsOf(controls).find((x) => x.name === 'Min brightness=max');
    assert.equal(await checkVariant('dots', 'sync', 'градиент 64×64', IMAGES['градиент 64×64'], v), 'skipped');
  });
});

// Full sweep of 23 styles (task 2.3): PLOTTERFUN_SWEEP=1 node --test tests/plotterfun-host.test.js
describe('plotterfun via the host: full sweep', { concurrency: 4, skip: !SWEEP && 'PLOTTERFUN_SWEEP=1' }, () => {
  for (const [style, model] of styles) {
    it(`${style} (${model}): final arrives, quiet after it, the result matches the reference`, { timeout: 600000 }, async () => {
      const controls = await probeControls(style);
      assert.ok(controls && controls.length, 'style sent sliders');
      const skipped = [];
      let checked = 0;
      for (const [imageName, image] of Object.entries(IMAGES)) {
        const variants = variantsOf(controls);
        for (let i = 0; i < variants.length; i += 4) {
          const res = await Promise.all(variants.slice(i, i + 4).map((v) => checkVariant(style, model, imageName, image, v, skipped)));
          checked += res.filter((r) => r === 'ok').length;
        }
      }
      assert.ok(checked > 0);
      if (skipped.length) console.log(`  ${style}: варианты, на которых падает или зацикливается сам стиль plotterfun (${skipped.length}): ${skipped.join('; ')}`);
    });
  }
});

test('data after final: the layer learns about it (late:true)', async () => {
  const w = spawnWorker({ hosted: true });
  // a synthetic "style": we declare sync, but it sends a second batch via a timer
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pf-late-'));
  writeFileSync(join(dir, 'late.js'), `postMessage(['sliders', []]);
onmessage = function () { postMessage(['svg-path', 'M0,0L1,1']); setTimeout(function () { postMessage(['svg-path', 'M0,0L2,2']); }, 30); };`);
  w.post({ type: 'init', style: 'late', model: 'sync', base: dir + '/' });
  await sleep(50);
  w.post({ type: 'run', runId: 1, image: { width: 1, height: 1, data: new Uint8ClampedArray(4) }, params: {} });
  await sleep(200);
  await w.terminate();
  const kinds = w.messages.filter((m) => m.type !== 'sliders').map((m) => `${m.type}${m.late ? ':late' : ''}`);
  assert.deepEqual(kinds, ['svg-path', 'final', 'svg-path:late']);
});

test('none: final never arrives', async () => {
  const w = spawnWorker({ hosted: true });
  w.post({ type: 'init', style: 'squiggle', model: 'none', base: VENDOR_DIR + '/' });
  await sleep(50);
  w.post({ type: 'run', runId: 1, image: makeImage('gradient', 64, 64), params: { ...commonDefaults(), ...Object.fromEntries((await probeControls('squiggle')).map((c) => [c.label, defaultOf(c)])) } });
  await sleep(500);
  await w.terminate();
  assert.ok(w.messages.some((m) => m.type === 'svg-path'));
  assert.ok(!w.messages.some((m) => m.type === 'final'));
});

test('timer-chain: final does not arrive between iterations (stipple)', async () => {
  const controls = await probeControls('stipple');
  const params = { ...commonDefaults(), ...Object.fromEntries(controls.map((c) => [c.label, defaultOf(c)])), 'Max Stipples': 500, 'Max Iterations': 6 };
  const r = await runHosted({ style: 'stipple', model: 'timer-chain', image: makeImage('photo', 80, 60), params, quietMs: 100 });
  const kinds = r.msgs.filter((m) => !(m.__idle || m.__pong)).map((m) => m.type);
  assert.equal(kinds.filter((k) => k === 'final').length, 1);
  assert.equal(kinds.lastIndexOf('final'), kinds.length - 1, 'final is the last message');
  assert.ok(r.msgs.filter((m) => m.type === 'msg' && /^Iteration/.test(m.text)).length >= 6);
});
