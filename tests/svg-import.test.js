import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importSvg, SvgImportError } from '../src/core/svg-import.js';
import { bbox, allLines } from '../src/core/drawing.js';
import { parseXml } from './helpers/xml.js';
import { loadTree, closeTo } from './helpers/fixtures.js';

const svg = (body, attrs = '') => parseXml(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ${attrs}>${body}</svg>`);

test('a path with an arc: the polyline lies on the ellipse', () => {
  const d = importSvg(svg('<path d="M0 0 A 30 20 0 0 1 60 0"/>'), { chordMm: 0.5 });
  const line = allLines(d)[0];
  for (let i = 0; i < line.length; i += 2) {
    const v = ((line[i] - 30) / 30) ** 2 + (line[i + 1] / 20) ** 2;
    assert.ok(Math.abs(v - 1) < 1e-3);
  }
  assert.ok(line.length > 20);
});

test('all shapes are imported', () => {
  const d = importSvg(loadTree('shapes.svg'));
  assert.equal(allLines(d).length, 6);
});

test('a rounded rectangle has arcs and stays within the bounds', () => {
  const d = importSvg(svg('<rect x="0" y="0" width="40" height="20" rx="5"/>'), { chordMm: 0.5 });
  const b = bbox(d);
  assert.ok(closeTo(b.w, 40, 1e-6) && closeTo(b.h, 20, 1e-6));
  assert.ok(allLines(d)[0].length > 40, 'corners are rounded');
  const line = allLines(d)[0];
  for (let i = 0; i < line.length; i += 2) assert.ok(Math.hypot(line[i], line[i + 1]) > 1.4, 'corner (0,0) cut off by rounding');
});

test('use by href and xlink:href with an offset and a transform', () => {
  const tree = svg('<defs><line id="a" x1="0" y1="0" x2="10" y2="0"/></defs><use href="#a" x="5" y="7"/><use xlink:href="#a" transform="translate(0 100)" x="1"/>');
  const lines = allLines(importSvg(tree));
  assert.deepEqual(lines[0], [5, 7, 15, 7]);
  assert.deepEqual(lines[1], [1, 100, 11, 100]);
});

test('nested groups: translate and rotate in nesting order', () => {
  const tree = svg('<g transform="translate(10 0)"><g transform="rotate(90)"><line x1="0" y1="0" x2="5" y2="0"/></g></g>');
  const [line] = allLines(importSvg(tree));
  assert.ok(closeTo(line[0], 10) && closeTo(line[1], 0) && closeTo(line[2], 10) && closeTo(line[3], 5));
});

test('hidden and defs are skipped, text and images give a warning', () => {
  const tree = svg('<defs><line x1="0" y1="0" x2="1" y2="1"/></defs><line x1="0" y1="0" x2="1" y2="0" display="none"/><line x1="0" y1="0" x2="2" y2="0" style="visibility: hidden"/><text>a</text><text>b</text><text>c</text><image href="x"/><line x1="0" y1="5" x2="9" y2="5"/>');
  const d = importSvg(tree);
  assert.equal(allLines(d).length, 1);
  assert.deepEqual(d.meta.warnings, ['пропущено текстовых элементов: 3, переведите текст в кривые', 'пропущено растровых изображений: 1']);
});

test('Inkscape layers and a single layer without them', () => {
  const layered = importSvg(svg('<g inkscape:groupmode="layer" inkscape:label="контур" id="a"><line x1="0" y1="0" x2="5" y2="0"/></g><g inkscape:groupmode="layer" inkscape:label="штрих" id="b"><line x1="0" y1="1" x2="5" y2="1"/></g>'));
  assert.deepEqual(layered.layers.map((l) => l.name), ['контур', 'штрих']);
  const plain = importSvg(svg('<g><line x1="0" y1="0" x2="5" y2="0"/></g><line x1="0" y1="1" x2="5" y2="1"/>'));
  assert.equal(plain.layers.length, 1);
  assert.equal(plain.layers[0].lines.length, 2);
});

test('physical size: 100x50 mm, viewBox 200x100 → 0.5 mm per unit', () => {
  const d = importSvg(svg('<line x1="0" y1="0" x2="5" y2="0"/>', 'width="100mm" height="50mm" viewBox="0 0 200 100"'));
  assert.deepEqual(d.meta.physicalSize, { w: 100, h: 50 });
  assert.equal(d.meta.unitMm, 0.5);
});

test('without absolute units the size is unknown', () => {
  const d = importSvg(svg('<line x1="0" y1="0" x2="5" y2="0"/>', 'width="100" height="50" viewBox="0 0 200 100"'));
  assert.equal(d.meta.physicalSize, undefined);
  assert.equal(d.meta.unitMm, undefined);
});

test('not an SVG — an error without a partial result', () => {
  assert.throws(() => importSvg({ tag: 'html', attrs: {}, children: [] }), SvgImportError);
  assert.throws(() => importSvg(null), /не удалось прочитать SVG/);
});

test('broken XML is rejected by the parser', () => {
  assert.throws(() => parseXml('<svg><g></svg>'));
});

test('fit picks the chord in mm on paper', () => {
  const tree = svg('<circle cx="500" cy="500" r="500"/>');
  const fine = importSvg(tree, { fit: { fieldMm: { w: 100, h: 100 }, marginMm: 0, rotate: false }, chordMm: 0.3 });
  const coarse = importSvg(tree, { fit: { fieldMm: { w: 100, h: 100 }, marginMm: 0, rotate: false }, chordMm: 3 });
  assert.ok(allLines(fine)[0].length > allLines(coarse)[0].length * 5);
});
