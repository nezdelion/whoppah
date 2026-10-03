// Staged computation with a cache, for own styles with live parameters. Pure, no DOM and no timers.
//
// A style is a generator  function* steps({ gray, w, h, params, paper, cache })  that
//   - computes its stages through stage()/stageGen(): a stage with the same dependencies as last time returns the cached
//     value without recomputing (a live slider that touches only the last stage reuses the tone, the geometry, ...);
//   - may yield { progress: { key, params } } (a dictionary key and its parameters, e.g. a percent) and { partial: lines }
//     (an intermediate result); the driver (styles/style-driver.js) decides how often to send them;
//   - returns the final lines (Float64Array[]).
// The driver runs the generator in time slices and can drop it at any yield (new live parameters): a stage is stored only when
// it completes, so a dropped run leaves the cache consistent.
//
// Dependencies are compared element-wise with === (numbers: -0 equals 0, NaN equals NaN). To chain stages, pass the value of
// the upstream stage itself as a dependency: it is a new object whenever that stage was recomputed, so everything downstream
// is invalidated. The result must depend only on the inputs and the parameters, never on the cache history
// (a live change gives exactly the same lines as a fresh run with the same parameters).

/** One cache per image/run: the driver creates a new one on every 'run'. */
export const createCache = () => new Map();

const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));

function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
  return true;
}

/** The cached value of stage name if deps are equal, otherwise fn() (the previous value of that stage is replaced). */
export function stage(cache, name, deps, fn) {
  const hit = cache && cache.get(name);
  if (hit && sameDeps(hit.deps, deps)) return hit.value;
  const value = fn();
  if (cache) cache.set(name, { deps: deps.slice(), value });
  return value;
}

/** The same for a generator stage: use as  const v = yield* stageGen(cache, name, deps, function* () { ...; return v; }). */
export function* stageGen(cache, name, deps, genFn) {
  const hit = cache && cache.get(name);
  if (hit && sameDeps(hit.deps, deps)) return hit.value;
  const value = yield* genFn();
  if (cache) cache.set(name, { deps: deps.slice(), value });
  return value;
}

/** Runs a steps generator to the end ignoring progress and partial results (node tests, a synchronous call). */
export function runToEnd(gen) {
  for (;;) {
    const r = gen.next();
    if (r.done) return r.value;
  }
}

/** Progress message from a style: { progress: { key, params: { percent } } }, percent is an integer 0..100. */
export const progressOf = (key, fraction) => ({ progress: { key, params: { percent: Math.min(100, Math.max(0, Math.floor(fraction * 100))) } } });
