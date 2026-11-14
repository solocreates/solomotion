import { createId } from "../ids";
import { emptyOverlay, type ScopeOverlay } from "../schema/scope";
import { detach, overlayIsEmpty, resolveStyle, writeStyleToOverlay } from "../scope";
import type { Link, PartialTextStyle, StyleRange, TextClip, TextStyle } from "../schema";
import { sameLink } from "../links/target";

/**
 * Range algebra for span-based rich text. The invariant maintained everywhere:
 * ranges are sorted by `start` and never overlap. All indices are grapheme
 * indices (`end` exclusive).
 */

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (va !== null && typeof va === "object" && vb !== null && typeof vb === "object") {
      if (JSON.stringify(va) !== JSON.stringify(vb)) return false;
    } else if (va !== vb) return false;
  }
  return true;
}

function rangePayloadEqual(a: StyleRange, b: StyleRange): boolean {
  return (
    shallowEqual(a.overlay.props, b.overlay.props) &&
    JSON.stringify(a.overlay.removed) === JSON.stringify(b.overlay.removed) &&
    JSON.stringify(a.overlay.added) === JSON.stringify(b.overlay.added) &&
    JSON.stringify(a.animation) === JSON.stringify(b.animation) &&
    JSON.stringify(a.sounds) === JSON.stringify(b.sounds) &&
    sameLink(a.link, b.link)
  );
}

function isEmptyPayload(r: StyleRange): boolean {
  return overlayIsEmpty(r.overlay) && r.animation === null && Object.keys(r.sounds).length === 0 && !r.link;
}

/**
 * A range's overlay after a patch: a DETACHED copy of the old one (or a fresh
 * one for a gap) with the patch's style folded in and its mutator run.
 * Detached, because the ranges handed in are usually frozen document state,
 * and the mutator is allowed to write anywhere in the overlay.
 */
function patchedOverlay(base: ScopeOverlay | undefined, patch: RangePatch): ScopeOverlay {
  const next = base ? detach(base) : emptyOverlay();
  next.added.textEffects ??= [];
  if (patch.style) writeStyleToOverlay(next, patch.style);
  patch.overlay?.(next);
  return next;
}

