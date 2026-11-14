import { describe, expect, it } from "vitest";
import type { GroupClip, ShapeClip } from "../schema";
import { jointSchema, physicsSchema, simulationSchema } from "../schema/physics";
import { createEmptyDocument, createShapeClip, createTrack } from "../factories";
import { locateClip } from "../timeline/ops";
import { groupChainMatrix } from "../timeline/group-space";
import { apply } from "../navigation/matrix";
import { setKeyframe } from "../animation/keyframes";
import { createRig, setBoneProps } from "../rig/ops";
import { resolveFlatPhysics } from "./flat";
import { createMeshClip, createWorld } from "../world/ops";
import { evaluateWorld } from "../world/evaluate";
import { matPosition, transformPoint } from "../world/math";
import { placeClip } from "../timeline/place";

/**
 * PHYSICS THROUGH THE BONES — what a rigged piece with a body does, measured.
 * A portrait comp (floor at y = 960); a bone drawn from one piece to the next.
 */
function rigComp(gravity = 981) {
  const doc = createEmptyDocument();
  const frame = doc.frames[0]!;
  frame.width = 1080;
  frame.height = 1920;
  frame.physics = simulationSchema.parse({ gravity });
  const rect = (name: string, x: number, y: number, w: number, h: number) => {
    const c = createShapeClip({ frameId: frame.id, shape: "rect", startMs: 0, durationMs: 20000, x, y, width: w, height: h }) as ShapeClip;
    c.name = name;
    const lane = createTrack(name);
    lane.clips.push(c);
    doc.tracks.push(lane);
    return c;
  };
  const resolved = (ms: number) => resolveFlatPhysics(doc, frame.id, ms);
  const rotation = (rigId: string, bone: string, ms: number) => {
    const g = locateClip(resolved(ms), rigId)!.clip as GroupClip;
    return g.rig!.bones.find((b) => b.id === bone)!.pose?.rotation ?? 0;
  };
  /** Where a piece's centre is in the comp at `ms`, carried by its groups and its bone. */
  const where = (id: string, ms: number) => {
    const d = resolved(ms);
    const c = locateClip(d, id)!.clip as ShapeClip;
    return apply(groupChainMatrix(d, id, () => ms), { x: c.transform.x, y: c.transform.y });
  };
  return { doc, frame, rect, rotation, where };
}

/** The clock: a face, and a hand on a bone from the face's centre to the hand's. */
function clock(hand: Partial<ReturnType<typeof physicsSchema.parse>> = {}, gravity?: number) {
  const c = rigComp(gravity);
  const face = c.rect("face", -300, 0, 160, 160);
  const handClip = c.rect("hand", 100, 0, 120, 120);
  handClip.physics = physicsSchema.parse(hand);
  const rigId = createRig(c.doc, c.frame.id, { memberIds: [face.id, handClip.id], bones: [{ head: [-300, 0], tail: [100, 0], name: "Hand" }] })!;
  const bone = (locateClip(c.doc, rigId)!.clip as GroupClip).rig!.bones[0]!.id;
  return { ...c, face, hand: handClip, rigId, bone };
}

