// Setup UI components on a fake DOM: folded sections, the jog pad, the pen area editor, the readiness card and the setup wizard.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom } from './helpers/fake-dom.js';
import { createState } from '../src/app/state.js';
import { MemoryStore } from '../src/storage/settings-store.js';
import { createCalibrationCapture } from '../src/app/calibration/capture.js';
import { bedFromPenOffset } from '../src/core/bed.js';
import { fakeServer } from './helpers/fake-position.js';
import { t } from '../src/i18n/index.js';
import './helpers/ru.js';

let h, fold, FOLD_KEY, createJogPad, createAreaEditor, createReadinessCard, createSetupWizard, OFFSET_KEY;
const savedGlobals = {};
before(async () => {
  installFakeDom();
  for (const k of ['localStorage', 'confirm']) savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  ({ h } = await import('../src/app/ui/dom.js'));
  ({ fold, FOLD_KEY } = await import('../src/app/ui/collapsible.js'));
  ({ createJogPad } = await import('../src/app/ui/jog-pad.js'));
  ({ createAreaEditor } = await import('../src/app/ui/area-editor.js'));
  ({ createReadinessCard } = await import('../src/app/ui/readiness-card.js'));
  ({ createSetupWizard, OFFSET_KEY } = await import('../src/app/ui/setup-wizard.js'));
});
const restoreGlobals = () => {
  for (const [k, d] of Object.entries(savedGlobals)) {
    if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
  }
};
afterEach(restoreGlobals);
after(restoreGlobals);

const setGlobal = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
const memStorage = (init = {}) => {
  const data = { ...init };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
};
const brokenStorage = () => ({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } });

const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const all = (root, tag) => root.findAll((e) => e.tagName === tag);
const btn = (root, text) => all(root, 'BUTTON').find((b) => b.textContent === text);
const byLabel = (root, label) => root.findAll((e) => e.getAttribute('aria-label') === label)[0];
const inputs = (root) => all(root, 'INPUT');
const change = (el, value) => { el.value = String(value); el.dispatch('change'); };

const OK_LINK = { xy: { ok: true, message: '' }, z: { ok: true, message: '' }, hint: '', homeMissing: false };
const NO_HOME = { xy: { ok: false, message: 'Home не выполнен' }, z: { ok: false, message: 'Home не выполнен' }, hint: 'Home не выполнен: сделайте Home', homeMissing: true };
const NEED_PROFILE = 'нужно право «изменение профиля машины»';
const NEED_CONTROL = 'нужно право «управление принтером»';

function subs() {
  const set = new Set();
  return { add: (fn) => { set.add(fn); return () => set.delete(fn); }, emit: (...a) => { for (const fn of [...set]) fn(...a); }, get size() { return set.size; } };
}

/** The calibrator of the app: the real capture over a fake server, a fake jog, Home guard and freshness monitor. */
function fakeCalibrator({ state, server, link = OK_LINK, profileNeed = () => null }) {
  const linkSubs = subs(), monSubs = subs();
  const monitor = {
    st: { known: true, xy: true, z: true, message: '' },
    status: () => monitor.st,
    subscribe: monSubs.add,
    refresh: async () => {},
    set(st) { monitor.st = { ...monitor.st, ...st }; monSubs.emit(monitor.st); },
  };
  const jog = {
    moves: [], gone: [], gate: null,
    async move(axis, dir, step) { jog.moves.push([axis, dir, step]); if (jog.gate) await jog.gate; return { ok: true, message: 'готово' }; },
    async goTo(v) { jog.gone.push(v); return { ok: true, message: '' }; },
    homes: 0,
    async home() { jog.homes++; return { ok: true, message: 'G28 отправлен: парковка' }; },
  };
  const cal = {
    linkValue: link, homed: 0, linkSubs, monSubs,
    link: () => cal.linkValue,
    subscribeLink: linkSubs.add,
    setLink(v) { cal.linkValue = v; linkSubs.emit(); },
    markHomed: () => { cal.homed++; cal.setLink(OK_LINK); },
    monitor, jog,
    capture: state ? createCalibrationCapture({ state, positionSource: server.source, monitor, profileNeed }) : { unsupported: false },
  };
  return cal;
}

