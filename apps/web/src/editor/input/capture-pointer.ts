"use client";

/**
 * `setPointerCapture`, which THROWS, wrapped once.
 *
 * The DOM call raises `NotFoundError` whenever the pointer is no longer active
 * by the time the handler runs — a very fast tap, a pointer the browser retired
 * mid-dispatch, a press replayed a beat later (which `useTouchIntent` does by
 * design). It is not an exceptional condition; it is a normal thing that happens
 * on touch and pen hardware and essentially never with a mouse, which is why it
 * survives review and only shows up on a tablet.
 *
 * And it is not a harmless throw. It sits at the TOP of a pointerdown handler,
 * before the gesture's mode is set, so the exception takes the rest of the
 * handler with it: the press is swallowed and the gesture either never starts,
 * or starts half-armed with no capture and therefore no guaranteed release.
 * "I drew a selection rectangle and it stayed on screen until I clicked again"
 * is one of the shapes that produces.
 *
 * The stage's middle-button pan already had this guard, with a comment
 * explaining exactly this failure — and the other fifty call sites did not. One
 * documented workaround in one file is a note; the same call unguarded
 * everywhere else is the bug still being there.
 *
 * **Capture is an optimisation, never a requirement.** It lets a drag keep
 * tracking off-element; every gesture here also listens on the window or its
 * container, so losing it degrades rather than breaks. Returning a boolean
 * rather than rethrowing says exactly that: a caller may check, and none has to.
 */
export function capturePointer(el: Element | null | undefined, pointerId: number): boolean {
  if (!el || typeof el.setPointerCapture !== "function") return false;
  try {
    el.setPointerCapture(pointerId);
    return true;
  } catch {
    // The pointer is already gone. The gesture continues without capture.
    return false;
  }
}
