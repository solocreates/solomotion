import { describe, expect, it } from "vitest";
import type { GroupClip } from "../schema";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { addConstraint, createRig, poseBones, setBoneProps } from "./ops";
import { rigPoseAt } from "./pose";
import { pairOf, sideOf } from "./sides";
import { mirrorPose, rigAxis, symmetrize } from "./symmetry";

/** A half-rigged character standing on x = 50: the left side done, the right a stray bone in another convention. */
function character() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const X = 50;
  const id = createRig(doc, frameId, {
    bones: [
      { head: [X, 0], tail: [X, -100], name: "Spine" },
      { head: [X + 30, -90], tail: [X + 110, -60], name: "Upper.L" },
      { head: [X + 110, -60], tail: [X + 180, -20], name: "Fore.L" },
      { head: [X + 180, -20], tail: [X + 190, -20], name: "Hand_ctrl.L", parent: null, deform: false },
      { head: [X + 20, -130], tail: [X + 24, -130], name: "Pupil.L", parent: null, deform: false },
      { head: [X, -200], tail: [X, -210], name: "Look", parent: null, deform: false },
      { head: [X - 40, -95], tail: [X - 60, -50], name: "upper_R", parent: null },
    ],
  })!;
  const g = () => locateClip(doc, id)!.clip as GroupClip;
  const b = (n: string) => g().rig!.bones.find((x) => x.name === n)!;
  setBoneProps(doc, id, b("Upper.L").id, { parent: b("Spine").id });
  setBoneProps(doc, id, b("Fore.L").id, { limits: { rotation: [0, 120] }, ik: { target: b("Hand_ctrl.L").id, chain: 2 } });
  setBoneProps(doc, id, b("Hand_ctrl.L").id, { shape: "diamond", limits: { x: [-20, 50] } });
  setBoneProps(doc, id, b("Pupil.L").id, { shape: "circle", limits: { x: [-6, 6], y: [-6, 6] } });
  addConstraint(doc, id, b("Pupil.L").id, { type: "look", target: { kind: "bone", bone: b("Look").id } });
  return { doc, id, g, b, X };
}

const near = (a: readonly number[], b: readonly number[], eps = 1e-4) => expect(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)).toBeLessThan(eps);

describe("symmetrize", () => {
  it("finds the character's middle from its centre bones", () => {
    const { g } = character();
    expect(rigAxis(g().rig!, true)).toBeCloseTo(50, 9);
  });

  it("builds the right side from the left: geometry, parents, IK, limits, constraints — updating the stray bone, not duplicating it", () => {
    const { doc, id, g, b, X } = character();
    const strayId = b("upper_R").id;
    const res = symmetrize(doc, id)!;
    expect(res.from).toBe("L");
    expect(res.created).toHaveLength(3);
    expect(res.updated).toEqual([strayId]);
    const rig = g().rig!;
    expect(rig.bones).toHaveLength(10);
    // The stray bone was the right upper arm all along: same id, its own name kept.
    expect(pairOf(rig, b("Upper.L").id)!.id).toBe(strayId);
    expect(b("upper_R").parent).toBe(b("Spine").id);
    const fore = b("Fore.R");
    expect(fore.parent).toBe(strayId);
    expect(fore.limits).toEqual({ rotation: [-120, 0] });
    expect(fore.ik?.target).toBe(b("Hand_ctrl.R").id);
    expect(b("Hand_ctrl.R")).toMatchObject({ shape: "diamond", deform: false, limits: { x: [-50, 20] } });
    expect(b("Pupil.R").constraints?.[0]).toMatchObject({ type: "look", target: { kind: "bone", bone: b("Look").id } });
    // Mirrored about x = 50, at rest.
    const pose = rigPoseAt(g(), 0, true)!;
    for (const L of rig.bones.filter((x) => sideOf(x.name) === "L")) {
      const l = pose.byId.get(L.id)!, r = pose.byId.get(pairOf(rig, L.id)!.id)!;
      near(r.head, [2 * X - l.head[0], l.head[1]]);
      near(r.tail, [2 * X - l.tail[0], l.tail[1]]);
    }
  });

  it("twice is once", () => {
    const { doc, id, g } = character();
    symmetrize(doc, id);
    const once = structuredClone(g().rig);
    const again = symmetrize(doc, id)!;
    expect(again.created).toEqual([]);
    expect(g().rig).toEqual(once);
  });

  it("works from the right too", () => {
    const { doc, id, g } = character();
    symmetrize(doc, id);
    const r = symmetrize(doc, id, { from: "R" })!;
    expect(r.created).toEqual([]);
    expect(g().rig!.bones).toHaveLength(10);
  });
});

