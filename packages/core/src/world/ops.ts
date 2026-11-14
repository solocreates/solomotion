import type {
  MotionDocument,
  EmptyClip,
  CameraClip,
  Clip,
  Frame,
  LightClip,
  LightType,
  MeshClip,
  MeshData,
  Modifier,
  Paint,
  VisualClip,
} from "../schema";
import {
  cameraSpecSchema,
  lightSpecSchema,
  materialSchema,
  meshLinesSchema,
  latticeSpecSchema,
  worldSpecSchema,
  type Material,
} from "../schema/world";
import { createId } from "../ids";
import { createFrame, createRasterClip, createShapeClip, type CreateFrameInput } from "../factories";
import { internalPageId } from "../pages";
import { frameFps } from "../timeline/fps";
import { DEFAULT_CLIP_MOTION_BLUR } from "../schema/motion-blur";
import { DEFAULT_LAYOUT_ITEM } from "../schema/relations";
import { solidPaint } from "../schema/vector";
import { placeClip } from "../timeline/place";
import { compDurationMs, locateClip, restackClips } from "../timeline/ops";
import { defaultCameraMatrix, DEFAULT_CAMERA_SPEC } from "./camera";
import { frameLayerTree } from "../timeline/layer-tree";
import { buildPrimitive, primitiveDef } from "./primitives";
import { quantizeMesh } from "./mesh";
import { followMeshTopology } from "../shape-keys/topology";
import { MDF, applyModifierStack, modifierPath } from "./modifiers";
import { aimRotation, decomposeTrs, eulerFromRotation, invert4, sub, type V3 } from "./math";
import { bakeClipAt, evaluateWorld, objectLocalBounds, worldCameras } from "./evaluate";
import { latticeMesh } from "./lattice";
import { isBodyKind } from "./body";

/**
 * WORLD OPS — making worlds and the things in them. Every creation path (the
 * add menu, the API, import, "Move into 3D") goes through these, so a camera
 * made by an agent and one made by ⇧A are the same object.
 */

/** Flat comp space (x right, y down, z away; frame-centre) → world (Z up). One rotation. */
export function flatToWorld(p: V3): V3 {
  return [p[0], p[2], -p[1]];
}

/** World → flat comp space. */
export function worldToFlat(p: V3): V3 {
  return [p[0], -p[2], p[1]];
}

interface SpatialBaseInput {
  frameId: string;
  startMs: number;
  durationMs: number;
  name: string;
  position?: V3;
  rotation?: V3;
  fills?: Paint[];
}

/** Every visual-clip field, at rest — the shared spine of the 3D factories. */
function spatialBase(input: SpatialBaseInput) {
  const [x, y, z] = input.position ?? [0, 0, 0];
  const [rx, ry, rz] = input.rotation ?? [0, 0, 0];
  return {
    id: createId("clip"),
    frameId: input.frameId,
    name: input.name,
    startMs: input.startMs,
    durationMs: input.durationMs,
    keyframes: [],
    linkGroupId: null,
    fillDuration: false,
    locked: false,
    audioMix: { volume: 1, muted: false },
    motionBlur: DEFAULT_CLIP_MOTION_BLUR,
    audioEffects: [],
    sounds: [],
    hidden: false,
    mirrorId: null,
    origin: null,
    transform: {
      x, y, scale: 1, scaleY: null, rotation: rz, skewX: 0, skewY: 0,
      anchor: { x: 0.5, y: 0.5 },
      ...(z ? { z } : {}),
      ...(rx ? { rotationX: rx } : {}),
      ...(ry ? { rotationY: ry } : {}),
    },
    fills: input.fills ?? [],
    strokes: [],
    maxWidth: null,
    effects: [],
    fps: null,
    opacity: 1,
    feather: 0,
    borderRadius: { tl: 0, tr: 0, br: 0, bl: 0 },
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    content: { x: 0, y: 0, scale: 1, scaleY: null, rotation: 0 },
    blendMode: "normal" as const,
    isStencil: false,
    animIn: null,
    animOut: null,
    trackBinding: null,
    layoutItem: { ...DEFAULT_LAYOUT_ITEM },
  };
}

