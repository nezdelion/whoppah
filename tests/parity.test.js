import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importSvg } from '../src/core/svg-import.js';
import { buildPlan, fieldOf, cornerOf } from '../src/core/pipeline.js';
import { legacyToSettings } from './helpers/legacy.js';
import { loadTree, fixturesDir } from './helpers/fixtures.js';
import './helpers/ru.js';

const cases = JSON.parse(readFileSync(join(fixturesDir, 'cases.json'), 'utf8'));

function runNew(svgName, options) {
  const settings = legacyToSettings(options);
  const drawing = importSvg(loadTree(svgName), {
    fit: { fieldMm: fieldOf(settings.job), marginMm: settings.job.marginMm, rotate: settings.job.rotate },
  });
  return buildPlan(drawing, settings);
}

for (const c of cases) {
  test(`G-code parity with the old implementation: ${c.name}`, () => {
    const expected = readFileSync(join(fixturesDir, `${c.name}.gcode`), 'utf8').split('\n');
    const actual = runNew(c.svg, c.options).gcode.split('\n');
    assert.equal(actual.length, expected.length, 'line count');
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) assert.fail(`строка ${i + 1}: «${actual[i]}» вместо «${expected[i]}»`);
    }
  });
}

test('golden files contain layers/lines (the set is not empty)', () => {
  assert.ok(cases.length >= 5);
  assert.ok(runNew('use-hidden.svg', {}).stats.lines >= 3);
});

test('default simplification reduces the point count, the parity mode does not', () => {
  const settings = legacyToSettings({});
  const drawing = importSvg(loadTree('arcs.svg'), { fit: { fieldMm: fieldOf(settings.job), marginMm: 5, rotate: false } });
  const off = buildPlan(drawing, settings);
  const on = buildPlan(drawing, { ...settings, job: { ...settings.job, simplifyTolMm: 0.05 } });
  assert.ok(on.optimization.pointsAfter < off.optimization.pointsAfter);
  assert.deepEqual(cornerOf(settings.calibration), { x: -5, y: 50 });
});
