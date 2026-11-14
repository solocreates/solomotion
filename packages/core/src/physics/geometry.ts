import type { PathCommand } from "../vector/geometry";
import { flattenCommands } from "../vector/polyline";

/**
 * A COLLIDER'S SHAPE, from an outline — the 2D geometry physics needs and
 * nothing more: an outline flattened and simplified, its convex hull, and its
 * cut into CONVEX pieces (a solver collides convex shapes; a star, a word or
 * an L is not one).
 *
 * The cut is ear-clipping, then Hertel–Mehlhorn: drop every diagonal whose
 * removal leaves both sides convex. Never more than four times the fewest
 * pieces possible, linear-ish in practice, and with no dependency. Holes are
 * filled: a falling "O" is a solid disc, which is what a rigid body of it is.
 */

export type P2 = readonly [number, number];

/** Twice the signed area: + is counter-clockwise in a y-up frame (clockwise on a y-down screen). */
export function signedArea2(poly: readonly P2[]): number {
  let a = 0;
  // Σ over edges j→i of (x_j − x_i)(y_j + y_i) — the trapezoid rule, +2A for a counter-clockwise ring.
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]![0] - poly[i]![0]) * (poly[j]![1] + poly[i]![1]);
  return a;
}

/** The outer contours of an outline, flattened, simplified and wound counter-clockwise (+ area). */
export function outlinePolygons(cmds: readonly PathCommand[], size: number): P2[][] {
  const tol = Math.max(0.25, size * 0.004);
  const polys = flattenCommands(cmds, tol)
    .filter((pl) => pl.closed && pl.pts.length >= 3)
    .map((pl) => {
      const pts = pl.pts.map((p) => [p.x, p.y] as P2);
      // A closed polyline repeats its first point last.
      if (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
      return simplify(pts, Math.max(0.5, size * 0.01));
    })
    .filter((p) => p.length >= 3 && Math.abs(signedArea2(p)) > 1e-6);
  if (!polys.length) return [];
  // Holes sit inside a larger contour of the other winding; a rigid body fills them.
  const byArea = polys.map((p) => ({ p, a: signedArea2(p) })).sort((x, y) => Math.abs(y.a) - Math.abs(x.a));
  const outer: P2[][] = [];
  for (const { p } of byArea) {
    if (outer.some((o) => pointInPolygon(p[0]!, o))) continue;
    outer.push(signedArea2(p) < 0 ? p.slice().reverse() : p);
  }
  return outer;
}

/**
 * An outline's LINE as a wall, not its fill: every contour, open or closed,
 * holes included, cut into one quad per segment, `width` thick and centred
 * on the line. A ring holds what is inside it, a drawn line is a ramp, an
 * "O" is two walls. Each quad runs half a width past its ends so neighbours
 * overlap at the joints and nothing slips between them. Counter-clockwise.
 */
export function edgeQuads(cmds: readonly PathCommand[], size: number, width: number): P2[][] {
  const tol = Math.max(0.25, size * 0.002);
  const half = Math.max(1, width / 2);
  const out: P2[][] = [];
  for (const pl of flattenCommands(cmds, tol)) {
    let pts = pl.pts.map((p) => [p.x, p.y] as P2);
    // Finer than a fill's simplification: a ball rolls along this line, and a coarse ring rolls bumpy.
    const eps = Math.max(0.5, size * 0.0015);
    if (pl.closed) {
      if (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
      pts = simplify(pts, eps, 96);
      if (pts.length >= 2) pts.push(pts[0]!);
    } else pts = simplifyOpen(pts, eps, 96);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i]!, [bx, by] = pts[i + 1]!;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const dx = ((bx - ax) / len) * half, dy = ((by - ay) / len) * half;
      const quad: P2[] = [
        [ax - dx + dy, ay - dy - dx],
        [bx + dx + dy, by + dy - dx],
        [bx + dx - dy, by + dy + dx],
        [ax - dx - dy, ay - dy + dx],
      ];
      out.push(signedArea2(quad) < 0 ? quad.reverse() : quad);
    }
  }
  return out;
}

/** Ramer–Douglas–Peucker on an open polyline (both ends kept), then at most `max` points. */
function simplifyOpen(pts: P2[], eps: number, max: number): P2[] {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const rdp = (i: number, j: number) => {
    const p = pts[i]!, q = pts[j]!;
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let far = -1, fd = eps;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k]![0] - p[0]) * dy - (pts[k]![1] - p[1]) * dx) / len;
      if (d > fd) (fd = d), (far = k);
    }
    if (far < 0) return;
    keep[far] = 1;
    rdp(i, far);
    rdp(far, j);
  };
  rdp(0, pts.length - 1);
  const out = pts.filter((_, i) => keep[i]);
  if (out.length <= max) return out;
  const step = Math.ceil(out.length / max);
  return out.filter((_, i) => i % step === 0 || i === out.length - 1);
}

