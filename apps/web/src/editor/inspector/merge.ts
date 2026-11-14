import type { Clip, PartialTextStyle, TextClip } from "@solomotion/core";
import { MIXED, type FieldValue } from "./shared-inspector";

/**
 * Value merging for multi-select — the read half of Figma-style multi-edit
 * (the write half is the SelectionScope fan-out). Every component asks: "do the
 * selected clips agree on this value?" One answer type, one rule, everywhere.
 */

/**
 * A field's reading across the selection: the PRIMARY's value, and whether the
 * rest disagree.
 *
 * The value is always a real value, never a sentinel — a section computes with
 * it (a percentage, a ratio, a label) exactly as it does for one layer, and
 * only the control looks at `mixed` to say "Mixed" instead of the number. That
 * is what lets one component serve one clip and fifty without a branch.
 */
export interface Field<T> {
  value: T;
  mixed: boolean;
}

/** Read `read` off every peer (primary first). See `Field`. */
export function mergeReads<C, T>(peers: readonly C[], read: (c: C) => T, same: (a: T, b: T) => boolean = Object.is): Field<T> {
  const value = read(peers[0]!);
  for (let i = 1; i < peers.length; i++) if (!same(value, read(peers[i]!))) return { value, mixed: true };
  return { value, mixed: false };
}

/** Merge one derived value across clips: the shared value, or MIXED. */
export function mergeField<T>(clips: readonly Clip[], read: (clip: Clip) => T): T | typeof MIXED {
  if (clips.length === 0) return undefined as T;
  const f = mergeReads(clips, read);
  return f.mixed ? MIXED : f.value;
}

/** True when every clip agrees; used to gate a plain value vs a MIXED sentinel. */
export function isMixed<T>(value: T | typeof MIXED): value is typeof MIXED {
  return value === MIXED;
}

/** The scalar text-style keys the typography panel edits (kept in sync with StyleFields). */
export const MERGED_STYLE_KEYS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fauxBold",
  "italic",
  "letterSpacing",
  "lineHeight",
  "color",
  "opacity",
  "align",
  "decoration",
  "textCase",
  "direction",
] as const satisfies readonly (keyof PartialTextStyle)[];

/**
 * A merged `PartialTextStyle` across the selection: keys every clip agrees on
 * carry the shared value; keys they differ on are OMITTED. StyleFields already
 * renders an omitted (undefined) key as "Mixed" — so passing this straight into
 * the SAME StyleFields the single-clip inspector uses gives Figma multi-edit for
 * free, no forked component.
 */
export function mergeTextStyle(clips: readonly (TextClip)[]): PartialTextStyle {
  const out: PartialTextStyle = {};
  for (const key of MERGED_STYLE_KEYS) {
    const merged = mergeField(clips, (c) => (c as TextClip).style[key]);
    if (!isMixed(merged) && merged !== undefined) {
      (out as Record<string, unknown>)[key] = merged;
    }
  }
  return out;
}

export { MIXED };
export type { FieldValue };

/**
 * A `<Select>`'s value for a merged field: the option, or "" while the
 * selection disagrees — Radix shows the trigger's placeholder for "", so a
 * `<SelectValue placeholder="Mixed" />` is the whole Mixed state.
 */
export function selectValue<T extends string | null>(f: Field<T>): string {
  return f.mixed || f.value === null ? "" : f.value;
}

/** An `IconTrack`'s value for a merged field: the id, or no segment lit while mixed. */
export function trackValue<T extends string>(f: Field<T>): T | readonly T[] {
  return f.mixed ? [] : f.value;
}
