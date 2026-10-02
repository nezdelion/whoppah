// A tiny helper for building DOM without markup in strings; the shared button with a hint.
import { t } from '../../i18n/index.js';

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && k !== 'list') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/**
 * A sign (⚠, ?) that shows its text under the control on click, Enter or Space and hides it on the next one;
 * the click does not reach the control (a checkbox is not toggled, a button is not pressed). The text is also the hover title.
 * @returns {{ icon: HTMLElement, text: HTMLElement }}
 */
export function disclosure(symbol, text, { iconClass = 'hint-icon', textClass = 'hint-text' } = {}) {
  const body = h('span', { class: textClass, hidden: true, onclick: (e) => e.preventDefault() }, text);
  const toggle = (e) => {
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    body.hidden = !body.hidden;
    icon.setAttribute('aria-expanded', String(!body.hidden));
  };
  const icon = h('span', {
    class: iconClass, title: text, tabindex: 0, role: 'button', 'aria-label': t('form.more'), 'aria-expanded': 'false',
    onclick: toggle,
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') toggle(e); },
  }, symbol);
  return { icon, text: body };
}

/**
 * Every button of the app. hint — a dictionary key (a literal: tests check that each one exists in en and ru):
 * the text is the hover title, and on devices without hover the "?" sign next to the button shows it under the button.
 * Returns the wrapper: wrapper.button is the <button>, wrapper.disabled is passed to it, hidden hides the whole wrapper.
 */
export function button({ label, hint, onclick, hidden = false, ...attrs }) {
  const text = t(hint);
  const btn = h('button', { type: 'button', title: text, ...attrs, onclick }, label);
  const { icon, text: body } = disclosure('?', text);
  const wrap = h('span', { class: 'btn-wrap', hidden }, btn, icon, body);
  Object.defineProperty(wrap, 'disabled', { get: () => btn.disabled, set: (v) => { btn.disabled = v; }, configurable: true });
  wrap.button = btn;
  return wrap;
}
