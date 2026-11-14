import type { MotionDocument, PathClip, VisualClip } from "../schema";
import { basisOfTransform, mapLocal, unmapLocal, type LayerBasis } from "../transform-map";
import { clipBox } from "../timeline/ops";
import type { V3 } from "./math";
import { handleDepth } from "../vector/geometry";

/**
 * A 2D LAYER'S PLANE IN A WORLD — where a point of the layer's own geometry
 * sits in its object's local 3D space. ONE mapping, shared by everything that
 * puts layer geometry into a world: the picture plane, a path's 3D curve and
 * the 3D edit mode's cage (path anchors, crop corners).
 *
 * The picture is drawn AT REST — placement (position, rotation, scale) is the
 * object matrix's job (`objectLocalMatrix`) — so only what belongs to the
 * picture survives here: its skew and its pivot. Content (u right, v down)
 * lies on the local XZ plane facing −Y, and a path point's depth (`z`, + away
 * from the front) runs along +Y. (ADR-3d, "The transform".)
 */
export function planeBasis(doc: MotionDocument, clip: VisualClip): LayerBasis {
  return basisOfTransform({ ...clip.transform, scale: 1, scaleY: null, rotation: 0 }, clipBox(doc, clip));
}

/** A point of the layer's own geometry → its object's local 3D space. */
export function planeToLocal(b: LayerBasis, p: { x: number; y: number; z?: number }): V3 {
  const q = mapLocal(p.x, p.y, b);
  return [q.x, p.z ?? 0, -q.y];
}

/** The exact inverse: object-local 3D → the layer's own coordinates and depth. */
export function localToPlane(b: LayerBasis, v: V3): { x: number; y: number; z: number } {
  const q = unmapLocal(v[0], -v[2], b);
  return { x: q.x, y: q.y, z: v[1] };
}

/**
 * A path layer's outline as a POLYLINE in its own object space, depth
 * included — its first run, beziers sampled (16 steps a curved segment). What
 * a Curve modifier follows and what a revolved (Screw) path turns.
 */
export function pathPolyline(doc: MotionDocument, clip: PathClip): V3[] {
  const basis = planeBasis(doc, clip);
  const sp = clip.subpaths.find((s) => s.points.length >= 2);
  if (!sp) return [];
  const out: V3[] = [];
  const pts = sp.points;
  const n = sp.closed ? pts.length : pts.length - 1;
  out.push(planeToLocal(basis, pts[0]!));
  for (let i = 0; i < n; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const c1 = a.hOut ?? a, c2 = b.hIn ?? b;
    // Depth is a cubic like x and y, its control values the handles' depths
    // (`handleDepth`: their own, else a straight run's — so a curve whose
    // handles carry no depth still runs straight in depth between anchors).
    const az = a.z ?? 0, bz = b.z ?? 0;
    const z1 = handleDepth(a, a.hOut, b), z2 = handleDepth(b, b.hIn, a);
    const steps = a.hOut || b.hIn ? 16 : 1;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push(
        planeToLocal(basis, {
          x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
          y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
          z: u * u * u * az + 3 * u * u * t * z1 + 3 * u * t * t * z2 + t * t * t * bz,
        }),
      );
    }
  }
  return out;
}
