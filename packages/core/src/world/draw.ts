import type { Contour, PathClip, StrokeStyle } from "../schema";
import { pathBox } from "../pivot";
import { translateSubpaths } from "../vector/geometry";
import { strokesToLayer } from "../vector/layer-space";
import { add, basis4, cross, dot, eulerFromRotation, normalize3, scale3, sub, type V3 } from "./math";

/**
 * DRAWING IN SPACE — a stroke made by the flat brush, landed on a page in a
 * world.
 *
 * Nothing about the stroke's LOOK is 3D's own. The viewport fits the gesture
 * in SCREEN px with the flat canvas's own fit (`vectorStroke`: the brush's
 * streamline, straighten, auto-close, taper and pressure, all measured in the
 * px the brush is authored in), previews exactly that fit, and hands it here.
 * This module answers only WHERE it lands:
 *
 *     screen px ──land──▶ world point ──frame──▶ page / layer coordinates
 *
 * That order is the decision. The first version fitted in WORLD units with the
 * brush's px-denominated settings (straighten, auto-close, taper) read as if
 * they were world units — zoomed in, a 20px auto-close spanned a hundred screen
 * px and closed strokes into polygons; zoomed out, tapers ate the line. Fitting
 * where the brush's units are true makes 3D drawing the 2D stroke plus one map.
 *
 * A PAGE is a plane with a facing (right, up; forward = up × right, away from
 * the eye). Contours on a page are in its coordinates: x right, y DOWN (the
 * flat convention), and a point's `z` is depth along forward — absent on a
 * flat page, set where a stroke hugs a surface.
 */

export interface DrawPage {
  anchor: V3;
  right: V3;
  up: V3;
}

/**
 * Where a stroke lands, chosen BEFORE it is drawn — never guessed from where
 * the pen happened to start (that rule made a stroke that clipped an object's
 * edge wrap it, and one a pixel away float in front of it).
 *
 *   view     a page facing you through the 3D cursor — paper held up to the
 *            camera. The default: what you draw is what you see.
 *   surface  on the objects under the pen; where it leaves them it continues
 *            on the page through the first touch.
 *   front / side / top   the world's axis planes through the 3D cursor
 *            (Blender's drawing planes), turned to face you.
 */
export const DRAW_PLACEMENTS = ["view", "surface", "front", "side", "top"] as const;
export type DrawPlacement = (typeof DRAW_PLACEMENTS)[number];

/** A page's facing: away from the eye, so its picture is never seen mirrored. */
export function pageForward(page: Pick<DrawPage, "right" | "up">): V3 {
  return normalize3(cross(page.up, page.right));
}

/**
 * The page a placement draws on. `view` is the camera's own right/up/forward;
 * `cursor` the 3D cursor; `hit` the surface point under the first sample (for
 * `surface`). Axis pages pick the sign of their right axis so they face the eye.
 */
export function pageFor(placement: DrawPlacement, view: { right: V3; up: V3; forward: V3 }, cursor: V3, hit: V3 | null = null): DrawPage {
  if (placement === "view") return { anchor: cursor, right: view.right, up: view.up };
  if (placement === "surface") return { anchor: hit ?? cursor, right: view.right, up: view.up };
  const axes: Record<"front" | "side" | "top", { right: V3; up: V3 }> = {
    front: { right: [1, 0, 0], up: [0, 0, 1] },
    side: { right: [0, 1, 0], up: [0, 0, 1] },
    top: { right: [1, 0, 0], up: [0, 1, 0] },
  };
  const a = axes[placement];
  // Seen from behind, flip right: the page turns to face you and keeps its up.
  const facing = dot(pageForward(a), view.forward) >= 0;
  return { anchor: cursor, right: facing ? a.right : scale3(a.right, -1), up: a.up };
}

/** A world point in a page's coordinates (x right, y down, z depth along forward). */
export function toPage(page: DrawPage, w: V3): { x: number; y: number; z: number } {
  const d = sub(w, page.anchor);
  return { x: dot(d, page.right), y: -dot(d, page.up), z: dot(d, pageForward(page)) };
}

