// The only place that knows the processing order: layout -> optimization -> G-code.
import { layout, resolveField, sheetWarnings } from './layout.js';
import { optimize } from './optimize.js';
import { generateGcode } from './gcode.js';
import { axisLimits } from './profile.js';

export function fieldOf(job) {
  return resolveField(job);
}

export const cornerOf = (calibration) => ({ x: calibration.cornerX, y: calibration.cornerY });

/** Sheet warnings that do not depend on the drawing. */
export function sheetCheck({ profile, calibration, job }) {
  return sheetWarnings(fieldOf(job), cornerOf(calibration), axisLimits(profile));
}

/**
 * @param drawing  Drawing in document coordinates
 * @param settings { profile, calibration, job }
 * @param hooks    { beforeLayer?, firmware? } — firmware: firmware settings (M503), only for the time estimate
 * @returns { machine, gcode, stats, warnings, outOfLimits, optimization, field }
 * Throws DrawingError if the drawing cannot be laid out or is empty.
 */
export function buildPlan(drawing, { profile, calibration, job }, hooks = {}) {
  const field = fieldOf(job);
  const corner = cornerOf(calibration);
  const laidOut = layout(drawing, {
    field, corner, marginMm: job.marginMm, halign: job.halign, valign: job.valign,
    rotate: job.rotate, asIs: job.asIs,
  });
  const { drawing: machine, report } = optimize(laidOut, {
    simplifyTolMm: job.simplifyTolMm, mergeTolMm: job.mergeTolMm, linkTolMm: job.linkTolMm, start: [corner.x, corner.y],
  });
  const out = generateGcode(machine, { profile, calibration, beforeLayer: hooks.beforeLayer, firmware: hooks.firmware });
  return { machine, ...out, optimization: report, field, corner };
}
