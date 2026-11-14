"use client";

import {
  mirroredCharAt,
  rangeAt,
  resolveBidi,
  resolveTextStyle,
  segmentTextCached,
  setTextBoxMeasurer,
  unitIndexOf,
  shapeArabicGraphemes,
  glyphDirection,
  styleAt,
  visualOrderRanges,
  type AnimationUnit,
  type BidiInfo,
  type GlyphVisual,
  type ClipPose,
  type EffectiveRange,
  type RangeStyleSample,
  type ResolvedTextStyle,
  type MotionDocument,
  type LayerBox,
  type StyleRange,
  type TextClip,
  type TextHighlight,
  type TextSegmentation,
  type TextStyle,
} from "@solomotion/core";
import { fontsVersion } from "./fonts";

/**
 * Glyph layout in *frame* coordinates relative to the clip anchor (block
 * center at 0,0). Pure measurement + arrangement; animation offsets are
 * applied at draw time so layouts cache across frames.
 */

export interface LaidGlyph {
  char: string;
  graphemeIndex: number;
  /** Left edge x relative to anchor. */
  x: number;
  /** Baseline y relative to anchor. */
  y: number;
  width: number;
  line: number;
  style: ResolvedTextStyle;
  /**
   * How far this glyph's own ink reaches above and below its baseline, px.
   *
   * The letters that are actually there, not what the face could draw — it is
   * what lets a highlight box sit centred on the word instead of reserving a
   * descender no capital has. Zero on a space, a newline, or an engine that
   * reports no metrics, which the box reads as "I have nothing to add".
   */
  inkAscent: number;
  inkDescent: number;
  /**
   * How deep the scope that dresses this glyph sits: 0 the layer's own style,
   * 1 a range, 2 the caption's focus. Read by whatever paints BEHIND a run —
   * two pills that meet between words overlap by their padding, and the deeper
   * scope's pill has to be the one on top, in the order the overlays merge.
   */
  styleDepth: StyleDepth;
  /**
   * The joined WORD this glyph belongs to, when it is set in a joining script
   * (Arabic, Persian, Urdu…). Shared by every glyph of the word. The painter
   * uses it to draw the word in ONE call when its letters move together —
   * which is the only way the font's full shaping (joins, lam-alef, kerning,
   * contextual alternates) happens, and so the only way the canvas can look
   * exactly like the inline editor. See `ShapedWord`.
   */
  word?: ShapedWord;
}

/**
 * A word the browser must shape as a whole. `text` is its logical text, as
 * typed; `size` is how many graphemes it spans, so a painter can tell whether
 * it holds all of them (a word broken across lines does not).
 */
export interface ShapedWord {
  text: string;
  size: number;
}

export type StyleDepth = 0 | 1 | 2;

export interface TextLayout {
  glyphs: LaidGlyph[];
  width: number;
  height: number;
  /**
   * The text box, frame px, centered on the anchor — the rect a "clip content"
   * layer masks its glyphs to. Auto modes hug the content (blockWidth/height);
   * a fixed box uses maxWidth/maxHeight. Whether clipping is actually applied is
   * the caller's call (a text clip's `clipContent`, a fixed caption box).
   */
  clipBox?: { width: number; height: number } | null;
  /**
   * How far the block of lines sits BELOW the top of the box, in frame px.
   *
   * Zero for auto-height (the block IS the box) and for a fixed box aligned to
   * the top; a fixed box aligned middle/bottom pushes the block down by the
   * slack. The canvas has always applied this while placing glyphs, but only as
   * a local variable — so the inline editor, which builds a DOM box of
   * `height` and lets the browser stack lines from its top, had no way to know
   * about it and put the text somewhere the canvas never drew it the moment a
   * text box was given a fixed height. Derived here, read there.
   */
  blockOffsetY: number;
}

export function fontString(style: TextStyle, fontSizeOverride?: number): string {
  const size = fontSizeOverride ?? style.fontSize;
  // Rounded: a TWEENED weight lands between integers, and a variable face
  // draws 437 as readily as 400 — but a fractional weight is not valid in
  // every engine's canvas `font` shorthand, and an invalid shorthand is
  // silently ignored (the glyph keeps the previous glyph's font).
  const weight = typeof style.fontWeight === "number" ? Math.round(style.fontWeight) : style.fontWeight;
  return `${style.italic ? "italic " : ""}${weight} ${size}px "${style.fontFamily}", sans-serif`;
}

/**
 * The extra ink faux bold lays around every edge of a glyph, in px. Zero when
 * off. The painter strokes at twice this (a canvas stroke straddles its path);
 * the ink bounds pad by it once.
 */
export function fauxBoldOutset(style: { fauxBold?: number; fontSize: number | string }): number {
  return typeof style.fontSize === "number" ? (style.fauxBold ?? 0) * style.fontSize : 0;
}

/** Keyframed typography overrides sampled at the current time. */
export interface LayoutOverrides {
  fontSize?: number;
  letterSpacing?: number;
  lineHeight?: number;
  color?: string;
  fontWeight?: number;
  fauxBold?: number;
  italic?: boolean;
  /**
   * Keyframed text-BOX size. Overrides the clip's own `maxWidth`/`maxHeight`,
   * so an animated box re-wraps its lines instead of being scaled — which is
   * the whole point of animating a box rather than a transform. Must be folded
   * into the layout cache key (it is, below): a size that changes per frame
   * against a cache keyed only on style would render the first frame forever.
   */
  maxWidth?: number;
  maxHeight?: number;
  /** Range-scoped keyframe values per text slice (most specific — applied last). */
  rangeStyles?: RangeStyleSample[];
}

/** Apply sampled range-scoped keyframe values onto a resolved glyph style. */
function applyRangeValues(style: TextStyle, values: Record<string, unknown>): TextStyle {
  const next = { ...style };
  if (typeof values.fontSize === "number") next.fontSize = values.fontSize;
  if (typeof values.letterSpacing === "number") next.letterSpacing = values.letterSpacing;
  if (typeof values.lineHeight === "number") next.lineHeight = values.lineHeight;
  if (typeof values.color === "string") next.color = values.color;
  if (typeof values.fontWeight === "number") next.fontWeight = values.fontWeight;
  if (typeof values.fauxBold === "number") next.fauxBold = values.fauxBold;
  if (typeof values.italic === "boolean") next.italic = values.italic;
  return next;
}

/**
 * How far THIS glyph's ink actually reaches above and below its own baseline,
 * in px, from the metrics the width measurement already returned.
 *
 * Not the font's cap height and descender depth. Those describe what the FACE
 * could draw — "H" is as tall as it gets, "g" as deep — and a box built from
 * them reserves room under an all-caps word for a tail that is not there. The
 * text then sits high in its own highlight, on every font, at every line
 * height, because the emptiness is below the baseline where nothing is drawn.
 *
 * Clamped at zero on both sides: `actualBoundingBoxDescent` goes NEGATIVE for a
 * glyph whose ink stops above the baseline (every capital), and a box is never
 * shorter than the baseline it sits on. A space, a newline, and an engine that
 * reports no metrics all come back as zero ink, which the callers read as "this
 * glyph has nothing to say about how tall the box is".
 */