async function app({ head = { x: 0, y: 0, z: 20 }, link, profileNeed } = {}) {
  const server = fakeServer({ head });
  const state = createState({ store: new MemoryStore() });
  await state.load();
  const cal = fakeCalibrator({ state, server, link, profileNeed });
  return { server, state, cal, profile: () => state.get('profile'), bed: () => { const p = state.get('profile'); return [p.bedX0, p.bedY0, p.bedX1, p.bedY1, p.bedUrNominal]; } };
}

// --- folded sections

test('fold: closed by default, the toggle is remembered per id and wins over the default', () => {
  const storage = memStorage();
  setGlobal('localStorage', storage);
  const a = fold({ id: 'printer', title: 'Принтер', note: 'меняется редко' }, 'тело');
  assert.equal(a.tagName, 'DETAILS');
  assert.equal(a.open, false);
  assert.equal(a.children[0].tagName, 'SUMMARY');
  assert.equal(a.children[0].textContent, 'Принтер');
  assert.match(a.textContent, /меняется редко.*тело/);
  a.open = true;
  a.dispatch('toggle');
  assert.equal(storage.data[FOLD_KEY('printer')], '1');
  assert.equal(fold({ id: 'printer', title: 'Принтер' }).open, true, 'after a reload the section is open');
  assert.equal(fold({ id: 'optimize', title: 'Оптимизация' }).open, false, 'another id is independent');
  a.open = false;
  a.dispatch('toggle');
  assert.equal(storage.data[FOLD_KEY('printer')], '0');
  assert.equal(fold({ id: 'printer', title: 'Принтер', open: true }).open, false, 'a remembered "closed" beats open: true');
  assert.equal(fold({ id: 'fresh', title: 'x', open: true }).open, true, 'nothing remembered — the default');
});

test('fold: a throwing or missing storage falls back to the default and toggling does not throw', () => {
  setGlobal('localStorage', brokenStorage());
  const a = fold({ id: 'printer', title: 'Принтер', open: true });
  assert.equal(a.open, true);
  a.open = false;
  assert.doesNotThrow(() => a.dispatch('toggle'));
  delete globalThis.localStorage;
  const b = fold({ id: 'printer', title: 'Принтер' });
  assert.equal(b.open, false);
  b.open = true;
  assert.doesNotThrow(() => b.dispatch('toggle'));
});

// --- jog pad

const JOG = ['X−', 'X+', 'Y−', 'Y+', 'Z−', 'Z+'];
const jogDisabled = (pad) => JOG.map((l) => btn(pad.element, l).disabled);

test('fold without a note shows no stray "null" text', () => {
  const d = fold({ id: 'nullcheck', title: 'T' }, h('p', {}, 'body'));
  assert.doesNotMatch(d.textContent, /null|undefined/);
});

test('jog pad: without Home all six are disabled, the hint and "Already homed" are shown; after it they work', () => {
  const cal = fakeCalibrator({ link: NO_HOME });
  setGlobal('confirm', () => true);
  const log = [];
  const pad = createJogPad({ calibrator: cal, step: { get: () => 1, set() {} }, log: (m) => log.push(m) });
  assert.deepEqual(jogDisabled(pad), [true, true, true, true, true, true]);
  assert.match(pad.element.textContent, /Home не выполнен: сделайте Home/);
  const homeDone = btn(pad.element, t('print.homeDone'));
  assert.equal(all(pad.element, 'SPAN').find((s) => s.button === homeDone).hidden, false);
  homeDone.click();
  assert.equal(cal.homed, 1);
  assert.deepEqual(jogDisabled(pad), [false, false, false, false, false, false]);
  assert.equal(all(pad.element, 'SPAN').find((s) => s.button === homeDone).hidden, true);
  // only XY homed: Z stays disabled
  cal.setLink({ ...OK_LINK, z: { ok: false, message: 'Home Z' } });
  assert.deepEqual(jogDisabled(pad), [false, false, false, false, true, true]);
  pad.destroy();
  assert.equal(cal.linkSubs.size, 0);
});

