// "Print" tab: settings, preview, statistics, download, sending, manual commands, job status.
import { h, button } from '../ui/dom.js';
import { mountSettingsPanel, calibrationSummary } from '../ui/settings-panel.js';
import { createViewport } from '../ui/viewport.js';
import { renderPreview } from '../ui/preview.js';
import { buildPlan, fieldOf, cornerOf, sheetCheck, fitRectMachine } from '../../core/pipeline.js';
import { bedRect, printArea } from '../../core/bed.js';
import { exportSvg, exportOnPaper } from '../../core/svg-export.js';
import { isPartial, partialReasons } from '../../core/drawing.js';
import { axisLimits } from '../../core/profile.js';
import { downloadText, baseName } from '../download.js';
import { JOG_STEPS } from '../../core/jog.js';
import { reasonText } from '../photo/layer-stack.js';
import { t, fmtNumber } from '../../i18n/index.js';

/** "A–B min" by the time estimate bounds; if equal — "A min". */
const minutesText = (time) => {
  const a = Math.ceil(time.min / 60), b = Math.ceil(time.max / 60);
  return a === b ? t('print.minutes', { a }) : t('print.minutesRange', { a, b });
};

const MANUAL_BUTTONS = ['up', 'corner', 'touch', 'motorsOff', 'home'];

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
    get title() { return t('tab.print'); },

    mount(el) {
      const $ = {};

      // --- left column: settings
      const settingsHost = h('div', { class: 'settings' });
      mountSettingsPanel(settingsHost, {
        state, store, notify: (m) => log(m),
        ui: { ...ui, connectionMonitor: connection, calibrator, cornerOffset: readOffset, configured: () => transport.configured() },
      });

      // --- right column
      $.canvas = h('canvas', { class: 'preview', width: 900, height: 900 });
      $.travel = h('input', { type: 'checkbox', checked: true, onchange: draw });
      $.stats = h('div', { class: 'stats' });
      $.calibration = h('div', { class: 'note' });
      $.bed = h('div', { class: 'note', role: 'status' });
      $.partial = h('div', { class: 'warn' });
      $.warn = h('div', { class: 'warn' });
      $.name = h('input', { placeholder: 'plot.gcode' });
      $.job = h('div', { class: 'job' }, t('print.jobNone'));
      $.progress = h('progress', { max: 100, value: 0 });
      $.log = h('div', { class: 'log' });

      const view = createViewport();
      view.attach($.canvas, () => draw());
      const previewCard = h('div', { class: 'card' },
        $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.travel, t('print.travel'))),
        $.stats, $.calibration, $.bed, $.partial, $.warn,
        h('div', { class: 'row' },
          $.dlGcode = button({ label: t('print.dl.gcode'), hint: 'print.dl.gcode.hint', onclick: () => download('gcode') }),
          $.dlSvg = button({ label: t('print.dl.svg'), hint: 'print.dl.svg.hint', onclick: () => download('svg') }),
          $.dlPaper = button({ label: t('print.dl.paper'), hint: 'print.dl.paper.hint', onclick: () => download('paper') })));

      const calibrationCard = calibrator ? mountCaptureCard() : null;

      const sendCard = h('div', { class: 'card' },
        h('h2', {}, t('print.send.title')),
        h('label', {}, t('print.fileName'), $.name),
        h('div', { class: 'row' },
          $.frame = button({ label: t('print.frame'), hint: 'print.frame.hint', onclick: () => run(t('print.log.frame'), () => service.frame(state.drawing())) }),
          $.upload = button({ label: t('print.upload'), hint: 'print.upload.hint', onclick: () => run(t('print.log.upload'), () => service.send(state.drawing(), { print: false, name: fileName() })) }),
          $.print = button({ label: t('print.print'), hint: 'print.print.hint', class: 'primary', onclick: () => run(t('print.log.drawing'), () => service.send(state.drawing(), { print: true, name: fileName() })) })));

      const printerCard = h('div', { class: 'card' },
        h('h2', {}, t('print.printer.title')),
        h('div', { class: 'row' }, $.test = button({ label: t('print.test'), hint: 'print.test.hint', onclick: testConnection }),
          $['m-up'] = button({ label: t('print.manual.up'), hint: 'print.manual.up.hint', onclick: () => manual('up') }),
          $['m-corner'] = button({ label: t('print.manual.corner'), hint: 'print.manual.corner.hint', onclick: () => manual('corner') }),
          $['m-touch'] = button({ label: t('print.manual.touch'), hint: 'print.manual.touch.hint', onclick: () => manual('touch') }),
          $['m-motorsOff'] = button({ label: t('print.manual.motorsOff'), hint: 'print.manual.motorsOff.hint', onclick: () => manual('motorsOff') }),
          $['m-home'] = button({ label: t('print.manual.home'), hint: 'print.manual.home.hint', onclick: () => manual('home') })),
        $.job, $.progress,
        h('div', { class: 'row' },
          $.pause = button({ label: t('print.pauseResume'), hint: 'print.pauseResume.hint', onclick: () => run(t('print.log.pause'), () => service.pause(!/^Paus/.test(lastJobState))) }),
          $.cancel = button({
            label: t('print.cancel'), hint: 'print.cancel.hint', class: 'danger',
            onclick: () => { if (confirm(t('print.cancelConfirm'))) run(t('print.log.cancel'), () => service.cancel()); },
          })),
        $.log);

      el.append(h('div', { class: 'columns' }, h('div', {}, settingsHost), h('div', { class: 'work-col' }, previewCard, calibrationCard, sendCard, printerCard)));

      // --- behavior
      const log = (msg) => {
        $.log.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
        $.log.scrollTop = $.log.scrollHeight;
      };

      function manual(id) { run(t(`print.manual.${id}`), () => service.manual(id)); }

      function mountCaptureCard() {
        const need = ui.needs ? ui.needs('calibration') : null;
        const initial = readOffset();
        $.offX = h('input', { type: 'number', step: '0.1', value: initial.x, 'aria-label': t('print.offX') });
        $.offY = h('input', { type: 'number', step: '0.1', value: initial.y, 'aria-label': t('print.offY') });
        $.fresh = h('div', { class: 'warn', role: 'status' });
        const offset = () => {
          const n = (el) => (Number.isFinite(parseFloat(el.value)) ? parseFloat(el.value) : 0);
          return { x: n($.offX), y: n($.offY) };
        };
        const saveOffset = () => { try { localStorage.setItem(OFFSET_KEY, JSON.stringify(offset())); } catch (e) { /* without saving */ } };
        $.offX.addEventListener('change', saveOffset);
        $.offY.addEventListener('change', saveOffset);
        const cap = calibrator.capture;
        const act = (text, fn) => async () => {
          capBusy = true; syncCapture();
          try { const r = await fn(); log(`${text}: ${r.message}`); } finally { capBusy = false; syncCapture(); }
        };
        $.homeHint = h('div', { class: 'warn', role: 'status' });
        // Home may have been done before the page was opened (G28 is dangerous once the pen is installed): the user's word instead of G28
        $.homeDone = button({
          label: t('print.homeDone'), hint: 'print.homeDone.hint', hidden: true,
          onclick: () => {
            if (confirm(t('print.homeConfirm'))) {
              calibrator.markHomed(); log(t('print.homeAccepted')); syncCapture();
            }
          },
        });
        $.step = h('select', { 'aria-label': t('print.stepLabel') }, JOG_STEPS.map((v) => h('option', { value: v, selected: v === 1 }, t('print.stepOption', { v }))));
        const jogBtn = (axis, dir) => {
          const text = `${axis.toUpperCase()}${dir > 0 ? '+' : '−'}`;
          return ($[`jog${axis}${dir}`] = button({ label: text, hint: 'print.jog.hint', onclick: act(text, () => calibrator.jog.move(axis, dir, Number($.step.value))) }));
        };
        const jogCard = calibrator.jog ? [
          h('div', { class: 'note' }, t('print.jogNote')),
          h('div', { class: 'row' }, h('label', {}, t('print.step'), $.step),
            ['x', 'y', 'z'].flatMap((a) => [jogBtn(a, -1), jogBtn(a, 1)])),
        ] : [];
        return h('div', { class: 'card' },
          h('h2', {}, t('print.capture.title')),
          h('div', { class: 'note' }, t('print.capture.note')),
          need ? h('div', { class: 'note' }, t('print.capture.unavailable', { need })) : null,
          $.homeHint, $.homeDone,
          h('div', { class: 'row' },
            h('label', {}, t('print.capture.offset'), $.offX), h('label', {}, 'Y', $.offY)),
          h('div', { class: 'row' },
            $.capCorner = button({ label: t('print.capture.corner'), hint: 'print.capture.corner.hint', onclick: act(t('print.capture.corner'), () => cap.captureCorner(offset())) }),
            $.capTouch = button({ label: t('print.capture.touch'), hint: 'print.capture.touch.hint', onclick: act(t('print.capture.touch'), () => cap.captureTouch()) })),
          h('div', { class: 'row' },
            $.okCorner = button({ label: t('print.capture.cornerOk'), hint: 'print.capture.cornerOk.hint', onclick: act(t('print.capture.cornerOk'), () => cap.confirm('xy')) }),
            $.okTouch = button({ label: t('print.capture.touchOk'), hint: 'print.capture.touchOk.hint', onclick: act(t('print.capture.touchOk'), () => cap.confirm('z')) })),
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
          log(`${label}: ${r.ok ? (r.message || t('common.ok')) : r.message}`);
        } catch (e) {
          log(`${label}: ${e.message}`);
        }
        poll();
      }

      async function testConnection() {
        const s = await connection.checkNow();
        log(s.status === 'ok' || s.status === 'printer-off' ? s.detail : t('print.link', { detail: s.detail }));
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
          limits: axisLimits(s.profile), bed: bedRect(s.profile), area: printArea(s.profile), fit: fitRectMachine(s),
          showTravel: $.travel.checked, emptyText: planError || t('print.noDrawing'), view,
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
        $.bed.textContent = printArea(s.profile).bedMeasured ? '' : t('bed.notMeasuredCheck');
        $.partial.textContent = drawing && isPartial(drawing)
          ? (partialReasons(drawing).length ? t('print.partialWith', { reasons: partialReasons(drawing).map(reasonText).join('; ') }) : t('print.partial')) : '';

        if (plan) {
          const st = plan.stats, o = plan.optimization;
          const f1 = (v) => fmtNumber(v, { minFrac: 1 }), f2 = (v) => fmtNumber(v, { minFrac: 2, maxFrac: 2 });
          $.stats.textContent = t('print.stats', {
            lines: t('svgtab.lines', { count: st.lines }), w: f1(st.size[0]), h: f1(st.size[1]), draw: f2(st.draw / 1000), travel: f2(st.travel / 1000),
            time: minutesText(st.time), fw: fw ? t('print.withFirmware') : '',
            x0: f1(st.bbox.x0), x1: f1(st.bbox.x1), y0: f1(st.bbox.y0), y1: f1(st.bbox.y1),
            pb: o.pointsBefore, pa: o.pointsAfter, lb: o.linesBefore, la: o.linesAfter, tb: f2(o.travelBefore / 1000), ta: f2(o.travelAfter / 1000),
          });
        } else $.stats.textContent = '';

        const online = transport.configured();
        for (const k of ['dlGcode', 'dlSvg', 'dlPaper']) $[k].disabled = !plan;
        for (const k of ['frame', 'upload', 'print']) $[k].disabled = !plan || !online;
        for (const k of ['test', 'pause', 'cancel', ...MANUAL_BUTTONS.map((id) => 'm-' + id)]) $[k].disabled = !online;
        if (!online) $.job.textContent = t('print.notConfigured');
        if (!$.name.dataset.touched) $.name.value = drawing ? `${baseName(state.sourceName())}.gcode` : '';
        syncCapture();
        draw();
      }

      $.name.addEventListener('input', () => { $.name.dataset.touched = '1'; });

      let polling = false;
      // after the connection test: if OctoPrint responds, read the job, otherwise show the reason
      function onCheck(s) {
        if (s.status === 'ok' || s.status === 'printer-off') poll();
        else if (transport.configured()) { lastJobState = ''; $.job.textContent = t('print.noConnection', { detail: s.detail }); }
      }

      async function poll() {
        if (polling || !transport.configured()) return;
        polling = true;
        try {
          const j = await transport.job();
          lastJobState = j.state || '';
          const left = j.timeLeft != null ? t('print.timeLeft', { min: Math.ceil(j.timeLeft / 60) }) : '';
          $.job.textContent = `${j.state}${j.file ? ` · ${j.file}` : ''}${j.progress != null ? ` · ${fmtNumber(j.progress, { minFrac: 1 })}%` : ''}${left}`;
          $.progress.value = j.progress || 0;
        } catch (e) {
          lastJobState = '';
          $.job.textContent = t('print.noConnection', { detail: e.message });
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