function glyphInk(m: TextMetrics): { ascent: number; descent: number } {
  const a = m.actualBoundingBoxAscent;
  const d = m.actualBoundingBoxDescent;
  return {
    ascent: Number.isFinite(a) ? Math.max(0, a) : 0,
    descent: Number.isFinite(d) ? Math.max(0, d) : 0,
  };
}

interface MeasuredGlyph {
  char: string;
  graphemeIndex: number;
  /** Code-unit index into the source string — maps back to bidi-js levels/reorder ranges. */
  stringIndex: number;
  width: number;
  style: ResolvedTextStyle;
  isSpace: boolean;
  isNewline: boolean;
  inkAscent: number;
  inkDescent: number;
  styleDepth: StyleDepth;
  word?: ShapedWord;
}

/** Display-only case transform — never mutates the underlying text or indices. */
function applyTextCase(char: string, textCase: TextStyle["textCase"], atWordStart: boolean): string {
  switch (textCase) {
    case "upper":
      return char.toUpperCase();
    case "lower":
      return char.toLowerCase();
    case "title":
      return atWordStart ? char.toUpperCase() : char.toLowerCase();
    default:
      return char;
  }
}

/**
 * The effective style of a single grapheme — base + keyframed typography
 * overrides + static ranges + range-scoped keyframes, resolved most-specific
 * last. This is the exact per-glyph resolution the canvas uses; the inline
 * text editor reuses it so what you type looks like what gets drawn.
 *
 * `base` must be a RESOLVED style (variables → literals, via `resolveTextStyle`);
 * range styles carry literals in Phase 2, so the output is fully literal.
 */
export function glyphStyleAt(
  base: ResolvedTextStyle,
  ranges: readonly StyleRange[],
  index: number,
  overrides?: LayoutOverrides,
): ResolvedTextStyle {
  return resolveGlyphStyle(base, ranges, index, overrides);
}

function resolveGlyphStyle(
  base: ResolvedTextStyle,
  ranges: readonly StyleRange[],
  index: number,
  overrides?: LayoutOverrides,
): ResolvedTextStyle {
  const withBase: ResolvedTextStyle = overrides
    ? {
        ...base,
        fontSize: overrides.fontSize ?? base.fontSize,
        letterSpacing: overrides.letterSpacing ?? base.letterSpacing,
        lineHeight: overrides.lineHeight ?? base.lineHeight,
        fontWeight: overrides.fontWeight ?? base.fontWeight,
        fauxBold: overrides.fauxBold ?? base.fauxBold,
        italic: overrides.italic ?? base.italic,
      }
    : base;
  // Ranges merge over the resolved base; in Phase 2 range styles are literal, so
  // the merged result is literal (cast to the resolved type).
  let resolved = styleAt(withBase, ranges, index) as ResolvedTextStyle;
  // A keyframed color is explicit animation — it outranks static range styling.
  if (overrides?.color !== undefined) resolved = { ...resolved, color: overrides.color };
  // Range-scoped keyframes are the most specific — they win over everything for
  // the glyphs they cover (a keyframed color/weight/size on one word or letter).
  if (overrides?.rangeStyles) {
    for (const rs of overrides.rangeStyles) {
      if (index >= rs.start && index < rs.end) {
        resolved = applyRangeValues(resolved, rs.values) as ResolvedTextStyle;
      }
    }
  }
  return resolved;
}

/**
 * Reorder each line's graphemes from logical (typed) order into visual
 * (left-to-right paint) order per its bidi embedding levels. Line breaking
 * upstream stays in logical order (word-wrap boundaries are only meaningful
 * there); reordering per already-broken line matches bidi-js's own
 * documented usage for wrapped text. Only the ARRAY POSITION changes —
 * `graphemeIndex` on each glyph is untouched, so per-glyph animation lookups
 * (keyed by grapheme index) keep working after reordering.
 */
function reorderLinesToVisual(lines: MeasuredGlyph[][], text: string, bidi: BidiInfo): void {
  for (const line of lines) {
    if (line.length === 0) continue;
    const first = line[0]!;
    const last = line[line.length - 1]!;
    const startCU = first.stringIndex;
    const endCU = last.stringIndex + last.char.length - 1;
    const flips = visualOrderRanges(bidi, startCU, endCU);
    for (const [startFlipCU, endFlipCU] of flips) {
      let lo = line.findIndex((g) => g.stringIndex >= startFlipCU);
      if (lo < 0) continue;
      let hi = lo;
      for (let i = lo + 1; i < line.length && line[i]!.stringIndex <= endFlipCU; i++) hi = i;
      while (lo < hi) {
        const tmp = line[lo]!;
        line[lo] = line[hi]!;
        line[hi] = tmp;
        lo++;
        hi--;
      }
    }
  }
}

/** The side a paragraph starts on — right for one whose base direction is RTL. */
function startEdge(line: readonly MeasuredGlyph[], bidi: BidiInfo | undefined): "left" | "right" {
  const at = line.find((g) => !g.isSpace)?.stringIndex;
  if (!bidi || at === undefined) return "left";
  const para = bidi.embeddingLevels.paragraphs.find((p) => at >= p.start && at <= p.end);
  return (para?.level ?? 0) % 2 === 1 ? "right" : "left";
}

/**
 * JUSTIFY one line: the slack between its ink and the box is shared by the
 * spaces BETWEEN its words (never the ones hanging off either end, which the
 * wrap left there). Null for a paragraph's last line, a line with one word, or
 * a line that does not fit — those keep their start edge, as in every
 * typesetter. `x` is where the first glyph goes so the first word's ink meets
 * the left edge (the line is already in visual order).
 */
function justifyLine(
  line: readonly MeasuredGlyph[],
  boxWidth: number,
  lastOfParagraph: boolean,
): { x: number; gap: number; spaces: ReadonlySet<number> } | null {
  if (lastOfParagraph) return null;
  const first = line.findIndex((g) => !g.isSpace);
  const last = line.findLastIndex((g) => !g.isSpace);
  if (first < 0) return null;
  const spaces = new Set<number>();
  let lead = 0;
  let ink = 0;
  line.forEach((g, i) => {
    if (i < first) lead += g.width;
    else if (i <= last) {
      ink += g.width;
      if (g.isSpace) spaces.add(i);
    }
  });
  const slack = boxWidth - ink;
  if (!spaces.size || slack <= 0) return null;
  return { x: -boxWidth / 2 - lead, gap: slack / spaces.size, spaces };
}

