// "Photo" source: image -> stack of style layers (workers) -> preview -> ctx.emit(drawing).
// The tab knows nothing about specific styles: only the registry, the parameter description and the runner.
import { h } from '../ui/dom.js';
import { createViewport } from '../ui/viewport.js';
import { exportSvg } from '../../core/svg-export.js';
import { stats } from '../../core/drawing.js';
import { downloadText, baseName } from '../download.js';
import { STYLES, getStyle, groupedStyles, originLabel, defaultsOfParams, sessionFactory } from '../../styles/registry.js';
import { createRunner } from '../../styles/runner.js';
import { loadModels } from '../../styles/plotterfun-models.js';
import { createLayerStack, normalizeParams, clampSize, SIZE_RANGE } from '../photo/layer-stack.js';
import { decodeImage, rasterize, ImageLoadError, ACCEPT } from '../photo/image-loader.js';
import { buildParamForm } from '../photo/param-form.js';
import { estimateSpacing, densityText } from '../photo/density.js';

const PARAM_DEBOUNCE_MS = 180;
const SAVE_DEBOUNCE_MS = 400;
const DEFAULT_STYLE = 'own:crosshatch';
const STATUS_TEXT = { running: 'считается', partial: 'промежуточный', done: 'готово', error: 'ошибка', idle: '' };

const fetchText = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
};

