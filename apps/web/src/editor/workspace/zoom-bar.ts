/**
 * THE ZOOM BAR's maths — a scrollbar whose thumb IS the visible window.
 *
 * Premiere, Resolve and Audition share one control for an axis: the thumb's
 * position is where you are, its LENGTH is how much you see, and its ends are
 * handles. Drag the body to pan, drag an end to zoom with the other end held.
 *
 * Axis-agnostic: everything is in the axis's own unit (ms for time, base px for
 * rows). The bar maps [0, barPx] onto [0, extent] and every answer here is a
 * window in that unit; an `ViewAxis` adapter turns it into a pan or a zoom.
 *
 * THE HANDLE STAYS UNDER THE CURSOR. The mapping is frozen at the press
 * (`pressScale`), and when the window is wider than the content (zoomed out past
 * it) the frozen extent is the window itself — so the handle starts exactly
 * where you grabbed it and follows the pointer 1:1, instead of jumping inward
 * on the first move and then needing a long push to shrink.
 */

export interface AxisWindow {
  /** First visible unit. */
  start: number;
  /** Visible length. */
  size: number;
  /** The content's length — what a full bar stands for. */
  extent: number;
  /** Smallest / largest window the axis allows (its zoom bounds). */
  minSize: number;
  maxSize: number;
}

export type BarGrip = "start" | "end" | "body";

/** What the full bar stands for right now: never less than what is on screen. */
export function shownExtent(w: Pick<AxisWindow, "start" | "size" | "extent">): number {
  return Math.max(w.extent, w.start + w.size, w.size, 1e-9);
}

/** The thumb in bar pixels. Never thinner than `minPx`, so both handles stay grabbable. */
export function thumbRect(start: number, size: number, extent: number, barPx: number, minPx: number): { left: number; width: number } {
  if (barPx <= 0 || extent <= 0) return { left: 0, width: Math.max(0, barPx) };
  const scale = barPx / extent;
  const width = Math.min(barPx, Math.max(minPx, size * scale));
  const left = Math.min(barPx - width, Math.max(0, start * scale));
  return { left, width };
}

/**
 * The window a drag asks for. `w0` is the window at the press, `extent0` the
 * frozen extent (`shownExtent(w0)`), `at` the pointer's unit position along the
 * frozen bar, already corrected by the grab offset so `at` equals the grabbed
 * edge at the press.
 */
export function dragWindow(grip: BarGrip, w0: AxisWindow, extent0: number, at: number): { start: number; size: number } {
  const end0 = w0.start + w0.size;
  // The window on screen is always a legal answer, even when something else
  // (a pinch past the floor) put it outside the bounds — so the press never jumps.
  const maxSize = Math.max(w0.maxSize, w0.size);
  const minSize = Math.min(w0.minSize, w0.size);
  if (grip === "body") {
    return { start: Math.min(Math.max(0, extent0 - w0.size), Math.max(0, at)), size: w0.size };
  }
  if (grip === "end") {
    const end = Math.min(extent0, w0.start + maxSize, Math.max(w0.start + minSize, at));
    return { start: w0.start, size: end - w0.start };
  }
  const start = Math.max(0, end0 - maxSize, Math.min(end0 - minSize, at));
  return { start, size: end0 - start };
}

/** Click on the bare track: centre the window there. */
export function centredAt(w: Pick<AxisWindow, "start" | "size" | "extent">, at: number): number {
  return Math.min(Math.max(0, shownExtent(w) - w.size), Math.max(0, at - w.size / 2));
}