function layoutMeasured(
  measured: MeasuredGlyph[],
  align: TextStyle["align"],
  maxWidth: number | null,
  lineHeightFactorSource: ResolvedTextStyle,
  maxHeight: number | null = null,
  verticalAlign: "top" | "middle" | "bottom" = "top",
  bidiText?: string,
  bidi?: BidiInfo,
): TextLayout {
  if (lineHeightFactorSource.orientation === "vertical") {
    return layoutVertical(measured, align, maxWidth, lineHeightFactorSource, maxHeight, verticalAlign);
  }
  // 1. Break into lines: explicit newlines always; soft-wrap at word boundaries when maxWidth set.
  const lines: MeasuredGlyph[][] = [[]];
  // Whether each line ends its paragraph (a newline or the end of the text) —
  // justify spreads every line but those, the way every typesetter does.
  const endsParagraph: boolean[] = [];
  let lineWidth = 0;
  let wordBuffer: MeasuredGlyph[] = [];
  let wordWidth = 0;

  const pushWord = () => {
    if (wordBuffer.length === 0) return;
    if (maxWidth !== null && lineWidth > 0 && lineWidth + wordWidth > maxWidth) {
      endsParagraph[lines.length - 1] = false;
      lines.push([]);
      lineWidth = 0;
    }
    lines[lines.length - 1]!.push(...wordBuffer);
    lineWidth += wordWidth;
    wordBuffer = [];
    wordWidth = 0;
  };

  for (const g of measured) {
    if (g.isNewline) {
      pushWord();
      endsParagraph[lines.length - 1] = true;
      lines.push([]);
      lineWidth = 0;
      continue;
    }
    if (g.isSpace) {
      pushWord();
      lines[lines.length - 1]!.push(g);
      lineWidth += g.width;
      continue;
    }
    wordBuffer.push(g);
    wordWidth += g.width;
  }
  pushWord();

  if (bidi && bidiText) reorderLinesToVisual(lines, bidiText, bidi);

  // 2. Vertical metrics per line (driven by the largest font on the line).
  const lineMetrics = lines.map((line) => {
    let maxSize = 0;
    for (const g of line) maxSize = Math.max(maxSize, g.style.fontSize);
    if (maxSize === 0) maxSize = lineHeightFactorSource.fontSize;
    const height = maxSize * lineHeightFactorSource.lineHeight;
    return { height, ascent: maxSize * LINE_ASCENT_RATIO };
  });

  const blockHeight = lineMetrics.reduce((a, m) => a + m.height, 0);
  const lineWidths = lines.map((line) => line.reduce((a, g) => a + g.width, 0));
  const blockWidth = Math.max(0, ...lineWidths);

  // Horizontal alignment reference. When a wrap/box width is fixed (auto-height
  // or fixed-size), lines align within the BOX — exactly like the CSS
  // `text-align` the inline editor applies to a `maxWidth`-wide box, so edit and
  // display agree. Auto-width has no box, so lines align within their own
  // content block (single-line auto-width therefore hugs the anchor for every
  // alignment — Figma parity: alignment is a no-op until the box has slack).
  const alignWidth = maxWidth ?? blockWidth;

  // 3. Place glyphs, honoring alignment. Auto height anchors the block at its
  // own center; a fixed-height box anchors the block within the BOX per
  // verticalAlign (top/middle/bottom), so the box — not the content — is what
  // stays centered on the clip anchor.
  const boxHeight = maxHeight ?? blockHeight;
  const glyphs: LaidGlyph[] = [];
  let top =
    maxHeight == null
      ? -blockHeight / 2
      : verticalAlign === "top"
        ? -boxHeight / 2
        : verticalAlign === "bottom"
          ? boxHeight / 2 - blockHeight
          : -blockHeight / 2;
  const blockTop = top; // `top` walks down the lines below; keep where it began.
  lines.forEach((line, li) => {
    const metric = lineMetrics[li]!;
    const lw = lineWidths[li]!;
    const spread = align === "justify" && maxWidth !== null ? justifyLine(line, alignWidth, endsParagraph[li] ?? true) : null;
    const lineAlign = spread ? "left" : align === "justify" ? startEdge(line, bidi) : align;
    let x =
      spread ? spread.x : lineAlign === "left" ? -alignWidth / 2 : lineAlign === "right" ? alignWidth / 2 - lw : -lw / 2;
    const baseline = top + metric.ascent;
    for (const [gi, g] of line.entries()) {
      glyphs.push({
        char: g.char,
        graphemeIndex: g.graphemeIndex,
        x,
        y: baseline,
        width: g.width,
        line: li,
        style: g.style,
        inkAscent: g.inkAscent,
        styleDepth: g.styleDepth,
        inkDescent: g.inkDescent,
        word: g.word,
      });
      x += g.width + (spread?.spaces.has(gi) ? spread.gap : 0);
    }
    top += metric.height;
  });

  return {
    glyphs,
    width: blockWidth,
    height: boxHeight,
    // Where the block STARTED, expressed from the box's top edge (the box being
    // centred on the anchor, its top at -boxHeight/2). The same number the
    // glyph loop above consumed, exported so the DOM editor stacks its lines
    // from the same place instead of always hugging the top.
    blockOffsetY: blockTop + boxHeight / 2,
    clipBox: { width: maxWidth ?? blockWidth, height: maxHeight ?? blockHeight },
  };
}

/**
 * VERTICAL WRITING — upright glyphs stacked top-to-bottom in columns that
 * advance RIGHT-TO-LEFT (the CJK convention; Illustrator's vertical type).
 *
 * The horizontal engine's ideas map one-for-one with the axes swapped: a
 * "line" is a column, the line pitch is the column pitch, the glyph advance
 * along the flow is the row pitch (`fontSize × lineHeight` — every glyph gets
 * one cell, which is what keeps a mixed-script column on a grid), and `align`
 * places the column's run along the flow (top / middle / bottom) while
 * `verticalAlign` places the block of columns across it. Explicit newlines
 * start a new column; a fixed box HEIGHT wraps a column that overruns it.
 *
 * Bidi is deliberately not applied: a column reads top-down whatever the
 * script, and mirroring is a negative scale, never a layout concern.
 */
function layoutVertical(
  measured: MeasuredGlyph[],
  align: TextStyle["align"],
  maxWidth: number | null,
  style: ResolvedTextStyle,
  maxHeight: number | null,
  verticalAlign: "top" | "middle" | "bottom",
): TextLayout {
  const pitchOf = (g: MeasuredGlyph) => g.style.fontSize * style.lineHeight;
  const columns: MeasuredGlyph[][] = [[]];
  let colHeight = 0;
  for (const g of measured) {
    if (g.isNewline) {
      columns.push([]);
      colHeight = 0;
      continue;
    }
    const pitch = pitchOf(g);
    if (maxHeight !== null && colHeight > 0 && colHeight + pitch > maxHeight) {
      columns.push([]);
      colHeight = 0;
    }
    columns[columns.length - 1]!.push(g);
    colHeight += pitch;
  }

  // Column metrics: its pitch across the flow is the largest em in it.
  const colMetrics = columns.map((col) => {
    let maxSize = 0;
    for (const g of col) maxSize = Math.max(maxSize, g.style.fontSize);
    if (maxSize === 0) maxSize = style.fontSize;
    return { pitch: maxSize * style.lineHeight, height: col.reduce((a, g) => a + pitchOf(g), 0) };
  });
  const blockWidth = colMetrics.reduce((a, m) => a + m.pitch, 0);
  const blockHeight = Math.max(0, ...colMetrics.map((m) => m.height));
  const boxWidth = maxWidth ?? blockWidth;
  const boxHeight = maxHeight ?? blockHeight;

  // Columns advance right-to-left, the block placed across the box per verticalAlign.
  let right =
    maxWidth == null
      ? blockWidth / 2
      : verticalAlign === "top"
        ? boxWidth / 2
        : verticalAlign === "bottom"
          ? -boxWidth / 2 + blockWidth
          : blockWidth / 2;
  const glyphs: LaidGlyph[] = [];
  columns.forEach((col, ci) => {
    const m = colMetrics[ci]!;
    const cx = right - m.pitch / 2;
    // Along the flow: `align` is top / middle / bottom of the box.
    let y = align === "left" || align === "justify" ? -boxHeight / 2 : align === "right" ? boxHeight / 2 - m.height : -m.height / 2;
    for (const g of col) {
      const pitch = pitchOf(g);
      glyphs.push({
        char: g.char,
        graphemeIndex: g.graphemeIndex,
        x: cx - g.width / 2,
        y: y + (pitch - g.style.fontSize) / 2 + g.style.fontSize * LINE_ASCENT_RATIO,
        width: g.width,
        line: ci,
        style: g.style,
        inkAscent: g.inkAscent,
        inkDescent: g.inkDescent,
        styleDepth: g.styleDepth,
      });
      y += pitch;
    }
    right -= m.pitch;
  });

  return {
    glyphs,
    width: boxWidth,
    height: boxHeight,
    blockOffsetY: 0,
    clipBox: { width: boxWidth, height: boxHeight },
  };
}

