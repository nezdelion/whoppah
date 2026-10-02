// Pen area editor: "pen offset from the nozzle" (numbers or the pen at a bed corner) or "extreme pen positions" (two points).
// Shows "pen reaches W×H", a map (bed, limits, area, sheet) and "Go to" the area corners. Used by the wizard and the Printer section.
import { h, button } from './dom.js';
import { createPoint } from './point.js';
import { renderPreview } from './preview.js';
import { areaStatus, bedPoints, bedRect, bedHint, bedNominal, bedFromPenOffset, BED_CORNERS, printArea } from '../../core/bed.js';
import { axisLimits } from '../../core/profile.js';
import { fieldOf, cornerOf } from '../../core/pipeline.js';
import { t, fmtNumber } from '../../i18n/index.js';

let seq = 0;
const fmt1 = (v) => fmtNumber(Math.round(v * 10) / 10); // 204 × 230, 204,5 × 230

/**
 * @param state      settings state (profile written through state.patch / state.setBedPoint)
 * @param calibrator { capture, jog, link(), subscribeLink, monitor } or null (no capture, no "Go to")
 * @param need       () => the missing machine profile permission text or null
 * @param online     () => the printer connection is configured
 * @param control    () => the user may control the printer (capture and "Go to" follow it, as the jog does)
 * @param log        (text) => void
 * @returns {{ element, refresh(), destroy() }}
 */
