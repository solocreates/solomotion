import type { MeshData } from "../schema/world";
import { faceNormal, hasUv, triangulateFace, vertexCount } from "./mesh";
import { cross, normalize3, type V3 } from "./math";

/**
 * SCATTER — copies of one shape spread over another's surface: stars on a
 * planet, confetti on a title, rivets on a plate, grass on a hill. Blender's
 * "distribute points on faces + instance on points", as one card.
 *
 * Points are spread by AREA (a big face gets more copies than a small one)
 * from a seeded random, so the same seed is the same scatter on every frame —
 * key Count and copies appear one by one, in a fixed order. Each copy can
 * stand along the surface (its +Z on the face normal), turn and vary in size.
 * On a picture's body each copy wears the picture's colour where it landed.
 */
export interface ScatterOptions {
  count: number;
  /** Multiplies the copy's own size. */
  size: number;
  /** 0 = all the same size, 1 = anywhere from nothing to full size. */
  sizeRandom: number;
  /** 0 = all facing one way, 1 = any turn (about the normal when standing). */
  turnRandom: number;
  /** Stand each copy along the surface normal. */
  align: boolean;
  /** Lift off the surface along its normal. */
  offset: number;
  seed: number;
  /** Keep the surface itself (off: only the copies). */
  keep: boolean;
}

/** Most vertices a scatter may make — beyond it, fewer copies. */
const VERTEX_BUDGET = 250_000;

function rand(seed: number, i: number, k: number): number {
  let h = Math.imul(seed + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35) ^ Math.imul(k + 13, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function scatterOver(surface: MeshData, item: MeshData, o: ScatterOptions): MeshData {
  const P = surface.positions;
  const tris: Array<{ a: number; b: number; c: number; n: V3 }> = [];
  const cum: number[] = [];
  let total = 0;
  for (const f of surface.faces) {
    const n = faceNormal(surface, f);
    const t = triangulateFace(surface, f);
    for (let i = 0; i < t.length; i += 3) {
      const a = t[i]!, b = t[i + 1]!, c = t[i + 2]!;
      const ab: V3 = [P[b * 3]! - P[a * 3]!, P[b * 3 + 1]! - P[a * 3 + 1]!, P[b * 3 + 2]! - P[a * 3 + 2]!];
      const ac: V3 = [P[c * 3]! - P[a * 3]!, P[c * 3 + 1]! - P[a * 3 + 1]!, P[c * 3 + 2]! - P[a * 3 + 2]!];
      const x = cross(ab, ac);
      const area = Math.hypot(x[0], x[1], x[2]) / 2;
      if (area <= 1e-12) continue;
      total += area;
      tris.push({ a, b, c, n });
      cum.push(total);
    }
  }
  const itemVerts = vertexCount(item);
  const count = Math.max(0, Math.min(Math.floor(o.count), itemVerts > 0 ? Math.floor(VERTEX_BUDGET / itemVerts) : 0));
  if (!tris.length || !count) return o.keep ? surface : { positions: [], faces: [] };

  const keepVerts = o.keep ? vertexCount(surface) : 0;
  const positions: number[] = o.keep ? surface.positions.slice() : [];
  const faces: number[][] = o.keep ? surface.faces.map((f) => f.slice()) : [];
  const withUv = hasUv(surface);
  const uv: number[] | null = withUv ? (o.keep ? surface.uv!.slice() : []) : null;
  const parts: string[] | null = surface.faceParts ? (o.keep ? surface.faceParts.slice() : []) : null;
  const IP = item.positions;

  for (let i = 0; i < count; i++) {
    // Where: a triangle chosen by area, a point inside it uniformly.
    const r = rand(o.seed, i, 0) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo]!;
    let u = rand(o.seed, i, 1), v = rand(o.seed, i, 2);
    if (u + v > 1) (u = 1 - u), (v = 1 - v);
    const w = 1 - u - v;
    const at = (k: number) => P[t.a * 3 + k]! * w + P[t.b * 3 + k]! * u + P[t.c * 3 + k]! * v;
    const n = t.n;
    const p: V3 = [at(0) + n[0] * o.offset, at(1) + n[1] * o.offset, at(2) + n[2] * o.offset];

    // How it stands: +Z on the normal (or as it was), turned, sized.
    const spin = (rand(o.seed, i, 3) - 0.5) * 2 * Math.PI * o.turnRandom;
    let X: V3, Y: V3, Z: V3;
    if (o.align) {
      Z = n;
      const ref: V3 = Math.abs(Z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
      const x0 = normalize3(cross(ref, Z));
      const y0 = cross(Z, x0);
      const cs = Math.cos(spin), sn = Math.sin(spin);
      X = [x0[0] * cs + y0[0] * sn, x0[1] * cs + y0[1] * sn, x0[2] * cs + y0[2] * sn];
      Y = cross(Z, X);
    } else {
      // Free: a random orientation, as much of it as turnRandom allows.
      const a1 = spin, a2 = (rand(o.seed, i, 4) - 0.5) * 2 * Math.PI * o.turnRandom, a3 = (rand(o.seed, i, 5) - 0.5) * 2 * Math.PI * o.turnRandom;
      const [c1, s1, c2, s2, c3, s3] = [Math.cos(a1), Math.sin(a1), Math.cos(a2), Math.sin(a2), Math.cos(a3), Math.sin(a3)];
      X = [c1 * c2, s1 * c2, -s2];
      Y = [c1 * s2 * s3 - s1 * c3, s1 * s2 * s3 + c1 * c3, c2 * s3];
      Z = cross(X, Y);
    }
    const s = o.size * (1 - o.sizeRandom * rand(o.seed, i, 6));

    const base = positions.length / 3;
    for (let k = 0; k < IP.length; k += 3) {
      const lx = IP[k]! * s, ly = IP[k + 1]! * s, lz = IP[k + 2]! * s;
      positions.push(p[0] + X[0] * lx + Y[0] * ly + Z[0] * lz, p[1] + X[1] * lx + Y[1] * ly + Z[1] * lz, p[2] + X[2] * lx + Y[2] * ly + Z[2] * lz);
    }
    for (const f of item.faces) faces.push(f.map((x) => x + base));
    if (uv) {
      // The copy wears the surface's picture where it landed.
      const su = surface.uv!;
      const U = su[t.a * 2]! * w + su[t.b * 2]! * u + su[t.c * 2]! * v;
      const V = su[t.a * 2 + 1]! * w + su[t.b * 2 + 1]! * u + su[t.c * 2 + 1]! * v;
      for (let k = 0; k < itemVerts; k++) uv.push(U, V);
    }
    if (parts) for (let k = 0; k < item.faces.length; k++) parts.push("");
  }
  const out: MeshData = { positions, faces };
  if (uv) out.uv = uv;
  if (parts) out.faceParts = parts;
  return out;
}