function measureClipText(
  ctx: CanvasRenderingContext2D,
  text: string,
  base: ResolvedTextStyle,
  ranges: readonly EffectiveRange[],
  overrides: LayoutOverrides | undefined,
  bidi: BidiInfo,
): MeasuredGlyph[] {
  const seg = segmentTextCached(text);
  // Contextual Arabic/Persian letter forms — a batch pass since joining
  // depends on neighboring graphemes, computed once per grapheme (1:1, order
  // preserved; only mutates Arabic-block letters).
  const shaped = shapeArabicGraphemes(seg.graphemes.map((g) => g.char));
  const out: MeasuredGlyph[] = [];
  // `actualBoundingBox*` is reported from the CURRENT baseline setting, so the
  // ink below is measured about the alphabetic baseline the painter draws on.
  ctx.textBaseline = "alphabetic";
  let lastFont = "";
  let atWordStart = true;
  for (let i = 0; i < seg.graphemes.length; i++) {
    const g = seg.graphemes[i]!;
    const style = resolveGlyphStyle(base, ranges, i, overrides);
    const covering = rangeAt(ranges, i);
    const styleDepth: StyleDepth = !covering ? 0 : covering.scope === "focus" ? 2 : 1;
    const font = fontString(style);
    if (font !== lastFont) {
      ctx.font = font;
      lastFont = font;
    }
    const isNewline = g.char === "\n";
    const isSpace = !isNewline && /^\s+$/.test(g.char);
    // Mirrored neutral punctuation (parens/brackets under RTL) outranks
    // Arabic shaping — the two never overlap (mirroring only applies to
    // non-Arabic bracket-like characters).
    const baseChar = mirroredCharAt(bidi, g.stringIndex) ?? shaped[i]!;
    // Case is display-only: transform the measured/drawn char, keep the index.
    const char = applyTextCase(baseChar, style.textCase, atWordStart);
    atWordStart = isSpace || isNewline;
    // ONE measurement per glyph: the advance and the ink come off the same
    // TextMetrics, so asking where the letters are costs nothing extra.
    ctx.direction = glyphDirection(char);
    const m = isNewline ? null : ctx.measureText(char);
    const width = m ? m.width + style.letterSpacing : 0;
    const ink = m ? glyphInk(m) : { ascent: 0, descent: 0 };
    out.push({
      char,
      graphemeIndex: i,
      stringIndex: g.stringIndex,
      width,
      style,
      isSpace,
      isNewline,
      inkAscent: ink.ascent,
      inkDescent: ink.descent,
      styleDepth,
    });
  }
  shapeWords(ctx, out, seg.graphemes.map((g) => g.char));
  // The measuring context is shared; leave it as it was found.
  ctx.direction = "inherit";
  return out;
}

/**
 * WORDS IN A JOINING SCRIPT, measured as words.
 *
 * Each glyph was measured alone (in its joined form), which is what per-letter
 * animation needs — but a word's real width comes from shaping it whole: the
 * lam-alef ligature, kerning, contextual alternates. The painter draws such a
 * word in one call whenever its letters move together, so the layout must
 * agree with that drawing: each letter's advance is scaled so the word's
 * letters sum to the width of the word as the browser shapes it. Caret, hit
 * testing, highlights and the drawn word then line up exactly.
 *
 * A word here is a maximal run of right-to-left script graphemes, set in one
 * font with no letter spacing (spacing letters apart is per-letter drawing by
 * definition).
 */
function shapeWords(ctx: CanvasRenderingContext2D, glyphs: MeasuredGlyph[], source: readonly string[]): void {
  // Eligibility reads the TYPED grapheme, never the shaped one: the alef folded
  // into a lam-alef is shaped to "" (no direction of its own), and judging it by
  // that split every such word in two — "سلام" drew as "سل" + "م" with the alef
  // gone. Persian and Arabic lose a letter in almost every sentence that way.
  const eligible = (g: MeasuredGlyph) =>
    !g.isSpace && !g.isNewline && glyphDirection(source[g.graphemeIndex] ?? "") === "rtl" && g.style.letterSpacing === 0;
  let i = 0;
  while (i < glyphs.length) {
    const first = glyphs[i]!;
    if (!eligible(first)) {
      i++;
      continue;
    }
    const font = fontString(first.style);
    let end = i + 1;
    while (end < glyphs.length && eligible(glyphs[end]!) && fontString(glyphs[end]!.style) === font) end++;
    if (end - i > 1) {
      const text = source.slice(first.graphemeIndex, glyphs[end - 1]!.graphemeIndex + 1).join("");
      ctx.font = font;
      ctx.direction = "rtl";
      const whole = ctx.measureText(text).width;
      const parts = glyphs.slice(i, end);
      const sum = parts.reduce((a, g) => a + g.width, 0);
      const word: ShapedWord = { text, size: parts.length };
      for (const g of parts) {
        if (sum > 0) g.width = (g.width / sum) * whole;
        g.word = word;
      }
    }
    i = end;
  }
}

/**
 * Layout cache: keyed by clip object identity (immer gives us new identities
 * on change) + keyframe overrides + loaded-fonts version.
 */
const layoutCache = new WeakMap<object, Map<string, TextLayout>>();

function cachedLayout(
  clip: object,
  cacheKey: string,
  compute: () => TextLayout,
): TextLayout {
  let byKey = layoutCache.get(clip);
  if (!byKey) {
    byKey = new Map();
    layoutCache.set(clip, byKey);
  }
  let layout = byKey.get(cacheKey);
  if (!layout) {
    layout = compute();
    if (byKey.size > 8) byKey.clear();
    byKey.set(cacheKey, layout);
  }
  return layout;
}

/**
 * Where this engine puts a line's baseline: `ratio x fontSize` below the top of
 * the line box, where the line box is `fontSize x lineHeight` tall.
 *
 * It is a house rule, not a font metric — a real typographic model would centre
 * the font's own content area (ascent + descent) in the line box the way CSS
 * does, and 0.78 sits noticeably above that for most faces. It stays because it
 * is what every existing project was laid out with: changing it would silently
 * move the text in every document ever saved, which is a different (and much
 * louder) bug than the one it causes. What matters is that it is stated ONCE
 * and that anything laying the same text out in the DOM can ask how far it
 * differs — see {@link domBaselineDrift}.
 */
