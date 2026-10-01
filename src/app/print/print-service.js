// Print scenarios on top of Transport: checks, confirmations, cancel with pen lift, manual commands.
// Dependencies are injected; the service knows neither the DOM nor a concrete transport.
import { buildPlan } from '../../core/pipeline.js';
import { liftLines, cornerLines, touchLines, homeLines, motorsOffLines, frameLines } from '../../core/gcode.js';
import { absoluteZ } from '../../core/profile.js';
import { TransportError } from '../../transport/transport.js';
import { t } from '../../i18n/index.js';

const CANCEL_TIMEOUT_MS = 30000;
const CANCEL_POLL_MS = 1000;

/** 'ready' | 'wait' | 'other-job' | 'stop' */
export function classifyState(state) {
  const s = String(state || '');
  if (s === 'Operational') return 'ready';
  if (s === 'Cancelling') return 'wait';
  if (/^(Printing|Paused|Pausing|Resuming|Starting)/.test(s)) return 'other-job';
  return 'stop';
}

function stopMessage(kind, state) {
  if (kind === 'other-job') return t('print.stop.otherJob');
  const s = String(state || '');
  const what = /^(Error|Closed with error|Offline after error)/.test(s) ? t('print.stop.error')
    : /^(Offline|Closed)/.test(s) ? t('print.stop.offline') : t('print.stop.state', { state: s || t('print.stop.unknown') });
  return t('print.stop.printer', { what });
}

export function createPrintService({
  transport, getSettings, confirm, preflight = [], beforePlan = [],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(),
}) {
  const fail = (message) => ({ ok: false, message });
  const done = (message = '') => ({ ok: true, message });

  // Expected transport errors become a message, the rest are rethrown.
  async function guarded(fn) {
    try { return await fn(); } catch (e) {
      if (e instanceof TransportError) return fail(e.message);
      throw e;
    }
  }

  async function send(drawing, { print = false, name = 'plot.gcode' } = {}) {
    // Preparation (refreshing the calibration from the server) runs before the settings snapshot: the plan and the checks see the same snapshot.
    for (const prepare of beforePlan) await prepare();
    const settings = getSettings();
    let plan;
    try { plan = buildPlan(drawing, settings); } catch (e) { return fail(e.message); }

    const ctx = { drawing, plan, settings };
    const results = [];
    for (const check of preflight) results.push(await check(ctx));
    const blocked = results.filter((r) => r.level === 'block');
    if (blocked.length) return fail(blocked.map((r) => r.message).join('\n'));

    const notes = results.filter((r) => r.level === 'confirm').map((r) => r.message);
    if (print) {
      const { profile, calibration } = settings;
      notes.push(profile.home
        ? t('print.confirm.homeIn')
        : t('print.confirm.homeNot'));
      notes.push(t('print.confirm.paper', { x: calibration.cornerX, y: calibration.cornerY }));
    } else if (notes.length) notes.push(t('print.confirm.uploadAnyway'));
    if (notes.length && !(await confirm(notes.join('\n')))) return fail(t('print.cancelled'));

    return guarded(async () => {
      await transport.upload(name, plan.gcode, { select: true, print });
      return done(t(print ? 'print.drawing' : 'print.uploaded', { name }));
    });
  }

  async function cancel() {
    return guarded(async () => {
      await transport.cancel();
      const deadline = now() + CANCEL_TIMEOUT_MS;
      for (;;) {
        const { state } = await transport.job();
        const kind = classifyState(state);
        if (kind === 'ready') break;
        if (kind !== 'wait') return fail(stopMessage(kind, state));
        if (now() >= deadline) return fail(t('print.cancelTimeout'));
        await sleep(CANCEL_POLL_MS);
      }
      // the state may have changed between the poll and the command
      const { state } = await transport.job();
      const kind = classifyState(state);
      if (kind !== 'ready') return fail(stopMessage(kind, state));
      const { profile, calibration } = getSettings();
      await transport.command(liftLines(profile, calibration));
      return done(t('print.cancelled.lifted', { z: absoluteZ(profile, calibration).start }));
    });
  }

  const pause = (on) => guarded(async () => { await transport.pause(on); return done(t(on ? 'print.paused' : 'print.resumed')); });

  const MANUAL = {
    up: { lines: liftLines },
    corner: { lines: cornerLines },
    touch: {
      lines: touchLines,
      ask: (s) => t('print.ask.touch', { z: absoluteZ(s.profile, s.calibration).touch }),
    },
    motorsOff: {
      lines: motorsOffLines,
      ask: () => t('print.ask.motorsOff'),
    },
    home: {
      lines: homeLines,
      ask: () => t('print.ask.home'),
    },
  };

  async function manual(action) {
    const entry = MANUAL[action];
    if (!entry) return fail(`unknown command: ${action}`);
    const settings = getSettings();
    if (entry.ask && !(await confirm(entry.ask(settings)))) return fail(t('print.cancelled'));
    return guarded(async () => {
      await transport.command(entry.lines(settings.profile, settings.calibration));
      return done(t(`print.manual.${action}`));
    });
  }

  // Trace the drawing outline with the pen raised, printing does not start.
  async function frame(drawing) {
    const settings = getSettings();
    let plan;
    try { plan = buildPlan(drawing, settings); } catch (e) { return fail(e.message); }
    return guarded(async () => {
      await transport.command(frameLines(plan.stats.bbox, settings.profile, settings.calibration));
      return done(t('print.frameSent'));
    });
  }

  return { send, cancel, pause, manual, frame };
}
