// Generates the golden G-code with the old implementation (tests/tools/legacy-core.cjs) into tests/fixtures/*.gcode.
// Run: node tests/tools/gen-golden.js
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseXml } from '../helpers/xml.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const legacy = createRequire(import.meta.url)('./legacy-core.cjs');

const cases = JSON.parse(readFileSync(join(fixtures, 'cases.json'), 'utf8'));
for (const c of cases) {
  const tree = parseXml(readFileSync(join(fixtures, c.svg), 'utf8'));
  const { gcode } = legacy.plan(tree, c.options);
  writeFileSync(join(fixtures, `${c.name}.gcode`), gcode);
  console.log(`${c.name}.gcode: ${gcode.split('\n').length - 1} строк`);
}
