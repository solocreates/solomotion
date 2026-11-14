import type { Vec2 } from "../schema/common";
import type { TrackSample } from "../schema/tracking";

/**
 * THE POSE — where a tracked region is at one instant, as a homography about
 * its centre, decomposed into one field per degree of freedom:
 *
 *     H = T(x, y) · R(rotation) · K(skew) · S(scale, scaleY) · P(g, h)
 *
 * `P = [[1,0,0],[0,1,0],[g,h,1]]` is the projective row. A region-local point
 * `p` therefore lands at `t + L · p / (1 + g·p.x + h·p.y)` with `L = R·K·S`.
 *
 * The decomposition is UNIQUE for any homography with a positive determinant
 * (P is H's bottom row; the rest is a QR split of the affine remainder), which
 * is what makes every channel separately solvable, pinnable and readable: a
 * tracked plane is not a nine-number blob, it is "this far, this turned, this
 * sheared, this far away from square".
 *
 * Pure maths, no DOM; the engines, the reader, the stage overlay and the
 * corner-pin renderer all go through here.
 */
export interface RegionPose {
  x: number;
  y: number;
  scale: number;
  /** null = locked to `scale`. */
  scaleY: number | null;
  /** Degrees. */
  rotation: number;
  /** Shear, degrees. Absent = 0. */
  skew?: number;
  /** Projective row `[g, h]`. Absent or null = affine. */
  perspective?: Vec2 | null;
  /** Per-vertex offsets in region-local space, parallel to `regionVertices`. */
  warp?: Vec2[] | null;
}

/** A row-major 3×3 homography: `[h00,h01,h02, h10,h11,h12, h20,h21,h22]`. */
export type Homography = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_POSE: RegionPose = { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skew: 0, perspective: null };

/** The pose half of a sample, for callers that only want to place geometry. */
export function poseOf(s: TrackSample): RegionPose {
  return {
    x: s.x,
    y: s.y,
    scale: s.scale,
    scaleY: s.scaleY,
    rotation: s.rotation,
    skew: s.skew,
    perspective: s.perspective,
    warp: s.warp,
  };
}

/** The linear part `L = R · K · S` as `[a, b, c, d]` (columns: L·e1 = (a,b), L·e2 = (c,d)). */
function linearOf(pose: RegionPose): [number, number, number, number] {
  const sx = pose.scale;
  const sy = pose.scaleY ?? pose.scale;
  const k = Math.tan(((pose.skew ?? 0) * Math.PI) / 180);
  const r = (pose.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // K·S = [[sx, k·sy], [0, sy]]; R·(K·S) column by column.
  return [cos * sx, sin * sx, cos * k * sy - sin * sy, sin * k * sy + cos * sy];
}

/** Map one region-local point through a pose (warp NOT applied — see `contourAtPose`). */
export function posePoint(p: Vec2, pose: RegionPose): Vec2 {
  const [a, b, c, d] = linearOf(pose);
  const g = pose.perspective?.x ?? 0;
  const h = pose.perspective?.y ?? 0;
  const w = 1 + g * p.x + h * p.y;
  // A point on or behind the vanishing line has no image; hold it at the
  // horizon rather than flinging it to the other side of the frame.
  const iw = w > 1e-6 ? 1 / w : 1e6;
  const px = p.x * iw;
  const py = p.y * iw;
  return { x: pose.x + a * px + c * py, y: pose.y + b * px + d * py };
}

/** The inverse — a source-pixel point back into region-local space. */
export function unposePoint(q: Vec2, pose: RegionPose): Vec2 {
  const [a, b, c, d] = linearOf(pose);
  const det = a * d - b * c || 1e-12;
  const dx = q.x - pose.x;
  const dy = q.y - pose.y;
  const rx = (d * dx - c * dy) / det;
  const ry = (-b * dx + a * dy) / det;
  const g = pose.perspective?.x ?? 0;
  const h = pose.perspective?.y ?? 0;
  const den = 1 - g * rx - h * ry;
  const k = Math.abs(den) > 1e-9 ? 1 / den : 1e9;
  return { x: rx * k, y: ry * k };
}

/** Compose the pose into a homography (region-local → source px). */
export function poseHomography(pose: RegionPose): Homography {
  const [a, b, c, d] = linearOf(pose);
  const g = pose.perspective?.x ?? 0;
  const h = pose.perspective?.y ?? 0;
  // H = A · P with A = [[a,c,x],[b,d,y],[0,0,1]].
  return [a + pose.x * g, c + pose.x * h, pose.x, b + pose.y * g, d + pose.y * h, pose.y, g, h, 1];
}

/**
 * Decompose a homography back into a pose. Null for a degenerate or mirrored
 * map (a tracked plane cannot turn inside out; a solver that says it did is
 * wrong, and the caller keeps its prior).
 */
export function poseFromHomography(H: Homography): RegionPose | null {
  const n = H[8];
  if (!Number.isFinite(n) || Math.abs(n) < 1e-12) return null;
  const m = H.map((v) => v / n) as Homography;
  const g = m[6];
  const h = m[7];
  const x = m[2];
  const y = m[5];
  // A = H · P⁻¹, P⁻¹ = [[1,0,0],[0,1,0],[-g,-h,1]] — only the linear part matters.
  const a = m[0] - g * x;
  const b = m[3] - g * y;
  const c = m[1] - h * x;
  const d = m[4] - h * y;
  const det = a * d - b * c;
  if (!(det > 1e-12) || !Number.isFinite(det)) return null;
  const sx = Math.hypot(a, b);
  const theta = Math.atan2(b, a);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // U = Rᵀ · L = [[sx, k·sy], [0, sy]].
  const u01 = cos * c + sin * d;
  const sy = -sin * c + cos * d;
  if (!(sy > 1e-9)) return null;
  const skew = (Math.atan(u01 / sy) * 180) / Math.PI;
  const hasPersp = Math.abs(g) > 1e-12 || Math.abs(h) > 1e-12;
  return {
    x,
    y,
    scale: sx,
    scaleY: Math.abs(sy - sx) < 1e-9 ? null : sy,
    rotation: (theta * 180) / Math.PI,
    skew: Math.abs(skew) < 1e-9 ? 0 : skew,
    perspective: hasPersp ? { x: g, y: h } : null,
  };
}

/** Apply a homography to a point. */
export function applyHomography(H: Homography, p: Vec2): Vec2 {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  const iw = Math.abs(w) > 1e-12 ? 1 / w : 1e12;
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) * iw, y: (H[3] * p.x + H[4] * p.y + H[5]) * iw };
}

