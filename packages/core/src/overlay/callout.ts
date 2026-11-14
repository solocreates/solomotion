/**
 * ANCHORED SURFACES — where a floating thing goes when it belongs to something
 * on the canvas.
 *
 * Docked chrome names a slot and `StageChrome` owns the rest (see that file:
 * flex, not a solver). This is the other half — a surface that belongs to ONE
 * LAYER and must sit beside it: a contextual action bar over the selection, the
 * way a rich-text editor puts bold/italic above the words you highlighted.
 *
 * It is pure screen arithmetic, so it is testable and shared. Every anchored
 * surface picks its side here rather than growing its own `top - height - 8`,
 * which is how the old chrome ended up with a 260-line runtime solver: a dozen
 * private placement rules that agreed only by luck.
 *
 * The rules, stated once:
 *
 *  1. Try the preferred sides in order and take the first that FITS — fits
 *     meaning the surface lands wholly inside the viewport once it has been
 *     clamped along the cross axis.
 *  2. If none fits, take the side with the most room. A surface pinned to a
 *     corner of a tiny viewport still has to appear somewhere, and "the
 *     roomiest side, clamped" is the least-wrong answer.
 *  3. Clamp the cross axis ALWAYS. A callout that runs off the edge is worse
 *     than one that is not perfectly centred on its layer.
 *
 * Screen pixels throughout, never world units — which is what makes an anchored
 * surface zoom-safe by construction: it tracks the layer's box as the camera
 * moves and never changes size.
 */

export type CalloutSide = "top" | "bottom" | "left" | "right";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CalloutPlacement {
  side: CalloutSide;
  /** Top-left of the surface, in the same screen space as the inputs. */
  x: number;
  y: number;
  /** Did the chosen side actually have room, or is this the least-wrong one? */
  fits: boolean;
}

export interface CalloutOptions {
  /** The layer's box on screen. */
  anchor: Rect;
  /** The surface's measured size. */
  size: { width: number; height: number };
  /** The stage's usable area (already inset by rulers and docked chrome). */
  viewport: Rect;
  /** Distance between the surface and the anchor box. */
  gap?: number;
  /** Minimum distance from the viewport edge. */
  margin?: number;
  /** Which sides to try, best first. */
  prefer?: readonly CalloutSide[];
}

/** Above, then below, then beside — the reading order people expect. */
const DEFAULT_PREFER: readonly CalloutSide[] = ["top", "bottom", "right", "left"];

export function placeCallout(opts: CalloutOptions): CalloutPlacement {
  const { anchor, size, viewport } = opts;
  const gap = opts.gap ?? 10;
  const margin = opts.margin ?? 8;
  const prefer = opts.prefer ?? DEFAULT_PREFER;

  const minX = viewport.x + margin;
  const maxX = viewport.x + viewport.width - margin - size.width;
  const minY = viewport.y + margin;
  const maxY = viewport.y + viewport.height - margin - size.height;

  let best: CalloutPlacement | null = null;
  let bestRoom = -Infinity;

  for (const side of prefer) {
    const raw = rawOrigin(side, anchor, size, gap);
    // Clamp the cross axis; the main axis is what decides whether it fits.
    const x = side === "top" || side === "bottom" ? clamp(raw.x, minX, maxX) : raw.x;
    const y = side === "left" || side === "right" ? clamp(raw.y, minY, maxY) : raw.y;
    const room = mainAxisRoom(side, anchor, viewport, margin) - gap;
    const fits =
      room >= mainExtent(side, size) &&
      // A viewport narrower than the surface can never fit it; say so rather
      // than reporting a fit the clamp only pretended to achieve.
      maxX >= minX &&
      maxY >= minY;
    if (fits) return { side, x, y, fits: true };
    if (room > bestRoom) {
      bestRoom = room;
      best = { side, x: clamp(x, minX, maxX), y: clamp(y, minY, maxY), fits: false };
    }
  }
  // `prefer` is never empty in practice; the fallback keeps the return total.
  return best ?? { side: "top", x: clamp(anchor.x, minX, maxX), y: clamp(anchor.y, minY, maxY), fits: false };
}

/** Where the surface would sit on this side with nothing in the way. */
function rawOrigin(side: CalloutSide, a: Rect, s: { width: number; height: number }, gap: number): { x: number; y: number } {
  const cx = a.x + a.width / 2 - s.width / 2;
  const cy = a.y + a.height / 2 - s.height / 2;
  switch (side) {
    case "top":
      return { x: cx, y: a.y - gap - s.height };
    case "bottom":
      return { x: cx, y: a.y + a.height + gap };
    case "left":
      return { x: a.x - gap - s.width, y: cy };
    case "right":
      return { x: a.x + a.width + gap, y: cy };
  }
}

/** How much space this side has, from the anchor's edge to the viewport's. */
function mainAxisRoom(side: CalloutSide, a: Rect, v: Rect, margin: number): number {
  switch (side) {
    case "top":
      return a.y - (v.y + margin);
    case "bottom":
      return v.y + v.height - margin - (a.y + a.height);
    case "left":
      return a.x - (v.x + margin);
    case "right":
      return v.x + v.width - margin - (a.x + a.width);
  }
}

function mainExtent(side: CalloutSide, s: { width: number; height: number }): number {
  return side === "top" || side === "bottom" ? s.height : s.width;
}

function clamp(v: number, lo: number, hi: number): number {
  // A viewport too small for the surface inverts the bounds; prefer the low
  // edge, which keeps the surface's start visible rather than its end.
  return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}
