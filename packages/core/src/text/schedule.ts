import type { AnimationSpec, AnimationUnit } from "../schema";
import type { Easing } from "../schema/common";
import { evaluateEasing } from "../easing";
import { segmentText, unitIndexOf, type TextSegmentation } from "./segment";
import { diffAsSplice } from "./ranges";
import { countSpans, countedText, spanProgress, type CountSpan, type CountUpSetting, type CountedText } from "./count-up";

/**
 * THE text animation schedule — the one answer to "when does this piece of text
 * move, and why".
 *
 * Historically the renderer and the audio engine each derived their own answer
 * (`evalSpecAtUnit` walked `unitIndex * stagger` from the clip start; the cue
 * walker re-implemented the same arithmetic over `clip.text`). Two derivations
 * of one fact is a defect waiting for its ticket, and it got one: the moment a
 * clip's content was KEYFRAMED the two stopped agreeing entirely — the picture
 * showed the keyed text while the clicks were still being scheduled for the
 * base string. Both now read this module, so they cannot drift by construction.
 *
 * The model: a text clip's content is a sequence of EPOCHS (one per `text`
 * keyframe, one total when the content is static). Between two epochs the
 * grapheme diff splits into a departing cohort and an arriving cohort — so
 * changing "A B C D" into "A E F G" plays the out-animation on "B C D" and the
 * in-animation on "E F G", while "A " is never touched. Every glyph therefore
 * carries a LIFESPAN, and its animations are anchored to the ends of that
 * lifespan rather than to the clip's.
 *
 * Ordering convention: a departing cohort FINISHES at the cut and the arriving
 * cohort STARTS at it. That keeps layout honest — only one content string is
 * ever on screen, so nothing has to lay out ghost glyphs that the current text
 * no longer contains — and it reads the way the edit reads: the old words
 * leave, the new words arrive.
 */

/** One content state of a text clip, live over `[fromMs, toMs)` (clip-local). */
export interface TextEpoch {
  /** Position in `TextTimeline.epochs` — carried so a consumer holding an epoch
   *  can match it against epoch-tagged data without an identity search. */
  index: number;
  fromMs: number;
  toMs: number;
  text: string;
  seg: TextSegmentation;
  /**
   * Per grapheme: the clip-local ms its ARRIVING cohort begins. Graphemes that
   * survived an earlier cut inherit the time they originally arrived, so the
   * unchanged half of an edit never re-animates.
   */
  enterAtMs: number[];
  /**
   * Per grapheme: the clip-local ms by which it must be GONE — the cut that
   * removes it, or the clip's end for survivors. Out-animations are anchored to
   * finish exactly here.
   */
  exitAtMs: number[];
  /** Lazily built cohort rankings, keyed `${phase}:${unit}` (see `cohortIndex`). */
  cohorts: Map<string, CohortIndex>;
  /**
   * The numbers that COUNT from this epoch toward the next one (`count-up.ts`)
   * — over `[fromMs, toMs)`, from the last key that held this text to the key
   * that ends it. Absent when nothing counts.
   */
  count?: { spans: CountSpan[]; fromMs: number; toMs: number };
  /**
   * Set only on a COUNTED VIEW (what `epochAt` returns mid-count): how the
   * counted text maps back to this epoch's own graphemes. Anything indexed by
   * grapheme — ranges, range keyframes, range animations — reads its source
   * index through it.
   */
  view?: CountedText;
}

export interface TextTimeline {
  epochs: TextEpoch[];
  durationMs: number;
}

/** A `text` keyframe reduced to what the schedule needs. */
export interface TextContentKey {
  timeMs: number;
  text: string;
  /** The easing of the segment leaving this key — what a counting number rides. */
  easing?: Easing;
}

/**
 * Build the epoch timeline from a clip's content keys. `baseText` is the
 * clip's own string, used when it has no keys at all. The first epoch always
 * starts at 0 — keyframe sampling holds the first key's value backwards in
 * time, and the schedule must agree with the sampler exactly.
 */