export const LINE_ASCENT_RATIO = 0.78;

/**
 * How far BELOW this layout's baseline the browser would put the same line's
 * baseline, for one line of `fontSize` at `lineHeightFactor`.
 *
 * CSS's inline box model centres the font's content area (its ascent plus
 * descent) inside the line box — the "half-leading" — and puts the baseline one
 * ascent below that. This engine instead uses {@link LINE_ASCENT_RATIO}. The two
 * disagree by a fraction of the font size (typically ~0.2em, which at 48px is
 * nearly ten pixels), and that difference is exactly why text used to JUMP DOWN
 * the moment you double-clicked into it: the glyphs you were looking at were
 * painted by this engine, and the glyphs you were typing were placed by the
 * browser.
 *
 * Returning the drift — rather than "fixing" either side — is what lets the
 * editor sit on top of the canvas without either surface changing what it
 * believes. Measured through the same 2D context the layout measures with, so
 * it uses the real font's metrics for the real loaded font.
 *
 * Exact for a line whose glyphs share one size (the overwhelming case, and
 * always true of the first line's caret home). A line mixing sizes drifts by a
 * different amount per size; the editor compensates for its first line, which
 * is where the caret lives.
 */
export function domBaselineDrift(
  ctx: CanvasRenderingContext2D,
  style: TextStyle,
  fontSize: number,
  lineHeightFactor: number,
): number {
  ctx.font = fontString(style, fontSize);
  // Font-box metrics describe the FONT, not the string — any non-empty sample
  // reports the same ascent/descent.
  const m = ctx.measureText("Hg");
  const ascent = m.fontBoundingBoxAscent;
  const descent = m.fontBoundingBoxDescent;
  // No metrics (an old engine, a font that failed to load) → claim no drift
  // rather than shifting the text by a guess.
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return 0;
  const lineBox = fontSize * lineHeightFactor;
  const cssBaseline = (lineBox - (ascent + descent)) / 2 + ascent;
  return cssBaseline - fontSize * LINE_ASCENT_RATIO;
}

function overridesKey(overrides?: LayoutOverrides): string {
  if (!overrides) return "";
  const range = overrides.rangeStyles?.length
    ? overrides.rangeStyles
        .map((r) => `${r.start}-${r.end}[${Object.entries(r.values).map(([k, v]) => `${k}=${v}`).join(",")}]`)
        .join("|")
    : "";
  return `${overrides.fontSize ?? ""}:${overrides.letterSpacing ?? ""}:${overrides.lineHeight ?? ""}:${overrides.color ?? ""}:${overrides.fontWeight ?? ""}:${overrides.fauxBold ?? ""}:${overrides.italic ?? ""}:${overrides.maxWidth ?? ""}:${overrides.maxHeight ?? ""}:${range}`;
}

/**
 * A pose's keyframed overrides as the layout engine wants them — or undefined
 * when nothing is keyed, so the common case keeps hitting the layout cache.
 *
 * THE one builder. The canvas and the inline text editor both lay text out and
 * must agree to the pixel; when each assembled this object itself, adding a
 * field (as box size just did) silently fixed one and left the other rendering
 * against stale numbers.
 */
export function layoutOverridesFor(pose: ClipPose): LayoutOverrides | undefined {
  if (
    pose.fontSizeOverride === undefined &&
    pose.letterSpacingOverride === undefined &&
    pose.lineHeightOverride === undefined &&
    pose.colorOverride === undefined &&
    pose.fontWeightOverride === undefined &&
    pose.fauxBoldOverride === undefined &&
    pose.italicOverride === undefined &&
    pose.maxWidthOverride === undefined &&
    pose.maxHeightOverride === undefined &&
    pose.rangeStyles.length === 0
  ) {
    return undefined;
  }
  return {
    fontSize: pose.fontSizeOverride,
    letterSpacing: pose.letterSpacingOverride,
    lineHeight: pose.lineHeightOverride,
    color: pose.colorOverride,
    fontWeight: pose.fontWeightOverride,
    fauxBold: pose.fauxBoldOverride,
    italic: pose.italicOverride,
    maxWidth: pose.maxWidthOverride,
    maxHeight: pose.maxHeightOverride,
    rangeStyles: pose.rangeStyles.length ? pose.rangeStyles : undefined,
  };
}

/**
 * The text box a clip lays out in, at this instant: the keyframed override when
 * there is one, otherwise the clip's own value (null = auto-size that axis).
 *
 * THE one answer — the renderer, hit-testing and the inline editor all call it,
 * so a clip with an animated box is the same rectangle in all three. Keying an
 * axis pins it: an auto-width layer with `maxWidth` keys becomes a fixed-width
 * box for as long as those keys say so, which is what asking for a width at a
 * moment in time means.
 */
export function boxWidthOf(clip: TextClip, overrides?: LayoutOverrides): number | null {
  return overrides?.maxWidth ?? clip.maxWidth;
}

export function boxHeightOf(clip: TextClip, overrides?: LayoutOverrides): number | null {
  return overrides?.maxHeight ?? clip.maxHeight;
}

export function layoutTextClip(
  ctx: CanvasRenderingContext2D,
  clip: TextClip,
  overrides?: LayoutOverrides,
  /** Effective text when content is keyframed; defaults to the clip's text. */
  textOverride?: string,
  /**
   * The clip's style with bindable typography resolved to literals (via
   * `resolveTextStyle`). Callers with a document MUST pass this so bound font
   * family/size/weight measure correctly; the resolved values are folded into
   * the cache key so a variable edit re-lays out.
   */
  resolvedStyle?: ResolvedTextStyle,
  /**
   * The spans to style the glyphs with — `core`'s `effectiveRanges(clip, t)`,
   * which is the layer's own ranges PLUS the caption cue in focus right now.
   * Defaults to the static ranges, so a plain text layer reads unchanged.
   *
   * Passing the ranges (rather than reading `clip.ranges` here) is what lets a
   * caption use this function at all: its styling is a function of time, and a
   * layout engine that reads the clip directly could only ever see one answer.
   */
  ranges: readonly EffectiveRange[] = clip.ranges,
): TextLayout {
  const style = resolvedStyle ?? (clip.style as ResolvedTextStyle);
  const text = textOverride ?? clip.text;
  const textKey = textOverride === undefined ? "" : `#${text.length}:${text}`;
  const styleKey = `${style.fontFamily}/${style.fontSize}/${style.fontWeight}/${style.orientation}`;
  const key = `${fontsVersion()}:${overridesKey(overrides)}:${textKey}:${styleKey}:${rangesToken(ranges)}`;
  return cachedLayout(clip, key, () => {
    const bidi = resolveBidi(text, style.direction);
    const measured = measureClipText(ctx, text, style, ranges, overrides, bidi);
    return layoutMeasured(
      measured,
      style.align,
      boxWidthOf(clip, overrides),
      style,
      boxHeightOf(clip, overrides),
      clip.verticalAlign,
      text,
      bidi,
    );
  });
}

