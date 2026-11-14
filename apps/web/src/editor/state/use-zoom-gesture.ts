"use client";

import * as React from "react";
import { gestureMods } from "../input/modifiers";

/**
 * What a MIDDLE-BUTTON drag means, decided once for every camera in the app.
 *
 * A bare middle drag hand-pans — the one gesture every 3D and paint tool
 * agrees on. With ⌘/Ctrl held it becomes a scrubby zoom about the press point
 * (Blender's Ctrl+MMB): drag up or right to zoom in, down or left to zoom out.
 * The camera never has to leave your hand to change scale, which is what the
 * wheel costs you on a mouse whose wheel is also the button.
 *
 * `meta` rather than `alt`, deliberately: ⌥-drag already means "duplicate" on
 * this stage, and the modifier puck can latch ⌘ for a stylus with a barrel
 * button that reports as middle.
 */
export function middleDragIntent(e: {
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}): "pan" | "zoom" {
  return gestureMods(e).meta ? "zoom" : "pan";
}

/** Screen px of drag → zoom factor. ~140px doubles; `dx - dy` so right and up both zoom in. */
export function dragZoomFactor(dx: number, dy: number): number {
  return Math.exp((dx - dy) * 0.005);
}

/**
 * The ONE zoom-gesture detector — trackpad pinch (browsers report it as
 * ctrlKey+wheel) and ⌘/Ctrl + two-finger scroll for the PRIMARY axis, ⌥/Alt +
 * two-finger scroll for the CROSS axis (e.g. track height instead of time),
 * identical on every surface: the canvas, the timeline lanes, the graph
 * panel… Attach it to a scroller or viewport and translate `factor` into
 * that surface's own zoom model(s).
 *
 *   factor > 1  = zoom in   ·   factor < 1 = zoom out
 *   center      = pointer position, local to the element (anchor the zoom!)
 *
 * Plain (unmodified) wheel is untouched unless `onPan` is given — scrollable
 * surfaces keep native scrolling; free surfaces (the canvas) pan. `onZoomY`
 * is optional — surfaces with no cross-axis zoom just don't pass it, and ⌥ +
 * wheel falls through to `onPan`/native scroll as before.
 *
 * Attached with a non-passive listener every render (latest-closure safe,
 * survives the element mounting late), so callers just pass fresh callbacks.
 */
export function useZoomGesture(
  ref: React.RefObject<HTMLElement | null>,
  handlers: {
    onZoom: (factor: number, center: { x: number; y: number }, e: WheelEvent) => void;
    onZoomY?: (factor: number, center: { x: number; y: number }, e: WheelEvent) => void;
    onPan?: (dx: number, dy: number, e: WheelEvent) => void;
  },
): void {
  const latest = React.useRef(handlers);
  latest.current = handlers;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // A scrollable child that floats over the surface (the stage's tool
      // capsule, tool-options bar, layers panel…) keeps its OWN wheel: without
      // this the surface's pan/zoom preventDefault swallowed the scroll, so the
      // stage moved instead of the inner box. Any element opts in with
      // `data-wheel-scroll`.
      const target = e.target as Element | null;
      if (target?.closest?.("[data-wheel-scroll]")) return;
      const rect = el.getBoundingClientRect();
      const center = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        // Pinch / ⌘-scroll — must preventDefault or the browser page-zooms.
        e.preventDefault();
        latest.current.onZoom(Math.exp(-e.deltaY * 0.01), center, e);
      } else if (e.altKey && latest.current.onZoomY) {
        // ⌥-scroll — must preventDefault: some browsers (Firefox/Windows)
        // treat plain Alt+wheel as back/forward navigation.
        e.preventDefault();
        latest.current.onZoomY(Math.exp(-e.deltaY * 0.01), center, e);
      } else if (latest.current.onPan) {
        e.preventDefault();
        latest.current.onPan(-e.deltaX, -e.deltaY, e);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
}
