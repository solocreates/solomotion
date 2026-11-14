import type { Contour, MeshData, MeshShapeDelta, PathPoint, PathShapeDelta, ShapeDelta, ShapeKey, Subpath } from "../schema";

/**
 * DELTA ARITHMETIC — reading, writing and combining the two stored delta arms
 * (see `schema/shape-keys.ts` for the exact format). Pure; no clip, no time.
 */

/** Numbers per anchor in a path delta: dx, dy, dInX, dInY, dOutX, dOutY. */
export const PATH_STRIDE = 6;

/** Below this a mesh delta component is noise (positions are quantised to 1e-4). */
export const MESH_EPS = 5e-5;
/** Below this a path delta component is noise. */
export const PATH_EPS = 1e-9;

export function emptyDelta(kind: ShapeDelta["kind"]): ShapeDelta {
  return kind === "path" ? { kind: "path", contours: {} } : { kind: "mesh", verts: [], xyz: [] };
}

/** Deep copy (a key's delta is never shared between two keys). */
export function copyDelta(d: ShapeDelta): ShapeDelta {
  if (d.kind === "path") {
    const contours: Record<string, number[]> = {};
    for (const [id, run] of Object.entries(d.contours)) contours[id] = run.slice();
    return { kind: "path", contours };
  }
  return { kind: "mesh", verts: d.verts.slice(), xyz: d.xyz.slice() };
}

// ── Path ─────────────────────────────────────────────────────────────────────

/** A handle as an offset from its anchor (a missing handle sits ON the anchor). */
export function handleOffset(p: PathPoint, side: "hIn" | "hOut"): [number, number] {
  const h = p[side];
  return h ? [h.x - p.x, h.y - p.y] : [0, 0];
}

/** The six numbers that turn `base` into `target` (same anchor). */
function pointDelta(base: PathPoint, target: PathPoint, out: number[]): void {
  const [bix, biy] = handleOffset(base, "hIn");
  const [box, boy] = handleOffset(base, "hOut");
  const [tix, tiy] = handleOffset(target, "hIn");
  const [tox, toy] = handleOffset(target, "hOut");
  out.push(target.x - base.x, target.y - base.y, tix - bix, tiy - biy, tox - box, toy - boy);
}

const isZeroRun = (run: readonly number[], eps: number) => run.every((v) => Math.abs(v) <= eps);

/**
 * The delta that turns `base` into `target` — contours matched by id, else by
 * position; points by index (a key is the SAME topology drawn elsewhere).
 * All-zero contours are left out (zero is the default).
 */
export function pathDeltaBetween(base: ReadonlyArray<Subpath>, target: ReadonlyArray<Contour & { id?: string }>): PathShapeDelta {
  const contours: Record<string, number[]> = {};
  base.forEach((b, s) => {
    const t = target.find((c) => c.id === b.id) ?? target[s];
    if (!t) return;
    const run: number[] = [];
    for (let i = 0; i < b.points.length; i++) {
      const tp = t.points[i];
      if (!tp) run.push(0, 0, 0, 0, 0, 0);
      else pointDelta(b.points[i]!, tp, run);
    }
    if (!isZeroRun(run, PATH_EPS)) contours[b.id] = run;
  });
  return { kind: "path", contours };
}

/** Add `scale · d` into `acc` (path), contour by contour. */
export function accumulatePath(acc: Record<string, number[]>, d: PathShapeDelta, scale: number): void {
  for (const [id, run] of Object.entries(d.contours)) {
    const into = (acc[id] ??= []);
    for (let i = 0; i < run.length; i++) into[i] = (into[i] ?? 0) + scale * run[i]!;
  }
}

// ── Mesh ─────────────────────────────────────────────────────────────────────