/** Sort, drop empty/degenerate ranges, and merge adjacent ranges with identical payloads. */
export function normalizeRanges(ranges: StyleRange[]): StyleRange[] {
  const sorted = ranges
    .filter((r) => r.end > r.start && !isEmptyPayload(r))
    .slice()
    .sort((a, b) => a.start - b.start);

  const out: StyleRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.end === r.start && rangePayloadEqual(last, r)) {
      last.end = r.end;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

export interface RangePatch {
  /** Typographic convenience — folded into `overlay.props`. */
  style?: PartialTextStyle;
  /**
   * Any other change, as a MUTATION of the range's own overlay: set a prop,
   * delete one, fork a paint list. It runs once per range the span covers (and
   * once for each gap, on an empty overlay), so "make the selection bold" and
   * "let the selection inherit its colour again" are the same shape — and a
   * span over two differently styled ranges keeps each one's other overrides.
   * A value patch could only ever ADD; this is why revert works on a range.
   */
  overlay?: (ov: ScopeOverlay) => void;
  animation?: StyleRange["animation"];
  sounds?: StyleRange["sounds"];
  /** A link for the span; `null` removes it. Undefined leaves each range's own. */
  link?: Link | null;
}

/** The covered part's link after a patch — absent stays absent, never `undefined`-valued. */
function withLink<R extends StyleRange>(range: R, patch: RangePatch, base?: Link): R {
  const link = patch.link !== undefined ? patch.link : base;
  const { link: _drop, ...rest } = range;
  return (link ? { ...rest, link } : rest) as R;
}

/**
 * Apply a patch to [start, end): existing ranges are split at the boundaries,
 * the covered parts get the patch merged in, and uncovered gaps inside the
 * selection become new ranges. Returns a new normalized array.
 */
export function applyRangePatch(
  ranges: StyleRange[],
  start: number,
  end: number,
  patch: RangePatch,
): StyleRange[] {
  if (end <= start) return ranges;
  const next: StyleRange[] = [];
  let cursor = start;
  const covered: Array<[number, number]> = [];

  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const overlapStart = Math.max(r.start, start);
    const overlapEnd = Math.min(r.end, end);
    if (overlapEnd <= overlapStart) {
      next.push(r);
      continue;
    }
    // Left remainder keeps the old payload.
    if (r.start < overlapStart) {
      next.push({ ...r, id: createId("range"), end: overlapStart });
    }
    // Overlapped part gets the patch merged over the old payload.
    next.push(withLink({
      id: createId("range"),
      start: overlapStart,
      end: overlapEnd,
      overlay: patchedOverlay(r.overlay, patch),
      animation: patch.animation !== undefined ? patch.animation : r.animation,
      sounds: patch.sounds !== undefined ? { ...r.sounds, ...patch.sounds } : r.sounds,
    }, patch, r.link));
    covered.push([overlapStart, overlapEnd]);
    // Right remainder keeps the old payload.
    if (r.end > overlapEnd) {
      next.push({ ...r, id: createId("range"), start: overlapEnd });
    }
  }

  // Fill gaps in the selection not covered by any existing range.
  covered.sort((a, b) => a[0] - b[0]);
  for (const [cs, ce] of covered) {
    if (cs > cursor) {
      next.push(withLink({
        id: createId("range"),
        start: cursor,
        end: cs,
        overlay: patchedOverlay(undefined, patch),
        animation: patch.animation ?? null,
        sounds: patch.sounds ?? {},
      }, patch));
    }
    cursor = Math.max(cursor, ce);
  }
  if (cursor < end) {
    next.push(withLink({
      id: createId("range"),
      start: cursor,
      end,
      overlay: patchedOverlay(undefined, patch),
      animation: patch.animation ?? null,
      sounds: patch.sounds ?? {},
    }, patch));
  }

  return normalizeRanges(next);
}

/** Remove all styling/overrides inside [start, end). */
export function clearRange(ranges: StyleRange[], start: number, end: number): StyleRange[] {
  const next: StyleRange[] = [];
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) {
      next.push(r);
      continue;
    }
    if (r.start < start) next.push({ ...r, id: createId("range"), end: start });
    if (r.end > end) next.push({ ...r, id: createId("range"), start: end });
  }
  return normalizeRanges(next);
}

/**
 * Write a typographic patch to the LAYER — the whole-clip edit — and make it
 * win: the same keys are stripped from every range, so a mixed-colour text
 * recolours uniformly when you change the clip's colour instead of keeping
 * three words in the old one. THE base-style writer; every surface that edits
 * a text layer's own style (the inspector, multi-select, keyframe bakes) comes
 * through here so the rule cannot be applied on one path and forgotten on
 * another. Mutates — call inside a document update.
 */
export function applyBaseStyle(clip: TextClip, patch: PartialTextStyle): void {
  Object.assign(clip.style, patch);
  clip.ranges = clearRangeStyleKeys(clip.ranges, Object.keys(patch) as (keyof PartialTextStyle)[]);
}

/** Strip the given style keys from EVERY range. Ranges left empty are pruned. */
export function clearRangeStyleKeys(
  ranges: StyleRange[],
  keys: readonly (keyof PartialTextStyle)[],
): StyleRange[] {
  if (ranges.length === 0 || keys.length === 0) return ranges;
  const next = ranges.map((r) => {
    const props = { ...r.overlay.props };
    for (const k of keys) {
      delete props[k];
      // The pill is stored per-field, so clearing it means clearing all four.
      if (k === "highlight") for (const p of Object.keys(props)) if (p.startsWith("highlight.")) delete props[p];
    }
    return { ...r, overlay: { ...r.overlay, props } };
  });
  return normalizeRanges(next);
}

