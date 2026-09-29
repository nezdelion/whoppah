// Dependency boundary check: core, transport, storage — only within their own layer; app — anywhere.
// styles: styles/tone.js and styles/own/* — only core and each other (pure functions, no DOM);
// the rest of styles — core and styles; core, transport and storage do not know about styles.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

const LAYERS = ['core', 'transport', 'storage', 'styles', 'app'];
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

const isPureStyle = (rel) => rel[0] === 'styles' && (rel[1] === 'tone.js' || (rel[1] === 'own' && rel[2] !== 'worker.js'));
const isInPureStyleZone = (rel) => rel[0] === 'styles' && (rel[1] === 'tone.js' || rel[1] === 'own');

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
      if (layer === 'styles') {
        const target = relative(srcDir, resolve(dirname(file), spec)).split(sep);
        const ok = isPureStyle(rel) ? target[0] === 'core' || isInPureStyleZone(target) : target[0] === 'core' || target[0] === 'styles';
        if (!ok) violations.push(`${rel.join('/')}: ${isPureStyle(rel) ? 'чистый стиль' : 'styles'} не может импортировать ${spec}`);
        continue;
      }
      if (!ISOLATED.has(layer)) continue;
      const target = relative(srcDir, resolve(dirname(file), spec)).split(sep)[0];
      if (target !== layer) violations.push(`${rel.join('/')}: слой ${layer} не может импортировать ${spec}`);
    }
    if ((layer === 'core' || isPureStyle(rel)) && DOM_GLOBALS.test(source)) {
      violations.push(`${rel.join('/')}: ${layer === 'core' ? 'core' : 'чистый стиль'} обращается к DOM, сети или хранилищу`);
    }
  }
  return violations;
}
