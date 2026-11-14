import { describe, expect, it } from "vitest";
import type { Bone, GroupClip, Rig } from "../schema";
import { boneSchema, rigSchema } from "../schema/rig";
import { createGroupClip } from "../factories";
import { bakeRig, evaluateRig, orderBones } from "./pose";
import { isIdentity4, length3, sub, transformPoint, type V3 } from "../world/math";

const bone = (b: Partial<Bone> & { id: string }): Bone => boneSchema.parse(b);
const rig = (bones: Bone[]): Rig => rigSchema.parse({ bones });
const near = (a: V3, b: V3, eps = 1e-6) => expect(length3(sub(a, b))).toBeLessThan(eps);

/** An arm along +X in a flat comp: shoulder at 0, elbow at 100, wrist at 180. */
function arm(extra: Partial<Bone> = {}, forearm: Partial<Bone> = {}): Bone[] {
  return [
    bone({ id: "upper", rest: { x: 0, y: 0, rotation: 0, length: 100 }, ...extra }),
    bone({ id: "fore", parent: "upper", rest: { x: 100, y: 0, rotation: 0, length: 80 }, ...forearm }),
  ];
}

describe("rig pose — forward", () => {
  it("is exactly the identity at rest, so binding art never moves it", () => {
    const r = evaluateRig(rig(arm()), { planar: true });
    expect(r.atRest).toBe(true);
    for (const b of r.bones) expect(isIdentity4(b.skin)).toBe(true);
    near(r.byId.get("fore")!.tail, [180, 0, 0]);
  });

  it("turns a child with its parent — clockwise on screen, y down", () => {
    const bones = arm({ pose: { x: 0, y: 0, rotation: 90, scale: 1, scaleY: null } });
    const r = evaluateRig(rig(bones), { planar: true });
    // The upper arm now points DOWN the screen; the forearm hangs off it.
    near(r.byId.get("upper")!.tail, [0, 100, 0], 1e-9);
    near(r.byId.get("fore")!.tail, [0, 180, 0], 1e-9);
    // What the forearm does to a point on it: carries the rest wrist to the posed one.
    near(transformPoint(r.byId.get("fore")!.skin, [180, 0, 0]), [0, 180, 0], 1e-9);
  });

  it("stretch carries the joint out along the bone, and children ride it", () => {
    const bones = arm({ pose: { x: 0, y: 0, rotation: 0, scale: 1.5, scaleY: 1 } });
    const r = evaluateRig(rig(bones), { planar: true });
    near(r.byId.get("fore")!.head, [150, 0, 0]);
  });

  it("moves a root in the rig's space, a child in its parent's frame", () => {
    const bones = arm({ rest: { x: 0, y: 0, rotation: 90, length: 100 }, pose: { x: 10, y: -5, rotation: 0, scale: 1, scaleY: null } }, { pose: { x: 20, y: 0, rotation: 0, scale: 1, scaleY: null } });
    const r = evaluateRig(rig(bones), { planar: true });
    near(r.byId.get("upper")!.head, [10, -5, 0]);
    // The forearm's +X is the upper arm's direction (down), so x: 20 moves it 20 further down.
    near(r.byId.get("fore")!.head, [10, 95 + 20, 0], 1e-9);
  });

  it("reads a flat rig in its plane: depth and 3D angles rest", () => {
    const bones = arm({ rest: { x: 0, y: 0, z: 50, rotation: 0, rotationY: 45, length: 100 } });
    near(evaluateRig(rig(bones), { planar: true }).byId.get("fore")!.tail, [180, 0, 0]);
    // The same rig in a world does lift and pitch.
    const w = evaluateRig(rig(bones), { planar: false }).byId.get("upper")!;
    expect(w.head[2]).toBe(50);
    expect(Math.abs(w.tail[2] - 50)).toBeGreaterThan(10);
  });

  it("turns a missing, self or cyclic parent into a root instead of failing", () => {
    const bones = [
      bone({ id: "a", parent: "b" }),
      bone({ id: "b", parent: "a" }),
      bone({ id: "c", parent: "c" }),
      bone({ id: "d", parent: "ghost" }),
    ];
    const ordered = orderBones(bones);
    expect(ordered.map((o) => o.bone.id).sort()).toEqual(["a", "b", "c", "d"]);
    expect(ordered.find((o) => o.bone.id === "c")!.parent).toBeNull();
    expect(ordered.find((o) => o.bone.id === "d")!.parent).toBeNull();
    // Exactly one of the cycle keeps its parent; the loop is cut once.
    const ab = ordered.filter((o) => o.bone.id === "a" || o.bone.id === "b");
    expect(ab.filter((o) => o.parent === null).length).toBe(1);
    expect(() => evaluateRig(rig(bones), { planar: true })).not.toThrow();
  });
});

