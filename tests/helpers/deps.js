// Dependency boundary check: core, transport, storage — only within their own layer; app — anywhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

const LAYERS = ['core', 'transport', 'storage', 'app'];
const ISOLATED = new Set(['core', 'transport', 'storage']);
const DOM_GLOBALS = /\b(?:document|window|navigator|globalThis)\s*\.|\b(?:localStorage|sessionStorage|DOMParser|Worker|XMLHttpRequest)\b|\bfetch\s*\(/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

export function importsOf(source) {
  const out = [];
  const re = /(?:^|[;\s])(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source))) out.push(m[1] || m[2]);
  return out;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** @returns violation lines; an empty array — all fine */
export function checkDeps(srcDir) {
  const violations = [];
  for (const file of walk(srcDir)) {
    const rel = relative(srcDir, file).split(sep);
    const layer = rel[0];
    if (!LAYERS.includes(layer)) continue;
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const spec of importsOf(source)) {
      if (!spec.startsWith('.')) {
        violations.push(`${rel.join('/')}: внешний импорт «${spec}» (зависимостей нет)`);
        continue;
      }
      if (!ISOLATED.has(layer)) continue;
      const target = relative(srcDir, resolve(dirname(file), spec)).split(sep)[0];
      if (target !== layer) violations.push(`${rel.join('/')}: слой ${layer} не может импортировать ${spec}`);
    }
    if (layer === 'core' && DOM_GLOBALS.test(source)) {
      violations.push(`${rel.join('/')}: core обращается к DOM, сети или хранилищу`);
    }
  }
  return violations;
}