/** The sparse delta that turns `base` positions into `target` positions. */
export function meshDeltaBetween(base: ArrayLike<number>, target: ArrayLike<number>): MeshShapeDelta {
  const verts: number[] = [];
  const xyz: number[] = [];
  const n = Math.min(base.length, target.length) / 3;
  for (let v = 0; v < n; v++) {
    const dx = target[v * 3]! - base[v * 3]!;
    const dy = target[v * 3 + 1]! - base[v * 3 + 1]!;
    const dz = target[v * 3 + 2]! - base[v * 3 + 2]!;
    if (Math.abs(dx) <= MESH_EPS && Math.abs(dy) <= MESH_EPS && Math.abs(dz) <= MESH_EPS) continue;
    verts.push(v);
    xyz.push(dx, dy, dz);
  }
  return { kind: "mesh", verts, xyz };
}

/** Add `scale · d` into a dense xyz accumulator (length 3·vertexCount). Out-of-range vertices are ignored. */
export function accumulateMesh(acc: Float64Array | number[], d: MeshShapeDelta, scale: number): void {
  const n = acc.length / 3;
  for (let k = 0; k < d.verts.length; k++) {
    const v = d.verts[k]!;
    if (v >= n) continue;
    acc[v * 3] = (acc[v * 3] ?? 0) + scale * (d.xyz[k * 3] ?? 0);
    acc[v * 3 + 1] = (acc[v * 3 + 1] ?? 0) + scale * (d.xyz[k * 3 + 1] ?? 0);
    acc[v * 3 + 2] = (acc[v * 3 + 2] ?? 0) + scale * (d.xyz[k * 3 + 2] ?? 0);
  }
}

/** A dense xyz run back to the sparse stored form. */
export function sparsifyMesh(dense: ArrayLike<number>): MeshShapeDelta {
  const zero = new Float64Array(dense.length);
  return meshDeltaBetween(zero, dense);
}

/** `a + scale · b` as a new delta of a's kind (mismatched kinds return a copy of a). */
export function addDelta(a: ShapeDelta, b: ShapeDelta, scale = 1): ShapeDelta {
  if (a.kind === "path" && b.kind === "path") {
    const out = copyDelta(a) as PathShapeDelta;
    accumulatePath(out.contours, b, scale);
    for (const [id, run] of Object.entries(out.contours)) if (isZeroRun(run, PATH_EPS)) delete out.contours[id];
    return out;
  }
  if (a.kind === "mesh" && b.kind === "mesh") {
    let n = 0;
    for (const v of a.verts) n = Math.max(n, v + 1);
    for (const v of b.verts) n = Math.max(n, v + 1);
    const dense = new Float64Array(n * 3);
    accumulateMesh(dense, a, 1);
    accumulateMesh(dense, b, scale);
    return sparsifyMesh(dense);
  }
  return copyDelta(a);
}

/** The keys a key is drawn on top of, itself first — stops at a missing id or a cycle (never hangs). */
export function keyChain(keys: ReadonlyArray<ShapeKey>, id: string | undefined): ShapeKey[] {
  const out: ShapeKey[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const k = keys.find((x) => x.id === cur);
    if (!k) break;
    out.push(k);
    cur = k.relativeTo;
  }
  return out;
}

/** A key's stored delta, or null for a key whose shape lives in an asset. */
export function deltaOf(key: ShapeKey): ShapeDelta | null {
  return key.source.kind === "delta" ? key.source.delta : null;
}

/** The summed delta of a key's whole chain — its ABSOLUTE shape minus the base. Null id = the base (empty). */
export function chainDelta(keys: ReadonlyArray<ShapeKey>, id: string | undefined, kind: ShapeDelta["kind"]): ShapeDelta {
  let acc = emptyDelta(kind);
  for (const k of keyChain(keys, id)) {
    const d = deltaOf(k);
    if (d) acc = addDelta(acc, d);
  }
  return acc;
}

/** Would pointing `id` at `ref` close a loop? */
export function shapeKeyWouldCycle(keys: ReadonlyArray<ShapeKey>, id: string, ref: string | undefined): boolean {
  if (!ref) return false;
  if (ref === id) return true;
  return keyChain(keys, ref).some((k) => k.id === id || k.relativeTo === id);
}

/** Positions as a plain array (copy). */
export function positionsOf(mesh: MeshData): number[] {
  return mesh.positions.slice();
}
