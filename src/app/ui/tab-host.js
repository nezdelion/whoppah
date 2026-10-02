// Tab buttons and panels. Tabs are created once; their views can be rebuilt in place (live language switch): rebuild()
// unmounts every view and mounts it again, the tab objects with their models and the active tab stay.
import { h, button } from './dom.js';

/**
 * @param nav    the tab button container; panels — the panel container
 * @param tabs   [{ id, title (string or getter — read on every mount), mount(view), unmount?() }]
 * @returns {{ mount(), unmount(), rebuild(), show(id), active(): string }}
 */
export function createTabHost({ nav, panels, tabs }) {
  const buttons = new Map(), views = new Map();
  let active = tabs.length ? tabs[0].id : null, mounted = false;

  function show(id) {
    if (!tabs.some((tab) => tab.id === id)) return;
    active = id;
    for (const [tid, btn] of buttons) {
      btn.setAttribute('aria-selected', String(tid === id));
      views.get(tid).hidden = tid !== id;
    }
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    for (const tab of tabs) {
      const view = h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true });
      const btn = button({ label: tab.title, hint: 'tab.hint', role: 'tab', onclick: () => show(tab.id) });
      nav.append(btn);
      panels.append(view);
      buttons.set(tab.id, btn.button);
      views.set(tab.id, view);
      tab.mount(view);
    }
    show(active);
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    for (const tab of tabs) if (tab.unmount) tab.unmount();
    buttons.clear();
    views.clear();
    nav.replaceChildren();
    panels.replaceChildren();
  }

  return { mount, unmount, rebuild() { unmount(); mount(); }, show, active: () => active };
}