export function buildTextTimeline(
  baseText: string,
  keys: TextContentKey[],
  durationMs: number,
  countUps?: readonly CountUpSetting[],
): TextTimeline {
  const sorted = keys.slice().sort((a, b) => a.timeMs - b.timeMs);
  const texts: TextContentKey[] =
    sorted.length === 0 ? [{ timeMs: 0, text: baseText }] : sorted.slice();
  // The first key reaches backwards to the clip start (held), so epoch 0 opens
  // at 0 no matter where that key sits.
  texts[0] = { timeMs: 0, text: texts[0]!.text };

  const epochs: TextEpoch[] = [];
  // Index of each grapheme in the NEXT epoch, or -1 when the cut removes it.
  const forward: number[][] = [];
  // The last key that held the current epoch's text — where its count starts,
  // and whose easing it rides (keyframe semantics: a segment runs from the key
  // before the change to the key that makes it).
  let holdMs = 0;
  let holdEasing: Easing = { kind: "linear" };

  for (let k = 0; k < texts.length; k++) {
    const { timeMs, text } = texts[k]!;
    const keyEasing = sorted[k]?.easing ?? { kind: "linear" };
    // A repeated value is not a content change — collapsing it here keeps a
    // "re-key the same words" edit from re-animating the whole line.
    const prev = epochs[epochs.length - 1];
    if (prev && prev.text === text) {
      holdMs = Math.max(0, timeMs);
      holdEasing = keyEasing;
      continue;
    }
    const seg = segmentText(text);
    const n = seg.graphemes.length;
    const epoch: TextEpoch = {
      index: epochs.length,
      fromMs: k === 0 ? 0 : Math.max(0, timeMs),
      toMs: durationMs,
      text,
      seg,
      enterAtMs: new Array<number>(n).fill(k === 0 ? 0 : Math.max(0, timeMs)),
      exitAtMs: new Array<number>(n).fill(durationMs),
      cohorts: new Map(),
    };

    if (prev) {
      prev.toMs = epoch.fromMs;
      const before = prev.seg.graphemes.map((g) => g.char);
      const after = seg.graphemes.map((g) => g.char);
      const spans = countSpans(before, after, holdEasing, countUps);
      if (spans.length > 0 && epoch.fromMs > holdMs) prev.count = { spans, fromMs: holdMs, toMs: epoch.fromMs };
      forward.push(linkAcrossCut(prev, epoch, before, after, spans));
    }
    epochs.push(epoch);
    // Epoch 0 opens at 0 (its key holds backwards), but its count starts at the
    // key itself — that is where the number is still exactly its first value.
    holdMs = k === 0 ? Math.max(0, sorted[0]?.timeMs ?? 0) : epoch.fromMs;
    holdEasing = keyEasing;
  }

  // Backward pass: a survivor's exit is whatever its future self's exit is, so
  // a glyph that lives through three cuts still leaves exactly once, at the end.
  for (let k = epochs.length - 2; k >= 0; k--) {
    const epoch = epochs[k]!;
    const next = epochs[k + 1]!;
    const link = forward[k]!;
    for (let i = 0; i < epoch.exitAtMs.length; i++) {
      const j = link[i] ?? -1;
      epoch.exitAtMs[i] = j === -1 ? epoch.toMs : next.exitAtMs[j]!;
    }
  }

  return { epochs, durationMs };
}

/**
 * Carry arrival times across a cut and return where each old grapheme lives in
 * the new epoch (-1 = removed).
 *
 * The diff runs over ELEMENTS, not graphemes: a number that counted into this
 * cut is ONE element on both sides, so "0" → "100" is the same object arriving
 * at its destination — it survives the cut instead of leaving as one letter
 * and arriving as three, which would replay the in/out animation on a number
 * that had just finished counting smoothly into place.
 */
