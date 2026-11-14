import type { MotionDocument } from "../../schema";
import type { CameraScene, CameraSolution, CameraSolve, CameraTracker, TrackSpan } from "../../schema/tracking";
import { createId } from "../../ids";
import { nextTrackerColor } from "../palette";
import { findVisualClip, mergeSpans } from "../ops";
import { cameraPointsInWorld, cameraSceneOf } from "./read-camera";
import { apply3, matFromQuat, mul3, quatFromMat, symEig, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type M3, type V3 } from "./linalg";

/**
 * CAMERA TRACKER OPS — document edits for the camera solve: create one on a
 * plate, commit a run, change how it solves, and the SCENE TOOLS that stand
 * the solve up in a world (ground, origin, scale). Each is one draft-mutating
 * function the app wraps in one labelled update.
 */

function getCamera(doc: MotionDocument, id: string): CameraTracker | null {
  const t = doc.trackers.find((x) => x.id === id);
  return t?.kind === "camera" ? t : null;
}

/** A camera tracker on the footage `clipId` shows. Null unless the clip is a video. */
export function createCameraTracker(doc: MotionDocument, input: { clipId: string; name?: string; solve?: Partial<CameraSolve> }): CameraTracker | null {
  const clip = findVisualClip(doc, input.clipId);
  if (!clip || clip.kind !== "video") return null;
  const n = doc.trackers.filter((t) => t.kind === "camera").length;
  const tracker: CameraTracker = {
    kind: "camera",
    id: createId("tracker"),
    name: input.name ?? (n ? `Camera ${n + 1}` : "Camera"),
    color: nextTrackerColor(doc.trackers.length),
    source: { kind: "asset", assetId: clip.assetId },
    via: clip.id,
    solve: { mode: "auto", focalLength: null, features: 400, analysisEdge: 960, ...input.solve },
    solution: null,
    scene: null,
    analysis: null,
    dirty: true,
  };
  doc.trackers.push(tracker);
  return tracker;
}

/** A run's solution replaces the last one (a solve is whole-shot; there is nothing to merge). */
export function commitCameraSolve(doc: MotionDocument, id: string, solution: CameraSolution, solved: TrackSpan[]): void {
  const t = getCamera(doc, id);
  if (!t) return;
  t.solution = solution;
  // A placement made for the old solve's frame means nothing in the new one.
  t.scene = null;
  t.analysis = { version: t.analysis?.version ?? 0, engine: "cpu", coverage: mergeSpans(solved), at: Date.now() };
  t.dirty = false;
}

export function setCameraSolve(doc: MotionDocument, id: string, patch: Partial<CameraSolve>): void {
  const t = getCamera(doc, id);
  if (!t) return;
  t.solve = { ...t.solve, ...patch };
  t.dirty = true;
}

// ── Scene tools ──────────────────────────────────────────────────────────────

/** Compose a world-space similarity (s·R·w + o) onto the tracker's current placement. */
function composeScene(t: CameraTracker, s: number, R: M3, o: V3): void {
  const cur = cameraSceneOf(t);
  if (!cur) return;
  const Rc = matFromQuat(cur.rotation);
  const next: CameraScene = {
    rotation: quatFromMat(mul3(R, Rc)),
    scale: cur.scale * s,
    offset: vadd(vscale(apply3(R, cur.offset as V3), s), o) as [number, number, number],
  };
  t.scene = next;
}

function worldPoint(t: CameraTracker, index: number): V3 | null {
  const all = cameraPointsInWorld(t);
  if (index < 0 || 3 * index + 2 >= all.length) return null;
  return [all[3 * index]!, all[3 * index + 1]!, all[3 * index + 2]!];
}

/** The rotation turning unit vector `a` onto `b` (the shortest arc). */
function rotationOnto(a: V3, b: V3): M3 {
  const v = vcross(a, b);
  const c = vdot(a, b);
  const s = vlen(v);
  if (s < 1e-12) return c > 0 ? [1, 0, 0, 0, 1, 0, 0, 0, 1] : [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const k = vscale(v, 1 / s);
  const C = 1 - c;
  const [x, y, z] = k;
  return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C];
}

/**
 * SET GROUND — the points named (three or more, picked on the floor) become
 * the world's ground plane: the scene turns so the plane is level (normal
 * +Z) and moves so it lies at z = 0. The camera stays above it. Returns the
 * plane fit's RMS distance (world units) or null when the points do not span
 * a plane.
 */
export function setCameraGround(doc: MotionDocument, id: string, points: number[]): number | null {
  const t = getCamera(doc, id);
  if (!t || points.length < 3) return null;
  const P = points.map((i) => worldPoint(t, i)).filter((p): p is V3 => !!p);
  if (P.length < 3) return null;
  const c = vscale(P.reduce(vadd, [0, 0, 0] as V3), 1 / P.length);
  const C = new Float64Array(9);
  for (const p of P) {
    const d = vsub(p, c);
    for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) C[r * 3 + q] = C[r * 3 + q]! + d[r]! * d[q]!;
  }
  const { values, vectors } = symEig(C, 3);
  if (!(values[1]! > 1e-9)) return null; // collinear
  let n = vnorm([vectors[0]!, vectors[3]!, vectors[6]!]);
  // Up is the side the camera is on (at the first frame).
  const cam = t.solution ? cameraPointsInWorldCamera(t) : null;
  if (cam && vdot(vsub(cam, c), n) < 0) n = vscale(n, -1);
  const R = rotationOnto(n, [0, 0, 1]);
  const rc = apply3(R, c);
  composeScene(t, 1, R, [0, 0, -rc[2]]);
  return Math.sqrt(Math.max(0, values[0]!) / P.length);
}

/** Where the first solved camera stands in the world. */
function cameraPointsInWorldCamera(t: CameraTracker): V3 | null {
  const s = t.solution;
  const scene = cameraSceneOf(t);
  if (!s || !scene || !s.poses.length) return null;
  const c: V3 = [s.poses[4]!, s.poses[5]!, s.poses[6]!];
  return vadd(vscale(apply3(matFromQuat(scene.rotation), c), scene.scale), scene.offset as V3);
}

/** SET ORIGIN — this point becomes (0, 0, 0). Pick a point on the floor after Set ground and the floor stays at z = 0. */
export function setCameraOrigin(doc: MotionDocument, id: string, point: number): boolean {
  const t = getCamera(doc, id);
  const p = t ? worldPoint(t, point) : null;
  if (!t || !p) return false;
  composeScene(t, 1, [1, 0, 0, 0, 1, 0, 0, 0, 1], [-p[0], -p[1], -p[2]]);
  return true;
}

/** SET SCALE — the distance between two points is `distance` world units (1 unit = 1 cm). Scales about the origin. */
export function setCameraScale(doc: MotionDocument, id: string, a: number, b: number, distance: number): boolean {
  const t = getCamera(doc, id);
  const pa = t ? worldPoint(t, a) : null;
  const pb = t ? worldPoint(t, b) : null;
  if (!t || !pa || !pb || !(distance > 0)) return false;
  const now = vlen(vsub(pa, pb));
  if (!(now > 1e-9)) return false;
  composeScene(t, distance / now, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]);
  return true;
}

/** Back to the derived placement. */
export function resetCameraScene(doc: MotionDocument, id: string): void {
  const t = getCamera(doc, id);
  if (t) t.scene = null;
}
