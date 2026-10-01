import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrawing, bbox } from '../src/core/drawing.js';
import { exportSvg, exportOnPaper } from '../src/core/svg-export.js';
import { importSvg } from '../src/core/svg-import.js';
import { layout } from '../src/core/layout.js';
import { parseXml } from './helpers/xml.js';
import './helpers/ru.js';

const WORK = { field: { w: 180, h: 180 }, corner: { x: -5, y: 50 }, marginMm: 5 };
const doc = (layers, meta) => createDrawing({ layers, meta });
const attr = (svg, name) => new RegExp(`<svg[^>]* ${name}="([^"]*)"`).exec(svg)[1];

test('a drawing on the field: viewBox 0 0 170 170, without the printer offset', () => {
  const machine = layout(doc([{ id: 'l', name: 'l', lines: [[0, 0, 100, 100]] }]), WORK);
  const svg = exportSvg(machine);
  assert.equal(attr(svg, 'viewBox'), '0 0 170 170');
  assert.equal(attr(svg, 'width'), '170mm');
  assert.ok(!/[XY]-?\d/.test(svg) && !svg.includes('225') && !svg.includes('55'));
});

test('the orientation is the same as on paper', () => {
  const machine = layout(doc([{ id: 'l', name: 'l', lines: [[0, 0, 10, 0], [0, 10, 10, 10]] }]), { ...WORK, marginMm: 0 });
  const back = importSvg(parseXml(exportSvg(machine)));
  const [top, bottom] = [back.layers[0].lines[0], back.layers[0].lines[1]];
  // line order is preserved: the first was at the top of the document -> in SVG y is smaller
  assert.ok(top[1] < bottom[1] || top[1] === 0);
  assert.equal(bbox(back).h, 180);
});

test('without a physical size: width/height without units', () => {
  const svg = exportSvg(doc([{ id: 'l', name: 'l', lines: [[100, 100, 900, 700]] }]));
  assert.equal(attr(svg, 'viewBox'), '0 0 800 600');
  assert.equal(attr(svg, 'width'), '800');
  assert.equal(attr(svg, 'height'), '600');
});

test('physical document size: mm by bounds', () => {
  const svg = exportSvg(doc([{ id: 'l', name: 'l', lines: [[0, 0, 100, 50]] }], { unitMm: 0.5 }));
  assert.equal(attr(svg, 'width'), '50mm');
  assert.equal(attr(svg, 'height'), '25mm');
});

test('drawing 170×42.5 mm', () => {
  const machine = layout(doc([{ id: 'l', name: 'l', lines: [[0, 0, 400, 100]] }]), WORK);
  const svg = exportSvg(machine);
  assert.equal(attr(svg, 'width'), '170mm');
  assert.equal(attr(svg, 'height'), '42.5mm');
});

test('round-trip exchange: layers, order and geometry', () => {
  const src = doc([
    { id: 'a', name: 'контур & "рамка"', lines: [[10, 20, 30, 40, 50, 25]] },
    { id: 'b', name: 'штрих', lines: [[15, 15, 60, 70], [0, 0, 5, 5]] },
  ]);
  const back = importSvg(parseXml(exportSvg(src)));
  assert.deepEqual(back.layers.map((l) => l.name), ['контур & "рамка"', 'штрих']);
  const b = bbox(src);
  back.layers.forEach((layer, i) => {
    layer.lines.forEach((line, j) => {
      const orig = src.layers[i].lines[j];
      for (let k = 0; k < orig.length; k += 2) {
        assert.ok(Math.abs(line[k] - (orig[k] - b.x0)) < 0.01);
        assert.ok(Math.abs(line[k + 1] - (orig[k + 1] - b.y0)) < 0.01);
      }
    });
  });
});

test('export as on paper: field 180×180, margin 5 mm', () => {
  const machine = layout(doc([{ id: 'l', name: 'l', lines: [[0, 0, 100, 100]] }]), WORK);
  const svg = exportOnPaper(machine, { field: WORK.field, corner: WORK.corner });
  assert.equal(attr(svg, 'width'), '180mm');
  assert.equal(attr(svg, 'viewBox'), '0 0 180 180');
  const back = importSvg(parseXml(svg));
  const b = bbox(back);
  assert.ok(Math.abs(b.x0 - 5) < 0.01 && Math.abs(b.y0 - 5) < 0.01 && Math.abs(b.x1 - 175) < 0.01 && Math.abs(b.y1 - 175) < 0.01);
});