describe("a rigged piece that falls swings from its joint", () => {
  it("a pendulum: the hand falls about the joint, the length holds, the face stays put", () => {
    const { rigId, bone, rotation, where, face, hand } = clock({ damping: 0.6 });
    expect(rotation(rigId, bone, 0)).toBeCloseTo(0, 6);
    // On its way down: turned clockwise (down, on screen), still 400 from the joint.
    // A 4 m pendulum (400 px at 1 cm a px) is slow: ~6° in 0.3 s, past 30° by 0.8 s.
    const mid = where(hand.id, 800);
    expect(rotation(rigId, bone, 300)).toBeGreaterThan(3);
    expect(rotation(rigId, bone, 800)).toBeGreaterThan(30);
    expect(Math.hypot(mid.x + 300, mid.y)).toBeCloseTo(400, -1);
    // Settled: hanging straight down below the joint.
    expect(rotation(rigId, bone, 12000)).toBeGreaterThan(80);
    expect(rotation(rigId, bone, 12000)).toBeLessThan(100);
    const end = where(hand.id, 12000);
    expect(end.x).toBeGreaterThan(-320);
    expect(end.x).toBeLessThan(-280);
    expect(end.y).toBeGreaterThan(380);
    // The face is the clock's: where it was drawn.
    expect(where(face.id, 12000).x).toBeCloseTo(-300, 3);
    expect(where(face.id, 12000).y).toBeCloseTo(0, 3);
  });

  it("follows the arm it hangs from: a keyed parent moves, the dynamic child lags and swings behind", () => {
    const c = rigComp(0);
    const upper = c.rect("upper", -150, 0, 300, 40);
    const fore = c.rect("fore", 150, 0, 300, 40);
    fore.physics = physicsSchema.parse({ damping: 0.3 });
    const rigId = createRig(c.doc, c.frame.id, {
      memberIds: [upper.id, fore.id],
      bones: [
        { head: [-300, 0], tail: [0, 0], name: "Upper" },
        { head: [0, 0], tail: [300, 0], name: "Fore" },
      ],
    })!;
    const g = locateClip(c.doc, rigId)!.clip as GroupClip;
    const [up, fo] = g.rig!.bones;
    // The upper arm swings 90° down in half a second; no gravity: only the swing moves the forearm.
    setKeyframe(g.keyframes, `bone.${up!.id}.rotation`, 0, 0, { kind: "linear" });
    setKeyframe(g.keyframes, `bone.${up!.id}.rotation`, 500, 90, { kind: "linear" });
    // The forearm trails: relative to its parent it turned back (anticlockwise) while the arm swung.
    expect(c.rotation(rigId, fo!.id, 400)).toBeLessThan(-5);
    // Pinned at the elbow: the upper arm's tip is at (−300, 300) once it has swung down, and the
    // forearm's centre stays half its length (150) from there, wherever the forearm points.
    const mid = c.where(fore.id, 1000);
    expect(Math.hypot(mid.x + 300, mid.y - 300)).toBeCloseTo(150, -1);
  });

  it("follow: a piece that follows its keys holds its pose and only sags and settles", () => {
    const loose = clock({ damping: 0.1 });
    const firm = clock({ damping: 0.1, follow: 0.9 });
    expect(loose.rotation(loose.rigId, loose.bone, 2000)).not.toBeCloseTo(0, 0);
    // Gravity pulls it a little off its keyed 0°, no more.
    expect(Math.abs(firm.rotation(firm.rigId, firm.bone, 2000))).toBeLessThan(15);
  });

  it("a bone's rotation limits are the hinge's stops", () => {
    const { doc, rigId, bone, rotation } = clock({ damping: 0.4 });
    setBoneProps(doc, rigId, bone, { limits: { rotation: [-30, 30] } });
    for (const t of [300, 1000, 4000]) expect(rotation(rigId, bone, t)).toBeLessThan(33);
    expect(rotation(rigId, bone, 4000)).toBeGreaterThan(25);
  });

  it("a ragdoll: the rig itself falls — the whole character comes down, the loose limb flops over", () => {
    const c = rigComp();
    const body = c.rect("body", 0, 300, 200, 200);
    const head = c.rect("head", 20, -100, 120, 120);
    head.physics = physicsSchema.parse({ damping: 0.2 });
    // A head on a neck, balanced (nearly) upright on the body.
    const rigId = createRig(c.doc, c.frame.id, { memberIds: [body.id, head.id], bones: [{ head: [0, 300], tail: [20, -100], name: "Neck" }] })!;
    const g = locateClip(c.doc, rigId)!.clip as GroupClip;
    g.physics = physicsSchema.parse({ bounce: 0, friction: 1 });
    const neck = g.rig!.bones[0]!.id;
    // Falling together, nothing turns; the body lands (960 − 100) and the head topples off its balance.
    expect(Math.abs(c.rotation(rigId, neck, 300))).toBeLessThan(2);
    expect(c.where(body.id, 8000).y).toBeGreaterThan(840);
    expect(Math.abs(c.rotation(rigId, neck, 8000))).toBeGreaterThan(30);
  });
});

