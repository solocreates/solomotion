import type { MotionDocument, Clip, VisualClip } from "../../schema";
import type { CameraTracker } from "../../schema/tracking";
import { createId } from "../../ids";
import { createNestedClip, createTextClip } from "../../factories";
import { placeClip } from "../../timeline/place";
import { clipBox, cloneClip, reissueClipIds } from "../../timeline/ops";
import { compFps } from "../../timeline/fps";
import { internalPageId } from "../../pages";
import { createCameraClip, createLightClip, createWorld } from "../../world/ops";
import { eulerFromRotation, type Mat4 } from "../../world/math";
import { defaultCameraDistance } from "../../world/camera";
import { footageAt, footageClips, sourceToComp } from "../footage";
import { cameraPlatePoints, cameraPointsInWorld, cameraReadout } from "./read-camera";
import { symEig, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type V3 } from "./linalg";

/**
 * MAKE 3D SCENE — a camera solve becomes a world you can put things in.
 *
 * One gesture builds what After Effects' "Create camera" and Blender's "Setup
 * tracking scene" build, as ordinary layers:
 *
 *   a WORLD the plate's size, with the footage inside it as its BACKPLATE
 *   (`backplate`: drawn flat behind the scene, with its own time map — so the
 *   camera and the plate share one clock, and retiming the plate retimes the
 *   camera), a CAMERA that follows the solve (position, rotation, lens), a sun
 *   and a soft studio, and a shadow-catching floor once the ground is known;
 *
 *   NESTED where the footage was, over its span, with its placement — and the
 *   original footage hidden, not removed: its 2D trackers, followers and sound
 *   keep working, and nothing decodes the plate twice.
 */

export interface CameraSceneIds {
  worldId: string;
  nestedId: string;
  cameraId: string;
  plateId: string;
}

function cameraOf(doc: MotionDocument, id: string): CameraTracker | null {
  const t = doc.trackers.find((x) => x.id === id);
  return t?.kind === "camera" ? t : null;
}

/** Worlds whose camera follows this solve. */
export function worldsFollowing(doc: MotionDocument, trackerId: string): string[] {
  const out = new Set<string>();
  for (const track of doc.tracks) for (const c of track.clips) if (c.kind === "camera" && c.trackBinding?.trackerId === trackerId) out.add(c.frameId);
  return [...out];
}

