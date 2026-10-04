// "Text" source: a phrase -> a single-stroke font -> "like by hand" -> preview -> ctx.emit(drawing) on "To print".
// The model (text, font, parameters, seed, user fonts) lives in text/text-model.js and outlives the view: mount/unmount only
// build and remove the DOM (a live language switch remounts the view).
import { h, button } from '../ui/dom.js';
import { createViewport } from '../ui/viewport.js';
import { stats, bbox } from '../../core/drawing.js';
import { createTextModel } from '../text/text-model.js';
import { TEXT_PARAMS, HAND_PARAMS, TEXT_PRESETS } from '../text/text-params.js';
import { buildParamForm, buildPresetPicker } from '../photo/param-form.js';
import { t, fmtNumber } from '../../i18n/index.js';

const mm = (v) => fmtNumber(v, { maxFrac: 1 });

/** Polylines into a canvas: fitted into (W, H) with a margin, Y down; returns nothing. */
function strokeLines(g, lines, W, H, { pad, lineWidth, color }) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of lines) for (let i = 0; i < l.length; i += 2) {
    if (l[i] < x0) x0 = l[i];
    if (l[i] > x1) x1 = l[i];
    if (l[i + 1] < y0) y0 = l[i + 1];
    if (l[i + 1] > y1) y1 = l[i + 1];
  }
  if (x0 === Infinity) return;
  const k = Math.min((W - 2 * pad) / Math.max(x1 - x0, 1e-6), (H - 2 * pad) / Math.max(y1 - y0, 1e-6));
  const ox = (W - (x1 - x0) * k) / 2 - x0 * k, oy = (H - (y1 - y0) * k) / 2 - y0 * k;
  g.strokeStyle = color; g.lineWidth = lineWidth; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath();
  for (const l of lines) {
    g.moveTo(l[0] * k + ox, l[1] * k + oy);
    for (let i = 2; i < l.length; i += 2) g.lineTo(l[i] * k + ox, l[i + 1] * k + oy);
  }
  g.stroke();
}

