import type { AnimationUnit } from "../schema";

export interface Grapheme {
  /** The grapheme cluster (may be multi-code-unit: emoji, combining marks). */
  char: string;
  /** Index into the original string (code units), for mapping back to string ops. */
  stringIndex: number;
}

export interface TextSegmentation {
  /** The exact string this segmentation describes — carried so a consumer
   *  handed a `seg` can tell whether it matches the content it expected
   *  (see `epochForSeg`), instead of guessing from the grapheme count. */
  text: string;
  graphemes: Grapheme[];
  /** Per grapheme: index of the word it belongs to (whitespace joins the previous word). */
  wordIndex: number[];
  /** Per grapheme: index of the line it's on (explicit newlines only). */
  lineIndex: number[];
  wordCount: number;
  lineCount: number;
}

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

export function splitGraphemes(text: string): Grapheme[] {
  if (graphemeSegmenter) {
    const out: Grapheme[] = [];
    for (const seg of graphemeSegmenter.segment(text)) {
      out.push({ char: seg.segment, stringIndex: seg.index });
    }
    return out;
  }
  // Fallback: code points (handles surrogate pairs, not full clusters).
  const out: Grapheme[] = [];
  let i = 0;
  for (const char of text) {
    out.push({ char, stringIndex: i });
    i += char.length;
  }
  return out;
}

const isSpace = (c: string) => /^\s+$/.test(c);

/**
 * Segment text once; all animation/range logic addresses graphemes by index
 * so multi-byte characters (emoji, RTL scripts) animate as single units.
 */
export function segmentText(text: string): TextSegmentation {
  const graphemes = splitGraphemes(text);
  const wordIndex: number[] = [];
  const lineIndex: number[] = [];

  let word = -1;
  let line = 0;
  let prevWasSpace = true;

  for (const g of graphemes) {
    if (g.char === "\n") {
      lineIndex.push(line);
      line += 1;
      // Newline attaches to the previous word for animation purposes.
      wordIndex.push(Math.max(word, 0));
      prevWasSpace = true;
      continue;
    }
    const space = isSpace(g.char);
    if (!space && prevWasSpace) word += 1;
    prevWasSpace = space;
    wordIndex.push(Math.max(word, 0));
    lineIndex.push(line);
  }

  return {
    text,
    graphemes,
    wordIndex,
    lineIndex,
    wordCount: Math.max(word + 1, graphemes.length > 0 ? 1 : 0),
    lineCount: graphemes.length > 0 ? line + 1 : 0,
  };
}

/** Unit index of a grapheme for a given animation unit. */
export function unitIndexOf(seg: TextSegmentation, graphemeIndex: number, unit: AnimationUnit): number {
  switch (unit) {
    case "letter":
      return graphemeIndex;
    case "word":
      return seg.wordIndex[graphemeIndex] ?? 0;
    case "line":
      return seg.lineIndex[graphemeIndex] ?? 0;
  }
}

export function unitCountOf(seg: TextSegmentation, unit: AnimationUnit): number {
  switch (unit) {
    case "letter":
      return seg.graphemes.length;
    case "word":
      return seg.wordCount;
    case "line":
      return seg.lineCount;
  }
}

/**
 * The text of the unit a grapheme belongs to — one letter, one word, or one
 * line. Lives here beside `unitIndexOf` so "which unit is this?" and "what does
 * that unit say?" are answered by the same module; the Animate panel's rhythm
 * strip labels its ticks with it.
 */
export function unitTextOf(seg: TextSegmentation, graphemeIndex: number, unit: AnimationUnit): string {
  if (unit === "letter") return seg.graphemes[graphemeIndex]?.char ?? "";
  const target = unitIndexOf(seg, graphemeIndex, unit);
  const list = unit === "word" ? seg.wordIndex : seg.lineIndex;
  let out = "";
  for (let i = 0; i < seg.graphemes.length; i++) {
    if (list[i] === target) out += seg.graphemes[i]!.char;
  }
  return out.trim();
}


/**
 * Memoized segmentation keyed by text identity. Evaluation runs every frame and
 * caption edits re-slice the same string many times per gesture, so the cache
 * lives WITH the segmenter rather than beside one of its callers.
 */
const segCache = new Map<string, TextSegmentation>();
export function segmentTextCached(text: string): TextSegmentation {
  let seg = segCache.get(text);
  if (!seg) {
    seg = segmentText(text);
    if (segCache.size > 512) segCache.clear();
    segCache.set(text, seg);
  }
  return seg;
}