/**
 * A cheap, stable cache token for a ranges array — identity, not contents.
 *
 * `effectiveRanges` memoises per (clip, phase), so a caption sitting still
 * hands back the same array every frame and this returns the same token; a new
 * phase (or an edit, which gives immer a new array) mints a new one.
 *
 * A caption mid-CROSSING (v78) does hand back a fresh array per frame, and
 * that does re-lay the block out — about ten frames per word at the default
 * 160ms. Hashing contents would not save it: a `TextLayout` carries each
 * glyph's RESOLVED style, colour and pill included, so a token that ignored
 * colour would serve a cached layout whose glyphs never change colour, and the
 * crossing would simply not be visible. Making that cheap means splitting
 * layout into measured geometry and per-glyph style — worth doing, not worth
 * doing behind a comment that claims it is already done.
 */
const rangeTokens = new WeakMap<object, number>();
let nextRangeToken = 0;
function rangesToken(ranges: readonly EffectiveRange[]): number {
  if (ranges.length === 0) return 0;
  let token = rangeTokens.get(ranges);
  if (token === undefined) rangeTokens.set(ranges, (token = ++nextRangeToken));
  return token;
}

// ── The one measurement, handed to the headless side ──────────────────────────
//
// Core cannot lay glyphs out (no DOM, no 2D context), so `clipNaturalSize` used
// to approximate a text layer's box as `longestLine x fontSize x 0.6` while this
// file measured the real thing. Two boxes for one layer: the crosshair, the hit
// rect, snapping and — most visibly — the pivot DRAG all worked in the guessed
// box, so grabbing a text layer's anchor slid the text sideways by the ratio
// between the guess and the truth.
//
// Registering here, at module scope, is deliberate: this module IS the
// measurement, so anything that can lay text out has already imported it, and
// there is no startup order to get wrong. Measured at the RESTING style (no
// keyframe overrides), because a natural size is a property of the layer, not of
// an instant — the same stance core's own per-kind sizes take.
setTextBoxMeasurer((doc: MotionDocument, clip): LayerBox | null => {
  const ctx = measureContext();
  if (!ctx) return null;
  const rStyle = resolveTextStyle(doc, clip.style);
  // The RESTING layout — no keyframe overrides and no caption focus. A
  // caption's box would otherwise breathe with the word being spoken, and a box
  // that changes as it plays makes every gizmo, snap line and pivot jitter.
  const layout = layoutTextClip(ctx, clip, undefined, undefined, rStyle);
  const box = layout.clipBox ?? { width: layout.width, height: layout.height };
  // Text is authored about its own origin, so the box centre is the origin —
  // `cx/cy` is only ever non-zero for a path's wandering outline.
  return { width: box.width, height: box.height, cx: 0, cy: 0 };
});

/**
 * The offscreen 2D context this module measures with — created lazily, and only
 * where a DOM exists. Server rendering imports this module for its pure helpers,
 * and must not touch `document`.
 */
let sharedMeasureCanvas: CanvasRenderingContext2D | null = null;
function measureContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!sharedMeasureCanvas) sharedMeasureCanvas = document.createElement("canvas").getContext("2d");
  return sharedMeasureCanvas;
}

/**
 * THE ANIMATION PIVOT of every laid glyph: the x of the centre of the UNIT it
 * animates as part of.
 *
 * A text animation's grain is `letter`, `word` or `line`, and until now the
 * renderer scaled and rotated every glyph about its OWN centre whatever the
 * grain said. So a line-grained Scale In did not scale a line — it shrank each
 * letter in place, leaving the gaps between them at full size, and the result
 * read as a row of independent characters rather than as one line arriving.
 * The library's preview cards, which pose one element per unit, were right and
 * the canvas was wrong; that disagreement is what this fixes.
 *
 * Only the horizontal pivot moves. The vertical one stays on the BASELINE,
 * because that is what the grain means physically: a line growing in scales
 * about the line it sits on, exactly as After Effects' anchor-point grouping
 * does. A unit never spans two lines, so one x per unit is the whole answer.
 *
 * Returns null for `letter` — the identity case — so the draw loop can skip the
 * indirection entirely on the commonest grain.
 */
export function unitPivotsX(
  layout: TextLayout,
  seg: TextSegmentation,
  unit: AnimationUnit,
): number[] | null {
  if (unit === "letter") return null;
  // Unit index → the run's horizontal extent. Whitespace is included: it is
  // inside the word or line it belongs to and it is part of what scales.
  const extent = new Map<number, { min: number; max: number }>();
  const unitOf = layout.glyphs.map((g) =>
    g.graphemeIndex < seg.graphemes.length ? unitIndexOf(seg, g.graphemeIndex, unit) : -1,
  );
  for (let i = 0; i < layout.glyphs.length; i++) {
    const g = layout.glyphs[i]!;
    const u = unitOf[i]!;
    const cur = extent.get(u);
    if (!cur) extent.set(u, { min: g.x, max: g.x + g.width });
    else {
      cur.min = Math.min(cur.min, g.x);
      cur.max = Math.max(cur.max, g.x + g.width);
    }
  }
  return layout.glyphs.map((g, i) => {
    const e = extent.get(unitOf[i]!);
    return e ? (e.min + e.max) / 2 : g.x + g.width / 2;
  });
}

/** A rectangle in layout coordinates (box centre at 0,0). */
export interface LayoutRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ── WHERE THE ANIMATION PUTS THE INK ─────────────────────────────────────────
//
// A laid-out block is the text AT REST. What the canvas paints is every glyph
// (and every highlight pill) pushed through its own animation pose — an in/out
// preset, or, on a caption, the pop the spoken cue plays. Those two are
// different rectangles, and the gap is not cosmetic: a buffer measured from the
// resting layout cuts the moving artwork at the buffer wall, dead straight,
// corners and all. See `layer-region.ts`, which states that defect class.
//
// So the pose lives here, beside the layout it displaces, as arithmetic both
// the painter and the extent can ask for.

/** The animation the painter will apply, laid glyph by laid glyph. */
export interface GlyphAnim {
  /** The pose glyph `index` is drawn under. */
  visualAt: (index: number) => GlyphVisual;
  /** The x that glyph's animation UNIT scales and rotates about (`unitPivotsX`). */
  pivotXAt: (index: number) => number;
}

/** True when this pose displaces nothing — the fast path, and the common one. */
export function isRestPose(v: GlyphVisual): boolean {
  return v.dx === 0 && v.dy === 0 && v.scale === 1 && v.rotation === 0;
}

/**
 * A layout point under a glyph's animation pose: translated by `dx/dy`, then
 * rotated and scaled about (`pivotX`, `baselineY`).
 *
 * This IS `enterRunPose`, written as a map instead of as canvas state, so the
 * rectangle a buffer reserves and the pixels drawn into it come from one
 * formula. Two formulas here means a clipped edge the day they drift.
 */
function posedLayoutPoint(
  p: { x: number; y: number },
  vis: GlyphVisual,
  pivotX: number,
  baselineY: number,
): { x: number; y: number } {
  const lx = (p.x - pivotX) * vis.scale;
  const ly = (p.y - baselineY) * vis.scale;
  const rad = (vis.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: pivotX + vis.dx + lx * cos - ly * sin,
    y: baselineY + vis.dy + lx * sin + ly * cos,
  };
}

