// "Print" tab: settings, preview, statistics, download, sending, manual commands, job status.
import { h } from '../ui/dom.js';
import { mountSettingsPanel, calibrationSummary } from '../ui/settings-panel.js';
import { renderPreview } from '../ui/preview.js';
import { buildPlan, fieldOf, cornerOf, sheetCheck } from '../../core/pipeline.js';
import { exportSvg, exportOnPaper } from '../../core/svg-export.js';
import { isPartial, partialReasons } from '../../core/drawing.js';
import { axisLimits } from '../../core/profile.js';
import { downloadText, baseName } from '../download.js';

const POLL_MS = 3000;
const MANUAL_BUTTONS = [
  ['up', 'Перо вверх'], ['corner', 'К углу бумаги'], ['touch', 'Перо на касание'], ['motorsOff', 'Моторы выкл'], ['home', 'Home (G28)'],
];

export function createPrintTab({ state, store, service, transport, ui = {} }) {
  let timer = 0, pollTimer = 0, unsubscribe = () => {}, plan = null, planError = '';
  let lastJobState = '', darkQuery = null, redraw = null;

  return {
    id: 'print',
    title: 'Печать',

    mount(el) {
      const $ = {};
      const button = (key, text, onclick, cls = '') => ($[key] = h('button', { type: 'button', class: cls, onclick }, text));

      // --- left column: settings
      const settingsHost = h('div', { class: 'settings' });
      mountSettingsPanel(settingsHost, { state, store, notify: (m) => log(m), ui });

      // --- right column
      $.canvas = h('canvas', { class: 'preview', width: 900, height: 900 });
      $.travel = h('input', { type: 'checkbox', checked: true, onchange: draw });
      $.stats = h('div', { class: 'stats' });
      $.calibration = h('div', { class: 'note' });
      $.partial = h('div', { class: 'warn' });
      $.warn = h('div', { class: 'warn' });
      $.name = h('input', { placeholder: 'plot.gcode' });
      $.job = h('div', { class: 'job' }, 'Нет связи');
      $.progress = h('progress', { max: 100, value: 0 });
      $.log = h('div', { class: 'log' });

      const previewCard = h('div', { class: 'card' },
        $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.travel, 'переезды')),
        $.stats, $.calibration, $.partial, $.warn,
        h('div', { class: 'row' },
          button('dlGcode', 'Скачать G-code', () => download('gcode')),
          button('dlSvg', 'Скачать SVG', () => download('svg')),
          button('dlPaper', 'SVG как на бумаге', () => download('paper'))));

      const sendCard = h('div', { class: 'card' },
        h('h2', {}, 'Отправка'),
        h('label', {}, 'Имя файла в OctoPrint', $.name),
        h('div', { class: 'row' },
          button('frame', 'Обвести рамку', () => run('Рамка', () => service.frame(state.drawing()))),
          button('upload', 'Загрузить в OctoPrint', () => run('Загрузка', () => service.send(state.drawing(), { print: false, name: fileName() }))),
          button('print', 'Отправить и печатать', () => run('Рисование', () => service.send(state.drawing(), { print: true, name: fileName() })), 'primary')));

      const printerCard = h('div', { class: 'card' },
        h('h2', {}, 'Принтер'),
        h('div', { class: 'row' }, button('test', 'Проверить связь', testConnection),
          MANUAL_BUTTONS.map(([id, text]) => button('m-' + id, text, () => run(text, () => service.manual(id))))),
        $.job, $.progress,
        h('div', { class: 'row' },
          button('pause', 'Пауза / продолжить', () => run('Пауза', () => service.pause(!/^Paus/.test(lastJobState)))),
          button('cancel', 'Отмена', () => { if (confirm('Отменить рисование?')) run('Отмена', () => service.cancel()); }, 'danger')),
        $.log);

      el.append(h('div', { class: 'columns' }, h('div', {}, settingsHost), h('div', { class: 'work-col' }, previewCard, sendCard, printerCard)));

      // --- behavior
      const log = (msg) => {
        $.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
        $.log.scrollTop = $.log.scrollHeight;
      };

      async function run(label, action) {
        try {
          const r = await action();
          log(`${label}: ${r.ok ? (r.message || 'ок') : r.message}`);
        } catch (e) {
          log(`${label}: ${e.message}`);
        }
        poll();
      }

      async function testConnection() {
        try {
          const r = await transport.test();
          log(`OctoPrint ${r.server}${r.printer ? `, принтер: ${r.printer}` : ''}`);
        } catch (e) { log(`Связь: ${e.message}`); }
        poll();
      }

      const fileName = () => (($.name.value.trim() || `${baseName(state.sourceName())}`).replace(/(\.gcode)?$/i, '') + '.gcode');

      function download(kind) {
        if (!plan) return;
        const base = baseName(state.sourceName());
        if (kind === 'gcode') downloadText(`${base}.gcode`, plan.gcode);
        else if (kind === 'svg') downloadText(`${base}.svg`, exportSvg(plan.machine), 'image/svg+xml');
        else downloadText(`${base}-paper.svg`, exportOnPaper(plan.machine, { field: plan.field, corner: plan.corner }), 'image/svg+xml');
      }

      function draw() {
        const s = state.settings();
        renderPreview($.canvas, {
          machine: plan ? plan.machine : null, field: fieldOf(s.job), corner: cornerOf(s.calibration),
          limits: axisLimits(s.profile), showTravel: $.travel.checked,
          emptyText: planError || 'Рисунок не загружен',
        });
      }

      function render() {
        const s = state.settings();
        const drawing = state.drawing();
        plan = null; planError = '';
        if (drawing) {
          try { plan = buildPlan(drawing, s); } catch (e) { planError = e.message; }
        }
        const warnings = [...sheetCheck(s), ...(plan ? plan.warnings : [])];
        if (planError) warnings.push(planError);
        $.warn.textContent = warnings.join('\n');
        $.calibration.textContent = calibrationSummary(s.calibration);
        $.partial.textContent = drawing && isPartial(drawing)
          ? `Рисунок промежуточный${partialReasons(drawing).length ? ': ' + partialReasons(drawing).join('; ') : ''}. Отправка на принтер потребует подтверждения.` : '';

        if (plan) {
          const st = plan.stats, o = plan.optimization;
          $.stats.textContent = `${st.lines} линий · рисунок ${st.size[0].toFixed(1)}×${st.size[1].toFixed(1)} мм` +
            ` · перо ${(st.draw / 1000).toFixed(2)} м, переезды ${(st.travel / 1000).toFixed(2)} м · ≈${Math.ceil(st.seconds / 60)} мин` +
            ` · X ${st.bbox.x0.toFixed(1)}…${st.bbox.x1.toFixed(1)}, Y ${st.bbox.y0.toFixed(1)}…${st.bbox.y1.toFixed(1)}` +
            ` · оптимизация: точек ${o.pointsBefore}→${o.pointsAfter}, линий ${o.linesBefore}→${o.linesAfter}, переезды ${(o.travelBefore / 1000).toFixed(2)}→${(o.travelAfter / 1000).toFixed(2)} м`;
        } else $.stats.textContent = '';

        const online = transport.configured();
        for (const k of ['dlGcode', 'dlSvg', 'dlPaper']) $[k].disabled = !plan;
        for (const k of ['frame', 'upload', 'print']) $[k].disabled = !plan || !online;
        for (const k of ['test', 'pause', 'cancel', ...MANUAL_BUTTONS.map(([id]) => 'm-' + id)]) $[k].disabled = !online;
        if (!online) $.job.textContent = 'Принтер не настроен: укажите адрес и API-ключ OctoPrint';
        if (!$.name.dataset.touched) $.name.value = drawing ? `${baseName(state.sourceName())}.gcode` : '';
        draw();
      }

      $.name.addEventListener('input', () => { $.name.dataset.touched = '1'; });

      let polling = false;
      async function poll() {
        if (polling || !transport.configured()) return;
        polling = true;
        try {
          const j = await transport.job();
          lastJobState = j.state || '';
          const left = j.timeLeft != null ? ` · осталось ≈${Math.ceil(j.timeLeft / 60)} мин` : '';
          $.job.textContent = `${j.state}${j.file ? ` · ${j.file}` : ''}${j.progress != null ? ` · ${j.progress.toFixed(1)}%` : ''}${left}`;
          $.progress.value = j.progress || 0;
        } catch (e) {
          lastJobState = '';
          $.job.textContent = `Нет связи: ${e.message}`;
        }
        polling = false;
      }

      unsubscribe = state.subscribe((e) => {
        if (e.type === 'settings' && e.section === 'connection') { render(); poll(); return; }
        if (e.type === 'drawing') $.name.dataset.touched = '';
        clearTimeout(timer);
        timer = setTimeout(render, 120);
      });
      darkQuery = matchMedia('(prefers-color-scheme: dark)');
      redraw = draw;
      darkQuery.addEventListener('change', redraw);
      pollTimer = setInterval(poll, POLL_MS);
      render();
      poll();
    },

    unmount() {
      unsubscribe();
      if (darkQuery) darkQuery.removeEventListener('change', redraw);
      clearTimeout(timer);
      clearInterval(pollTimer);
    },
  };
}
