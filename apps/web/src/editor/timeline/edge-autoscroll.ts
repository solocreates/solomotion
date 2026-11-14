/**
 * Edge auto-scroll — the headless brain behind "drag a clip toward the top/bottom
 * of the timeline and it scrolls to reveal the tracks (or the new-track slot)
 * beyond the fold".
 *
 * Split in two, on purpose:
 *  - `edgeScrollVelocity` is a PURE function: pointer + viewport metrics in, a
 *    signed px/frame delta out. No DOM, no time, no state — trivially testable
 *    and reusable by any scrollable surface (stage, filer, a future panel).
 *  - `createEdgeAutoScroll` is the thin rAF driver that reads a live element each
 *    frame, applies the velocity, and pings `onScroll` so the caller's drag can
 *    re-resolve against the freshly revealed rows.
 *
 * The anti-jank contract lives entirely in the pure function: velocity is
 * CLAMPED to the exact remaining scroll room, so the surface glides to the
 * boundary and stops dead — it never overshoots, bounces, or fights whatever
 * arms the new-lane placeholder at that same boundary. Hand a maxed-out
 * viewport and you get exactly 0 back, every frame, with zero hysteresis.
 */

export interface EdgeScrollInput {
  /** Pointer position in client (viewport) coordinates. */
  pointerY: number;
  /** Top of the ACTIVE scroll region in client px (below a ruler/header inset). */
  top: number;
  /** Bottom of the scroll region in client px. */
  bottom: number;
  /** The element's current `scrollTop`. */
  scrollTop: number;
  /** `scrollHeight - clientHeight`, floored at 0 — the furthest we can scroll. */
  maxScrollTop: number;
  /** Thickness of the hot band at each edge, in px. Pointer past the edge = full speed. */
  zonePx: number;
  /** Peak scroll speed in px per frame, reached at (and past) the outer edge. */
  maxSpeedPxPerFrame: number;
}

/**
 * The signed scroll delta for this frame: negative = scroll up, positive = down,
 * 0 = idle or already pinned at that boundary. Ramps quadratically from 0 at the
 * inner edge of the hot band to `maxSpeedPxPerFrame` at the outer edge, then
 * clamps to whatever room actually remains so the last frame lands flush.
 */
export function edgeScrollVelocity(input: EdgeScrollInput): number {
  const { pointerY, top, bottom, scrollTop, maxScrollTop, zonePx, maxSpeedPxPerFrame } = input;
  if (zonePx <= 0 || maxScrollTop <= 0) return 0;

  // Ease-in (depth²) so a clip that just grazes the edge creeps, while parking it
  // hard against the rail races — precise near tracks, fast when you mean it.
  const ramp = (depth: number) => Math.min(1, Math.max(0, depth)) ** 2 * maxSpeedPxPerFrame;

  if (pointerY < top + zonePx) {
    if (scrollTop <= 0) return 0; // already at the very top — nothing to reveal
    const v = -ramp((top + zonePx - pointerY) / zonePx);
    return Math.max(v, -scrollTop); // never scroll past 0
  }
  if (pointerY > bottom - zonePx) {
    if (scrollTop >= maxScrollTop) return 0; // pinned at the bottom (incl. any armed ghost lane)
    const v = ramp((pointerY - (bottom - zonePx)) / zonePx);
    return Math.min(v, maxScrollTop - scrollTop); // never scroll past the end
  }
  return 0;
}

export interface EdgeAutoScrollOptions {
  /** Resolved fresh each frame, so an unmount/remount mid-drag can't hold a stale node. */
  getViewport: () => HTMLElement | null;
  /** Inset from the element's top where vertical scrolling should begin (e.g. a sticky ruler). */
  contentTopInset?: number;
  /** Inset from the element's left where horizontal scrolling should begin. */
  contentLeftInset?: number;
  /** Enable the vertical axis (default true). */
  vertical?: boolean;
  /** Enable the horizontal axis (default true). */
  horizontal?: boolean;
  zonePx?: number;
  maxSpeedPxPerFrame?: number;
  /** Fired after any frame that actually moved the scroll, so the drag can re-resolve. */
  onScroll?: () => void;
}

