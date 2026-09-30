// "Print" tab: settings, preview, statistics, download, sending, manual commands, job status.
import { h } from '../ui/dom.js';
import { mountSettingsPanel, calibrationSummary } from '../ui/settings-panel.js';
import { createViewport } from '../ui/viewport.js';
import { renderPreview } from '../ui/preview.js';
import { buildPlan, fieldOf, cornerOf, sheetCheck } from '../../core/pipeline.js';
import { exportSvg, exportOnPaper } from '../../core/svg-export.js';
import { isPartial, partialReasons } from '../../core/drawing.js';
import { axisLimits } from '../../core/profile.js';
import { downloadText, baseName } from '../download.js';
import { JOG_STEPS } from '../../core/jog.js';

/** "A–B min" by the time estimate bounds; if equal — "A min". */
const minutesText = (t) => {
  const a = Math.ceil(t.min / 60), b = Math.ceil(t.max / 60);
  return a === b ? `${a} мин` : `${a}–${b} мин`;
};

const MANUAL_BUTTONS = [
  ['up', 'Перо вверх'], ['corner', 'К углу бумаги'], ['touch', 'Перо на касание'], ['motorsOff', 'Моторы выкл'], ['home', 'Home (G28)'],
];

const OFFSET_KEY = 'neptune-plotter.capture-offset';
const readOffset = () => {
  try { const o = JSON.parse(localStorage.getItem(OFFSET_KEY)); if (Number.isFinite(o.x) && Number.isFinite(o.y)) return o; } catch (e) { /* nothing saved */ }
  return { x: 0, y: 0 };
};

/**
 * calibrator — { capture, monitor, jog, link, subscribeLink } in plugin mode and in standalone with a feed, otherwise null: no capture buttons.
 * connection — the connection monitor (connection-monitor.js): it alone holds the 3 s polling timer;
 * the job state (/api/job) is requested right after each of its checks, there is no separate timer.
 */
