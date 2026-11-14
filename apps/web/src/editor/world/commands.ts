"use client";

import {
  clipLocalTime,
  composeTrs,
  createCameraClip,
  createEmptyClip,
  createLightClip,
  createMeshClip,
  createTextClip,
  decomposeTrs,
  deleteLayers,
  expandToDescendants,
  invert4,
  isSpatialClip,
  joinMeshes,
  locateClip,
  makeMeshEditable,
  mul4,
  objectLocalMatrix,
  placeClip,
  quantizeMesh,
  setMeshData,
  transformMesh,
  translate4,
  buildPrimitive,
  aimEuler,
  writeChannel,
  makeCameraActive,
  materializeDefaultCamera,
  type MotionDocument,
  type DocumentStore,
  type LightType,
  type Mat4,
  type MeshClip,
  type MeshData,
  type V3,
  type VisualClip,
  type WorldObject,
} from "@solomotion/core";
import { useSession } from "../state/session";
import { useWorldUi } from "./state";
import { useToolDefaults } from "../state/tool-defaults";
import { toast } from "@/lib/toast";

/**
 * THE VIEWPORT'S VERBS — every write a 3D gesture makes, in one place, over
 * core ops. The viewport, the add menu, the right-click menu and the keyboard
 * call these; none of them writes the document itself.
 */

const isSpatial = (c: { kind: string }) => c.kind === "mesh" || c.kind === "camera" || c.kind === "light";

/** Where a new object lands in time: the comp's start, spanning it (a 3D object usually lives for the whole shot). */
export function spanFor(doc: MotionDocument, frameId: string): { startMs: number; durationMs: number } {
  const frame = doc.frames.find((f) => f.id === frameId);
  const dur = frame?.durationMs ?? doc.durationMs ?? 5000;
  return { startMs: 0, durationMs: Math.max(100, dur) };
}

function place(store: DocumentStore, label: string, make: (d: MotionDocument) => VisualClip): string | null {
  let id: string | null = null;
  store.update(label, (d) => {
    const clip = make(d);
    clip.fillDuration = true;
    placeClip(d, clip, { landing: "surface" });
    id = clip.id;
  });
  if (id) useSession.getState().select([id]);
  return id;
}

export function addPrimitive(store: DocumentStore, frameId: string, primitive: string, at: V3): string | null {
  const def = buildPrimitive(primitive, {});
  if (!def) return null;
  return place(store, "Add mesh", (d) => createMeshClip({ frameId, ...spanFor(d, frameId), primitive, position: at }));
}

export function addCamera(store: DocumentStore, frameId: string, at: V3, lookAt?: V3): string | null {
  return place(store, "Add camera", (d) =>
    createCameraClip({ frameId, ...spanFor(d, frameId), position: at, rotation: lookAt ? aimEuler(at, lookAt) : [90, 0, 0] }),
  );
}

/** A controller (an empty) at the 3D cursor — axes to animate, aim at and parent to. */
export function addController(store: DocumentStore, frameId: string, at: V3): string | null {
  return place(store, "Add controller", (d) => createEmptyClip({ frameId, ...spanFor(d, frameId), position: at }));
}

export function addLight(store: DocumentStore, frameId: string, type: LightType, at: V3): string | null {
  // Lights point down −Z: a fresh spot/sun/area aims at the origin, the way
  // Blender's sun points straight down.
  const aim = type === "spot" || type === "area" ? aimEuler(at, [0, 0, 0]) : ([0, 0, 0] as V3);
  return place(store, "Add light", (d) => createLightClip({ frameId, ...spanFor(d, frameId), type, position: at, rotation: aim }));
}

/** A text standing in the world, facing the front camera (it is a picture plane). */
export function addText(store: DocumentStore, frameId: string, at: V3, text = "Text"): string | null {
  return place(store, "Add text", (d) => {
    const clip = createTextClip({ frameId, ...spanFor(d, frameId), text, presetId: null, x: at[0], y: at[1] });
    clip.transform.z = at[2];
    // The text tool's own defaults — the options row's font and size, the flat tool's.
    clip.style = { ...clip.style, ...useToolDefaults.getState().text };
    return clip;
  });
}

// ── Transforms ───────────────────────────────────────────────────────────────

