import type { LatticeSpec, MeshData } from "../schema/world";
import { identity4, transformPoint, type Mat4, type V3 } from "./math";

/**
 * LATTICE — Blender's soft deform: a coarse cage of points around a shape;
 * move the cage's points and the shape inside bends with them, smoothly, no
 * matter how many points the shape has. The classic squash, bulge and lean.
 *
 * The cage is a mesh whose points are a regular grid (`LatticeSpec`, x
 * fastest, then y, then z) — edited with the same edit mode as any mesh.
 * What deforms the shape is how far each cage point has moved from its REST
 * place in the grid: every shape point takes the blend of its neighbouring
 * points' moves, by its place in the grid. So an untouched cage changes
 * nothing, and moving the whole cage changes nothing either — only reshaping
 * it does (as in Blender).
 *
 * Two blends, Blender's two: `smooth` (a uniform cubic B-spline — soft,
 * never overshooting, a point moves a little less than the cage point it
 * follows) and `linear` (trilinear — the shape follows the cage's straight
 * cells exactly). Points outside the cage take the move of its nearest face.
 */

export function latticeIndex(spec: LatticeSpec, i: number, j: number, k: number): number {
  return i + spec.u * (j + spec.v * k);
}

/** Where grid point (i, j, k) stands at rest, in the cage's own space. */
export function latticeRest(spec: LatticeSpec, i: number, j: number, k: number): V3 {
  const [sx, sy, sz] = spec.size;
  return [-sx / 2 + (sx * i) / (spec.u - 1), -sy / 2 + (sy * j) / (spec.v - 1), -sz / 2 + (sz * k) / (spec.w - 1)];
}

/** The cage itself, at rest: its points, and every grid edge as a loose line (no faces — a cage is not a surface). */
export function latticeMesh(spec: LatticeSpec): MeshData {
  const positions: number[] = [];
  const lines: number[] = [];
  for (let k = 0; k < spec.w; k++) {
    for (let j = 0; j < spec.v; j++) {
      for (let i = 0; i < spec.u; i++) {
        positions.push(...latticeRest(spec, i, j, k));
        const at = latticeIndex(spec, i, j, k);
        if (i + 1 < spec.u) lines.push(at, latticeIndex(spec, i + 1, j, k));
        if (j + 1 < spec.v) lines.push(at, latticeIndex(spec, i, j + 1, k));
        if (k + 1 < spec.w) lines.push(at, latticeIndex(spec, i, j, k + 1));
      }
    }
  }
  return { positions, faces: [], lines };
}

/** One axis: the grid points that touch parameter `t` (0..n-1) and their weights. */
function axisWeights(t: number, n: number, smooth: boolean): Array<[number, number]> {
  const c = Math.min(n - 1, Math.max(0, t));
  const i0 = Math.min(n - 2, Math.floor(c));
  const f = c - i0;
  if (!smooth) return [[i0, 1 - f], [i0 + 1, f]];
  // Uniform cubic B-spline over i0-1 … i0+2, the ends clamped (repeated).
  const f2 = f * f, f3 = f2 * f;
  const w = [(1 - f) ** 3 / 6, (3 * f3 - 6 * f2 + 4) / 6, (-3 * f3 + 3 * f2 + 3 * f + 1) / 6, f3 / 6];
  const clampI = (i: number) => Math.min(n - 1, Math.max(0, i));
  return [[clampI(i0 - 1), w[0]!], [i0, w[1]!], [i0 + 1, w[2]!], [clampI(i0 + 2), w[3]!]];
}

/**
 * Deform `mesh` (in its own space) by a cage. `cage` is the cage's points now
 * (its own space), `toCage` maps the shape's space into the cage's, and
 * `strength` scales the move (key it to press the deform in).
 */
export function latticeDeform(
  mesh: MeshData,
  cage: readonly number[],
  spec: LatticeSpec,
  toCage: Mat4,
  fromCage: Mat4,
  smooth: boolean,
  strength: number,
): MeshData {
  const count = spec.u * spec.v * spec.w;
  if (cage.length !== count * 3 || strength === 0) return mesh;
  // How far each cage point has moved from rest.
  const d = new Float64Array(count * 3);
  let moved = false;
  for (let k = 0; k < spec.w; k++) for (let j = 0; j < spec.v; j++) for (let i = 0; i < spec.u; i++) {
    const at = latticeIndex(spec, i, j, k);
    const r = latticeRest(spec, i, j, k);
    for (let a = 0; a < 3; a++) {
      const m = cage[at * 3 + a]! - r[a]!;
      d[at * 3 + a] = m;
      if (Math.abs(m) > 1e-9) moved = true;
    }
  }
  if (!moved) return mesh;
  const [sx, sy, sz] = spec.size;
  const P = mesh.positions;
  const out = P.slice();
  for (let p = 0; p < P.length; p += 3) {
    const q = transformPoint(toCage, [P[p]!, P[p + 1]!, P[p + 2]!]);
    const wx = axisWeights(((q[0] + sx / 2) / sx) * (spec.u - 1), spec.u, smooth);
    const wy = axisWeights(((q[1] + sy / 2) / sy) * (spec.v - 1), spec.v, smooth);
    const wz = axisWeights(((q[2] + sz / 2) / sz) * (spec.w - 1), spec.w, smooth);
    let mx = 0, my = 0, mz = 0;
    for (const [k, gz] of wz) for (const [j, gy] of wy) {
      const gyz = gy * gz;
      if (!gyz) continue;
      for (const [i, gx] of wx) {
        const g = gx * gyz;
        if (!g) continue;
        const at = latticeIndex(spec, i, j, k) * 3;
        mx += d[at]! * g;
        my += d[at + 1]! * g;
        mz += d[at + 2]! * g;
      }
    }
    const r = transformPoint(fromCage, [q[0] + mx * strength, q[1] + my * strength, q[2] + mz * strength]);
    out[p] = r[0];
    out[p + 1] = r[1];
    out[p + 2] = r[2];
  }
  return { ...mesh, positions: out };
}

/**
 * The cage at a new resolution, KEEPING ITS SHAPE: each new point takes the
 * old cage's move at its place (linear, so the old points' own moves are
 * reproduced exactly where the grids share points). Blender resets a lattice
 * whose resolution changes; a cage you have shaped should not lose it. A grid
 * that no longer matches its spec comes back at rest.
 */
export function resampleLattice(from: LatticeSpec, points: readonly number[], to: LatticeSpec): MeshData {
  const rest = latticeMesh(to);
  if (points.length !== from.u * from.v * from.w * 3) return rest;
  const I = identity4();
  return { ...rest, positions: latticeDeform(rest, points, from, I, I, false, 1).positions };
}