describe("mirror pose", () => {
  /** Every sided bone's posed head and tail against its pair's, mirrored about x = 50. */
  function expectMirrored(g: () => GroupClip, X: number, at = 0) {
    const rig = g().rig!;
    const pose = rigPoseAt(g(), at, true)!;
    for (const L of rig.bones.filter((x) => sideOf(x.name) === "L")) {
      const l = pose.byId.get(L.id)!, r = pose.byId.get(pairOf(rig, L.id)!.id)!;
      near(r.head, [2 * X - l.head[0], l.head[1]], 1e-3);
      near(r.tail, [2 * X - l.tail[0], l.tail[1]], 1e-3);
    }
  }

  it("copies the left pose onto the right with the sign rules — turns, a child's move, a root's move, IK and the pupils' look", () => {
    const { doc, id, g, b, X } = character();
    symmetrize(doc, id);
    poseBones(doc, id, [
      { bone: b("Upper.L").id, values: { rotation: 20, y: 6, scale: 1.1 } },
      { bone: b("Hand_ctrl.L").id, values: { x: -15, y: 25 } },
      { bone: b("Look").id, values: { y: 40 } },
    ], 0);
    mirrorPose(doc, id, 0, { mode: "copy" });
    expect(b("upper_R").pose).toMatchObject({ rotation: -20, y: -6, scale: 1.1 });
    expect(b("Hand_ctrl.R").pose).toMatchObject({ x: 15, y: 25 });
    expectMirrored(g, X);
  });

  it("flips a whole pose: the sides swap, the middle mirrors onto itself", () => {
    const { doc, id, g, b, X } = character();
    symmetrize(doc, id);
    poseBones(doc, id, [
      { bone: b("Spine").id, values: { rotation: 12 } },
      { bone: b("Upper.L").id, values: { rotation: 25 } },
      { bone: b("upper_R").id, values: { rotation: -5 } },
      { bone: b("Hand_ctrl.R").id, values: { x: 30, y: -10 } },
    ], 0);
    const before = rigPoseAt(structuredClone(g()), 0, true)!;
    mirrorPose(doc, id, 0, { mode: "flip" });
    expect(b("Spine").pose!.rotation).toBeCloseTo(-12, 9);
    const rig = g().rig!;
    const after = rigPoseAt(g(), 0, true)!;
    for (const bone of rig.bones) {
      const other = sideOf(bone.name) ? pairOf(rig, bone.id)! : bone;
      const was = before.byId.get(other.id)!, now = after.byId.get(bone.id)!;
      near(now.head, [2 * X - was.head[0], was.head[1]], 1e-3);
      near(now.tail, [2 * X - was.tail[0], was.tail[1]], 1e-3);
    }
  });

  it("keys where asked", () => {
    const { doc, id, g, b } = character();
    symmetrize(doc, id);
    poseBones(doc, id, [{ bone: b("Upper.L").id, values: { rotation: 30 } }], 500, { key: true });
    mirrorPose(doc, id, 500, { mode: "copy", key: true });
    expect(g().keyframes.some((k) => k.property === `bone.${b("upper_R").id}.rotation`)).toBe(true);
  });
});