test('jog pad: XY cross and Z column in OctoPrint order; two pads use separate radio groups', () => {
  const a = createJogPad({ calibrator: fakeCalibrator({}), step: { get: () => 1, set() {} } });
  const b = createJogPad({ calibrator: fakeCalibrator({}), step: { get: () => 10, set() {} } });
  const areas = Object.fromEntries(JOG.map((l) => [l, all(a.element, 'SPAN').find((s) => s.button === btn(a.element, l)).style.gridArea]));
  assert.deepEqual(areas, { 'X−': 'xm', 'X+': 'xp', 'Y−': 'ym', 'Y+': 'yp', 'Z−': 'zm', 'Z+': 'zp' });
  const name = (pad) => { const r = pad.element.findAll((e) => e.type === 'radio')[0]; return r.name ?? r.getAttribute('name'); };
  assert.notEqual(name(a), name(b));
});

test('jog pad: "Home (G28)" next to "Already homed" when not homed; sends G28 only after the pen confirmation', async () => {
  const cal = fakeCalibrator({ link: NO_HOME });
  const log = [];
  const pad = createJogPad({ calibrator: cal, step: { get: () => 1, set() {} }, log: (m) => log.push(m) });
  const homeBtn = btn(pad.element, t('jogpad.home'));
  const wrap = all(pad.element, 'SPAN').find((s) => s.button === homeBtn);
  assert.equal(wrap.hidden, false, 'shown while Home is missing');
  let asked = '';
  setGlobal('confirm', (q) => { asked = q; return false; });
  homeBtn.click();
  await tick();
  assert.equal(cal.jog.homes, 0, 'cancelled: no G28');
  assert.match(asked, /перо|Перо/i);
  setGlobal('confirm', () => true);
  homeBtn.click();
  await tick(); await tick();
  assert.equal(cal.jog.homes, 1);
  assert.equal(cal.homed, 1, 'the guard is lifted');
  assert.deepEqual(log, ['G28: G28 отправлен: парковка']);
  assert.equal(wrap.hidden, true, 'hidden once homed');
  pad.destroy();
});

test('jog pad: without permission (allowed false) everything is disabled', () => {
  const cal = fakeCalibrator({});
  let allowed = false;
  const pad = createJogPad({ calibrator: cal, allowed: () => allowed, step: { get: () => 1, set() {} } });
  assert.deepEqual(jogDisabled(pad), [true, true, true, true, true, true]);
  allowed = true;
  pad.sync();
  assert.deepEqual(jogDisabled(pad), [false, false, false, false, false, false]);
});

test('jog pad: the chosen step goes into jog.move; while a step runs all buttons are disabled and onBusy reports it', async () => {
  const cal = fakeCalibrator({});
  let step = 1;
  const busy = [], log = [];
  const pad = createJogPad({ calibrator: cal, step: { get: () => step, set: (v) => { step = v; } }, onBusy: (b) => busy.push(b), log: (m) => log.push(m) });
  const radios = pad.element.findAll((e) => e.tagName === 'INPUT' && e.type === 'radio');
  const pick = (v) => { for (const r of radios) r.checked = String(r.value) === String(v); radios.find((r) => String(r.value) === String(v)).dispatch('change'); };
  assert.deepEqual(radios.map((r) => Number(r.value)), [0.1, 1, 10], 'step segments');
  assert.deepEqual(radios.filter((r) => r.checked).map((r) => Number(r.value)), [1], 'the owner step is preselected');
  const group = (r) => r.name ?? r.getAttribute('name');
  assert.equal(new Set(radios.map(group)).size, 1, 'one radio group');
  pick(10);
  assert.equal(step, 10);
  let release;
  cal.jog.gate = new Promise((r) => { release = r; });
  btn(pad.element, 'Y−').click();
  assert.deepEqual(cal.jog.moves, [['y', -1, 10]]);
  assert.equal(pad.busy, true);
  assert.deepEqual(jogDisabled(pad), [true, true, true, true, true, true]);
  btn(pad.element, 'X+').click(); // disabled: no second move
  assert.equal(cal.jog.moves.length, 1);
  release();
  await tick();
  assert.equal(pad.busy, false);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(jogDisabled(pad), [false, false, false, false, false, false]);
  assert.deepEqual(log, ['Y−: готово']);
  pick(0.1);
  btn(pad.element, 'Z+').click();
  await tick();
  assert.deepEqual(cal.jog.moves[1], ['z', 1, 0.1]);
});

