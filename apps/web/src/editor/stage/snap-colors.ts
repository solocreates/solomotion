import type { SnapLineKind } from "@solomotion/core";

/**
 * The one place a flashed smart-guide's color is decided — shared by the stage
 * layer drag ([Stage.tsx]) and the vector overlay ([VectorOverlay.tsx]) so every
 * surface speaks the same visual language:
 *   center  magenta   · a center/midline alignment
 *   guide   teal      · a ruler guide the user pulled out
 *   node    violet    · an individual vector anchor (node-to-node snapping)
 *   edge/page  red    · a layer edge or the page frame
 */
export function snapLineColor(kind: SnapLineKind): string {
  switch (kind) {
    case "center":
      return "#FF5CA8";
    case "guide":
      return "#22C7B6";
    case "node":
      return "#9B8CFF";
    default:
      return "#F5406B";
  }
}
