// Print scenarios on top of Transport: checks, confirmations, cancel with pen lift, manual commands.
// Dependencies are injected; the service knows neither the DOM nor a concrete transport.
import { buildPlan } from '../../core/pipeline.js';
import { liftLines, cornerLines, touchLines, homeLines, motorsOffLines, frameLines } from '../../core/gcode.js';
import { absoluteZ } from '../../core/profile.js';
import { TransportError } from '../../transport/transport.js';

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
  if (kind === 'other-job') return 'началось другое задание — перо не поднято';
  const s = String(state || '');
  const what = /^(Error|Closed with error|Offline after error)/.test(s) ? 'ошибка'
    : /^(Offline|Closed)/.test(s) ? 'отключён' : `состояние «${s || 'неизвестно'}»`;
  return `принтер: ${what} — перо не поднято`;
}

export function createPrintService({
  transport, getSettings, confirm, preflight = [],
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
        ? 'В файле есть G28 — ручка должна быть поднята.'
        : 'G28 в файле нет — принтер должен держать координаты (голова не двигается рукой).');
      notes.push(`Бумага в углу X${calibration.cornerX} Y${calibration.cornerY}, перо на метке. Рисовать?`);
    } else if (notes.length) notes.push('Всё равно загрузить?');
    if (notes.length && !(await confirm(notes.join('\n')))) return fail('отменено');

    return guarded(async () => {
      await transport.upload(name, plan.gcode, { select: true, print });
      return done(print ? `Рисование ${name}` : `Загружено ${name}`);
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
        if (now() >= deadline) return fail('отмена не завершилась — перо не поднято');
        await sleep(CANCEL_POLL_MS);
      }
      // the state may have changed between the poll and the command
      const { state } = await transport.job();
      const kind = classifyState(state);
      if (kind !== 'ready') return fail(stopMessage(kind, state));
      const { profile, calibration } = getSettings();
      await transport.command(liftLines(profile, calibration));
      return done(`Задание отменено, перо поднято на Z${absoluteZ(profile, calibration).start}`);
    });
  }

  const pause = (on) => guarded(async () => { await transport.pause(on); return done(on ? 'Пауза' : 'Продолжено'); });

  const MANUAL = {
    up: { label: 'Перо вверх', lines: liftLines },
    corner: { label: 'К углу бумаги', lines: cornerLines },
    touch: {
      label: 'Перо на касание', lines: touchLines,
      ask: (s) => `Опустить перо до касания бумаги, Z${absoluteZ(s.profile, s.calibration).touch}?`,
    },
    motorsOff: {
      label: 'Моторы выкл', lines: motorsOffLines,
      ask: () => 'Отключить моторы? Координаты сбросятся, перед рисованием нужен Home.',
    },
    home: {
      label: 'Home (G28)', lines: homeLines,
      ask: () => 'Ручка поднята выше сопла? При G28 голова опускается до стола: перо ниже сопла на 8 мм.',
    },
  };

  async function manual(action) {
    const entry = MANUAL[action];
    if (!entry) return fail(`неизвестная команда: ${action}`);
    const settings = getSettings();
    if (entry.ask && !(await confirm(entry.ask(settings)))) return fail('отменено');
    return guarded(async () => {
      await transport.command(entry.lines(settings.profile, settings.calibration));
      return done(entry.label);
    });
  }

  // Trace the drawing outline with the pen raised, printing does not start.
  async function frame(drawing) {
    const settings = getSettings();
    let plan;
    try { plan = buildPlan(drawing, settings); } catch (e) { return fail(e.message); }
    return guarded(async () => {
      await transport.command(frameLines(plan.stats.bbox, settings.profile, settings.calibration));
      return done('Обводка рамки отправлена');
    });
  }

  return { send, cancel, pause, manual, frame };
}
