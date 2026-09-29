// Shared module worker of own styles (native protocol): {type:'run', styleId, image, params} -> progress/result.
import { RUN, PROGRESS, RESULT, ERROR } from '../protocol.js';
import { toGray } from '../tone.js';
import { crosshatch } from './crosshatch.js';

// id -> function (gray, w, h, params) => lines
const IMPL = { 'own:crosshatch': crosshatch };

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== RUN) return;
  const { runId, styleId, image, params } = msg;
  try {
    const fn = IMPL[styleId];
    if (!fn) throw new Error(`неизвестный стиль ${styleId}`);
    self.postMessage({ type: PROGRESS, runId, text: 'Расчёт штриховки' });
    const gray = toGray(image.data, image.width, image.height);
    const lines = fn(gray, image.width, image.height, params);
    self.postMessage({ type: RESULT, runId, lines, final: true }, lines.map((l) => l.buffer));
  } catch (err) {
    self.postMessage({ type: ERROR, runId, message: err && err.message ? err.message : String(err) });
  }
};