describe("rig pose — IK", () => {
  /** An arm with IK on the forearm, reaching for a free control bone. */
  function ikRig(target: V3, opts: { flip?: boolean; mix?: number; restBend?: number; pole?: V3 } = {}): Rig {
    const bones = arm({}, { rest: { x: 100, y: 0, rotation: opts.restBend ?? 0, length: 80 } });
    bones[1] = { ...bones[1]!, ik: { target: "ctrl", chain: 2, pole: opts.pole ? "pole" : null, flip: opts.flip ?? false, mix: opts.mix ?? 1 } };
    bones.push(bone({ id: "ctrl", deform: false, rest: { x: target[0], y: target[1], z: target[2] || undefined, rotation: 0, length: 10 } }));
    if (opts.pole) bones.push(bone({ id: "pole", deform: false, rest: { x: opts.pole[0], y: opts.pole[1], z: opts.pole[2] || undefined, rotation: 0, length: 10 } }));
    return rig(bones);
  }

  it("lands the tip on a reachable target and keeps every length", () => {
    const r = evaluateRig(ikRig([120, 60, 0]), { planar: true });
    const up = r.byId.get("upper")!, fore = r.byId.get("fore")!;
    near(fore.tail, [120, 60, 0], 0.05);
    expect(length3(sub(up.tail, up.head))).toBeCloseTo(100, 6);
    expect(length3(sub(fore.tail, fore.head))).toBeCloseTo(80, 6);
    // The joint stays joined.
    near(up.tail, fore.head, 1e-6);
  });

  it("bends the side the arm bends at rest, and flip bends the other", () => {
    // At rest the forearm turns clockwise (down the screen) from the upper arm.
    const bent = (flip: boolean) => evaluateRig(ikRig([150, 0, 0], { restBend: 30, flip }), { planar: true }).byId.get("upper")!.tail[1];
    expect(bent(false)).toBeLessThan(0); // elbow UP — a clockwise turn at the elbow
    expect(bent(true)).toBeGreaterThan(0);
  });

  it("never pops sides as the target sweeps across the arm's line", () => {
    const side = (ty: number) => {
      const r = evaluateRig(ikRig([140, ty, 0], { restBend: 30 }), { planar: true });
      const a = sub(r.byId.get("upper")!.tail, r.byId.get("upper")!.head);
      const b = sub(r.byId.get("fore")!.tail, r.byId.get("fore")!.head);
      return Math.sign(a[0] * b[1] - a[1] * b[0]);
    };
    const sides = [-60, -20, -1, 0, 1, 20, 60].map(side);
    expect(new Set(sides).size).toBe(1);
  });

  it("straightens toward a target out of reach", () => {
    const r = evaluateRig(ikRig([0, 900, 0]), { planar: true });
    const fore = r.byId.get("fore")!;
    // Pointing straight down, fully extended.
    near(fore.tail, [0, 180, 0], 1e-6);
  });

  it("mix blends the reach — 0 is the keyed pose, 1 the target", () => {
    const at = (mix: number) => evaluateRig(ikRig([100, 80, 0], { mix }), { planar: true }).byId.get("fore")!.tail;
    near(at(0), [180, 0, 0], 1e-9);
    near(at(1), [100, 80, 0], 0.05);
    const half = at(0.5);
    expect(length3(sub(half, [140, 40, 0]))).toBeLessThan(0.05);
  });

  it("aims a world elbow at its pole", () => {
    const r = evaluateRig(ikRig([120, 0, 60], { pole: [60, 200, 0] }), { planar: false });
    near(r.byId.get("fore")!.tail, [120, 0, 60], 0.05);
    // The elbow swings toward +Y, where the pole is.
    expect(r.byId.get("upper")!.tail[1]).toBeGreaterThan(20);
  });

  it("ignores a target that hangs off its own chain (it would chase itself)", () => {
    const bones = arm();
    bones.push(bone({ id: "hand", parent: "fore", rest: { x: 80, y: 0, rotation: 0, length: 20 } }));
    bones[1] = { ...bones[1]!, ik: { target: "hand", chain: 2, pole: null, flip: false, mix: 1 } };
    const r = evaluateRig(rig(bones), { planar: true });
    near(r.byId.get("fore")!.tail, [180, 0, 0]);
  });

  it("carries the bones under a turned joint", () => {
    const base = ikRig([120, 60, 0]);
    base.bones.push(bone({ id: "hand", parent: "fore", rest: { x: 80, y: 0, rotation: 0, length: 20 } }));
    const r = evaluateRig(base, { planar: true });
    near(r.byId.get("hand")!.head, r.byId.get("fore")!.tail, 1e-6);
  });
});

describe("rig pose — channels at an instant", () => {
  it("samples keys on bone paths, and modulators shake them", () => {
    const g: GroupClip = { ...createGroupClip({ frameId: "f", startMs: 0, durationMs: 2000 }), rig: rig(arm()) };
    g.keyframes = [
      { id: "k", property: "bone.upper.rotation", range: null, keys: [{ id: "a", timeMs: 0, value: 0, easing: { kind: "linear" } }, { id: "b", timeMs: 1000, value: 90, easing: { kind: "linear" } }] },
    ] as GroupClip["keyframes"];
    const mid = evaluateRig(bakeRig(g, 500)!, { planar: true });
    near(mid.byId.get("upper")!.tail, [Math.cos(Math.PI / 4) * 100, Math.sin(Math.PI / 4) * 100, 0], 1e-6);
    // The stored rig is untouched by sampling.
    expect(g.rig!.bones[0]!.pose).toBeUndefined();
    // A still rig comes back by reference.
    const still = { ...g, keyframes: [] };
    expect(bakeRig(still, 500)).toBe(still.rig);
  });
});
