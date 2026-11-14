import { describe, expect, it } from "vitest";
import { rigSchema } from "../schema/rig";
import { boneColor, mirrorName, pairOf, SIDE_COLORS, sideOf, sideStem } from "./sides";

describe("sides from names", () => {
  it("flips every convention a rigger brings, keeping case", () => {
    const cases: Array<[string, string, "L" | "R"]> = [
      ["Arm.L", "Arm.R", "L"],
      ["arm.r", "arm.l", "R"],
      ["arm_L", "arm_R", "L"],
      ["Arm-R", "Arm-L", "R"],
      ["Upper arm L", "Upper arm R", "L"],
      ["L_arm", "R_arm", "L"],
      ["r.leg", "l.leg", "R"],
      ["l_hand_ctrl", "r_hand_ctrl", "L"],
      ["arm_L_ctrl", "arm_R_ctrl", "L"],
      ["Finger.L.001", "Finger.R.001", "L"],
      ["toe_R2", "toe_L2", "R"],
      ["LeftArm", "RightArm", "L"],
      ["leftArm", "rightArm", "L"],
      ["armLeft", "armRight", "L"],
      ["ArmRight", "ArmLeft", "R"],
      ["Arm_Left", "Arm_Right", "L"],
      ["left_arm", "right_arm", "L"],
      ["LEFT_EYE", "RIGHT_EYE", "L"],
      ["Eye Right", "Eye Left", "R"],
      ["Left", "Right", "L"],
      ["leg.left.fk", "leg.right.fk", "L"],
    ];
    for (const [name, mirrored, side] of cases) {
      expect([name, sideOf(name)]).toEqual([name, side]);
      expect([name, mirrorName(name)]).toEqual([name, mirrored]);
      expect(mirrorName(mirrorName(name))).toBe(name);
    }
  });

  it("leaves centre names alone — a word must stand on its own", () => {
    for (const name of ["Spine", "Head", "Leftover", "Cleft", "upright", "Wright", "L", "R", "LEFTARM", "Bone 3", "Root", "Lower jaw", "Rib"]) {
      expect([name, sideOf(name)]).toEqual([name, null]);
      expect(mirrorName(name)).toBe(name);
    }
  });

  it("matches stems across conventions", () => {
    expect(sideStem("Arm.L")).toBe("arm");
    expect(sideStem("arm_R")).toBe("arm");
    expect(sideStem("LeftArm")).toBe("arm");
    expect(sideStem("Finger.L.001")).toBe(sideStem("finger_R_001"));
  });
});

describe("pairOf", () => {
  const rig = rigSchema.parse({
    bones: [
      { id: "s", name: "Spine" },
      { id: "al", name: "Arm.L" },
      { id: "ar", name: "Arm.R" },
      { id: "ll", name: "Leg.L" },
      { id: "lr", name: "leg_r" }, // a different convention on the other side
      { id: "hl", name: "Hand.L" }, // its other side is missing
    ],
  });
  it("finds the other side by its mirrored name, then across conventions", () => {
    expect(pairOf(rig, "al")?.id).toBe("ar");
    expect(pairOf(rig, "ar")?.id).toBe("al");
    expect(pairOf(rig, "ll")?.id).toBe("lr");
    expect(pairOf(rig, "lr")?.id).toBe("ll");
  });
  it("is null for a centre bone, a missing side, or an unknown id", () => {
    expect(pairOf(rig, "s")).toBeNull();
    expect(pairOf(rig, "hl")).toBeNull();
    expect(pairOf(rig, "ghost")).toBeNull();
  });
});

describe("side colours", () => {
  it("are derived from the name unless a bone has its own", () => {
    expect(boneColor({ name: "Arm.L", color: null })).toBe(SIDE_COLORS.L);
    expect(boneColor({ name: "Arm.R", color: null })).toBe(SIDE_COLORS.R);
    expect(boneColor({ name: "Spine", color: null })).toBeNull();
    expect(boneColor({ name: "Arm.L", color: "#123456" })).toBe("#123456");
  });
});
