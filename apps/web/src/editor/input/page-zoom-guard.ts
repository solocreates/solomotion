"use client";

/**
 * THE APP NEVER PAGE-ZOOMS — a zoom gesture zooms the surface under it.
 *
 * A browser zooms the whole page on a trackpad pinch (reported as ctrl+wheel
 * in Chrome and Firefox, as `gesture*` events in Safari) and on ⌘+ / ⌘− / ⌘0.
 * In a document that is a feature; in an editor it is a trap: the panels
 * grow, the inspector runs off the right edge, and nothing says why. Every
 * zoomable surface already handles the pinch itself (`useZoomGesture`, the 3D
 * viewport), so the page's own zoom is only ever the side effect of a surface
 * that did not cancel it — or of a pinch over a panel that has no zoom.
 *
 * So it is cancelled ONCE, for the whole app, in the capture phase: the event
 * still reaches the surface under the pointer (cancelling never stops
 * propagation), and the page itself never moves. The KEYS are no longer
 * handled here: `workspace/zoom-shortcuts.ts` routes ⌘= ⌘− ⌘0 ⇧0 to the view
 * you are in and falls back to the stage through `requestStageZoom`.
 *
 * One way out stays open: a page ALREADY pinch-zoomed (before this ran, or by
 * the OS) may still pinch back out — never a page you cannot un-zoom.
 */

/** in/out step · fit · actual (100%) — the D5 command set. */
export type StageZoomRequest = "in" | "out" | "fit" | "actual";

const bus = new EventTarget();

/** Ask whichever stage is showing (the flat Stage or a world's viewport) to zoom. */
export function requestStageZoom(kind: StageZoomRequest): void {
  bus.dispatchEvent(new CustomEvent<StageZoomRequest>("zoom", { detail: kind }));
}

/** A stage answers zoom keys here; returns the unsubscribe. */
export function onStageZoomRequest(fn: (kind: StageZoomRequest) => void): () => void {
  const on = (e: Event) => fn((e as CustomEvent<StageZoomRequest>).detail);
  bus.addEventListener("zoom", on);
  return () => bus.removeEventListener("zoom", on);
}

export function startPageZoomGuard(): () => void {
  const pinchedIn = () => (window.visualViewport?.scale ?? 1) > 1.001;
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    // Pinching OUT of a page that is already zoomed is the way back.
    if (pinchedIn() && e.deltaY > 0) return;
    e.preventDefault();
  };
  const onGesture = (e: Event) => {
    if (pinchedIn() && (e as Event & { scale?: number }).scale !== undefined && (e as Event & { scale: number }).scale < 1) return;
    e.preventDefault();
  };
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });
  for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(t, onGesture, { passive: false, capture: true });
  return () => {
    window.removeEventListener("wheel", onWheel, { capture: true });
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) document.removeEventListener(t, onGesture, { capture: true });
  };
}
