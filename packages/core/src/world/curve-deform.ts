import type { MeshData } from "../schema/world";
import { cross, dot, normalize3, sub, type V3 } from "./math";

/**
 * CURVE — bend a shape ALONG A PATH (Blender's Curve modifier, C4D's Spline
 * Wrap): the shape's length along one axis is laid onto the path by arc
 * length, its other two axes stand on the path's moving frame. Text that
 * flows round a 3D ribbon, a logo that rides a loop, a tube that follows a
 * drawn stroke — and `offset` keyed slides it along.
 *
 * The frame is ROTATION-MINIMISING (double reflection, Wang et al. 2008), not
 * Frenet: Frenet flips at every inflection of a drawn curve, this one turns
 * only as much as the path does. It starts from the path's own "up" — the
 * normal of the plane the path was drawn on — so a flat path keeps letters
 * upright the way the eye expects.
 */

interface Frame {
  p: V3;
  t: V3;
  n: V3;
  b: V3;
  s: number;
}

const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2]);

/**
 * The path's frames, one per sample, with arc length. Null for a path too
 * short to follow. `normal` is the plane the path was drawn on (facing the
 * viewer): "up" starts IN that plane, to the left of travel — a shape on a
 * path stands on it the way text on a 2D path does.
 */
export function curveFrames(points: readonly V3[], normal: V3): Frame[] | null {
  const pts = points.filter((p, i) => i === 0 || len3(sub(p, points[i - 1]!)) > 1e-6);
  if (pts.length < 2) return null;
  const tangents = pts.map((_, i) => {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!;
    return normalize3(sub(b, a));
  });
  const up = cross(normal, tangents[0]!);
  // Start "up" perpendicular to the first tangent.
  let r0 = sub(up, mul3(tangents[0]!, dot(up, tangents[0]!)));
  if (len3(r0) < 1e-6) r0 = Math.abs(tangents[0]![2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let r = normalize3(sub(r0, mul3(tangents[0]!, dot(r0, tangents[0]!))));
  const frames: Frame[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      s += len3(sub(pts[i]!, pts[i - 1]!));
      // Double reflection: carry r from the last frame to this one.
      const v1 = sub(pts[i]!, pts[i - 1]!);
      const c1 = dot(v1, v1);
      const rL = sub(r, mul3(v1, (2 / c1) * dot(v1, r)));
      const tL = sub(tangents[i - 1]!, mul3(v1, (2 / c1) * dot(v1, tangents[i - 1]!)));
      const v2 = sub(tangents[i]!, tL);
      const c2 = dot(v2, v2);
      r = c2 < 1e-12 ? rL : normalize3(sub(rL, mul3(v2, (2 / c2) * dot(v2, rL))));
    }
    const t = tangents[i]!;
    frames.push({ p: pts[i]!, t, n: r, b: normalize3(cross(t, r)), s });
  }
  return frames;
}

/** The frame at arc length `s` (clamped ends continue straight along their tangent). */
function frameAt(frames: Frame[], s: number): { p: V3; t: V3; n: V3; b: V3 } {
  const total = frames[frames.length - 1]!.s;
  if (s <= 0) {
    const f = frames[0]!;
    return { p: add3(f.p, mul3(f.t, s)), t: f.t, n: f.n, b: f.b };
  }
  if (s >= total) {
    const f = frames[frames.length - 1]!;
    return { p: add3(f.p, mul3(f.t, s - total)), t: f.t, n: f.n, b: f.b };
  }
  let lo = 0, hi = frames.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (frames[mid]!.s <= s) lo = mid;
    else hi = mid;
  }
  const a = frames[lo]!, b = frames[hi]!;
  const k = (s - a.s) / Math.max(1e-9, b.s - a.s);
  const lerp = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
  return { p: lerp(a.p, b.p), t: normalize3(lerp(a.t, b.t)), n: normalize3(lerp(a.n, b.n)), b: normalize3(lerp(a.b, b.b)) };
}

/**
 * Lay `mesh` along the path. `axis` is the shape's length axis; the shape
 * starts at the path's start plus `offset` (a fraction of the path's length);
 * `stretch` fits the shape's whole length to the path instead of keeping its
 * size. The two other axes map to the frame's up and side.
 */
export function deformAlongCurve(mesh: MeshData, path: readonly V3[], normal: V3, axis: 0 | 1 | 2, offset: number, stretch: boolean): MeshData {
  const frames = curveFrames(path, normal);
  if (!frames) return mesh;
  const total = frames[frames.length - 1]!.s;
  const P = mesh.positions;
  let lo = Infinity, hi = -Infinity;
  for (let i = axis; i < P.length; i += 3) (lo = Math.min(lo, P[i]!)), (hi = Math.max(hi, P[i]!));
  const length = Math.max(1e-6, hi - lo);
  const k = stretch ? total / length : 1;
  // The other two axes: "side" and "up" of the shape. For a card (XZ plane,
  // facing −Y) along X that is up = Z, side = Y — letters stand on the path.
  const [side, upAxis] = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
  // The side vector keeps the shape's handedness: on a straight path along
  // the axis with the shape's own up, the deform is the identity.
  const sideOf = (t: V3, n: V3): V3 => (axis === 1 ? cross(t, n) : cross(n, t));
  const out = P.slice();
  for (let i = 0; i < P.length; i += 3) {
    const s = (P[i + axis]! - lo) * k + offset * total;
    const f = frameAt(frames, s);
    const sv = sideOf(f.t, f.n);
    const u = P[i + upAxis]!, w = P[i + side]!;
    out[i] = f.p[0] + f.n[0] * u + sv[0] * w;
    out[i + 1] = f.p[1] + f.n[1] * u + sv[1] * w;
    out[i + 2] = f.p[2] + f.n[2] * u + sv[2] * w;
  }
  return { ...mesh, positions: out };
}
