import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip } from "../factories";
import { placeClip } from "../timeline/place";
import { createEmptyClip, createMeshClip, createWorld } from "../world/ops";
import { evaluateWorld } from "../world/evaluate";
import { matPosition } from "../world/math";
import { jointSchema, physicsSchema, simulationSchema } from "../schema/physics";
import { FORCE } from "./forces";
import { parseDocument, serializeDocument } from "../io";

describe("physics in a world", () => {
  it("a 2D layer standing in the world is a body: a card topples and lies on the ground", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const card = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 6000, width: 200, height: 300 });
    card.transform = { ...card.transform, z: 160, rotationX: 8 };
    card.physics = physicsSchema.parse({ bounce: 0 });
    placeClip(doc, card, { landing: "surface" });
    const z = (t: number) => matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === card.id)!.matrix)[2];
    expect(z(0)).toBeCloseTo(160, 3);
    // Down, over, and flat on the floor: its centre a hair above Z 0, not standing at 150.
    expect(z(5000)).toBeGreaterThan(-1);
    expect(z(5000)).toBeLessThan(20);
  });

  it("a cube made at the origin, half under the floor, falls onto it instead of firing upward", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const cube = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "cube", position: [0, 0, 0] });
    cube.physics = physicsSchema.parse({});
    placeClip(doc, cube, { landing: "surface" });
    const z = (t: number) => matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === cube.id)!.matrix)[2];
    // Standing on the ground from the first frame (its half-height above Z 0), and staying there.
    for (const t of [0, 100, 500, 2000, 3900]) {
      expect(z(t)).toBeGreaterThan(90);
      expect(z(t)).toBeLessThan(110);
    }
  });

  it("a body keyed to grow keeps growing while it falls: its scale is its own, not the simulation's", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({ gravity: 0, floor: false });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 2000, primitive: "sphere", position: [0, 0, 300] });
    ball.physics = physicsSchema.parse({ velocity: [100, 0, 0] });
    ball.keyframes = [{ id: "k", property: "scale", keys: [{ id: "a", timeMs: 0, value: 0.01 }, { id: "b", timeMs: 1000, value: 1 }] }] as typeof ball.keyframes;
    placeClip(doc, ball, { landing: "surface" });
    const at = (t: number) => evaluateWorld(doc, frame, t).objects.find((o) => o.id === ball.id)!.matrix;
    const size = (m: readonly number[]) => Math.hypot(m[0]!, m[1]!, m[2]!);
    expect(size(at(1500))).toBeCloseTo(1, 2);
    expect(matPosition(at(1500))[0]).toBeGreaterThan(140); // still moved by the simulation
  });

  it("a field on a null in the world pushes a floating mesh along the null's +X", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({ gravity: 0, floor: false });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "sphere", position: [0, 0, 300] });
    ball.physics = physicsSchema.parse({});
    placeClip(doc, ball, { landing: "surface" });
    const wind = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 4000, name: "Wind" });
    wind.forces = [{ ...FORCE.create("wind"), strength: 400, falloff: "none" }];
    placeClip(doc, wind, { landing: "surface" });
    const p = matPosition(evaluateWorld(doc, frame, 1000).objects.find((o) => o.id === ball.id)!.matrix);
    // ½ · 400 · 1² = 200 along X, nothing else.
    expect(p[0]).toBeGreaterThan(190);
    expect(p[0]).toBeLessThan(210);
    expect(p[2]).toBeCloseTo(300, 1);
  });

  it("an old world's physics settings become its comp's: gravity flips to a downward pull, the ground to the floor", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    const raw = JSON.parse(serializeDocument(doc));
    raw.version = 91;
    const f = raw.frames.find((x: { id: string }) => x.id === frame.id);
    f.world.physics = { gravity: -500, ground: false, groundZ: 12, startMs: 250 };
    delete f.physics;
    const back = parseDocument(JSON.stringify(raw));
    const g = back.frames.find((x) => x.id === frame.id)!;
    expect(g.physics).toMatchObject({ gravity: 500, floor: false, floorAt: 12, startMs: 250 });
    expect((g.world as Record<string, unknown>).physics).toBeUndefined();
  });

  it("a joint holds in a world: a ball pinned to a point in the air swings on its string", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({ floor: false });
    // A ball 200 units to the side of a pin at (0, 0, 500).
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 4000, primitive: "sphere", position: [200, 0, 500] });
    ball.physics = physicsSchema.parse({ damping: 0 });
    ball.joints = [jointSchema.parse({ id: "j", type: "rope", targetAnchor: [0, 0, 500], length: 200 })];
    placeClip(doc, ball, { landing: "surface" });
    for (const t of [400, 900, 1600]) {
      const p = matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === ball.id)!.matrix);
      // Never further than the rope (a hair of give), and well below where it started.
      expect(Math.hypot(p[0], p[1], p[2] - 500)).toBeLessThan(206);
      // From level it falls almost freely at first: ½·981·0.4² ≈ 78.5 below the start.
      if (t === 400) expect(p[2]).toBeLessThan(430);
    }
  });
});
