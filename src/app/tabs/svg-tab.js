// "SVG" source: file loading (choose or drag&drop) -> importSvg -> ctx.emit(drawing).
import { h } from '../ui/dom.js';
import { importSvg, SvgImportError } from '../../core/svg-import.js';
import { stats } from '../../core/drawing.js';
import { svgTextToTree } from '../dom-svg.js';
import { baseName } from '../download.js';
import { t, fmtNumber } from '../../i18n/index.js';

export function createSvgSource() {
  let unsubscribe = () => {};

  return {
    id: 'svg',
    title: 'SVG',

    mount(el, ctx) {
      let loaded = null; // { tree, name }
      let lastFit = '';
      const input = h('input', { type: 'file', accept: '.svg,image/svg+xml', hidden: true });
      const drop = h('div', { class: 'drop', tabindex: 0, role: 'button' }, t('svgtab.drop'), input);
      const info = h('div', { class: 'note' });
      const warn = h('div', { class: 'warn' });
      el.append(h('div', { class: 'card' }, drop, info, warn));

      function runImport() {
        const params = ctx.printParams.get();
        const fit = { fieldMm: params.fieldMm, marginMm: params.marginMm, rotate: params.rotate };
        lastFit = JSON.stringify(fit);
        try {
          const drawing = importSvg(loaded.tree, { name: loaded.name, fit });
          const s = stats(drawing);
          const size = drawing.meta.physicalSize ? t('svgtab.size', { w: fmtNumber(drawing.meta.physicalSize.w, { minFrac: 1 }), h: fmtNumber(drawing.meta.physicalSize.h, { minFrac: 1 }) }) : '';
          info.textContent = t('svgtab.info', { name: loaded.name, lines: t('svgtab.lines', { count: s.lines }), points: t('svgtab.points', { count: s.points }), size }) +
            (drawing.meta.dropped ? t('svgtab.dropped', { count: drawing.meta.dropped }) : '');
          warn.textContent = drawing.meta.warnings.join('\n');
          ctx.emit(drawing);
        } catch (e) {
          warn.textContent = e instanceof SvgImportError ? e.message[0].toUpperCase() + e.message.slice(1) : t('common.errorWith', { message: e.message });
        }
      }

      async function load(file) {
        if (!file) return;
        try {
          loaded = { tree: svgTextToTree(await file.text()), name: baseName(file.name) };
        } catch (e) {
          // the previous drawing stays in place
          warn.textContent = t('svgtab.readFailed');
          return;
        }
        runImport();
      }

      drop.addEventListener('click', () => input.click());
      drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
      input.addEventListener('change', () => { load(input.files[0]).finally(() => { input.value = ''; }); });
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); load(e.dataTransfer.files[0]); });

      // the curve chord length depends on the scale on paper: recompute when the field changes
      unsubscribe = ctx.printParams.subscribe(() => {
        if (!loaded || !ctx.ownsDrawing()) return; // the drawing was supplied by another tab — do not overwrite it
        const p = ctx.printParams.get();
        if (JSON.stringify({ fieldMm: p.fieldMm, marginMm: p.marginMm, rotate: p.rotate }) !== lastFit) runImport();
      });
    },

    unmount() { unsubscribe(); },
  };
}
