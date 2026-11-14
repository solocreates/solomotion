import { describe, expect, it } from "vitest";
import { createAsset, createCarrierTrack, createEmptyDocument, createVideoClip } from "../../factories";
import { addClipToTrack } from "../../timeline/ops";
import { resolvedDocAt } from "../../evaluate/resolved-doc";
import { evaluateWorld } from "../../world/evaluate";
import { invert4, rotation4, transformPoint, type V3 as WV3 } from "../../world/math";
import { lensFov } from "../../world/camera";
import { seededRandom } from "../engine";
import { expSO3, mul3, transpose3, apply3, vscale, type V3 } from "./linalg";
import type { Pose } from "./geometry";
import { toDocument } from "./run-camera";
import { cameraPointsInWorld, projectToPlate } from "./read-camera";
import { makeCameraScene, placeTextOnSolvedPoints } from "./scene";
import { setCameraGround, setCameraOrigin, setCameraScale } from "./ops-camera";
import type { CameraSolution as RawSolution } from "./solve";
import type { CameraTracker } from "../../schema/tracking";
import type { MotionDocument } from "../../schema";

/**
 * "Make 3D scene" must put the world camera exactly where the solve says the
 * plate was shot from: a solved point, projected through the WORLD camera the
 * way the renderer projects it (its lens in mm, its matrix from the follow
 * bake), must land on the plate pixel the solve itself projects it to. That
 * one check covers the axes change, the lens conversion, the time map through
 * the backplate and the bake.
 */

const W = 1920;
const H = 1080;
const F = 1600;

function fakeSolution(frames: number): { raw: RawSolution; points: V3[] } {
  const rand = seededRandom(4);
  const poses: Pose[] = [];
  for (let i = 0; i < frames; i++) {
    const u = i / (frames - 1);
    const c2w = mul3(expSO3([0, (-8 + 16 * u) * (Math.PI / 180), 0]), expSO3([(2 * u * Math.PI) / 180, 0, 0]));
    const R = transpose3(c2w);
    const c: V3 = [-1 + 2 * u, 0.1 * u, 0.5 * u];
    poses.push({ R, t: vscale(apply3(R, c), -1) });
  }
  const points: V3[] = [];
  // A floor at y = 1.5 (CV: y down) and a back wall.
  for (let i = 0; i < 60; i++) points.push([(rand() - 0.5) * 8, 1.5, 4 + rand() * 8]);
  for (let i = 0; i < 60; i++) points.push([(rand() - 0.5) * 8, 1.5 - rand() * 3, 12]);
  return {
    raw: {
      mode: "free",
      f: F,
      cx: W / 2,
      cy: H / 2,
      poses,
      points: Float64Array.from(points.flat()),
      pointLuma: new Float32Array(points.length).fill(128),
      pointTrack: Int32Array.from(points.map((_, i) => i)),
      rms: 0.3,
      frameRms: new Float32Array(frames).fill(0.3),
      keyframes: [0, frames - 1],
    },
    points,
  };
}

function setup() {
  const doc = createEmptyDocument("Test") as MotionDocument;
  const comp = doc.frames[0]!;
  const asset = createAsset({ kind: "video", name: "plate.mp4", mime: "video/mp4", bytes: 1, width: W, height: H, durationMs: 2000, fps: 30 });
  doc.assets.push(asset);
  const clip = createVideoClip({ frameId: comp.id, assetId: asset.id, startMs: 500, durationMs: 2000 });
  const track = createCarrierTrack("Plate", comp.id);
  addClipToTrack(track, clip);
  doc.tracks.push(track);
  const frames = 61;
  const times = Array.from({ length: frames }, (_, i) => Math.round((i * 1000) / 30));
  const { raw, points } = fakeSolution(frames);
  const tracker: CameraTracker = {
    kind: "camera",
    id: "tracker_cam",
    name: "Camera",
    color: "#4ade80",
    source: { kind: "asset", assetId: asset.id },
    via: clip.id,
    solve: { mode: "auto", focalLength: null, features: 400, analysisEdge: 960 },
    solution: toDocument(raw, times, W, H),
    scene: null,
    analysis: { version: 0, engine: "cpu", coverage: [[0, times[frames - 1]!]], at: 0 },
    dirty: false,
  };
  doc.trackers.push(tracker);
  return { doc, comp, clip, tracker, points, times };
}

