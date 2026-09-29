// plotterfun adapter: parameters (sliders) -> parameter description, plotterfun-host messages -> events of our protocol.
import { pathToLines } from '../core/svg-import.js';
import { INIT, RUN, PARAMS, HOST, PROGRESS, RESULT, ERROR, SLIDERS } from './protocol.js';

export const VENDOR_BASE = new URL('../../vendor/plotterfun/', import.meta.url).href;
const CIRCLE_CHORD_PX = 0.5;

export const REASON_UNTRACKED = 'завершение стиля не отслеживается';
export const REASON_LATE = 'стиль продолжил вывод после завершения';

// Common plotterfun parameters (defaultControls from helpers.js). A style without them (linescan) still reads them via pixelProcessor:
// in plotterfun they carry over into config from a previously chosen style, here they are substituted explicitly.
export const COMMON_CONTROLS = Object.freeze([
  { label: 'Inverted', type: 'checkbox' },
  { label: 'Brightness', value: 0, min: -100, max: 100 },
  { label: 'Contrast', value: 0, min: -100, max: 100 },
  { label: 'Min brightness', value: 0, min: 0, max: 255 },
  { label: 'Max brightness', value: 255, min: 0, max: 255 },
]);

/** The default checkbox value in plotterfun is set by the checked field (or value) */
const checkedOf = (c) => !!(c.checked !== undefined ? c.checked : c.value);

export const commonDefaults = () => Object.fromEntries(controlsToParams([...COMMON_CONTROLS]).map((p) => [p.key, p.default]));

const BAD = /NaN|Infinity/;

/**
 * plotterfun sometimes yields NaN (e.g. squiggle reads a pixel past the end of the last row), and the browser SVG parser
 * aborts the path at the first error. Instead we drop the bad points (in a polyline) or whole circles.
 */
export function sanitizePath(d) {
  if (!BAD.test(d)) return d;
  return d.split(/(?=M)/).map((sub) => {
    if (!BAD.test(sub)) return sub;
    if (/a/i.test(sub.replace(/NaN|Infinity/g, ''))) return '';
    const pts = (sub.match(/[ML][^ML]*/g) || []).map((t) => t.slice(1).trim()).filter((p) => p && !BAD.test(p));
    return pts.length ? `M${pts[0]}${pts.slice(1).map((p) => `L${p}`).join('')}` : '';
  }).join(' ');
}

/** plotterfun controls -> [{key,label,type,min,max,step,options,default,live}]; the parameter key is the label, as in plotterfun. */
export function controlsToParams(controls) {
  return controls.map((c) => {
    const base = { key: c.label, label: c.label, live: !!c.noRestart };
    if (c.type === 'checkbox') return { ...base, type: 'bool', default: checkedOf(c) };
    if (c.type === 'select') return { ...base, type: 'select', options: [...c.options], default: c.value !== undefined ? c.value : c.options[0] };
    return { ...base, type: 'number', min: c.min, max: c.max, step: c.step || 1, default: c.value };
  });
}

/**
 * A session of one run: translates our protocol into host messages and back.
 * @param opts { style, model }
 */
export function createPlotterfunSession({ style, model = 'none', base = VENDOR_BASE, commonTone = false }) {
  let lastLines = [];
  const reasonOf = () => (model === 'none' ? REASON_UNTRACKED : undefined);
  return {
    initMessages: () => [[{ type: INIT, style, model, base }]],
    runMessage({ runId, image, params }) {
      return [{ type: RUN, runId, image, params: { ...commonDefaults(), ...params } }, [image.data.buffer]];
    },
    paramsMessage({ runId, params }) {
      return [{ type: PARAMS, runId, params }];
    },
    /** host message -> array of events {type: SLIDERS|PROGRESS|RESULT|ERROR} */
    decode(m) {
      switch (m && m.type) {
        case HOST.SLIDERS: {
          let params = controlsToParams(m.controls);
          if (commonTone) params = params.concat(controlsToParams([...COMMON_CONTROLS]).filter((c) => !params.some((p) => p.key === c.key)));
          return [{ type: SLIDERS, controls: m.controls, params }];
        }
        case HOST.MSG: return [{ type: PROGRESS, text: m.text }];
        case HOST.PATH: {
          try { lastLines = pathToLines(sanitizePath(m.d), CIRCLE_CHORD_PX); } catch (e) { return [{ type: ERROR, message: `стиль вернул неразборчивый путь: ${e.message}` }]; }
          return [{ type: RESULT, lines: lastLines, final: false, late: !!m.late, reason: m.late ? REASON_LATE : reasonOf() }];
        }
        case HOST.FINAL: return [{ type: RESULT, lines: lastLines, final: true }];
        case HOST.ERROR: return [{ type: ERROR, message: m.message }];
        default: return [];
      }
    },
  };
}