/** `A · B` for two homographies. */
export function multiplyHomography(A: Homography, B: Homography): Homography {
  const out = new Array(9).fill(0) as Homography;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) out[r * 3 + c] = A[r * 3]! * B[c]! + A[r * 3 + 1]! * B[3 + c]! + A[r * 3 + 2]! * B[6 + c]!;
  return out;
}

/** The inverse homography (adjugate / determinant). Null when singular. */
export function invertHomography(H: Homography): Homography | null {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [
    A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k,
  ];
}

/**
 * The homography taking four points onto four points — what a corner pin is.
 * Solved as the 8×8 linear system with h22 = 1. Null when three are collinear.
 */
export function homographyFromQuads(from: readonly Vec2[], to: readonly Vec2[]): Homography | null {
  const A: number[][] = [];
  const rhs: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }
  const s = solveLinear(A, rhs);
  return s ? ([s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!, s[6]!, s[7]!, 1] as Homography) : null;
}

/** Gaussian elimination with partial pivoting. Null when singular. Small systems only. */
export function solveLinear(M: number[][], rhs: number[]): number[] | null {
  const n = rhs.length;
  const A = M.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const p = A[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = A[r]!;
      const f = row[col]! / p[col]!;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) row[k]! -= f * p[k]!;
    }
  }
  return A.map((row, i) => row[n]! / row[i]!);
}

/** Interpolate two poses — shortest-arc rotation, linear elsewhere. */
export function lerpPose(a: RegionPose, b: RegionPose, t: number): RegionPose {
  const aY = a.scaleY ?? null;
  const bY = b.scaleY ?? null;
  const pa = a.perspective ?? null;
  const pb = b.perspective ?? null;
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    scale: a.scale + (b.scale - a.scale) * t,
    scaleY: aY == null && bY == null ? null : (aY ?? a.scale) + ((bY ?? b.scale) - (aY ?? a.scale)) * t,
    rotation: lerpAngle(a.rotation, b.rotation, t),
    skew: (a.skew ?? 0) + ((b.skew ?? 0) - (a.skew ?? 0)) * t,
    perspective:
      pa == null && pb == null
        ? null
        : { x: (pa?.x ?? 0) + ((pb?.x ?? 0) - (pa?.x ?? 0)) * t, y: (pa?.y ?? 0) + ((pb?.y ?? 0) - (pa?.y ?? 0)) * t },
  };
}

/** Shortest signed rotation a→b, degrees. */
export function shortestArc(a: number, b: number): number {
  let d = ((b - a + 180) % 360) - 180;
  if (d < -180) d += 360;
  return d;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + shortestArc(a, b) * t;
}
