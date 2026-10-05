// The only place that knows the processing order: layout -> optimization -> G-code.
import { layout, resolveField, sheetWarnings, fitRectFor } from './layout.js';
import { optimize } from './optimize.js';
import { generateGcode } from './gcode.js';
import { printArea } from './bed.js';

export function fieldOf(job) {
  return resolveField(job);
}

export const cornerOf = (calibration) => ({ x: calibration.cornerX, y: calibration.cornerY });

/**
 * The fit rectangle of the job in sheet coordinates, or null: without the "Limit to print area" option,
 * or when the print area does not cut the field minus margins (then the layout is exactly as without the option).
 */
export function fitRectOf({ profile, calibration, job }) {
  if (!job.fitPrintArea) return null;
  return fitRectFor(fieldOf(job), job.marginMm, cornerOf(calibration), printArea(profile));
}

/** The fit rectangle in printer coordinates (for the preview), or null. */
export function fitRectMachine(settings) {
  const r = fitRectOf(settings);
  if (!r || r.empty) return null;
  const c = cornerOf(settings.calibration);
  return { x0: c.x + r.x0, y0: c.y + r.y0, x1: c.x + r.x1, y1: c.y + r.y1 };
}

/** Sheet warnings that do not depend on the drawing: the sheet against the print area. */
export function sheetCheck({ profile, calibration, job }) {
  return sheetWarnings(fieldOf(job), cornerOf(calibration), printArea(profile), { fitted: !!job.fitPrintArea });
}

/**
 * @param drawing  Drawing in document coordinates
 * @param settings { profile, calibration, job }
 * @param hooks    { beforeLayer?, firmware? } — firmware: firmware settings (M503), only for the time estimate
 * @returns { machine, gcode, stats, warnings, outOfLimits, outOfArea, outOfBed, bedChecked, optimization, field }
 * Throws DrawingError if the drawing cannot be laid out or is empty.
 */
export function buildPlan(drawing, { profile, calibration, job }, hooks = {}) {
  const field = fieldOf(job);
  const corner = cornerOf(calibration);
  const laidOut = layout(drawing, {
    field, corner, marginMm: job.marginMm, halign: job.halign, valign: job.valign,
    rotate: job.rotate, asIs: job.asIs, fitRect: fitRectOf({ profile, calibration, job }),
  });
  const { drawing: machine, report } = optimize(laidOut, {
    simplifyTolMm: job.simplifyTolMm, mergeTolMm: job.mergeTolMm, linkTolMm: job.linkTolMm, start: [corner.x, corner.y],
    keepOrder: !!drawing.meta.keepOrder, // e.g. text: written in reading and stroke order, not nearest-first from the corner
  });
  const out = generateGcode(machine, { profile, calibration, beforeLayer: hooks.beforeLayer, firmware: hooks.firmware });
  return { machine, ...out, optimization: report, field, corner };
}
