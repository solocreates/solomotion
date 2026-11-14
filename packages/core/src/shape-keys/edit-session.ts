import type { MotionDocument, MeshData, ShapeKeySource, Subpath } from "../schema";
import { copyDelta } from "./delta";
import { locateClip } from "../timeline/ops";
import { setPathGeometry } from "../pivot";
import { copySubpaths } from "../vector/geometry";
import { setMeshData } from "../world/ops";
import { cloneMesh } from "../world/mesh";
import { canHoldShapeKeys, setKeyShape, shapeOfKey } from "./ops";

/**
 * EDIT KEY — while a key is armed the path or mesh SHOWS that key and every
 * ordinary tool edits it: the base is parked in the session, the key's shape
 * stands in for it and every key sits muted (what you see is exactly the
 * key). Ending writes the edited outline back as the key's delta and restores
 * base and mutes. Two document writes, and no editing tool had to learn about
 * keys — the node editor, the pen, mesh edit mode and agents all just work.
 */
export interface KeyEditSession {
  clipId: string;
  keyId: string;
  base: Subpath[] | MeshData;
  muted: Record<string, boolean>;
  /** Every key's source as it was: the base comes back exactly, so they are exact again. */
  sources: Record<string, ShapeKeySource>;
}

const sameTopology = (a: Subpath[] | MeshData, b: Subpath[] | MeshData): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((s, i) => s.points.length === b[i]!.points.length)
    : !Array.isArray(a) && !Array.isArray(b) && a.positions.length === b.positions.length;

/** Arm a key (mutates `doc` — call inside an update). Null when it cannot be edited. */
export function beginKeyEdit(doc: MotionDocument, clipId: string, keyId: string): KeyEditSession | null {
  const clip = locateClip(doc, clipId)?.clip;
  if (!clip || !canHoldShapeKeys(clip)) return null;
  const key = clip.shapeKeys?.find((k) => k.id === keyId);
  if (!key || key.source.kind !== "delta") return null;
  const shape = shapeOfKey(clip, keyId);
  const muted: Record<string, boolean> = {};
  const sources: Record<string, ShapeKeySource> = {};
  for (const k of clip.shapeKeys ?? []) {
    muted[k.id] = !!k.mute;
    sources[k.id] = k.source.kind === "delta" ? { kind: "delta", delta: copyDelta(k.source.delta) } : { ...k.source };
    k.mute = true;
  }
  if (clip.kind === "path") {
    const base = copySubpaths(clip.subpaths);
    setPathGeometry(clip, copySubpaths(shape as Subpath[]));
    return { clipId, keyId, base, muted, sources };
  }
  // A plain copy: inside an immutable update the live mesh is a draft that dies with it.
  const base = cloneMesh(clip.geometry.mesh);
  setMeshData(doc, clipId, shape as MeshData);
  return { clipId, keyId, base, muted, sources };
}

/**
 * End an edit: `saved`; `topology` when points were added or removed meanwhile
 * (the base comes back and the key keeps the shape it had); `gone` when the
 * layer or key no longer exists.
 */
export function endKeyEdit(doc: MotionDocument, s: KeyEditSession): "saved" | "topology" | "gone" {
  const clip = locateClip(doc, s.clipId)?.clip;
  if (!clip || !canHoldShapeKeys(clip)) return "gone";
  const edited = clip.kind === "path" ? copySubpaths(clip.subpaths) : clip.geometry.mesh;
  const ok = sameTopology(edited, s.base);
  if (clip.kind === "path") setPathGeometry(clip, copySubpaths(s.base as Subpath[]));
  else setMeshData(doc, s.clipId, s.base as MeshData);
  for (const k of clip.shapeKeys ?? []) {
    if (s.muted[k.id]) k.mute = true;
    else delete k.mute;
    const src = s.sources[k.id];
    if (src) k.source = src;
  }
  if (!clip.shapeKeys?.some((k) => k.id === s.keyId)) return "gone";
  if (!ok) return "topology";
  setKeyShape(clip, s.keyId, edited);
  return "saved";
}
