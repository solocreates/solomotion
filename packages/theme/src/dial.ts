/**
 * THE DIAL — the mark's geometry, as pure functions.
 *
 * The wordmark's four o's are filled discs, each with a brighter quarter
 * pointing up, right, down, left: four frames of one turn, read clockwise. The
 * small mark is ONE dial (quarter up), and the loader is that dial turning a
 * quarter per beat. Every surface that draws the mark draws it from here, so
 * the wedge is the same shape in a 13px favicon and a 200px hero.
 */

/** Up, right, down, left — degrees clockwise from twelve o'clock. */
export const DIAL_DIRECTIONS = [0, 90, 180, 270] as const;

/** SVG path of a quarter wedge of an ellipse, centred on `dir` (0 = up). */
export function wedgePath(cx: number, cy: number, rx: number, ry: number, dir: number): string {
  const a = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const p = (deg: number) => `${(cx + rx * Math.cos(a(deg))).toFixed(2)} ${(cy + ry * Math.sin(a(deg))).toFixed(2)}`;
  return `M${cx} ${cy}L${p(dir - 45)}A${rx} ${ry} 0 0 1 ${p(dir + 45)}Z`;
}

/** Where a font's own "o" sits, in a 100-unit em box, MEASURED rather than
 *  guessed, so the disc covers exactly the glyph it replaces. */
export interface OMetrics {
  /** Advance width of the "o". */
  adv: number;
  /** Baseline from the top of a 1em line box. */
  base: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** The subset of `TextMetrics` the measurement needs (a canvas provides it). */
export interface GlyphMetrics {
  width: number;
  actualBoundingBoxLeft: number;
  actualBoundingBoxRight: number;
  actualBoundingBoxAscent: number;
  actualBoundingBoxDescent: number;
  fontBoundingBoxAscent: number;
  fontBoundingBoxDescent: number;
}

/** Text metrics of "o" set at 100px → where the disc goes. */
export function oMetricsFrom(m: GlyphMetrics): OMetrics {
  const A = m.fontBoundingBoxAscent;
  const D = m.fontBoundingBoxDescent;
  const base = (100 - (A + D)) / 2 + A;
  const top = base - m.actualBoundingBoxAscent;
  const bot = base + m.actualBoundingBoxDescent;
  const left = -m.actualBoundingBoxLeft;
  const right = m.actualBoundingBoxRight;
  return { adv: m.width, base, cx: (left + right) / 2, cy: (top + bot) / 2, rx: (right - left) / 2, ry: (bot - top) / 2 };
}

/**
 * The wordmark's o's for one family, measured once per family and weight.
 * Space Grotesk 600 at 100px (the face next/font serves), as measured in
 * Chrome, ships as the default so the first paint is already right and the
 * client's one measurement changes nothing. Re-measure if the face changes:
 * a stale default is a visible jump on every boot.
 */
export const DEFAULT_O: OMetrics = { adv: 61.34, base: 84.5, cx: 30.67, cy: 59.79, rx: 25.75, ry: 26.11 };

/** "solomotion" split around its four o's, with the dial each one wears. */
export const WORDMARK_PARTS: ReadonlyArray<{ text: string } | { o: 0 | 1 | 2 | 3 }> = [
  { text: "s" },
  { o: 0 },
  { text: "l" },
  { o: 1 },
  { text: "m" },
  { o: 2 },
  { text: "ti" },
  { o: 3 },
  { text: "n" },
];
