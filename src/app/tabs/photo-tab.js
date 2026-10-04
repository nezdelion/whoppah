// "Photo" source: image -> stack of style layers (workers) -> preview -> ctx.emit(drawing).
// The tab knows nothing about specific styles: only the registry, the parameter description and the runner.
// The model (image, layers, runs) lives in photo/photo-model.js and outlives the view: mount/unmount only build and remove
// the DOM (a live language switch remounts the view; the image, layers, parameters and running computations stay).
import { h, button } from '../ui/dom.js';
import { createViewport } from '../ui/viewport.js';
import { exportSvg } from '../../core/svg-export.js';
import { downloadText } from '../download.js';
import { STYLES, getStyle, groupedStyles, groupLabel, originLabel, sessionFactory } from '../../styles/registry.js';
import { createRunner } from '../../styles/runner.js';
import { loadModels } from '../../styles/plotterfun-models.js';
import { SIZE_RANGE, reasonText, progressText } from '../photo/layer-stack.js';
import { createPhotoModel, DEFAULT_STYLE, VIGNETTE_PARAMS, CROP_LOCKS } from '../photo/photo-model.js';
import { fullRect, hitTest, dragRect } from '../photo/crop.js';
import { t } from '../../i18n/index.js';
import { decodeImage, rasterize, ImageLoadError, ACCEPT } from '../photo/image-loader.js';
import { buildParamForm, buildPresetPicker } from '../photo/param-form.js';
import { estimateSpacing, densityText } from '../photo/density.js';

// crop mode: the grab distance of the frame handles in CSS px and the cursor over each handle
const GRAB_CSS_PX = 14;
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move' };

const statusLabel = (s) => (s === 'idle' ? '' : t(`photo.status.${s}`));

const fetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
};

// the runner is created after reading the model manifest (without it all plotterfun styles are "intermediate")
const loadRunner = () => loadModels(fetchText, {
  manifestUrl: new URL('../../styles/plotterfun-completion.json', import.meta.url).href,
  upstreamUrl: new URL('../../../vendor/plotterfun/UPSTREAM', import.meta.url).href,
}).then((modelOf) => createRunner({ createSession: sessionFactory(modelOf) }));

