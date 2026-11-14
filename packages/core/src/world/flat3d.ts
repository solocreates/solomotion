import type { MotionDocument, Clip, GroupClip, Keyframe, VisualClip } from "../schema";
import { worldSpecSchema } from "../schema/world";
import { fxToken, parseFxToken } from "../schema/expressions";
import { parseVarToken } from "../schema/variables";
import { addExpression, expressionById } from "../expressions/document";
import { compileExpression } from "../expressions/bind";
import { GLOBALS_BY_NAME } from "../expressions/globals";
import { variablesByName } from "../expressions/scope";
import { exprTypeForVariable } from "../expressions/types";
import { sampleKeyframes } from "../animation/keyframes";
import { applyModulators } from "../animation/modulators";
import { isSpatialClip } from "../clip-registry";
import { compDurationMs, locateClip, nestClips } from "../timeline/ops";
import { frameFps } from "../timeline/fps";
import { internalPageId } from "../pages";
import { createNestedClip } from "../factories";
import { placeClip } from "../timeline/place";
import { createWorld, materializeDefaultCamera } from "./ops";
import { defaultCameraDistance } from "./camera";
import { composeTrs, decomposeTrs, mul4, rotation4, scale4, translate4, type Mat4, type V3 } from "./math";

/**
 * 2D LAYERS WITH DEPTH — After Effects' 3D switch, for a flat comp.
 *
 * A flat comp is a world seen from the front: x right, y down, z AWAY from
 * the viewer, origin at the frame centre, looked at by the DEFAULT camera
 * (`defaultCameraDistance`), at which depth 0 is exactly 1 px per px. So a
 * layer with no depth is drawn as it always was, and one with `z`,
 * `rotationX` or `rotationY` is the same picture standing in that space.
 *
 * Nothing new is stored: depth is three optional transform fields that key,
 * drive and modulate like every other. The picture keeps the 2D stack order
 * (a flat comp is a layout; a WORLD is where depth decides who is in front),
 * and `moveIntoWorld` turns the one into the other without moving a pixel.
 */

const DEPTH_PATHS = new Set(["z", "rotationX", "rotationY"]);

export interface LayerDepth {
  z: number;
  rotationX: number;
  rotationY: number;
}

/**
 * The layer's depth at a local instant, or null when it has none — the cheap
 * question every flat layer is asked per frame, answered from the stored
 * fields unless a depth channel actually animates.
 */
export function layerDepthAt(clip: VisualClip, localMs: number): LayerDepth | null {
  if (isSpatialClip(clip)) return null;
  const t = clip.transform;
  const keyed = clip.keyframes.some((k) => !k.range && DEPTH_PATHS.has(k.property));
  const mods = clip.modulators?.some((m) => m.enabled && DEPTH_PATHS.has(m.target)) ?? false;
  let z = t.z ?? 0;
  let rotationX = t.rotationX ?? 0;
  let rotationY = t.rotationY ?? 0;
  if (keyed || mods) {
    const sampled = keyed ? sampleKeyframes(clip.keyframes.filter((k) => !k.range && DEPTH_PATHS.has(k.property)), localMs) : {};
    const read = (p: string, base: number) => {
      const v = typeof sampled[p] === "number" ? (sampled[p] as number) : base;
      return mods ? applyModulators(clip.modulators, p, v, localMs / 1000, sampled) : v;
    };
    z = read("z", z);
    rotationX = read("rotationX", rotationX);
    rotationY = read("rotationY", rotationY);
  }
  if (z === 0 && rotationX === 0 && rotationY === 0) return null;
  return { z, rotationX, rotationY };
}

/** The 2D half of a placement — what the flat renderer already resolved. */
export interface FlatPose {
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
}

/** The in/out animation's pose (core `layerPoseAt`). */
export interface FlatAnimPose {
  dx: number;
  dy: number;
  rotation: number;
  scale: number;
}

/**
 * The layer's plane in comp space: a point (u, v) of its picture, in px about
 * its pivot, goes to `M · (u, v, 0)`. The in/out pose is applied the way a
 * world applies it — along the screen, at the layer's depth, spinning about
 * the line of sight — so a slide reads as a slide however the layer is turned,
 * and the same layer moved into a world plays the same.
 */
