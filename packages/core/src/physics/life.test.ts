import { describe, expect, it } from "vitest";
import type { ShapeClip, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { placeClip } from "../timeline/place";
import { locateClip } from "../timeline/ops";
import { bakeClipAt, evaluateWorld } from "../world/evaluate";
import { createMeshClip, createWorld } from "../world/ops";
import { matPosition } from "../world/math";
import { resolveFlatPhysics } from "./flat";

/** A body is in the simulation while its layer is on the timeline — 2D and 3D alike. */

function comp() {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse({});
  const add = (x: number, y: number, w: number, h: number, startMs: number, durationMs: number, body: Partial<ReturnType<typeof physicsSchema.parse>>) => {
    const c = createShapeClip({ frameId: frame.id, shape: "rect", startMs, durationMs, x, y, width: w, height: h }) as ShapeClip;
    c.physics = physicsSchema.parse(body);
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const y = (id: string, ms: number) => {
    const c = locateClip(resolveFlatPhysics(doc, frame.id, ms), id)!.clip as VisualClip;
    return bakeClipAt(c, ms - c.startMs).transform.y;
  };
  return { doc, frame, add, y };
}

describe("a body lives on the timeline", () => {
  it("what rests on a shelf falls the moment the shelf's clip ends", () => {
    const { add, y } = comp();
    // A shelf at y = 0 (top edge −20) for the first two seconds.
    add(0, 0, 600, 40, 0, 2000, { type: "passive" });
    const box = add(0, -300, 100, 100, 0, 10000, { bounce: 0 });
    // Landed and resting on the shelf: centre at −20 − 50.
    expect(y(box.id, 1900)).toBeGreaterThan(-75);
    expect(y(box.id, 1900)).toBeLessThan(-65);
    // The shelf is gone: it falls on to the floor (960 − 50).
    expect(y(box.id, 2500)).toBeGreaterThan(0);
    expect(y(box.id, 6000)).toBeGreaterThan(900);
  });

  it("a shelf that has not started yet is not there to be hit", () => {
    const { add, y } = comp();
    add(0, 0, 600, 40, 3000, 4000, { type: "passive" });
    const box = add(0, -300, 100, 100, 0, 10000, { bounce: 0 });
    // Falls straight through where the shelf will be.
    expect(y(box.id, 2500)).toBeGreaterThan(900);
  });

  it("a body that starts later enters where its own keys put it then, and falls from there", () => {
    const { add, y } = comp();
    const late = add(0, -500, 100, 100, 2000, 6000, { bounce: 0 });
    // At its start it is exactly where it was placed; half a second on, ½ g t² below.
    expect(y(late.id, 2000)).toBeCloseTo(-500, 3);
    const d = y(late.id, 2500) + 500;
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(135);
  });

  it("two clips at different times never touch, though they occupy the same place", () => {
    const { add, y } = comp();
    // The first falls and rests on the floor, then its clip ends; the second starts after.
    add(0, 0, 200, 200, 0, 3000, { bounce: 0 });
    const second = add(0, 0, 200, 200, 3000, 4000, { bounce: 0 });
    // It lands on the floor itself (960 − 100), not on top of the first (760 − 100).
    expect(y(second.id, 6500)).toBeGreaterThan(850);
  });

  it("in a world: a mesh resting on a slab falls when the slab's clip ends", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({});
    const slab = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "cube", position: [0, 0, 300] });
    slab.transform = { ...slab.transform, scale: 4, scaleY: 4, scaleZ: 0.2 };
    slab.physics = physicsSchema.parse({ type: "passive" });
    placeClip(doc, slab, { landing: "surface" });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 8000, primitive: "cube", position: [0, 0, 600] });
    ball.physics = physicsSchema.parse({ bounce: 0 });
    placeClip(doc, ball, { landing: "surface" });
    const z = (t: number) => matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === ball.id)!.matrix)[2];
    const resting = z(1900);
    expect(resting).toBeGreaterThan(300);
    expect(z(5000)).toBeLessThan(resting - 200);
  });
});