export function makeCameraScene(doc: MotionDocument, trackerId: string, opts: { footageClipId?: string; name?: string } = {}): CameraSceneIds | null {
  const tracker = cameraOf(doc, trackerId);
  if (!tracker?.solution) return null;
  const all = footageClips(doc, tracker).filter((c) => !doc.frames.find((f) => f.id === c.frameId)?.world);
  const footage = all.find((c) => c.id === (opts.footageClipId ?? tracker.via)) ?? all[0];
  if (!footage || footage.kind !== "video") return null;
  const asset = doc.assets.find((a) => a.id === footage.assetId);
  const width = asset?.width ?? tracker.solution.width;
  const height = asset?.height ?? tracker.solution.height;
  const span = { startMs: 0, durationMs: footage.durationMs };

  const { frame: world } = createWorld(doc, {
    name: opts.name ?? `${footage.name || "Footage"} · 3D`,
    width,
    height,
    durationMs: footage.durationMs,
    fps: compFps(doc, footage.frameId),
    starter: false,
    transparent: true,
    // A comp that exists to be nested lives on the internal page, off the board (as `addWorldClip`'s do).
    pageId: internalPageId(doc),
  });

  // The plate: the footage itself, at rest in the world's frame, with its time map, effects and crop.
  const plate = reissueClipIds(footage) as VisualClip;
  plate.frameId = world.id;
  plate.startMs = 0;
  plate.name = "Plate";
  plate.backplate = true;
  plate.locked = true;
  plate.hidden = false;
  plate.trackBinding = null;
  plate.transform = { ...plate.transform, x: 0, y: 0, scale: 1, scaleY: null, rotation: 0, skewX: 0, skewY: 0, z: 0, rotationX: 0, rotationY: 0, scaleZ: null };
  plate.keyframes = plate.keyframes.filter((k) => !isPlacementPath(k.property));
  // The sound stays with the footage in its own comp.
  if ("audioMix" in plate && plate.audioMix) plate.audioMix = { ...plate.audioMix, muted: true };
  placeClip(doc, plate as Clip, { newLaneEdge: "bottom" });

  const camera = createCameraClip({ frameId: world.id, ...span, name: tracker.name, position: [0, -defaultCameraDistance(width, height), 0], rotation: [90, 0, 0] });
  camera.fillDuration = true;
  camera.trackBinding = { trackerId, channels: ["position", "rotation", "lens"], offset: { x: 0, y: 0 }, smooth: 0, invert: false, enabled: true };
  placeClip(doc, camera, { landing: "surface" });

  const sun = createLightClip({ frameId: world.id, ...span, type: "sun", name: "Sun", position: [600, -900, 1600], rotation: [40, 0, 30], intensity: 3 });
  const studio = createLightClip({ frameId: world.id, ...span, type: "environment", name: "Studio", intensity: 0.45 });
  for (const l of [sun, studio]) {
    l.fillDuration = true;
    placeClip(doc, l, { landing: "surface" });
  }
  if (tracker.scene && world.world) world.world.render.floor = { ...world.world.render.floor, mode: "shadow", z: 0 };

  const nested = createNestedClip({ frameId: footage.frameId, sourceFrameId: world.id, startMs: footage.startMs, durationMs: footage.durationMs, name: world.name });
  // Where the footage stood, box and all: footage is fitted by its BOX (a plate dropped
  // into a smaller comp keeps scale 1 and a smaller box), the world by its size — so the
  // nested world takes the footage's placement times the box-to-world ratio.
  const placed = cloneClip(footage) as VisualClip;
  const box = clipBox(doc, footage);
  const kx = box.width / width;
  const ky = box.height / height;
  nested.transform = { ...placed.transform, scale: placed.transform.scale * kx, scaleY: (placed.transform.scaleY ?? placed.transform.scale) * ky };
  nested.keyframes = placed.keyframes
    .filter((k) => isPlacementPath(k.property))
    .map((k) => (k.property === "scale" || k.property === "scaleY" ? { ...k, keys: k.keys.map((f) => (typeof f.value === "number" ? { ...f, value: f.value * (k.property === "scale" ? kx : ky) } : f)) } : k));
  placeClip(doc, nested, { aboveClipId: footage.id });
  footage.hidden = true;
  return { worldId: world.id, nestedId: nested.id, cameraId: camera.id, plateId: plate.id };
}

const PLACEMENT = new Set(["x", "y", "z", "scale", "scaleY", "scaleZ", "rotation", "rotationX", "rotationY", "skewX", "skewY", "anchor.x", "anchor.y", "opacity"]);
const isPlacementPath = (p: string) => PLACEMENT.has(p);

/** The ground was set: worlds built on this solve catch shadows on it. */
export function catchShadowsOnGround(doc: MotionDocument, trackerId: string): void {
  for (const id of worldsFollowing(doc, trackerId)) {
    const f = doc.frames.find((x) => x.id === id);
    if (f?.world && f.world.render.floor.mode === "none") f.world.render.floor = { ...f.world.render.floor, mode: "shadow", z: 0 };
  }
}

/**
 * TEXT IN THE SHOT — a text layer standing on the picked solve points: at
 * their centre, lying on their plane when there are three or more (a wall, a
 * floor, a tabletop), else facing the camera; sized so it reads on the plate
 * as it would in a flat comp. Returns the new layer's id.
 */
