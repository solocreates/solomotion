import type { MeshData } from "../schema/world";
import { faceNormal, triangulateFace, vertexCount } from "./mesh";
import { type V3 } from "./math";

/**
 * SHRINKWRAP — every point of a shape moves onto the nearest point of another
 * surface (plus an `offset` along that surface's normal): a decal hugging a
 * sphere, a text wrapped onto a bottle, a flat logo pressed onto a curved
 * screen. Exact nearest points (Ericson's closest point on a triangle), found
 * through a uniform grid over the target's triangles so a few thousand points
 * against a few thousand triangles stays interactive.
 */

interface Tri {
  a: V3;
  b: V3;
  c: V3;
  n: V3;
}

/** Closest point on triangle abc to p (Real-Time Collision Detection, 5.1.5). */
function closestOnTri(p: V3, a: V3, b: V3, c: V3): V3 {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: V3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const d = (x: V3, y: V3) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];
  const d1 = d(ab, ap), d2 = d(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp: V3 = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
  const d3 = d(ab, bp), d4 = d(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp: V3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
  const d5 = d(ab, cp), d6 = d(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom, w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

/** The target's triangles bucketed into a grid — built once per target (cached by identity). */
class TriGrid {
  readonly tris: Tri[] = [];
  private readonly cells = new Map<string, number[]>();
  readonly size: number;
  readonly min: V3 = [Infinity, Infinity, Infinity];

  constructor(target: MeshData) {
    const P = target.positions;
    const at = (i: number): V3 => [P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!];
    for (const f of target.faces) {
      const n = faceNormal(target, f);
      const t = triangulateFace(target, f);
      for (let i = 0; i < t.length; i += 3) this.tris.push({ a: at(t[i]!), b: at(t[i + 1]!), c: at(t[i + 2]!), n });
    }
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vertexCount(target); i++) {
      for (let k = 0; k < 3; k++) {
        this.min[k] = Math.min(this.min[k]!, P[i * 3 + k]!);
        max[k] = Math.max(max[k]!, P[i * 3 + k]!);
      }
    }
    const span = Math.max(1e-6, max[0] - this.min[0], max[1] - this.min[1], max[2] - this.min[2]);
    this.size = span / Math.max(4, Math.cbrt(this.tris.length) * 2);
    this.tris.forEach((t, i) => {
      const lo = [0, 1, 2].map((k) => Math.floor((Math.min(t.a[k]!, t.b[k]!, t.c[k]!) - this.min[k]!) / this.size));
      const hi = [0, 1, 2].map((k) => Math.floor((Math.max(t.a[k]!, t.b[k]!, t.c[k]!) - this.min[k]!) / this.size));
      for (let x = lo[0]!; x <= hi[0]!; x++) for (let y = lo[1]!; y <= hi[1]!; y++) for (let z = lo[2]!; z <= hi[2]!; z++) {
        const key = `${x},${y},${z}`;
        const list = this.cells.get(key);
        if (list) list.push(i);
        else this.cells.set(key, [i]);
      }
    });
  }

  /** The nearest surface point and its triangle's normal — searching outward ring by ring. */
  nearest(p: V3): { q: V3; n: V3 } | null {
    const c = [0, 1, 2].map((k) => Math.floor((p[k]! - this.min[k]!) / this.size));
    let best = null as { q: V3; n: V3; d: number } | null;
    const seen = new Set<number>();
    for (let ring = 0; ring < 64; ring++) {
      for (let x = c[0]! - ring; x <= c[0]! + ring; x++) {
        for (let y = c[1]! - ring; y <= c[1]! + ring; y++) {
          for (let z = c[2]! - ring; z <= c[2]! + ring; z++) {
            if (Math.max(Math.abs(x - c[0]!), Math.abs(y - c[1]!), Math.abs(z - c[2]!)) !== ring) continue;
            for (const i of this.cells.get(`${x},${y},${z}`) ?? []) {
              if (seen.has(i)) continue;
              seen.add(i);
              const t = this.tris[i]!;
              const q = closestOnTri(p, t.a, t.b, t.c);
              const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
              if (!best || d < best.d) best = { q, n: t.n, d };
            }
          }
        }
      }
      // Once something is found, one more ring guarantees it is the nearest.
      if (best && Math.sqrt(best.d) < ring * this.size) break;
      if (seen.size === this.tris.length) break;
    }
    return best ? { q: best.q, n: best.n } : null;
  }
}

const grids = new WeakMap<MeshData, TriGrid>();

/** Move every point of `mesh` onto `target` (both in the shape's own space), then `offset` out along the surface. */
export function shrinkwrapMesh(mesh: MeshData, target: MeshData, offset: number, strength = 1): MeshData {
  if (!target.faces.length) return mesh;
  let grid = grids.get(target);
  if (!grid) grids.set(target, (grid = new TriGrid(target)));
  const P = mesh.positions;
  const out = P.slice();
  for (let i = 0; i < P.length; i += 3) {
    const p: V3 = [P[i]!, P[i + 1]!, P[i + 2]!];
    const hit = grid.nearest(p);
    if (!hit) continue;
    for (let k = 0; k < 3; k++) out[i + k] = p[k]! + (hit.q[k]! + hit.n[k]! * offset - p[k]!) * strength;
  }
  return { ...mesh, positions: out };
}
