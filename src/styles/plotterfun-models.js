// Execution models of plotterfun styles: the plotterfun-completion.json manifest applies only to the commit
// vendor/plotterfun/UPSTREAM for which it was verified. Otherwise (mismatch, no file, garbage) — none for all.
import { MODELS } from './protocol.js';

/** The first line of UPSTREAM is the full commit hash; the other lines are informational. */
export function parseUpstream(text) {
  const first = String(text || '').split(/\r?\n/, 1)[0].trim();
  return /^[0-9a-f]{40}$/.test(first) ? first : null;
}

/** @returns (styleName) => 'sync'|'async-handler'|'timer-chain'|'none' */
export function resolveModels(manifest, upstreamText) {
  const commit = parseUpstream(upstreamText);
  const valid = !!(commit && manifest && manifest.vendorCommit === commit && manifest.styles && typeof manifest.styles === 'object');
  return (name) => {
    if (!valid) return 'none';
    const model = manifest.styles[name];
    return MODELS.includes(model) ? model : 'none';
  };
}

/** Loading the manifest and UPSTREAM via fetchText(url) -> Promise<string>; any error gives none for all. */
export async function loadModels(fetchText, { manifestUrl, upstreamUrl }) {
  try {
    const [manifestText, upstreamText] = await Promise.all([fetchText(manifestUrl), fetchText(upstreamUrl)]);
    return resolveModels(JSON.parse(manifestText), upstreamText);
  } catch (e) {
    return resolveModels(null, null);
  }
}
