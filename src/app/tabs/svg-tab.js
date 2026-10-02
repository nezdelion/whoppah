// "SVG" source: file loading (choose or drag&drop) -> importSvg -> ctx.emit(drawing).
// The loaded file and the last import result live in the source, not in the view: mount/unmount can be repeated
// (a live language switch remounts the view) without losing the file; the messages are shown in the current language.
import { h } from '../ui/dom.js';
import { importSvg, SvgImportError } from '../../core/svg-import.js';
import { stats } from '../../core/drawing.js';
import { svgTextToTree } from '../dom-svg.js';
import { baseName } from '../download.js';
import { t, fmtNumber } from '../../i18n/index.js';

/** @param parse (text) => SVG tree (tests replace the DOMParser-based one) */
export function createSvgSource({ parse = svgTextToTree } = {}) {
  // model: the loaded file, the print parameters of its last import, the messages (functions — computed on render)
  let loaded = null; // { tree, name }
  let lastFit = '';
  const messages = { info: null, warn: null };
  let ctx = null, paint = () => {}, unsubscribe = () => {};

  const say = (next) => { Object.assign(messages, next); paint(); };
  const text = (name) => (messages[name] ? messages[name]() : '');

  function runImport() {
    const params = ctx.printParams.get();
    const fit = { fieldMm: params.fieldMm, marginMm: params.marginMm, rotate: params.rotate };
    lastFit = JSON.stringify(fit);
    try {
      const drawing = importSvg(loaded.tree, { name: loaded.name, fit });
      const s = stats(drawing), { name } = loaded, meta = drawing.meta;
      say({
        info: () => {
          const size = meta.physicalSize ? t('svgtab.size', { w: fmtNumber(meta.physicalSize.w, { minFrac: 1 }), h: fmtNumber(meta.physicalSize.h, { minFrac: 1 }) }) : '';
          return t('svgtab.info', { name, lines: t('svgtab.lines', { count: s.lines }), points: t('svgtab.points', { count: s.points }), size }) +
            (meta.dropped ? t('svgtab.dropped', { count: meta.dropped }) : '');
        },
        warn: () => meta.warnings.join('\n'), // core texts: in the language of the import
      });
      ctx.emit(drawing);
    } catch (e) {
      const message = e instanceof SvgImportError ? e.message[0].toUpperCase() + e.message.slice(1) : null;
      say({ warn: message ? () => message : () => t('common.errorWith', { message: e.message }) });
    }
  }

  async function load(file) {
    if (!file) return;
    try {
      loaded = { tree: parse(await file.text()), name: baseName(file.name) };
    } catch (e) {
      // the previous drawing stays in place
      say({ warn: () => t('svgtab.readFailed') });
      return;
    }
    runImport();
  }

  return {
    id: 'svg',
    title: 'SVG',
    /** The loaded file name or null (tests and diagnostics). */
    loadedName: () => (loaded ? loaded.name : null),
    /** Loading a file as from the file picker (tests). */
    load,

    mount(el, context) {
      ctx = context;
      const input = h('input', { type: 'file', accept: '.svg,image/svg+xml', hidden: true });
      const drop = h('div', { class: 'drop', tabindex: 0, role: 'button' }, t('svgtab.drop'), input);
      const info = h('div', { class: 'note' });
      const warn = h('div', { class: 'warn' });
      el.append(h('div', { class: 'card' }, drop, info, warn));
      paint = () => { info.textContent = text('info'); warn.textContent = text('warn'); };
      paint();

      drop.addEventListener('click', () => input.click());
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
      input.addEventListener('change', () => { load(input.files[0]).finally(() => { input.value = ''; }); });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); });

      // the curve chord length depends on the scale on paper: recompute when the field changes
      unsubscribe();
      unsubscribe = ctx.printParams.subscribe(() => {
        if (!loaded || !ctx.ownsDrawing()) return; // the drawing was supplied by another tab — do not overwrite it
        const p = ctx.printParams.get();
        if (JSON.stringify({ fieldMm: p.fieldMm, marginMm: p.marginMm, rotate: p.rotate }) !== lastFit) runImport();
      });
    },

    /** Removes the view and its subscription; the loaded file stays. */
    unmount() { unsubscribe(); unsubscribe = () => {}; paint = () => {}; },
  };
}
