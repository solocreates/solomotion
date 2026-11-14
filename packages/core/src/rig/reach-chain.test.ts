import { describe, expect, it } from "vitest";
import type { GroupClip } from "../schema";
import { createEmptyDocument } from "../factories";
import { locateClip } from "../timeline/ops";
import { addBone, boneIsOffset, bonesInRig, connectBone, createRig, setBoneProps } from "./ops";
import { reachChainLength } from "./pose-edit";

/** A body: hips → spine → (arm: upper → fore → hand) and (head), a free-floating hat. */
function body() {
  const doc = createEmptyDocument();
  const frameId = doc.frames[0]!.id;
  const rigId = createRig(doc, frameId, {
    name: "Pip",
    // Each the child of the one before (core's chain rule).
    bones: [
      { head: [0, 0], tail: [0, -100], name: "Spine" },
      { head: [0, -100], tail: [60, -100], name: "Upper" },
      { head: [60, -100], tail: [120, -100], name: "Fore" },
      { head: [120, -100], tail: [150, -100], name: "Hand" },
    ],
  })!;
  const g = () => locateClip(doc, rigId)!.clip as GroupClip;
  const id = (name: string) => g().rig!.bones.find((b) => b.name === name)!.id;
  addBone(doc, rigId, { head: [0, -100], tail: [0, -160], name: "Head", parent: id("Spine") });
  addBone(doc, rigId, { head: [40, -200], tail: [40, -240], name: "Hat", parent: null });
  return { doc, rigId, g, id };
}

describe("reach — a limb follows its hand", () => {
  it("bends up to the chain length, stops below a branch and below a pin", () => {
    const b = body();
    const rig = b.g().rig!;
    expect(reachChainLength(rig, b.id("Hand"), 3)).toBe(3); // hand, forearm, upper arm
    expect(reachChainLength(rig, b.id("Hand"), 8)).toBe(3); // never the spine two limbs hang from
    expect(reachChainLength(rig, b.id("Hand"), 2)).toBe(2);
    expect(reachChainLength(rig, b.id("Hand"), 3, new Set([b.id("Upper")]))).toBe(2); // the shoulder holds
    expect(reachChainLength(rig, b.id("Hand"), 3, new Set([b.id("Hand")]))).toBe(0);
  });
});

describe("parenting you can see and change", () => {
  it("parenting keeps a bone where it is; it is offset until connected", () => {
    const b = body();
    const hat = b.id("Hat");
    const before = bonesInRig(b.g().rig!, true).get(hat)!;
    setBoneProps(b.doc, b.rigId, hat, { parent: b.id("Head") });
    const after = bonesInRig(b.g().rig!, true).get(hat)!;
    expect(after.head[0]).toBeCloseTo(before.head[0], 6);
    expect(after.head[1]).toBeCloseTo(before.head[1], 6);
    expect(boneIsOffset(b.g().rig!, hat, true)).toBe(true);
    expect(boneIsOffset(b.g().rig!, b.id("Fore"), true)).toBe(false);
    expect(connectBone(b.doc, b.rigId, hat)).toBe(true);
    expect(boneIsOffset(b.g().rig!, hat, true)).toBe(false);
    // Its tail stayed where it was: the hat now hangs from the head's tip.
    expect(bonesInRig(b.g().rig!, true).get(hat)!.tail[1]).toBeCloseTo(-240, 6);
  });
});