export function flatLayerMatrix(pose: FlatPose, depth: LayerDepth, width: number, height: number, anim?: FlatAnimPose | null): Mat4 {
  const origin: V3 = [pose.x, pose.y, depth.z];
  const m = composeTrs({
    position: origin,
    rotation: [depth.rotationX, depth.rotationY, pose.rotation],
    scale: [pose.scaleX, pose.scaleY, 1],
  });
  if (!anim || (anim.dx === 0 && anim.dy === 0 && anim.rotation === 0 && anim.scale === 1)) return m;
  const D = defaultCameraDistance(width, height);
  const k = Math.max(1e-3, D + depth.z) / D;
  const about = mul4(
    mul4(translate4([origin[0] + anim.dx * k, origin[1] + anim.dy * k, origin[2]]), mul4(rotation4(0, 0, anim.rotation), scale4([anim.scale, anim.scale, anim.scale]))),
    translate4([-origin[0], -origin[1], -origin[2]]),
  );
  return mul4(about, m);
}

/**
 * The default camera's projection: a comp-space point to frame px (top-left
 * origin), or null when it is at or behind the lens.
 */
export function projectFlat(p: V3, width: number, height: number): { x: number; y: number } | null {
  const D = defaultCameraDistance(width, height);
  const w = D + p[2];
  if (w < 1) return null;
  const k = D / w;
  return { x: width / 2 + p[0] * k, y: height / 2 + p[1] * k };
}

// ── Into a world ─────────────────────────────────────────────────────────────

/** Flat comp space → world space: x stays, flat z (away) is world y, flat y (down) is world −z. */
const C: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const C_INV: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];

/**
 * A flat layer's placement as a world plane's. A picture plane lies on its
 * local XZ facing −Y — the flat plane carried through the same change of axes
 * — so the world placement is C · M · C⁻¹, and the default camera sees the
 * plane exactly where the flat comp drew it. Scale needs no conversion: the
 * plane's own scale mapping already does it.
 */
export function flatPlacementToWorld(t: { x: number; y: number; z?: number; rotationX?: number; rotationY?: number; rotation: number }): { position: V3; rotation: V3 } {
  const m = mul4(mul4(C, composeTrs({ position: [t.x, t.y, t.z ?? 0], rotation: [t.rotationX ?? 0, t.rotationY ?? 0, t.rotation], scale: [1, 1, 1] })), C_INV);
  const trs = decomposeTrs(m);
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6);
  return { position: trs.position.map(clean) as V3, rotation: trs.rotation.map(clean) as V3 };
}

/**
 * Channel by channel, the same change of axes for what ANIMATES. Exact for
 * every combination but one: a 2D rotation together with a Y tilt (Euler
 * order cannot carry that pair through a change of axes channel-wise), which
 * comes out close rather than equal.
 */
const CHANNEL_MAP: Record<string, { to: string; flip: boolean }> = {
  y: { to: "z", flip: true },
  z: { to: "y", flip: false },
  rotation: { to: "rotationY", flip: false },
  rotationY: { to: "rotation", flip: true },
};

/**
 * A DRIVER ON A FLIPPED CHANNEL, NEGATED. A driver is a token pointing into a
 * document table, not source, so a minus sign cannot just be written in front
 * of it (`-(fx:…)` names nothing, and the channel silently stops moving).
 * Instead each flavour gets a new expression row that reads the old value
 * negated, and the channel is bound to that:
 *
 *  - `fx:` — the original's own source with its RESULT wrapped in `-(…)`,
 *    spliced around the parsed result so leading `#locals` and a trailing
 *    `// comment` survive. The original row is left alone: other slots may
 *    share it. random()/wiggle() seed from the row's id and each call's offset,
 *    so the copy wobbles with its own (equally steady) pattern.
 *  - `var:` — `-#"name"`. The language names variables by NAME, so unlike the
 *    token this does not follow a later rename; a variable an expression
 *    cannot read as that number (gone, not a number, a name a built-in or
 *    another variable shadows) keeps its token un-negated.
 *  - `expr:` — the language cannot name a graph, so a graph-driven channel
 *    keeps its token un-negated and drives its new axis the other way.
 *
 * One row per original token per move, so layers that shared a driver still do.
 */
