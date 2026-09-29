// Estimate of the minimum line step of a layer on paper and comparison with the pen width. No DOM.

/** The "image pixel -> mm" scale when laying out on the field (the same formula as core/layout.js for a drawing the size of the image). */
export function scaleToPaper(image, { fieldMm, marginMm, rotate }) {
  const aw = fieldMm.w - 2 * marginMm, ah = fieldMm.h - 2 * marginMm;
  if (!(aw > 0 && ah > 0)) return null;
  const w = rotate ? image.height : image.width, h = rotate ? image.width : image.height;
  return Math.min(aw / w, ah / h);
}

/**
 * @param spacingPx step between lines in image px (null — unknown)
 * @returns null (check impossible) | {stepMm, tooDense}
 */
export function estimateSpacing(spacingPx, image, printParams) {
  if (!(spacingPx > 0) || !image) return null;
  const s = scaleToPaper(image, printParams);
  if (!s) return null;
  const stepMm = spacingPx * s;
  return { stepMm, tooDense: stepMm < printParams.penWidthMm };
}

const fmt = (v) => (Math.round(v * 100) / 100).toString();

export function densityText(est, penWidthMm) {
  if (!est) return '';
  return est.tooDense
    ? `шаг ${fmt(est.stepMm)} мм меньше ширины пера ${fmt(penWidthMm)} мм: линии сливаются`
    : `шаг ${fmt(est.stepMm)} мм`;
}