// --- pen area editor

const editorParts = (ed) => {
  const [rOffset, rMeasured] = ed.element.findAll((e) => e.tagName === 'INPUT' && e.type === 'radio');
  const box = (cls) => ed.element.findAll((e) => e.className === cls)[0];
  const [dx, dy] = inputs(box('area-offset'));
  return { rOffset, rMeasured, dx, dy, offsetBox: box('area-offset'), measuredBox: box('area-measured'), reach: box('note area-reach'), warn: ed.element.findAll((e) => e.className === 'warn')[0] };
};

test('area editor: the mode comes from the data (none / offset / measured)', async () => {
  const a = await app();
  const ed = createAreaEditor({ state: a.state, calibrator: a.cal });
  let p = editorParts(ed);
  assert.equal(p.offsetBox.hidden, false, 'not set: the offset editor is offered first');
  assert.deepEqual([p.dx.value, p.dy.value], ['', '']);
  assert.equal(p.reach.textContent, '');
  assert.match(p.warn.textContent, /Область пера не задана/);
  await a.state.patch('profile', bedFromPenOffset({ x: 35, y: 0 }, { w: 235, h: 235 }).changes);
  p = editorParts(ed);
  assert.deepEqual([p.rOffset.checked, p.rMeasured.checked, p.offsetBox.hidden, p.measuredBox.hidden], [true, false, false, true]);
  assert.deepEqual([p.dx.value, p.dy.value], ['35', '0']);
  await a.state.setBedPoint('ur', { x: 190, y: 225 });
  p = editorParts(ed);
  assert.deepEqual([p.rOffset.checked, p.rMeasured.checked, p.offsetBox.hidden, p.measuredBox.hidden], [false, true, true, false]);
  assert.deepEqual(inputs(p.measuredBox).map((i) => i.value), ['-35', '0', '190', '225']);
  ed.destroy();
});

test('area editor: dx/dy write the bed through state.patch; "Pen reaches: 204 × 230 мм"', async () => {
  const a = await app();
  const patches = [];
  const orig = a.state.patch;
  a.state.patch = (section, changes) => { patches.push([section, changes]); return orig(section, changes); };
  const ed = createAreaEditor({ state: a.state });
  const { dx, dy } = editorParts(ed);
  change(dx, '35');
  await tick();
  assert.equal(patches.length, 0, 'one field is not enough');
  change(dy, '0');
  await tick();
  assert.equal(patches.length, 1);
  assert.equal(patches[0][0], 'profile');
  assert.deepEqual(a.bed(), [-35, 0, 200, 235, true]);
  assert.equal(editorParts(ed).reach.textContent, 'Перо достаёт: 204 × 230 мм');
  assert.equal(editorParts(ed).warn.textContent, '');
});

test('area editor: "Pen here" captures with the chosen corner; "Go to" the area corners', async () => {
  const a = await app({ head: { x: 200, y: -3, z: 20 } });
  const calls = [];
  const orig = a.cal.capture.captureBedFromOffsetCorner;
  a.cal.capture.captureBedFromOffsetCorner = (w) => { calls.push(w); return orig(w); };
  const ed = createAreaEditor({ state: a.state, calibrator: a.cal });
  const sel = byLabel(ed.element, t('area.cornerLead'));
  assert.deepEqual(sel.findAll((o) => o.tagName === 'OPTION').map((o) => o.value), ['ll', 'lr', 'ul', 'ur']);
  sel.value = 'lr';
  btn(ed.element, t('area.penHere')).click();
  await tick(5);
  assert.deepEqual(calls, ['lr']);
  assert.deepEqual(a.bed(), [-35, -3, 200, 232, true]);
  assert.deepEqual([editorParts(ed).dx.value, editorParts(ed).dy.value], ['35', '3']);
  assert.match(ed.element.textContent, /Смещение пера от сопла: X35 Y3/);
  // the area: limits X-4…234 Y1…231 ∩ bed X-35…200 Y-3…232
  btn(ed.element, t('area.goNear')).click();
  await tick();
  btn(ed.element, t('area.goFar')).click();
  await tick();
  assert.deepEqual(a.cal.jog.gone, [{ x: -4, y: 1 }, { x: 200, y: 231 }]);
});