/**
 * Effective style of a single grapheme = base style + the range covering it.
 * Ranges never overlap, so this is one `resolveStyle` — the same resolver the
 * inspector shows and the renderer paints, which is the whole reason a
 * caption's focused word gets its own everything without layout, measurement
 * or the renderer knowing captions exist (`effectiveRanges` folds the focus in
 * as one more range before this is ever called).
 */
export function styleAt(base: TextStyle, ranges: readonly StyleRange[], graphemeIndex: number): TextStyle {
  const r = rangeAt(ranges, graphemeIndex);
  return r ? resolveStyle(base, r.overlay) : base;
}

/** The range covering a grapheme, if any (ranges are non-overlapping). Generic
 *  so a caller holding `EffectiveRange`s gets one back with its `scope`. */
export function rangeAt<R extends StyleRange>(ranges: readonly R[], graphemeIndex: number): R | null {
  for (const r of ranges) {
    if (graphemeIndex >= r.start && graphemeIndex < r.end) return r;
  }
  return null;
}

/**
 * The merged style shared by every grapheme in [start, end), for inspector
 * display. Values that differ across the selection come back as undefined
 * ("mixed" in the UI).
 */
export function sharedStyleIn(
  base: TextStyle,
  ranges: StyleRange[],
  start: number,
  end: number,
): PartialTextStyle {
  if (end <= start) return {};
  let acc: Record<string, unknown> | null = null;
  for (let i = start; i < end; i++) {
    const s = styleAt(base, ranges, i) as unknown as Record<string, unknown>;
    if (acc === null) {
      acc = { ...s };
    } else {
      for (const k of Object.keys(acc)) {
        const same = JSON.stringify(acc[k]) === JSON.stringify(s[k]);
        if (!same) delete acc[k];
      }
    }
  }
  return (acc ?? {}) as PartialTextStyle;
}

/**
 * Remap ranges after a text splice (used when inline editing changes the text):
 * `at` graphemes were kept, `removed` graphemes deleted, `inserted` added.
 */
export function remapRangesAfterSplice(
  ranges: StyleRange[],
  at: number,
  removed: number,
  inserted: number,
): StyleRange[] {
  const next: StyleRange[] = [];
  for (const r of ranges) {
    const span = remapSpanAfterSplice(r, at, removed, inserted);
    if (span.end > span.start) next.push({ ...r, ...span });
  }
  return normalizeRanges(next);
}

/**
 * Where a grapheme span lands after a splice — the shared arithmetic behind
 * both things this app addresses by position: style ranges and caption cues.
 * Boundaries past the cut shift by the delta; boundaries inside it collapse to
 * the cut. Text typed at a boundary joins the span on its LEFT, which is what
 * extending a word feels like in every editor.
 */
export function remapSpanAfterSplice(
  span: { start: number; end: number },
  at: number,
  removed: number,
  inserted: number,
): { start: number; end: number } {
  const delta = inserted - removed;
  const removedEnd = at + removed;
  const move = (i: number) => (i >= removedEnd ? i + delta : i > at ? at : i);
  return { start: move(span.start), end: move(span.end) };
}

/** Compute the splice (start, removedCount, insertedCount) between two grapheme arrays. */
export function diffAsSplice(
  oldGraphemes: string[],
  newGraphemes: string[],
): { at: number; removed: number; inserted: number } {
  let prefix = 0;
  const maxPrefix = Math.min(oldGraphemes.length, newGraphemes.length);
  while (prefix < maxPrefix && oldGraphemes[prefix] === newGraphemes[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < Math.min(oldGraphemes.length, newGraphemes.length) - prefix &&
    oldGraphemes[oldGraphemes.length - 1 - suffix] === newGraphemes[newGraphemes.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    at: prefix,
    removed: oldGraphemes.length - prefix - suffix,
    inserted: newGraphemes.length - prefix - suffix,
  };
}
