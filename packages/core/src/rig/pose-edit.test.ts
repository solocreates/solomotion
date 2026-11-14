import { describe, expect, it } from "vitest";
import type { Bone, Rig } from "../schema";
import { boneSchema, rigSchema } from "../schema/rig";
import { evaluateRig } from "./pose";
import { setBoneChannel } from "./fields";
import { axisRotation, moveChannels, moveChannels3d, reachChannels, rotateChannels3d, turnBetween, turnChannel, worldAngle } from "./pose-edit";
import { transformPoint, type V3 } from "../world/math";

const bone = (b: Partial<Bone> & { id: string }): Bone => boneSchema.parse(b);
const arm = (): Rig =>
  rigSchema.parse({
    bones: [bone({ id: "u", rest: { x: -100, y: 0, rotation: 0, length: 100 } }), bone({ id: "f", parent: "u", rest: { x: 100, y: 0, rotation: 20, length: 80 } })],
  });
/** A new rig with the values written — rigs are immutable in the app, and the pose memo keys on identity. */
const write = (rig: Rig, id: string, values: Record<string, number>): Rig => {
  const next = structuredClone(rig);
  for (const [k, v] of Object.entries(values)) setBoneChannel(next, `bone.${id}.${k}`, v);
  return next;
};

describe("pose gestures → channels", () => {
  it("a tip dragged to a point lands there, and the elbow keeps its side", () => {
    for (const target of [[20, 60], [40, -60], [-60, 90], [60, 0]] as Array<[number, number]>) {
      let r = arm();
      for (const { bone, rotation } of reachChannels(r, "f", [target[0], target[1], 0])) r = write(r, bone, { rotation });
      const p = evaluateRig(r, { planar: true });
      const tip = p.byId.get("f")!.tail;
      expect(Math.hypot(tip[0] - target[0], tip[1] - target[1])).toBeLessThan(0.5);
      // At rest the forearm turns clockwise from the upper arm; it still does.
      const a = [p.byId.get("u")!.tail[0] - p.byId.get("u")!.head[0], p.byId.get("u")!.tail[1] - p.byId.get("u")!.head[1]];
      const b = [tip[0] - p.byId.get("f")!.head[0], tip[1] - p.byId.get("f")!.head[1]];
      expect(a[0]! * b[1]! - a[1]! * b[0]!).toBeGreaterThan(0);
    }
  });

  it("a turn on screen is the same turn under a mirrored parent", () => {
    const rig = write(arm(), "u", { scale: 1, scaleY: -1 });
    const p = evaluateRig(rig, { planar: true });
    const was = worldAngle(p.byId.get("f")!);
    const now = worldAngle(evaluateRig(write(rig, "f", { rotation: turnChannel(p, "f", 30) }), { planar: true }).byId.get("f")!);
    expect(((now - was + 540) % 360) - 180).toBeCloseTo(30, 6);
  });

  it("a move on screen moves the head that far, whatever its parent's turn", () => {
    const rig = write(arm(), "u", { rotation: 90 });
    const p = evaluateRig(rig, { planar: true });
    const head = p.byId.get("f")!.head;
    const moved = evaluateRig(write(rig, "f", moveChannels(p, "f", [10, -5, 0])), { planar: true }).byId.get("f")!.head;
    expect(moved[0] - head[0]).toBeCloseTo(10, 6);
    expect(moved[1] - head[1]).toBeCloseTo(-5, 6);
  });
});

describe("in a world", () => {
  /** A leg out of the hip, pitched down and turned, its shin hanging off it at an angle — every axis in play. */
  const leg = (): Rig =>
    rigSchema.parse({
      bones: [
        bone({ id: "t", rest: { x: 0, y: 0, z: 100, rotation: 30, rotationY: 70, rotationX: 0, length: 50 } }),
        bone({ id: "s", parent: "t", rest: { x: 50, y: 0, z: 0, rotation: -25, rotationY: 15, rotationX: 40, length: 45 } }),
      ],
    });
  const near = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it("a turn about any axis in the world turns the bone exactly that way, under a turned parent", () => {
    for (const [axis, deg] of [[[0, 0, 1], 40], [[1, 0, 0], -35], [[0.3, -0.8, 0.5], 72]] as Array<[V3, number]>) {
      let r = write(leg(), "t", { rotation: 12, rotationY: -20, rotationX: 9 });
      const before = evaluateRig(r, { planar: false }).byId.get("s")!;
      const turn = axisRotation(axis, deg);
      r = write(r, "s", rotateChannels3d(evaluateRig(r, { planar: false }), "s", turn));
      const after = evaluateRig(r, { planar: false }).byId.get("s")!;
      // The head stays; the tip goes where the turn takes it.
      expect(near(after.head, before.head)).toBeLessThan(1e-6);
      const want = transformPoint(turn, [before.tail[0] - before.head[0], before.tail[1] - before.head[1], before.tail[2] - before.head[2]]);
      expect(near(after.tail, [before.head[0] + want[0], before.head[1] + want[1], before.head[2] + want[2]])).toBeLessThan(1e-4);
    }
  });

  it("a dragged tip's turn is the one between where it was and where the pointer is", () => {
    const r = leg();
    const s = evaluateRig(r, { planar: false }).byId.get("s")!;
    const from: V3 = [s.tail[0] - s.head[0], s.tail[1] - s.head[1], s.tail[2] - s.head[2]];
    const to: V3 = [10, -30, -20];
    const next = write(r, "s", rotateChannels3d(evaluateRig(r, { planar: false }), "s", turnBetween(from, to)!));
    const t = evaluateRig(next, { planar: false }).byId.get("s")!;
    const dir: V3 = [t.tail[0] - t.head[0], t.tail[1] - t.head[1], t.tail[2] - t.head[2]];
    const len = Math.hypot(...to);
    expect(near(dir.map((v) => v / 45) as V3, to.map((v) => v / len) as V3)).toBeLessThan(1e-4);
  });

  it("a move in the world moves the head that far through a turned parent", () => {
    const r = write(leg(), "t", { rotationX: 33 });
    const p = evaluateRig(r, { planar: false });
    const head = p.byId.get("s")!.head;
    const moved = evaluateRig(write(r, "s", moveChannels3d(p, "s", [4, -7, 11])), { planar: false }).byId.get("s")!.head;
    expect(near(moved, [head[0] + 4, head[1] - 7, head[2] + 11])).toBeLessThan(1e-6);
  });
});
