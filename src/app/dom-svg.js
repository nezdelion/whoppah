// DOMParser -> a neutral tree {tag, attrs, children} that core/svg-import understands.
import { SvgImportError } from '../core/svg-import.js';

function toTree(el) {
  const attrs = {};
  for (const a of el.attributes) attrs[a.name] = a.value;
  return { tag: el.localName, attrs, children: Array.from(el.children, toTree) };
}

export function svgTextToTree(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'svg') {
    throw new SvgImportError('не удалось прочитать SVG');
  }
  return toTree(doc.documentElement);
}