/** The inverse of `toPage`. */
export function fromPage(page: DrawPage, p: { x: number; y: number; z?: number }): V3 {
  return add(page.anchor, add(add(scale3(page.right, p.x), scale3(page.up, -p.y)), scale3(pageForward(page), p.z ?? 0)));
}

/**
 * Land contours fitted in screen px. `land(x, y)` is where a screen point
 * meets the drawing (the page, or a surface); `onPage(x, y)` where it meets
 * the page alone — HANDLES land there, because a tangent is a direction on
 * the page and dropping one onto a surface behind it would kink the curve.
 * `frame` expresses a world point in the coordinates the path is written in
 * (a new layer's page, or an existing layer's own space).
 *
 * Null when an anchor lands nowhere (a ray parallel to the page): a stroke is
 * kept whole or not at all, never with a hole where a point fell off.
 */
export function landContours(
  subpaths: readonly Contour[],
  land: (x: number, y: number) => V3 | null,
  onPage: (x: number, y: number) => V3 | null,
  frame: (w: V3) => { x: number; y: number; z: number },
): Contour[] | null {
  const out: Contour[] = [];
  for (const c of subpaths) {
    const points: Contour["points"] = [];
    for (const p of c.points) {
      const w = land(p.x, p.y);
      if (!w) return null;
      const q = frame(w);
      const handle = (h: { x: number; y: number } | null) => {
        if (!h) return null;
        const hw = onPage(h.x, h.y);
        if (!hw) return null;
        const hq = frame(hw);
        return { x: hq.x, y: hq.y };
      };
      // A depth below a hundredth of a unit is the float noise of a flat page, not depth.
      points.push({ ...p, x: q.x, y: q.y, z: Math.abs(q.z) > 0.01 ? q.z : undefined, hIn: handle(p.hIn), hOut: handle(p.hOut) });
    }
    out.push({ ...c, points });
  }
  return out;
}

/** Does any point of these contours leave its page? (A flat path is a picture; a deep one a 3D curve.) */
export function contoursHaveDepth(subpaths: readonly Contour[]): boolean {
  const deep = (z: number | undefined) => z !== undefined && Math.abs(z) > 0.01;
  return subpaths.some((c) => c.points.some((p) => deep(p.z) || deep(p.hIn?.z) || deep(p.hOut?.z)));
}

/**
 * A NEW path layer standing on a page: its contours centred on their own box
 * and its transform putting that box's centre where the page has it.
 *
 * Centred on `pathBox` — the box the PIVOT is a fraction of — and nothing
 * else. Centring on the anchors' extent instead (the first version) left the
 * layer's box centre off its origin by the curves' overshoot, and the plane
 * mapping subtracts that centre: every curvy stroke jumped sideways by it the
 * moment it was committed.
 */
export function pathOnPage(subpaths: Contour[], page: DrawPage): { subpaths: Contour[]; transform: Pick<PathClip["transform"], "x" | "y" | "z" | "rotationX" | "rotationY" | "rotation"> } | null {
  const box = pathBox(subpaths);
  if (!(box.width > 0 || box.height > 0)) return null;
  const centred = subpaths.map((c) => ({ ...c, points: c.points.map((p) => ({ ...p, hIn: p.hIn && { ...p.hIn }, hOut: p.hOut && { ...p.hOut } })) }));
  translateSubpaths(centred, -box.cx, -box.cy);
  const at = fromPage(page, { x: box.cx, y: box.cy });
  const r = eulerFromRotation(basis4(page.right, pageForward(page), page.up));
  return { subpaths: centred, transform: { x: at[0], y: at[1], z: at[2], rotationX: r[0], rotationY: r[1], rotation: r[2] } };
}

/**
 * The ink a stroke fitted in screen px wears once its geometry is in a space
 * `unitsPerPx` world units to the px: the width (and with it, through
 * `baseWidth`, the dash, wave and roughness) scaled by the same factor as the
 * geometry — never one without the other.
 */
export function inkInSpace(ink: readonly StrokeStyle[], unitsPerPx: number): StrokeStyle[] {
  return strokesToLayer(ink, { lengthScale: unitsPerPx });
}
