import type { Easing } from "../schema/common";

/**
 * NUMBERS THAT COUNT — the headless half of count-up text.
 *
 * A text layer's content is keyframable, and content holds between keys: "I
 * made 0" becomes "I made 100" in one cut. When the two keys differ in a
 * NUMBER, that number should instead count 0 → 1 → 2 … → 100 across the
 * segment, on the key's own easing, keeping its decimals, sign, digit system
 * and thousands separators, and landing on the exact value at the key.
 *
 * The model is a NUMBER OBJECT, not a run of letters:
 *
 *  • A number is identified by its SLOT — it is the nth number in the text.
 *    The nth number of one key and the nth number of the next are the same
 *    object, whatever their lengths (9 → 10, 0 → 999, 0.00 → 12.50), and
 *    whatever else about the sentence changed at that key.
 *  • While it counts, everything that addresses text by grapheme index — the
 *    glyph schedule, range styles, range keyframes, range animations — is
 *    mapped THROUGH the object (`CountedView`): a range that covers the number
 *    covers every value it passes through, so 9 → 10 never renders the "1" in
 *    one colour and the "0" in another, and the digits never re-animate as
 *    "new letters" when the count grows a digit.
 *  • Each object can be switched off (`CountUpSetting`); off, the content cuts
 *    at the key exactly as it always has.
 *
 * Pure; the text schedule (`schedule.ts`) is the only caller that builds views.
 */

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/** Which digits a number was written in — preserved while it counts. */
export type DigitSystem = "latin" | "arabic" | "persian";

const DIGIT_BASE: Record<DigitSystem, number> = { latin: 0x30, arabic: 0x660, persian: 0x6f0 };

function digitOf(ch: string | undefined): { system: DigitSystem; value: number } | null {
  if (!ch || ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  for (const system of ["latin", "arabic", "persian"] as const) {
    const base = DIGIT_BASE[system];
    if (c >= base && c <= base + 9) return { system, value: c - base };
  }
  return null;
}

const GROUP_SEPS = new Set([",", "٬"]); // ASCII comma, Arabic thousands separator
const DECIMAL_SEPS = new Set([".", "٫"]); // full stop, Arabic decimal separator
const MINUS = new Set(["-", "−"]);

export interface NumberToken {
  /** Grapheme range `[start, end)` in the text it was read from. */
  start: number;
  end: number;
  value: number;
  /** Digits after the decimal separator. */
  decimals: number;
  /** Integer digits as written — "007" is 3, so leading zeros survive. */
  intDigits: number;
  leadingZeros: boolean;
  system: DigitSystem;
  groupSep: string | null;
  decimalSep: string;
}

const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);

/**
 * Every number in a grapheme sequence, left to right (logical order). A minus
 * counts only when it cannot be a hyphen ("COVID-19" is 19, "-5°" is −5);
 * separators count only between digits in their proper positions, so a
 * sentence's full stop or comma is never swallowed into a number.
 */
