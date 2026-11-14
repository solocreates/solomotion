import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "../factories";
import { placeClip } from "../timeline/place";
import { createCameraClip, createWorld, makeCameraActive, materializeDefaultCamera } from "./ops";
import { activeCameraAt, evaluateWorld } from "./evaluate";
import { defaultCameraMatrix } from "./camera";

function world() {
  const doc = createEmptyDocument();
  const { frame } = createWorld(doc, { starter: false, width: 1920, height: 1080 });
  const cam = (name: string, startMs = 0, durationMs = 4000) => {
    const c = createCameraClip({ frameId: frame.id, startMs, durationMs, name, position: [0, -1000, 0], rotation: [90, 0, 0] });
    placeClip(doc, c, { landing: "surface" });
    return c;
  };
  return { doc, frame, cam };
}

describe("choosing the camera", () => {
  it("lifts the chosen camera over the live one, and only where it is on the timeline", () => {
    const { doc, frame, cam } = world();
    const a = cam("A");
    const b = cam("B"); // placed on top: B is live
    expect(activeCameraAt(doc, frame, 1000)).toBe(b.id);
    expect(makeCameraActive(doc, frame.id, a.id, 1000)).toBeNull();
    expect(activeCameraAt(doc, frame, 1000)).toBe(a.id);
    // Choosing the live one again changes nothing.
    const order = doc.tracks.map((t) => t.id).join();
    expect(makeCameraActive(doc, frame.id, a.id, 1000)).toBeNull();
    expect(doc.tracks.map((t) => t.id).join()).toBe(order);
    const late = cam("Late", 3000, 1000);
    expect(makeCameraActive(doc, frame.id, late.id, 1000)).toMatch(/not on the timeline/);
  });

  it("shows a hidden camera it is asked to look through", () => {
    const { doc, frame, cam } = world();
    const a = cam("A");
    a.hidden = true;
    expect(activeCameraAt(doc, frame, 0)).toBeNull();
    expect(makeCameraActive(doc, frame.id, a.id, 0)).toBeNull();
    expect(activeCameraAt(doc, frame, 0)).toBe(a.id);
  });

  it("makes the default camera real without moving the picture, and under the others", () => {
    const { doc, frame, cam } = world();
    const before = evaluateWorld(doc, frame, 0).camera.matrix;
    expect(before).toEqual(defaultCameraMatrix(frame.width, frame.height));
    const id = materializeDefaultCamera(doc, frame.id)!;
    const after = evaluateWorld(doc, frame, 0).camera;
    expect(after.clipId).toBe(id);
    after.matrix.forEach((v, i) => expect(v).toBeCloseTo(before[i]!, 2));
    // A shot camera later in the comp still wins its stretch; the made-real one shows in the gaps.
    const shot = cam("Shot", 1000, 1000);
    const id2 = materializeDefaultCamera(doc, frame.id)!;
    expect(activeCameraAt(doc, frame, 1500)).toBe(shot.id);
    expect([id, id2]).toContain(activeCameraAt(doc, frame, 500));
  });
});

describe("the shutter's instants", () => {
  it("keeps a layer whole on its first and last frames, and never blurs across a camera cut", () => {
    const { doc, frame, cam } = world();
    const a = cam("A", 0, 1000);
    const b = cam("B", 1000, 1000);
    // Frame 0 with a centred shutter reaches before anything exists.
    expect(evaluateWorld(doc, frame, -8).camera.clipId).toBeNull();
    expect(evaluateWorld(doc, frame, -8, { aliveAt: 0 }).camera.clipId).toBe(a.id);
    // The last frame before the cut stays on A for every instant of its shutter.
    expect(evaluateWorld(doc, frame, 1004).camera.clipId).toBe(b.id);
    expect(evaluateWorld(doc, frame, 1004, { aliveAt: 996 }).camera.clipId).toBe(a.id);
    // And the first frame after it is B, held at its own start.
    expect(evaluateWorld(doc, frame, 995, { aliveAt: 1000 }).camera.clipId).toBe(b.id);
  });
});