/**
 * Split a matrix into T, R, S, choosing — when it is MIRRORED — the flipped
 * axis that keeps the rotation nearest the one it had. A mirrored matrix is
 * the same shape with any one axis negated (and a half turn); `decomposeTrs`
 * always negates X, so S Y −1 came back as X −1 and a 180° turn — the same
 * picture, keys that spin, and not what was typed.
 */
function decomposeNear(m: Mat4, prev: [number, number, number]): ReturnType<typeof decomposeTrs> {
  const base = decomposeTrs(m);
  if (base.scale[0] >= 0) return base;
  const wrap = (a: number) => Math.abs(((((a + 180) % 360) + 360) % 360) - 180);
  const cost = (r: readonly number[]) => r.reduce((acc, v, i) => acc + wrap(v - prev[i]!), 0);
  let best = base;
  let bestCost = cost(base.rotation);
  for (const axis of [1, 2] as const) {
    // Negate that axis's column: what is left is unmirrored, and its rotation is the one a flip on `axis` means.
    const q = m.slice() as Mat4;
    for (let r = 0; r < 3; r++) q[axis * 4 + r] = -m[axis * 4 + r]!;
    const d = decomposeTrs(q);
    const scale = d.scale.slice() as [number, number, number];
    scale[axis] = -scale[axis];
    const c = cost(d.rotation);
    if (c < bestCost - 1e-6) (best = { ...d, scale }), (bestCost = c);
  }
  return best;
}

/** The transform values a world matrix means for a clip, given its parent's matrix. */
export function transformValuesFor(clip: VisualClip, world: Mat4, parent: Mat4): Record<string, number> {
  const local = mul4(invert4(parent), world);
  const t = clip.transform;
  const trs = decomposeNear(local, [t.rotationX ?? 0, t.rotationY ?? 0, t.rotation]);
  const near = (v: number, prev: number) => {
    // Keep Euler continuous: the equivalent angle nearest the old one, so a key
    // never spins the long way round.
    let a = v;
    while (a - prev > 180) a -= 360;
    while (a - prev < -180) a += 360;
    return Math.round(a * 1e4) / 1e4;
  };
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  const planeScale = !isSpatialClip(clip);
  return {
    x: r(trs.position[0]),
    y: r(trs.position[1]),
    z: r(trs.position[2]),
    rotationX: near(trs.rotation[0], t.rotationX ?? 0),
    rotationY: near(trs.rotation[1], t.rotationY ?? 0),
    rotation: near(trs.rotation[2], t.rotation),
    scale: r(trs.scale[0]),
    scaleY: r(planeScale ? trs.scale[2] : trs.scale[1]),
    scaleZ: r(planeScale ? trs.scale[1] : trs.scale[2]),
  };
}

/** The parent space an evaluated object sits in (groups, constraints, animations folded in). */
export function parentMatrixOf(o: WorldObject): Mat4 {
  return mul4(o.matrix, invert4(objectLocalMatrix(o.clip)));
}

/**
 * Write new placements for objects — keyed where the channel is animated or
 * record mode is on, resting values otherwise (`writeChannel`, the app's one
 * animatable write). Only channels that actually changed are written, so a
 * move never plants a stray rotation key.
 */
export function commitPlacements(
  store: DocumentStore,
  label: string,
  items: Array<{ id: string; values: Record<string, number> }>,
  mergeKey?: string,
): void {
  const session = useSession.getState();
  const recording = session.recording;
  const playhead = session.playheadMs;
  store.update(label, (d) => {
    for (const { id, values } of items) {
      const loc = locateClip(d, id);
      if (!loc || loc.clip.kind === "audio") continue;
      const clip = loc.clip;
      const local = playhead - clip.startMs;
      const t = clip.transform;
      const current: Record<string, number> = {
        x: t.x, y: t.y, z: t.z ?? 0, rotationX: t.rotationX ?? 0, rotationY: t.rotationY ?? 0, rotation: t.rotation,
        scale: t.scale, scaleY: t.scaleY ?? t.scale, scaleZ: t.scaleZ ?? t.scale,
      };
      const keyed = new Set(clip.keyframes.map((k) => k.property));
      // Y and Z scale with no value of their own FOLLOW X: whatever X becomes,
      // they become. So "unchanged" for them is measured against the NEW X —
      // an X-only scale (S X) must write the old Y and Z to keep them, or they
      // follow X and the scale comes out uniform.
      const nextScale = values.scale ?? t.scale;
      for (const [path, v] of Object.entries(values)) {
        if (!Number.isFinite(v)) continue;
        const linked = (path === "scaleY" && t.scaleY == null) || (path === "scaleZ" && t.scaleZ == null);
        if (linked && !keyed.has(path)) {
          if (Math.abs(v - nextScale) < 1e-9) continue;
          writeChannel(clip, path, local, v, { forceKey: recording });
          continue;
        }
        // Unchanged channels stay untouched — unless they are keyed and this is
        // a keyed write, where the partner rule seeds them correctly anyway.
        if (Math.abs((current[path] ?? 0) - v) < 1e-6 && !keyed.has(path)) continue;
        writeChannel(clip, path, local, v, { forceKey: recording });
      }
    }
  }, mergeKey ? { mergeKey } : undefined);
}

