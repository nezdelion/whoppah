// The printer connection feed state next to the connection indicator ("Connection", standalone only):
// a dot and state label, the reason, a button to read the firmware limits (M211) and a warning about the profile limits.
import { h, button } from './dom.js';
import { FEED_LABELS } from '../../transport/octoprint-feed.js';
import { createLimitsMemo } from './feed-limits.js';
import { firmwareAccelSuggestion, firmwareWarnings } from '../../core/firmware-settings.js';
import { limitsWarnings, limitsWarningText } from '../../core/marlin-replies.js';
import { t } from '../../i18n/index.js';

// feed states → data-status values from app.css (--conn-*)
const DOT = { off: 'unconfigured', connecting: 'checking', live: 'ok', forbidden: 'auth', unavailable: 'error' };
const needsFeed = () => t('feedind.needsFeed');

const axisRange = (l, a) => `${a.toUpperCase()} ${l.min[a]}…${l.max[a]}`;

const kv = (o, unit = '') => (o ? `X ${o.x}, Y ${o.y}, Z ${o.z}${unit}` : null);

/** Lines of the firmware settings (M503) summary for display; what is absent from the response is skipped. */
export function firmwareSummary(fw) {
  const rows = [
    fw.maxFeed && t('feedind.maxFeed', { value: kv(fw.maxFeed) }),
    fw.maxAccel && t('feedind.maxAccel', { value: kv(fw.maxAccel) }),
    fw.accel && t('feedind.accel', { print: fw.accel.print ?? '—', travel: fw.accel.travel ?? '—' }),
    fw.jerk && t('feedind.jerk', { value: kv(fw.jerk) }),
    fw.meshFade !== null && (fw.meshFade > 0 ? t('feedind.meshFade', { value: fw.meshFade }) : t('feedind.meshFadeOff')),
  ].filter(Boolean);
  return `${t('feedind.fwHeader')}\n${rows.join('\n')}`;
}

/**
 * @param feed        PrinterFeed
 * @param getProfile  () => machine profile (limits limX0…limY1, feeds, accelerations)
 * @param getCalibration () => calibration (touch Z)
 * @param firmware    { get(), read(), subscribe(fn) } — firmware settings memory (feed-firmware.js); without it there is no button
 * @param limits      the M211 limits memory (feed-limits.js); passed from outside so that a read result outlives a rebuilt indicator
 * @param patchProfile (changes) => apply values to the profile; confirm (text) => boolean
 * @param onProfile   (fn) => unsubscribe — the profile changed
 * @returns { element, destroy }
 */
export function createFeedIndicator(feed, {
  getProfile, getCalibration = () => null, onProfile, firmware = null, limits: memo = createLimitsMemo(feed), patchProfile = () => {}, confirm = () => false,
}) {
  let message = '', busy = false;
  const dot = h('span', { class: 'conn-dot', 'aria-hidden': 'true' });
  const label = h('span', { class: 'conn-label' });
  const badge = h('span', { class: 'conn conn-full' }, dot, label);
  const detail = h('div', { class: 'conn-detail' });
  const info = h('div', { class: 'conn-detail' });
  const warn = h('div', { class: 'warn', role: 'status' });
  const limitsBtn = button({ label: t('feedind.readLimits'), hint: 'feedind.readLimits.hint', onclick: readLimits });
  const fwButton = button({ label: t('feedind.readFirmware'), hint: 'feedind.readFirmware.hint', onclick: readFirmware });
  const fwApply = button({ label: t('feedind.applyAccel'), hint: 'feedind.applyAccel.hint', onclick: applyAccel });
  const fwInfo = h('div', { class: 'conn-detail fw-info' });
  const fwWarn = h('div', { class: 'warn', role: 'status' });
  const element = h('div', { class: 'conn-block feed-block', role: 'status' },
    h('div', { class: 'conn-detail' }, t('feedind.title')), badge, detail,
    h('div', { class: 'row' }, limitsBtn, ...(firmware ? [fwButton, fwApply] : [])), info, warn, ...(firmware ? [fwInfo, fwWarn] : []));
  let fwMessage = '';

  async function readFirmware() {
    busy = true; fwMessage = t('feedind.readingFirmware'); render();
    try {
      fwMessage = await firmware.read() ? '' : t('feedind.reconnectedFirmware');
    } catch (e) {
      fwMessage = t('feedind.readFirmwareFailed', { message: e.message });
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
    const rows = keys.map((k) => t('feedind.accelRow', { name: t(`schema.profile.${k}`), from: p[k], to: sug[k] }));
    if (confirm(t('feedind.applyConfirm', { rows: rows.join('\n') }))) patchProfile(sug);
  }

  async function readLimits() {
    busy = true; message = t('feedind.readingLimits'); render();
    try {
      message = await memo.read() ? '' : t('feedind.reconnectedLimits');
    } catch (e) {
      message = t('feedind.readLimitsFailed', { message: e.message });
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
    element.setAttribute('aria-label', t('feedind.aria', { state: FEED_LABELS[s], detail: feed.detail() }));
    limitsBtn.disabled = s !== 'live' || busy;
    limitsBtn.button.title = s === 'live' ? t('feedind.readLimits.hint') : needsFeed();
    if (!limits) info.textContent = message;
    else info.textContent = t(limits.enabled ? 'feedind.limits' : 'feedind.limitsOff', { x: axisRange(limits, 'x'), y: axisRange(limits, 'y'), z: axisRange(limits, 'z') });
    warn.textContent = limits ? limitsWarningText(limitsWarnings(getProfile(), limits)) : '';
    warn.hidden = !warn.textContent;
    if (firmware) {
      const fw = firmware.get(); // a stale result (drop, reconnect, address change) is reset
      fwButton.disabled = s !== 'live' || busy;
      fwButton.button.title = s === 'live' ? t('feedind.readFirmware.hint') : needsFeed();
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