test('area editor: "Extreme positions" — two points become the bed without the nominal mark', async () => {
  const a = await app();
  const ed = createAreaEditor({ state: a.state, calibrator: a.cal });
  const p = editorParts(ed);
  p.rMeasured.checked = true;
  p.rMeasured.dispatch('change');
  assert.equal(editorParts(ed).measuredBox.hidden, false);
  assert.equal(editorParts(ed).offsetBox.hidden, true);
  assert.match(p.measuredBox.textContent, /Ближнее левое положение пера.*Дальнее правое положение пера/);
  const [llx, lly, urx, ury] = inputs(p.measuredBox);
  change(llx, '-4'); change(lly, '1');
  await tick();
  assert.equal(a.bed()[4], true, 'one point: the data look like the offset mode');
  assert.equal(editorParts(ed).measuredBox.hidden, false, 'the chosen mode stays while editing: the second point is still shown');
  assert.equal(editorParts(ed).rMeasured.checked, true);
  change(urx, '200'); change(ury, '231');
  await tick();
  assert.deepEqual(a.bed(), [-4, 1, 200, 231, false]);
  assert.equal(editorParts(ed).rMeasured.checked, true, 'the data say measured');
  assert.equal(editorParts(ed).reach.textContent, 'Перо достаёт: 204 × 230 мм');
  // a profile switch drops the choice: the editor follows the data of the new profile
  const made = await a.state.createProfile('Другой');
  const first = a.state.activeProfileId();
  await a.state.selectProfile(made.id);
  await a.state.patch('profile', bedFromPenOffset({ x: 10, y: 0 }, { w: 235, h: 235 }).changes);
  assert.deepEqual([editorParts(ed).rOffset.checked, editorParts(ed).measuredBox.hidden], [true, true], 'the other profile is in the offset mode');
  await a.state.selectProfile(first);
  assert.equal(editorParts(ed).rMeasured.checked, true, 'back: the measured profile');
  // capture of the far right position
  a.server.head = { x: 190, y: 220, z: 20 };
  all(p.measuredBox, 'BUTTON').filter((b) => b.textContent === t('point.capture'))[1].click();
  await tick(5);
  assert.deepEqual(a.bed(), [-4, 1, 190, 220, false]);
});

test('area editor: without the profile permission — read only, the values are visible', async () => {
  const a = await app({ profileNeed: () => NEED_PROFILE });
  await a.state.patch('profile', bedFromPenOffset({ x: 35, y: 0 }, { w: 235, h: 235 }).changes);
  const ed = createAreaEditor({ state: a.state, calibrator: a.cal, need: () => NEED_PROFILE });
  const p = editorParts(ed);
  assert.deepEqual([p.dx.value, p.dy.value], ['35', '0']);
  for (const el of [p.rOffset, p.rMeasured, p.dx, p.dy, byLabel(ed.element, t('area.cornerLead')), ...inputs(p.measuredBox)]) assert.equal(el.disabled, true);
  assert.equal(btn(ed.element, t('area.penHere')).disabled, true);
  assert.ok(all(p.measuredBox, 'BUTTON').filter((b) => b.textContent === t('point.capture')).every((b) => b.disabled));
  // "Go to" follows the jog rules (control permission), not the profile permission
  assert.equal(btn(ed.element, t('area.goFar')).disabled, false);
  const noControl = createAreaEditor({ state: a.state, calibrator: a.cal, control: () => false });
  assert.equal(btn(noControl.element, t('area.goFar')).disabled, true);
  assert.equal(btn(noControl.element, t('area.penHere')).disabled, true);
  assert.equal(editorParts(noControl).dx.disabled, false, 'the numbers stay editable with the profile permission');
});

// --- readiness card

