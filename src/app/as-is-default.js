// "As is in mm" follows the drawing source: text is sized in mm (cap height), so a text drawing switches the job option on;
// it stays an ordinary option the user can switch off to scale the text. A drawing from another source puts back what
// the option was before the text, unless the user changed the option meanwhile (then their choice stays).

/** Sources whose drawings are laid out at their real size by default. */
export const AS_IS_SOURCES = Object.freeze(['text']);

/**
 * @param state  app state (subscribe, get, patch, drawingSource)
 * @returns { destroy() }
 */
export function followAsIsDefault(state) {
  let restore = null; // the value to put back for a non-text drawing; null — nothing was switched by us
  let ours = false;   // our own patch is being applied (its settings event is not a user change)
  const set = (v) => { ours = true; try { state.patch('job', { asIs: v }); } finally { ours = false; } };
  const off = state.subscribe((e) => {
    if (e.type === 'settings' && (e.section === 'job' || e.section === '*') && !ours) restore = null; // the user decided
    if (e.type !== 'drawing' || !state.drawing()) return;
    const asIs = !!state.get('job').asIs;
    if (AS_IS_SOURCES.includes(state.drawingSource())) {
      if (!asIs) { set(true); restore = false; }
    } else if (restore !== null) {
      if (asIs !== restore) set(restore);
      restore = null;
    }
  });
  return { destroy: off };
}