describe("art that bends falls as a chain", () => {
  it("a tail with three bones through it hangs down from its root, every bone swinging", () => {
    const c = rigComp();
    const tail = c.rect("tail", 0, 0, 600, 30);
    tail.physics = physicsSchema.parse({ damping: 0.5 });
    const rigId = createRig(c.doc, c.frame.id, {
      memberIds: [tail.id],
      bones: [
        { head: [-300, 0], tail: [-100, 0], name: "T1" },
        { head: [-100, 0], tail: [100, 0], name: "T2" },
        { head: [100, 0], tail: [300, 0], name: "T3" },
      ],
    })!;
    const bones = (locateClip(c.doc, rigId)!.clip as GroupClip).rig!.bones;
    // Every bone the art is made of swings: the root turns down toward vertical,
    // and the chain's total turn ends near straight down.
    const total = (t: number) => bones.reduce((a, b) => a + c.rotation(rigId, b.id, t), 0);
    expect(c.rotation(rigId, bones[0]!.id, 10000)).toBeGreaterThan(45);
    expect(total(10000)).toBeGreaterThan(70);
    expect(total(10000)).toBeLessThan(110);
  });
});

describe("joints on rigged pieces", () => {
  it("a rigged piece pinned to the comp holds its bone up: the hand does not swing", () => {
    const { hand, rigId, bone, rotation } = clock({ damping: 0.3 });
    hand.joints = [jointSchema.parse({ id: "j1", type: "pin", target: null, anchor: [0, 0, 0] })];
    expect(Math.abs(rotation(rigId, bone, 3000))).toBeLessThan(3);
  });

  it("a rope from a rigged hand to a loose ball: the ball hangs from the hand, the hand dips under it", () => {
    const c = clock({ damping: 0.3 }, 981);
    const ball = c.rect("ball", 100, 300, 60, 60);
    ball.physics = physicsSchema.parse({ damping: 0.3 });
    c.hand.joints = [jointSchema.parse({ id: "rope", type: "rope", target: ball.id, anchor: [0, 0, 0], targetAnchor: [0, 0, 0] })];
    // Free, the ball would fall to the floor (960 − 30) — held, it stays within the rope's reach of the hand.
    const h = c.where(c.hand.id, 6000), b = c.where(ball.id, 6000);
    expect(b.y).toBeLessThan(900);
    expect(Math.hypot(b.x - h.x, b.y - h.y)).toBeLessThan(340);
  });
});

describe("the piece a rig hangs from", () => {
  it("falls, and the whole rig falls with it — its hanging piece swinging", () => {
    const c = rigComp();
    const face = c.rect("face", -300, 0, 160, 160);
    const hand = c.rect("hand", 100, 0, 120, 120);
    face.physics = physicsSchema.parse({ bounce: 0 });
    hand.physics = physicsSchema.parse({ damping: 0.3 });
    const rigId = createRig(c.doc, c.frame.id, { memberIds: [face.id, hand.id], bones: [{ head: [-300, 0], tail: [100, 0], name: "Hand" }] })!;
    expect(c.where(face.id, 4000).y).toBeGreaterThan(800);
    // Still on its joint, so it came down too: 400 from the face's centre, on or near the floor.
    const f = c.where(face.id, 4000), h = c.where(hand.id, 4000);
    expect(h.y).toBeGreaterThan(500);
    expect(Math.hypot(h.x - f.x, h.y - f.y)).toBeCloseTo(400, -1);
    void rigId;
  });
});