test('readiness card: the row states follow the monitor and the connection; "Set up" passes the item id', async () => {
  const a = await app();
  const connSubs = subs();
  let conn = 'offline';
  const connection = { status: () => ({ status: conn }), subscribe: connSubs.add };
  const opened = [];
  const card = createReadinessCard({ state: a.state, calibrator: a.cal, connection, onSetup: (id) => opened.push(id) });
  const rows = () => Object.fromEntries(card.element.findAll((e) => e.getAttribute('data-item')).map((r) => [r.getAttribute('data-item'), r.getAttribute('data-state')]));
  assert.deepEqual(rows(), { connection: 'todo', area: 'todo', corner: 'todo', touch: 'todo' });
  await a.state.patch('profile', bedFromPenOffset({ x: 35, y: 0 }, { w: 235, h: 235 }).changes);
  await a.state.patch('calibration', { cornerX: 10, cornerY: 20 });
  conn = 'ok'; connSubs.emit();
  assert.deepEqual(rows(), { connection: 'ok', area: 'ok', corner: 'ok', touch: 'ok' });
  assert.equal(card.element.dataset.ready, '1');
  assert.match(card.element.textContent, /204 × 230 мм.*X10 Y20/);
  a.cal.monitor.set({ xy: false });
  assert.deepEqual(rows(), { connection: 'ok', area: 'ok', corner: 'stale', touch: 'ok' });
  assert.equal(card.element.dataset.ready, '');
  a.cal.monitor.set({ known: false });
  assert.deepEqual(rows(), { connection: 'ok', area: 'ok', corner: 'unknown', touch: 'unknown' });
  const touchRow = card.element.findAll((e) => e.getAttribute('data-item') === 'touch')[0];
  btn(touchRow, t('ready.setup')).click();
  btn(card.element, t('ready.run')).click();
  assert.deepEqual(opened, ['touch', undefined]);
  card.destroy();
  assert.equal(connSubs.size + a.cal.monSubs.size, 0);
});

test('readiness card: without a connection monitor (plugin) there is no connection row', async () => {
  const a = await app();
  const card = createReadinessCard({ state: a.state, calibrator: null, onSetup: () => {} });
  assert.deepEqual(card.element.findAll((e) => e.getAttribute('data-item')).map((r) => r.getAttribute('data-item')), ['area', 'corner', 'touch']);
});

// --- setup wizard

async function wizardApp({ ui = {}, head, calibrator = true, link } = {}) {
  const a = await app({ head, link, profileNeed: () => (ui.needs ? ui.needs('profiles') : null) });
  const host = document.createElement('div');
  const connSubs = subs();
  const connectionMonitor = { status: () => ({ status: 'ok', detail: '' }), subscribe: connSubs.add, checkNow: async () => ({ detail: 'ok' }) };
  const wizard = createSetupWizard({
    host, state: a.state, ui: { connectionMonitor, ...ui }, calibrator: calibrator ? a.cal : null,
    transport: { configured: () => true }, jogStep: { get: () => 1, set() {} },
  });
  return { ...a, host, wizard, dialog: host.children[0], connSubs };
}

