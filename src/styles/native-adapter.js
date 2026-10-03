// Adapter for own styles: the worker already speaks our protocol. paper ({ mmPerPx, penWidthMm }) goes with 'run' only;
// live 'params' do not change it (a new paper restarts the layer).
import { RUN, PARAMS } from './protocol.js';

export function createNativeSession({ id }) {
  return {
    initMessages: () => [],
    runMessage({ runId, image, params, paper }) {
      return [{ type: RUN, runId, styleId: id, image, params, paper: paper || null }, [image.data.buffer]];
    },
    paramsMessage({ runId, params }) {
      return [{ type: PARAMS, runId, styleId: id, params }];
    },
    decode: (m) => (m ? [m] : []),
  };
}