function linkAcrossCut(prev: TextEpoch, epoch: TextEpoch, before: string[], after: string[], spans: CountSpan[]): number[] {
  const elements = (chars: string[], side: "from" | "to") => {
    const els: Array<{ key: string; start: number; end: number }> = [];
    const tokens = spans.map((sp) => sp[side]).sort((a, b) => a.start - b.start);
    let i = 0;
    for (const t of tokens) {
      for (; i < t.start; i++) els.push({ key: chars[i]!, start: i, end: i + 1 });
      els.push({ key: `\uE000#${spans.find((sp) => sp[side] === t)!.slot}`, start: t.start, end: t.end });
      i = t.end;
    }
    for (; i < chars.length; i++) els.push({ key: chars[i]!, start: i, end: i + 1 });
    return els;
  };
  const a = elements(before, "from");
  const b = elements(after, "to");
  const splice = diffAsSplice(a.map((e) => e.key), b.map((e) => e.key));
  const link = new Array<number>(before.length).fill(-1);
  for (let j = 0; j < b.length; j++) {
    const survivor = j < splice.at ? j : j >= splice.at + splice.inserted ? j - splice.inserted + splice.removed : -1;
    if (survivor < 0) continue; // inserted → keeps `fromMs`, the arriving cohort
    const src = a[survivor]!;
    const dst = b[j]!;
    // Every grapheme of a surviving element inherits its source's first
    // arrival; every old grapheme of it links to the element's first new one.
    for (let g = dst.start; g < dst.end; g++) epoch.enterAtMs[g] = prev.enterAtMs[src.start] ?? epoch.fromMs;
    for (let g = src.start; g < src.end; g++) link[g] = dst.start;
  }
  return link;
}

/**
 * The epoch live at a clip-local time (the last one that has started) — or,
 * while a number in it is COUNTING toward the next key, the counted view of
 * it: the text as it reads right now, with arrival and exit times carried
 * through the number objects (see `count-up.ts`). Everything that reads
 * content — the string laid out, glyph animation, the caret — comes through
 * here, so none of it needs to know numbers can count.
 */
export function epochAt(timeline: TextTimeline, localMs: number): TextEpoch {
  const { epochs } = timeline;
  let epoch = epochs[0]!;
  for (let i = epochs.length - 1; i > 0; i--) {
    if (localMs >= epochs[i]!.fromMs) {
      epoch = epochs[i]!;
      break;
    }
  }
  const count = epoch.count;
  if (!count || localMs <= count.fromMs || localMs >= count.toMs) return epoch;
  const raw = (localMs - count.fromMs) / (count.toMs - count.fromMs);
  return countedView(epoch, count.spans, raw);
}

const viewCache = new WeakMap<TextEpoch, Map<string, TextEpoch>>();

function countedView(epoch: TextEpoch, spans: CountSpan[], raw: number): TextEpoch {
  const counted = countedText(epoch.seg.graphemes.map((g) => g.char), spans, (sp) => spanProgress(sp, raw, evaluateEasing));
  const text = counted.graphemes.join("");
  if (text === epoch.text) return epoch;
  let views = viewCache.get(epoch);
  if (!views) viewCache.set(epoch, (views = new Map()));
  const hit = views.get(text);
  if (hit) return hit;
  const seg = segmentText(text);
  // A digit that fused with a neighbour into one grapheme would break the
  // index map; hold the key's text rather than animate against wrong indices.
  if (seg.graphemes.length !== counted.graphemes.length) return epoch;
  const view: TextEpoch = {
    ...epoch,
    text,
    seg,
    enterAtMs: counted.source.map((j) => epoch.enterAtMs[j]!),
    exitAtMs: counted.source.map((j) => epoch.exitAtMs[j]!),
    cohorts: new Map(),
    count: undefined,
    view: counted,
  };
  if (views.size > 512) views.clear();
  views.set(text, view);
  return view;
}

/**
 * Per-grapheme position WITHIN its own cohort: the ordinal of its unit among
 * the units that share its cohort time, and how many units that cohort holds.
 *
 * This is what makes a partial edit read correctly. "E F G" arriving as words
 * 1..3 of "A E F G" must stagger 0, 1, 2 — not 1, 2, 3 — or the new words would
 * sit waiting for a stagger slot belonging to a word that arrived long ago.
 */
export interface CohortIndex {
  /** Per grapheme: its unit's ordinal inside its cohort. */
  order: number[];
  /** Per grapheme: the number of distinct units in its cohort. */
  size: number[];
}

