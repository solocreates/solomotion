"use client";

import * as React from "react";
import { pointInPolygon } from "@solomotion/core";
import { useLasso, lassoArmed } from "../input/lasso";
import { pointerMay } from "../input/pointer-authority";

/**
 * SWEEP SELECTION over any container — one gesture, two shapes.
 *
 * Drag empty space and every descendant tagged with `dataAttr` that falls under
 * the sweep is hit-tested and reported. Shared by the filer grid, the flipbook
 * sheet, the layers list, the variables table and the timeline.
 *
 * The two shapes:
 *
 *   RECT   the classic rubber band. Mouse only — see the pointer rules below.
 *   LASSO  a free-form polygon, armed app-wide (`input/lasso.ts`). Works with
 *          ANY pointer, because being usable with a finger is the entire point
 *          of it, and it MERGES into the existing selection by default.
 *
 * Only the shape and the hit test differ. The attribute scan, the additive
 * merge, the overlay, the drag threshold and the pointer lifecycle are the same
 * for both and exist once — a second hook for "the round one" would be the same
 * near-miss the three hand-rolled marquees already were.
 *
 * ── Pointer rules, and why they changed ──────────────────────────────────────
 *
 * Neither touch NOR pen sweeps a rectangle. Scrolling is how you move through a
 * timeline or a sheet and it happens constantly; a rect sweep is occasional and
 * has other routes. Pen was briefly allowed to sweep on the grounds that it is
 * a precise instrument — but on a tablet the pen is ALSO how you move the
 * panel, so drawing a selection box was exactly what you got when you tried to
 * scroll, with the content sliding underneath it. A tool you cannot avoid
 * triggering is worse than one you have to arm.
 *
 * So the lasso is the touch and pen answer, and it is armed rather than
 * implicit. While it is armed, one pointer of any kind draws.
 *
 * Tagging: `data-no-marquee` never starts a drag. `data-marquee-click-through`
 * still arms a drag (so sweeping FROM it works) but skips `onClear` on a plain
 * click, because the element handles its own click.
 */

const MARQUEE_THRESHOLD = 4;
/** Below this the polygon is a tap, not a shape. */
const LASSO_THRESHOLD = 8;

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Pt {
  x: number;
  y: number;
}

function intersects(a: DOMRect, r: DOMRect): boolean {
  return !(a.right < r.left || a.left > r.right || a.bottom < r.top || a.top > r.bottom);
}

/**
 * An element is caught if its CENTRE or any CORNER is inside the shape.
 *
 * Centre alone misses a long timeline clip you deliberately looped one end of;
 * corners alone catch a huge clip whose corner you merely brushed. Together
 * they behave the way a lasso looks like it should: enclose any recognisable
 * part of a thing and you get the thing.
 */