/** Alt+G / Alt+R / Alt+S — clear location, rotation or scale. */
export function clearTransform(store: DocumentStore, ids: string[], what: "location" | "rotation" | "scale"): void {
  const values: Record<string, number> =
    what === "location" ? { x: 0, y: 0, z: 0 } : what === "rotation" ? { rotationX: 0, rotationY: 0, rotation: 0 } : { scale: 1, scaleY: 1, scaleZ: 1 };
  commitPlacements(store, `Clear ${what}`, ids.map((id) => ({ id, values })));
}

// ── Objects ──────────────────────────────────────────────────────────────────

export function deleteObjects(store: DocumentStore, ids: string[]): void {
  if (!ids.length) return;
  store.update(ids.length > 1 ? "Delete objects" : "Delete object", (d) => {
    deleteLayers(d, expandToDescendants(d, ids), { pruneEmptiedTracks: true });
  });
  useSession.getState().select([]);
}

/**
 * Ctrl+J — merge the selected meshes into the ACTIVE one, each brought into
 * its space so nothing visibly moves. Parts travel with their faces; the
 * others are deleted. Primitives are made editable first (a join is polygons).
 */
export function joinObjects(store: DocumentStore, objects: WorldObject[], activeId: string): boolean {
  const meshes = objects.filter((o) => o.kind === "mesh" && o.clip.kind === "mesh" && (o.clip as MeshClip).geometry.type !== "asset");
  const active = meshes.find((o) => o.id === activeId);
  if (!active || meshes.length < 2) return false;
  const inv = invert4(active.matrix);
  let mesh = meshDataOf(active.clip as MeshClip);
  if (!mesh) return false;
  const others: string[] = [];
  for (const o of meshes) {
    if (o.id === activeId) continue;
    const m = meshDataOf(o.clip as MeshClip);
    if (!m) continue;
    mesh = joinMeshes(mesh, transformMesh(m, mul4(inv, o.matrix)));
    others.push(o.id);
  }
  store.update("Join", (d) => {
    setMeshData(d, activeId, mesh!);
    deleteLayers(d, others, { pruneEmptiedTracks: true });
  });
  useSession.getState().select([activeId]);
  return true;
}

/** The polygons a mesh clip shows at rest (primitive built, or stored). */
export function meshDataOf(clip: MeshClip): MeshData | null {
  const g = clip.geometry;
  if (g.type === "mesh") return g.mesh;
  if (g.type === "primitive") return buildPrimitive(g.primitive, g.params);
  return null;
}

/** Commit an edit-mode result as one undo step. */
export function commitMesh(store: DocumentStore, clipId: string, mesh: MeshData, label: string): void {
  store.update(label, (d) => void setMeshData(d, clipId, mesh));
}

export function makeEditable(store: DocumentStore, clipId: string): void {
  store.update("Make editable", (d) => {
    const loc = locateClip(d, clipId);
    if (loc?.clip.kind === "mesh") makeMeshEditable(loc.clip);
  });
}

/** P — split the given faces off into a new object beside the old one. */
export function separateInto(store: DocumentStore, clipId: string, kept: MeshData, separated: MeshData): string | null {
  let newId: string | null = null;
  store.update("Separate", (d) => {
    const loc = locateClip(d, clipId);
    if (!loc || loc.clip.kind !== "mesh") return;
    setMeshData(d, clipId, kept);
    const src = loc.clip;
    const copy = structuredClone(src) as MeshClip;
    copy.id = `${src.id}_${Math.random().toString(36).slice(2, 7)}`;
    copy.name = `${src.name}.001`;
    copy.geometry = { type: "mesh", mesh: quantizeMesh(separated) };
    placeClip(d, copy, { aboveClipId: src.id, landing: "settle" });
    newId = copy.id;
  });
  return newId;
}