describe("in a world, the same", () => {
  /** A post and a weight in the air, a bone from the post's centre to the weight's: the weight swings. */
  function worldClock(weight: Partial<ReturnType<typeof physicsSchema.parse>>, rigBody?: Partial<ReturnType<typeof physicsSchema.parse>>, limits?: Record<string, [number, number]>) {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({});
    const span = { frameId: frame.id, startMs: 0, durationMs: 20000 };
    const post = createMeshClip({ ...span, primitive: "cube", params: { sizeX: 60, sizeY: 60, sizeZ: 60 }, name: "Post", position: [0, 0, 600] });
    const bob = createMeshClip({ ...span, primitive: "cube", params: { sizeX: 60, sizeY: 60, sizeZ: 60 }, name: "Bob", position: [300, 0, 600] });
    bob.physics = physicsSchema.parse(weight);
    placeClip(doc, post, { landing: "surface" });
    placeClip(doc, bob, { landing: "surface" });
    const rigId = createRig(doc, frame.id, { memberIds: [post.id, bob.id], bones: [{ head: [0, 0, 600], tail: [300, 0, 600], name: "Arm" }] })!;
    if (rigBody) (locateClip(doc, rigId)!.clip as GroupClip).physics = physicsSchema.parse(rigBody);
    if (limits) setBoneProps(doc, rigId, (locateClip(doc, rigId)!.clip as GroupClip).rig!.bones[0]!.id, { limits });
    const at = (id: string, t: number) => matPosition(evaluateWorld(doc, frame, t).objects.find((o) => o.id === id)!.matrix);
    return { doc, frame, at, post, bob };
  }

  it("a weight on a bone swings down from the post and stays the bone's length away", () => {
    const { at, post, bob } = worldClock({ damping: 0.6 });
    const p = at(post.id, 10000), b = at(bob.id, 10000);
    // Hanging under the joint (Z is up): ~300 below the post, the post where it was.
    expect(p[2]).toBeCloseTo(600, 3);
    expect(Math.hypot(b[0] - 0, b[1] - 0, b[2] - 600)).toBeCloseTo(300, -1);
    expect(b[2]).toBeLessThan(330);
  });

  it("a world bone's limits are its joint's stops: the weight stops 30° down", () => {
    const { at, bob } = worldClock({ damping: 0.6 }, undefined, { rotationY: [-30, 30], rotation: [-30, 30], rotationX: [-30, 30] });
    const b = at(bob.id, 6000);
    // 300 · sin 30° = 150 below the joint, give or take the stop's give.
    expect(b[2]).toBeGreaterThan(600 - 175);
    expect(b[2]).toBeLessThan(600 - 100);
  });

  it("a rope from a rigged weight holds a loose ball under it", () => {
    const { doc, frame, at, bob } = worldClock({ damping: 0.6 });
    const ball = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 20000, primitive: "sphere", name: "Ball", position: [300, 0, 450] });
    ball.physics = physicsSchema.parse({ damping: 0.4 });
    placeClip(doc, ball, { landing: "surface" });
    bob.joints = [jointSchema.parse({ id: "rope", type: "rope", target: ball.id, anchor: [0, 0, 0], targetAnchor: [0, 0, 0] })];
    const b = at(bob.id, 8000), l = at(ball.id, 8000);
    // Free, it would lie on the ground; held, it hangs within the rope of the weight.
    expect(l[2]).toBeGreaterThan(100);
    expect(Math.hypot(l[0] - b[0], l[1] - b[1], l[2] - b[2])).toBeLessThan(200);
  });

  it("a bar that bends with three bones hangs as a chain", () => {
    const doc = createEmptyDocument();
    const { frame } = createWorld(doc, { starter: false });
    frame.physics = simulationSchema.parse({});
    const bar = createMeshClip({ frameId: frame.id, startMs: 0, durationMs: 20000, primitive: "cube", params: { sizeX: 600, sizeY: 30, sizeZ: 30 }, name: "Bar", position: [0, 0, 800] });
    bar.physics = physicsSchema.parse({ damping: 0.6 });
    placeClip(doc, bar, { landing: "surface" });
    const rigId = createRig(doc, frame.id, {
      memberIds: [bar.id],
      bones: [
        { head: [-300, 0, 800], tail: [-100, 0, 800], name: "B1" },
        { head: [-100, 0, 800], tail: [100, 0, 800], name: "B2" },
        { head: [100, 0, 800], tail: [300, 0, 800], name: "B3" },
      ],
    })!;
    const last = (locateClip(doc, rigId)!.clip as GroupClip).rig!.bones[2]!.id;
    const tip = (t: number) => {
      const r = evaluateWorld(doc, frame, t).rigs.find((x) => x.id === rigId)!;
      return transformPoint(r.matrix, r.pose.byId.get(last)!.tail);
    };
    expect(tip(0)[2]).toBeCloseTo(800, 3);
    // Hanging from its root at (−300, 0, 800): the tip about 600 below it.
    const end = tip(12000);
    expect(end[2]).toBeLessThan(800 - 450);
    expect(Math.abs(end[0] + 300)).toBeLessThan(150);
  });

  it("when the rig falls, the post comes down to the ground too", () => {
    const { at, post } = worldClock({ damping: 0.3 }, { bounce: 0 });
    expect(at(post.id, 6000)[2]).toBeLessThan(120);
  });
});
