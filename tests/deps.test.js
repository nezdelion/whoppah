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
