import type { MotionDocument } from "../../schema";
import type { CameraScene, CameraSolution, CameraTracker } from "../../schema/tracking";
import type { Mat2D } from "../../navigation/matrix";
import { eulerFromRotation, type Mat4, type V3 as WV3 } from "../../world/math";
import { defaultCameraDistance } from "../../world/camera";
import { footageAt, type FootageView } from "../footage";
import { SENSOR_MM } from "./solve";
import { apply3, matFromQuat, mul3, quatFromMat, slerp, transpose3, vadd, vlen, vscale, vsub, type M3, type V3 } from "./linalg";

/**
 * READING A CAMERA SOLVE — where the shot's camera was, in a WORLD, at a comp
 * instant. The one place the solve's computer-vision frame meets the world's
 * Blender one (Z up, cameras looking down their −Z), so the follow bake, the
 * `track()` readings, the point cloud and the scene tools cannot disagree.
 *
 * Time goes through the footage's placement exactly as for a region track
 * (`footageAt`): the consumer's comp must show the footage — in "Make 3D
 * scene" the plate stands in the world as its backplate, so the world camera
 * and the footage share one time map, and retiming the plate retimes the
 * camera.
 */

/** CV camera axes (x right, y down, z forward) → world camera axes (x right, y up, looking down −z). */
const CV_TO_GL: M3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

export { SENSOR_MM };

export interface CameraPose {
  /** Camera-to-solve rotation (CV axes). */
  R: M3;
  /** Camera centre, solve units. */
  c: V3;
  /** Reprojection error here, px (interpolated between measured frames). */
  error: number;
  /** A frame the solve placed (not interpolated across a gap). */
  solved: boolean;
}

function poseAtIndex(s: CameraSolution, i: number): { q: number[]; c: V3 } {
  const o = i * 7;
  return { q: s.poses.slice(o, o + 4), c: [s.poses[o + 4]!, s.poses[o + 5]!, s.poses[o + 6]!] };
}

/** The solved camera at a source time: measured frames as stored, between them slerp + lerp; ends hold. */
export function cameraPoseAt(s: CameraSolution, sourceMs: number): CameraPose | null {
  const n = s.times.length;
  if (n === 0) return null;
  const at = (i: number, solved: boolean): CameraPose => {
    const p = poseAtIndex(s, i);
    return { R: matFromQuat(p.q), c: p.c, error: s.frameError[i] ?? s.error, solved };
  };
  if (sourceMs <= s.times[0]! + 0.5) return at(0, Math.abs(sourceMs - s.times[0]!) < 0.5);
  if (sourceMs >= s.times[n - 1]! - 0.5) return at(n - 1, Math.abs(sourceMs - s.times[n - 1]!) < 0.5);
  // Last measured frame at or before the time.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.times[mid]! <= sourceMs) lo = mid;
    else hi = mid;
  }
  const ta = s.times[lo]!;
  const tb = s.times[hi]!;
  if (Math.abs(sourceMs - ta) < 0.5) return at(lo, true);
  if (Math.abs(sourceMs - tb) < 0.5) return at(hi, true);
  const a = poseAtIndex(s, lo);
  const b = poseAtIndex(s, hi);
  const t = (sourceMs - ta) / Math.max(1e-9, tb - ta);
  return {
    R: matFromQuat(slerp(a.q, b.q, t)),
    c: vadd(a.c, vscale(vsub(b.c, a.c), t)),
    error: (s.frameError[lo] ?? s.error) * (1 - t) + (s.frameError[hi] ?? s.error) * t,
    solved: false,
  };
}

/**
 * The default placement of a solve in a world: its FIRST camera stands where
 * a world's default camera does — at (0, −D, 0) looking along +Y, level — and
 * the scene is scaled so the median point lies at that same distance D, where
 * one world unit is one plate pixel. Text dropped on a solved point is then
 * the size it would be on the plate.
 */
export function defaultCameraScene(s: CameraSolution): CameraScene {
  const first = poseAtIndex(s, 0);
  const R0 = matFromQuat(first.q);
  const D = defaultCameraDistance(s.width, s.height);
  // Median depth of the points in front of the first camera (tripod: directions, so 1).
  const depths: number[] = [];
  const Rt = transpose3(R0);
  for (let i = 0; i < s.points.length; i += 3) {
    const d = apply3(Rt, vsub([s.points[i]!, s.points[i + 1]!, s.points[i + 2]!], first.c))[2];
    if (d > 0) depths.push(d);
  }
  depths.sort((x, y) => x - y);
  const median = s.mode === "tripod" ? 1 : depths.length ? depths[depths.length >> 1]! : 1;
  const scale = D / Math.max(1e-9, median);
  // World ← solve rotation: the first camera's axes onto the default camera's (x → x, forward → +Y, down → −Z).
  const CV_TO_WORLD: M3 = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const Rs = mul3(CV_TO_WORLD, Rt);
  const c0 = vscale(apply3(Rs, first.c), scale);
  return { rotation: quatFromMat(Rs), scale, offset: [-c0[0], -D - c0[1], -c0[2]] };
}

export function cameraSceneOf(t: CameraTracker): CameraScene | null {
  return t.scene ?? (t.solution ? defaultCameraScene(t.solution) : null);
}

/** A solve-space point into the world. */
export function sceneToWorld(scene: CameraScene, p: V3): V3 {
  return vadd(vscale(apply3(matFromQuat(scene.rotation), p), scene.scale), scene.offset as V3);
}

