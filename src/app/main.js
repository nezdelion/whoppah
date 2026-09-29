// Composition root: choosing implementations (storage, transport, auth), assembling the tabs.
import { LocalStorageStore, migrateLegacy } from '../storage/settings-store.js';
import { createOctoPrintTransport } from '../transport/octoprint-http.js';
import { createApiKeyAuth } from '../transport/auth-api-key.js';
import { createState, createSourceContext } from './state.js';
import { createPrintService } from './print/print-service.js';
import { limitsCheck, partialCheck } from './print/checks.js';
import { createSvgSource } from './tabs/svg-tab.js';
import { createPrintTab } from './tabs/print-tab.js';
import { h } from './ui/dom.js';

async function start() {
  const store = new LocalStorageStore(localStorage);
  await migrateLegacy(localStorage, store);
  const state = createState({ store });
  await state.load();

  const transport = createOctoPrintTransport({
    getBaseUrl: () => state.get('connection').url,
    auth: createApiKeyAuth({ getKey: () => state.get('connection').key }),
  });
  const service = createPrintService({
    transport,
    getSettings: () => state.settings(),
    confirm: (message) => Promise.resolve(window.confirm(message)),
    preflight: [limitsCheck, partialCheck],
  });

  const tabs = [
    ...[createSvgSource()].map((source) => ({ id: source.id, title: source.title, source })),
    { id: 'print', title: 'Печать', tab: createPrintTab({ state, store, service, transport }) },
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

  // after loading a drawing, show the result immediately
  state.subscribe((e) => { if (e.type === 'drawing') show('print'); });
}

start().catch((e) => {
  document.getElementById('panels').textContent = `Не удалось запустить приложение: ${e.message}`;
  console.error(e);
});
