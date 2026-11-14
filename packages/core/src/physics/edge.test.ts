import { describe, expect, it } from "vitest";
import type { ShapeClip, VisualClip } from "../schema";
import { physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createPathClip, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { resolveFlatPhysics } from "./flat";
import { bakeClipAt } from "../world/evaluate";
import { edgeQuads } from "./geometry";

function comp(settings: Partial<ReturnType<typeof simulationSchema.parse>> = {}) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse(settings);
  const place = <C extends VisualClip>(c: C, body: Partial<ReturnType<typeof physicsSchema.parse>>) => {
    c.physics = physicsSchema.parse(body);
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const shape = (s: ShapeClip["shape"], x: number, y: number, w: number, h: number, body: Partial<ReturnType<typeof physicsSchema.parse>>) =>
    place(createShapeClip({ frameId: frame.id, shape: s, startMs: 0, durationMs: 20000, x, y, width: w, height: h }) as ShapeClip, body);
  const line = (pts: Array<[number, number]>, body: Partial<ReturnType<typeof physicsSchema.parse>>) =>
    place(createPathClip({ frameId: frame.id, startMs: 0, durationMs: 20000, subpaths: [{ closed: false, points: pts.map(([x, y]) => ({ x, y })) }] as never }), body);
  const at = (id: string, ms: number) => {
    const c = locateClip(resolveFlatPhysics(doc, frame.id, ms), id)!.clip as VisualClip;
    return bakeClipAt(c, ms - c.startMs).transform;
  };
  return { shape, line, at };
}

describe("edge colliders", () => {
  it("cuts every segment into an overlapping, counter-clockwise quad as thick as the line", () => {
    const quads = edgeQuads([{ type: "M", x: 0, y: 0 }, { type: "L", x: 100, y: 0 }, { type: "L", x: 100, y: 100 }], 100, 10);
    expect(quads).toHaveLength(2);
    const ys = quads[0]!.map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 6);
    // Half a width past each end, so neighbours overlap at the corner.
    expect(Math.max(...quads[0]!.map((p) => p[0]))).toBeCloseTo(105, 6);
  });

  it("a ring holds a ball INSIDE it, bouncing for ever — its fill would have thrown it out", () => {
    for (const ringShape of ["edge", "outline"] as const) {
      const { shape, at } = comp({ floor: false });
      shape("ellipse", 0, 0, 800, 800, { type: "passive", shape: ringShape, bounce: 1, friction: 0 });
      const ball = shape("ellipse", 0, -100, 60, 60, { bounce: 1, friction: 0, damping: 0, velocity: [900, -300, 0] });
      let far = 0;
      for (let ms = 0; ms <= 8000; ms += 250) {
        const t = at(ball.id, ms);
        far = Math.max(far, Math.hypot(t.x, t.y));
      }
      if (ringShape === "edge") expect(far).toBeLessThan(400 - 25);
      else expect(far).toBeGreaterThan(400);
    }
  });

  it("an open line is its edge on auto: a ball lands on it and rolls down, not on its box", () => {
    const { shape, line, at } = comp({ floor: false });
    // Falls from left to right: +y is down.
    const ramp = line([[-400, -200], [400, 200]], { type: "passive" });
    const ball = shape("ellipse", -200, -600, 60, 60, { bounce: 0, friction: 0.3 });
    const rampAt = (x: number) => {
      const r = at(ramp.id, 0);
      return r.y + (x - r.x) * 0.5;
    };
    const t = at(ball.id, 1500);
    // Its box's top is at y = −200 + ramp.y: a ball resting on the box would sit level at x = −200.
    expect(t.x).toBeGreaterThan(-150);
    // On the line: its centre a radius (plus the line's half width) above it.
    expect(rampAt(t.x) - t.y).toBeGreaterThan(25);
    expect(rampAt(t.x) - t.y).toBeLessThan(45);
  });
});