export function numberTokens(graphemes: readonly string[]): NumberToken[] {
  const out: NumberToken[] = [];
  let i = 0;
  while (i < graphemes.length) {
    const d0 = digitOf(graphemes[i]);
    if (!d0) {
      i++;
      continue;
    }
    let start = i;
    let negative = false;
    if (i > 0 && MINUS.has(graphemes[i - 1]!) && !isWordChar(graphemes[i - 2])) {
      start = i - 1;
      negative = true;
    }
    const system = d0.system;
    let intPart = "";
    let groupSep: string | null = null;
    let j = i;
    // Integer digits, with thousands groups of exactly three.
    while (j < graphemes.length) {
      const d = digitOf(graphemes[j]);
      if (d && d.system === system) {
        intPart += d.value;
        j++;
        continue;
      }
      const sep = graphemes[j]!;
      if (GROUP_SEPS.has(sep) && (groupSep === null || groupSep === sep)) {
        const next3 = graphemes.slice(j + 1, j + 4).map(digitOf);
        const after = digitOf(graphemes[j + 4]);
        if (next3.length === 3 && next3.every((x) => x && x.system === system) && !(after && after.system === system)) {
          groupSep = sep;
          j++;
          continue;
        }
      }
      break;
    }
    let decimals = 0;
    let fracPart = "";
    let decimalSep = ".";
    const sep = graphemes[j];
    const firstFrac = digitOf(graphemes[j + 1]);
    if (sep && DECIMAL_SEPS.has(sep) && firstFrac && firstFrac.system === system) {
      decimalSep = sep;
      j++;
      while (j < graphemes.length) {
        const d = digitOf(graphemes[j]);
        if (!d || d.system !== system) break;
        fracPart += d.value;
        decimals++;
        j++;
      }
    }
    const magnitude = Number(`${intPart}${fracPart ? `.${fracPart}` : ""}`);
    out.push({
      start,
      end: j,
      value: negative ? -magnitude : magnitude,
      decimals,
      intDigits: intPart.length,
      leadingZeros: intPart.length > 1 && intPart[0] === "0",
      system,
      groupSep,
      decimalSep,
    });
    i = j;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export interface NumberFormat {
  decimals: number;
  /** Minimum integer digits (leading zeros), 1 when none were written. */
  minInt: number;
  system: DigitSystem;
  groupSep: string | null;
  decimalSep: string;
}

/** The format a count between two tokens is written in: the richer of the two. */
export function countFormat(a: NumberToken, b: NumberToken): NumberFormat {
  return {
    decimals: Math.max(a.decimals, b.decimals),
    minInt: Math.max(a.leadingZeros ? a.intDigits : 1, b.leadingZeros ? b.intDigits : 1),
    system: a.system,
    groupSep: a.groupSep ?? b.groupSep,
    decimalSep: a.decimals > 0 ? a.decimalSep : b.decimalSep,
  };
}

/** Write a value in a format — graphemes, one per character. */
export function formatNumber(value: number, fmt: NumberFormat): string[] {
  const fixed = Math.abs(value).toFixed(fmt.decimals);
  const [intRaw = "0", frac = ""] = fixed.split(".");
  let int = intRaw.padStart(fmt.minInt, "0");
  if (fmt.groupSep) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, fmt.groupSep);
  // Never "-0" or "-0.00": a count passing through zero reads as zero.
  const negative = value < 0 && Number(fixed) !== 0;
  const text = `${negative ? "-" : ""}${int}${frac ? fmt.decimalSep + frac : ""}`;
  const base = DIGIT_BASE[fmt.system];
  return [...text].map((ch) => (ch >= "0" && ch <= "9" ? String.fromCharCode(base + ch.charCodeAt(0) - 0x30) : ch));
}

/* -------------------------------------------------------------------------- */
/* Settings and objects                                                        */
/* -------------------------------------------------------------------------- */

/** Per number object: whether it counts, and on which curve (null = the key's). */
export interface CountUpSetting {
  slot: number;
  enabled: boolean;
  easing: Easing | null;
  /**
   * How many values the count shows on its way — null = every value (auto).
   * N quantises the EASED progress into N equal steps, so the number jumps N
   * times and waits on each step as long as the curve says.
   */
  steps?: number | null;
}

export function countSettingFor(settings: readonly CountUpSetting[] | undefined, slot: number): CountUpSetting {
  return settings?.find((s) => s.slot === slot) ?? { slot, enabled: true, easing: null, steps: null };
}

/** One number object as the inspector lists it: its slot and every value it takes. */
export interface CountUpObject {
  slot: number;
  /** The number's written value at each content key, in time order (null = the key has no nth number). */
  values: Array<string | null>;
  /** True when at least two consecutive keys hold different values — i.e. it would count. */
  changes: boolean;
}

/**
 * The number objects a content-keyed text holds. Empty for static content —
 * with one key there is nothing to count between.
 */
export function countUpObjects(keyTexts: readonly string[]): CountUpObject[] {
  if (keyTexts.length < 2) return [];
  const per = keyTexts.map((t) => {
    const g = [...segmentGraphemes(t)];
    return numberTokens(g).map((tok) => ({ tok, raw: g.slice(tok.start, tok.end).join("") }));
  });
  const slots = Math.max(0, ...per.map((p) => p.length));
  const out: CountUpObject[] = [];
  for (let slot = 0; slot < slots; slot++) {
    const values = per.map((p) => p[slot]?.raw ?? null);
    let changes = false;
    for (let k = 1; k < per.length; k++) {
      const a = per[k - 1]![slot];
      const b = per[k]![slot];
      if (a && b && a.tok.value !== b.tok.value) changes = true;
    }
    out.push({ slot, values, changes });
  }
  return out;
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function segmentGraphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : [...text];
}

/* -------------------------------------------------------------------------- */
/* A count across one content segment                                          */
/* -------------------------------------------------------------------------- */

/** One number counting across a segment: from a token of the earlier key to one of the later. */
export interface CountSpan {
  slot: number;
  from: NumberToken;
  to: NumberToken;
  format: NumberFormat;
  easing: Easing;
  steps: number | null;
}

/**
 * THE progress of a count at raw segment progress `raw` — eased, then
 * quantised to the span's steps. Every reader (the picture, the digit
 * arrivals, the sound ticks) goes through this, so they cannot drift apart.
 */
export function spanProgress(span: CountSpan, raw: number, ease: (easing: Easing, u: number) => number): number {
  const e = ease(span.easing, Math.min(1, Math.max(0, raw)));
  if (!span.steps || raw >= 1) return e;
  return Math.min(1, Math.floor(e * span.steps + 1e-9) / span.steps);
}

/** Can every value between this number and another be shown digit for digit? */
function exactlyCountable(t: NumberToken): boolean {
  return Math.abs(t.value) <= Number.MAX_SAFE_INTEGER / 10 ** t.decimals && t.intDigits + t.decimals <= 15;
}

/**
 * The counts that run between two content keys: every slot both texts hold
 * whose value differs and whose object is switched on.
 */
export function countSpans(
  from: readonly string[],
  to: readonly string[],
  keyEasing: Easing,
  settings: readonly CountUpSetting[] | undefined,
): CountSpan[] {
  const a = numberTokens(from);
  const b = numberTokens(to);
  const spans: CountSpan[] = [];
  for (let slot = 0; slot < Math.min(a.length, b.length); slot++) {
    const setting = countSettingFor(settings, slot);
    if (!setting.enabled) continue;
    const ta = a[slot]!;
    const tb = b[slot]!;
    if (ta.value === tb.value) continue;
    // A HOLD key cuts to the next text — that is what hold means on every
    // track — so nothing counts across it. Counted anyway, a held number was
    // shown as its parsed double for the whole hold.
    const easing = setting.easing ?? keyEasing;
    if (easing.kind === "hold") continue;
    // A count is exact or it is not a count: past 2^53 a double cannot hold
    // the digits, and "450284102701938521" was shown as …938496, 23 digits as
    // 4.5e+22. Such numbers cut like any other text.
    if (!exactlyCountable(ta) || !exactlyCountable(tb)) continue;
    spans.push({
      slot,
      from: ta,
      to: tb,
      format: countFormat(ta, tb),
      easing,
      steps: setting.steps && setting.steps > 0 ? Math.round(setting.steps) : null,
    });
  }
  return spans;
}

/**
 * THE COUNTED VIEW of a text at progress `u` along its segments: the new
 * graphemes, and for every one of them the index in the source text it stands
 * for. A digit of a counting number maps to its number's FIRST source digit,
 * so whatever the source digit carries (its arrival time, the range around it)
 * the whole counting number carries.
 */
export interface CountedText {
  graphemes: string[];
  /** Per counted grapheme: its source grapheme index. */
  source: number[];
  /** Per counting slot: where it sits in the source and in the counted text. */
  slots: Array<{ srcStart: number; srcEnd: number; start: number; end: number }>;
}

export function countedText(
  source: readonly string[],
  spans: readonly CountSpan[],
  progress: (span: CountSpan) => number,
): CountedText {
  const byStart = [...spans].sort((x, y) => x.from.start - y.from.start);
  const graphemes: string[] = [];
  const src: number[] = [];
  const slots: CountedText["slots"] = [];
  let i = 0;
  for (const span of byStart) {
    for (; i < span.from.start; i++) {
      graphemes.push(source[i]!);
      src.push(i);
    }
    const u = Math.min(1, Math.max(0, progress(span)));
    const value = span.from.value + (span.to.value - span.from.value) * u;
    const digits = formatNumber(value, span.format);
    const start = graphemes.length;
    for (const d of digits) {
      graphemes.push(d);
      src.push(span.from.start);
    }
    slots.push({ srcStart: span.from.start, srcEnd: span.from.end, start, end: graphemes.length });
    i = span.from.end;
  }
  for (; i < source.length; i++) {
    graphemes.push(source[i]!);
    src.push(i);
  }
  return { graphemes, source: src, slots };
}

/**
 * Map a SOURCE grapheme span `[start, end)` into the counted text. A span that
 * touches a counting number snaps to the whole number — a range around "9"
 * covers "10" too — and everything after a number moves with its length.
 */
export function mapSpanThroughCount(view: CountedText, start: number, end: number): { start: number; end: number } {
  const mapPos = (pos: number, isEnd: boolean) => {
    let shift = 0;
    for (const s of view.slots) {
      if (pos <= s.srcStart) break;
      if (pos < s.srcEnd) return isEnd ? s.end : s.start; // inside a number: snap outward
      shift += s.end - s.start - (s.srcEnd - s.srcStart);
    }
    return pos + shift;
  };
  return { start: mapPos(start, false), end: mapPos(end, true) };
}

/**
 * The number-to-number map between two texts that differ ONLY in their
 * numbers ("0+" and "40+"), as a counted view `mapSpanThroughCount` reads —
 * or null when anything else changed, where no honest mapping exists.
 *
 * Mid-count, ranges already ride the counting number. After the count lands
 * the text IS the key's text, and ranges written against the base text were
 * applied by raw index — so a "+" styled after "0" painted the "0" of "40".
 * This is the settled half of the same rule: a range after a number moves
 * with its length, at rest as well as in motion.
 */
export function numberAlignedView(fromText: string, toText: string): CountedText | null {
  const from = segmentGraphemes(fromText);
  const to = segmentGraphemes(toText);
  const a = numberTokens(from);
  const b = numberTokens(to);
  if (a.length !== b.length || a.length === 0) return null;
  const skeleton = (g: readonly string[], toks: NumberToken[]) => {
    const out: string[] = [];
    let i = 0;
    for (const t of toks) {
      out.push(g.slice(i, t.start).join(""));
      i = t.end;
    }
    out.push(g.slice(i).join(""));
    return out.join("\u0000");
  };
  if (skeleton(from, a) !== skeleton(to, b)) return null;
  return {
    graphemes: [...to],
    source: [],
    slots: a.map((t, k) => ({ srcStart: t.start, srcEnd: t.end, start: b[k]!.start, end: b[k]!.end })),
  };
}

/* -------------------------------------------------------------------------- */
/* When each digit last changed                                                */
/* -------------------------------------------------------------------------- */

/** Per character of a formatted number: its decimal place (0 = ones, -1 = tenths), or null for signs and separators. */
function placesOf(chars: readonly string[], fmt: NumberFormat): Array<number | null> {
  const isDigit = (c: string) => digitOf(c) !== null;
  const dec = chars.indexOf(fmt.decimalSep);
  const intEnd = fmt.decimals > 0 && dec >= 0 ? dec : chars.length;
  const intDigits = chars.slice(0, intEnd).filter(isDigit).length;
  let seenInt = 0;
  let seenFrac = 0;
  return chars.map((c, i) => {
    if (!isDigit(c)) return null;
    if (i < intEnd) return intDigits - 1 - seenInt++;
    return -1 - seenFrac++;
  });
}

export interface DigitArrival {
  /** When this digit took its current value (clip-local ms), or null when it has not changed this segment. */
  changedAtMs: number | null;
  /** How long its previous value was on screen before that change. */
  heldMs: number;
}

/**
 * For every character of a counting number at `localMs`, when its digit last
 * changed and how long the value before it was held — what lets a digit play
 * the text's in-animation as it changes (letter-grained), or the whole number
 * as it ticks (word-grained), and lets the caller skip changes too fast to be
 * animated at all. Solved by bisection on the easing, so it is exact to the
 * frame whatever the curve, with no history kept between frames.
 */
export function digitArrivals(
  span: CountSpan,
  fromMs: number,
  toMs: number,
  localMs: number,
  ease: (easing: Easing, u: number) => number,
): DigitArrival[] {
  const len = toMs - fromMs;
  const d = span.format.decimals;
  const scale = 10 ** d;
  const value = (u: number) => span.from.value + (span.to.value - span.from.value) * spanProgress(span, u, ease);
  const scaled = (u: number) => Math.round(Math.abs(value(u)) * scale);
  const u = Math.min(1, Math.max(0, (localMs - fromMs) / len));
  const chars = formatNumber(value(u), span.format);
  const places = placesOf(chars, span.format);

  /** The smallest progress in [lo, hi] whose bucket equals `bucket(hi)` (the bucket is monotone within a count). */
  const startOf = (bucket: (x: number) => number, lo: number, hi: number) => {
    const target = bucket(hi);
    if (bucket(lo) === target) return lo;
    let a = lo;
    let b = hi;
    for (let k = 0; k < 24; k++) {
      const m = (a + b) / 2;
      if (bucket(m) === target) b = m;
      else a = m;
    }
    return b;
  };

  return places.map((p) => {
    if (p === null) return { changedAtMs: null, heldMs: 0 };
    const unit = 10 ** (p + d);
    const bucket = (x: number) => Math.floor(scaled(x) / unit);
    const began = startOf(bucket, 0, u);
    if (began <= 0) return { changedAtMs: null, heldMs: 0 };
    const before = startOf(bucket, 0, Math.max(0, began - 1e-9));
    return { changedAtMs: fromMs + began * len, heldMs: (began - before) * len };
  });
}
