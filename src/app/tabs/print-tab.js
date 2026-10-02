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
import { createJogPad } from '../ui/jog-pad.js';
import { createSetupWizard, readCornerOffset } from '../ui/setup-wizard.js';
import { reasonText } from '../photo/layer-stack.js';
import { t, fmtNumber } from '../../i18n/index.js';

/** "A–B min" by the time estimate bounds; if equal — "A min". */
const minutesText = (time) => {
  const a = Math.ceil(time.min / 60), b = Math.ceil(time.max / 60);
  return a === b ? t('print.minutes', { a }) : t('print.minutesRange', { a, b });
};

const MANUAL_BUTTONS = ['up', 'corner', 'touch', 'motorsOff', 'home'];

/**
 * calibrator — { capture, monitor, jog, link, subscribeLink } in plugin mode and in standalone with a feed, otherwise null: no capture buttons.
 * connection — the connection monitor (connection-monitor.js): it alone holds the 3 s polling timer;
 * the job state (/api/job) is requested right after each of its checks, there is no separate timer.
 */
export function createPrintTab({ state, store, service, transport, connection, ui = {}, calibrator = null }) {
  let timer = 0, offCycle = () => {}, unsubscribe = () => {}, plan = null, planError = '';
  let lastJobState = '', darkQuery = null, redraw = null, stopMonitor = () => {}, stopLink = () => {}, stopFirmware = () => {};
  let settingsPanel = null, wizard = null, jogPad = null, detachView = () => {};
  // The current view's elements. Functions of an earlier view (an async action finishing after a remount) reach the new one.
  let $ = {};
  // View state that outlives a remount (live language switch): the log, the file name, "travel", the jog step, the preview zoom.
  const view = createViewport();
  let logText = '', nameState = { value: '', touched: '' }, showTravel = true, jogStep_ = 1, capBusy = false;

  return {
    id: 'print',
    get title() { return t('tab.print'); },

    mount(el) {
      $ = {};

      // --- the setup wizard (a dialog in this tab) and the left column: settings
      const jogStep = { get: () => jogStep_, set: (v) => { jogStep_ = v; } };
      wizard = createSetupWizard({
        host: el, state, notify: (m) => log(m), ui: { ...ui, connectionMonitor: connection }, calibrator, transport, service, jogStep,
      });
      const settingsHost = h('div', { class: 'settings' });
      settingsPanel = mountSettingsPanel(settingsHost, {
        state, store, notify: (m) => log(m),
        ui: { ...ui, connectionMonitor: connection, calibrator, cornerOffset: readCornerOffset, configured: () => transport.configured(), openWizard: (step) => wizard.open(step) },
      });

      // --- right column
      $.canvas = h('canvas', { class: 'preview', width: 900, height: 900 });
      $.travel = h('input', { type: 'checkbox', checked: showTravel, onchange: () => { showTravel = $.travel.checked; draw(); } });
      $.stats = h('div', { class: 'stats' });
      $.calibration = h('div', { class: 'note' });
      $.bed = h('div', { class: 'note', role: 'status' });
      $.partial = h('div', { class: 'warn' });
      $.warn = h('div', { class: 'warn' });
      $.name = h('input', { placeholder: 'plot.gcode', value: nameState.value });
      $.name.dataset.touched = nameState.touched;
      $.job = h('div', { class: 'job' }, t('print.jobNone'));
      $.progress = h('progress', { max: 100, value: 0 });
      $.log = h('div', { class: 'log' });
      $.log.textContent = logText;

      detachView = view.attach($.canvas, () => draw());
      const previewCard = h('div', { class: 'card' },
        $.canvas,
        h('div', { class: 'row spread' }, h('label', { class: 'check' }, $.travel, t('print.travel'))),
        $.stats, $.calibration, $.bed, $.partial, $.warn,
        h('div', { class: 'row' },
          $.dlGcode = button({ label: t('print.dl.gcode'), hint: 'print.dl.gcode.hint', onclick: () => download('gcode') }),
          $.dlSvg = button({ label: t('print.dl.svg'), hint: 'print.dl.svg.hint', onclick: () => download('svg') }),
          $.dlPaper = button({ label: t('print.dl.paper'), hint: 'print.dl.paper.hint', onclick: () => download('paper') })));

      const calibrationCard = calibrator ? mountCalibrationCard() : null;

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
        logText += `${new Date().toLocaleTimeString()}  ${msg}\n`;
        $.log.textContent = logText;
        $.log.scrollTop = $.log.scrollHeight;
      };

      function manual(id) { run(t(`print.manual.${id}`), () => service.manual(id)); }

      function mountCalibrationCard() {
        const need = ui.needs ? ui.needs('calibration') : null;
        $.fresh = h('div', { class: 'warn', role: 'status' });
        const cap = calibrator.capture;
        const act = (text, fn) => async () => {
          capBusy = true; syncCapture();
          try { const r = await fn(); log(`${text}: ${r.message}`); } finally { capBusy = false; syncCapture(); }
        };
        jogPad = calibrator.jog ? createJogPad({
          calibrator, step: jogStep, log: (m) => log(m), // log is defined below (the card is built first)
          allowed: () => transport.configured() && !(ui.needs && ui.needs('calibration')),
          onBusy: (b) => { capBusy = b; syncCapture(); },
        }) : null;
        return h('div', { class: 'card' },
          h('h2', {}, t('print.calibration.title')),
          need ? h('div', { class: 'note' }, t('print.capture.unavailable', { need })) : null,
          $.fresh,
          h('div', { class: 'row' },
            $.okCorner = button({ label: t('print.capture.cornerOk'), hint: 'print.capture.cornerOk.hint', onclick: act(t('print.capture.cornerOk'), () => cap.confirm('xy')) }),
            $.okTouch = button({ label: t('print.capture.touchOk'), hint: 'print.capture.touchOk.hint', onclick: act(t('print.capture.touchOk'), () => cap.confirm('z')) }),
            $.setup = button({ label: t('print.calibration.setup'), hint: 'print.calibration.setup.hint', class: 'primary', onclick: () => wizard.open() })),
          jogPad ? h('div', { class: 'note' }, t('print.jogNote')) : null,
          jogPad ? jogPad.element : null);
      }

      // capBusy: a confirmation or a jog step is in progress — the buttons are disabled (kept across a remount)
      function syncCapture() {
        if (!calibrator) return;
        const base = !transport.configured() || !!(ui.needs && ui.needs('calibration'));
        const link = calibrator.link(); // the "Not homed" guard (standalone): per XY and Z parts
        const off = (ok) => capBusy || base || !ok;
        $.okCorner.disabled = off(link.xy.ok);
        $.okTouch.disabled = off(link.z.ok);
        if (jogPad) jogPad.sync();
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
        if (!$.name.dataset.touched) { $.name.value = drawing ? `${baseName(state.sourceName())}.gcode` : ''; nameState = { value: $.name.value, touched: '' }; }
        syncCapture();
        draw();
      }

      $.name.addEventListener('input', () => { $.name.dataset.touched = '1'; nameState = { value: $.name.value, touched: '1' }; });

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
        if (e.type === 'drawing') { $.name.dataset.touched = ''; nameState = { ...nameState, touched: '' }; }
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

    /** Removes the view (subscriptions, timers, listeners); the log, the file name and the preview zoom stay for the next mount. */
    unmount() {
      if (settingsPanel) settingsPanel.destroy();
      settingsPanel = null;
      if (wizard) wizard.destroy();
      wizard = null;
      if (jogPad) jogPad.destroy();
      jogPad = null;
      detachView();
      detachView = () => {};
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