/** A layout rect's axis-aligned bounds once posed — the four corners, mapped. */
export function posedRect(
  r: LayoutRect,
  vis: GlyphVisual,
  pivotX: number,
  baselineY: number,
): LayoutRect {
  if (isRestPose(vis)) return r;
  const pts = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ].map((c) => posedLayoutPoint(c, vis, pivotX, baselineY));
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** Two adjacent glyphs share a pill only when they share a pose. */
export function samePose(a: GlyphVisual, b: GlyphVisual): boolean {
  return (
    a.dx === b.dx &&
    a.dy === b.dy &&
    a.scale === b.scale &&
    a.rotation === b.rotation &&
    a.opacity === b.opacity
  );
}

/**
 * The run breaks that belong to DRAWING rather than to layout: an invisible
 * glyph paints no pill, and one rect cannot carry two poses.
 *
 * Both the pill pass and the extent that reserves room for it read them from
 * here, so they can never disagree about how many pills there are or how wide.
 */
export function paintedRunRules(anim: GlyphAnim) {
  return {
    visible: (i: number) => anim.visualAt(i).opacity > 0.01,
    continues: (prev: number, i: number) => samePose(anim.visualAt(prev), anim.visualAt(i)),
  };
}

/**
 * ONE highlight pill: the rect it paints, and where its run sits.
 *
 * `start`/`end` are indices into `layout.glyphs` (end inclusive), so a caller
 * that animates glyphs can read the run's pose, opacity and pivot without this
 * module knowing that animation exists.
 */
