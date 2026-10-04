// Deep equality for big data (pixel arrays, direction fields, lines) without node:assert's diff: on a mismatch
// assert.deepEqual renders a full diff of both values, which for arrays of tens of thousands of numbers eats gigabytes.
// sameData reports only the path and the first differing value.
import { AssertionError } from 'node:assert';

const isList = (v) => Array.isArray(v) || ArrayBuffer.isView(v);
const show = (v) => (isList(v) ? `${v.constructor.name}(${v.length})` : JSON.stringify(v));

function diff(a, b, path) {
  if (Object.is(a, b)) return null;
  if (isList(a) && isList(b)) {
    if (a.length !== b.length) return `${path || 'value'}: length ${a.length} ≠ ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = diff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !isList(a) && !isList(b)) {
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    if (ka.join() !== kb.join()) return `${path || 'value'}: keys [${ka}] ≠ [${kb}]`;
    for (const k of ka) {
      const d = diff(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path || 'value'}: ${show(a)} ≠ ${show(b)}`;
}

/** Throws a short AssertionError at the first difference (arrays and typed arrays compare by elements). */
export function sameData(actual, expected, message = '') {
  const d = diff(actual, expected, '');
  if (d) throw new AssertionError({ message: message ? `${message}: ${d}` : d, operator: 'sameData' });
}
