// Shared module worker of own styles (native protocol): {type:'run', styleId, image, params, paper} and live
// {type:'params', runId, params} -> progress/result/error. The work is done by the style driver (../style-driver.js):
// time slices, live parameters (the latest wins), progress, intermediate and final results.
import { createDriver, plain, staged } from '../style-driver.js';
import { crosshatch } from './crosshatch.js';
import { wavesSteps } from './waves.js';
import { engravingSteps } from './engraving.js';

// id -> steps factory: plain(fn) for a function (gray, w, h, params, paper) => lines, staged(steps) for a generator
const IMPL = {
  'own:crosshatch': plain(crosshatch, 'styles.progress.hatch'),
  'own:waves': staged(wavesSteps),
  'own:engraving': staged(engravingSteps),
};

const driver = createDriver({
  impl: IMPL,
  post: (msg, transfer) => self.postMessage(msg, transfer || []),
  now: () => performance.now(),
  defer: (fn) => setTimeout(fn, 0),
});

self.onmessage = (e) => driver.onMessage(e.data);
