// Minimal XML parser for tests: builds a {tag, attrs, children} tree. Text is ignored.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ENTITIES[e]);

export function parseXml(text) {
  const src = text
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    const between = src.slice(last, m.index);
    if (/[<>]/.test(between)) throw new Error('bad xml');
    last = re.lastIndex;
    const [, closing, tag, attrText, selfClose] = m;
    if (closing) {
      const top = stack.pop();
      if (!top || top.tag !== tag) throw new Error('mismatched tag ' + tag);
      continue;
    }
    const attrs = {};
    for (const a of attrText.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescape(a[2] ?? a[3]);
    const node = { tag: tag.includes(':') ? tag.split(':')[1] : tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  if (stack.length !== 1) throw new Error('unclosed tags');
  if (root.children.length !== 1) throw new Error('no root element');
  return root.children[0];
}
