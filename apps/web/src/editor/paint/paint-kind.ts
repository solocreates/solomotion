import { isGradientPaint, type Paint } from "@solomotion/core";

/**
 * Which shelf of the library a paint belongs on — the same three groupings the
 * editor's tabs use, so a style can never appear under a tab that could not
 * open it.
 *
 * Its own module because both the library and the recents list need it, and the
 * two importing it from each other is how a cycle starts.
 */
export type ShelfKind = "solid" | "gradient" | "pattern";

export function shelfKindOf(paint: Paint): ShelfKind | null {
  if (paint.type === "solid") return "solid";
  if (paint.type === "pattern") return "pattern";
  if (isGradientPaint(paint)) return "gradient";
  return null;
}

export const SHELF_LABEL: Record<ShelfKind, string> = {
  solid: "colour",
  gradient: "gradient",
  pattern: "pattern",
};
