// Style registry: description, parameters, worker creation. The "Photo" tab knows only this interface.
// Descriptor: { id, name, group, origin: 'plotterfun'|'own', params: [...]|'dynamic', adapter: 'plotterfun'|'native',
//   createWorker(), spacing?(params, image, paper) -> px|null,
//   usesPaper?: true — size parameters are in mm on paper: the run gets paper { mmPerPx, penWidthMm } and the layer is
//                      recomputed when the field, margin, rotation or pen width change the paper scale;
//   presets?: [{ id, label (lazy), params: {...partial values} }] — style presets offered in the layer card }
// Parameter description: { key, label, type: 'number'|'bool'|'select', min, max, step, options, optionLabel?(value), default, live }
import { defaultParams as crosshatchDefaults, PARAMS as CROSSHATCH_PARAMS } from './own/crosshatch.js';
import { PARAMS as WAVES_PARAMS, PRESETS as WAVES_PRESETS, spacingPx as wavesSpacing } from './own/waves.js';
import { PARAMS as ENGRAVING_PARAMS, PRESETS as ENGRAVING_PRESETS, spacingPx as engravingSpacing } from './own/engraving.js';
import { createPlotterfunSession } from './plotterfun-adapter.js';
import { createNativeSession } from './native-adapter.js';
import { t } from '../i18n/index.js';

// Group identifiers; the label is groupLabel(id) from the dictionary (style.group.<id>)
export const GROUPS = Object.freeze({ lines: 'lines', contour: 'contour', dots: 'dots', patterns: 'patterns' });
export const groupLabel = (id) => t(`style.group.${id}`);

const PF_HOST = new URL('./plotterfun-host.js', import.meta.url).href;

// Step between lines in image px where it is known from the plotterfun style parameters.
const PF_SPACING = {
  squiggle: (p, img) => Math.floor(img.height / p['Line Count']),
  squiggleLeftRight: (p, img) => Math.floor(img.height / p['Line Count']),
  sawtooth: (p, img) => Math.floor(img.height / p['Line Count']),
  subline: (p, img) => Math.floor(img.height / p['Line Count']),
  linescan: (p) => p.Spacing,
  longwave: (p) => 2 * p['Step size'],
};

const ownWorker = () => new Worker(new URL('./own/worker.js', import.meta.url), { type: 'module' });

const pf = (style, name, group, extra = {}) => ({
  id: `pf:${style}`, name, group, origin: 'plotterfun', params: 'dynamic', adapter: 'plotterfun', pfStyle: style,
  createWorker: () => new Worker(PF_HOST),
  spacing: PF_SPACING[style],
  ...extra,
});

export const STYLES = Object.freeze([
  {
    id: 'own:waves', get name() { return t('style.name.waves'); }, group: GROUPS.lines, origin: 'own',
    params: WAVES_PARAMS, adapter: 'native', usesPaper: true, presets: WAVES_PRESETS,
    createWorker: ownWorker,
    spacing: (p, img, paper) => wavesSpacing(p, paper),
  },
  pf('squiggle', 'Squiggle', GROUPS.lines),
  pf('squiggleLeftRight', 'Squiggle left-right', GROUPS.lines),
  pf('spiral', 'Spiral', GROUPS.lines),
  pf('polyspiral', 'Polyspiral', GROUPS.lines),
  pf('subline', 'Subline', GROUPS.lines),
  pf('sawtooth', 'Sawtooth', GROUPS.lines),
  pf('springs', 'Springs', GROUPS.lines),
  pf('waves', 'Waves', GROUPS.lines),
  pf('longwave', 'Longwave', GROUPS.lines),
  pf('linescan', 'Linescan', GROUPS.lines, { commonTone: true }),
  pf('linedraw', 'Linedraw', GROUPS.contour),
  {
    id: 'own:engraving', get name() { return t('style.name.engraving'); }, group: GROUPS.contour, origin: 'own',
    params: ENGRAVING_PARAMS, adapter: 'native', usesPaper: true, presets: ENGRAVING_PRESETS,
    createWorker: ownWorker,
    spacing: (p, img, paper) => engravingSpacing(p, paper),
  },
  {
    id: 'own:crosshatch', name: 'Crosshatch', group: GROUPS.contour, origin: 'own',
    params: CROSSHATCH_PARAMS, adapter: 'native',
    createWorker: ownWorker,
    spacing: (p) => p.spacing,
  },
  pf('halftone', 'Halftone', GROUPS.dots),
  pf('stipple', 'Stipple', GROUPS.dots),
  pf('delaunay', 'Delaunay', GROUPS.dots),
  pf('dots', 'Dots', GROUPS.dots),
  pf('jaggy', 'Jaggy', GROUPS.dots),
  pf('peano', 'Peano', GROUPS.patterns),
  pf('woven', 'Woven', GROUPS.patterns),
  pf('needles', 'Needles', GROUPS.patterns),
  pf('boxes', 'Boxes', GROUPS.patterns),
  pf('mosaic', 'Mosaic', GROUPS.patterns),
  pf('implode', 'Implode', GROUPS.patterns),
  pf('margins', 'Margins', GROUPS.patterns),
]);

const BY_ID = new Map(STYLES.map((s) => [s.id, s]));
export const getStyle = (id) => BY_ID.get(id) || null;

/** Styles by group in registry order: [{group, styles}] */
export function groupedStyles() {
  const out = [];
  for (const s of STYLES) {
    let g = out.find((x) => x.group === s.group);
    if (!g) out.push(g = { group: s.group, styles: [] });
    g.styles.push(s);
  }
  return out;
}

export const originLabel = (s) => (s.origin === 'plotterfun' ? 'plotterfun' : t('style.origin.own'));

export const defaultsOfParams = (params) => Object.fromEntries(params.map((p) => [p.key, p.default]));
export { crosshatchDefaults };

/** Session factory for the runner: modelOf(styleName) — from plotterfun-models. */
export function sessionFactory(modelOf) {
  return (descriptor) => (descriptor.adapter === 'plotterfun'
    ? createPlotterfunSession({ style: descriptor.pfStyle, model: modelOf(descriptor.pfStyle), commonTone: !!descriptor.commonTone })
    : createNativeSession(descriptor));
}