export function placeTextOnSolvedPoints(
  doc: MotionDocument,
  trackerId: string,
  worldId: string,
  points: number[],
  atMs: number,
  text = "Text",
): string | null {
  const tracker = cameraOf(doc, trackerId);
  const world = doc.frames.find((f) => f.id === worldId);
  if (!tracker?.solution || !world?.world || points.length === 0) return null;
  const all = cameraPointsInWorld(tracker);
  const P = points.filter((i) => 3 * i + 2 < all.length).map((i): V3 => [all[3 * i]!, all[3 * i + 1]!, all[3 * i + 2]!]);
  if (!P.length) return null;
  const c = vscale(P.reduce(vadd, [0, 0, 0] as V3), 1 / P.length);
  const cam = cameraReadout(doc, tracker, worldId, atMs);
  const eye: V3 = cam ? cam.position : [0, -defaultCameraDistance(world.width, world.height), 0];
  // Camera's right in the world (its matrix's first column).
  const camRight: V3 = cam ? [cam.matrix[0]!, cam.matrix[1]!, cam.matrix[2]!] : [1, 0, 0];
  let front = vnorm(vsub(eye, c));
  if (P.length >= 3) {
    const C = new Float64Array(9);
    for (const p of P) {
      const d = vsub(p, c);
      for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) C[r * 3 + q] = C[r * 3 + q]! + d[r]! * d[q]!;
    }
    const { values, vectors } = symEig(C, 3);
    if (values[1]! > 1e-9) {
      const n = vnorm([vectors[0]!, vectors[3]!, vectors[6]!]);
      front = vdot(n, front) >= 0 ? n : vscale(n, -1);
    }
  }
  // A picture plane's front faces its local −Y: local X → right, local −Y → front, Z = X × Y.
  let right = vsub(camRight, vscale(front, vdot(camRight, front)));
  if (vlen(right) < 1e-6) right = vcross([0, 0, 1], front);
  right = vnorm(right);
  const y = vscale(front, -1);
  const z = vcross(right, y);
  const m: Mat4 = [right[0], right[1], right[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
  const [rx, ry, rz] = eulerFromRotation(m);
  // At depth d one unit spans D/d of what it spans at the default distance D, where 1 unit = 1 px.
  const scale = vlen(vsub(eye, c)) / defaultCameraDistance(world.width, world.height);
  const clip = createTextClip({ frameId: worldId, text, startMs: 0, durationMs: Math.max(1000, (world.durationMs ?? 5000)) });
  clip.name = text;
  clip.fillDuration = true;
  clip.transform = { ...clip.transform, x: c[0], y: c[1], z: c[2], rotationX: rx, rotationY: ry, rotation: rz, scale, scaleY: null, scaleZ: null };
  placeClip(doc, clip, { landing: "surface" });
  return clip.id;
}

/**
 * SOLVED POINTS UNDER COMP POSITIONS — what a click on the plate picks, for a
 * caller that has positions instead of a pointer (an agent reading a rendered
 * frame). Each position snaps to the nearest solve point the camera puts on
 * the plate at `compMs`; `missPx` is how far it had to reach, comp px.
 */
export function solvedPointsNear(
  doc: MotionDocument,
  trackerId: string,
  compId: string,
  compMs: number,
  at: ReadonlyArray<{ x: number; y: number }>,
): Array<{ index: number; x: number; y: number; missPx: number } | null> {
  const tracker = cameraOf(doc, trackerId);
  const view = tracker?.solution ? footageAt(doc, tracker, compId, compMs) : null;
  if (!tracker || !view) return at.map(() => null);
  const dots = cameraPlatePoints(tracker, view.sourceMs).map((p) => ({ index: p.index, ...sourceToComp(view, p) }));
  return at.map((q) => {
    let best: { index: number; x: number; y: number; missPx: number } | null = null;
    for (const d of dots) {
      const miss = Math.hypot(d.x - q.x, d.y - q.y);
      if (!best || miss < best.missPx) best = { ...d, missPx: miss };
    }
    return best;
  });
}
