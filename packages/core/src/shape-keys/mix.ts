import type { MeshData, PathPoint, ShapeKey, Subpath } from "../schema";
import { accumulateMesh, accumulatePath, chainDelta, deltaOf, PATH_STRIDE } from "./delta";
import { keyPath } from "./fields";

/**
 * THE MIX — `shape = base + Σ wᵢ · Δᵢ`, one function per geometry arm, each
 * memoised so a still weight set hands back the SAME array (pictures, buffers
 * and Path2D caches key on identity), and an all-zero set hands back the base
 * itself.
 */

/** A key's weight now: its sampled `key.<id>` keyframe, else its resting value. */
export function shapeKeyWeight(key: ShapeKey, sampled: Readonly<Record<string, unknown>> | undefined): number {
  const s = sampled?.[keyPath(key.id)];
  const w = typeof s === "number" ? s : (key.value ?? 0);
  return Number.isFinite(w) ? w : 0;
}

export interface MixTerm {
  key: ShapeKey;
  weight: number;
}

/** The keys that move the shape now: unmuted, non-zero, of the given source kind. */
export function mixTerms(keys: ReadonlyArray<ShapeKey> | undefined, sampled: Readonly<Record<string, unknown>> | undefined, source: "delta" | "asset" = "delta"): MixTerm[] {
  const out: MixTerm[] = [];
  for (const key of keys ?? []) {
    if (key.mute || key.source.kind !== source) continue;
    const weight = shapeKeyWeight(key, sampled);
    if (weight !== 0) out.push({ key, weight });
  }
  return out;
}

/** A stable string for a weight set — what geometry caches add to their key. "" = the base. */
export function mixSignature(terms: ReadonlyArray<MixTerm>): string {
  return terms.map((t) => `${t.key.id}=${t.weight}`).join(",");
}

// ── Path ─────────────────────────────────────────────────────────────────────

/** Apply a summed per-contour delta to subpaths (new arrays; ids kept). */
export function applyPathOffsets(base: ReadonlyArray<Subpath>, sum: Record<string, number[]>): Subpath[] {
  return base.map((sub) => {
    const run = sum[sub.id];
    if (!run) return sub;
    return { ...sub, points: sub.points.map((p, i) => movePoint(p, run, i * PATH_STRIDE)) };
  });
}

function movePoint(p: PathPoint, run: readonly number[], o: number): PathPoint {
  const dx = run[o] ?? 0, dy = run[o + 1] ?? 0;
  const dix = run[o + 2] ?? 0, diy = run[o + 3] ?? 0;
  const dox = run[o + 4] ?? 0, doy = run[o + 5] ?? 0;
  const x = p.x + dx, y = p.y + dy;
  // A handle is its anchor's offset plus the key's; a corner stays a corner
  // unless the key itself grows the arm.
  const arm = (h: PathPoint["hIn"], ddx: number, ddy: number) =>
    h ? { x: x + (h.x - p.x) + ddx, y: y + (h.y - p.y) + ddy } : ddx !== 0 || ddy !== 0 ? { x: x + ddx, y: y + ddy } : null;
  return { ...p, x, y, hIn: arm(p.hIn, dix, diy), hOut: arm(p.hOut, dox, doy) };
}

/**
 * What a memo entry was built from, beyond its base object: the keys' SOURCES
 * (a topology edit or "Edit key" replaces them) and, for a path, every
 * contour's points array — so a base mutated in place outside an immutable
 * update (a headless script, a test) is never answered from a stale entry.
 */
function stamp(keys: ReadonlyArray<ShapeKey>, base?: ReadonlyArray<Subpath>): unknown[] {
  const s: unknown[] = keys.map((k) => k.source);
  if (base) for (const sub of base) s.push(sub, sub.points, sub.points.length);
  return s;
}

const sameStamp = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

const pathMemo = new WeakMap<ReadonlyArray<Subpath>, { stamp: unknown[]; sig: string; out: Subpath[] }>();

/**
 * A path's outline with its shape keys mixed in at these weights. Returns
 * `base` itself when nothing is weighted, and the same array for the same
 * (base, keys, weights) — so a still mouth never re-builds its picture.
 */
export function morphSubpaths(base: Subpath[], keys: ReadonlyArray<ShapeKey> | undefined, sampled: Readonly<Record<string, unknown>> | undefined): Subpath[] {
  if (!keys || keys.length === 0) return base;
  const terms = mixTerms(keys, sampled);
  if (terms.length === 0) return base;
  const sig = mixSignature(terms);
  const st = stamp(keys, base);
  const hit = pathMemo.get(base);
  if (hit && hit.sig === sig && sameStamp(hit.stamp, st)) return hit.out;
  const sum: Record<string, number[]> = {};
  for (const t of terms) {
    const d = deltaOf(t.key);
    if (d?.kind === "path") accumulatePath(sum, d, t.weight);
  }
  const out = applyPathOffsets(base, sum);
  pathMemo.set(base, { stamp: st, sig, out });
  return out;
}

/** A key's own ABSOLUTE outline (its chain at full strength, nothing else mixed) — what "Edit key" shows and edits. */
export function keyShapeSubpaths(base: ReadonlyArray<Subpath>, keys: ReadonlyArray<ShapeKey>, id: string | undefined): Subpath[] {
  const d = chainDelta(keys, id, "path");
  return applyPathOffsets(base, d.kind === "path" ? d.contours : {});
}

// ── Mesh ─────────────────────────────────────────────────────────────────────

const meshMemo = new WeakMap<MeshData, { stamp: unknown[]; sig: string; out: MeshData }>();

/** Positions plus a dense xyz offset (same length or shorter). */
function offsetMesh(base: MeshData, dense: ArrayLike<number>): MeshData {
  const positions = base.positions.slice();
  for (let i = 0; i < positions.length && i < dense.length; i++) positions[i] = positions[i]! + dense[i]!;
  return { ...base, positions };
}

/** A mesh with its shape keys mixed in. Same identity rules as `morphSubpaths`. */
export function morphMesh(base: MeshData, keys: ReadonlyArray<ShapeKey> | undefined, sampled: Readonly<Record<string, unknown>> | undefined): MeshData {
  if (!keys || keys.length === 0) return base;
  const terms = mixTerms(keys, sampled);
  if (terms.length === 0) return base;
  const sig = mixSignature(terms);
  // Stamped by sources, not the keys array: a bake hands a fresh array of
  // shallow copies every frame, and a still weight set must still hit.
  const st = stamp(keys);
  st.push(base.positions);
  const hit = meshMemo.get(base);
  if (hit && hit.sig === sig && sameStamp(hit.stamp, st)) return hit.out;
  const dense = new Float64Array(base.positions.length);
  for (const t of terms) {
    const d = deltaOf(t.key);
    if (d?.kind === "mesh") accumulateMesh(dense, d, t.weight);
  }
  const out = offsetMesh(base, dense);
  meshMemo.set(base, { stamp: st, sig, out });
  return out;
}

/** A key's own ABSOLUTE mesh (its chain at full strength). */
export function keyShapeMesh(base: MeshData, keys: ReadonlyArray<ShapeKey>, id: string | undefined): MeshData {
  const d = chainDelta(keys, id, "mesh");
  if (d.kind !== "mesh" || d.verts.length === 0) return base;
  const dense = new Float64Array(base.positions.length);
  accumulateMesh(dense, d, 1);
  return offsetMesh(base, dense);
}
