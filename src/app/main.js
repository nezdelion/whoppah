// Composition root: choosing implementations (storage, transport, auth), assembling the tabs.
import { LocalStorageStore, migrateLegacy } from '../storage/settings-store.js';
import { createOctoPrintTransport } from '../transport/octoprint-http.js';
import { createApiKeyAuth } from '../transport/auth-api-key.js';
import { createSessionAuth } from '../transport/auth-session.js';
import { ServerStore } from '../storage/server-store.js';
import { loadEnv } from './env.js';
import { offerLocalImport } from './local-import.js';
import { createState, createSourceContext } from './state.js';
import { createPrintService } from './print/print-service.js';
import { limitsCheck, partialCheck } from './print/checks.js';
import { createOctoPrintPosition } from '../transport/octoprint-position.js';
import { createPrinterFeed, createFeedPositionSource } from '../transport/octoprint-feed.js';
import * as marlinReplies from '../core/marlin-replies.js';
import { setupCalibration } from './calibration/setup.js';
import { createSvgSource } from './tabs/svg-tab.js';
import { createPhotoSource } from './tabs/photo-tab.js';
import { createPrintTab } from './tabs/print-tab.js';
import { h } from './ui/dom.js';
import { createConnectionMonitor, isValidBaseUrl } from './connection-monitor.js';
import { createConnectionIndicator } from './ui/connection-indicator.js';

const notice = (() => {
  const el = h('div', { class: 'notice', hidden: true, role: 'status' });
  return {
    el,
    show(...content) { el.replaceChildren(...content, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); el.hidden = true; } }, 'скрыть')); el.hidden = false; },
  };
})();

const pageVisibility = () => ({
  visible: () => document.visibilityState !== 'hidden',
  subscribe: (fn) => { document.addEventListener('visibilitychange', fn); return () => document.removeEventListener('visibilitychange', fn); },
});

// Choosing implementations by mode: standalone — key and browser storage, plugin — session and OctoPrint server.
function setupPlugin(env) {
  const auth = createSessionAuth({
    baseUrl: env.baseUrl, csrfCookie: env.csrfCookie, refreshUrl: `${env.baseUrl}/plugin/plotter/env.json`,
    onExpired: () => notice.show('Сессия OctoPrint истекла. ',
      h('a', { href: `${env.loginUrl.replace(/\/+$/, '')}/?redirect=${encodeURIComponent(location.pathname + location.search)}`, target: '_blank', rel: 'noopener' }, 'Войти'),
      ' — рисунок и настройки на странице сохранятся.'),
  });
  const store = new ServerStore({ baseUrl: env.baseUrl, settingsUrl: env.settingsUrl, auth });
  const transport = createOctoPrintTransport({ getBaseUrl: () => env.baseUrl, auth, sameOrigin: true });
  const needs = (section) => {
    if (section === 'profile' && !env.canEditProfile) return 'нужно право «изменение профиля машины»';
    if (section === 'calibration' && !env.canEditCalibration) return 'нужно право «управление принтером»';
    return null;
  };
  document.querySelector('header').append(h('a', { class: 'back-link', href: env.octoprintUrl }, '← OctoPrint'));
  const positionSource = createOctoPrintPosition({ apiUrl: `${env.baseUrl}/plugin/plotter/api`, auth });
  return { store, transport, needs, positionSource, ui: { hideConnection: true, needs } };
}