/** @param createModel () => photo model (tests); by default the real one with workers */
export function createPhotoSource({ createModel = () => createPhotoModel({ getStyle, loadRunner, decodeImage, rasterize, isLoadError: (e) => e instanceof ImageLoadError }) } = {}) {
  let model = null;
  let cleanup = [];
  // view state that outlives a remount: preview zoom/pan, the canvas size, "show photo"
  const view = createViewport();
  let canvasSize = { w: 900, h: 300 }, showPhoto = true, cropMode = false;

  return {
    id: 'photo',
    get title() { return t('tab.photo'); },
    /** The model (tests and diagnostics). */
    get model() { return model; },

    mount(el, ctx) {
      if (!model) model = createModel();
      const m = model, stack = m.stack;
      m.attach(ctx);
      let drawQueued = false, alive = true;

      // --- DOM
      const $ = {};
      const input = h('input', { type: 'file', accept: ACCEPT, hidden: true });
      const presetInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
      $.drop = h('div', { class: 'drop', tabindex: 0, role: 'button' }, t('photo.drop'), input);
      $.info = h('div', { class: 'note' });
      $.warn = h('div', { class: 'warn', role: 'alert' });
      $.size = h('input', { type: 'number', min: SIZE_RANGE.min, max: SIZE_RANGE.max, step: 50, value: m.workingSize(), inputMode: 'numeric' });
      $.layers = h('div', { class: 'layers' });
      $.addStyle = h('select', { 'aria-label': t('photo.newLayerStyle') }, groupedStyles().map((g) =>
        h('optgroup', { label: groupLabel(g.group) }, g.styles.map((s) => h('option', { value: s.id, selected: s.id === DEFAULT_STYLE }, `${s.name} · ${originLabel(s)}`)))));
      $.add = button({ label: t('photo.addLayer'), hint: 'photo.addLayer.hint', onclick: () => m.addLayer($.addStyle.value) });
      $.canvas = h('canvas', { class: 'preview photo-preview', width: canvasSize.w, height: canvasSize.h, 'aria-label': t('photo.previewAria') });
      $.fit = button({ label: t('photo.fit'), hint: 'photo.fit.hint', onclick: () => { view.reset(); if (!cropMode) $.canvas.style.touchAction = 'pan-y'; requestDraw(); } });
      $.cropOn = button({ label: t('photo.crop'), hint: 'photo.crop.hint', onclick: () => setCropMode(true) });
      $.cropDone = button({ label: t('photo.cropDone'), hint: 'photo.cropDone.hint', class: 'primary', onclick: () => setCropMode(false) });
      $.cropReset = button({ label: t('photo.cropReset'), hint: 'photo.cropReset.hint', onclick: () => m.resetCrop() });
      $.cropLock = h('select', { 'aria-label': t('photo.cropAspect'), onchange: () => m.setCropLock($.cropLock.value) },
        CROP_LOCKS.map((v) => h('option', { value: v, selected: v === m.cropLock() }, t(`photo.cropAspect.${v}`))));
      $.cropHelp = h('div', { class: 'note' }, t('photo.cropHelp'));
      $.vignette = h('div');
      $.showPhoto = h('input', { type: 'checkbox', checked: showPhoto, onchange: () => { showPhoto = $.showPhoto.checked; requestDraw(); } });
      $.stats = h('div', { class: 'stats' });
      $.sendWarn = h('div', { class: 'warn' });
      $.toPrint = button({ label: t('photo.toPrint'), hint: 'photo.toPrint.hint', class: 'primary', onclick: () => m.sendToPrint((text) => window.confirm(text)) });
      $.exportSvg = button({ label: t('photo.exportSvg'), hint: 'photo.exportSvg.hint', onclick: exportSvgFile });
      $.exportPreset = button({ label: t('photo.exportPreset'), hint: 'photo.exportPreset.hint', onclick: exportPreset });
      $.importPreset = button({ label: t('photo.importPreset'), hint: 'photo.importPreset.hint', onclick: () => presetInput.click() });

      const imageCard = h('div', { class: 'card' }, $.drop, $.info, $.warn,
        h('label', { class: 'size' }, t('photo.workingSize'), $.size),
        h('div', { class: 'vignette' }, h('h3', {}, t('photo.vignette')), h('div', { class: 'note' }, t('photo.vignette.note')), $.vignette));
      const layersCard = h('div', { class: 'card' }, h('h2', {}, t('photo.layers')), $.layers,
        h('div', { class: 'row' }, $.addStyle, $.add));
      const previewCard = h('div', { class: 'card' }, $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.showPhoto, t('photo.showPhoto')), $.fit),
        h('div', { class: 'row crop-row' }, $.cropOn, $.cropDone, $.cropReset, h('label', { class: 'crop-lock' }, t('photo.cropAspect'), $.cropLock)),
        $.cropHelp,
        $.stats, $.sendWarn,
        h('div', { class: 'row' }, $.toPrint, $.exportSvg, $.exportPreset, $.importPreset, presetInput));
      el.append(h('div', { class: 'columns' }, h('div', {}, imageCard, layersCard), h('div', { class: 'work-col sticky' }, previewCard)));

      // --- "Fade background": the same form as layer parameters; a slider change does not rebuild the form under the finger
      let editingVignette = false;
      function renderVignette() {
        $.vignette.replaceChildren(buildParamForm(VIGNETTE_PARAMS, m.vignette(), (key, value) => {
          editingVignette = true;
          try { m.setVignette({ [key]: value }); } finally { editingVignette = false; }
        }));
      }

      // --- crop mode: the whole photo with the frame; dragging edits a draft frame, the model gets it once on release
      let draft = null;
      function updateCropUi() {
        const has = !!m.image().imageData;
        $.cropOn.hidden = cropMode;
        $.cropDone.hidden = !cropMode;
        $.cropOn.disabled = !has;
        $.cropReset.disabled = !m.crop();
        $.cropLock.value = m.cropLock();
        $.cropHelp.hidden = !cropMode;
      }

      function attachCrop(canvas) {
        let drag = null;
        // pointer -> source image px; k — source px per CSS px
        const at = (e, decoded) => {
          const r = canvas.getBoundingClientRect();
          const kx = r.width ? decoded.width / r.width : 1, ky = r.height ? decoded.height / r.height : 1;
          return { x: (e.clientX - r.left) * kx, y: (e.clientY - r.top) * ky, k: Math.max(kx, ky) };
        };
        const on = {
          pointerdown(e) {
            const { decoded } = m.image();
            if (!decoded || drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
            const p = at(e, decoded), start = m.crop() || fullRect(decoded);
            const handle = hitTest(start, p.x, p.y, GRAB_CSS_PX * p.k);
            if (!handle) return;
            drag = { id: e.pointerId, handle, start, x: p.x, y: p.y };
            try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no capture */ }
            e.preventDefault();
          },
          pointermove(e) {
            const { decoded } = m.image();
            if (!decoded) return;
            const p = at(e, decoded);
            if (!drag) { canvas.style.cursor = CURSOR[hitTest(m.crop() || fullRect(decoded), p.x, p.y, GRAB_CSS_PX * p.k)] || 'default'; return; }
            if (e.pointerId !== drag.id) return;
            draft = dragRect(drag.start, drag.handle, p.x - drag.x, p.y - drag.y, decoded, { aspect: m.cropAspect() });
            requestDraw();
          },
          pointerup(e) {
            if (!drag || e.pointerId !== drag.id) return;
            const next = draft;
            drag = null; draft = null;
            if (next) m.setCrop(next); // one recalculation per gesture
            requestDraw();
          },
          pointercancel(e) {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null; draft = null; requestDraw();
          },
        };
        for (const [n, f] of Object.entries(on)) canvas.addEventListener(n, f);
        canvas.style.touchAction = 'none';
        return () => { for (const [n, f] of Object.entries(on)) canvas.removeEventListener(n, f); canvas.style.cursor = ''; draft = null; };
      }

      // the canvas input: the zoom/pan of the view, or the crop frame in crop mode
      let detachInput = () => {};
      function attachInput() {
        detachInput();
        if (cropMode) { view.reset(); detachInput = attachCrop($.canvas); } else detachInput = view.attach($.canvas, requestDraw);
      }
      function setCropMode(on) {
        cropMode = !!on;
        attachInput();
        updateCropUi();
        requestDraw();
      }

      function renderMessages() {
        $.info.textContent = m.text('info');
        $.warn.textContent = m.text('warn');
        $.sendWarn.textContent = m.text('sendWarn');
      }

      // --- layers: DOM
      function statusText(l) {
        if (!l.visible) return t('photo.status.hidden');
        if (l.status === 'idle') return m.image().imageData ? t('photo.status.waiting') : t('photo.status.noImage');
        const base = statusLabel(l.status);
        if (l.status === 'error') return `${base}: ${l.message}`;
        if (l.status === 'done') return [base, progressText(l.note)].filter(Boolean).join(' · ');
        return [base, progressText(l.progress), l.reason && (l.status === 'running' ? t('photo.status.partialReason', { reason: reasonText(l.reason) }) : reasonText(l.reason))].filter(Boolean).join(' · ');
      }

      function densityOf(l) {
        const style = getStyle(l.styleId), { imageData } = m.image(), printParams = m.printParams();
        if (!style.spacing || !imageData || !l.visible || !printParams) return null;
        try {
          const px = style.spacing(l.params, imageData, m.paper());
          const est = estimateSpacing(px, imageData, printParams);
          return est ? { est, text: densityText(est, printParams.penWidthMm) } : null;
        } catch (e) { return null; }
      }

      function refreshLayerInfo(uid) {
        const l = stack.find(uid), e = elements.get(uid);
        if (!l || !e) return;
        e.status.textContent = statusText(l);
        e.status.dataset.status = l.visible ? l.status : 'hidden';
        const d = densityOf(l);
        e.density.textContent = d ? d.text : '';
        e.density.className = d && d.est.tooDense ? 'warn' : 'note';
      }

      const elements = new Map();
      function renderLayers() {
        elements.clear();
        const layers = stack.layers;
        $.layers.replaceChildren(...(layers.length ? layers.map((l, i) => layerView(l, i, layers.length)) : [h('div', { class: 'note' }, t('photo.noLayers'))]));
        layers.forEach((l) => refreshLayerInfo(l.uid));
        updateActions();
      }

      function layerView(l, i, total) {
        const e = { status: h('div', { class: 'layer-status', role: 'status' }), density: h('div', { class: 'note' }) };
        elements.set(l.uid, e);
        const styleSelect = h('select', { 'aria-label': t('photo.layerStyle'), onchange: () => m.changeStyle(l.uid, styleSelect.value) },
          groupedStyles().map((g) => h('optgroup', { label: groupLabel(g.group) }, g.styles.map((s) => h('option', { value: s.id, selected: s.id === l.styleId }, `${s.name} · ${originLabel(s)}`)))));
        const inner = h('div');
        const body = h('details', { class: 'layer-body', open: i === total - 1 }, h('summary', {}, t('photo.params')), inner);
        m.layerDescs(l.uid).then((descs) => {
          if (!alive || !descs || stack.find(l.uid) !== l) return;
          const presets = getStyle(l.styleId).presets || [];
          // a style preset sets many values at once: the form is rebuilt with them
          const renderForm = () => {
            const picker = presets.length ? buildPresetPicker(descs, presets, l.params, (id) => { m.applyStylePreset(l.uid, id); renderForm(); }) : null;
            e.syncPreset = picker ? picker.sync : null;
            inner.replaceChildren(...(picker ? [picker.el] : []), buildParamForm(descs, l.params, (key, value) => m.changeParam(l.uid, descs, key, value)));
          };
          renderForm();
          refreshLayerInfo(l.uid);
        }).catch((err) => { inner.textContent = t('photo.paramsFailed', { message: err.message }); });
        return h('div', { class: 'layer', style: `--layer-color: var(--layer-${i % 4})` },
          h('div', { class: 'layer-head' },
            h('label', { class: 'check', title: t('photo.showLayer') }, h('input', { type: 'checkbox', checked: l.visible, 'aria-label': t('photo.showLayerAria'), onchange: (ev) => m.setVisible(l.uid, ev.target.checked) })),
            h('input', { class: 'layer-name', value: l.name, 'aria-label': t('photo.layerName'), onchange: (ev) => { stack.rename(l.uid, ev.target.value); ev.target.value = l.name; } }),
            button({ label: '↑', hint: 'photo.up.hint', 'aria-label': t('photo.upAria'), disabled: i === 0, onclick: () => stack.move(l.uid, -1) }),
            button({ label: '↓', hint: 'photo.down.hint', 'aria-label': t('photo.downAria'), disabled: i === total - 1, onclick: () => stack.move(l.uid, 1) }),
            button({ label: '×', hint: 'photo.remove.hint', class: 'danger', 'aria-label': t('photo.removeAria'), onclick: () => m.removeLayer(l.uid) })),
          h('label', {}, t('photo.style'), styleSelect),
          e.status, e.density, body);
      }

      // --- preview
      function requestDraw() {
        if (drawQueued) return;
        drawQueued = true;
        requestAnimationFrame(() => { drawQueued = false; if (alive) draw(); });
      }

      // the photo under the drawing: the working image (crop and fade background applied) drawn once into a canvas
      let underlay = { src: null, canvas: null };
      function underlayOf(imageData) {
        if (underlay.src === imageData) return underlay.canvas;
        let canvas = null;
        try {
          canvas = h('canvas', { width: imageData.width, height: imageData.height });
          canvas.getContext('2d').putImageData(new ImageData(imageData.data, imageData.width, imageData.height), 0, 0);
        } catch (e) { canvas = null; } // no ImageData (tests) or an odd buffer: the source bitmap is drawn instead
        underlay = { src: imageData, canvas };
        return canvas;
      }

      function draw() {
        const { decoded, imageData } = m.image();
        const css = getComputedStyle(document.documentElement);
        const col = (n) => css.getPropertyValue(n).trim();
        const g = $.canvas.getContext('2d');
        const W = $.canvas.width, H = $.canvas.height, dpr = window.devicePixelRatio || 1;
        const cropping = cropMode && decoded && imageData;
        $.canvas.style.setProperty('--ar', cropping ? String(decoded.width / decoded.height) : imageData ? String(imageData.width / imageData.height) : '3');
        view.setSize(W, H);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        g.fillStyle = col('--paper'); g.fillRect(0, 0, W, H);
        if (!imageData) { g.fillStyle = col('--muted'); g.font = `${16 * dpr}px system-ui`; g.fillText(t('photo.noPhoto'), 16 * dpr, 30 * dpr); return; }
        if (cropping) { drawCrop(g, col, W, H, dpr, decoded, imageData); return; }
        view.apply(g);
        if (showPhoto && decoded) {
          const c = m.crop() || fullRect(decoded), img = underlayOf(imageData);
          g.globalAlpha = 0.3;
          if (img) g.drawImage(img, 0, 0, W, H); else g.drawImage(decoded.bitmap, c.x, c.y, c.w, c.h, 0, 0, W, H);
          g.globalAlpha = 1;
        }
        drawLines(g, col, W / imageData.width, 0, 0, dpr, view.zoom);
      }

      /** Crop mode: the whole photo, the layers inside the current frame, the area outside the (draft) frame dimmed, handles. */
      function drawCrop(g, col, W, H, dpr, decoded, imageData) {
        const sx = W / decoded.width, sy = H / decoded.height;
        const cur = m.crop() || fullRect(decoded), f = draft || cur;
        g.globalAlpha = 0.55; g.drawImage(decoded.bitmap, 0, 0, W, H); g.globalAlpha = 1;
        drawLines(g, col, (cur.w * sx) / imageData.width, cur.x * sx, cur.y * sy, dpr, 1);
        const x = f.x * sx, y = f.y * sy, w = f.w * sx, hh = f.h * sy;
        g.fillStyle = col('--paper'); g.globalAlpha = 0.65;
        g.fillRect(0, 0, W, y); g.fillRect(0, y + hh, W, H - y - hh); g.fillRect(0, y, x, hh); g.fillRect(x + w, y, W - x - w, hh);
        g.globalAlpha = 1;
        g.strokeStyle = col('--accent'); g.lineWidth = 2 * dpr; g.strokeRect(x, y, w, hh);
        const s = 8 * dpr;
        g.fillStyle = col('--accent');
        for (const [px, py] of [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + hh / 2], [x + w, y + hh], [x + w / 2, y + hh], [x, y + hh], [x, y + hh / 2]]) g.fillRect(px - s / 2, py - s / 2, s, s);
      }

      /** The visible layers: working px * k + (ox, oy) in canvas units; zoom keeps the line width constant on screen. */
      function drawLines(g, col, k, ox, oy, dpr, zoom) {
        g.lineJoin = 'round'; g.lineWidth = (1.4 * dpr) / zoom; // constant thickness in screen pixels
        const eps = (0.6 * dpr) / zoom;
        stack.layers.forEach((l, i) => {
          if (!l.visible || !l.lines.length) return;
          g.strokeStyle = col(`--layer-${i % 4}`);
          g.beginPath();
          for (const line of l.lines) {
            let px = line[0] * k + ox, py = line[1] * k + oy;
            g.moveTo(px, py);
            for (let j = 2; j < line.length; j += 2) {
              const x = line[j] * k + ox, y = line[j + 1] * k + oy;
              if (Math.abs(x - px) < eps && Math.abs(y - py) < eps && j < line.length - 2) continue; // decimation per screen pixel
              g.lineTo(x, y); px = x; py = y;
            }
          }
          g.stroke();
        });
      }

      function updateActions() {
        let lines = 0, points = 0;
        for (const l of stack.layers) if (l.visible) for (const line of l.lines) { lines++; points += line.length >> 1; }
        const pending = stack.pending();
        $.stats.textContent = lines ? t('photo.stats', { lines: t('svgtab.lines', { count: lines }), points: t('svgtab.points', { count: points }) }) + (pending.length ? t('photo.statsPending') : '') : t('photo.noLines');
        $.toPrint.disabled = !lines;
        $.exportSvg.disabled = !lines;
      }

      // --- output
      function exportSvgFile() {
        const drawing = m.currentDrawing();
        if (drawing) downloadText(`${m.image().name || 'photo'}.svg`, exportSvg(drawing), 'image/svg+xml');
      }

      function exportPreset() {
        downloadText(`${m.image().name || 'photo'}-layers.json`, JSON.stringify(m.toPreset(), null, 2), 'application/json');
      }

      // --- events
      const offStack = stack.subscribe((e) => {
        if (e.type === 'result') { refreshLayerInfo(e.uid); updateActions(); requestDraw(); return; }
        if (e.type === 'params') {
          refreshLayerInfo(e.uid);
          const el = elements.get(e.uid), l = stack.find(e.uid);
          if (el && el.syncPreset && l) el.syncPreset(l.params);
          return;
        }
        if (e.type === 'meta') return;
        renderLayers(); requestDraw();
      });
      const offModel = m.subscribe((e) => {
        if (e.type === 'image') { if (e.fresh) view.reset(); renderMessages(); renderLayers(); updateCropUi(); requestDraw(); }
        else if (e.type === 'crop') { updateCropUi(); requestDraw(); }
        else if (e.type === 'vignette') { if (!editingVignette) renderVignette(); }
        else if (e.type === 'size') $.size.value = m.workingSize();
        else if (e.type === 'message') renderMessages();
        else if (e.type === 'print-params') for (const l of stack.layers) refreshLayerInfo(l.uid);
      });
      attachInput();
      const resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        const r = $.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
        if (w < 2 || hh < 2 || ($.canvas.width === w && $.canvas.height === hh)) return;
        $.canvas.width = w; $.canvas.height = hh; canvasSize = { w, h: hh }; requestDraw();
      }) : null;
      if (resizeObs) resizeObs.observe($.canvas);
      const dark = window.matchMedia('(prefers-color-scheme: dark)');
      dark.addEventListener('change', requestDraw);

      $.drop.addEventListener('click', () => input.click());
      $.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      input.addEventListener('change', () => { m.loadFile(input.files[0]).finally(() => { input.value = ''; }); });
      presetInput.addEventListener('change', () => { m.importPresetFile(presetInput.files[0]).finally(() => { presetInput.value = ''; }); });
      $.drop.addEventListener('dragover', (e) => { e.preventDefault(); $.drop.classList.add('over'); });
      $.drop.addEventListener('dragleave', () => $.drop.classList.remove('over'));
      $.drop.addEventListener('drop', (e) => { e.preventDefault(); $.drop.classList.remove('over'); m.loadFile(e.dataTransfer.files[0]); });
      $.size.addEventListener('change', () => { $.size.value = m.setWorkingSize($.size.value); });

      cleanup = [offStack, offModel, () => detachInput(), () => { if (resizeObs) resizeObs.disconnect(); }, () => dark.removeEventListener('change', requestDraw), () => { alive = false; }];

      renderMessages();
      renderLayers();
      renderVignette();
      updateCropUi();
      draw();
    },

    /** Removes the view: subscriptions and DOM listeners; the model (image, layers, running computations) stays. */
    unmount() { for (const fn of cleanup) fn(); cleanup = []; },

    /** Full teardown: the view and the model (workers, timers). */
    dispose() { this.unmount(); if (model) model.dispose(); model = null; },
  };
}

export { STYLES };
