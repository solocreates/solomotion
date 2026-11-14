import { describe, expect, it } from "vitest";
import type { Rig } from "../schema";
import { evaluateRig } from "./pose";
import { reachChannels3d } from "./pose-edit";

/** A world arm: shoulder at the origin, upper arm along +X, forearm along +X, slightly bent up (+Z). */
function arm(): Rig {
  return {
    showBones: true,
    blend: 0.35,
    bones: [
      { id: "upper", name: "Upper", parent: null, rest: { x: 0, y: 0, z: 0, rotation: 0, rotationY: -10, rotationX: 0, length: 100 }, deform: true, ik: null, shape: "bone", size: null, color: null, limits: null },
      { id: "fore", name: "Fore", parent: "upper", rest: { x: 100, y: 0, z: 0, rotation: 0, rotationY: 20, rotationX: 0, length: 100 }, deform: true, ik: null, shape: "bone", size: null, color: null, limits: null },
    ],
  } as Rig;
}

describe("reach in a world — a limb follows its hand in 3D", () => {
  it("puts the tip on the target and keeps the shoulder where it is", () => {
    const rig = arm();
    const target: [number, number, number] = [120, 80, 40];
    const writes = reachChannels3d(rig, "fore", target, 2);
    expect(writes.map((w) => w.bone)).toEqual(["upper", "fore"]);
    const posed: Rig = { ...rig, bones: rig.bones.map((b) => ({ ...b, pose: { x: 0, y: 0, scale: 1, scaleY: null, ...writes.find((w) => w.bone === b.id)!.values } })) };
    const p = evaluateRig(posed, { planar: false });
    const tail = p.byId.get("fore")!.tail;
    expect(Math.hypot(tail[0] - target[0], tail[1] - target[1], tail[2] - target[2])).toBeLessThan(1);
    expect(p.byId.get("upper")!.head).toEqual([0, 0, 0]);
  });
});
