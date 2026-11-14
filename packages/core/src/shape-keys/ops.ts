import type { Clip, MeshClip, MeshData, PathClip, ShapeDelta, ShapeKey, Subpath } from "../schema";
import { createId } from "../ids";
import { addDelta, chainDelta, copyDelta, deltaOf, emptyDelta, meshDeltaBetween, pathDeltaBetween, shapeKeyWouldCycle } from "./delta";
import { keyPath, shapeKeysOf } from "./fields";
import { keyShapeMesh, keyShapeSubpaths, morphMesh, morphSubpaths } from "./mix";
import { mirrorName } from "../rig/sides";

/**
 * AUTHORING — every write to a clip's shape keys. Mutating (call inside a
 * document update); the web inspector, the stage's "Edit key" mode and the
 * agent verbs all go through here, so they cannot disagree.
 */

/** A clip that can hold delta keys: a path, or a mesh with its own polygons. */
export type KeyedClip = PathClip | (MeshClip & { geometry: { type: "mesh"; mesh: MeshData } });

export function canHoldShapeKeys(clip: Clip): clip is KeyedClip {
  return clip.kind === "path" || (clip.kind === "mesh" && clip.geometry.type === "mesh");
}

function deltaKind(clip: KeyedClip): ShapeDelta["kind"] {
  return clip.kind === "path" ? "path" : "mesh";
}