/** Blender's default material grey, a touch warmer. */
export const DEFAULT_MESH_COLOR = "#c9cbd1";

export interface CreateMeshInput {
  frameId: string;
  startMs: number;
  durationMs: number;
  primitive?: string;
  params?: Record<string, number>;
  mesh?: MeshData;
  assetId?: string;
  name?: string;
  position?: V3;
  rotation?: V3;
  color?: string;
  material?: Partial<Material>;
}

export function createMeshClip(input: CreateMeshInput): MeshClip {
  const def = input.primitive ? primitiveDef(input.primitive) : undefined;
  const geometry: MeshClip["geometry"] = input.assetId
    ? { type: "asset", assetId: input.assetId }
    : input.mesh
      ? { type: "mesh", mesh: input.mesh }
      : { type: "primitive", primitive: def?.id ?? "cube", params: { ...(input.params ?? {}) } };
  return {
    ...spatialBase({
      ...input,
      name: input.name ?? def?.label ?? (input.assetId ? "Model" : "Mesh"),
      fills: input.assetId ? [] : [solidPaint(input.color ?? DEFAULT_MESH_COLOR)],
    }),
    kind: "mesh",
    uv: "box",
    texture: null,
    geometry,
    material: materialSchema.parse({ ...(input.assetId ? { source: "file" } : {}), ...(input.material ?? {}) }),
    parts: [],
    modifiers: [],
    lines: meshLinesSchema.parse({}),
    shading: "auto",
    smoothAngle: 30,
    castShadow: true,
    receiveShadow: true,
  };
}

export function createCameraClip(input: Omit<SpatialBaseInput, "name"> & { name?: string; focalLength?: number }): CameraClip {
  return {
    ...spatialBase({ ...input, name: input.name ?? "Camera" }),
    kind: "camera",
    camera: cameraSpecSchema.parse({ focalLength: input.focalLength ?? 50 }),
  };
}

/** A CONTROLLER (an empty): axes in space to animate, aim at and parent to. */
export function createEmptyClip(input: Omit<SpatialBaseInput, "name"> & { name?: string; display?: EmptyClip["display"]; size?: number }): EmptyClip {
  return {
    ...spatialBase({ ...input, name: input.name ?? "Controller" }),
    kind: "empty",
    display: input.display ?? "axes",
    size: input.size ?? 80,
  };
}

/**
 * Parent `childId` to `parentId` with Child Of, keeping the child exactly where
 * it is now (the parent's current world matrix, inverted, is stored). Pass
 * null to unparent — the child keeps its own transform.
 */
export function setChildOf(doc: MotionDocument, frame: Frame, childId: string, parentId: string | null, atMs = 0): boolean {
  const loc = locateClip(doc, childId);
  if (!loc || loc.clip.kind === "audio") return false;
  const clip = loc.clip;
  const rest = (clip.constraints ?? []).filter((c) => c.type !== "childOf");
  if (!parentId) {
    clip.constraints = rest.length ? rest : undefined;
    return true;
  }
  if (parentId === childId) return false;
  const target = evaluateWorld(doc, frame, atMs).objects.find((o) => o.id === parentId);
  clip.constraints = [...rest, { id: createId("cns"), type: "childOf", targetId: parentId, enabled: true, influence: 1, inverse: target ? invert4(target.matrix) : null }];
  return true;
}

/**
 * A LATTICE FOR AN OBJECT — Blender's Add › Lattice, scale it round the
 * object, parent it, add the modifier and pick the cage, as ONE step: a cage
 * of `resolution` points fitted around the object's own extent (a little room
 * past it, and real depth even round a flat layer), riding the object (Child
 * Of, so a moving object keeps its deform), and a Lattice card at the end of
 * the object's stack reading it. Returns the cage's and the card's ids.
 */
