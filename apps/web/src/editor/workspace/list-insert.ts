/**
 * ONE ORDERED LIST, TWO PRESENTATIONS — the maths a rail and a tab strip share.
 *
 * A rail and a region's tab strip are the same object: an ordered list of
 * editors in a region, plus the active one. The rail is its vertical (or
 * bottom) presentation, the strip its horizontal one in a region header. So
 * "where in this list would the pointer insert?" and "which tabs still fit with
 * their names?" are answered once, here, and both surfaces call it. Pure: no
 * DOM, no React — the caller measures, this decides.
 */

export type ListAxis = "x" | "y";

export interface Span {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far past a slot boundary the pointer must go before the slot changes. */
export const LIST_HYSTERESIS_PX = 6;

const startOf = (r: Span, axis: ListAxis) => (axis === "x" ? r.x : r.y);
const lenOf = (r: Span, axis: ListAxis) => (axis === "x" ? r.width : r.height);

/**
 * The insertion slot for a pointer over a list: 0 (before the first item) …
 * `items.length` (after the last). `items` are the list's NATURAL rects in
 * order, WITHOUT the dragged item (the caller closes its hole).
 *
 * It is solved against the list AS DISPLAYED: while slot `prev` is showing,
 * every item from `prev` on sits `badge` px further along (the gap the badge
 * opened), and the pointer is compared with THOSE midpoints. Comparing with
 * the natural ones put the badge one slot late — you aim at what you see.
 * That is also what makes it stable: crossing an item swaps it with the gap,
 * and coming back needs the pointer to cross it again (a `badge`-wide band),
 * plus `hysteresis` px either way so a pointer resting on a midpoint never
 * makes the badge flicker.
 */
export function solveListInsert(
  items: readonly Span[],
  axis: ListAxis,
  pointer: { x: number; y: number },
  prev: number | null = null,
  badge = 0,
  hysteresis = LIST_HYSTERESIS_PX,
): number {
  const p = axis === "x" ? pointer.x : pointer.y;
  const valid = prev !== null && prev >= 0 && prev <= items.length;
  const mids = items.map((r, k) => startOf(r, axis) + lenOf(r, axis) / 2 + (valid && k >= prev! ? badge : 0));
  let slot = 0;
  while (slot < mids.length && p > mids[slot]!) slot++;
  if (!valid || prev === slot) return slot;
  // Stay in `prev` while the pointer is inside its span grown by the hysteresis.
  const lo = prev === 0 ? -Infinity : mids[prev! - 1]! - hysteresis;
  const hi = prev === mids.length ? Infinity : mids[prev!]! + hysteresis;
  return p >= lo && p <= hi ? prev! : slot;
}

/**
 * Which tabs collapse to their icon so the strip fits `available` px.
 *
 * Names are always shown when there is room. When there is not, INACTIVE tabs
 * fold to icons from the END of the strip first (the tabs you opened last, and
 * the ones furthest from where the eye starts), and the active tab never
 * folds — it is the sentence the strip is saying. If even that does not fit,
 * the strip scrolls (`overflow: true`).
 *
 * `full[i]` / `icon[i]` are MEASURED widths; nothing here guesses a width.
 */
export function fitTabs(
  full: readonly number[],
  icon: readonly number[],
  active: number,
  available: number,
  gap = 0,
): { collapsed: boolean[]; overflow: boolean } {
  const n = full.length;
  const collapsed = new Array<boolean>(n).fill(false);
  const total = () => full.reduce((a, w, i) => a + (collapsed[i] ? icon[i] ?? w : w), 0) + gap * Math.max(0, n - 1);
  for (let i = n - 1; i >= 0 && total() > available + 0.5; i--) {
    if (i === active) continue;
    collapsed[i] = true;
  }
  return { collapsed, overflow: total() > available + 0.5 };
}
