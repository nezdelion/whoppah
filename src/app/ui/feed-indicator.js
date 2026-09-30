// The printer connection feed state next to the connection indicator ("Connection", standalone only):
// a dot and state label, the reason, a button to read the firmware limits (M211) and a warning about the profile limits.
import { h } from './dom.js';
import { FEED_LABELS } from '../../transport/octoprint-feed.js';
import { createLimitsMemo } from './feed-limits.js';
import { firmwareAccelSuggestion, firmwareWarnings } from '../../core/firmware-settings.js';
import { limitsWarnings, limitsWarningText } from '../../core/marlin-replies.js';

// feed states → data-status values from app.css (--conn-*)
const DOT = { off: 'unconfigured', connecting: 'checking', live: 'ok', forbidden: 'auth', unavailable: 'error' };
const NEEDS_FEED = 'нужен поток связи с принтером (состояние «на связи»)';

const axisRange = (l, a) => `${a.toUpperCase()} ${l.min[a]}…${l.max[a]}`;

const kv = (o, unit = '') => (o ? `X ${o.x}, Y ${o.y}, Z ${o.z}${unit}` : null);

/** Lines of the firmware settings (M503) summary for display; what is absent from the response is skipped. */
export function firmwareSummary(fw) {
  const rows = [
    fw.maxFeed && `макс. подача (M203): ${kv(fw.maxFeed)} мм/с`,
    fw.maxAccel && `макс. ускорение (M201): ${kv(fw.maxAccel)} мм/с²`,
    fw.accel && `ускорение (M204): печать ${fw.accel.print ?? '—'}, переезд ${fw.accel.travel ?? '—'} мм/с²`,
    fw.jerk && `рывок (M205): ${kv(fw.jerk)} мм/с`,
    fw.meshFade !== null && `затухание сетки (M420 Z): ${fw.meshFade > 0 ? `${fw.meshFade} мм` : 'выключено'}`,
  ].filter(Boolean);
  return `Настройки прошивки:\n${rows.join('\n')}`;
}

/**
 * @param feed        PrinterFeed
 * @param getProfile  () => machine profile (limits limX0…limY1, feeds, accelerations)
 * @param getCalibration () => calibration (touch Z)
 * @param firmware    { get(), read(), subscribe(fn) } — firmware settings memory (feed-firmware.js); without it there is no button
 * @param patchProfile (changes) => apply values to the profile; confirm (text) => boolean
 * @param onProfile   (fn) => unsubscribe — the profile changed
 * @returns { element, destroy }
 */
export function createFeedIndicator(feed, {
  getProfile, getCalibration = () => null, onProfile, firmware = null, patchProfile = () => {}, confirm = () => false,
}) {
  const memo = createLimitsMemo(feed);
  let message = '', busy = false;
  const dot = h('span', { class: 'conn-dot', 'aria-hidden': 'true' });
  const label = h('span', { class: 'conn-label' });
  const badge = h('span', { class: 'conn conn-full' }, dot, label);
  const detail = h('div', { class: 'conn-detail' });
  const info = h('div', { class: 'conn-detail' });
  const warn = h('div', { class: 'warn', role: 'status' });
  const button = h('button', { type: 'button', onclick: readLimits }, 'Прочитать границы прошивки');
  const fwButton = h('button', { type: 'button', onclick: readFirmware }, 'Прочитать настройки прошивки');
  const fwApply = h('button', { type: 'button', onclick: applyAccel }, 'Заполнить ускорения профиля…');
  const fwInfo = h('div', { class: 'conn-detail fw-info' });
  const fwWarn = h('div', { class: 'warn', role: 'status' });
  const element = h('div', { class: 'conn-block feed-block', role: 'status' },
    h('div', { class: 'conn-detail' }, 'Поток связи с принтером'), badge, detail,
    h('div', { class: 'row' }, button, ...(firmware ? [fwButton, fwApply] : [])), info, warn, ...(firmware ? [fwInfo, fwWarn] : []));
  let fwMessage = '';

  async function readFirmware() {
    busy = true; fwMessage = 'читаю настройки прошивки (M503)…'; render();
    try {
      fwMessage = await firmware.read() ? '' : 'Поток переподключился во время чтения — прочитайте настройки снова';
    } catch (e) {
      fwMessage = `Не удалось прочитать настройки прошивки: ${e.message}`;
    }
    busy = false;
    render();
  }

  // values are proposed, not written silently: show "was → will be" and apply on confirmation
  function applyAccel() {
    const sug = firmwareAccelSuggestion(firmware.get());
    const keys = Object.keys(sug);
    if (!keys.length) return;
    const p = getProfile();
    const names = { accelXY: 'Ускорение XY', accelZ: 'Ускорение Z' };
    const rows = keys.map((k) => `${names[k]}: ${p[k]} → ${sug[k]} мм/с²`);
    if (confirm(`Заполнить профиль по настройкам прошивки?\n${rows.join('\n')}\n(ход без подачи материала идёт с ускорением переезда M204 T, но не выше M201 по оси)`)) patchProfile(sug);
  }

  async function readLimits() {
    busy = true; message = 'читаю границы прошивки (M211)…'; render();
    try {
      message = await memo.read() ? '' : 'Поток переподключился во время чтения — прочитайте границы снова';
    } catch (e) {
      message = `Не удалось прочитать границы: ${e.message}`;
    }
    busy = false;
    render();
  }

  function render() {
    const s = feed.state();
    const limits = memo.get(); // a stale result (drop, reconnect, address change) is reset
    badge.dataset.status = DOT[s];
    label.textContent = FEED_LABELS[s];
    detail.textContent = feed.detail();
    element.setAttribute('aria-label', `Поток связи с принтером: ${FEED_LABELS[s]}. ${feed.detail()}`);
    button.disabled = s !== 'live' || busy;
    button.title = s === 'live' ? '' : NEEDS_FEED;
    if (!limits) info.textContent = message;
    else info.textContent = `Границы прошивки: ${limits.enabled ? '' : 'выключены; '}${axisRange(limits, 'x')}, ${axisRange(limits, 'y')}, ${axisRange(limits, 'z')}`;
    warn.textContent = limits ? limitsWarningText(limitsWarnings(getProfile(), limits)) : '';
    warn.hidden = !warn.textContent;
    if (firmware) {
      const fw = firmware.get(); // a stale result (drop, reconnect, address change) is reset
      fwButton.disabled = s !== 'live' || busy;
      fwButton.title = s === 'live' ? '' : NEEDS_FEED;
      fwApply.disabled = !fw || !Object.keys(firmwareAccelSuggestion(fw)).length;
      fwInfo.textContent = fw ? firmwareSummary(fw) : fwMessage;
      fwWarn.textContent = fw ? firmwareWarnings(getProfile(), getCalibration(), fw).map((w) => w.text).join('\n') : '';
      fwWarn.hidden = !fwWarn.textContent;
    }
  }
  render();
  const off = [feed.onChange(render), onProfile(render), ...(firmware ? [firmware.subscribe(render)] : [])];
  return { element, destroy: () => off.forEach((f) => f()) };
}