function caughtByPolygon(r: DOMRect, poly: Pt[]): boolean {
  const pts: Pt[] = [
    { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    { x: r.left, y: r.top },
    { x: r.right, y: r.top },
    { x: r.left, y: r.bottom },
    { x: r.right, y: r.bottom },
  ];
  return pts.some((p) => pointInPolygon(p, poly));
}

/**
 * What kind of surface the sweep would start on. The distinction is real and
 * it is the reason this predicate takes a parameter instead of splitting in
 * two: on a SCROLLER a drag from empty space is already spoken for — it is how
 * you move through a timeline or a list, and it happens constantly. On a
 * CANVAS there is no scroll to collide with, so the same drag is free.
 */
export type SweepSurface = "scroller" | "canvas";

/**
 * MAY THIS POINTER START A RECTANGLE SWEEP?
 *
 * The one predicate behind the answer, because the rule was being re-typed at
 * every marquee in the app — the lanes, the curve editor, the dope sheet, the
 * flipbook, this hook — as a hand-written `pointerType !== "mouse"` plus a
 * `lasso.armed` check, five times, each free to disagree with the others about
 * what a pen or an armed lasso means.
 *
 * Three rules, one place:
 *   • while the lasso is armed it owns the pointer outright, so the two shapes
 *     can never race one pointer-down;
 *   • on a SCROLLER, a rect sweep is a mouse gesture. A finger and a pen are
 *     both how you scroll the panel, and a tool you cannot avoid triggering is
 *     worse than one you have to arm;
 *   • on a CANVAS, ask pointer authority. A stylus sweeps — it is the precise
 *     instrument and the whole point of it — and a finger sweeps only where a
 *     stylus is not the one doing the authoring.
 *
 * The canvas case was the missing one, and it cost twice: a Pencil could not
 * rubber-band on the stage at all through the shared hook, while the stage's
 * own hand-rolled marquee asked nobody and let every finger draw one.
 *
 * Every hand-rolled marquee that cannot use `useSweepSelect` (because its hit
 * test is model-based — time × track, world space, value axes) still calls
 * THIS, so the entry rule stays shared even where the implementation cannot be.
 */
export function rectSweepAllowed(
  e: { pointerType?: string },
  surface: SweepSurface = "scroller",
): boolean {
  if (lassoArmed()) return false;
  const type = e.pointerType ?? "mouse";
  if (type === "mouse") return true;
  if (surface === "scroller") return false;
  return type === "pen" || pointerMay(e, "sweep");
}

export interface SweepSelectHandlers {
  /** Fired once at pointer-down (before any drag threshold), so the caller can
   *  snapshot its "base" selection for an additive sweep. The lasso passes
   *  `true` always — merging is what it is for. */
  onDragStart: (additive: boolean) => void;
  /** Fired on every move past the threshold with the ids under the shape right
   *  now (not yet unioned with any base). */
  onSweep: (ids: string[]) => void;
  /** Fired on pointer-up when the gesture was a plain click (no drag) and
   *  non-additive — the "click empty space to deselect" case. */
  onClear: () => void;
}

export function useSweepSelect(
  containerRef: React.RefObject<HTMLElement | null>,
  dataAttr: string,
  handlers: SweepSelectHandlers,
) {
  const [rect, setRect] = React.useState<Rect | null>(null);
  const [path, setPath] = React.useState<Pt[] | null>(null);
  // Subscribed (not just read through `lassoArmed()`) so arming re-renders the
  // surface — it needs `touch-action: none` while the lasso is live, or the
  // browser scrolls the panel out from under the shape being drawn.
  const armed = useLasso((s) => s.armed);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const lasso = lassoArmed();
    if (!lasso && !rectSweepAllowed(e)) return;

    const container = containerRef.current;
    if (!container) return;
    const target = e.target as HTMLElement;
    // The lasso draws OVER items — enclosing a clip is the whole gesture, so it
    // must not be blocked by starting on one. The rect sweep still only begins
    // from empty space, where tagged items own their own drags.
    if (!lasso && target.closest(`[${dataAttr}]`)) return;
    if (target.closest("[data-no-marquee]")) return;
    const clickThrough = target.closest("[data-marquee-click-through]") != null;

    const additive = lasso || e.shiftKey;
    handlers.onDragStart(additive);
    const startX = e.clientX;
    const startY = e.clientY;
    const pts: Pt[] = [{ x: startX, y: startY }];
    let dragging = false;

    const scan = (test: (r: DOMRect) => boolean) => {
      const hits: string[] = [];
      for (const el of container.querySelectorAll<HTMLElement>(`[${dataAttr}]`)) {
        if (test(el.getBoundingClientRect())) {
          const id = el.getAttribute(dataAttr);
          if (id) hits.push(id);
        }
      }
      handlers.onSweep(hits);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const box = container.getBoundingClientRect();

      if (lasso) {
        const last = pts[pts.length - 1]!;
        // Thin the path: raw pointer streams are 200–360Hz on a tablet, and a
        // polygon with three thousand vertices makes every hit test quadratic
        // in nothing useful. 2px keeps the drawn curve smooth.
        if (Math.hypot(ev.clientX - last.x, ev.clientY - last.y) >= 2) {
          pts.push({ x: ev.clientX, y: ev.clientY });
        }
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < LASSO_THRESHOLD) return;
        dragging = true;
        setPath(pts.map((p) => ({ x: p.x - box.left, y: p.y - box.top })));
        scan((r) => caughtByPolygon(r, pts));
        return;
      }

      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < MARQUEE_THRESHOLD) return;
      dragging = true;
      const left = Math.min(startX, ev.clientX);
      const top = Math.min(startY, ev.clientY);
      const width = Math.abs(ev.clientX - startX);
      const height = Math.abs(ev.clientY - startY);
      setRect({
        left: left - box.left + container.scrollLeft,
        top: top - box.top + container.scrollTop,
        width,
        height,
      });
      const sweep = new DOMRect(left, top, width, height);
      scan((r) => intersects(r, sweep));
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      // Touch cancels constantly and fires this INSTEAD of pointerup; without
      // it the move listener outlives the gesture and every later pointer move
      // in the app re-runs the sweep. Same leak as the scrub had.
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      setRect(null);
      setPath(null);
      if (!dragging && !additive && !clickThrough) handlers.onClear();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };

  const marqueeNode = (
    <>
      {rect && (
        <div
          className="pointer-events-none absolute z-10 rounded-sm border border-primary/70 bg-primary/10"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      )}
      {path && path.length > 1 && (
        // Drawn in the container's own coordinate space, NOT scroll-offset like
        // the rect above: the lasso is a screen-space gesture (the shape follows
        // your hand, not the content), so it is positioned from the container's
        // client box and needs no scroll correction.
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 z-20 h-full w-full overflow-visible"
        >
          <defs>
            <filter id="lasso-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          {/* The shape closes itself visually — the hit test already treats the
              polygon as closed, so showing it open would misreport what is
              caught. Two strokes: a soft wide glow under a crisp line. */}
          <polygon
            points={path.map((p) => `${p.x},${p.y}`).join(" ")}
            fill="var(--primary)"
            fillOpacity={0.1}
            stroke="var(--primary)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            filter="url(#lasso-glow)"
            opacity={0.95}
          />
        </svg>
      )}
    </>
  );

  return {
    onPointerDown,
    marqueeNode,
    /**
     * Spread on the scroll viewport. While the lasso is armed the surface must
     * stop scrolling or the content slides out from under the shape you are
     * drawing — and it has to go back to scrolling the moment it disarms, which
     * is why this is derived state rather than a class someone remembers to
     * toggle.
     */
    surfaceClassName: armed ? "touch-none" : undefined,
    armed,
  };
}