async function start() {
  const env = await loadEnv();
  document.body.prepend(notice.el);
  let store, transport, plugin = null;
  if (env.mode === 'plugin') {
    plugin = setupPlugin(env);
    ({ store, transport } = plugin);
  } else {
    store = new LocalStorageStore(localStorage);
    await migrateLegacy(localStorage, store);
  }
  // The connection feed (standalone) is created below; manual input of corner/touch sets the part to the feed's current epoch, like the plugin server.
  let feed = null;
  const stampEdit = (changes) => {
    if (!feed) return {};
    const e = feed.epoch(), out = {};
    if (('cornerX' in changes || 'cornerY' in changes) && !('epochXY' in changes)) out.epochXY = e.xy;
    if ('zTouch' in changes && !('epochZ' in changes)) out.epochZ = e.z;
    return out;
  };
  const state = createState({ store, stampEdit: plugin ? null : stampEdit });
  await state.load();
  // Standalone epochs live in the feed memory and start over after a reload: the saved ones cannot be matched against them
  // (the app does not know what was done with the printer while the page was closed) — both parts are outdated until a capture/confirmation.
  if (!plugin) state.adoptCalibration({ ...state.get('calibration'), epochXY: null, epochZ: null });
  state.subscribe((e) => {
    if (e.type === 'save-error') notice.show(`Не удалось сохранить настройки: ${e.message}`);
  });

  if (!transport) {
    transport = createOctoPrintTransport({
      getBaseUrl: () => state.get('connection').url,
      auth: createApiKeyAuth({ getKey: () => state.get('connection').key }),
    });
  }
  if (plugin) {
    const message = await offerLocalImport({
      serverStore: store, localStore: new LocalStorageStore(localStorage), flags: localStorage,
      flagKey: `neptune-plotter.plugin-import-offered.${env.user || ''}`,
      confirm: (m) => window.confirm(m), needs: plugin.needs,
    }).catch((e) => `Перенос настроек: ${e.message}`);
    if (message) { await state.load(); notice.show(message); }
  }
  // Connection monitor: in standalone "configured" = a valid address and a non-empty key; in the plugin — a session, no key.
  const connection = createConnectionMonitor({
    transport,
    visibility: pageVisibility(),
    configured: plugin ? () => transport.configured() : () => { const c = state.get('connection'); return isValidBaseUrl(c.url) && !!c.key; },
    describeAuth: plugin ? (status) => `сессия OctoPrint не принята (${status}): войдите заново` : undefined,
  });
  if (!plugin) {
    state.subscribe((e) => { if (e.type === 'settings' && (e.section === 'connection' || e.section === '*')) connection.configChanged(); });
  }
  // The printer connection feed (head position, firmware limits, foreign commands) — standalone only.
  // Our own commands go through feed.command so that the feed can tell them from foreign log lines.
  if (!plugin) {
    const rawTransport = transport;
    feed = createPrinterFeed({
      getBaseUrl: () => state.get('connection').url, getKey: () => state.get('connection').key,
      sendCommands: (lines) => rawTransport.command(lines), replies: marlinReplies, visibility: pageVisibility(),
    });
    transport = { ...rawTransport, command: (lines) => feed.command(lines) };
    state.subscribe((e) => { if (e.type === 'settings' && (e.section === 'connection' || e.section === '*')) feed.configChanged(); });
  }
  document.querySelector('header h1').after(createConnectionIndicator(connection).element);
  // Capture and jog panel: plugin — the plugin source (epochs and write on the server); standalone — the feed source, the app stores the calibration.
  const positionSource = plugin ? plugin.positionSource
    : createFeedPositionSource(feed, { calibration: { get: () => state.get('calibration'), patch: (changes) => state.patch('calibration', changes) } });
  const calibration = setupCalibration({ positionSource, state, store, visibility: pageVisibility(), standalone: !plugin, transport });
  const calibrator = calibration && calibration.calibrator;
  const preflight = [limitsCheck, partialCheck, ...(calibration ? [calibration.check] : [])];
  const service = createPrintService({
    transport,
    getSettings: () => state.settings(),
    confirm: (message) => Promise.resolve(window.confirm(message)),
    preflight,
    beforePlan: calibration ? [calibration.beforePlan] : [],
  });

  const tabs = [
    ...[createSvgSource(), createPhotoSource()].map((source) => ({ id: source.id, title: source.title, source })),
    { id: 'print', title: 'Печать', tab: createPrintTab({ state, store, service, transport, connection, calibrator, ui: plugin ? plugin.ui : { feed } }) },
  ];

  const nav = document.getElementById('tabs');
  const panels = document.getElementById('panels');
  const buttons = new Map(), views = new Map();
  const show = (id) => {
    for (const [tid, btn] of buttons) {
      const active = tid === id;
      btn.setAttribute('aria-selected', String(active));
      views.get(tid).hidden = !active;
    }
  };

  for (const t of tabs) {
    const view = h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true });
    const btn = h('button', { type: 'button', role: 'tab', onclick: () => show(t.id) }, t.title);
    nav.append(btn);
    panels.append(view);
    buttons.set(t.id, btn);
    views.set(t.id, view);
    if (t.source) t.source.mount(view, createSourceContext({ state, store, sourceId: t.source.id }));
    else t.tab.mount(view);
  }
  show(tabs[0].id);
  connection.start();
  if (feed) feed.start();

  // after loading a drawing, show the result immediately
  state.subscribe((e) => { if (e.type === 'drawing') show('print'); });
}

start().catch((e) => {
  document.getElementById('panels').textContent = `Не удалось запустить приложение: ${e.message}`;
  console.error(e);
});