export function cohortIndex(
  epoch: TextEpoch,
  unit: AnimationUnit,
  phase: "in" | "out",
): CohortIndex {
  const key = `${phase}:${unit}`;
  const cached = epoch.cohorts.get(key);
  if (cached) return cached;

  const times = phase === "in" ? epoch.enterAtMs : epoch.exitAtMs;
  const n = epoch.seg.graphemes.length;
  // cohort time → sorted distinct unit indices in it
  const byCohort = new Map<number, Set<number>>();
  for (let i = 0; i < n; i++) {
    const t = times[i]!;
    let set = byCohort.get(t);
    if (!set) byCohort.set(t, (set = new Set()));
    set.add(unitIndexOf(epoch.seg, i, unit));
  }
  const ranks = new Map<number, Map<number, number>>();
  const sizes = new Map<number, number>();
  for (const [t, set] of byCohort) {
    const sortedUnits = [...set].sort((a, b) => a - b);
    const rank = new Map<number, number>();
    sortedUnits.forEach((u, idx) => rank.set(u, idx));
    ranks.set(t, rank);
    sizes.set(t, sortedUnits.length);
  }

  const order = new Array<number>(n);
  const size = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = times[i]!;
    order[i] = ranks.get(t)!.get(unitIndexOf(epoch.seg, i, unit)) ?? 0;
    size[i] = sizes.get(t) ?? 1;
  }
  const built: CohortIndex = { order, size };
  epoch.cohorts.set(key, built);
  return built;
}

// ── Per-unit timing (the arithmetic BOTH the renderer and the audio read) ────

/** Wall time a cohort of `unitCount` units needs to complete, jitter included. */
export function animationSpanMs(spec: AnimationSpec, unitCount: number): number {
  if (unitCount <= 0) return 0;
  return (unitCount - 1) * spec.staggerMs + spec.durationMs;
}

/**
 * The clip-local ms a single unit's animation BEGINS.
 *
 * `anchorMs` is the cohort's fixed point: for an entrance, the moment the
 * cohort arrives (0, or the cut that inserted it); for an exit, the deadline it
 * must be gone by (the cut that removes it, or the clip's end).
 *
 * Jitter is deliberately one-sided — entrances only ever LAG and exits only
 * ever LEAVE EARLY. Symmetric jitter would let a glyph overrun its own cut and
 * still be mid-animation when its content no longer exists; one-sided jitter
 * humanises the rhythm with the deadline still guaranteed. It also reads right:
 * hesitation before a keystroke is what real typing sounds like.
 */
export function unitStartMs(
  spec: AnimationSpec,
  order: number,
  cohortSize: number,
  phase: "in" | "out",
  anchorMs: number,
  seed: number,
): number {
  const jitter = spec.jitterMs > 0 ? hash01(seed, 1) * spec.jitterMs : 0;
  if (phase === "in") return anchorMs + spec.delayMs + order * spec.staggerMs + jitter;
  return (
    anchorMs - spec.delayMs - animationSpanMs(spec, cohortSize) + order * spec.staggerMs - jitter
  );
}

/**
 * Deterministic 0..1 seed for one unit's randomisation. Salted with the clip id,
 * the phase and the cohort's anchor so re-running an export, scrubbing, or
 * re-entering a cohort after a content change all reproduce the same variation —
 * and so the sound engine's per-hit randomisation lands on the same value the
 * renderer jittered the glyph with.
 */
export function unitSeed(
  clipId: string,
  phase: "in" | "out",
  anchorMs: number,
  unitIndex: number,
): number {
  let h = 2166136261 ^ unitIndex ^ (phase === "in" ? 0x9e37 : 0x85eb) ^ Math.round(anchorMs);
  for (let i = 0; i < clipId.length; i++) {
    h ^= clipId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

/** A second-order hash: many independent 0..1 draws from one unit seed. */
export function hash01(seed: number, salt: number): number {
  let h = Math.imul(Math.round(seed * 4294967295) ^ Math.imul(salt + 1, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
