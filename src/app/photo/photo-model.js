// Model of the "Photo" tab: the image, the style-layer stack, runs in workers, presets, messages. No DOM.
// The view (tabs/photo-tab.js) can be unmounted and mounted again (live language switch) while the image, layers, parameters
// and running computations stay here: a run reports to the stack, not to the view.
import { createLayerStack, normalizeParams, clampSize, SIZE_RANGE } from './layer-stack.js';
import { defaultsOfParams } from '../../styles/registry.js';
import { DEFAULT_PAPER, samePaper } from '../../styles/own/kit/paper.js';
import { presetValues } from '../../styles/own/kit/params.js';
import { scaleToPaper } from './density.js';
import { stats } from '../../core/drawing.js';
import { baseName } from '../download.js';
import { t } from '../../i18n/index.js';

export const PARAM_DEBOUNCE_MS = 180;
export const SAVE_DEBOUNCE_MS = 400;
export const DEFAULT_STYLE = 'own:crosshatch';

/**
 * @param getStyle    styleId => style descriptor (registry)
 * @param loadRunner  () => Promise<runner> — called once, on first need ({ probe, run, cancel, live, dispose })
 * @param decodeImage (file) => Promise<{ width, height, bitmap }>; rasterize (decoded, longSide) => { width, height, data }
 * @param isLoadError (error) => true for "not an image" (a short message instead of the error text)
 * @param timers      { setTimeout, clearTimeout } — replaced in tests
 *
 * Messages (info, warn, sendWarn) are kept as functions and computed by the view on render: after a language switch they
 * are shown in the new language. Events of subscribe(fn): { type: 'image', fresh } — the image or its working size changed
 * (fresh: a new file), 'size' — the working size field, 'message', 'print-params'; stack events — model.stack.subscribe.
 *
 * Paper scale: styles with usesPaper get paper = { mmPerPx, penWidthMm } (mmPerPx = scaleToPaper(working image, print
 * params), the same as the density check). When the print parameters change that scale or the pen width, visible layers of
 * such styles restart (with the parameter delay); hidden ones are reset so that showing them recomputes; others are untouched.
 */