function driverNegator(doc: MotionDocument): (token: string) => string {
  const made = new Map<string, string>();
  const negate = (token: string): string => {
    const fxId = parseFxToken(token);
    if (fxId) {
      const original = expressionById(doc, fxId);
      const result = original && compileExpression(original.source).result;
      if (!original || !result) return token;
      const { start, end } = result.span;
      const src = original.source;
      const source = `${src.slice(0, start)}-(${src.slice(start, end)})${src.slice(end)}`;
      return fxToken(addExpression(doc, source, original.name && `${original.name} · 3D`).id);
    }
    const varId = parseVarToken(token);
    if (varId) {
      const v = doc.variables.find((x) => x.id === varId);
      const readable = !!v && exprTypeForVariable(v.type) === "float" && !GLOBALS_BY_NAME.has(v.name) && variablesByName(doc.variables).get(v.name.trim().toLowerCase()) === v;
      if (!readable) return token;
      const quoted = v.name.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
      return fxToken(addExpression(doc, `-#"${quoted}"`).id);
    }
    return token;
  };
  return (token) => {
    let next = made.get(token);
    if (next === undefined) made.set(token, (next = negate(token)));
    return next;
  };
}

/**
 * A FLAT RIG carried into a world by the same change of axes as its art: every
 * bone frame F becomes C·F·C⁻¹ (so a child's rest, written in its parent's
 * frame, converts the same way as a root's), which makes a flat bone's turn a
 * turn about world Y (its pitch), its move down the screen a move down in Z,
 * and its thickness the depth axis. Keys, modulators and limits follow channel
 * by channel; painted strokes live in each layer's own 2D space and need
 * nothing. Exact: the rig bends the converted art exactly as it bent the flat.
 */
const BONE_CHANNEL_MAP: Record<string, { to: string; flip: boolean }> = {
  y: { to: "z", flip: true },
  rotation: { to: "rotationY", flip: false },
  scaleY: { to: "scaleZ", flip: false },
};

function convertRigToWorld(group: GroupClip, negate: (token: string) => string): void {
  const rig = group.rig;
  if (!rig) return;
  const scaleKeyed = new Set(group.keyframes.filter((k) => /^bone\.[^.]+\.scale$/.test(k.property)).map((k) => k.property.split(".")[1]));
  rig.bones = rig.bones.map((b) => {
    const w = flatPlacementToWorld({ x: b.rest.x, y: b.rest.y, rotation: b.rest.rotation });
    const rest = { ...b.rest, x: w.position[0], y: w.position[1], z: w.position[2], rotationX: w.rotation[0], rotationY: w.rotation[1], rotation: w.rotation[2] };
    let pose = b.pose;
    if (pose || scaleKeyed.has(b.id)) {
      const p = pose ?? { x: 0, y: 0, rotation: 0, scale: 1, scaleY: null };
      // A flat bone never stretched in depth: world Y (the old depth) stays 1, its thickness is world Z now.
      pose = { ...p, x: p.x, y: 0, z: -p.y || 0, rotation: 0, rotationY: p.rotation, rotationX: 0, scale: p.scale, scaleY: 1, scaleZ: p.scaleY };
    }
    let limits = b.limits;
    if (limits) {
      const { y, rotation, scaleY, ...rest2 } = limits;
      limits = { ...rest2, ...(y && { z: [-y[1], -y[0]] as [number, number] }), ...(rotation && { rotationY: rotation }), ...(scaleY && { scaleZ: scaleY }) };
    }
    // A point a constraint looks at goes through the same axes: flat (x, y) is world (x, 0, −y).
    const constraints = b.constraints?.map((c) => (c.target.kind === "point" ? { ...c, target: { kind: "point" as const, x: c.target.x, y: 0, z: -c.target.y || 0 } } : c));
    return { ...b, rest, pose, limits, ...(constraints && { constraints }) };
  });
  const remap = (path: string): { to: string; flip: boolean } | null => {
    const m = /^bone\.([^.]+)\.(.+)$/.exec(path);
    const map = m ? BONE_CHANNEL_MAP[m[2]!] : undefined;
    return m && map ? { to: `bone.${m[1]}.${map.to}`, flip: map.flip } : null;
  };
  group.keyframes = group.keyframes.map((track) => {
    const map = !track.range ? remap(track.property) : null;
    if (!map) return track;
    return { ...track, property: map.to as typeof track.property, keys: map.flip ? track.keys.map((k) => ({ ...k, value: typeof k.value === "number" ? -k.value : k.value })) : track.keys };
  });
  if (group.modulators) {
    group.modulators = group.modulators.map((m) => {
      const map = remap(m.target);
      if (!map) return m;
      return map.flip ? { ...m, target: map.to, amount: -m.amount, offset: -m.offset } : { ...m, target: map.to };
    });
  }
  if (group.drivers) {
    // A driver moves with its channel, negated where the channel flips (`driverNegator`).
    const next: Record<string, string> = {};
    for (const [path, token] of Object.entries(group.drivers)) {
      const map = remap(path);
      next[map?.to ?? path] = map?.flip ? negate(token) : token;
    }
    group.drivers = next;
  }
}