export interface EdgeAutoScroll {
  /** Feed the latest pointer position; starts the rAF loop on first call. */
  update(pointerX: number, pointerY: number): void;
  /** Halt and release the rAF loop. Idempotent. */
  stop(): void;
}

/**
 * Drive `edgeScrollVelocity` off requestAnimationFrame against a live element,
 * on both axes at once — push a clip toward any edge (top/bottom to reveal
 * tracks, left/right to reveal time) and the surface follows. An axis with no
 * overflow yields 0 and costs nothing, so a corner drag scrolls diagonally for
 * free.
 *
 * The loop stays armed between the first `update` and `stop` even while the
 * pointer is held perfectly still — that's the whole point: parked in the hot
 * band, the surface keeps scrolling until the boundary, then idles at 0 (cheap)
 * ready to resume the instant more content appears (e.g. a ghost lane arming).
 */
export function createEdgeAutoScroll(opts: EdgeAutoScrollOptions): EdgeAutoScroll {
  const zonePx = opts.zonePx ?? 56;
  const maxSpeed = opts.maxSpeedPxPerFrame ?? 16;
  const topInset = opts.contentTopInset ?? 0;
  const leftInset = opts.contentLeftInset ?? 0;
  const doY = opts.vertical ?? true;
  const doX = opts.horizontal ?? true;
  let pointerX = 0;
  let pointerY = 0;
  let raf = 0;

  const tick = () => {
    raf = 0;
    const el = opts.getViewport();
    if (!el) return; // unmounted mid-drag — let stop()/the next update reattach
    const rect = el.getBoundingClientRect();
    let moved = false;
    if (doY) {
      const dy = edgeScrollVelocity({
        pointerY,
        top: rect.top + topInset,
        bottom: rect.bottom,
        scrollTop: el.scrollTop,
        maxScrollTop: Math.max(0, el.scrollHeight - el.clientHeight),
        zonePx,
        maxSpeedPxPerFrame: maxSpeed,
      });
      if (dy !== 0) {
        el.scrollTop += dy;
        moved = true;
      }
    }
    if (doX) {
      // Same 1-D brain, mapped onto the X axis: pointerX↦pointerY, left↦top…
      const dx = edgeScrollVelocity({
        pointerY: pointerX,
        top: rect.left + leftInset,
        bottom: rect.right,
        scrollTop: el.scrollLeft,
        maxScrollTop: Math.max(0, el.scrollWidth - el.clientWidth),
        zonePx,
        maxSpeedPxPerFrame: maxSpeed,
      });
      if (dx !== 0) {
        el.scrollLeft += dx;
        moved = true;
      }
    }
    if (moved) opts.onScroll?.();
    raf = requestAnimationFrame(tick);
  };

  return {
    update(x: number, y: number) {
      pointerX = x;
      pointerY = y;
      if (!raf) raf = requestAnimationFrame(tick);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}


/**
 * The scroller under a point — so edge auto-scroll works on ANY drop target
 * without being wired per surface.
 *
 * "Drag to the edge and it scrolls" was implemented once, for clip drags, with
 * the timeline's viewport passed in by hand. Every other drop target (the
 * lanes from a library drag, the layers list, the flipbook sheet, the filer)
 * had none, because each would have had to pass its own element. Asking the
 * DOM instead means the behaviour arrives everywhere at once and follows the
 * pointer between panels mid-drag.
 *
 * Deliberately the same derivation the gesture scope uses — overflow set AND
 * content to scroll — so "what counts as a scroller" has one answer.
 */
export function scrollerAt(x: number, y: number): HTMLElement | null {
  let el = document.elementFromPoint(x, y) as HTMLElement | null;
  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    const canX = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
    const canY = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (canX || canY) return el;
    el = el.parentElement;
  }
  return null;
}
