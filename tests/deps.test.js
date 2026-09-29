import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeps, importsOf } from './helpers/deps.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('the real sources do not violate layer boundaries', () => {
  assert.deepEqual(checkDeps(srcDir), []);
});

test('import parsing: static, side-effect, export from, dynamic', () => {
  const src = `import a from './a.js';\nimport { b } from "../b.js";\nimport './c.js';\nexport * from './d.js';\nconst x = await import('./e.js');`;
  assert.deepEqual(importsOf(src), ['./a.js', '../b.js', './c.js', './d.js', './e.js']);
});

test('a forbidden import is found, after removal the check passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'));
  try {
    mkdirSync(join(dir, 'core'));
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'x.js'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'core', 'ok.js'), "import { y } from './y.js';\n");
    writeFileSync(join(dir, 'core', 'bad.js'), "import { x } from '../app/x.js';\n");
    const bad = checkDeps(dir);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /core\/bad\.js/);
    writeFileSync(join(dir, 'core', 'bad.js'), 'export const ok = 1;\n');
    assert.deepEqual(checkDeps(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test('core must not touch the DOM and network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'));
  try {
    mkdirSync(join(dir, 'core'));
    writeFileSync(join(dir, 'core', 'dom.js'), 'export const t = document.title;\n');
    assert.equal(checkDeps(dir).length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test('external packages are forbidden everywhere', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'));
  try {
    mkdirSync(join(dir, 'app'));
    writeFileSync(join(dir, 'app', 'a.js'), "import x from 'lodash';\n");
    assert.equal(checkDeps(dir).length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test('styles: pure styles — core only; other styles — core and styles; app is not pulled in from styles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deps-'));
  try {
    for (const d of ['core', 'app', 'styles', 'styles/own']) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, 'app', 'x.js'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'core', 'c.js'), 'export const c = 1;\n');
    writeFileSync(join(dir, 'styles', 'tone.js'), "import { c } from '../core/c.js';\n");
    writeFileSync(join(dir, 'styles', 'own', 'a.js'), "import { t } from '../tone.js';\nimport { c } from '../../core/c.js';\n");
    writeFileSync(join(dir, 'styles', 'own', 'worker.js'), "import { r } from '../protocol.js';\nself.onmessage = null;\n");
    writeFileSync(join(dir, 'styles', 'runner.js'), "import { c } from '../core/c.js';\nimport { t } from './tone.js';\n");
    assert.deepEqual(checkDeps(dir), [], 'worker.js and runner.js may use protocol.js and tone.js');

    writeFileSync(join(dir, 'styles', 'own', 'a.js'), "import { r } from '../runner.js';\n");
    assert.match(checkDeps(dir).join('\n'), /own\/a\.js/);
    writeFileSync(join(dir, 'styles', 'own', 'a.js'), 'export const ok = 1;\n');
    writeFileSync(join(dir, 'styles', 'tone.js'), 'export const t = document.title;\n');
    assert.match(checkDeps(dir).join('\n'), /tone\.js.*DOM/);
    writeFileSync(join(dir, 'styles', 'tone.js'), 'export const t = 1;\n');
    writeFileSync(join(dir, 'styles', 'runner.js'), "import { x } from '../app/x.js';\n");
    assert.match(checkDeps(dir).join('\n'), /runner\.js/);
    writeFileSync(join(dir, 'styles', 'runner.js'), 'export const r = 1;\n');
    writeFileSync(join(dir, 'core', 'c.js'), "import { r } from '../styles/runner.js';\n");
    assert.match(checkDeps(dir).join('\n'), /core\/c\.js/);
  } finally { rmSync(dir, { recursive: true }); }
});