/** @param createModel () => text model (tests); by default the real one (fetches the built-in fonts) */
export function createTextSource({ createModel = () => createTextModel() } = {}) {
  let model = null;
  let cleanup = [];
  const view = createViewport();
  let canvasSize = { w: 900, h: 360 };

  return {
    id: 'text',
    get title() { return t('tab.text'); },
    /** The model (tests and diagnostics). */
    get model() { return model; },

    mount(el, ctx) {
      if (!model) model = createModel();
      const m = model;
      m.attach(ctx);
      let alive = true, drawQueued = false, editing = false;

      // --- DOM
      const $ = {};
      $.text = h('textarea', { rows: 4, placeholder: t('texttab.placeholder'), 'aria-label': t('texttab.text'), value: m.text() });
      $.font = h('select', { 'aria-label': t('texttab.font') });
      $.sample = h('canvas', { class: 'text-sample', width: 600, height: 60, 'aria-label': t('texttab.sampleAria') });
      $.fileInput = h('input', { type: 'file', accept: '.svg,.jhf,image/svg+xml', hidden: true });
      $.addFont = button({ label: t('texttab.addFont'), hint: 'texttab.addFont.hint', onclick: () => $.fileInput.click() });
      $.removeFont = button({ label: t('texttab.removeFont'), hint: 'texttab.removeFont.hint', class: 'danger', onclick: removeFont });
      $.info = h('div', { class: 'note', role: 'status' });
      $.warn = h('div', { class: 'warn', role: 'alert' });
      $.params = h('div');
      $.canvas = h('canvas', { class: 'preview photo-preview text-preview', width: canvasSize.w, height: canvasSize.h, 'aria-label': t('texttab.previewAria') });
      $.fit = button({ label: t('texttab.fit'), hint: 'texttab.fit.hint', onclick: () => { view.reset(); requestDraw(); } });
      $.stats = h('div', { class: 'stats' });
      $.drawWarn = h('div', { class: 'warn' });
      $.variation = button({ label: t('texttab.newVariation'), hint: 'texttab.newVariation.hint', onclick: () => m.newVariation() });
      $.toPrint = button({ label: t('texttab.toPrint'), hint: 'texttab.toPrint.hint', class: 'primary', onclick: () => m.sendToPrint() });

      const textCard = h('div', { class: 'card' },
        h('label', {}, t('texttab.text'), $.text),
        h('label', {}, t('texttab.font'), $.font),
        $.sample,
        h('div', { class: 'row' }, $.addFont, $.removeFont, $.fileInput),
        h('div', { class: 'note' }, t('texttab.userFonts.note')),
        $.info, $.warn);
      const paramsCard = h('div', { class: 'card text-params' }, h('h2', {}, t('texttab.params')), $.params);
      const previewCard = h('div', { class: 'card' }, $.canvas,
        h('div', { class: 'row spread' }, $.stats, $.fit),
        $.drawWarn,
        h('div', { class: 'row' }, $.toPrint, $.variation));
      el.append(h('div', { class: 'columns' }, h('div', {}, textCard, paramsCard), h('div', { class: 'work-col sticky' }, previewCard)));

      // --- fonts
      function renderFonts() {
        const fonts = m.fonts();
        const opt = (f) => h('option', { value: f.id, selected: f.id === m.fontId() },
          f.user ? t(f.where === 'local' ? 'texttab.userFontLocal' : 'texttab.userFont', { name: f.name }) : f.name);
        const builtin = fonts.filter((f) => !f.user), user = fonts.filter((f) => f.user);
        $.font.replaceChildren(
          h('optgroup', { label: t('texttab.fonts.builtin') }, builtin.map(opt)),
          ...(user.length ? [h('optgroup', { label: t('texttab.fonts.user') }, user.map(opt))] : []));
        $.font.value = m.fontId();
        $.removeFont.disabled = !user.some((f) => f.id === m.fontId());
      }

      async function removeFont() {
        const f = m.fonts().find((x) => x.id === m.fontId() && x.user);
        if (!f || !window.confirm(t('texttab.removeConfirm', { name: f.name }))) return;
        await m.removeFont(f.id);
      }

      // --- parameters: a slider change does not rebuild the form under the finger
      let picker = null;
      function renderParams() {
        picker = buildPresetPicker(HAND_PARAMS, TEXT_PRESETS, m.params(), (id) => { m.applyPreset(id); renderParams(); });
        $.params.replaceChildren(picker.el, buildParamForm(TEXT_PARAMS, m.params(), (key, value) => {
          editing = true;
          try { m.setParams({ [key]: value }); } finally { editing = false; }
          picker.sync(m.params());
        }));
      }

      function renderMessages() {
        $.info.textContent = m.message('info');
        $.warn.textContent = m.message('warn');
      }

      // --- preview
      function requestDraw() {
        if (drawQueued) return;
        drawQueued = true;
        requestAnimationFrame(() => { drawQueued = false; if (alive) draw(); });
      }

      function draw() {
        const css = getComputedStyle(document.documentElement);
        const col = (n) => css.getPropertyValue(n).trim();
        const dpr = window.devicePixelRatio || 1;
        const d = m.drawing();
        const lines = d ? d.layers.flatMap((l) => l.lines) : [];
        const b = d ? bbox(d) : null;
        const s = d ? stats(d) : { lines: 0 };
        // the canvas follows the text proportions (between 4:1 and 1:1)
        const ar = b ? Math.min(4, Math.max(1, (b.w + 4) / (b.h + 4))) : 3;
        $.canvas.style.setProperty('--ar', String(ar));
        const W = $.canvas.width, H = $.canvas.height;
        view.setSize(W, H);
        const g = $.canvas.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        g.fillStyle = col('--paper'); g.fillRect(0, 0, W, H);
        if (!lines.length) {
          g.fillStyle = col('--muted'); g.font = `${16 * dpr}px system-ui`;
          g.fillText(d ? t('texttab.empty') : t('texttab.loadingFont'), 16 * dpr, 30 * dpr);
        } else {
          view.apply(g);
          strokeLines(g, lines, W, H, { pad: 12 * dpr, lineWidth: (1.4 * dpr) / view.zoom, color: col('--layer-0') || '#000' });
        }
        $.stats.textContent = s.lines ? t('texttab.stats', { lines: t('svgtab.lines', { count: s.lines }), w: mm(d.meta.physicalSize.w), h: mm(d.meta.physicalSize.h) }) : '';
        $.drawWarn.textContent = d ? d.meta.warnings.join('\n') : '';
        $.toPrint.disabled = !s.lines;
        $.variation.disabled = !s.lines || !(m.params().variation > 0);
        drawSample(col, dpr);
      }

      function drawSample(col, dpr) {
        const g = $.sample.getContext('2d'), W = $.sample.width, H = $.sample.height;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, W, H);
        const lines = m.sample();
        if (lines) strokeLines(g, lines, W, H, { pad: 6, lineWidth: 1.2 * dpr, color: col('--text') || '#000' });
      }

      // --- events
      const offModel = m.subscribe((e) => {
        if (e.type === 'fonts' || e.type === 'font') { renderFonts(); requestDraw(); }
        else if (e.type === 'drawing') { if (!editing && picker) picker.sync(m.params()); requestDraw(); }
        else if (e.type === 'state') { $.text.value = m.text(); renderParams(); requestDraw(); }
        else if (e.type === 'message') renderMessages();
      });
      const onInput = () => m.setText($.text.value);
      $.text.addEventListener('input', onInput);
      const onFont = () => m.setFont($.font.value);
      $.font.addEventListener('change', onFont);
      const onFile = () => { const f = $.fileInput.files[0]; m.addFontFile(f).finally(() => { $.fileInput.value = ''; }); };
      $.fileInput.addEventListener('change', onFile);
      const detachView = view.attach($.canvas, requestDraw);
      const resizeObs = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        const r = $.canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
        const w = Math.round(r.width * dpr), hh = Math.round(r.height * dpr);
        if (w < 2 || hh < 2 || ($.canvas.width === w && $.canvas.height === hh)) return;
        $.canvas.width = w; $.canvas.height = hh; canvasSize = { w, h: hh }; requestDraw();
      }) : null;
      if (resizeObs) resizeObs.observe($.canvas);
      const dark = window.matchMedia('(prefers-color-scheme: dark)');
      dark.addEventListener('change', requestDraw);

      cleanup = [offModel, detachView,
        () => $.text.removeEventListener('input', onInput), () => $.font.removeEventListener('change', onFont),
        () => $.fileInput.removeEventListener('change', onFile),
        () => { if (resizeObs) resizeObs.disconnect(); }, () => dark.removeEventListener('change', requestDraw), () => { alive = false; }];

      renderFonts();
      renderParams();
      renderMessages();
      draw();
    },

    /** Removes the view: subscriptions and DOM listeners; the model (text, font, parameters, user fonts) stays. */
    unmount() { for (const fn of cleanup) fn(); cleanup = []; },

    /** Full teardown: the view and the model (timers). */
    dispose() { this.unmount(); if (model) model.dispose(); model = null; },
  };
}