export function createPhotoSource() {
  let cleanup = [];

  return {
    id: 'photo',
    title: 'Фото',

    mount(el, ctx) {
      const stack = createLayerStack({ getStyle });
      const paramCache = new Map(); // styleId -> parameter description (for dynamic — from the worker sliders)
      const timers = new Map();     // uid -> deferred start timer
      let decoded = null, imageData = null, workingSize = SIZE_RANGE.default, imageName = '';
      let printParams = ctx.printParams.get();
      let runner = null, runnerReady = null, saveTimer = 0, drawQueued = false, disposed = false;

      // --- DOM
      const $ = {};
      const input = h('input', { type: 'file', accept: ACCEPT, hidden: true });
      const presetInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
      $.drop = h('div', { class: 'drop', tabindex: 0, role: 'button' }, 'Перетащи фото сюда или нажми, чтобы выбрать', input);
      $.info = h('div', { class: 'note' });
      $.warn = h('div', { class: 'warn', role: 'alert' });
      $.size = h('input', { type: 'number', min: SIZE_RANGE.min, max: SIZE_RANGE.max, step: 50, value: workingSize, inputMode: 'numeric' });
      $.layers = h('div', { class: 'layers' });
      $.addStyle = h('select', { 'aria-label': 'Стиль нового слоя' }, groupedStyles().map((g) =>
        h('optgroup', { label: g.group }, g.styles.map((s) => h('option', { value: s.id, selected: s.id === DEFAULT_STYLE }, `${s.name} · ${originLabel(s)}`)))));
      $.add = h('button', { type: 'button', onclick: () => addLayer($.addStyle.value) }, 'Добавить слой');
      $.canvas = h('canvas', { class: 'preview photo-preview', width: 900, height: 300, 'aria-label': 'Превью: колесо — масштаб, перетаскивание — сдвиг, двойной щелчок — вписать' });
      const view = createViewport();
      $.fit = h('button', { type: 'button', title: 'Вписать в область (двойной щелчок или 0)', onclick: () => { view.reset(); $.canvas.style.touchAction = 'pan-y'; requestDraw(); } }, 'Вписать');
      $.showPhoto = h('input', { type: 'checkbox', checked: true, onchange: requestDraw });
      $.stats = h('div', { class: 'stats' });
      $.sendWarn = h('div', { class: 'warn' });
      $.toPrint = h('button', { type: 'button', class: 'primary', onclick: sendToPrint }, 'В печать');
      $.exportSvg = h('button', { type: 'button', onclick: exportSvgFile }, 'Экспорт SVG');
      $.exportPreset = h('button', { type: 'button', onclick: exportPreset }, 'Экспорт пресета');
      $.importPreset = h('button', { type: 'button', onclick: () => presetInput.click() }, 'Импорт пресета');

      const imageCard = h('div', { class: 'card' }, $.drop, $.info, $.warn,
        h('label', { class: 'size' }, 'Рабочее разрешение (длинная сторона, px)', $.size));
      const layersCard = h('div', { class: 'card' }, h('h2', {}, 'Слои'), $.layers,
        h('div', { class: 'row' }, $.addStyle, $.add));
      const previewCard = h('div', { class: 'card' }, $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.showPhoto, 'фото под рисунком'), $.fit),
        $.stats, $.sendWarn,
        h('div', { class: 'row' }, $.toPrint, $.exportSvg, $.exportPreset, $.importPreset, presetInput));
      el.append(h('div', { class: 'columns' }, h('div', {}, imageCard, layersCard), h('div', { class: 'work-col sticky' }, previewCard)));

      // --- runner: created after reading the model manifest (without it all plotterfun styles are "intermediate")
      function getRunner() {
        if (!runnerReady) {
          runnerReady = loadModels(fetchText, {
            manifestUrl: new URL('../../styles/plotterfun-completion.json', import.meta.url).href,
            upstreamUrl: new URL('../../../vendor/plotterfun/UPSTREAM', import.meta.url).href,
          }).then((modelOf) => { runner = createRunner({ createSession: sessionFactory(modelOf) }); return runner; });
        }
        return runnerReady;
      }

      async function descsOf(style) {
        if (Array.isArray(style.params)) return style.params;
        if (!paramCache.has(style.id)) paramCache.set(style.id, getRunner().then((r) => r.probe(style)).catch((e) => { paramCache.delete(style.id); throw e; }));
        return paramCache.get(style.id);
      }

      // --- layer runs
      function schedule(layer, delay = 0) {
        clearTimeout(timers.get(layer.uid));
        timers.set(layer.uid, setTimeout(() => start(layer.uid), delay));
      }

      async function start(uid) {
        timers.delete(uid);
        const layer = stack.find(uid);
        if (!layer || !layer.visible || !imageData || disposed) return;
        const style = getStyle(layer.styleId);
        try {
          const [descs, r] = await Promise.all([descsOf(style), getRunner()]);
          if (disposed || stack.find(uid) !== layer || !layer.visible) return;
          layer.params = normalizeParams(descs, layer.params);
          r.run(uid, { ...style, params: descs }, { image: imageData, params: layer.params }, (state) => stack.applyResult(uid, state));
        } catch (e) {
          stack.applyResult(uid, { status: 'error', message: e.message, lines: [] });
        }
      }

      const cancel = (uid) => { clearTimeout(timers.get(uid)); timers.delete(uid); if (runner) runner.cancel(uid); };

      function rerunAll() {
        for (const l of stack.layers) {
          if (l.visible) schedule(l, 0); else { cancel(l.uid); stack.reset(l.uid); }
        }
      }

      async function addLayer(styleId) {
        try {
          const descs = await descsOf(getStyle(styleId));
          const layer = stack.add(styleId, { params: defaultsOfParams(descs) });
          schedule(layer, 0);
        } catch (e) { $.warn.textContent = `Не удалось добавить слой: ${e.message}`; }
      }

      // --- image
      async function loadFile(file) {
        if (!file) return;
        let next;
        try { next = await decodeImage(file); } catch (e) {
          $.warn.textContent = e instanceof ImageLoadError ? 'Не удалось открыть изображение' : `Ошибка: ${e.message}`;
          return; // the previous image and layers stay
        }
        if (decoded) decoded.bitmap.close();
        decoded = next;
        view.reset();
        imageName = baseName(file.name, 'photo');
        $.warn.textContent = '';
        applyWorkingSize();
        if (!stack.layers.length) await addLayer(DEFAULT_STYLE); else rerunAll();
      }

      function applyWorkingSize() {
        if (!decoded) return;
        imageData = rasterize(decoded, workingSize);
        $.info.textContent = `${imageName}: ${decoded.width}×${decoded.height}, рабочее ${imageData.width}×${imageData.height}`;
        renderLayers();
        requestDraw();
      }

      // --- layers: DOM
      function statusText(l) {
        if (!l.visible) return 'скрыт';
        if (l.status === 'idle') return imageData ? 'ожидание' : 'нет изображения';
        const base = STATUS_TEXT[l.status];
        if (l.status === 'error') return `${base}: ${l.message}`;
        if (l.status === 'done') return base;
        return [base, l.progress, l.reason && (l.status === 'running' ? `промежуточный: ${l.reason}` : l.reason)].filter(Boolean).join(' · ');
      }

      function densityOf(l) {
        const style = getStyle(l.styleId);
        if (!style.spacing || !imageData || !l.visible) return null;
        try {
          const px = style.spacing(l.params, imageData);
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
        $.layers.replaceChildren(...(layers.length ? layers.map((l, i) => layerView(l, i, layers.length)) : [h('div', { class: 'note' }, 'Слоёв нет: добавь стиль.')]));
        layers.forEach((l) => refreshLayerInfo(l.uid));
        updateActions();
      }

      function layerView(l, i, total) {
        const style = getStyle(l.styleId);
        const e = { status: h('div', { class: 'layer-status', role: 'status' }), density: h('div', { class: 'note' }) };
        elements.set(l.uid, e);
        const styleSelect = h('select', { 'aria-label': 'Стиль слоя', onchange: () => changeStyle(l.uid, styleSelect.value) },
          groupedStyles().map((g) => h('optgroup', { label: g.group }, g.styles.map((s) => h('option', { value: s.id, selected: s.id === l.styleId }, `${s.name} · ${originLabel(s)}`)))));
        const inner = h('div');
        const body = h('details', { class: 'layer-body', open: i === total - 1 }, h('summary', {}, 'Параметры'), inner);
        descsOf(style).then((descs) => {
          if (disposed || stack.find(l.uid) !== l) return;
          l.params = normalizeParams(descs, l.params);
          inner.replaceChildren(buildParamForm(descs, l.params, (key, value) => changeParam(l, descs, key, value)));
          refreshLayerInfo(l.uid);
        }).catch((err) => { inner.textContent = `Параметры недоступны: ${err.message}`; });
        return h('div', { class: 'layer', style: `--layer-color: var(--layer-${i % 4})` },
          h('div', { class: 'layer-head' },
            h('label', { class: 'check', title: 'показывать слой' }, h('input', { type: 'checkbox', checked: l.visible, 'aria-label': 'Показывать слой', onchange: (ev) => setVisible(l, ev.target.checked) })),
            h('input', { class: 'layer-name', value: l.name, 'aria-label': 'Название слоя', onchange: (ev) => { stack.rename(l.uid, ev.target.value); ev.target.value = l.name; } }),
            h('button', { type: 'button', title: 'выше', 'aria-label': 'Слой выше', disabled: i === 0, onclick: () => stack.move(l.uid, -1) }, '↑'),
            h('button', { type: 'button', title: 'ниже', 'aria-label': 'Слой ниже', disabled: i === total - 1, onclick: () => stack.move(l.uid, 1) }, '↓'),
            h('button', { type: 'button', class: 'danger', title: 'удалить', 'aria-label': 'Удалить слой', onclick: () => removeLayer(l.uid) }, '×')),
          h('label', {}, 'Стиль', styleSelect),
          e.status, e.density, body);
      }

      function setVisible(l, visible) {
        stack.setVisible(l.uid, visible);
        if (visible) { if (l.status !== 'done') schedule(l, 0); } else { cancel(l.uid); if (l.status !== 'done') stack.reset(l.uid); }
      }

      function removeLayer(uid) { cancel(uid); stack.remove(uid); }

      function changeStyle(uid, styleId) {
        const l = stack.find(uid);
        cancel(uid);
        stack.setStyle(uid, styleId);
        if (l.visible) schedule(l, 0);
      }

      function changeParam(l, descs, key, value) {
        stack.setParams(l.uid, { [key]: value });
        const desc = descs.find((d) => d.key === key);
        // live parameters go to the running worker, the rest restart the layer (with a delay for slider movement)
        if (l.visible && desc && desc.live && runner && runner.live(l.uid, l.params)) return;
        if (l.visible) { clearTimeout(timers.get(l.uid)); schedule(l, PARAM_DEBOUNCE_MS); }
      }

      // --- preview
      function requestDraw() {
        if (drawQueued) return;
        drawQueued = true;
        requestAnimationFrame(() => { drawQueued = false; if (!disposed) draw(); });
      }

      function draw() {
        const css = getComputedStyle(document.documentElement);
        const col = (n) => css.getPropertyValue(n).trim();
        const g = $.canvas.getContext('2d');
        const W = $.canvas.width, H = $.canvas.height, dpr = window.devicePixelRatio || 1;
        $.canvas.style.setProperty('--ar', imageData ? String(imageData.width / imageData.height) : '3');
        view.setSize(W, H);
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        g.fillStyle = col('--paper'); g.fillRect(0, 0, W, H);
        if (!imageData) { g.fillStyle = col('--muted'); g.font = `${16 * dpr}px system-ui`; g.fillText('Фото не загружено', 16 * dpr, 30 * dpr); return; }
        view.apply(g);
        if ($.showPhoto.checked && decoded) { g.globalAlpha = 0.3; g.drawImage(decoded.bitmap, 0, 0, W, H); g.globalAlpha = 1; }
        const k = W / imageData.width;
        g.lineJoin = 'round'; g.lineWidth = (1.4 * dpr) / view.zoom; // constant thickness in screen pixels
        const eps = (0.6 * dpr) / view.zoom;
        stack.layers.forEach((l, i) => {
          if (!l.visible || !l.lines.length) return;
          g.strokeStyle = col(`--layer-${i % 4}`);
          g.beginPath();
          for (const line of l.lines) {
            let px = line[0] * k, py = line[1] * k;
            g.moveTo(px, py);
            for (let j = 2; j < line.length; j += 2) {
              const x = line[j] * k, y = line[j + 1] * k;
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
        $.stats.textContent = lines ? `${lines} линий, ${points} точек` + (pending.length ? ', есть незавершённые слои' : '') : 'Пока нет линий';
        $.toPrint.disabled = !lines;
        $.exportSvg.disabled = !lines;
      }

      // --- output
      function currentDrawing() { return stack.toDrawing({ name: imageName }); }

      function sendToPrint() {
        const drawing = currentDrawing();
        if (!drawing) return;
        const pending = stack.pending();
        if (pending.length) {
          const list = pending.map((p) => `слой «${p.name}» не завершён${p.reason ? ` (${p.reason})` : ''}`).join('\n');
          if (!window.confirm(`${list}\n\nРезультат промежуточный. Передать во вкладку «Печать» всё равно?`)) return;
          $.sendWarn.textContent = `Передан промежуточный рисунок:\n${list}`;
        } else $.sendWarn.textContent = '';
        const s = stats(drawing);
        $.info.textContent = `${imageName}: передано ${s.lines} линий, ${s.points} точек`;
        ctx.emit(drawing);
      }

      function exportSvgFile() {
        const drawing = currentDrawing();
        if (drawing) downloadText(`${imageName || 'photo'}.svg`, exportSvg(drawing), 'image/svg+xml');
      }

      // --- presets
      function exportPreset() {
        downloadText(`${imageName || 'photo'}-layers.json`, JSON.stringify(stack.toPreset(workingSize), null, 2), 'application/json');
      }

      async function applyPreset(preset) {
        for (const l of stack.layers) cancel(l.uid);
        const { workingSize: size, skipped } = stack.loadPreset(preset);
        workingSize = size; $.size.value = size;
        if (skipped.length) $.warn.textContent = `Неизвестные стили в пресете пропущены: ${skipped.join(', ')}`;
        if (decoded) applyWorkingSize(); else renderLayers();
        rerunAll();
      }

      async function importPresetFile(file) {
        if (!file) return;
        try { await applyPreset(JSON.parse(await file.text())); } catch (e) { $.warn.textContent = `Не удалось прочитать пресет: ${e.message}`; }
      }

      function persist() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => ctx.presets.save(stack.toPreset(workingSize)), SAVE_DEBOUNCE_MS);
      }

      // --- events
      const offStack = stack.subscribe((e) => {
        if (e.type === 'result') { refreshLayerInfo(e.uid); updateActions(); requestDraw(); return; }
        if (e.type === 'params') { refreshLayerInfo(e.uid); persist(); return; }
        if (e.type === 'meta') { persist(); return; }
        renderLayers(); requestDraw(); persist();
      });
      const offPrint = ctx.printParams.subscribe((p) => { printParams = p; for (const l of stack.layers) refreshLayerInfo(l.uid); });
      const detachView = view.attach($.canvas, requestDraw);
      const resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        const r = $.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
        if (w < 2 || hh < 2 || ($.canvas.width === w && $.canvas.height === hh)) return;
        $.canvas.width = w; $.canvas.height = hh; requestDraw();
      }) : null;
      if (resizeObs) resizeObs.observe($.canvas);
      const dark = window.matchMedia('(prefers-color-scheme: dark)');
      dark.addEventListener('change', requestDraw);

      $.drop.addEventListener('click', () => input.click());
      $.drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
      input.addEventListener('change', () => { loadFile(input.files[0]).finally(() => { input.value = ''; }); });
      presetInput.addEventListener('change', () => { importPresetFile(presetInput.files[0]).finally(() => { presetInput.value = ''; }); });
      $.drop.addEventListener('dragover', (e) => { e.preventDefault(); $.drop.classList.add('over'); });
      $.drop.addEventListener('dragleave', () => $.drop.classList.remove('over'));
      $.drop.addEventListener('drop', (e) => { e.preventDefault(); $.drop.classList.remove('over'); loadFile(e.dataTransfer.files[0]); });
      $.size.addEventListener('change', () => {
        workingSize = clampSize($.size.value);
        $.size.value = workingSize;
        persist();
        if (decoded) { applyWorkingSize(); rerunAll(); }
      });

      cleanup = [offStack, offPrint, detachView, () => { if (resizeObs) resizeObs.disconnect(); }, () => dark.removeEventListener('change', requestDraw), () => {
        disposed = true;
        clearTimeout(saveTimer);
        for (const t of timers.values()) clearTimeout(t);
        if (runner) runner.dispose();
      }];

      // restoring the saved stack (without an image; computation starts after the photo is loaded)
      renderLayers();
      draw();
      ctx.presets.load().then((saved) => {
        if (!saved || disposed) return;
        try {
          const { workingSize: size } = stack.loadPreset(saved);
          workingSize = size; $.size.value = size;
        } catch (e) { /* a corrupted preset is ignored */ }
      });
    },

    unmount() { for (const fn of cleanup) fn(); cleanup = []; },
  };
}

export { STYLES };