/** Where the renderer would draw a world point, comp px (top-left origin), through the world's live camera. */
function projectThroughWorld(doc: MotionDocument, worldId: string, t: number, p: WV3): { x: number; y: number } {
  const resolved = resolvedDocAt(doc, t, worldId, false);
  const frame = resolved.frames.find((f) => f.id === worldId)!;
  const ev = evaluateWorld(resolved, frame, t);
  const local = transformPoint(invert4(ev.camera.matrix), p);
  const fovX = lensFov(ev.camera.spec.focalLength, ev.camera.spec.sensorWidth);
  const fx = frame.width / 2 / Math.tan((fovX * Math.PI) / 360);
  return { x: frame.width / 2 + (fx * local[0]) / -local[2], y: frame.height / 2 - (fx * local[1]) / -local[2] };
}

describe("Make 3D scene", () => {
  it("puts the world camera where the plate was shot from: solved points land on their plate pixels", () => {
    const { doc, comp, clip, tracker, times } = setup();
    const ids = makeCameraScene(doc, tracker.id)!;
    expect(ids).toBeTruthy();
    // The footage is hidden under the world, the world nested over its span.
    expect(clip.hidden).toBe(true);
    const nested = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === ids.nestedId)!;
    expect([nested.frameId, nested.startMs, nested.durationMs]).toEqual([comp.id, clip.startMs, clip.durationMs]);
    const t = tracker;
    const world = cameraPointsInWorld(t);
    let worst = 0;
    for (const k of [0, 17, 33, 59]) {
      const worldMs = times[k]!; // the plate starts at world time 0 with the footage's time map
      for (let i = 0; i < 120; i += 7) {
        const p: WV3 = [world[3 * i]!, world[3 * i + 1]!, world[3 * i + 2]!];
        const want = projectToPlate(t, p as V3, times[k]!)!;
        const got = projectThroughWorld(doc, ids.worldId, worldMs, p);
        worst = Math.max(worst, Math.hypot(got.x - want.x, got.y - want.y));
      }
    }
    expect(worst).toBeLessThan(0.05);
  });

  it("stands the floor up: ground, origin and scale keep the camera on the plate", () => {
    const { doc, tracker, times } = setup();
    const ids = makeCameraScene(doc, tracker.id)!;
    // The first 60 points are the floor.
    expect(setCameraGround(doc, tracker.id, [0, 5, 11, 23, 40])).toBeLessThan(1e-6);
    expect(setCameraOrigin(doc, tracker.id, 3)).toBe(true);
    expect(setCameraScale(doc, tracker.id, 3, 9, 250)).toBe(true);
    const world = cameraPointsInWorld(tracker);
    // Every floor point is now at z = 0, point 3 at the origin, 3↔9 250 apart.
    for (let i = 0; i < 60; i++) expect(Math.abs(world[3 * i + 2]!)).toBeLessThan(1e-6);
    expect(Math.hypot(world[9]!, world[10]!, world[11]!)).toBeLessThan(1e-6);
    expect(Math.hypot(world[27]! - world[9]!, world[28]! - world[10]!, world[29]! - world[11]!)).toBeCloseTo(250, 6);
    // The camera stands above the floor, and the plate still agrees with the world.
    const p: WV3 = [world[30]!, world[31]!, world[32]!];
    const want = projectToPlate(tracker, p as V3, times[30]!)!;
    const got = projectThroughWorld(doc, ids.worldId, times[30]!, p);
    expect(Math.hypot(got.x - want.x, got.y - want.y)).toBeLessThan(0.05);
    const resolved = resolvedDocAt(doc, 0, ids.worldId, false);
    const ev = evaluateWorld(resolved, resolved.frames.find((f) => f.id === ids.worldId)!, 0);
    expect(ev.camera.matrix[14]!).toBeGreaterThan(0);
  });

  it("stands text on picked points, lying on their plane", () => {
    const { doc, tracker } = setup();
    const ids = makeCameraScene(doc, tracker.id)!;
    setCameraGround(doc, tracker.id, [0, 5, 11]);
    const id = placeTextOnSolvedPoints(doc, tracker.id, ids.worldId, [1, 2, 4, 6], 0, "Hello")!;
    const text = doc.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;
    expect(text.frameId).toBe(ids.worldId);
    if (!("transform" in text)) throw new Error("visual");
    // On the floor (z = 0) and lying flat: its front (a picture plane faces its local −Y) faces up.
    const tr = text.transform;
    expect(Math.abs(tr.z ?? 0)).toBeLessThan(1e-6);
    const front = transformPoint(rotation4(tr.rotationX ?? 0, tr.rotationY ?? 0, tr.rotation), [0, -1, 0]);
    expect(front[2]).toBeGreaterThan(0.999);
  });
});
