// Adapter for own styles: the worker already speaks our protocol.
import { RUN, PARAMS } from './protocol.js';

export function createNativeSession({ id }) {
  return {
    initMessages: () => [],
    runMessage({ runId, image, params }) {
      return [{ type: RUN, runId, styleId: id, image, params }, [image.data.buffer]];
    },
    paramsMessage({ runId, params }) {
      return [{ type: PARAMS, runId, styleId: id, params }];
    },
    decode: (m) => (m ? [m] : []),
  };
}