export function addLattice(
  doc: MotionDocument,
  clipId: string,
  opts: {
    resolution?: [number, number, number];
    card?: Modifier;
    /**
     * The object's extent in its own space as a renderer MEASURED it (a
     * text's glyphs, a picture's silhouette). Without it the cage fits the
     * layer's box (`objectLocalBounds`) — a text's whole line box.
     */
    bounds?: { min: V3; max: V3 } | null;
  } = {},
): { cageId: string; modifierId: string } | null {
  const loc = locateClip(doc, clipId);
  const clip = loc?.clip;
  if (!clip || clip.kind === "audio" || clip.kind === "camera" || clip.kind === "light" || clip.kind === "empty") return null;
  if (clip.kind !== "mesh" && !isBodyKind(clip.kind)) return null;
  const frame = doc.frames.find((f) => f.id === clip.frameId);
  if (!frame?.world) return null;
  const o = evaluateWorld(doc, frame, clip.startMs, { physics: false }).objects.find((x) => x.id === clipId);
  const b = opts.bounds ?? (o && objectLocalBounds(o, doc)) ?? { min: [-50, -50, -50] as V3, max: [50, 50, 50] as V3 };
  const span = [0, 1, 2].map((k) => b.max[k]! - b.min[k]!);
  const room = Math.max(...span) * 0.04;
  const floor = Math.max(...span) * 0.2;
  const size = span.map((v) => Math.max(v + room * 2, floor, 1)) as [number, number, number];
  const centre: V3 = [0, 1, 2].map((k) => (b.min[k]! + b.max[k]!) / 2 || 0) as V3;
  const [u, v, w] = opts.resolution ?? [3, 3, 3];
  const spec = latticeSpecSchema.parse({ u, v, w, size });
  const cage = createMeshClip({
    frameId: clip.frameId,
    startMs: clip.startMs,
    durationMs: clip.durationMs,
    mesh: latticeMesh(spec),
    name: `${clip.name} lattice`,
    position: centre,
  });
  cage.fills = [];
  cage.castShadow = false;
  cage.receiveShadow = false;
  cage.lattice = spec;
  // An offset from the object it rides (no inverse): the cage's own place IS the centre, in the object's space.
  cage.constraints = [{ id: createId("cns"), type: "childOf", targetId: clipId, enabled: true, influence: 1, inverse: null }];
  placeClip(doc, cage, { aboveClipId: clipId });
  const card = { ...(opts.card ?? MDF.create("lattice")), cage: cage.id } as Modifier;
  const target = clip as VisualClip;
  target.modifiers = [...(target.modifiers ?? []), card];
  return { cageId: cage.id, modifierId: card.id };
}

/**
 * PAINTING ON A MESH — the drawing layer the brush lands on, in the comp the
 * mesh wears as its texture (`texture.frameId`, wrapped by its `uv`). A mesh
 * with no texture is given one: a square comp with a BASE COAT in the mesh's
 * own fill (so the first stroke changes nothing but the stroke) and a
 * full-size drawing layer on top. A comp whose topmost layer is already such a
 * drawing layer paints into it; otherwise a fresh one goes on top, so painting
 * never draws into a design's own layers. Returns the layer and its comp.
 */
