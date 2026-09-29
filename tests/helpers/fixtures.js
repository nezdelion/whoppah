import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml } from './xml.js';

export const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const readFixture = (name) => readFileSync(join(fixturesDir, name), 'utf8');
export const loadTree = (name) => parseXml(readFixture(name));

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

export const closeTo = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