export function createPrintTab({ state, store, service, transport, connection, ui = {}, calibrator = null }) {
  let timer = 0, offCycle = () => {}, unsubscribe = () => {}, plan = null, planError = '';
  let lastJobState = '', darkQuery = null, redraw = null, stopMonitor = () => {}, stopLink = () => {}, stopFirmware = () => {};

  return {
    id: 'print',
    title: 'Печать',

    mount(el) {
      const $ = {};
      const button = (key, text, onclick, cls = '') => ($[key] = h('button', { type: 'button', class: cls, onclick }, text));

      // --- left column: settings
      const settingsHost = h('div', { class: 'settings' });
      mountSettingsPanel(settingsHost, { state, store, notify: (m) => log(m), ui: { ...ui, connectionMonitor: connection } });

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

      const view = createViewport();
      view.attach($.canvas, () => draw());
      const previewCard = h('div', { class: 'card' },
        $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.travel, 'переезды')),
        $.stats, $.calibration, $.partial, $.warn,
        h('div', { class: 'row' },
          button('dlGcode', 'Скачать G-code', () => download('gcode')),
          button('dlSvg', 'Скачать SVG', () => download('svg')),
          button('dlPaper', 'SVG как на бумаге', () => download('paper'))));

      const calibrationCard = calibrator ? mountCaptureCard() : null;

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

      el.append(h('div', { class: 'columns' }, h('div', {}, settingsHost), h('div', { class: 'work-col' }, previewCard, calibrationCard, sendCard, printerCard)));

      // --- behavior
      const log = (msg) => {
        $.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
        $.log.scrollTop = $.log.scrollHeight;
      };

      function mountCaptureCard() {
        const need = ui.needs ? ui.needs('calibration') : null;
        const initial = readOffset();
        $.offX = h('input', { type: 'number', step: '0.1', value: initial.x, 'aria-label': 'Смещение пера по X, мм' });
        $.offY = h('input', { type: 'number', step: '0.1', value: initial.y, 'aria-label': 'Смещение пера по Y, мм' });
        $.fresh = h('div', { class: 'warn', role: 'status' });
        const offset = () => {
          const n = (el) => (Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : 0);
          return { x: n($.offX), y: n($.offY) };
        };
        const saveOffset = () => { try { localStorage.setItem(OFFSET_KEY, JSON.stringify(offset())); } catch (e) { /* without saving */ } };
        $.offX.addEventListener('change', saveOffset);
        $.offY.addEventListener('change', saveOffset);
        const cap = calibrator.capture;
        const act = (key, text, fn) => button(key, text, async () => {
          capBusy = true; syncCapture();
          try { const r = await fn(); log(`${text}: ${r.message}`); } finally { capBusy = false; syncCapture(); }
        });
        $.homeHint = h('div', { class: 'warn', role: 'status' });
        // Home may have been done before the page was opened (G28 is dangerous once the pen is installed): the user's word instead of G28
        $.homeDone = h('button', { type: 'button', hidden: true, onclick: () => {
          if (confirm('Принтер точно выполнил Home после включения? Если нет — координаты неверны, перо может упереться в стол.')) {
            calibrator.markHomed(); log('Home принят как выполненный (по подтверждению)'); syncCapture();
          }
        } }, 'Home уже сделан');
        $.step = h('select', { 'aria-label': 'Шаг перемещения, мм' }, JOG_STEPS.map((v) => h('option', { value: v, selected: v === 1 }, `${v} мм`)));
        const jogBtn = (axis, dir) => act(`jog${axis}${dir}`, `${axis.toUpperCase()}${dir > 0 ? '+' : '−'}`, () => calibrator.jog.move(axis, dir, Number($.step.value)));
        const jogCard = calibrator.jog ? [
          h('div', { class: 'note' }, 'Перемещение пера: положение читается перед каждым шагом, шаг не выходит за пределы профиля, а Z — ниже касания больше чем на 2 мм.'),
          h('div', { class: 'row' }, h('label', {}, 'Шаг', $.step),
            ['x', 'y', 'z'].flatMap((a) => [jogBtn(a, -1), jogBtn(a, 1)])),
        ] : [];
        return h('div', { class: 'card' },
          h('h2', {}, 'Калибровка по положению головы'),
          h('div', { class: 'note' }, 'Подведите перо кнопками перемещения ниже или вкладкой Control в OctoPrint, затем нажмите кнопку. Во время печати недоступно.'),
          need ? h('div', { class: 'note' }, `Недоступно: ${need}`) : null,
          $.homeHint, $.homeDone,
          h('div', { class: 'row' },
            h('label', {}, 'Смещение пера от угла листа, мм: X', $.offX), h('label', {}, 'Y', $.offY)),
          h('div', { class: 'row' },
            act('capCorner', 'Угол здесь', () => cap.captureCorner(offset())),
            act('capTouch', 'Касание здесь', () => cap.captureTouch())),
          h('div', { class: 'row' },
            act('okCorner', 'Угол верен', () => cap.confirm('xy')),
            act('okTouch', 'Касание верно', () => cap.confirm('z'))),
          ...jogCard,
          $.fresh);
      }

      const JOG_KEYS = calibrator && calibrator.jog ? ['x', 'y', 'z'].flatMap((a) => [`jog${a}-1`, `jog${a}1`]) : [];
      let capBusy = false; // a capture or a jog step is in progress: all buttons are disabled
      function syncCapture() {
        if (!calibrator) return;
        const base = !transport.configured() || !!(ui.needs && ui.needs('calibration'));
        const link = calibrator.link(); // the "Not homed" guard (standalone): per XY and Z parts
        const off = (blocked, ok) => capBusy || !!blocked || !ok;
        $.capCorner.disabled = off(base || calibrator.capture.unsupported, link.xy.ok);
        $.capTouch.disabled = off(base || calibrator.capture.unsupported, link.z.ok);
        $.okCorner.disabled = off(base, link.xy.ok);
        $.okTouch.disabled = off(base, link.z.ok);
        for (const k of JOG_KEYS) $[k].disabled = off(base, k.startsWith('jogz') ? link.z.ok : link.xy.ok);
        $.homeHint.textContent = link.hint;
        $.homeDone.hidden = !(calibrator.markHomed && link.homeMissing);
        $.fresh.textContent = calibrator.monitor.status().message;
      }

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
        const s = await connection.checkNow();
        log(s.status === 'ok' || s.status === 'printer-off' ? s.detail : `Связь: ${s.detail}`);
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
          emptyText: planError || 'Рисунок не загружен', view,
        });
      }

      function render() {
        const s = state.settings();
        const drawing = state.drawing();
        const fw = ui.firmware ? ui.firmware.get() : null; // the read firmware settings — only for the time estimate
        plan = null; planError = '';
        if (drawing) {
          try { plan = buildPlan(drawing, s, { firmware: fw }); } catch (e) { planError = e.message; }
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
            ` · перо ${(st.draw / 1000).toFixed(2)} м, переезды ${(st.travel / 1000).toFixed(2)} м · ≈${minutesText(st.time)}${fw ? ' (с учётом прошивки)' : ''}` +
            ` · X ${st.bbox.x0.toFixed(1)}…${st.bbox.x1.toFixed(1)}, Y ${st.bbox.y0.toFixed(1)}…${st.bbox.y1.toFixed(1)}` +
            ` · оптимизация: точек ${o.pointsBefore}→${o.pointsAfter}, линий ${o.linesBefore}→${o.linesAfter}, переезды ${(o.travelBefore / 1000).toFixed(2)}→${(o.travelAfter / 1000).toFixed(2)} м`;
        } else $.stats.textContent = '';

        const online = transport.configured();
        for (const k of ['dlGcode', 'dlSvg', 'dlPaper']) $[k].disabled = !plan;
        for (const k of ['frame', 'upload', 'print']) $[k].disabled = !plan || !online;
        for (const k of ['test', 'pause', 'cancel', ...MANUAL_BUTTONS.map(([id]) => 'm-' + id)]) $[k].disabled = !online;
        if (!online) $.job.textContent = 'Принтер не настроен: укажите адрес и API-ключ OctoPrint';
        if (!$.name.dataset.touched) $.name.value = drawing ? `${baseName(state.sourceName())}.gcode` : '';
        syncCapture();
        draw();
      }

      $.name.addEventListener('input', () => { $.name.dataset.touched = '1'; });

      let polling = false;
      // after the connection test: if OctoPrint responds, read the job, otherwise show the reason
      function onCheck(s) {
        if (s.status === 'ok' || s.status === 'printer-off') poll();
        else if (transport.configured()) { lastJobState = ''; $.job.textContent = `Нет связи: ${s.detail}`; }
      }

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

      stopMonitor = calibrator ? calibrator.monitor.subscribe(syncCapture) : () => {};
      stopLink = calibrator ? calibrator.subscribeLink(syncCapture) : () => {};
      unsubscribe = state.subscribe((e) => {
        if (e.type === 'settings' && e.section === 'connection') { render(); return; }
        if (e.type === 'drawing') $.name.dataset.touched = '';
        clearTimeout(timer);
        timer = setTimeout(render, 120);
      });
      stopFirmware = ui.firmware ? ui.firmware.subscribe(() => { clearTimeout(timer); timer = setTimeout(render, 120); }) : () => {};
      darkQuery = matchMedia('(prefers-color-scheme: dark)');
      redraw = draw;
      darkQuery.addEventListener('change', redraw);
      offCycle = connection.onCycle(onCheck);
      render();
      if (['ok', 'printer-off'].includes(connection.status().status)) poll();
    },

    unmount() {
      unsubscribe();
      stopFirmware();
      stopMonitor();
      stopLink();
      offCycle();
      if (darkQuery) darkQuery.removeEventListener('change', redraw);
      clearTimeout(timer);
    },
  };
}