function convertClipToWorld(clip: VisualClip, negate: (token: string) => string): void {
  if (clip.kind === "group") convertRigToWorld(clip, negate);
  const t = clip.transform;
  const rotationKeyed = clip.keyframes.some((k) => k.property === "rotation" || k.property === "rotationX" || k.property === "rotationY");
  if (rotationKeyed) {
    const r = { x: t.rotationX ?? 0, y: t.rotationY ?? 0, z: t.rotation };
    clip.transform = { ...t, x: t.x, y: t.z ?? 0, z: -t.y, rotationX: r.x || undefined, rotationY: r.z || undefined, rotation: -r.y || 0 };
  } else {
    const w = flatPlacementToWorld(t);
    clip.transform = {
      ...t,
      x: w.position[0],
      y: w.position[1],
      z: w.position[2] || undefined,
      rotationX: w.rotation[0] || undefined,
      rotationY: w.rotation[1] || undefined,
      rotation: w.rotation[2],
    };
  }
  if (!clip.transform.y) clip.transform.y = 0;
  // Remap every animated channel — keys, drivers, modulators — through one table.
  // A driver on a flipped channel is bound to a negated copy (`driverNegator`).
  // The 2D motion-path handles on `x` keys are (x, y) handles; y is depth now.
  clip.keyframes = clip.keyframes.map((track) => {
    const map = !track.range ? CHANNEL_MAP[track.property] : undefined;
    const keys: Keyframe[] = track.property === "x" ? track.keys.map((k) => ({ ...k, spatial: null })) : track.keys;
    if (!map) return track.property === "x" ? { ...track, keys } : track;
    return {
      ...track,
      property: map.to as typeof track.property,
      keys: map.flip ? keys.map((k) => ({ ...k, value: typeof k.value === "number" ? -k.value : k.value })) : keys,
    };
  });
  if (clip.drivers) {
    const next: Record<string, string> = {};
    for (const [path, token] of Object.entries(clip.drivers)) {
      const map = CHANNEL_MAP[path];
      next[map?.to ?? path] = map?.flip ? negate(token) : token;
    }
    clip.drivers = next;
  }
  if (clip.modulators) {
    clip.modulators = clip.modulators.map((m) => {
      const map = CHANNEL_MAP[m.target];
      if (!map) return m;
      return map.flip ? { ...m, target: map.to, amount: -m.amount, offset: -m.offset } : { ...m, target: map.to };
    });
  }
}

/**
 * MOVE INTO A 3D WORLD — the layers (one comp) become picture planes in a new
 * transparent world the comp's own size, nested where they were. The world
 * has no camera, so the default one sees them exactly as the flat comp drew
 * them; from there they can be turned, pushed back, lit by nothing (pictures
 * are unlit) and shot with real cameras. Returns the nested layer and the
 * world, or null when nothing could move.
 */
