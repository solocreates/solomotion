/**
 * THE FRAME'S NAME LABEL — the title the canvas draws above each artboard, and
 * the one place its type and placement live.
 *
 * Two surfaces draw it: the chrome canvas (at rest) and the inline rename field
 * (while you type). They must be the same text in the same spot, or double-
 * clicking the name visibly swaps it for a different one. They were not: the
 * canvas was handed `var(--font-space-grotesk)`, which a canvas cannot resolve,
 * so it silently fell back to its 10px default while the field rendered real
 * Space Grotesk at 11px, a few pixels off, over the top of the still-drawn label.
 */

import type { Frame } from "@solomotion/core";

/** Label type size, px (screen space — the label does not zoom). */
export const FRAME_LABEL_SIZE = 11;
/** The label's baseline sits this far above the artboard's top edge, px. */
export const FRAME_LABEL_LIFT = 8;
/** Gap between the name and the W × H readout after it, px. */
export const FRAME_LABEL_DIMS_GAP = 10;

let resolvedFamily: string | null = null;

/**
 * The label's CSS `font` shorthand with the family RESOLVED — valid for a canvas
 * context and an element alike. `next/font` hands the family out as a custom
 * property on <body>; a canvas cannot read one, so it is read here, once.
 */
export function frameLabelFont(): string {
  if (resolvedFamily === null && typeof document !== "undefined" && document.body) {
    resolvedFamily = getComputedStyle(document.body).getPropertyValue("--font-space-grotesk").trim();
  }
  const family = resolvedFamily ? `${resolvedFamily}, sans-serif` : "sans-serif";
  return `500 ${FRAME_LABEL_SIZE}px ${family}`;
}

/** Where the label's text starts: its left edge and baseline, in stage px. */
export function frameLabelAnchor(
  frame: Pick<Frame, "x" | "y">,
  view: { tx: number; ty: number; scale: number },
): { x: number; baseline: number } {
  return {
    x: view.tx + frame.x * view.scale,
    baseline: view.ty + frame.y * view.scale - FRAME_LABEL_LIFT,
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;

/** Width and font-box metrics of `text` in the label face. */
export function measureFrameLabel(text: string): { width: number; ascent: number; descent: number } {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return { width: text.length * 6, ascent: 9, descent: 3 };
  measureCtx.font = frameLabelFont();
  const m = measureCtx.measureText(text || " ");
  return {
    width: m.width,
    ascent: m.fontBoundingBoxAscent || FRAME_LABEL_SIZE * 0.8,
    descent: m.fontBoundingBoxDescent || FRAME_LABEL_SIZE * 0.25,
  };
}

/**
 * A frame's name as it fits in `room` screen px — whole, or cut with an
 * ellipsis; "" when not even one letter and the ellipsis fit.
 */
export function fitFrameLabel(ctx: CanvasRenderingContext2D, name: string, room: number): string {
  if (ctx.measureText(name).width <= room) return name;
  const ell = "…";
  if (ctx.measureText(name[0] + ell).width > room) return "";
  let lo = 1, hi = name.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(name.slice(0, mid).trimEnd() + ell).width <= room) lo = mid;
    else hi = mid - 1;
  }
  return name.slice(0, lo).trimEnd() + ell;
}