export function createPhotoModel({
  getStyle, loadRunner, decodeImage, rasterize, isLoadError = () => false,
  timers = { setTimeout: (f, ms) => globalThis.setTimeout(f, ms), clearTimeout: (id) => globalThis.clearTimeout(id) },
  paramDelay = PARAM_DEBOUNCE_MS, saveDelay = SAVE_DEBOUNCE_MS, defaultStyle = DEFAULT_STYLE,
}) {
  const stack = createLayerStack({ getStyle });
  const paramCache = new Map(); // styleId -> parameter description (for dynamic — from the worker sliders)
  const pendingRuns = new Map(); // uid -> deferred start timer
  const listeners = new Set();
  const messages = { info: null, warn: null, sendWarn: null };
  let decoded = null, imageData = null, workingSize = SIZE_RANGE.default, imageName = '';
  let runner = null, runnerReady = null, saveTimer = 0, disposed = false;
  let ctx = null, printParams = null, offPrint = () => {}, lastPaper = null;

  const emit = (event) => { for (const fn of [...listeners]) fn(event); };
  const say = (name, fn) => { messages[name] = fn; emit({ type: 'message', name }); };

  // --- runner: created on first need
  function getRunner() {
    if (!runnerReady) runnerReady = Promise.resolve().then(loadRunner).then((r) => { runner = r; return r; });
    return runnerReady;
  }

  async function descsOf(style) {
    if (Array.isArray(style.params)) return style.params;
    if (!paramCache.has(style.id)) paramCache.set(style.id, getRunner().then((r) => r.probe(style)).catch((e) => { paramCache.delete(style.id); throw e; }));
    return paramCache.get(style.id);
  }

  // --- paper scale for styles with parameters in mm on paper
  function paperNow() {
    const k = imageData && printParams ? scaleToPaper(imageData, printParams) : null;
    const pen = printParams && printParams.penWidthMm > 0 ? printParams.penWidthMm : DEFAULT_PAPER.penWidthMm;
    return { mmPerPx: k > 0 ? k : DEFAULT_PAPER.mmPerPx, penWidthMm: pen };
  }

  function onPaperChange() {
    const next = paperNow();
    const changed = !samePaper(next, lastPaper);
    lastPaper = next;
    if (!changed || !imageData) return;
    for (const l of stack.layers) {
      const style = getStyle(l.styleId);
      if (!style || !style.usesPaper) continue;
      if (l.visible) schedule(l, paramDelay); else { cancel(l.uid); stack.reset(l.uid); }
    }
  }

  // --- layer runs
  function schedule(layer, delay = 0) {
    timers.clearTimeout(pendingRuns.get(layer.uid));
    pendingRuns.set(layer.uid, timers.setTimeout(() => start(layer.uid), delay));
  }

  async function start(uid) {
    pendingRuns.delete(uid);
    const layer = stack.find(uid);
    if (!layer || !layer.visible || !imageData || disposed) return;
    const style = getStyle(layer.styleId);
    try {
      const [descs, r] = await Promise.all([descsOf(style), getRunner()]);
      if (disposed || stack.find(uid) !== layer || !layer.visible) return;
      layer.params = normalizeParams(descs, layer.params);
      r.run(uid, { ...style, params: descs }, { image: imageData, params: layer.params, paper: paperNow() }, (state) => stack.applyResult(uid, state));
    } catch (e) {
      stack.applyResult(uid, { status: 'error', message: e.message, lines: [] });
    }
  }

  const cancel = (uid) => { timers.clearTimeout(pendingRuns.get(uid)); pendingRuns.delete(uid); if (runner) runner.cancel(uid); };

  function rerunAll() {
    for (const l of stack.layers) {
      if (l.visible) schedule(l, 0); else { cancel(l.uid); stack.reset(l.uid); }
    }
  }

  function applyWorkingSize({ fresh = false } = {}) {
    if (!decoded) return;
    imageData = rasterize(decoded, workingSize);
    lastPaper = paperNow();
    const info = { name: imageName, w: decoded.width, h: decoded.height, ww: imageData.width, wh: imageData.height };
    messages.info = () => t('photo.imageInfo', info);
    emit({ type: 'image', fresh });
  }

  function persist() {
    timers.clearTimeout(saveTimer);
    saveTimer = timers.setTimeout(() => { if (ctx) ctx.presets.save(stack.toPreset(workingSize)); }, saveDelay);
  }

  // every stack change except a computation result is part of the preset
  stack.subscribe((e) => { if (e.type !== 'result') persist(); });

  const model = {
    stack,
    image: () => ({ decoded, imageData, name: imageName }),
    workingSize: () => workingSize,
    printParams: () => printParams,
    /** The current paper scale { mmPerPx, penWidthMm } (defaults without an image or print parameters). */
    paper: () => paperNow(),
    /** The message text in the current language ('' — none). */
    text: (name) => (messages[name] ? messages[name]() : ''),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    /**
     * Binding to the source context. The first call restores the saved stack (without an image: computation starts after
     * the photo is loaded); calling again with the same context (a remounted view) changes nothing.
     */
    attach(next) {
      if (disposed || next === ctx) return;
      const first = !ctx;
      ctx = next;
      offPrint();
      printParams = ctx.printParams.get();
      lastPaper = paperNow();
      offPrint = ctx.printParams.subscribe((p) => { printParams = p; emit({ type: 'print-params' }); onPaperChange(); });
      if (!first) return;
      ctx.presets.load().then((saved) => {
        if (!saved || disposed) return;
        try {
          const { workingSize: size } = stack.loadPreset(saved);
          workingSize = size;
          emit({ type: 'size' });
        } catch (e) { /* a corrupted preset is ignored */ }
      });
    },

    descsOf,

    /** The layer parameter description; the layer parameters are normalized by it. null — the layer is gone. */
    async layerDescs(uid) {
      const l = stack.find(uid);
      if (!l) return null;
      const descs = await descsOf(getStyle(l.styleId));
      if (disposed || stack.find(uid) !== l) return null;
      l.params = normalizeParams(descs, l.params);
      return descs;
    },

    async addLayer(styleId) {
      try {
        const descs = await descsOf(getStyle(styleId));
        const layer = stack.add(styleId, { params: defaultsOfParams(descs) });
        schedule(layer, 0);
      } catch (e) { say('warn', () => t('photo.addLayerFailed', { message: e.message })); }
    },

    async loadFile(file) {
      if (!file) return;
      let next;
      try { next = await decodeImage(file); } catch (e) {
        say('warn', isLoadError(e) ? () => t('photo.err.openImage') : () => t('common.errorWith', { message: e.message }));
        return; // the previous image and layers stay
      }
      if (decoded && decoded.bitmap && decoded.bitmap.close) decoded.bitmap.close();
      decoded = next;
      imageName = baseName(file.name, 'photo');
      say('warn', null);
      applyWorkingSize({ fresh: true });
      if (!stack.layers.length) await model.addLayer(defaultStyle); else rerunAll();
    },

    setWorkingSize(value) {
      workingSize = clampSize(value);
      emit({ type: 'size' });
      persist();
      if (decoded) { applyWorkingSize(); rerunAll(); }
      return workingSize;
    },

    setVisible(uid, visible) {
      const l = stack.find(uid);
      if (!l) return;
      stack.setVisible(uid, visible);
      if (visible) { if (l.status !== 'done') schedule(l, 0); } else { cancel(uid); if (l.status !== 'done') stack.reset(uid); }
    },

    removeLayer(uid) { cancel(uid); stack.remove(uid); },

    changeStyle(uid, styleId) {
      const l = stack.find(uid);
      if (!l) return;
      cancel(uid);
      stack.setStyle(uid, styleId);
      if (l.visible) schedule(l, 0);
    },

    changeParam(uid, descs, key, value) {
      const l = stack.find(uid);
      if (!l) return;
      stack.setParams(uid, { [key]: value });
      const desc = descs.find((d) => d.key === key);
      // live parameters go to the running worker, the rest restart the layer (with a delay for slider movement)
      if (l.visible && desc && desc.live && runner && runner.live(uid, l.params)) return;
      if (l.visible) schedule(l, paramDelay);
    },

    /**
     * Style preset: the layer parameters become the defaults overlaid with the preset values (one change), and the layer
     * restarts (not the live path: many parameters change at once). Returns false for an unknown layer or preset.
     */
    applyStylePreset(uid, presetId) {
      const l = stack.find(uid);
      const style = l && getStyle(l.styleId);
      const preset = style && Array.isArray(style.params) && (style.presets || []).find((p) => p.id === presetId);
      if (!preset) return false;
      stack.setParams(uid, presetValues(style.params, preset));
      if (l.visible) schedule(l, 0);
      return true;
    },

    currentDrawing: () => stack.toDrawing({ name: imageName }),

    /** "To print": unfinished layers need confirm(text) => boolean. Returns true if the drawing was emitted. */
    sendToPrint(confirm) {
      const drawing = model.currentDrawing();
      if (!drawing || !ctx) return false;
      const pending = stack.pending();
      const list = () => pending.map((p) => t('photo.layer.notFinished', { name: p.name }) + (p.reason ? ` (${p.reason})` : '')).join('\n');
      if (pending.length) {
        if (!confirm(t('photo.sendConfirm', { list: list() }))) return false;
        say('sendWarn', () => t('photo.sentPartial', { list: list() }));
      } else say('sendWarn', null);
      const s = stats(drawing), name = imageName;
      say('info', () => t('photo.sent', { name, lines: t('svgtab.lines', { count: s.lines }), points: t('svgtab.points', { count: s.points }) }));
      ctx.emit(drawing);
      return true;
    },

    toPreset: () => stack.toPreset(workingSize),

    applyPreset(preset) {
      for (const l of stack.layers) cancel(l.uid);
      const { workingSize: size, skipped } = stack.loadPreset(preset);
      workingSize = size;
      emit({ type: 'size' });
      if (skipped.length) say('warn', () => t('photo.unknownStyles', { list: skipped.join(', ') }));
      applyWorkingSize();
      rerunAll();
    },

    async importPresetFile(file) {
      if (!file) return;
      try { model.applyPreset(JSON.parse(await file.text())); } catch (e) { say('warn', () => t('photo.presetFailed', { message: e.message })); }
    },

    /** Full teardown (the app is closing): timers, the subscription to the print parameters, the workers. */
    dispose() {
      disposed = true;
      offPrint();
      timers.clearTimeout(saveTimer);
      for (const id of pendingRuns.values()) timers.clearTimeout(id);
      pendingRuns.clear();
      if (runner) runner.dispose();
      listeners.clear();
    },
  };
  return model;
}
