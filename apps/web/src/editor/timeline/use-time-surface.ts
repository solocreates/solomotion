"use client";

import * as React from "react";
import { useZoomGesture } from "../state/use-zoom-gesture";
import { useMultiTouch, DRAG_SURFACE, SCROLL_SURFACE } from "../input/use-multi-touch";

/**
 * EVERY GESTURE A TIME SURFACE HAS, wired once.
 *
 * The timeline lanes and the flipbook sheet are the same kind of object: a
 * scroller with time across the X axis and rows down the Y, zoomable on both.
 * They had each grown their own copy of the plumbing, and the copies disagreed
 * — the timeline zoomed through the shared cursor-anchored controller while the
 * sheet multiplied `pxPerSec` by its own private 1.12, so the two axes the
 * sheet's own doc comment calls "the SAME zoom axes as the timeline" stepped at
 * different rates depending on which panel your pointer was over. And only one
 * of them had ever heard of a second finger, so the sheet had no pinch, no
 * two-finger pan, and no `touch-action` — which meant every cell drag inside it
 * was taken by the browser as a scroll.
 *
 * What is genuinely different between the two is one thing: what a zoom factor
 * DOES. The timeline clamps to the comp's duration through `timelineView`; the
 * sheet writes the session axes directly. So that is the parameter, and
 * everything around it lives here:
 *
 *   ⌘/⌃ + wheel, or a trackpad pinch  → zoom time
 *   ⌥ + wheel                         → zoom rows
 *   two fingers                       → pinch zooms time, drag pans the scroller
 *   plain wheel                       → untouched, so native scrolling stays
 *
 * Spread the returned `className` on the SCROLL VIEWPORT.
 *
 * By default it carries `touch-action: pan-x pan-y`, so **one finger scrolls
 * the surface natively** — the primary navigation of a timeline or a sheet,
 * with the browser's own momentum and rubber-banding and no JS at all. The
 * things you can actually GRAB inside it (clips, cells, trim edges, keyframes,
 * the ruler) each wear `DRAG_SURFACE`, and because `touch-action` resolves to
 * the nearest declaration the browser arbitrates by hit-target before any
 * handler runs: empty lane scrolls, clip drags. No recognizer, no threshold,
 * no guessing at intent.
 *
 * `surface: "canvas"` opts out for a viewport that is NOT a native scroller —
 * the curve editor is positioned by transform from the timeline's single
 * scroll value, so there is no scrollbar for the browser to move and the pan
 * has to be ours.
 */
export interface TimeSurfaceOptions {
  /**
   * Zoom the TIME axis. `centerX` is local to the surface, so the caller can
   * anchor the zoom under the pointer rather than at the scroll origin.
   */
  onZoomTime: (factor: number, centerX: number) => void;
  /** Zoom the ROW axis. Omit on surfaces with no second axis. */
  onZoomRows?: (factor: number) => void;
  /**
   * What two-finger centroid travel does. Only consulted for `surface:
   * "canvas"` — a native scroller is panned by the browser, and applying
   * `scrollLeft` on top of that would move it twice as far as the fingers.
   */
  onPan?: (dx: number, dy: number) => void;
  /**
   * "scroller" (default) — a real scroll container. One finger scrolls it
   * natively; we add pinch only.
   * "canvas" — positioned by transform, nothing for the browser to scroll, so
   * we own every gesture and `onPan` is required.
   */
  surface?: "scroller" | "canvas";
}

export function useTimeSurface(
  ref: React.RefObject<HTMLElement | null>,
  opts: TimeSurfaceOptions,
): { className: string } {
  // Latest-closure ref: callers pass fresh arrow functions every render (they
  // close over span, zoom and the store), and re-subscribing the listeners on
  // every keystroke of a rename would be a lot of churn for no gain.
  const latest = React.useRef(opts);
  latest.current = opts;

  useZoomGesture(ref, {
    onZoom: (factor, center) => latest.current.onZoomTime(factor, center.x),
    // Passed conditionally on purpose: `useZoomGesture` falls ⌥+wheel through
    // to native scrolling when there is no cross-axis handler, which is the
    // right behaviour for a surface with only one axis.
    ...(opts.onZoomRows ? { onZoomY: (factor: number) => latest.current.onZoomRows?.(factor) } : {}),
  });

  useMultiTouch(ref, {
    onGesture: ({ scale, dx, dy, x }) => {
      // Pan only where the browser is not already doing it. On a native
      // scroller `touch-action: pan-x pan-y` means the fingers have ALREADY
      // moved the viewport by the time this runs; adding our own delta would
      // double every two-finger drag.
      if (opts.surface === "canvas") latest.current.onPan?.(dx, dy);
      if (scale !== 1) latest.current.onZoomTime(scale, x);
    },
  });

  return { className: opts.surface === "canvas" ? DRAG_SURFACE : SCROLL_SURFACE };
}
