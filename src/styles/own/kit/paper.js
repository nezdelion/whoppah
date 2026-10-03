// Paper scale for own styles whose size parameters are in mm on paper (descriptor usesPaper: true).
// The style gets paper = { mmPerPx, penWidthMm }: mmPerPx is the "working image px -> mm on the sheet" scale (the same as the
// density check in app/photo/density.js), penWidthMm is the pen width of the active profile. Pure functions, no DOM.

/** Without print parameters (tests, no field): 0.25 mm/px and a 0.5 mm pen. */
export const DEFAULT_PAPER = Object.freeze({ mmPerPx: 0.25, penWidthMm: 0.5 });

const positive = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

/** A valid paper object: missing or invalid fields are taken from DEFAULT_PAPER. */
export function paperOf(paper) {
  const p = paper || {};
  return { mmPerPx: positive(p.mmPerPx, DEFAULT_PAPER.mmPerPx), penWidthMm: positive(p.penWidthMm, DEFAULT_PAPER.penWidthMm) };
}

/** mm on paper -> working image px. */
export const mmToPx = (mm, paper) => mm / paperOf(paper).mmPerPx;

/** Working image px -> mm on paper. */
export const pxToMm = (px, paper) => px * paperOf(paper).mmPerPx;

/** Two papers give the same style result: mmPerPx within a relative 1e-6, the same pen width. */
export function samePaper(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(a.mmPerPx - b.mmPerPx) <= 1e-6 * Math.max(Math.abs(a.mmPerPx), Math.abs(b.mmPerPx)) && a.penWidthMm === b.penWidthMm;
}
