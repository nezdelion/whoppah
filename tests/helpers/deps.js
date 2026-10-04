// Dependency boundary check: core, transport, storage — only within their own layer; app — anywhere.
// styles: styles/tone.js, styles/prep.js and styles/own/* (including own/kit/*, except own/worker.js) — only core and each other (pure functions, no DOM);
// the rest of styles — core and styles; core, transport and storage do not know about styles.
// i18n is a leaf layer: it imports nothing outside i18n and does not touch the DOM; it can be imported from any layer
// (core returns ready-made error and warning texts, so it needs t()).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

const LAYERS = ['core', 'transport', 'storage', 'styles', 'app', 'i18n'];
const ISOLATED = new Set(['core', 'transport', 'storage', 'i18n']);
const LEAF = 'i18n';
const DOM_GLOBALS = /\b(?:document|window|navigator|globalThis)\s*\.|\b(?:localStorage|sessionStorage|DOMParser|Worker|XMLHttpRequest)\b|\bfetch\s*\(/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
  });
}

export function importsOf(source) {
  const out = [];
  // import/export — only at the start of a line or after ";": the word "export" at the end of a string literal (i18n dictionaries) is not an import
  const re = /(?:^|;)[ \t]*(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
  let m;
  while ((m = re.exec(source))) out.push(m[1] || m[2]);
  return out;
}

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PURE_STYLE_FILES = new Set(['tone.js', 'prep.js']);
const isPureStyle = (rel) => rel[0] === 'styles' && (PURE_STYLE_FILES.has(rel[1]) || (rel[1] === 'own' && rel[2] !== 'worker.js'));
const isInPureStyleZone = (rel) => rel[0] === 'styles' && (PURE_STYLE_FILES.has(rel[1]) || rel[1] === 'own');

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
        const ok = target[0] === LEAF || (isPureStyle(rel) ? target[0] === 'core' || isInPureStyleZone(target) : target[0] === 'core' || target[0] === 'styles');
        if (!ok) violations.push(`${rel.join('/')}: ${isPureStyle(rel) ? 'чистый стиль' : 'styles'} не может импортировать ${spec}`);
        continue;
      }
      if (!ISOLATED.has(layer)) continue;
      const target = relative(srcDir, resolve(dirname(file), spec)).split(sep)[0];
      if (target !== layer && !(target === LEAF && layer !== LEAF)) violations.push(`${rel.join('/')}: слой ${layer} не может импортировать ${spec}`);
    }
    if ((layer === 'core' || layer === LEAF || isPureStyle(rel)) && DOM_GLOBALS.test(source)) {
      violations.push(`${rel.join('/')}: ${layer === 'core' || layer === LEAF ? layer : 'чистый стиль'} обращается к DOM, сети или хранилищу`);
    }
  }
  return violations;
}