describe("collision sounds", () => {
  it("a ball bouncing in a ring sounds on every bounce, harder hits louder, and only while it bounces", async () => {
    const { buildSoundCues } = await import("../audio/cues");
    const { makeSoundLayer } = await import("../factories");
    const { flatHits } = await import("./flat");
    const doc = createEmptyDocument();
    const frame = doc.frames[0]!;
    frame.width = 1080;
    frame.height = 1080;
    frame.physics = simulationSchema.parse({ floor: false, gravity: 0 });
    const add = (c: ShapeClip, body: Partial<ReturnType<typeof physicsSchema.parse>>) => {
      c.physics = physicsSchema.parse(body);
      const lane = createTrack(c.name);
      lane.clips.push(c);
      doc.tracks.push(lane);
      return c;
    };
    add(createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 800, height: 800 }) as ShapeClip, { type: "passive", shape: "edge", bounce: 1, friction: 0 });
    // Straight across and back, 760 units a pass at 1000 units/s: a bounce every ~0.74 s.
    const ball = add(createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 40 }) as ShapeClip, { bounce: 1, friction: 0, damping: 0, velocity: [1000, 0, 0] });
    ball.sounds = [makeSoundLayer({ kind: "hit", minSpeed: 60 }, "in")];
    const hits = flatHits(doc, frame.id, 4000).filter((h) => h.a === ball.id || h.b === ball.id);
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(hits.length).toBeLessThanOrEqual(6);
    expect(hits[0]!.ms).toBeGreaterThan(340);
    expect(hits[0]!.ms).toBeLessThan(420);
    expect(hits[0]!.speed).toBeGreaterThan(900);
    const cues = buildSoundCues(doc, 0, 4000, frame.id).filter((c) => c.clipId === ball.id);
    expect(cues.map((c) => Math.round(c.timeMs))).toEqual(hits.map((h) => Math.round(h.ms)));
    // A body cut short goes quiet with it.
    ball.durationMs = 1000;
    expect(buildSoundCues(doc, 0, 4000, frame.id).filter((c) => c.clipId === ball.id).length).toBe(1);
  });
});

describe("a body between frames", () => {
  it("reads where the simulation has it at any sub-frame instant, so a shutter sees it move", async () => {
    const { resolvedDocAt, clipAtInstant } = await import("../evaluate/resolved-doc");
    const { clipByIdIn } = await import("../timeline/frame-index");
    const doc = createEmptyDocument();
    const frame = doc.frames[0]!;
    frame.physics = simulationSchema.parse({ floor: false, gravity: 0 });
    const ball = createShapeClip({ frameId: frame.id, shape: "ellipse", startMs: 0, durationMs: 4000, x: 0, y: 0, width: 40, height: 40 }) as ShapeClip;
    ball.physics = physicsSchema.parse({ damping: 0, velocity: [1200, 0, 0] });
    const still = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 4000, x: 300, y: 300, width: 40, height: 40 }) as ShapeClip;
    for (const c of [ball, still]) {
      const lane = createTrack(c.name);
      lane.clips.push(c);
      doc.tracks.push(lane);
    }
    const bake = resolvedDocAt(doc, 500, frame.id);
    const now = clipByIdIn(bake, ball.id) as ShapeClip;
    // Two instants inside ONE 120 Hz step (8.3 ms) still differ: interpolated, not snapped.
    const xs = [500, 502, 504].map((t) => clipAtInstant(bake, now, t).clip.transform.x);
    expect(xs[0]).toBeCloseTo(now.transform.x, 6);
    expect(xs[1]! - xs[0]!).toBeCloseTo(2.4, 1);
    expect(xs[2]! - xs[1]!).toBeCloseTo(2.4, 1);
    // A layer nothing simulates is its own answer: no second bake.
    const plain = clipByIdIn(bake, still.id)!;
    expect(clipAtInstant(bake, plain, 520).doc).toBe(bake);
  });
});