export interface HighlightPill {
  highlight: TextHighlight;
  start: number;
  end: number;
  line: number;
  /**
   * The deepest scope in the run (`LaidGlyph.styleDepth`). The run that holds
   * the spoken word IS the spoken word's pill, whether or not the focus changed
   * the highlight itself — so the deepest glyph speaks for the run.
   */
  depth: StyleDepth;
  /** Largest font size in the run — only the fallback band is measured from it. */
  fontSize: number;
  /** The run's baseline, layout px — the vertical pivot a run pose scales about. */
  baselineY: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Two pills merge only when they say the same thing. */
function sameHighlight(a: TextHighlight, b: TextHighlight): boolean {
  return (
    a === b ||
    (a.color === b.color &&
      a.radius === b.radius &&
      a.paddingX === b.paddingX &&
      a.paddingY === b.paddingY)
  );
}

/** How far a line's ink reaches above and below its baseline, px. */
export interface InkBand {
  ascent: number;
  descent: number;
}

/**
 * THE INK BAND OF EVERY LINE — the letters a line actually contains, measured
 * about its baseline.
 *
 * Per LINE, not per run, and that is the whole design. A highlight box measured
 * from its own word breathes: "AWESOME" is cap-height, "awesome" is x-height,
 * "Apply" hangs a descender, so a caption that moves the box word by word would
 * have it grow and shrink under the reader. Measured across the line, every box
 * on that line is the same height and the same distance off the baseline, and
 * it still hugs the letters that are there — an all-caps line reserves nothing
 * below the baseline, because nothing on it goes there.
 *
 * A line of pure whitespace has no ink and returns none; the caller falls back
 * to the house rule.
 */
function lineInkBands(layout: TextLayout): Map<number, InkBand> {
  const bands = new Map<number, InkBand>();
  for (const g of layout.glyphs) {
    if (g.inkAscent <= 0 && g.inkDescent <= 0) continue;
    const band = bands.get(g.line);
    if (!band) bands.set(g.line, { ascent: g.inkAscent, descent: g.inkDescent });
    else {
      band.ascent = Math.max(band.ascent, g.inkAscent);
      band.descent = Math.max(band.descent, g.inkDescent);
    }
  }
  return bands;
}

/**
 * THE HIGHLIGHT PILLS of a laid-out block — the one place their geometry lives,
 * IN PAINT ORDER.
 *
 * A pill is its line's ink band plus `paddingY` above and below, and `paddingX`
 * wider than the run on each side. It exists because the canvas used to hold
 * that arithmetic in its draw loop and the inline editor used to re-derive it
 * in CSS out of the FONT's own ascent and descent — two engines, two answers,
 * so a pill visibly changed shape the instant you double-clicked into the text.
 * Now both ask here, and "focused" and "unfocused" cannot disagree.
 *
 * The run-breaking rules that are about DRAWING rather than layout are the
 * caller's, passed in: the canvas hides fully transparent glyphs and starts a
 * new pill wherever the glyph animation pose changes, because one rect cannot
 * carry two poses.
 *
 * ORDER IS PART OF THE ANSWER. Adjacent pills overlap by their padding in the
 * gap between words, and whichever paints last owns that gap — so the list
 * comes back shallowest scope first, glyph order within a depth (a stable
 * sort): the layer's pill, then any range's, then the caption focus's. Both
 * painters (the canvas pass and the inline editor's DOM rects) iterate this
 * list as given, which is what keeps them from disagreeing about which word
 * is on top.
 */
export function highlightPills(
  layout: TextLayout,
  options: {
    /** False → this glyph paints nothing and ends the run it was in. */
    visible?: (index: number) => boolean;
    /** False → break the run between these two adjacent glyphs. */
    continues?: (prevIndex: number, index: number) => boolean;
    /**
     * The highlight to measure a glyph with, INSTEAD of its own. Returning a
     * style for a glyph that has none is how the travelling pill gets the rect
     * of a word it is sliding toward — that word does not wear the pill yet,
     * and asking for its geometry must not require giving it one.
     */
    highlightOf?: (index: number) => TextHighlight | null;
  } = {},
): HighlightPill[] {
  const pills: HighlightPill[] = [];
  let run: HighlightPill | null = null;
  let startX = 0;
  let endX = 0;

  const bands = lineInkBands(layout);

  const flush = () => {
    if (!run) return;
    const h = run.highlight;
    // THE BOX IS CENTRED ON THE LETTERS, because it is measured from them.
    //
    // Twice now this was measured from something that merely CONTAINS the
    // letters. First the em box, which is taller than they are and sits lower,
    // so an all-caps word wore a strip of empty colour underneath. Then the
    // face's own cap height and descender depth — "H" is as tall as the font
    // gets, "g" as deep — which is the same mistake one step smaller: a word of
    // capitals still reserved room for a tail it does not have, so the text
    // rode high in its own highlight no matter the font or the line height.
    //
    // The band is the line's REAL ink (`lineInkBands`). Padding is then the
    // padding you asked for, the same above as below, and the text is centred
    // because there is nothing left in the box that is not a letter.
    const band = bands.get(run.line);
    // No ink on the line at all — whitespace, or an engine with no metrics.
    // The house rule is the fallback, not the design.
    const ascent = band ? band.ascent : run.fontSize * LINE_ASCENT_RATIO;
    const descent = band ? band.descent : run.fontSize * (1 - LINE_ASCENT_RATIO);
    run.height = ascent + descent + h.paddingY * 2;
    run.y = run.baselineY - ascent - h.paddingY;
    run.x = startX - h.paddingX;
    run.width = endX - startX + h.paddingX * 2;
    pills.push(run);
    run = null;
  };

  for (let i = 0; i < layout.glyphs.length; i++) {
    const g = layout.glyphs[i]!;
    const h = options.highlightOf ? options.highlightOf(i) : g.style.highlight;
    // A newline has no width and no ink; a pill across one would reach into the
    // next line's box.
    if (!h || g.char === "\n" || options.visible?.(i) === false) {
      flush();
      continue;
    }
    if (
      run &&
      (run.line !== g.line ||
        !sameHighlight(run.highlight, h) ||
        options.continues?.(run.end, i) === false)
    ) {
      flush();
    }
    if (!run) {
      startX = g.x;
      endX = g.x + g.width;
      run = {
        highlight: h,
        start: i,
        end: i,
        line: g.line,
        depth: g.styleDepth,
        fontSize: g.style.fontSize,
        baselineY: g.y,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      };
    } else {
      run.end = i;
      endX = g.x + g.width;
      run.fontSize = Math.max(run.fontSize, g.style.fontSize);
      if (g.styleDepth > run.depth) run.depth = g.styleDepth;
    }
  }
  flush();
  // `Array.prototype.sort` is stable, so equal depths keep glyph order.
  return pills.sort((a, b) => a.depth - b.depth);
}

/**
 * THE PILL A GRAPHEME SPAN WOULD WEAR, given a highlight style — the geometry
 * half of the travelling pill.
 *
 * Measured through `highlightPills` rather than beside it, so the rect the
 * pill slides to is the identical rect it would have had sitting still: box
 * height from the line's real ink, padding applied once, the same rounding.
 * A second measurer here is how a sliding pill ends up a pixel taller than a
 * resting one, which reads as a jump at the end of every word.
 *
 * Null when the span has no ink (a cue over whitespace). A span that wraps
 * returns the run on its FIRST line — a pill cannot be in two places, and the
 * caller cuts rather than slides across a line break anyway.
 */
export function spanPill(
  layout: TextLayout,
  start: number,
  end: number,
  highlight: TextHighlight,
): HighlightPill | null {
  const within = (i: number) => {
    const gi = layout.glyphs[i]!.graphemeIndex;
    return gi >= start && gi < end;
  };
  const pills = highlightPills(layout, { highlightOf: (i) => (within(i) ? highlight : null) });
  return pills[0] ?? null;
}

/**
 * The union of every pill rect, layout coords — null when the block has none.
 *
 * With `anim`, the pills WHERE THE PAINTER PUTS THEM. The caller that matters
 * is "clip content": that mask is the box union the pills, and a mask built
 * from the resting pills squares the corners off the one pill that is moving.
 */
export function highlightBounds(layout: TextLayout, anim?: GlyphAnim): LayoutRect | null {
  const pills = highlightPills(layout, anim ? paintedRunRules(anim) : {});
  if (pills.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pills) {
    const r = anim
      ? posedRect(
          { minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height },
          anim.visualAt(p.start),
          anim.pivotXAt(p.start),
          p.baselineY,
        )
      : { minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height };
    minX = Math.min(minX, r.minX);
    minY = Math.min(minY, r.minY);
    maxX = Math.max(maxX, r.maxX);
    maxY = Math.max(maxY, r.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * EVERYTHING THIS BLOCK PAINTS, in layout coordinates — the honest answer to
 * "how big a buffer does this layer need?".
 *
 * A text layer's ink used to be declared as its typographic box, which is not
 * where it paints, and the gap showed up twice:
 *
 *   a HIGHLIGHT PILL is drawn wider and taller than the run behind it, so every
 *   buffer measured from the box cut the pill at exactly its padding — and
 *   because the cut lands where the corner radius is, the symptom is a pill
 *   with its ROUNDED CORNERS SQUARED OFF
 *
 *   a LINE INSIDE A FIXED BOX is placed against the BOX, not against the
 *   content: a left-aligned line in a box wider than the longest line starts at
 *   the box's left edge, well outside a content-sized rect, so the glyphs
 *   themselves were being trimmed
 *
 *   a GLYPH IS DRAWN UNDER ITS ANIMATION POSE and the layout is the text at
 *   REST, so a word that scales up — an in/out preset, or the pop a caption
 *   plays on the cue being spoken — and the highlight pill riding with it both
 *   grew straight past a buffer measured for the resting block. That is the one
 *   this file kept being blamed for and never caused: the pill's geometry was
 *   right, its ROOM was not, and the cut landed on the padding, so a rounded
 *   pill came back square-edged on whichever side had run out of buffer
 *
 * All three are the same mistake — measuring paint with a box that describes
 * position. Pass `anim` and the extent is the union of the quads the painter is
 * about to draw, which is the rule `layer-region.ts` states for every other
 * layer kind; omit it and you get the resting ink, which is all a still needs.
 * The box (what the layer poses about, what a pivot is a fraction of, what the
 * selection handles sit on) stays exactly what it was, so nothing moves in any
 * document; this is only what a raster has to hold.
 */
export function textInkBounds(layout: TextLayout, anim?: GlyphAnim): LayoutRect {
  // The declared box is always part of the ink: an empty text layer still owns
  // its rectangle, and a fixed box is what "clip content" would trim to.
  const w = layout.clipBox?.width ?? layout.width;
  const h = layout.clipBox?.height ?? layout.height;
  const acc = {
    minX: -w / 2,
    minY: -h / 2,
    maxX: w / 2,
    maxY: h / 2,
  };
  const add = (
    rect: LayoutRect,
    vis: GlyphVisual | null,
    pivotX: number,
    baselineY: number,
    outset = 0,
  ) => {
    const r = outset
      ? { minX: rect.minX - outset, minY: rect.minY - outset, maxX: rect.maxX + outset, maxY: rect.maxY + outset }
      : rect;
    const b = vis ? posedRect(r, vis, pivotX, baselineY) : r;
    acc.minX = Math.min(acc.minX, b.minX);
    acc.minY = Math.min(acc.minY, b.minY);
    acc.maxX = Math.max(acc.maxX, b.maxX);
    acc.maxY = Math.max(acc.maxY, b.maxY);
  };

  for (let i = 0; i < layout.glyphs.length; i++) {
    const g = layout.glyphs[i]!;
    const size = g.style.fontSize;
    const vis = anim ? anim.visualAt(i) : null;
    if (vis && vis.opacity <= 0.001) continue;
    add(
      {
        minX: g.x,
        // The house box OR the glyph's real ink, whichever reaches further: a
        // tall accent outruns the ratio, and a buffer that under-reserves cuts.
        minY: g.y - Math.max(size * LINE_ASCENT_RATIO, g.inkAscent),
        maxX: g.x + g.width,
        maxY: g.y + Math.max(size * (1 - LINE_ASCENT_RATIO), g.inkDescent),
      },
      vis,
      anim ? anim.pivotXAt(i) : 0,
      g.y,
      // A per-glyph animation blur is a CSS filter, which reaches about three
      // radii past the ink it softens; faux bold grows every edge by its own.
      (vis ? vis.blur * 3 : 0) + fauxBoldOutset(g.style),
    );
  }

  // The pills the PAINTER will draw — same run breaks, same poses.
  const pills = highlightBounds(layout, anim);
  if (pills) add(pills, null, 0, 0);
  return acc;
}