export function createAreaEditor({ state, calibrator = null, need = () => null, online = () => true, control = () => true, log = () => {} }) {
  const name = `area-mode-${++seq}`;
  const cal = calibrator;
  const goTo = cal && cal.jog ? (v) => cal.jog.goTo(v) : null;
  const off = [];
  let busy = false;

  const profile = () => state.get('profile');
  const report = (r) => { if (r && r.message) { status.textContent = r.message; log(r.message); } };
  async function run(fn) {
    busy = true; sync();
    try { report(await fn()); } catch (e) { report({ ok: false, message: e.message }); } finally { busy = false; sync(); }
  }

  // --- mode switch
  const radio = (mode) => h('input', { type: 'radio', name, value: mode, onchange: () => onMode(mode) });
  const rOffset = radio('offset'), rMeasured = radio('measured');
  // the editor shown: the user's choice while editing (a first measured point makes the data look like 'offset'), else the data
  let chosen = null, chosenFor = null; // chosenFor: the active profile id the choice was made for (a profile switch resets it)
  function onMode(mode) { chosen = mode; chosenFor = state.activeProfileId(); refresh(); }

  // --- offset editor
  const dx = h('input', { type: 'number', step: '0.1' }), dy = h('input', { type: 'number', step: '0.1' });
  const onOffset = () => {
    const x = parseFloat(dx.value), y = parseFloat(dy.value);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    run(() => state.patch('profile', bedFromPenOffset({ x, y }, bedNominal(profile())).changes));
  };
  dx.addEventListener('change', onOffset);
  dy.addEventListener('change', onOffset);
  const cornerSel = h('select', { 'aria-label': t('area.cornerLead') }, BED_CORNERS.map((c) => h('option', { value: c, selected: c === 'ur' }, t(`area.corner.${c}`))));
  const penHere = cal ? button({ label: t('area.penHere'), hint: 'area.penHere.hint', onclick: () => run(() => cal.capture.captureBedFromOffsetCorner(cornerSel.value)) }) : null;
  const offsetBox = h('div', { class: 'area-offset' },
    h('div', { class: 'grid' }, h('label', {}, t('area.offsetX'), dx), h('label', {}, t('area.offsetY'), dy)),
    h('div', { class: 'note' }, t('area.offsetNote')),
    cal ? h('div', { class: 'note' }, t('area.cornerLead')) : null,
    cal ? h('div', { class: 'row' }, h('label', {}, '', cornerSel), penHere) : null);

  // --- measured editor: two points
  const point = (which) => createPoint({
    label: t(which === 'll' ? 'area.pointNear' : 'area.pointFar'), log,
    onSave: (v) => state.setBedPoint(which, v),
    onCapture: cal ? () => cal.capture.captureBedCorner(which) : null,
    onGoTo: goTo,
  });
  const ll = point('ll'), ur = point('ur');
  const measuredBox = h('div', { class: 'area-measured' }, h('div', { class: 'note' }, t('area.measuredLead')), ll.element, ur.element);

  // --- result: reach, warnings, map, go-to corners
  const reach = h('div', { class: 'note area-reach', role: 'status' });
  const warn = h('div', { class: 'warn', role: 'status' });
  const status = h('div', { class: 'note', role: 'status' });
  const canvas = h('canvas', { class: 'mini-map', width: 240, height: 240, 'aria-label': t('area.mapLabel') });
  const goNear = goTo ? button({ label: t('area.goNear'), hint: 'area.goNear.hint', onclick: () => run(() => { const a = printArea(profile()); return goTo({ x: a.x0, y: a.y0 }); }) }) : null;
  const goFar = goTo ? button({ label: t('area.goFar'), hint: 'area.goFar.hint', onclick: () => run(() => { const a = printArea(profile()); return goTo({ x: a.x1, y: a.y1 }); }) }) : null;

  const element = h('div', { class: 'area-editor' },
    h('div', { class: 'note' }, t('coords.note')),
    h('div', { class: 'row area-modes' },
      h('label', { class: 'check' }, rOffset, t('area.mode.offset')),
      h('label', { class: 'check' }, rMeasured, t('area.mode.measured'))),
    h('div', { class: 'area-body' }, h('div', {}, offsetBox, measuredBox), canvas),
    reach, warn, status,
    goTo ? h('div', { class: 'row' }, goNear, goFar) : null);

  function drawMap() {
    const s = state.settings();
    try {
      renderPreview(canvas, {
        machine: null, field: fieldOf(s.job), corner: cornerOf(s.calibration), limits: axisLimits(s.profile),
        bed: bedRect(s.profile), area: printArea(s.profile), fit: null, showTravel: false, emptyText: '', view: null,
      });
    } catch (e) { /* no canvas (tests) */ }
  }

  function refresh() {
    const p = profile();
    const a = areaStatus(p);
    if (chosen && chosenFor !== state.activeProfileId()) chosen = null;
    const mode = chosen || (a.mode === 'none' ? 'offset' : a.mode);
    rOffset.checked = mode === 'offset';
    rMeasured.checked = mode === 'measured';
    offsetBox.hidden = mode !== 'offset';
    measuredBox.hidden = mode !== 'measured';
    const active = globalThis.document && document.activeElement;
    const o = a.offset || { x: 0, y: 0 };
    if (active !== dx) dx.value = a.mode === 'none' ? '' : String(o.x);
    if (active !== dy) dy.value = a.mode === 'none' ? '' : String(o.y);
    const bp = bedPoints(p);
    ll.set(bp.ll, bp.ll.nominal ? t('bed.nominal') : '');
    ur.set(bp.ur, bp.ur.nominal ? t('bed.nominal') : '');
    reach.textContent = a.mode === 'none' ? '' : t('area.reach', { w: fmt1(a.w), h: fmt1(a.h) });
    const hints = [];
    if (a.mode === 'none') hints.push(t('area.notSet'));
    else if (a.empty) hints.push(t('area.empty'));
    hints.push(...bedHint(bedRect(p), bedNominal(p), undefined, { urNominal: p.bedUrNominal }));
    warn.textContent = hints.join('\n');
    drawMap();
    sync();
  }

  function sync() {
    const n = need();
    const link = cal ? cal.link() : null;
    const can = !n && !busy;
    // "Go to" is a jog action: the control permission, not the profile one; capture writes the profile — both
    const move = !!goTo && online() && !busy && control() && link.xy.ok && link.z.ok;
    const read = !!cal && online() && can && control() && link.xy.ok && !cal.capture.unsupported;
    rOffset.disabled = rMeasured.disabled = dx.disabled = dy.disabled = cornerSel.disabled = !can;
    if (penHere) penHere.disabled = !read;
    for (const pt of [ll, ur]) pt.setEnabled({ edit: can, capture: read, move });
    if (goNear) goNear.disabled = goFar.disabled = !move;
  }

  refresh();
  off.push(state.subscribe((e) => { if (e.type === 'settings') refresh(); }));
  if (cal) off.push(cal.subscribeLink(sync), cal.monitor.subscribe(sync));
  return { element, refresh, sync, destroy() { for (const fn of off.splice(0)) fn(); } };
}