/** Ramer–Douglas–Peucker on a closed ring, then at most `max` points. */
function simplify(pts: P2[], eps: number, max = 64): P2[] {
  if (pts.length <= 8) return pts;
  const keep = new Uint8Array(pts.length);
  // Split the ring at its two farthest-apart points.
  let a = 0, b = 0, best = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = (pts[i]![0] - pts[0]![0]) ** 2 + (pts[i]![1] - pts[0]![1]) ** 2;
    if (d > best) (best = d), (b = i);
  }
  keep[a] = keep[b] = 1;
  const rdp = (i: number, j: number) => {
    // Indices on the ring from i to j (exclusive), forward.
    const n = (j - i + pts.length) % pts.length;
    if (n < 2) return;
    const p = pts[i]!, q = pts[j]!;
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    let far = -1, fd = eps;
    for (let k = 1; k < n; k++) {
      const m = (i + k) % pts.length;
      const d = Math.abs((pts[m]![0] - p[0]) * dy - (pts[m]![1] - p[1]) * dx) / len;
      if (d > fd) (fd = d), (far = m);
    }
    if (far < 0) return;
    keep[far] = 1;
    rdp(i, far);
    rdp(far, j);
  };
  rdp(a, b);
  rdp(b, a);
  let out = pts.filter((_, i) => keep[i]);
  if (out.length > max) out = out.filter((_, i) => i % Math.ceil(out.length / max) === 0);
  return out.length >= 3 ? out : pts;
}

function pointInPolygon(p: P2, poly: readonly P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** The convex hull, counter-clockwise (monotone chain). */
export function convexHull(points: readonly P2[]): P2[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const isConvexCorner = (a: P2, b: P2, c: P2) => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) > 1e-9;

/** Is a counter-clockwise polygon convex? */
export function isConvex(poly: readonly P2[]): boolean {
  for (let i = 0; i < poly.length; i++) {
    if (!isConvexCorner(poly[(i + poly.length - 1) % poly.length]!, poly[i]!, poly[(i + 1) % poly.length]!)) {
      // Collinear points are not a dent.
      const a = poly[(i + poly.length - 1) % poly.length]!, b = poly[i]!, c = poly[(i + 1) % poly.length]!;
      if (Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) > 1e-9) return false;
    }
  }
  return true;
}

/** Ear-clip a simple counter-clockwise polygon into triangles (vertex indices). */
export function triangulate(poly: readonly P2[]): Array<[number, number, number]> {
  const idx = poly.map((_, i) => i);
  const tris: Array<[number, number, number]> = [];
  let guard = poly.length * poly.length;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length]!, i1 = idx[k]!, i2 = idx[(k + 1) % idx.length]!;
      const a = poly[i0]!, b = poly[i1]!, c = poly[i2]!;
      if (!isConvexCorner(a, b, c)) continue;
      // No other remaining point inside the ear.
      let empty = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTriangle(poly[j]!, a, b, c)) {
          empty = false;
          break;
        }
      }
      if (!empty) continue;
      tris.push([i0, i1, i2]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    // A self-touching outline can leave no ear: give up on the rest rather than loop.
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([idx[0]!, idx[1]!, idx[2]!]);
  return tris;
}

function inTriangle(p: P2, a: P2, b: P2, c: P2): boolean {
  const s = (u: P2, v: P2, w: P2) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  return s(a, b, p) >= -1e-12 && s(b, c, p) >= -1e-12 && s(c, a, p) >= -1e-12;
}

/**
 * Cut a simple counter-clockwise polygon into convex pieces (Hertel–Mehlhorn
 * over an ear-clipped triangulation), at most `max` of them — past that the
 * smallest pieces merge into their hulls, a few dents traded for speed.
 */
export function convexPieces(poly: readonly P2[], max = 24): P2[][] {
  if (poly.length < 3) return [];
  if (isConvex(poly)) return [poly.slice()];
  // Pieces as index rings; start from triangles and merge across shared edges.
  let pieces: number[][] = triangulate(poly).map((t) => [...t]);
  if (!pieces.length) return [convexHull(poly)];
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const m = mergeAcross(pieces[i]!, pieces[j]!);
        if (m && isConvex(m.map((k) => poly[k]!))) {
          pieces[i] = m;
          pieces.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  let out = pieces.map((r) => r.map((k) => poly[k]!));
  if (out.length > max) {
    out.sort((a, b) => Math.abs(signedArea2(b)) - Math.abs(signedArea2(a)));
    const rest = out.slice(max - 1).flat();
    out = [...out.slice(0, max - 1), convexHull(rest)];
  }
  return out;
}

/** Two index rings sharing an edge, joined into one ring across it; null when they share none. */
function mergeAcross(a: number[], b: number[]): number[] | null {
  for (let i = 0; i < a.length; i++) {
    const u = a[i]!, v = a[(i + 1) % a.length]!;
    const j = b.indexOf(v);
    if (j < 0 || b[(j + 1) % b.length] !== u) continue;
    // a: … u v …   b: … v u …  → a up to u, then b from after u around to before v, then v onward.
    const out: number[] = [];
    for (let k = 0; k < a.length; k++) {
      const x = a[(i + 1 + k) % a.length]!; // starts at v
      out.push(x);
      if (x === u) break;
    }
    for (let k = 2; k < b.length; k++) out.push(b[(j + k) % b.length]!);
    return out;
  }
  return null;
}