test('wizard: step order standalone and plugin; open on a step; Next/Back; "Set up" in the check step', async () => {
  const s = await wizardApp();
  assert.deepEqual(s.wizard.steps(), ['connection', 'area', 'sheet', 'touch', 'check']);
  assert.equal(s.dialog.tagName, 'DIALOG');
  assert.equal(s.wizard.isOpen(), false);
  s.wizard.open();
  assert.equal(s.wizard.step(), 'connection');
  assert.match(s.dialog.textContent, /Шаг 1 из 5/);
  const p = await wizardApp({ ui: { hideConnection: true } });
  assert.deepEqual(p.wizard.steps(), ['area', 'sheet', 'touch', 'check']);
  p.wizard.open('touch');
  assert.equal(p.wizard.isOpen(), true);
  assert.equal(p.dialog.open, true);
  assert.equal(p.wizard.step(), 'touch');
  assert.equal(p.dialog.dataset.step, 'touch');
  assert.match(p.dialog.textContent, /Шаг 3 из 4/);
  assert.match(p.dialog.textContent, /Опускайте перо шагами Z−/);
  btn(p.dialog, t('wizard.back')).click();
  assert.equal(p.wizard.step(), 'sheet');
  btn(p.dialog, t('wizard.next')).click();
  btn(p.dialog, t('wizard.next')).click();
  assert.equal(p.wizard.step(), 'check');
  const touchRow = p.dialog.findAll((e) => e.getAttribute('data-item') === 'touch')[0];
  btn(touchRow, t('ready.setup')).click();
  assert.equal(p.wizard.step(), 'touch');
  p.wizard.open('nope');
  assert.equal(p.wizard.step(), 'area', 'an unknown step — the first one');
  p.wizard.open('corner');
  assert.equal(p.wizard.step(), 'sheet', 'the readiness item "corner" is the sheet step');
  p.wizard.open('check');
  const cornerRow = p.dialog.findAll((e) => e.getAttribute('data-item') === 'corner')[0];
  btn(cornerRow, t('ready.setup')).click();
  assert.equal(p.wizard.step(), 'sheet');
  assert.ok(btn(p.dialog, 'X+'), 'the jog pad is in the area step (the pen is brought to a bed corner)');
});

test('wizard: "Sheet corner here" uses the offset from "The pen cannot reach the sheet corner"', async () => {
  const storage = memStorage();
  setGlobal('localStorage', storage);
  const w = await wizardApp({ ui: { hideConnection: true }, head: { x: 10, y: 20, z: 20 } });
  w.wizard.open('sheet');
  assert.match(w.dialog.textContent, /Перо не достаёт до угла листа/);
  change(byLabel(w.dialog, t('print.offX')), '-10');
  change(byLabel(w.dialog, t('print.offY')), '-10');
  assert.deepEqual(JSON.parse(storage.data[OFFSET_KEY]), { x: -10, y: -10 });
  btn(w.dialog, t('wizard.sheet.cornerHere')).click();
  await tick(5);
  const c = w.state.get('calibration');
  assert.deepEqual([c.cornerX, c.cornerY], [20, 30]);
  assert.ok(c.updatedAt);
  assert.match(w.dialog.textContent, /Угол листа сейчас: X20 Y30/);
  // "Go to the area corner": the near left corner of the pen area (not set: the axis limits)
  btn(w.dialog, t('wizard.sheet.goCorner')).click();
  await tick();
  assert.deepEqual(w.cal.jog.gone, [{ x: -4, y: 1 }]);
  // the offset is remembered for the next opening
  w.wizard.close();
  w.wizard.open('sheet');
  assert.equal(byLabel(w.dialog, t('print.offX')).value, -10);
});

test('wizard: "Touch here" saves the head Z as the touch', async () => {
  const w = await wizardApp({ ui: { hideConnection: true }, head: { x: 10, y: 20, z: 8.2 } });
  w.wizard.open('touch');
  assert.ok(btn(w.dialog, 'Z−'), 'the jog pad is in the step');
  btn(w.dialog, t('wizard.touch.here')).click();
  await tick(5);
  assert.equal(w.state.get('calibration').zTouch, 8.2);
  assert.match(w.dialog.textContent, /Касание сейчас: Z8.2/);
});