export function texturePaintLayer(doc: MotionDocument, meshId: string, size = 1024): { rasterId: string; frameId: string } | null {
  const mesh = locateClip(doc, meshId)?.clip;
  if (!mesh || mesh.kind !== "mesh" || mesh.lattice || mesh.geometry.type === "asset") return null;
  const world = doc.frames.find((f) => f.id === mesh.frameId);
  if (!world) return null;
  const span = Math.max(compDurationMs(doc, world.id), mesh.startMs + mesh.durationMs);
  let comp = mesh.texture ? doc.frames.find((f) => f.id === mesh.texture!.frameId) : undefined;
  if (!comp) {
    comp = createFrame({ name: `${mesh.name || "Mesh"} · paint`, width: size, height: size, background: "#00000000", pageId: internalPageId(doc), fps: frameFps(doc, world) });
    comp.fills = [];
    doc.frames.push(comp);
    const coat = mesh.fills.find((p) => p.enabled !== false);
    if (coat) {
      const base = createShapeClip({ frameId: comp.id, shape: "rect", startMs: 0, durationMs: span, width: size, height: size });
      base.name = "Base coat";
      // A copy of plain data (structuredClone cannot copy an edit in progress).
      base.fills = [JSON.parse(JSON.stringify(coat)) as typeof coat];
      base.strokes = [];
      placeClip(doc, base, { landing: "surface" });
    }
    mesh.texture = { frameId: comp.id, repeat: 1 };
  }
  const top = frameLayerTree(doc, comp.id)[0];
  const t = top?.type === "clip" ? top.clip : null;
  const covers =
    t?.kind === "raster" &&
    t.width === comp.width &&
    t.height === comp.height &&
    t.transform.x === 0 &&
    t.transform.y === 0 &&
    t.transform.scale === 1 &&
    (t.transform.scaleY ?? 1) === 1 &&
    t.transform.rotation === 0;
  if (covers) return { rasterId: t!.id, frameId: comp.id };
  const layer = createRasterClip({ frameId: comp.id, width: comp.width, height: comp.height, startMs: 0, durationMs: span, name: "Paint" });
  placeClip(doc, layer, { landing: "surface" });
  return { rasterId: layer.id, frameId: comp.id };
}

/** Sensible strengths per light type (Blender's units). */
export const LIGHT_DEFAULTS: Record<LightType, { intensity: number; label: string }> = {
  point: { intensity: 1000, label: "Point light" },
  spot: { intensity: 1500, label: "Spot light" },
  area: { intensity: 800, label: "Area light" },
  sun: { intensity: 3, label: "Sun" },
  environment: { intensity: 1, label: "Environment" },
  hemisphere: { intensity: 0.6, label: "Sky light" },
};

export function createLightClip(input: Omit<SpatialBaseInput, "name"> & { type: LightType; name?: string; intensity?: number }): LightClip {
  const d = LIGHT_DEFAULTS[input.type];
  return {
    ...spatialBase({ ...input, name: input.name ?? d.label }),
    kind: "light",
    light: lightSpecSchema.parse({ type: input.type, intensity: input.intensity ?? d.intensity }),
  };
}

/** A rotation (degrees, XYZ) that aims a camera or light at `target` from `from`. */
export function aimEuler(from: V3, target: V3, forward: "-z" | "-y" = "-z"): V3 {
  return eulerFromRotation(aimRotation(sub(target, from), forward));
}

export interface CreateWorldInput extends CreateFrameInput {
  /** Start with Blender's scene — camera, key light, studio and a cube. Default true. */
  starter?: boolean;
  /** Transparent backdrop (a world that will be composited over 2D). */
  transparent?: boolean;
}

/**
 * A NEW WORLD comp with the scene every 3D artist expects to open to — a
 * camera framing a cube, a key light, a studio to light reflections. The
 * camera is Blender's default, ×100 for our centimetres.
 */
export function createWorld(doc: MotionDocument, input: CreateWorldInput = {}): { frame: Frame; clipIds: string[] } {
  const frame = createFrame({ name: "World", width: 1920, height: 1080, ...input });
  frame.world = worldSpecSchema.parse({});
  frame.background = input.transparent ? "#00000000" : "#16171b";
  if (input.transparent) frame.fills = [];
  doc.frames.push(frame);
  const clipIds: string[] = [];
  if (input.starter !== false) {
    const span = { frameId: frame.id, startMs: 0, durationMs: Math.max(1000, frame.durationMs ?? doc.durationMs ?? 5000) };
    const camPos: V3 = [736, -693, 496];
    const objects: Clip[] = [
      createMeshClip({ ...span, primitive: "cube" }),
      createLightClip({ ...span, type: "point", position: [408, 100, 590], name: "Light", intensity: 1500 }),
      // A quiet studio for reflections and fill; the key light does the modelling.
      createLightClip({ ...span, type: "environment", name: "Studio", intensity: 0.3 }),
      createCameraClip({ ...span, position: camPos, rotation: aimEuler(camPos, [0, 0, 0]) }),
    ];
    for (const c of objects) {
      c.fillDuration = true;
      placeClip(doc, c, { landing: "surface" });
      clipIds.push(c.id);
    }
  }
  return { frame, clipIds };
}

