// Our message protocol between the main thread and the style workers (native) and the plotterfun-host wrapper.
// Unpacking plotterfun messages (['svg-path', d], etc.) stays inside plotterfun-host and the adapter.

// main -> worker
export const RUN = 'run';         // {type, runId, styleId?, image:{width,height,data}, params}
export const PARAMS = 'params';   // {type, runId, params}: live parameters of a running computation
export const INIT = 'init';       // {type, style, model, base}: for plotterfun-host only

// worker -> main
export const PROGRESS = 'progress'; // {type, runId, text}
export const RESULT = 'result';     // {type, runId, lines:[Float64Array|number[]...], final:boolean, reason?, late?}
export const ERROR = 'error';       // {type, runId, message}
export const SLIDERS = 'sliders';   // {type, controls}: plotterfun style parameters (adapter only)

// plotterfun-host -> main (the adapter translates them into PROGRESS/RESULT/ERROR/SLIDERS)
export const HOST = Object.freeze({ SLIDERS: 'sliders', MSG: 'msg', PATH: 'svg-path', FINAL: 'final', ERROR: 'error' });

// Execution models of plotterfun styles (see design.md 3a)
export const MODELS = Object.freeze(['sync', 'async-handler', 'timer-chain', 'none']);
