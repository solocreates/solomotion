import type { Easing } from "@solomotion/core";

/**
 * THE KEYFRAME GLYPH — what a key looks like, from what it does. One answer
 * for every surface that draws keys on a time axis (clip lanes, the dope
 * sheet), so a hold reads as a hold everywhere.
 *
 * After Effects' grammar, which motion people already read:
 *  · `linear` — a diamond: the value leaves at a constant rate;
 *  · `curve`  — a rounded diamond: it eases out (a preset or a bezier);
 *  · `hold`   — a square: it does not move until the next key.
 *
 * A key's easing is the segment LEAVING it, so the glyph says what happens
 * after the key. A stack of keys at one time (several properties) is a hold
 * only if every key holds, linear only if every key is linear; anything mixed
 * reads as a curve, because something there eases.
 */
export type KeyGlyph = "linear" | "curve" | "hold";

export function keyGlyph(easings: readonly Easing[]): KeyGlyph {
  if (easings.length === 0) return "linear";
  if (easings.every((e) => e.kind === "hold")) return "hold";
  if (easings.every((e) => e.kind === "linear")) return "linear";
  return "curve";
}

/**
 * The glyph's SHAPE as classes: rotation and corner. The corner follows the
 * theme's (`--r-xs`), capped to a fifth of the side like the scene's grips,
 * so a soft theme gets soft keys without a 9px key turning into a dot.
 */
export const KEY_GLYPH_SHAPE: Record<KeyGlyph, string> = {
  linear: "rotate-45 rounded-[min(var(--r-xs),2px)]",
  curve: "rotate-45 rounded-[38%]",
  hold: "rounded-[min(var(--r-xs),2px)]",
};

/** Does the segment leaving these keys MOVE? (A hold segment draws no bar.) */
export function segmentMoves(easings: readonly Easing[]): boolean {
  return easings.some((e) => e.kind !== "hold");
}
