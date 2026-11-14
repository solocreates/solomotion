/**
 * WHERE A POINTER IS, relative to a selection box's corners, and which way those
 * corners face on screen. The one answer the hover cursor and the press both
 * read, so what the cursor promises is what a drag does.
 *
 * Everything takes the box as its four SCREEN corners, in order around the box.
 * Rotation, skew, parents and zoom have all happened by then, so the constants
 * below are true pixels at every zoom on every layer.
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

/** How close (screen px) a pointer must be to a corner's centre to resize from it. */
export const HANDLE_HIT_PX = 9;

/** How far past the resize handle the rotate zone reaches, in screen px. */
export const ROTATE_BAND_PX = 10;

const unit = (x: number, y: number): ScreenPoint | null => {
  const l = Math.hypot(x, y);
  return l > 1e-6 ? { x: x / l, y: y / l } : null;
};

const degrees = (v: ScreenPoint): number => (Math.atan2(v.y, v.x) * 180) / Math.PI;

/** The box's outward directions at a corner: along each edge, away from the box. */
function cornerAxes(corners: readonly ScreenPoint[], i: number): [ScreenPoint, ScreenPoint] | null {
  const n = corners.length;
  const c = corners[i]!;
  const prev = corners[(i + n - 1) % n]!;
  const next = corners[(i + 1) % n]!;
  const a = unit(c.x - prev.x, c.y - prev.y);
  const b = unit(c.x - next.x, c.y - next.y);
  return a && b ? [a, b] : null;
}

/**
 * Which way a corner faces on screen, in degrees: its outward bisector. Taken
 * from the corner's own edges, so a long thin box still gets a true 45° cursor
 * where a line from its centre would read nearly flat, and a moved pivot changes
 * nothing.
 */
export function cornerBearing(corners: readonly ScreenPoint[], i: number): number {
  const axes = cornerAxes(corners, i);
  if (!axes) return 0;
  const bisector = unit(axes[0].x + axes[1].x, axes[0].y + axes[1].y);
  return bisector ? degrees(bisector) : 0;
}

/** Which way the edge from corner `i` to corner `i + 1` faces: its outward normal, in degrees. */
export function edgeBearing(corners: readonly ScreenPoint[], i: number): number {
  const n = corners.length;
  const a = corners[i]!;
  const b = corners[(i + 1) % n]!;
  const along = unit(b.x - a.x, b.y - a.y);
  if (!along) return 0;
  let cx = 0;
  let cy = 0;
  for (const p of corners) {
    cx += p.x / n;
    cy += p.y / n;
  }
  const normal = { x: along.y, y: -along.x };
  const outward = normal.x * (a.x - cx) + normal.y * (a.y - cy) >= 0;
  return degrees(outward ? normal : { x: -normal.x, y: -normal.y });
}

/**
 * The corner whose rotate zone holds the pointer, or null.
 *
 * The zone is a quarter ring: past the resize handle (`inner`), within
 * `ROTATE_BAND_PX` of it, and inside the wedge beyond both of the corner's edges.
 * The wedge is what makes it exact. A pointer beside an edge, however close to the
 * corner, is outside the box on only one axis, so it is not in the zone. It is
 * measured against the box's own edges rather than the pivot, because a pivot
 * moved off centre must not move where a corner can be grabbed.
 */
export function rotateZoneCorner(
  p: ScreenPoint,
  corners: readonly ScreenPoint[],
  inner: number = HANDLE_HIT_PX,
  band: number = ROTATE_BAND_PX,
): number | null {
  for (let i = 0; i < corners.length; i++) {
    const c = corners[i]!;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const d = Math.hypot(dx, dy);
    if (d <= inner || d > inner + band) continue;
    const axes = cornerAxes(corners, i);
    if (!axes) continue;
    const [u, v] = axes;
    // The pointer as a mix of the two outward axes. Both parts positive means
    // beyond both edges, and that holds on a skewed box too.
    const det = u.x * v.y - u.y * v.x;
    if (Math.abs(det) < 1e-6) continue;
    const along = (dx * v.y - dy * v.x) / det;
    const across = (u.x * dy - u.y * dx) / det;
    if (along >= 0 && across >= 0) return i;
  }
  return null;
}
