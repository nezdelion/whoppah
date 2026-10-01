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
import { createFirmwareMemo } from './ui/feed-firmware.js';
import * as marlinReplies from '../core/marlin-replies.js';
import { setupCalibration } from './calibration/setup.js';
import { createSvgSource } from './tabs/svg-tab.js';
import { createPhotoSource } from './tabs/photo-tab.js';
import { createPrintTab } from './tabs/print-tab.js';
import { h } from './ui/dom.js';
import { createConnectionMonitor, isValidBaseUrl } from './connection-monitor.js';
import { createConnectionIndicator } from './ui/connection-indicator.js';
import { t } from '../i18n/index.js';
import { applyLanguage, saveLanguageChoice } from './lang.js';

const notice = (() => {
  const el = h('div', { class: 'notice', hidden: true, role: 'status' });
  return {
    el,
    show(...content) { el.replaceChildren(...content, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); el.hidden = true; } }, t('notice.hide'))); el.hidden = false; },
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
    onExpired: () => notice.show(t('notice.expired') + ' ',
      h('a', { href: `${env.loginUrl.replace(/\/+$/, '')}/?redirect=${encodeURIComponent(location.pathname + location.search)}`, target: '_blank', rel: 'noopener' }, t('notice.signIn')),
      ' ' + t('notice.expiredTail')),
  });
  const store = new ServerStore({ baseUrl: env.baseUrl, settingsUrl: env.settingsUrl, auth });
  const transport = createOctoPrintTransport({ getBaseUrl: () => env.baseUrl, auth, sameOrigin: true });
  const needs = (section) => {
    if (section === 'profile' && !env.canEditProfile) return t('needs.right', { what: t('perm.profile') });
    if (section === 'calibration' && !env.canEditCalibration) return t('needs.right', { what: t('perm.control') });
    return null;
  };
  document.querySelector('header').append(h('a', { class: 'back-link', href: env.octoprintUrl }, '← OctoPrint'));
  const positionSource = createOctoPrintPosition({ apiUrl: `${env.baseUrl}/plugin/plotter/api`, auth });
  return { store, transport, needs, positionSource, ui: { hideConnection: true, needs } };
}

async function start() {
  const env = await loadEnv();
  // the language is chosen before any UI is built: user choice → OctoPrint language (plugin) → browser language → en
  const { choice } = applyLanguage({ env });
  const language = { get: () => choice, set: (v) => { saveLanguageChoice(v); location.reload(); } };
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
    if (e.type === 'save-error') notice.show(t('notice.saveFailed', { message: e.message }));
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
    }).catch((e) => t('notice.importFailed', { message: e.message }));
    if (message) { await state.load(); notice.show(message); }
  }
  // Connection monitor: in standalone "configured" = a valid address and a non-empty key; in the plugin — a session, no key.
  const connection = createConnectionMonitor({
    transport,
    visibility: pageVisibility(),
    configured: plugin ? () => transport.configured() : () => { const c = state.get('connection'); return isValidBaseUrl(c.url) && !!c.key; },
    describeAuth: plugin ? (status) => t('conn.sessionRejected', { status }) : undefined,
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

  // Firmware settings (M503) — standalone with a feed only; in plugin mode there is no feed and no read button (out of scope)
  const firmware = feed ? createFirmwareMemo(feed) : null;
  const tabs = [
    ...[createSvgSource(), createPhotoSource()].map((source) => ({ id: source.id, title: source.title, source })),
    { id: 'print', title: t('tab.print'), tab: createPrintTab({ state, store, service, transport, connection, calibrator, ui: { ...(plugin ? plugin.ui : { feed, firmware }), language } }) },
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

  for (const tab of tabs) {
    const view = h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true });
    const btn = h('button', { type: 'button', role: 'tab', onclick: () => show(tab.id) }, tab.title);
    nav.append(btn);
    panels.append(view);
    buttons.set(tab.id, btn);
    views.set(tab.id, view);
    if (tab.source) tab.source.mount(view, createSourceContext({ state, store, sourceId: tab.source.id }));
    else tab.tab.mount(view);
  }
  show(tabs[0].id);
  connection.start();
  if (feed) feed.start();

  // after loading a drawing, show the result immediately
  state.subscribe((e) => { if (e.type === 'drawing') show('print'); });
}

start().catch((e) => {
  document.getElementById('panels').textContent = t('app.startFailed', { message: e.message });
  console.error(e);
});