/** Every solved point in world units, flat xyz (tripod directions pushed out to the default distance). */
export function cameraPointsInWorld(t: CameraTracker): Float64Array {
  const s = t.solution;
  const scene = cameraSceneOf(t);
  if (!s || !scene) return new Float64Array(0);
  const out = new Float64Array(s.points.length);
  for (let i = 0; i < s.points.length; i += 3) {
    let p: V3 = [s.points[i]!, s.points[i + 1]!, s.points[i + 2]!];
    if (s.mode === "tripod") p = vadd(poseAtIndex(s, 0).c, p);
    out.set(sceneToWorld(scene, p), i);
  }
  return out;
}

export interface CameraReadout {
  view: FootageView;
  /** World position and Blender XYZ Euler, degrees — a camera clip's own transform fields. */
  position: WV3;
  rotation: WV3;
  /** Camera-to-world matrix, column-major (what a camera clip's placement composes to). */
  matrix: Mat4;
  /** Lens in mm for a world camera framing the CONSUMER comp (36 mm across its long side). */
  focalLength: number;
  error: number;
  solved: boolean;
}

/** Comp px per plate px along the plate's x axis. */
function placementScale(m: Mat2D): number {
  return Math.hypot(m.a, m.b);
}

const memo = new WeakMap<MotionDocument, Map<string, CameraReadout | null>>();

/** The solved camera at a comp instant, in that comp's world. Null without a solution or with the plate off screen. */
export function cameraReadout(doc: MotionDocument, tracker: CameraTracker, compId: string, compMs: number): CameraReadout | null {
  const key = `${tracker.id}|${compId}|${compMs}`;
  let cache = memo.get(doc);
  if (!cache) memo.set(doc, (cache = new Map()));
  if (cache.has(key)) return cache.get(key)!;
  const out = computeCamera(doc, tracker, compId, compMs);
  if (cache.size > 512) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return out;
}

function computeCamera(doc: MotionDocument, tracker: CameraTracker, compId: string, compMs: number): CameraReadout | null {
  const s = tracker.solution;
  const scene = cameraSceneOf(tracker);
  if (!s || !scene) return null;
  const view = footageAt(doc, tracker, compId, compMs);
  if (!view) return null;
  const pose = cameraPoseAt(s, view.sourceMs);
  if (!pose) return null;
  const Rs = matFromQuat(scene.rotation);
  const Rw = mul3(mul3(Rs, pose.R), CV_TO_GL);
  const position = sceneToWorld(scene, pose.c);
  const matrix: Mat4 = [Rw[0]!, Rw[3]!, Rw[6]!, 0, Rw[1]!, Rw[4]!, Rw[7]!, 0, Rw[2]!, Rw[5]!, Rw[8]!, 0, position[0], position[1], position[2], 1];
  const comp = doc.frames.find((f) => f.id === compId);
  const long = comp ? Math.max(comp.width, comp.height) : Math.max(s.width, s.height);
  const focalCompPx = s.focalPx * placementScale(view.toComp);
  return {
    view,
    position,
    rotation: eulerFromRotation(matrix),
    matrix,
    focalLength: (focalCompPx * SENSOR_MM) / long,
    error: pose.error,
    solved: pose.solved,
  };
}

/** Where a world point lands on the plate at a source time, plate px — for checks and snapping. */
export function projectToPlate(t: CameraTracker, world: V3, sourceMs: number): { x: number; y: number } | null {
  const s = t.solution;
  const scene = cameraSceneOf(t);
  if (!s || !scene) return null;
  const pose = cameraPoseAt(s, sourceMs);
  if (!pose) return null;
  const Rs = matFromQuat(scene.rotation);
  // world → solve: p = Rsᵀ (w − offset) / scale
  const p = vscale(apply3(transpose3(Rs), vsub(world, scene.offset as V3)), 1 / scene.scale);
  const local = apply3(transpose3(pose.R), vsub(p, pose.c));
  if (local[2] <= 1e-9) return null;
  return { x: (s.focalPx * local[0]) / local[2] + s.width / 2, y: (s.focalPx * local[1]) / local[2] + s.height / 2 };
}

/**
 * The solve's points where the solved camera puts them on the plate at a
 * source time, plate px — the stage's check that the solve sits on the
 * picture. Points behind the camera or off the frame are left out.
 */
export function cameraPlatePoints(t: CameraTracker, sourceMs: number): Array<{ x: number; y: number; index: number }> {
  const s = t.solution;
  const pose = s ? cameraPoseAt(s, sourceMs) : null;
  if (!s || !pose) return [];
  const Rt = transpose3(pose.R);
  const out: Array<{ x: number; y: number; index: number }> = [];
  for (let i = 0; i < s.points.length; i += 3) {
    const p: V3 = [s.points[i]!, s.points[i + 1]!, s.points[i + 2]!];
    // Tripod points are directions: seen from the camera, not from a place.
    const local = apply3(Rt, s.mode === "tripod" ? p : vsub(p, pose.c));
    if (local[2] <= 1e-9) continue;
    const x = (s.focalPx * local[0]) / local[2] + s.width / 2;
    const y = (s.focalPx * local[1]) / local[2] + s.height / 2;
    if (x >= 0 && y >= 0 && x <= s.width && y <= s.height) out.push({ x, y, index: i / 3 });
  }
  return out;
}

/** Distance between two world points (scene tools, readouts). */
export const worldDistance = (a: V3, b: V3) => vlen(vsub(a, b));