/**
 * MAKE THIS THE CAMERA — the one the world is seen through at `atMs`. The
 * active camera is DERIVED (the topmost visible camera live at an instant,
 * After Effects' rule), so choosing one is a restack, never a stored pointer:
 * it is shown, then lifted to sit just above the camera that is live now, in
 * that camera's scope, so it wins there and nothing else changes order.
 * Returns why it could not, or null when it is now the camera.
 */
export function makeCameraActive(doc: MotionDocument, frameId: string, cameraId: string, atMs: number): string | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  const loc = locateClip(doc, cameraId);
  if (!frame || !loc || loc.clip.kind !== "camera" || loc.clip.frameId !== frameId) return "Not a camera in this world.";
  const cam = loc.clip;
  if (atMs < cam.startMs || atMs >= cam.startMs + cam.durationMs) return `"${cam.name}" is not on the timeline at this moment — move the playhead into its bar.`;
  if (cam.hidden) cam.hidden = false;
  if (loc.track.hidden) loc.track.hidden = false;
  const live = worldCameras(doc, frame, atMs).find((c) => c.live);
  if (!live || live.clip.id === cameraId) return null;
  const above = locateClip(doc, live.clip.id)!;
  restackClips(doc, [cameraId], { trackIndex: above.trackIndex, groupId: above.track.groupId ?? null });
  return null;
}

/**
 * THE DEFAULT CAMERA, MADE REAL — what a world shows with no camera of its
 * own (it frames the comp exactly as the flat comp did), as a camera layer
 * standing where it stands, so its lens and place can be edited and keyed.
 * It goes BELOW every other camera, so it still shows only where none of them
 * is live: nothing on screen changes. Returns the new camera's id.
 */
export function materializeDefaultCamera(doc: MotionDocument, frameId: string): string | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame?.world) return null;
  const trs = decomposeTrs(defaultCameraMatrix(frame.width, frame.height));
  const cam = createCameraClip({
    frameId,
    startMs: 0,
    durationMs: Math.max(500, compDurationMs(doc, frameId)),
    name: "Camera",
    position: trs.position.map((v) => Math.round(v * 1000) / 1000) as V3,
    rotation: trs.rotation.map((v) => Math.round(v * 1e4) / 1e4) as V3,
    focalLength: DEFAULT_CAMERA_SPEC.focalLength,
  });
  cam.fillDuration = true;
  const cams = worldCameras(doc, frame, 0);
  const bottom = cams[cams.length - 1];
  placeClip(doc, cam, bottom ? { belowClipId: bottom.clip.id } : { landing: "surface" });
  return cam.id;
}

/**
 * MAKE EDITABLE — a primitive becomes polygons (C4D's C key; what Blender's
 * every primitive is after creation). Its params' keyframes go, because there
 * is nothing left for them to drive; modifiers stay (they still run on top).
 * One undo step; returns false when there is nothing to convert.
 */
export function makeMeshEditable(clip: MeshClip): boolean {
  if (clip.geometry.type !== "primitive") return false;
  const built = buildPrimitive(clip.geometry.primitive, clip.geometry.params);
  if (!built) return false;
  clip.geometry = { type: "mesh", mesh: quantizeMesh(built) };
  clip.keyframes = clip.keyframes.filter((t) => !t.property.startsWith("geometry."));
  return true;
}