test('wizard: without the permission a step is read only with the permission name', async () => {
  const needs = (s) => (s === 'calibration' ? NEED_CONTROL : s === 'profiles' || s === 'profile' ? NEED_PROFILE : null);
  const w = await wizardApp({ ui: { hideConnection: true, needs } });
  w.wizard.open('sheet');
  assert.match(w.dialog.textContent, /Только чтение: нужно право «управление принтером»/);
  assert.equal(btn(w.dialog, t('wizard.sheet.cornerHere')).disabled, true);
  assert.equal(btn(w.dialog, t('wizard.sheet.goCorner')).disabled, true);
  assert.ok(JOG.every((l) => btn(w.dialog, l).disabled), 'the jog pad is disabled');
  const corner = w.dialog.findAll((e) => e.className === 'point')[0];
  assert.ok(inputs(corner).every((i) => i.disabled), 'the sheet corner numbers are read only');
  w.wizard.open('touch');
  assert.match(w.dialog.textContent, /Только чтение: нужно право «управление принтером»/);
  assert.equal(btn(w.dialog, t('wizard.touch.here')).disabled, true);
  const locked = w.dialog.findAll((e) => e.tagName === 'FIELDSET');
  assert.equal(locked.length, 2, 'the touch value and the pen width');
  assert.ok(locked.every((f) => f.disabled));
  w.wizard.open('area');
  assert.match(w.dialog.textContent, /Только чтение: нужно право «изменение профиля машины»/);
  assert.equal(byLabel(w.dialog, t('profiles.active')).disabled, true);
  assert.equal(btn(w.dialog, t('area.penHere')).disabled, true);
  // with the permissions everything is enabled
  const ok = await wizardApp({ ui: { hideConnection: true } });
  ok.wizard.open('sheet');
  assert.equal(btn(ok.dialog, t('wizard.sheet.cornerHere')).disabled, false);
  assert.ok(!/Только чтение/.test(ok.dialog.textContent));
});

test('wizard: without a position monitor — numbers only, no jog pad and no capture', async () => {
  const w = await wizardApp({ ui: { hideConnection: true }, calibrator: false });
  w.wizard.open('sheet');
  assert.match(w.dialog.textContent, /Нет источника положения принтера/);
  assert.equal(btn(w.dialog, t('wizard.sheet.cornerHere')), undefined);
  assert.equal(btn(w.dialog, 'X+'), undefined);
  w.wizard.open('touch');
  assert.equal(btn(w.dialog, t('wizard.touch.here')), undefined);
});

test('wizard: destroy closes the dialog and removes the subscriptions', async () => {
  const w = await wizardApp();
  const base = w.cal.linkSubs.size + w.cal.monSubs.size;
  assert.ok(base > 0);
  w.wizard.open('check');
  assert.ok(w.cal.monSubs.size > 0);
  w.wizard.destroy();
  assert.equal(w.wizard.isOpen(), false);
  assert.equal(w.dialog.open, false);
  assert.equal(w.cal.linkSubs.size + w.cal.monSubs.size + w.connSubs.size, 0);
  // the step's own subscriptions are removed by closing as well
  const v = await wizardApp();
  v.wizard.open('connection');
  assert.equal(v.connSubs.size, 1, 'the connection indicator');
  btn(v.dialog, t('wizard.close')).click();
  assert.equal(v.wizard.isOpen(), false);
  assert.equal(v.connSubs.size, 0);
});

// --- the Print tab: the calibration card with the jog pad and "Set up…", the wizard lives in mount/unmount

test('print tab: mounts with a calibrator (the jog pad is built before the log), "Set up…" opens the wizard, unmount closes it', async () => {
  setGlobal('matchMedia', () => ({ addEventListener() {}, removeEventListener() {} }));
  setGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
  try {
    const { createPrintTab } = await import('../src/app/tabs/print-tab.js');
    const a = await app();
    const connection = { status: () => ({ status: 'ok', detail: '' }), subscribe: () => () => {}, onCycle: () => () => {}, checkNow: async () => ({}) };
    const transport = { configured: () => true, job: async () => ({ state: 'Operational' }) };
    const tab = createPrintTab({ state: a.state, store: new MemoryStore(), service: {}, transport, connection, ui: { hideConnection: true }, calibrator: a.cal });
    const el = document.createElement('div');
    tab.mount(el);
    const dialog = el.findAll((e) => e.tagName === 'DIALOG')[0];
    const card = el.findAll((e) => e.tagName === 'H2' && e.textContent === t('print.calibration.title'))[0];
    assert.ok(card, 'the calibration card');
    assert.ok(btn(el, 'X+'), 'the jog pad in the card');
    assert.equal(btn(el, t('wizard.sheet.cornerHere')), undefined, 'capture moved to the wizard');
    btn(el, t('print.calibration.setup')).click();
    assert.equal(dialog.open, true);
    assert.equal(dialog.dataset.step, 'area');
    tab.unmount();
    assert.equal(dialog.open, false);
  } finally {
    delete globalThis.matchMedia; delete globalThis.getComputedStyle;
  }
});
