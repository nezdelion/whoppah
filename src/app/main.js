// Composition root: choosing implementations (storage, transport, auth), assembling the tabs.
import { LocalStorageStore, migrateLegacy, migrateProfiles } from '../storage/settings-store.js';
import { fromLegacy } from '../core/profiles.js';
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
import { createLimitsMemo } from './ui/feed-limits.js';
import * as marlinReplies from '../core/marlin-replies.js';
import { setupCalibration } from './calibration/setup.js';
import { createSvgSource } from './tabs/svg-tab.js';
import { createPhotoSource } from './tabs/photo-tab.js';
import { createTextSource } from './tabs/text-tab.js';
import { createTextModel } from './text/text-model.js';
import { createUserFonts, safeLocalStorage } from './text/user-fonts.js';
import { createPrintTab } from './tabs/print-tab.js';
import { h } from './ui/dom.js';
import { createTabHost } from './ui/tab-host.js';
import { createLanguageSwitch } from './ui/lang-switch.js';
import { createConnectionMonitor, isValidBaseUrl } from './connection-monitor.js';
import { createConnectionIndicator } from './ui/connection-indicator.js';
import { t } from '../i18n/index.js';
import { applyLanguage, createLanguageControl } from './lang.js';

const notice = (() => {
  const el = h('div', { class: 'notice', hidden: true, role: 'status' });
  return {
    el,
    show(...content) { el.replaceChildren(...content, ' ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); el.hidden = true; } }, t('notice.hide'))); el.hidden = false; },
  };
})();

// the right side of the header (index.html); an older page without it — the header itself
const headerTools = () => document.getElementById('header-tools') || document.querySelector('header');

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
  const store = new ServerStore({ baseUrl: env.baseUrl, settingsUrl: env.settingsUrl, profilesUrl: env.profilesUrl, auth });
  const transport = createOctoPrintTransport({ getBaseUrl: () => env.baseUrl, auth, sameOrigin: true });
  const needs = (section) => {
    if ((section === 'profile' || section === 'profiles') && !env.canEditProfile) return t('needs.right', { what: t('perm.profile') });
    if (section === 'calibration' && !env.canEditCalibration) return t('needs.right', { what: t('perm.control') });
    return null;
  };
  headerTools().append(h('a', { class: 'back-link', href: env.octoprintUrl }, '← OctoPrint'));
  const positionSource = createOctoPrintPosition({ apiUrl: `${env.baseUrl}/plugin/plotter/api`, auth });
  return { store, transport, needs, positionSource, ui: { hideConnection: true, needs } };
}

async function start() {
  const env = await loadEnv();
  // the language is chosen before any UI is built: user choice → OctoPrint language (plugin) → browser language → en
  const { choice } = applyLanguage({ env });
  document.body.prepend(notice.el);
  let store, transport, plugin = null;
  if (env.mode === 'plugin') {
    plugin = setupPlugin(env);
    ({ store, transport } = plugin);
  } else {
    store = new LocalStorageStore(localStorage);
    await migrateLegacy(localStorage, store);
    // the single machine profile of earlier versions becomes the first named profile (the plugin server does it itself)
    await migrateProfiles(store, (values) => fromLegacy(values));
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
  // Capture and jog panel: plugin — the plugin source (epochs and write on the server); standalone — the feed source, the app stores the calibration.
  const positionSource = plugin ? plugin.positionSource
    : createFeedPositionSource(feed, { calibration: { get: () => state.get('calibration'), patch: (changes) => state.patch('calibration', changes) } });
  const profileNeed = () => (plugin ? plugin.needs('profiles') : null);
  const calibration = setupCalibration({ positionSource, state, store, visibility: pageVisibility(), standalone: !plugin, transport, profileNeed });
  const calibrator = calibration && calibration.calibrator;
  const preflight = [limitsCheck, partialCheck, ...(calibration ? [calibration.check] : [])];
  const service = createPrintService({
    transport,
    getSettings: () => state.settings(),
    confirm: (message) => Promise.resolve(window.confirm(message)),
    preflight,
    beforePlan: calibration ? [calibration.beforePlan] : [],
  });

  // Firmware settings (M503) and the M211 limits — standalone with a feed only (memory, outlives a rebuilt UI);
  // in plugin mode there is no feed and no read buttons (out of scope)
  const firmware = feed ? createFirmwareMemo(feed) : null;
  const limits = feed ? createLimitsMemo(feed) : null;

  // Tabs and their models are created once; on a language switch only their views are rebuilt (tab-host.js).
  // Sources keep one context: their models stay bound to it across remounts.
  const sourceTab = (source) => {
    const ctx = createSourceContext({ state, store, sourceId: source.id });
    return { id: source.id, get title() { return source.title; }, mount: (view) => source.mount(view, ctx), unmount: () => source.unmount() };
  };
  // the user's fonts of the "Text" tab: plugin — the user's server section (a font too big for it stays in this browser),
  // standalone — this browser
  const userFonts = createUserFonts(plugin
    ? { server: store, storage: safeLocalStorage(), localKey: `neptune-plotter.plugin-fonts.${env.user || ''}` }
    : { storage: safeLocalStorage() });
  const printTab = createPrintTab({ state, store, service, transport, connection, calibrator, ui: plugin ? plugin.ui : { feed, firmware, limits } });
  const tabs = createTabHost({
    nav: document.getElementById('tabs'),
    panels: document.getElementById('panels'),
    tabs: [
      sourceTab(createSvgSource()), sourceTab(createPhotoSource()),
      sourceTab(createTextSource({ createModel: () => createTextModel({ userFonts }) })),
      { id: 'print', get title() { return printTab.title; }, mount: (view) => printTab.mount(view), unmount: () => printTab.unmount() },
    ],
  });

  // Header: the connection indicator next to the title, the language switch (all tabs, both modes).
  let header = { destroy() {} };
  const mountHeader = () => {
    const indicator = createConnectionIndicator(connection);
    const lang = createLanguageSwitch(language);
    document.querySelector('header h1').after(indicator.element);
    headerTools().prepend(lang.element);
    header = { select: lang.select, destroy() { indicator.destroy(); indicator.element.remove(); lang.element.remove(); } };
  };
  // Live language switch: the static markup is already translated, here the views are rebuilt in place. Services (state,
  // transport, feed, monitors, calibration) and the tab models stay: the drawing, loaded files, running computations,
  // the active tab and the preview zoom survive.
  const language = createLanguageControl({
    env, choice,
    rebuild: () => {
      const y = window.scrollY;
      header.destroy();
      mountHeader();
      tabs.rebuild();
      window.scrollTo(0, y);
      if (header.select) header.select.focus();
    },
  });
  mountHeader();
  tabs.mount();
  connection.start();
  if (feed) feed.start();

  // after loading a drawing, show the result immediately
  state.subscribe((e) => { if (e.type === 'drawing') tabs.show('print'); });
}

start().catch((e) => {
  document.getElementById('panels').textContent = t('app.startFailed', { message: e.message });
  console.error(e);
});