/**
 * Set origin — move the object's pivot without moving what you see: the
 * vertices shift the other way by exactly the same amount.
 */
export function setOrigin(store: DocumentStore, o: WorldObject, to: "geometry" | "cursor"): void {
  const clip = o.clip as MeshClip;
  const mesh = meshDataOf(clip);
  if (!mesh) return;
  let localTarget: V3;
  if (to === "geometry") {
    let x = 0, y = 0, z = 0;
    const n = mesh.positions.length / 3;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      x += mesh.positions[i]!;
      y += mesh.positions[i + 1]!;
      z += mesh.positions[i + 2]!;
    }
    localTarget = [x / n, y / n, z / n];
  } else {
    const cursor = useWorldUi.getState().cursor;
    const inv = invert4(o.matrix);
    const p = [
      inv[0]! * cursor[0] + inv[4]! * cursor[1] + inv[8]! * cursor[2] + inv[12]!,
      inv[1]! * cursor[0] + inv[5]! * cursor[1] + inv[9]! * cursor[2] + inv[13]!,
      inv[2]! * cursor[0] + inv[6]! * cursor[1] + inv[10]! * cursor[2] + inv[14]!,
    ];
    localTarget = [p[0]!, p[1]!, p[2]!];
  }
  const shifted = transformMesh(mesh, translate4([-localTarget[0], -localTarget[1], -localTarget[2]]));
  const newWorld = mul4(o.matrix, translate4(localTarget));
  const values = transformValuesFor(clip, newWorld, parentMatrixOf(o));
  store.update("Set origin", (d) => {
    setMeshData(d, o.id, shifted);
    const loc = locateClip(d, o.id);
    if (!loc || loc.clip.kind === "audio") return;
    loc.clip.transform.x = values.x!;
    loc.clip.transform.y = values.y!;
    loc.clip.transform.z = values.z!;
  });
}

/** Ctrl+A — apply rotation and scale into the polygons (Blender's Apply). */
export function applyTransform(store: DocumentStore, o: WorldObject): void {
  const clip = o.clip as MeshClip;
  const mesh = meshDataOf(clip);
  if (!mesh) return;
  const t = clip.transform;
  const rs = composeTrs({ position: [0, 0, 0], rotation: [t.rotationX ?? 0, t.rotationY ?? 0, t.rotation], scale: [t.scale, t.scaleY ?? t.scale, t.scaleZ ?? t.scale] });
  store.update("Apply transform", (d) => {
    setMeshData(d, o.id, transformMesh(mesh, rs));
    const loc = locateClip(d, o.id);
    if (!loc || loc.clip.kind === "audio") return;
    Object.assign(loc.clip.transform, { rotation: 0, rotationX: undefined, rotationY: undefined, scale: 1, scaleY: null, scaleZ: undefined });
  });
}

/** The objects' ids that are 3D-native (for menus that only make sense on them). */
export function spatialIds(doc: MotionDocument, ids: string[]): string[] {
  return ids.filter((id) => {
    const c = locateClip(doc, id)?.clip;
    return !!c && isSpatial(c);
  });
}

/** The comp time the viewport is showing (the target comp's playhead). */
/**
 * Look through THIS camera from now on — the viewport menu's, the layer
 * menu's and the timeline's "Make active camera" alike (core
 * `makeCameraActive`, a restack: the live camera is derived). Says why when it
 * cannot. `look` also turns the view to look through it.
 */
export function setActiveCamera(store: DocumentStore, frameId: string, cameraId: string, opts: { look?: boolean } = {}): boolean {
  let why: string | null = null;
  store.update("Set active camera", (d) => void (why = makeCameraActive(d, frameId, cameraId, viewportTime())));
  if (why) {
    toast(why);
    return false;
  }
  if (opts.look) useWorldUi.getState().set({ throughCamera: true, viewCameraId: cameraId });
  return true;
}

/** The default camera, made a camera layer where it stands and selected (core `materializeDefaultCamera`). */
export function makeDefaultCameraReal(store: DocumentStore, frameId: string): string | null {
  let id: string | null = null;
  store.update("Make the default camera a layer", (d) => void (id = materializeDefaultCamera(d, frameId)));
  if (id) {
    useSession.getState().select([id]);
    toast("Camera added as a layer");
  }
  return id;
}

export function viewportTime(): number {
  return useSession.getState().playheadMs;
}

export { clipLocalTime };
