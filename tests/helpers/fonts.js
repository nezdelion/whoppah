// Tiny single-stroke font fixtures written for the tests (not taken from any font).

/**
 * Hershey JHF: code points 32.. in file order. " " (empty), "!" (one stroke), '"' (two strokes, pen up), "#" (a record
 * continued on the next line), "$" (an "H": capitals 21 units), "%" ("?" is not in it — see TINY_JHF_Q).
 */
export const TINY_JHF = [
  '12345  1JZ',
  '12346  3MWRFR[',
  '12347  6JZNFNJ RVFVJ',
  '12348  4JZKFYF',
  'R[',
  '12349  9MWNFN[ RVFV[ RNPVP',
].join('\n') + '\n';

/** A single-line SVG font: Y up, 1000 units per em; "I" is 700 high; Cyrillic PE by an entity; a ligature (skipped). */
export const TINY_SVG_FONT = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<!-- <glyph unicode="Z" d="M 0 0 L 9 9"/> is a comment -->
<font id="Tiny" horiz-adv-x="500">
<font-face font-family="Tiny Hand" units-per-em="1000" ascent="800" descent="-200"/>
<missing-glyph horiz-adv-x="500"/>
<glyph unicode=" " horiz-adv-x="300"/>
<glyph unicode="I" horiz-adv-x="400" d="M 200 0 L 200 700"/>
<glyph unicode="&#x41F;" horiz-adv-x="600" d="M 100 0 L 100 700 L 500 700 L 500 0"/>
<glyph unicode="x" d="M 0 0 L 300 400 M 0 400 L 300 0"/>
<glyph unicode="o" horiz-adv-x="420" d="M 200 0 C 300 0 350 100 350 200 C 350 300 300 400 200 400 C 100 400 50 300 50 200 C 50 100 100 0 200 0 Z"/>
<glyph unicode="?" horiz-adv-x="450" d="M 100 600 L 300 600 L 300 300 M 300 50 L 300 0"/>
<glyph unicode="&quot;" horiz-adv-x="300" d="M 100 700 L 100 500 M 200 700 L 200 500"/>
<glyph unicode="fi" horiz-adv-x="900" d="M 0 0 L 100 700"/>
</font></defs></svg>`;

/** An outline font: every glyph is a closed contour, "I" and "x" included. */
export const OUTLINE_SVG_FONT = `<svg xmlns="http://www.w3.org/2000/svg"><defs><font id="Fat" horiz-adv-x="500">
<font-face font-family="Fat" units-per-em="1000"/>
<glyph unicode="I" d="M 150 0 L 250 0 L 250 700 L 150 700 Z"/>
<glyph unicode="x" d="M 0 0 L 60 0 L 150 160 L 240 0 L 300 0 L 180 200 L 300 400 L 240 400 L 150 240 L 60 400 L 0 400 L 120 200 Z"/>
<glyph unicode="o" d="M 200 0 C 300 0 350 100 350 200 C 350 300 300 400 200 400 C 100 400 50 300 50 200 C 50 100 100 0 200 0 Z M 200 60 C 150 60 110 120 110 200 C 110 280 150 340 200 340 C 250 340 290 280 290 200 C 290 120 250 60 200 60 Z"/>
</font></defs></svg>`;

/** A File-like object for the app code (name + async text()). */
export const fakeFile = (name, text) => ({ name, size: text.length, text: async () => text });
