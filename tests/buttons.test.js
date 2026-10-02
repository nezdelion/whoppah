// The shared button helper (hint: title + "?" with the text under the button) and the scan: every button goes through it.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeDom } from './helpers/fake-dom.js';
import { dictionaries, setLocale } from '../src/i18n/index.js';
import './helpers/ru.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
let button, disclosure;
before(async () => {
  installFakeDom();
  ({ button, disclosure } = await import('../src/app/ui/dom.js'));
});

const parts = (wrap) => ({ btn: wrap.children[0], sign: wrap.children[1], text: wrap.children[2] });

test('button: the title is the hint text, the "?" shows and hides it, the button is not pressed', () => {
  let pressed = 0;
  const wrap = button({ label: 'Перейти', hint: 'point.goTo.hint', onclick: () => pressed++ });
  const { btn, sign, text } = parts(wrap);
  assert.equal(btn.tagName, 'BUTTON');
  assert.equal(btn.type, 'button');
  assert.equal(btn.title, 'Поднимает перо, переводит к точке и опускает на зазор над касанием');
  assert.equal(sign.textContent, '?');
  assert.equal(sign.getAttribute('role'), 'button');
  assert.equal(text.hidden, true);
  sign.click();
  assert.equal(text.hidden, false);
  assert.equal(sign.getAttribute('aria-expanded'), 'true');
  assert.equal(text.textContent, btn.title);
  sign.click();
  assert.equal(text.hidden, true);
  assert.equal(pressed, 0, 'the "?" does not press the button');
  btn.click();
  assert.equal(pressed, 1);
});

test('button: Enter and Space toggle the hint; disabled and hidden are passed through', () => {
  const wrap = button({ label: 'x', hint: 'print.frame.hint', onclick: () => {}, hidden: true, class: 'primary' });
  const { btn, sign, text } = parts(wrap);
  assert.equal(wrap.hidden, true);
  assert.equal(btn.hidden, false);
  assert.equal(btn.className, 'primary');
  sign.dispatch('keydown', { key: 'Enter' });
  assert.equal(text.hidden, false);
  sign.dispatch('keydown', { key: ' ' });
  assert.equal(text.hidden, true);
  sign.dispatch('keydown', { key: 'a' });
  assert.equal(text.hidden, true);
  wrap.disabled = true;
  assert.equal(btn.disabled, true);
  assert.equal(wrap.button, btn);
});

test('button: the English hint of "Go to"', () => {
  setLocale('en');
  try {
    assert.equal(parts(button({ label: 'Go to', hint: 'point.goTo.hint' })).btn.title, 'Raises the pen, moves to the point and lowers it to the clearance above the touch');
  } finally { setLocale('ru'); }
});

test('disclosure is shared with the ⚠ of risky options: a click does not reach the control', () => {
  const { icon, text } = disclosure('⚠', 'риск', { iconClass: 'warn-icon', textClass: 'warn-text' });
  const ev = icon.click();
  assert.equal(ev.defaultPrevented, true);
  assert.equal(text.hidden, false);
  assert.equal(icon.className, 'warn-icon');
});

// --- scan of the sources

const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

/** The argument text of every call `button(` (balanced parentheses, strings skipped). */
function buttonCalls(src) {
  const out = [];
  const re = /(?<![\w.$])button\(/g;
  let m;
  while ((m = re.exec(src))) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition
    let depth = 1, i = m.index + m[0].length, q = null;
    for (; i < src.length && depth; i++) {
      const c = src[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
      if (c === '\'' || c === '"' || c === '`') q = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

test('scan: no h(\'button\' outside the helper; every button( has a literal hint key present in en and ru', () => {
  const bad = [];
  let calls = 0;
  for (const file of walk(srcDir)) {
    const rel = file.slice(srcDir.length + 1);
    const src = readFileSync(file, 'utf8');
    if (rel !== 'app/ui/dom.js' && /h\(\s*['"]button['"]/.test(src)) bad.push(`${rel}: h('button' outside the helper`);
    if (/createElement\(\s*['"]button['"]/.test(src)) bad.push(`${rel}: createElement('button')`);
    if (rel === 'app/ui/dom.js') continue;
    for (const call of buttonCalls(src)) {
      calls++;
      const m = /\bhint:\s*'([\w.]+)'/.exec(call);
      if (!m) { bad.push(`${rel}: no literal hint in ${call.slice(0, 60)}`); continue; }
      for (const lang of ['en', 'ru']) if (!(m[1] in dictionaries[lang])) bad.push(`${rel}: ${m[1]} missing in ${lang}`);
    }
  }
  assert.deepEqual(bad, []);
  assert.ok(calls >= 40, `all buttons go through the helper (${calls} calls)`);
});