/** Replace a mesh clip's polygons (the one writer edit mode commits through). */
export function setMeshData(doc: MotionDocument, clipId: string, mesh: MeshData): boolean {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind !== "mesh") return false;
  makeMeshEditable(loc.clip);
  const before = loc.clip.geometry.type === "mesh" ? loc.clip.geometry.mesh : null;
  const next = quantizeMesh(mesh);
  // Shape keys follow vertices added or removed (`shape-keys/topology`).
  if (before && loc.clip.shapeKeys?.length) followMeshTopology(loc.clip.shapeKeys, before, next);
  loc.clip.geometry = { type: "mesh", mesh: next };
  return true;
}

/** Is this frame a world? (Re-exported beside the ops that make one.) */
export function frameIsWorld(frame: Frame | undefined): boolean {
  return !!frame?.world;
}

/** A visual clip's position as a world point. */
export function clipPosition(clip: VisualClip): V3 {
  return [clip.transform.x, clip.transform.y, clip.transform.z ?? 0];
}

/**
 * APPLY a modifier (Blender's Ctrl+A on a card): the stack up to and including
 * it is baked into the mesh's own polygons as it stands at `localMs`, and those
 * cards go — everything below keeps running on the result, so what you see does
 * not change. (Blender applies the one card to the bare mesh and warns that the
 * ones above were skipped; baking through it is the version that cannot
 * surprise.) A primitive becomes editable polygons; keys on what was baked are
 * dropped with it. False for an imported model, or no such card.
 */
export function applyModifier(clip: MeshClip, modifierId: string, localMs: number): boolean {
  const i = clip.modifiers.findIndex((m) => m.id === modifierId);
  if (i < 0 || clip.geometry.type === "asset") return false;
  const baked = bakeClipAt(clip, localMs);
  const g = baked.geometry;
  const base = g.type === "primitive" ? buildPrimitive(g.primitive, g.params) : g.type === "mesh" ? g.mesh : null;
  if (!base) return false;
  const upto = baked.modifiers.slice(0, i + 1);
  const mesh = applyModifierStack(base, upto, {}, undefined, localMs / 1000);
  const gone = new Set(upto.map((m) => m.id));
  const dropped = (path: string) => path.startsWith("geometry.") || [...gone].some((id) => path.startsWith(modifierPath(id, "")));
  clip.geometry = { type: "mesh", mesh: quantizeMesh(mesh) };
  clip.modifiers = clip.modifiers.filter((m) => !gone.has(m.id));
  clip.keyframes = clip.keyframes.filter((t) => !dropped(t.property));
  if (clip.modulators) clip.modulators = clip.modulators.filter((m) => !dropped(m.target));
  return true;
}

/** Placement channels a converted body hands to its mesh (the picture's own animation stays with the picture). */
const PLACEMENT = new Set(["x", "y", "z", "rotation", "rotationX", "rotationY", "scale", "scaleY", "scaleZ", "opacity"]);
/** A picture's 2D scaleY is its height (local Z); a mesh's scaleY is depth (local Y) — the two swap. */
const MESH_CHANNEL: Record<string, string> = { scaleY: "scaleZ", scaleZ: "scaleY" };

/**
 * CONVERT TO MESH — a 2D layer's body (its card, slab or outline solid, after
 * its modifiers: `mesh`, in layer px about its pivot, with its unwrap) becomes
 * an editable MESH that stands exactly where the layer did, and the layer
 * itself moves into a small comp of its own that the mesh wears as its
 * texture. So the polygons are yours to edit and the picture stays LIVE: the
 * words are still words (double-click the comp to retype them), a video still
 * plays, an effect still animates. Placement, its keys and the in/out
 * animations go to the mesh; everything that is the picture's stays with it.
 *
 * `rect` is the picture's rectangle (layer px, about the pivot) — the comp's
 * size; `sideColor` colours the sides as a part (null: the picture's edge, as
 * the body drew them). Returns the mesh's id.
 */