export function moveIntoWorld(
  doc: MotionDocument,
  clipIds: string[],
  name?: string,
  /** `wholeComp`: the world spans the parent comp's whole length (a frame made 3D), not just its layers'. */
  opts: { wholeComp?: boolean } = {},
): { nestedId: string; frameId: string } | null {
  const ids = clipIds.filter((id) => {
    const c = locateClip(doc, id)?.clip;
    return !!c && c.kind !== "audio" && c.kind !== "adjustment" && !isSpatialClip(c);
  });
  if (ids.length === 0) return null;
  const parent = doc.frames.find((f) => f.id === locateClip(doc, ids[0]!)!.clip.frameId);
  if (!parent || parent.world) return null;
  const nestedId = nestClips(doc, ids, name, { fullFrame: true, wholeComp: opts.wholeComp });
  if (!nestedId) return null;
  const nested = locateClip(doc, nestedId)?.clip;
  if (!nested || nested.kind !== "nested") return null;
  const world = doc.frames.find((f) => f.id === nested.sourceFrameId);
  if (!world) return null;
  world.world = worldSpecSchema.parse({});
  world.background = "#00000000";
  world.fills = [];
  const negate = driverNegator(doc);
  for (const track of doc.tracks) {
    for (const c of track.clips as Clip[]) {
      if (c.frameId !== world.id || c.kind === "audio") continue;
      convertClipToWorld(c as VisualClip, negate);
    }
  }
  // A world always opens WITH its camera, as a layer: the one that frames the
  // comp exactly as the flat comp did. A derived "default camera" you could look
  // through but not move, lock or key read as a camera that was broken.
  materializeDefaultCamera(doc, world.id);
  return { nestedId, frameId: world.id };
}

/**
 * A WHOLE FRAME INTO 3D — every layer of a flat frame moves into one new world
 * nested full-frame inside it, for the comp's whole length. The frame itself
 * stays: it is the WRAPPER the world lives in (a root frame keeps its place
 * on the board, its size, its export settings), so making the main frame 3D is
 * one nesting step and never a change of what the frame is. A frame with
 * nothing in it gets a fresh world instead (`addWorldClip`).
 */
export function frameIntoWorld(doc: MotionDocument, frameId: string, name?: string): { nestedId: string; frameId: string } | null {
  const frame = doc.frames.find((f) => f.id === frameId);
  if (!frame || frame.world) return null;
  const ids = doc.tracks
    .filter((t) => !t.groupId)
    .flatMap((t) => t.clips)
    .filter((c) => c.frameId === frameId && c.kind !== "audio" && c.kind !== "adjustment" && !isSpatialClip(c))
    .map((c) => c.id);
  const title = name ?? `${frame.name || "Frame"} · 3D`;
  if (ids.length === 0) return addWorldClip(doc, frameId, { name: title });
  return moveIntoWorld(doc, ids, title, { wholeComp: true });
}

/**
 * A NEW WORLD AS A LAYER — Blender's starter scene (camera, light, studio, a
 * cube) in a world comp the parent's size, nested full-frame in it from
 * `startMs`. What "+ Clip › 3D world" adds: a 3D scene is one more kind of
 * layer, not a different kind of project.
 */
export function addWorldClip(
  doc: MotionDocument,
  frameId: string,
  opts: { name?: string; startMs?: number; durationMs?: number; transparent?: boolean } = {},
): { nestedId: string; frameId: string } | null {
  const parent = doc.frames.find((f) => f.id === frameId);
  if (!parent) return null;
  const durationMs = Math.max(500, opts.durationMs ?? compDurationMs(doc, frameId) - (opts.startMs ?? 0));
  const { frame: world } = createWorld(doc, {
    name: opts.name ?? "3D world",
    width: parent.width,
    height: parent.height,
    durationMs,
    fps: frameFps(doc, parent),
    pageId: internalPageId(doc),
    transparent: opts.transparent ?? true,
  });
  const nested = createNestedClip({ frameId, sourceFrameId: world.id, startMs: opts.startMs ?? 0, durationMs, name: world.name });
  placeClip(doc, nested, { landing: "surface" });
  return { nestedId: nested.id, frameId: world.id };
}
