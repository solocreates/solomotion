import { describe, expect, it } from "vitest";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { parseDocument } from "../io";
import { physicsSchema, simulationSchema, type ShapeClip } from "../schema";
import { flatPhysics } from "./flat";
import { simulate } from "./solver";

/** A lone 16 px ball dropped inside a 920 px ring: at the bottom it falls ~1400 px/s, 12 px a 120 Hz step. */
function droppedBall(guard: boolean) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse({ floor: false, gravity: 981, guard });
  const add = (c: ShapeClip, body: Record<string, unknown>) => {
    c.physics = physicsSchema.parse(body);
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  add(createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 12000, x: 0, y: -110, width: 920, height: 920 }) as ShapeClip, { type: "passive", shape: "edge", bounce: 1, friction: 0 });
  const ball = add(createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 12000, x: 140, y: -360, width: 16, height: 16 }) as ShapeClip, { bounce: 1, friction: 0, damping: 0, velocity: [380, -658, 0] });
  return { doc, frame, ball };
}

const furthest = (guard: boolean) => {
  const { doc, frame, ball } = droppedBall(guard);
  const fp = flatPhysics(doc, frame.id)!;
  let far = 0;
  for (let t = 0.02; t <= 10; t += 1 / 120) {
    const p = simulate(fp.scene, t).get(ball.id);
    if (p) far = Math.max(far, Math.hypot(p.position[0], p.position[1] + 110));
  }
  return far;
};

describe("the tunnelling guard (v106)", () => {
  it("keeps a small fast ball inside a thin ring for ten seconds (it escapes without it)", () => {
    expect(furthest(false)).toBeGreaterThan(470);
    expect(furthest(true)).toBeLessThan(460);
  });

  it("is on for new comps and off for comps that already simulated", () => {
    expect(simulationSchema.parse({}).guard).toBe(true);
    const { doc, frame } = droppedBall(true);
    const old = JSON.parse(JSON.stringify({ ...doc, version: 105 }));
    delete old.frames[0].physics.guard;
    const migrated = parseDocument(JSON.stringify(old));
    expect(migrated.frames.find((f) => f.id === frame.id)!.physics!.guard).toBe(false);
  });
});