export function convertBodyToMesh(
  doc: MotionDocument,
  clipId: string,
  input: { mesh: MeshData; rect: { minX: number; minY: number; maxX: number; maxY: number }; sideColor: string | null; material: Material },
): string | null {
  const loc = locateClip(doc, clipId);
  if (!loc || loc.clip.kind === "audio") return null;
  const src = loc.clip as VisualClip;
  const world = doc.frames.find((f) => f.id === src.frameId);
  if (!world?.world) return null;
  const { rect } = input;
  const w = Math.max(1, rect.maxX - rect.minX), h = Math.max(1, rect.maxY - rect.minY);
  // The comp the picture lives in now — its exact rectangle, transparent.
  const comp = createFrame({
    name: `${src.name || "Layer"} · surface`,
    width: Math.ceil(w),
    height: Math.ceil(h),
    background: "#00000000",
    pageId: internalPageId(doc),
    fps: frameFps(doc, world),
  });
  comp.fills = [];
  doc.frames.push(comp);
  // The unwrap in the comp's 0..1 (v up, as a texture reads it).
  const mesh = quantizeMesh(input.mesh);
  if (mesh.uv) mesh.uv = mesh.uv.map((v, i) => (i % 2 === 0 ? (v - rect.minX) / w : 1 - (v - rect.minY) / h));
  const t = src.transform;
  const meshClip = createMeshClip({ frameId: src.frameId, startMs: src.startMs, durationMs: src.durationMs, mesh, name: src.name });
  meshClip.transform = {
    ...meshClip.transform,
    x: t.x,
    y: t.y,
    z: t.z ?? 0,
    rotation: t.rotation,
    rotationX: t.rotationX,
    rotationY: t.rotationY,
    scale: t.scale,
    scaleY: t.scaleZ ?? null,
    scaleZ: t.scaleY ?? undefined,
  };
  meshClip.opacity = src.opacity;
  meshClip.material = { ...input.material };
  meshClip.texture = { frameId: comp.id, repeat: 1 };
  meshClip.fills = [solidPaint("#ffffff")];
  meshClip.uv = "planar";
  meshClip.animIn = src.animIn;
  meshClip.animOut = src.animOut;
  meshClip.constraints = src.constraints;
  meshClip.keyframes = src.keyframes.filter((k) => !k.range && PLACEMENT.has(k.property)).map((k) => ({ ...k, property: (MESH_CHANNEL[k.property] ?? k.property) as typeof k.property }));
  if (src.modulators) meshClip.modulators = src.modulators.filter((m) => PLACEMENT.has(m.target)).map((m) => ({ ...m, target: MESH_CHANNEL[m.target] ?? m.target }));
  if (input.sideColor && mesh.faceParts?.includes("side")) {
    meshClip.parts = [{ id: "side", name: "Sides", fills: [solidPaint(input.sideColor)] }];
  }
  // The layer, at rest, filling its comp — its picture is the texture now.
  src.keyframes = src.keyframes.filter((k) => k.range || !PLACEMENT.has(k.property));
  if (src.modulators) src.modulators = src.modulators.filter((m) => !PLACEMENT.has(m.target));
  src.transform = {
    ...t,
    x: -(rect.minX + rect.maxX) / 2 || 0,
    y: -(rect.minY + rect.maxY) / 2 || 0,
    z: undefined,
    rotation: 0,
    rotationX: undefined,
    rotationY: undefined,
    scale: 1,
    scaleY: null,
    scaleZ: undefined,
  };
  src.opacity = 1;
  src.animIn = null;
  src.animOut = null;
  src.constraints = undefined;
  src.extrude = undefined;
  src.material = undefined;
  src.modifiers = undefined;
  // The mesh takes the layer's slot; the layer moves into its comp.
  loc.track.clips[loc.clipIndex] = meshClip as Clip;
  src.frameId = comp.id;
  placeClip(doc, src as Clip, { landing: "surface" });
  return meshClip.id;
}
