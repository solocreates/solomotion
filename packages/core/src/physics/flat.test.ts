import { describe, expect, it } from "vitest";
import type { MotionDocument, ShapeClip, VisualClip } from "../schema";
import { jointSchema, physicsSchema, simulationSchema, type ForceSpec } from "../schema/physics";
import { FORCE } from "./forces";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { createEmptyClip } from "../world/ops";
import { groupClips } from "../timeline/groups";
import { locateClip } from "../timeline/ops";
import { setKeyframe } from "../animation/keyframes";
import { flatPhysics, resolveFlatPhysics } from "./flat";
import { bakeClipAt } from "../world/evaluate";

/** A portrait comp (1080 × 1920: the floor is at y = 960) and a way to add shapes. */
function comp(settings: Partial<ReturnType<typeof simulationSchema.parse>> = {}) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse(settings);
  const add = (shape: ShapeClip["shape"], x: number, y: number, w: number, h: number, body?: Partial<ReturnType<typeof physicsSchema.parse>>, extra: Partial<ShapeClip> = {}) => {
    const c = createShapeClip({ frameId: frame.id, shape, startMs: 0, durationMs: 10000, x, y, width: w, height: h }) as ShapeClip;
    Object.assign(c, extra);
    if (body) c.physics = physicsSchema.parse(body);
    const lane = createTrack(c.name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  /** Where a layer is at comp time `ms` — read the way the renderer reads it. */
  const at = (id: string, ms: number) => {
    const c = locateClip(resolveFlatPhysics(doc, frame.id, ms), id)!.clip as VisualClip;
    return bakeClipAt(c, ms - c.startMs).transform;
  };
  return { doc, frame, add, at };
}

describe("2D rigid bodies", () => {
  it("a box falls, lands on the comp's bottom edge and rests there, level", () => {
    const { add, at } = comp();
    const box = add("rect", 0, 0, 200, 100, { bounce: 0 });
    expect(at(box.id, 0).y).toBeCloseTo(0, 6);
    // Free fall: ½ g t² at 0.5 s is 122.6 px.
    expect(at(box.id, 500).y).toBeGreaterThan(110);
    expect(at(box.id, 500).y).toBeLessThan(135);
    const rest = at(box.id, 4000);
    expect(rest.y).toBeGreaterThan(905);
    expect(rest.y).toBeLessThan(912); // 960 − 50
    expect(Math.abs(rest.rotation)).toBeLessThan(0.5);
  });

  it("is exact per frame: any order, any number of times, the same pose", () => {
    const { add, at } = comp();
    const box = add("rect", 0, 0, 120, 120, { spin: [0, 0, 90], velocity: [300, -200, 0] });
    const late = at(box.id, 2500);
    const early = at(box.id, 700);
    expect(at(box.id, 2500)).toEqual(late);
    expect(at(box.id, 700)).toEqual(early);
  });

  it("is keyed by what it starts from: a colour change reuses the run, a moved start re-simulates", () => {
    const { doc, frame, add } = comp();
    const box = add("rect", 0, 0, 120, 120, {});
    const key = flatPhysics(doc, frame.id)!.scene.key;
    box.fills = [];
    expect(flatPhysics(doc, frame.id)!.scene.key).toBe(key);
    box.transform.x = 50;
    expect(flatPhysics(doc, frame.id)!.scene.key).not.toBe(key);
  });

  it("a star lands on its real points, not on its box", () => {
    const { add, at } = comp({ floor: false });
    // A ledge at y = 400 (top edge 380).
    add("rect", 0, 400, 1000, 40, { type: "passive" });
    // A star, one point down: its box is 300 tall but its tips are what touch.
    const star = add("star", 0, 0, 300, 300, { bounce: 0, friction: 1 }, { pointCount: 5, innerRatio: 0.4, rotation: 0 } as Partial<ShapeClip>);
    const rest = at(star.id, 5000);
    // Point up, its two lower tips reach 150·cos 36° ≈ 121 below its centre: on them it rests at 380 − 121 ≈ 259.
    expect(rest.y).toBeGreaterThan(252);
    expect(rest.y).toBeLessThan(264);
    // Its box would have put it at 380 − 150 = 230 — and does, when asked for.
    const boxed = comp({ floor: false });
    boxed.add("rect", 0, 400, 1000, 40, { type: "passive" });
    const asBox = boxed.add("star", 0, 0, 300, 300, { bounce: 0, friction: 1, shape: "box" }, { pointCount: 5, innerRatio: 0.4 } as Partial<ShapeClip>);
    expect(boxed.at(asBox.id, 5000).y).toBeCloseTo(230, -0.5);
  });

  it("a ball with bounce comes back up after it hits", () => {
    const { add, at } = comp();
    const ball = add("ellipse", 0, 600, 100, 100, { bounce: 0.8 });
    let low = -Infinity, rose = false;
    for (let t = 0; t <= 3000; t += 20) {
      const y = at(ball.id, t).y;
      if (y < low - 20) rose = true;
      low = Math.max(low, y);
    }
    expect(low).toBeGreaterThan(895);
    expect(rose).toBe(true);
  });

  it("walls keep bodies in the comp", () => {
    const { add, at } = comp({ walls: true });
    const box = add("rect", 0, 800, 100, 100, { velocity: [3000, 0, 0], friction: 0, bounce: 0.2 });
    for (let t = 0; t <= 2000; t += 100) expect(at(box.id, t).x).toBeLessThan(540);
  });

  it("a thrown thing keeps flying: a body keyed moving at the start starts with that motion", () => {
    const { add, at } = comp({ startMs: 1000, gravity: 0, floor: false });
    const box = add("rect", 0, 0, 100, 100, {});
    setKeyframe(box.keyframes, "x", 0, 0, { kind: "linear" });
    setKeyframe(box.keyframes, "x", 1000, 400, { kind: "linear" }); // 400 px/s at the start
    expect(at(box.id, 1000).x).toBeCloseTo(400, 0);
    // A second later it has gone on at ~400 px/s, where its keys would have stopped it.
    expect(at(box.id, 2000).x).toBeGreaterThan(760);
    expect(at(box.id, 2000).x).toBeLessThan(820);
  });

  it("a group is one body: its members fall together and keep their places", () => {
    const { doc, add, at } = comp();
    const a = add("rect", -60, 0, 100, 100);
    const b = add("rect", 60, 0, 100, 80);
    const g = groupClips(doc, [a.id, b.id], "Pair")!;
    (locateClip(doc, g)!.clip as VisualClip).physics = physicsSchema.parse({ bounce: 0 });
    const t = at(g, 4000);
    // The lower member's bottom (y +50 at the start) rests on 960: the group has come down ~910.
    expect(t.y).toBeGreaterThan(890);
    expect(t.y).toBeLessThan(915);
  });

  it("an animated body pushes what is in its way", () => {
    const { add, at } = comp({ gravity: 0, floor: false });
    const pusher = add("rect", -400, 0, 100, 100, { type: "animated" });
    setKeyframe(pusher.keyframes, "x", 0, -400);
    setKeyframe(pusher.keyframes, "x", 2000, 200);
    const block = add("rect", 0, 0, 100, 100, { friction: 0 });
    expect(at(block.id, 2000).x).toBeGreaterThan(150);
    // The pusher itself follows its own keys.
    expect(at(pusher.id, 1000).x).toBeCloseTo(-100, 0);
  });

  it("a rolling wheel's turn is unwound — three turns read about 1080°", () => {
    const { add, at } = comp({ gravity: 0, floor: false });
    const wheel = add("ellipse", 0, 0, 100, 100, { spin: [0, 0, 360], damping: 0 });
    expect(at(wheel.id, 3000).rotation).toBeGreaterThan(1000);
    expect(at(wheel.id, 3000).rotation).toBeLessThan(1100);
  });
});

describe("fields", () => {
  /** A null in the comp carrying a field. */
  const field = (doc: MotionDocument, frameId: string, x: number, y: number, rotation: number, spec: Partial<ForceSpec> & { type: ForceSpec["type"] }) => {
    const e = createEmptyClip({ frameId, startMs: 0, durationMs: 10000, name: "Field" });
    e.transform = { ...e.transform, x, y, rotation };
    e.forces = [{ ...FORCE.create(spec.type), ...spec }];
    const lane = createTrack("Field");
    lane.clips.push(e);
    doc.tracks.push(lane);
    return e;
  };

  it("a wind blows along its layer: turned 90°, it blows down the screen; past its reach, nothing", () => {
    const { doc, frame, add, at } = comp({ gravity: 0, floor: false });
    field(doc, frame.id, 0, 0, 90, { type: "wind", strength: 400, radius: 600, falloff: "none" });
    const near = add("rect", 0, 0, 50, 50, {});
    const far = add("rect", 0, -900, 50, 50, {});
    // ½ · 400 · 1² = 200 px down in a second; sideways nothing.
    expect(at(near.id, 1000).y).toBeGreaterThan(190);
    expect(at(near.id, 1000).y).toBeLessThan(210);
    expect(Math.abs(at(near.id, 1000).x)).toBeLessThan(1);
    expect(at(far.id, 1000).y).toBeCloseTo(-900, 3);
  });

  it("a point field pulls toward it, a negative one pushes away", () => {
    const { doc, frame, add, at } = comp({ gravity: 0, floor: false });
    field(doc, frame.id, 0, 0, 0, { type: "point", strength: 300, falloff: "none" });
    const b = add("rect", 400, 0, 50, 50, {});
    expect(at(b.id, 800).x).toBeLessThan(330);
    const other = comp({ gravity: 0, floor: false });
    field(other.doc, other.frame.id, 0, 0, 0, { type: "point", strength: -300, falloff: "none" });
    const c = other.add("rect", 400, 0, 50, 50, {});
    expect(other.at(c.id, 800).x).toBeGreaterThan(470);
  });

  it("a vortex swirls clockwise on screen: a body to its right is pushed down", () => {
    const { doc, frame, add, at } = comp({ gravity: 0, floor: false });
    field(doc, frame.id, 0, 0, 0, { type: "vortex", strength: 500, falloff: "none" });
    const b = add("rect", 300, 0, 40, 40, {});
    expect(at(b.id, 500).y).toBeGreaterThan(40);
  });

  it("a gust is two keys on its strength", () => {
    const { doc, frame, add, at } = comp({ gravity: 0, floor: false });
    const f = field(doc, frame.id, 0, 0, 0, { type: "wind", strength: 0, falloff: "none" });
    setKeyframe(f.keyframes, `force.${f.forces![0]!.id}.strength`, 1000, 0);
    setKeyframe(f.keyframes, `force.${f.forces![0]!.id}.strength`, 1001, 800);
    const b = add("rect", 0, 0, 50, 50, {});
    expect(Math.abs(at(b.id, 1000).x)).toBeLessThan(0.5);
    expect(at(b.id, 2000).x).toBeGreaterThan(300);
  });
});

describe("joints", () => {
  it("a pinned bar swings like a pendulum, its pin never moving", () => {
    const { add, at } = comp({ floor: false });
    const bar = add("rect", 150, -500, 300, 20, { damping: 0 });
    // Pinned at its left end to the comp.
    bar.joints = [jointSchema.parse({ id: "j1", type: "pin", anchor: [-150, 0, 0] })];
    for (const t of [300, 700, 1200, 2000]) {
      const p = at(bar.id, t);
      const r = (p.rotation * Math.PI) / 180;
      // The left end, (−150, 0) in its own space, is where it was: (0, −500).
      const end = { x: p.x - 150 * Math.cos(r), y: p.y - 150 * Math.sin(r) };
      expect(Math.hypot(end.x - 0, end.y + 500)).toBeLessThan(3);
    }
    // And it swings down past the vertical.
    expect(at(bar.id, 700).rotation).toBeGreaterThan(45);
  });

  it("a spring pulls a weight back toward its length and bounces it", () => {
    const { add, at } = comp({ floor: false });
    const w = add("ellipse", 0, -300, 60, 60, { damping: 0 });
    w.joints = [jointSchema.parse({ id: "s", type: "spring", anchor: [0, 0, 0], targetAnchor: [0, -600, 0], length: 300, stiffness: 20, damping: 0.2 })];
    const ys = Array.from({ length: 60 }, (_, i) => at(w.id, i * 50).y);
    // It falls past its rest and comes back: the motion turns at least twice.
    let turnsBack = 0;
    for (let i = 2; i < ys.length; i++) if (Math.sign(ys[i]! - ys[i - 1]!) !== Math.sign(ys[i - 1]! - ys[i - 2]!) && Math.abs(ys[i]! - ys[i - 1]!) > 0.1) turnsBack++;
    expect(turnsBack).toBeGreaterThanOrEqual(2);
    expect(Math.max(...ys)).toBeLessThan(400);
  });
});

describe("the cache sees what a body's edit reaches", () => {
  it("an edit to one body repaints its whole comp: the others' paths changed with it", async () => {
    const { diffDocumentPicture } = await import("../preview/picture-change");
    const { doc, frame, add } = comp();
    add("rect", 0, 0, 100, 100, {});
    const other = add("rect", 0, -300, 100, 100, {});
    // An edit as immer makes one: only the path to the change is new.
    const next = { ...doc, tracks: doc.tracks.map((t) => (t.clips.some((c) => c.id === other.id) ? { ...t, clips: t.clips.map((c) => (c.id === other.id ? { ...c, transform: { ...(c as VisualClip).transform, x: 30 } } : c)) } : t)) } as MotionDocument;
    const delta = diffDocumentPicture(doc, next);
    expect(delta.total).toBe(false);
    expect(delta.changedFrames.has(frame.id)).toBe(true);
  });
});

describe("a force stack", () => {
  it("two cards on one carrier add up, in either order; muting one leaves the other", () => {
    const run = (order: "a-first" | "b-first", mute = false) => {
      const { doc, frame, add, at } = comp({ gravity: 0, floor: false });
      const e = createEmptyClip({ frameId: frame.id, startMs: 0, durationMs: 10000, name: "Forces" });
      const wind = { ...FORCE.create("wind"), strength: 300, falloff: "none" as const };
      const down = { ...FORCE.create("wind"), strength: 200, falloff: "none" as const, enabled: !mute };
      e.forces = order === "a-first" ? [wind, down] : [down, wind];
      const lane = createTrack("Forces");
      lane.clips.push(e);
      doc.tracks.push(lane);
      const b = add("rect", 0, 0, 50, 50, {});
      return at(b.id, 1000).x;
    };
    // ½ · (300 + 200) · 1² = 250 along X, whichever card is first.
    expect(run("a-first")).toBeGreaterThan(240);
    expect(run("a-first")).toBeCloseTo(run("b-first"), 6);
    // Muted, only the first wind: 150.
    expect(run("a-first", true)).toBeGreaterThan(140);
    expect(run("a-first", true)).toBeLessThan(160);
  });

});

describe("follow", () => {
  it("an active body that follows its keys rides them under gravity, settling just below", () => {
    const { add, at } = comp({ floor: false });
    const free = add("rect", 0, 0, 80, 80, { damping: 0 });
    const held = add("rect", 300, 0, 80, 80, { damping: 0, follow: 0.9 });
    setKeyframe(held.keyframes, "x", 0, 300, { kind: "linear" });
    setKeyframe(held.keyframes, "x", 2000, 500, { kind: "linear" });
    // Free, it has fallen ½ g t² ≈ 1960 px in 2 s; held, it is within a sag of its keys.
    expect(at(free.id, 2000).y).toBeGreaterThan(1500);
    expect(Math.abs(at(held.id, 2000).y)).toBeLessThan(40);
    expect(at(held.id, 2000).x).toBeGreaterThan(470);
  });
});
