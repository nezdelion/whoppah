// A folded section: <details> with a summary; the open state is remembered per id in the browser (localStorage).
import { h } from './dom.js';

export const FOLD_KEY = (id) => `neptune-plotter.fold.${id}`;

const readOpen = (id, fallback) => {
  try { const v = localStorage.getItem(FOLD_KEY(id)); return v === null ? fallback : v === '1'; } catch (e) { return fallback; }
};
const writeOpen = (id, open) => { try { localStorage.setItem(FOLD_KEY(id), open ? '1' : '0'); } catch (e) { /* no storage */ } };

/**
 * @param id    storage id of the fold
 * @param title summary text
 * @param open  default state when nothing is remembered
 * @param note  optional text under the summary
 */
export function fold({ id, title, open = false, note = '' }, ...children) {
  const details = h('details', { class: 'fold', open: readOpen(id, open) });
  details.addEventListener('toggle', () => writeOpen(id, !!details.open));
  details.append(h('summary', {}, title), note ? h('div', { class: 'note fold-note' }, note) : null, ...children);
  return details;
}