function uniqueName(keys: ReadonlyArray<ShapeKey>, want: string): string {
  const taken = new Set(keys.map((k) => k.name.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  for (let n = 2; ; n++) if (!taken.has(`${want} ${n}`.toLowerCase())) return `${want} ${n}`;
}

export interface NewShapeKey {
  name?: string;
  relativeTo?: string;
  /**
   * The ABSOLUTE shape the key should be (same topology as the base): what a
   * lattice, a modifier or a bone pose produced ("New key from current
   * shape"), or a drawn target. Absent = the reference shape (a zero delta).
   */
  shape?: Subpath[] | MeshData;
  value?: number;
}

/** Add a key. Null when the clip cannot hold one or `shape` does not match its topology. */
export function addShapeKey(clip: Clip, opts: NewShapeKey = {}): ShapeKey | null {
  if (!canHoldShapeKeys(clip)) return null;
  const keys = (clip.shapeKeys ??= []);
  const relativeTo = opts.relativeTo && keys.some((k) => k.id === opts.relativeTo) ? opts.relativeTo : undefined;
  let delta: ShapeDelta = emptyDelta(deltaKind(clip));
  if (opts.shape) {
    const d = deltaToShape(clip, relativeTo, opts.shape);
    if (!d) return null;
    delta = d;
  }
  const key: ShapeKey = {
    id: createId("sk"),
    name: uniqueName(keys, opts.name?.trim() || `Key ${keys.length + 1}`),
    ...(relativeTo && { relativeTo }),
    ...(opts.value !== undefined && { value: opts.value }),
    source: { kind: "delta", delta },
  };
  keys.push(key);
  return key;
}

/** A key standing for an imported model's own morph target (weights only — amendment 11). */
export function addAssetShapeKey(clip: MeshClip, target: number | string, name?: string): ShapeKey | null {
  if (clip.geometry.type !== "asset") return null;
  const keys = (clip.shapeKeys ??= []);
  const key: ShapeKey = { id: createId("sk"), name: uniqueName(keys, name || String(target)), source: { kind: "asset", target } };
  keys.push(key);
  return key;
}

/** The delta that makes a key, relative to `ref`, equal `shape` — null on a topology mismatch. */
function deltaToShape(clip: KeyedClip, ref: string | undefined, shape: Subpath[] | MeshData): ShapeDelta | null {
  const keys = clip.shapeKeys ?? [];
  if (clip.kind === "path") {
    if (!Array.isArray(shape)) return null;
    const refShape = keyShapeSubpaths(clip.subpaths, keys, ref);
    if (shape.length !== refShape.length || shape.some((s, i) => s.points.length !== refShape[i]!.points.length)) return null;
    return pathDeltaBetween(refShape, shape);
  }
  if (Array.isArray(shape)) return null;
  const refMesh = keyShapeMesh(clip.geometry.mesh, keys, ref);
  if (shape.positions.length !== refMesh.positions.length) return null;
  return meshDeltaBetween(refMesh.positions, shape.positions);
}

/** The mix as it stands (each key at its resting weight) — for "New key from mix". */
export function currentMix(clip: KeyedClip, sampled?: Readonly<Record<string, unknown>>): Subpath[] | MeshData {
  return clip.kind === "path" ? morphSubpaths(clip.subpaths, clip.shapeKeys, sampled) : morphMesh(clip.geometry.mesh, clip.shapeKeys, sampled);
}

/** A key's own absolute shape — what "Edit key" shows. Undefined id = the base. */
export function shapeOfKey(clip: KeyedClip, id: string | undefined): Subpath[] | MeshData {
  const keys = clip.shapeKeys ?? [];
  return clip.kind === "path" ? keyShapeSubpaths(clip.subpaths, keys, id) : keyShapeMesh(clip.geometry.mesh, keys, id);
}

/**
 * EDIT KEY — write a key's absolute shape (same topology). The key's delta is
 * re-derived against its reference, so the base and every other key stay put.
 */
export function setKeyShape(clip: Clip, id: string, shape: Subpath[] | MeshData): boolean {
  if (!canHoldShapeKeys(clip)) return false;
  const key = clip.shapeKeys?.find((k) => k.id === id);
  if (!key || key.source.kind !== "delta") return false;
  const d = deltaToShape(clip, key.relativeTo, shape);
  if (!d) return false;
  key.source = { kind: "delta", delta: d };
  return true;
}

/** Drop the key's tracks, drivers and modulators (what would otherwise address nothing). */
function forgetChannel(clip: Clip, id: string): void {
  const path = keyPath(id);
  clip.keyframes = clip.keyframes.filter((t) => t.property !== path);
  const c = clip as Clip & { drivers?: Record<string, string> };
  if (c.drivers && path in c.drivers) delete c.drivers[path];
  if (clip.modulators) clip.modulators = clip.modulators.filter((m) => m.target !== path);
}

/**
 * Remove a key. Keys drawn on top of it are re-pointed at ITS reference with
 * its delta folded in, so their absolute shapes do not move.
 */
export function removeShapeKey(clip: Clip, id: string): boolean {
  const keys = shapeKeysOf(clip);
  const gone = keys?.find((k) => k.id === id);
  if (!keys || !gone) return false;
  const goneDelta = deltaOf(gone);
  for (const k of keys) {
    if (k.relativeTo !== id) continue;
    const d = deltaOf(k);
    if (d && goneDelta) k.source = { kind: "delta", delta: addDelta(d, goneDelta) };
    if (gone.relativeTo) k.relativeTo = gone.relativeTo;
    else delete k.relativeTo;
  }
  keys.splice(keys.indexOf(gone), 1);
  forgetChannel(clip, id);
  if (keys.length === 0 && (clip.kind === "path" || clip.kind === "mesh")) delete clip.shapeKeys;
  return true;
}

/** Duplicate a key (same reference, same shape, weight 0). */
export function duplicateShapeKey(clip: Clip, id: string): ShapeKey | null {
  const keys = shapeKeysOf(clip);
  const src = keys?.find((k) => k.id === id);
  if (!keys || !src) return null;
  const copy: ShapeKey = {
    id: createId("sk"),
    name: uniqueName(keys, `${src.name} copy`),
    ...(src.relativeTo && { relativeTo: src.relativeTo }),
    source: src.source.kind === "delta" ? { kind: "delta", delta: copyDelta(src.source.delta) } : { ...src.source },
  };
  keys.splice(keys.indexOf(src) + 1, 0, copy);
  return copy;
}

export function renameShapeKey(clip: Clip, id: string, name: string): boolean {
  const keys = shapeKeysOf(clip);
  const k = keys?.find((x) => x.id === id);
  const want = name.trim();
  if (!keys || !k || !want) return false;
  k.name = want.toLowerCase() === k.name.toLowerCase() ? want : uniqueName(keys.filter((x) => x !== k), want);
  return true;
}

export function setShapeKeyMute(clip: Clip, id: string, mute: boolean): boolean {
  const k = shapeKeysOf(clip)?.find((x) => x.id === id);
  if (!k) return false;
  if (mute) k.mute = true;
  else delete k.mute;
  return true;
}

/**
 * Re-point a key at another reference (undefined = the base), KEEPING its
 * absolute shape: Δ' = Δ + chain(old) − chain(new). Refuses a loop.
 */
export function setShapeKeyRelativeTo(clip: Clip, id: string, ref: string | undefined): boolean {
  if (!canHoldShapeKeys(clip)) return false;
  const keys = clip.shapeKeys ?? [];
  const k = keys.find((x) => x.id === id);
  if (!k || k.source.kind !== "delta") return false;
  if (ref && !keys.some((x) => x.id === ref)) return false;
  if (shapeKeyWouldCycle(keys, id, ref)) return false;
  const kind = deltaKind(clip);
  const moved = addDelta(addDelta(k.source.delta, chainDelta(keys, k.relativeTo, kind)), chainDelta(keys, ref, kind), -1);
  k.source = { kind: "delta", delta: moved };
  if (ref) k.relativeTo = ref;
  else delete k.relativeTo;
  return true;
}

/**
 * MIRROR L↔R — a new key that is this one reflected across the clip's own
 * x = 0, named by `rig/sides` (`Smile.L` → `Smile.R`). Each point takes the
 * delta of the point standing at its mirror image (exact positions; a point
 * with no partner keeps a zero delta), x terms negated. Null when the clip is
 * not symmetric enough to mirror anything.
 */
export function mirrorShapeKey(clip: Clip, id: string): ShapeKey | null {
  if (!canHoldShapeKeys(clip)) return null;
  const keys = clip.shapeKeys ?? [];
  const src = keys.find((k) => k.id === id);
  if (!src || src.source.kind !== "delta") return null;
  const name = mirrorName(src.name);
  let delta: ShapeDelta;
  const tol = (v: number) => Math.round(v * 1000) / 1000;
  if (clip.kind === "path" && src.source.delta.kind === "path") {
    const d = src.source.delta;
    const at = new Map<string, [string, number]>();
    for (const s of clip.subpaths) s.points.forEach((p, i) => at.set(`${tol(p.x)},${tol(p.y)}`, [s.id, i]));
    const contours: Record<string, number[]> = {};
    let any = false;
    for (const s of clip.subpaths) {
      const run: number[] = [];
      for (const p of s.points) {
        const m = at.get(`${tol(-p.x)},${tol(p.y)}`);
        const r = m ? d.contours[m[0]] : undefined;
        const o = m ? m[1] * 6 : 0;
        if (r && m) any = true;
        // Reflecting across x swaps nothing about in/out (order is unchanged), only negates x.
        run.push(-(r?.[o] ?? 0), r?.[o + 1] ?? 0, -(r?.[o + 2] ?? 0), r?.[o + 3] ?? 0, -(r?.[o + 4] ?? 0), r?.[o + 5] ?? 0);
      }
      if (run.some((v) => v !== 0)) contours[s.id] = run;
    }
    if (!any) return null;
    delta = { kind: "path", contours };
  } else if (clip.kind === "mesh" && src.source.delta.kind === "mesh") {
    const d = src.source.delta;
    const pos = clip.geometry.mesh.positions;
    const at = new Map<string, number>();
    for (let v = 0; v * 3 < pos.length; v++) at.set(`${tol(pos[v * 3]!)},${tol(pos[v * 3 + 1]!)},${tol(pos[v * 3 + 2]!)}`, v);
    const dense = new Map<number, number>();
    d.verts.forEach((v, k) => dense.set(v, k));
    const verts: number[] = [], xyz: number[] = [];
    for (let v = 0; v * 3 < pos.length; v++) {
      const m = at.get(`${tol(-pos[v * 3]!)},${tol(pos[v * 3 + 1]!)},${tol(pos[v * 3 + 2]!)}`);
      const k = m === undefined ? undefined : dense.get(m);
      if (k === undefined) continue;
      verts.push(v);
      xyz.push(-d.xyz[k * 3]!, d.xyz[k * 3 + 1]!, d.xyz[k * 3 + 2]!);
    }
    if (verts.length === 0) return null;
    delta = { kind: "mesh", verts, xyz };
  } else return null;
  const key: ShapeKey = {
    id: createId("sk"),
    name: uniqueName(keys, name === src.name ? `${src.name} mirrored` : name),
    ...(src.relativeTo && { relativeTo: src.relativeTo }),
    source: { kind: "delta", delta },
  };
  keys.splice(keys.indexOf(src) + 1, 0, key);
  return key;
}
