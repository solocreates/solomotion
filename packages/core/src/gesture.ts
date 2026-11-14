/**
 * Headless GESTURE MATH — the pure, framework-free primitives every draggable
 * shares (stage layers, pen nodes, transform handles, sheet cells). No DOM, no
 * store: just geometry in, geometry out, so the exact same constraint rule
 * governs every drag and there is only ONE place that decides what "hold Shift"
 * means.
 */

/** Radians per degree. */
const DEG = Math.PI / 180;

/**
 * The Shift-constrain rule. Snap a free drag vector `(dx, dy)` to the nearest
 * ray whose angle is a multiple of `stepDeg`, then PROJECT the vector onto that
 * ray. At 90° this is a hard axis-lock (the off-axis component is dropped); at
 * 45° it adds diagonals; at 15° (the default) it also allows the 15/30/60/75
 * angles — one dial, every "constrain movement to a nice angle" gesture.
 *
 * Projection (dot with the unit ray) rather than rotation means the object
 * tracks the pointer's travel ALONG the locked direction and simply ignores the
 * sideways wander — the standard, predictable feel. Returns the constrained
 * delta plus the snapped angle in degrees (for drawing the guide).
 */
export function constrainDragToAngle(
  dx: number,
  dy: number,
  stepDeg = 15,
): { dx: number; dy: number; angleDeg: number } {
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0, angleDeg: 0 };
  const step = stepDeg * DEG;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  const ux = Math.cos(snapped);
  const uy = Math.sin(snapped);
  const proj = dx * ux + dy * uy; // signed travel along the locked ray
  return { dx: proj * ux, dy: proj * uy, angleDeg: (snapped / DEG + 360) % 360 };
}

/**
 * Lock drag movement to a single axis. Used for clip dragging with Shift to
 * constrain to pure vertical (Y-only) movement, like DaVinci Resolve.
 */
export function constrainDragToAxis(
  dx: number,
  dy: number,
  axis: 'x' | 'y',
): { dx: number; dy: number } {
  return axis === 'x' ? { dx, dy: 0 } : { dx: 0, dy };
}

/**
 * Is this press the one that OPENS a layer — the second (or later) press of a
 * multi-click — rather than the start of an ordinary drag?
 *
 * A double-click means one thing everywhere in this app: go one level deeper
 * into whatever is under the pointer (group → layer → the layer's own editor —
 * glyphs, nodes, corners, a nested comp's timeline). That gesture necessarily
 * BEGINS with a press landing on the layer, and interior chrome — the pivot
 * crosshair, corner-radius dots, parametric shape handles — floats inside the
 * very layer you are aiming at. When such a handle claims that press, the drill
 * never happens: you double-click a text layer to type in it and end up holding
 * its anchor point instead, which is arbitrary from the user's side because it
 * depends on where the crosshair happens to be sitting.
 *
 * So interior chrome is a SINGLE-press affordance. It still takes press-and-drag
 * (that is how you move a pivot or round a corner) — it just yields the press
 * that is already spoken for. Hit-testing is untouched: this is about intent,
 * not geometry, which is why it is one predicate rather than a special case in
 * each handle's hit test.
 *
 * `detail` is the DOM's own click counter (`MouseEvent.detail`), so the rule
 * follows the platform's double-click timing instead of inventing a second one.
 */
export function isDrillPress(detail: number): boolean {
  return detail >= 2;
}
